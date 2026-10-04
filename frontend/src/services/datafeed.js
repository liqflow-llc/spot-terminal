// TradingView Advanced Charts datafeed backed by our API.
// History: /api/markets/:address/candles (own fills + GeckoTerminal backfill).
// Live: bars are extended from the market's trade stream.
import { getJSON } from './api';
import { priceDecimals } from '../utils/format';

const RESOLUTION_MS = { 1: 60e3, 5: 300e3, 15: 900e3, 60: 3600e3, 240: 14400e3, '1D': 86400e3 };
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

    async resolveSymbol(address, onResolve, onError) {
      try {
        const m = await getJSON(`/api/markets/${address}`);
        const decimals = priceDecimals(m.last ?? m.bestBid ?? m.bestAsk);
        onResolve({
          name: m.symbol,
          ticker: address,
          description: `${m.base.name || m.base.symbol} / ${m.quote.symbol}`,
          type: 'crypto',
          session: '24x7',
          timezone: 'Etc/UTC',
          exchange: 'Manifest',
          listed_exchange: 'Manifest',
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
      const { from, to, firstDataRequest } = periodParams;
      try {
        const { bars } = await getJSON(`/api/markets/${symbolInfo.ticker}/candles?resolution=${resolution}&from=${from}&to=${to}`);
        if (firstDataRequest && bars.length) lastBars.set(`${symbolInfo.ticker}|${resolution}`, { ...bars.at(-1) });
        onResult(bars, { noData: bars.length === 0 });
      } catch (err) {
        onError(err.message);
      }
    },

    subscribeBars(symbolInfo, resolution, onTick, listenerGuid) {
      const key = `${symbolInfo.ticker}|${resolution}`;
      const span = RESOLUTION_MS[resolution];
      const unsubscribe = subscribeTrades(symbolInfo.ticker, (trade) => {
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
