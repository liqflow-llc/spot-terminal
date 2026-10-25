import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, HistogramSeries, createChart } from 'lightweight-charts';
import { ammTicker, createDatafeed } from '../services/datafeed';
import { formatAmount } from '../utils/format';
import { useTheme } from '../theme';

// The chart for installs without TradingView's licensed Advanced Charts bundle (it can't be in the
// repo): the same data and Manifest / All DEXs switch, drawn with TradingView's open-source
// Lightweight Charts. No drawing tools or indicators; open orders show as price lines.
const INTERVALS = [['1', '1m'], ['5', '5m'], ['15', '15m'], ['60', '1h'], ['240', '4h'], ['1D', '1D']];
const SPAN_S = { 1: 60, 5: 300, 15: 900, 60: 3600, 240: 14400, '1D': 86400 };
const BARS = 300;
const UP = '#2ebd85', DOWN = '#f6465d';
const COLORS = {
  dark: { bg: '#12161c', grid: 'rgba(255,255,255,0.04)', text: '#8a94a3', line: '#232a33' },
  light: { bg: '#ffffff', grid: 'rgba(0,0,0,0.06)', text: '#5a6575', line: '#e2e6ec' },
};
const look = (theme) => {
  const c = COLORS[theme] || COLORS.dark;
  return {
    layout: { background: { color: c.bg }, textColor: c.text },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.line },
    timeScale: { borderColor: c.line, timeVisible: true, secondsVisible: false },
  };
};
const toCandle = (b) => ({ time: Math.floor(b.time / 1000), open: b.open, high: b.high, low: b.low, close: b.close });
const toVolume = (b) => ({ time: Math.floor(b.time / 1000), value: b.volume || 0, color: b.close >= b.open ? `${UP}66` : `${DOWN}66` });

export default function LightweightChart({ address, market, ammOnly = false, onTrade, orders = [] }) {
  const boxRef = useRef(null);
  const chartRef = useRef(null);
  const candlesRef = useRef(null);
  const volumeRef = useRef(null);
  const linesRef = useRef([]);
  const onTradeRef = useRef(onTrade);
  onTradeRef.current = onTrade;
  const { theme } = useTheme();
  const [resolution, setResolution] = useState('15');
  const [chosen, setChosen] = useState(null);
  const [emptyManifest, setEmptyManifest] = useState(null); // market whose Manifest chart came back empty
  const [status, setStatus] = useState('loading'); // loading | ready | empty | error
  const [label, setLabel] = useState('');

  // As on the full chart: a market with no price of its own opens on All DEXs. So does one whose
  // Manifest chart is empty (a fresh install has no trade history yet), unless the visitor picked.
  const noPrice = market?.address === address && market.last == null;
  const source = ammOnly ? 'amm' : chosen || (noPrice || emptyManifest === address ? 'amm' : 'manifest');
  const ticker = source === 'amm' ? ammTicker(address) : address;
  const sourceKnown = ammOnly || market?.address === address;

  useEffect(() => {
    const chart = createChart(boxRef.current, { autoSize: true, ...look(theme) });
    candlesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
    });
    volumeRef.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
    volumeRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      linesRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { chartRef.current?.applyOptions(look(theme)); }, [theme]);

  useEffect(() => {
    if (!sourceKnown) return undefined;
    let live = true;
    const guid = `lw-${ticker}-${resolution}`;
    const feed = createDatafeed((_address, fn) => onTradeRef.current(fn));
    setStatus('loading');
    feed.resolveSymbol(ticker, (info) => {
      if (!live) return;
      setLabel(info.exchange);
      const precision = Math.max(0, Math.round(Math.log10(info.pricescale)));
      candlesRef.current.applyOptions({ priceFormat: { type: 'price', precision, minMove: 1 / info.pricescale } });
      const to = Math.floor(Date.now() / 1000) + SPAN_S[resolution];
      feed.getBars(info, resolution, { from: to - BARS * SPAN_S[resolution], to, countBack: BARS, firstDataRequest: true }, (bars) => {
        if (!live) return;
        candlesRef.current.setData(bars.map(toCandle));
        volumeRef.current.setData(bars.map(toVolume));
        chartRef.current?.timeScale().fitContent();
        setStatus(bars.length ? 'ready' : 'empty');
        if (!bars.length && source === 'manifest') setEmptyManifest(address);
        feed.subscribeBars(info, resolution, (bar) => {
          if (!live) return;
          try {
            candlesRef.current.update(toCandle(bar));
            volumeRef.current.update(toVolume(bar));
          } catch { /* a bar older than the last one: skip it */ }
        }, guid);
      }, () => live && setStatus('error'));
    }, () => live && setStatus('error'));
    return () => {
      live = false;
      feed.unsubscribeBars(guid);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, resolution, sourceKnown]);

  // The wallet's open orders on this market as price lines.
  useEffect(() => {
    const series = candlesRef.current;
    if (!series) return;
    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = (orders || [])
      .filter(o => o.market === address && (o.status === 'open' || o.status === 'expired'))
      .map(o => series.createPriceLine({
        price: o.price,
        color: o.side === 'buy' ? UP : DOWN,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `${o.side === 'buy' ? 'Buy' : 'Sell'} ${formatAmount(o.remaining ?? o.size)}`,
      }));
  }, [orders, address, status]);

  return (
    <div className="lw-wrap">
      <div className="lw-toolbar">
        {INTERVALS.map(([id, text]) => (
          <button key={id} type="button" className={`lw-btn ${resolution === id ? 'active' : ''}`} onClick={() => setResolution(id)}>{text}</button>
        ))}
        <span className="lw-sep" />
        {ammOnly ? (
          <span className="lw-btn active" title="No Manifest market for this pair yet">All DEXs</span>
        ) : (
          <>
            <button type="button" className={`lw-btn ${source === 'manifest' ? 'active' : ''}`} onClick={() => setChosen('manifest')} title="Trades on the order book your limit orders rest on">Manifest</button>
            <button type="button" className={`lw-btn ${source === 'amm' ? 'active' : ''}`} onClick={() => setChosen('amm')} title="The price of this pair across every Solana DEX (Jupiter)">All DEXs</button>
          </>
        )}
        <span className="lw-label muted">{label}</span>
      </div>
      <div ref={boxRef} className="lw-chart" />
      {status !== 'ready' && (
        <div className="lw-status muted">
          {status === 'loading' ? <span className="spinner" /> : status === 'empty' ? 'No trades in this period yet.' : 'Chart data is unavailable right now.'}
        </div>
      )}
    </div>
  );
}
