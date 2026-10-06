import { useEffect, useRef, useState } from 'react';
import { createDatafeed } from '../services/datafeed';
import { formatAmount } from '../utils/format';
import { reportError } from '../services/report';
import './TradingViewChart.css';

// The Advanced Charts library is a licensed static bundle served from /charting_library/
// (copied in by scripts/setup-charting-library.sh). It loads its own chunks at runtime,
// so it is script-tag loaded rather than bundled by Vite.
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

const BG = '#12161c';
const OVERRIDES = {
  'paneProperties.background': BG,
  'paneProperties.backgroundType': 'solid',
  'paneProperties.vertGridProperties.color': 'rgba(255,255,255,0.04)',
  'paneProperties.horzGridProperties.color': 'rgba(255,255,255,0.04)',
  'scalesProperties.textColor': '#8a94a3',
  'scalesProperties.lineColor': '#232a33',
  'mainSeriesProperties.candleStyle.upColor': '#2ebd85',
  'mainSeriesProperties.candleStyle.downColor': '#f6465d',
  'mainSeriesProperties.candleStyle.borderUpColor': '#2ebd85',
  'mainSeriesProperties.candleStyle.borderDownColor': '#f6465d',
  'mainSeriesProperties.candleStyle.wickUpColor': '#2ebd85',
  'mainSeriesProperties.candleStyle.wickDownColor': '#f6465d',
};

const DISABLED_FEATURES = [
  'header_symbol_search',
  'header_compare',
  'header_saveload',
  'symbol_search_hot_key',
  'popup_hints',
];

const BID = '#2ebd85', ASK = '#f6465d', MUTED = '#6f7a89';
const LINE_STATUSES = new Set(['open', 'expired', 'placing', 'replacing']);

export default function TradingViewChart({ address, onTrade, orders = [], onCancelOrder, onMoveOrder }) {
  const containerRef = useRef(null);
  const widgetRef = useRef(null);
  const readyRef = useRef(false);
  const onTradeRef = useRef(onTrade);
  const addressRef = useRef(address); // the market we should show
  const shownRef = useRef(null);      // the market the chart was last told to show
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(0); // bumps when the chart is ready or shows a new market
  const linesRef = useRef(new Map());     // order id -> { key, line }   (open orders)
  const fillsRef = useRef(new Map());     // order id -> shape           (filled orders)
  const handlersRef = useRef({});
  handlersRef.current = { onCancelOrder, onMoveOrder };
  onTradeRef.current = onTrade;
  addressRef.current = address;

  // Create the widget once; market changes are applied with setSymbol below.
  useEffect(() => {
    let cancelled = false;
    const datafeed = createDatafeed((_address, fn) => onTradeRef.current(fn));
    loadLibrary().then(() => {
      if (cancelled || !containerRef.current) return;
      const widget = new window.TradingView.widget({
        container: containerRef.current,
        library_path: LIBRARY_PATH,
        datafeed,
        symbol: (shownRef.current = addressRef.current),
        interval: '15',
        locale: 'en',
        theme: 'dark',
        autosize: true,
        timezone: 'Etc/UTC',
        disabled_features: DISABLED_FEATURES,
        enabled_features: ['hide_left_toolbar_by_default'],
        overrides: OVERRIDES,
        loading_screen: { backgroundColor: BG, foregroundColor: '#4c8dff' },
      });
      widgetRef.current = widget;
      widget.onChartReady(() => {
        readyRef.current = true;
        // The market may have changed while the first chart was still loading.
        if (shownRef.current !== addressRef.current) widget.activeChart().setSymbol((shownRef.current = addressRef.current));
        setReady(r => r + 1);
      });
    }).catch(err => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
      readyRef.current = false;
      widgetRef.current?.remove();
      widgetRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const widget = widgetRef.current;
    if (widget && readyRef.current && shownRef.current !== address) {
      widget.activeChart().setSymbol((shownRef.current = address), () => setReady(r => r + 1));
    }
  }, [address]);

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
        text: `${o.side === 'buy' ? 'Buy' : 'Sell'} ${formatQty(left)}${o.status === 'expired' ? ' · expired' : o.status === 'open' ? ' · drag to edit' : ''}`,
        lock: o.status !== 'open',
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
      {error ? <div className="tv-error">{error}</div> : <div ref={containerRef} className="tv-container" />}
    </div>
  );
}

const lineKey = (o, address) => `${address}|${o.price}|${o.remaining ?? o.size}|${o.status}`;
const formatQty = (n) => formatAmount(n);
