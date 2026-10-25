import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ammTicker, createDatafeed } from '../services/datafeed';
import { formatAmount } from '../utils/format';
import { reportError } from '../services/report';
import { useTheme } from '../theme';
import './TradingViewChart.css';

// Without the licensed bundle (a fresh clone of the open-source repo), the free chart instead.
const LightweightChart = lazy(() => import('./LightweightChart.jsx'));

// The Advanced Charts library is a licensed static bundle served from /charting_library/
// (copied in by scripts/setup-charting-library.sh). It loads its own chunks at runtime,
// so it is script-tag loaded rather than bundled by Vite. Not every install has it (it can't be
// redistributed): when it doesn't load, the page uses LightweightChart.jsx.
const LIBRARY_PATH = '/charting_library/';

let libraryPromise = null;
function loadLibrary() {
  if (window.TradingView?.widget) return Promise.resolve();
  libraryPromise ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${LIBRARY_PATH}charting_library.standalone.js`;
    script.async = true;
    script.onload = () => (window.TradingView?.widget ? resolve() : reject(new Error('Charting library did not initialise')));
    script.onerror = () => {
      libraryPromise = null;
      reject(new Error('Failed to load the charting library'));
    };
    document.head.appendChild(script);
  });
  return libraryPromise;
}

// Chart colours per site theme (TradingView can't read our CSS variables).
const CHART_THEME = {
  dark: { bg: '#12161c', grid: 'rgba(255,255,255,0.04)', text: '#8a94a3', line: '#232a33' },
  light: { bg: '#ffffff', grid: 'rgba(0,0,0,0.06)', text: '#5a6575', line: '#e2e6ec' },
};
const overridesFor = (theme) => ({
  'paneProperties.background': CHART_THEME[theme].bg,
  'paneProperties.backgroundType': 'solid',
  'paneProperties.vertGridProperties.color': CHART_THEME[theme].grid,
  'paneProperties.horzGridProperties.color': CHART_THEME[theme].grid,
  'scalesProperties.textColor': CHART_THEME[theme].text,
  'scalesProperties.lineColor': CHART_THEME[theme].line,
  'mainSeriesProperties.candleStyle.upColor': '#2ebd85',
  'mainSeriesProperties.candleStyle.downColor': '#f6465d',
  'mainSeriesProperties.candleStyle.borderUpColor': '#2ebd85',
  'mainSeriesProperties.candleStyle.borderDownColor': '#f6465d',
  'mainSeriesProperties.candleStyle.wickUpColor': '#2ebd85',
  'mainSeriesProperties.candleStyle.wickDownColor': '#f6465d',
});

const DISABLED_FEATURES = [
  'header_symbol_search',
  'header_compare',
  'header_saveload',
  'symbol_search_hot_key',
  'popup_hints',
];

const BID = '#2ebd85', ASK = '#f6465d', MUTED = '#6f7a89';
const LINE_STATUSES = new Set(['open', 'expired', 'placing', 'replacing']);

export default function TradingViewChart({ address, market, ammOnly = false, onTrade, orders = [], onCancelOrder, onMoveOrder }) {
  const containerRef = useRef(null);
  const widgetRef = useRef(null);
  const readyRef = useRef(false);
  const onTradeRef = useRef(onTrade);
  const addressRef = useRef(address); // the market we should show
  const shownRef = useRef(null);      // the market the chart was last told to show
  const [error, setError] = useState(null);
  // Which chart: SpotTerminal's own book (the default: what limit orders fill against), or the most
  // active pool for the pair anywhere on Solana. A Manifest market with no last price (no trades
  // yet and a one-sided book) has an empty chart, so it starts on the all-DEX one until the
  // visitor picks. A pair with no Manifest market (ammOnly) has only the all-DEX chart.
  const [chosenSource, setSource] = useState(null);
  const noPrice = market?.address === address && market.last == null;
  const source = ammOnly ? 'amm' : chosenSource || (noPrice ? 'amm' : 'manifest');
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const ticker = source === 'amm' ? ammTicker(address) : address;
  const ammOnlyRef = useRef(ammOnly);
  ammOnlyRef.current = ammOnly;
  const toggleRef = useRef(null);
  const { theme } = useTheme();
  const themeRef = useRef(theme);    // the theme the chart is showing
  const [ready, setReady] = useState(0); // bumps when the chart is ready or shows a new market
  const linesRef = useRef(new Map());     // order id -> { key, line }   (open orders)
  const fillsRef = useRef(new Map());     // order id -> shape           (filled orders)
  const handlersRef = useRef({});
  handlersRef.current = { onCancelOrder, onMoveOrder };
  onTradeRef.current = onTrade;
  addressRef.current = ticker; // the symbol the chart should show

  // Create the widget once, when it's known which chart to open (so a market that opens on the
  // all-DEX chart doesn't load its empty Manifest one first); market changes are applied with
  // setSymbol below.
  const sourceKnown = ammOnly || market?.address === address;
  const startedRef = useRef(false);
  const generationRef = useRef(0); // bumped on unmount: a library load still in flight then gives up
  useEffect(() => {
    if (!sourceKnown || startedRef.current) return;
    startedRef.current = true;
    const generation = ++generationRef.current;
    const gone = () => generationRef.current !== generation;
    const datafeed = createDatafeed((_address, fn) => onTradeRef.current(fn));
    loadLibrary().then(() => {
      if (gone() || !containerRef.current) return;
      const widget = new window.TradingView.widget({
        container: containerRef.current,
        library_path: LIBRARY_PATH,
        datafeed,
        symbol: (shownRef.current = addressRef.current),
        interval: '60',
        locale: 'en',
        theme: themeRef.current,
        autosize: true,
        timezone: 'Etc/UTC',
        disabled_features: DISABLED_FEATURES,
        enabled_features: ['hide_left_toolbar_by_default'],
        overrides: overridesFor(themeRef.current),
        loading_screen: { backgroundColor: CHART_THEME[themeRef.current].bg, foregroundColor: '#4c8dff' },
      });
      widgetRef.current = widget;
      // The chart switch, in TradingView's own toolbar.
      widget.headerReady().then(() => {
        if (gone()) return;
        const btn = widget.createButton({ align: 'left' });
        btn.setAttribute('title', 'Manifest: trades on the order book your limit orders rest on. All DEXs: the price of this pair across every Solana DEX (Jupiter), which can pass your limit price briefly without filling it.');
        btn.style.cursor = 'pointer';
        btn.addEventListener('click', () => { if (!ammOnlyRef.current) setSource(sourceRef.current === 'amm' ? 'manifest' : 'amm'); });
        toggleRef.current = btn;
        setReady(r => r + 1);
      }).catch(err => reportError('chart_toggle_failed', err));
      widget.onChartReady(() => {
        readyRef.current = true;
        // The market may have changed while the first chart was still loading.
        if (shownRef.current !== addressRef.current) widget.activeChart().setSymbol((shownRef.current = addressRef.current));
        setReady(r => r + 1);
      });
    }).catch(err => !gone() && setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKnown]);
  useEffect(() => () => {
    generationRef.current++;
    startedRef.current = false;
    readyRef.current = false;
    widgetRef.current?.remove();
    widgetRef.current = null;
  }, []);

  // Follow the site's light/dark setting. Our colours are re-applied whenever the chart is ready,
  // because TradingView restores the pane colours it saved from an earlier visit over `overrides`.
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !readyRef.current) return;
    const switching = themeRef.current !== theme;
    themeRef.current = theme;
    (switching ? widget.changeTheme(theme, { disableUndo: true }) : Promise.resolve())
      .then(() => widget.applyOverrides(overridesFor(theme)))
      .catch(err => reportError('chart_theme_failed', err));
  }, [theme, ready]);

  useEffect(() => {
    const widget = widgetRef.current;
    if (widget && readyRef.current && shownRef.current !== ticker) {
      widget.activeChart().setSymbol((shownRef.current = ticker), () => setReady(r => r + 1));
    }
  }, [ticker]);

  // The switch's label shows both charts, the current one highlighted.
  useEffect(() => {
    const btn = toggleRef.current;
    if (!btn) return;
    const on = 'font-weight:600;color:#4c8dff', off = 'opacity:.7';
    if (ammOnly) {
      btn.style.cursor = 'default';
      btn.setAttribute('title', 'No Manifest market for this pair yet, so this is its price across every Solana DEX (Jupiter).');
      btn.innerHTML = `<span style="${on}">All DEXs</span><span style="opacity:.6;padding-left:6px">· no Manifest market yet</span>`;
      return;
    }
    btn.style.cursor = 'pointer';
    btn.setAttribute('title', 'Manifest: trades on the order book your limit orders rest on. All DEXs: the price of this pair across every Solana DEX (Jupiter), which can pass your limit price briefly without filling it.');
    btn.innerHTML = `<span style="${source === 'manifest' ? on : off}">Manifest</span>`
      + '<span style="opacity:.5;padding:0 6px">|</span>'
      + `<span style="${source === 'amm' ? on : off}">All DEXs</span>`;
  }, [source, ammOnly, ready]);

  // The wallet's open orders as price lines (drag to change the price, ✕ to cancel) and its
  // filled orders as buy/sell markers.
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !readyRef.current) return;
    try {
      drawOrders(widget.activeChart());
    } catch (err) {
      reportError('chart_orders_failed', err); // drawing orders is a nicety; never break the chart
    }
  }, [orders, address, ready]);

  // Our licence is Advanced Charts: the Trading Platform's order lines aren't available, so open
  // orders are plain horizontal-line drawings (drag one to change the price) and fills are arrows.
  function drawOrders(chart) {
    const here = (orders || []).filter(o => o.market === address);
    const open = new Map(here.filter(o => LINE_STATUSES.has(o.status)).map(o => [o.id, o]));
    const filled = new Map(here.filter(o => o.status === 'claimed').map(o => [o.id, o]));
    const removeEntity = (id) => { try { chart.removeEntity(id); } catch { /* already gone */ } };

    for (const [id, entry] of linesRef.current) {
      const o = open.get(id);
      if (!o || entry.key !== lineKey(o, address)) {
        if (entry.entityId) removeEntity(entry.entityId);
        entry.dead = true;
        linesRef.current.delete(id);
      }
    }
    for (const o of open.values()) {
      if (linesRef.current.has(o.id)) continue;
      const entry = { key: lineKey(o, address), entityId: null, order: o };
      linesRef.current.set(o.id, entry);
      const color = o.status === 'expired' ? MUTED : o.side === 'buy' ? BID : ASK;
      const left = o.remaining != null ? o.remaining : o.size;
      chart.createShape({ price: o.price }, {
        shape: 'horizontal_line',
        // Orders found only on-chain can't be edited here (no payout of ours to replace).
        text: `${o.side === 'buy' ? 'Buy' : 'Sell'} ${formatQty(left)}${o.status === 'expired' ? ' · expired' : o.status === 'open' && o.source !== 'chain' ? ' · drag to edit' : ''}`,
        lock: o.status !== 'open' || o.source === 'chain',
        disableSave: true,
        disableUndo: true,
        overrides: { linecolor: color, linestyle: 2, linewidth: 1, showLabel: true, textcolor: color, horzLabelsAlign: 'left', vertLabelsAlign: 'bottom', fontsize: 11, bold: true },
      }).then((entityId) => {
        if (entry.dead) { removeEntity(entityId); return; }
        entry.entityId = entityId;
      }).catch(() => linesRef.current.delete(o.id));
    }

    for (const [id, holder] of fillsRef.current) {
      if (!filled.has(id) || holder.address !== address) {
        if (holder.entityId) removeEntity(holder.entityId);
        holder.dead = true;
        fillsRef.current.delete(id);
      }
    }
    for (const o of filled.values()) {
      if (fillsRef.current.has(o.id)) continue;
      const holder = { address, entityId: null };
      fillsRef.current.set(o.id, holder);
      const buy = o.side === 'buy';
      chart.createShape({ time: Math.floor((o.claimedAt || o.updatedAt || o.createdAt) / 1000), price: o.price }, {
        shape: buy ? 'arrow_up' : 'arrow_down',
        text: `${buy ? 'Bought' : 'Sold'} ${formatQty(o.size)}`,
        lock: true,
        disableSelection: true,
        disableSave: true,
        disableUndo: true,
        overrides: { color: buy ? BID : ASK, arrowColor: buy ? BID : ASK, fontsize: 11 },
      }).then((entityId) => {
        if (holder.dead) { removeEntity(entityId); return; }
        holder.entityId = entityId;
      }).catch(() => fillsRef.current.delete(o.id));
    }
  }

  // Dragging an order's line opens the edit dialog at the new price; the line snaps back until
  // the edit is signed (then it's redrawn at the new price).
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !readyRef.current) return undefined;
    const onDrawing = (entityId, type) => {
      if (type !== 'points_changed') return;
      for (const [id, entry] of linesRef.current) {
        if (entry.entityId !== entityId) continue;
        let price = null;
        try {
          price = widget.activeChart().getShapeById(entityId).getPoints()[0]?.price;
        } catch { /* shape gone */ }
        try { widget.activeChart().removeEntity(entityId); } catch { /* ignore */ }
        entry.dead = true;
        linesRef.current.delete(id);
        setReady(r => r + 1); // redraw at the order's real price
        if (price > 0 && Math.abs(price / entry.order.price - 1) > 1e-6) handlersRef.current.onMoveOrder?.(entry.order, price);
        return;
      }
    };
    widget.subscribe('drawing_event', onDrawing);
    return () => {
      try { widget.unsubscribe('drawing_event', onDrawing); } catch { /* widget gone */ }
    };
  }, [ready > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tv-wrap">
      {error ? (
        <Suspense fallback={<div className="tv-error"><span className="spinner" /></div>}>
          <LightweightChart address={address} market={market} ammOnly={ammOnly} onTrade={onTrade} orders={orders} />
        </Suspense>
      ) : <div ref={containerRef} className="tv-container" />}
    </div>
  );
}

const lineKey = (o, address) => `${address}|${o.price}|${o.remaining ?? o.size}|${o.status}`;
const formatQty = (n) => formatAmount(n);
