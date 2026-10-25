// TradingView Advanced Charts datafeed backed by our API. Two charts per market:
//  - "<address>": the Manifest book's own trades (what limit orders fill against). History from
//    /api/markets/:address/candles, live bars extended from the market's trade stream.
//  - "<address>~amm": the pair's price across every Solana DEX (Jupiter's chart data; GeckoTerminal's
//    most active pool as a fallback), from /api/markets/:address/amm-candles, live-ticked from
//    Jupiter's market price.
import { getJSON } from './api';
import { priceDecimals } from '../utils/format';

const RESOLUTION_MS = { 1: 60e3, 5: 300e3, 15: 900e3, 60: 3600e3, 240: 14400e3, '1D': 86400e3 };
const AMM = '~amm';
const AMM_TICK_MS = 15_000;
const SOURCE_WAIT_MS = 3000;
const DEX_NAMES = { orca: 'Orca', raydium: 'Raydium', 'raydium-clmm': 'Raydium CLMM', 'raydium-cp': 'Raydium CPMM', meteora: 'Meteora', 'meteora-dlmm': 'Meteora DLMM', pumpswap: 'PumpSwap', phoenix: 'Phoenix', lifinity: 'Lifinity' };
const dexName = (id) => DEX_NAMES[id] || (id ? id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');

/** "<address>" or "<address>~amm" -> { address, amm } */
export const parseTicker = (ticker) => ({ address: ticker.replace(AMM, ''), amm: ticker.endsWith(AMM) });
export const ammTicker = (address) => `${address}${AMM}`;
const SUPPORTED = Object.keys(RESOLUTION_MS);

/** @param subscribeTrades (address, fn) => unsubscribe */
export function createDatafeed(subscribeTrades) {
  const lastBars = new Map();      // `${address}|${resolution}` -> last bar
  const subscriptions = new Map(); // listenerGuid -> unsubscribe

  return {
    onReady(cb) {
      setTimeout(() => cb({
        supported_resolutions: SUPPORTED,
        supports_marks: false,
        supports_timescale_marks: false,
        supports_time: true,
      }), 0);
    },

    searchSymbols(_input, _exchange, _type, onResult) {
      onResult([]);
    },

    async resolveSymbol(ticker, onResolve, onError) {
      const { address, amm } = parseTicker(ticker);
      try {
        const m = await getJSON(`/api/markets/${address}`);
        const decimals = priceDecimals(m.last ?? m.bestBid ?? m.bestAsk);
        let exchange = 'Manifest';
        if (amm) {
          // The pool only names the chart: don't hold the chart up on a slow lookup (GeckoTerminal is
          // rate limited, and TradingView gives up on a symbol that takes too long to resolve).
          const { source } = await Promise.race([
            getJSON(`/api/markets/${address}/amm-source`).catch(() => ({ source: null })),
            new Promise(r => setTimeout(() => r({ source: undefined }), SOURCE_WAIT_MS)),
          ]);
          exchange = source === undefined ? 'All DEXs'
            : !source ? 'All DEXs (no active pool found)'
            : source.via === 'jupiter' ? 'All DEXs · every Solana pool (Jupiter)'
            : source.via === 'pair' ? (source.quiet ? `All DEXs · ${dexName(source.dex)} (low volume)` : `All DEXs · most active pool: ${dexName(source.dex)}`)
              : `All DEXs · ${dexName(source.dex)}, priced via USD${source.quiet ? ' (low volume)' : ''}`;
        }
        onResolve({
          name: m.symbol,
          ticker,
          description: `${m.base.name || m.base.symbol} / ${m.quote.symbol}`,
          type: 'crypto',
          session: '24x7',
          timezone: 'Etc/UTC',
          exchange,
          listed_exchange: exchange,
          format: 'price',
          minmov: 1,
          pricescale: 10 ** decimals,
          has_intraday: true,
          has_daily: true,
          supported_resolutions: SUPPORTED,
          intraday_multipliers: ['1', '5', '15', '60', '240'],
          volume_precision: 2,
          data_status: 'streaming',
        });
      } catch (err) {
        onError(err.message);
      }
    },

    async getBars(symbolInfo, resolution, periodParams, onResult, onError) {
      const { from, to, firstDataRequest, countBack } = periodParams;
      try {
        const { address, amm } = parseTicker(symbolInfo.ticker);
        // countBack (all-DEX chart): a quiet pool's last candles may be weeks before `from`.
        const { bars } = await getJSON(`/api/markets/${address}/${amm ? `amm-candles?countBack=${countBack || 0}&` : 'candles?'}resolution=${resolution}&from=${from}&to=${to}`);
        if (firstDataRequest && bars.length) lastBars.set(`${symbolInfo.ticker}|${resolution}`, { ...bars.at(-1) });
        onResult(bars, { noData: bars.length === 0 });
      } catch (err) {
        onError(err.message);
      }
    },

    subscribeBars(symbolInfo, resolution, onTick, listenerGuid) {
      const key = `${symbolInfo.ticker}|${resolution}`;
      const span = RESOLUTION_MS[resolution];
      const { address, amm } = parseTicker(symbolInfo.ticker);
      if (amm) {
        // No trade stream for other venues: move the live bar with Jupiter's market price.
        const tick = () => getJSON(`/api/markets/${address}/reference`).then(({ price }) => {
          if (!(price > 0)) return;
          const time = Math.floor(Date.now() / span) * span;
          const last = lastBars.get(key);
          const bar = !last || time > last.time
            ? { time, open: last?.close ?? price, high: Math.max(price, last?.close ?? price), low: Math.min(price, last?.close ?? price), close: price, volume: 0 }
            : { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price };
          lastBars.set(key, bar);
          onTick(bar);
        }).catch(() => {});
        const timer = setInterval(tick, AMM_TICK_MS);
        subscriptions.set(listenerGuid, () => clearInterval(timer));
        return;
      }
      const unsubscribe = subscribeTrades(address, (trade) => {
        const time = Math.floor(trade.time / span) * span;
        const last = lastBars.get(key);
        let bar;
        if (!last || time > last.time) {
          bar = { time, open: last?.close ?? trade.price, high: trade.price, low: trade.price, close: trade.price, volume: trade.size };
          if (last) {
            bar.high = Math.max(bar.high, bar.open);
            bar.low = Math.min(bar.low, bar.open);
          }
        } else if (time === last.time) {
          bar = { ...last, high: Math.max(last.high, trade.price), low: Math.min(last.low, trade.price), close: trade.price, volume: last.volume + trade.size };
        } else {
          return; // Older than the current bar; ignore.
        }
        lastBars.set(key, bar);
        onTick(bar);
      });
      subscriptions.set(listenerGuid, unsubscribe);
    },

    unsubscribeBars(listenerGuid) {
      subscriptions.get(listenerGuid)?.();
      subscriptions.delete(listenerGuid);
    },
  };
}
