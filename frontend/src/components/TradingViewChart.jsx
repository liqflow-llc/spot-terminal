import { useEffect, useRef, useState } from 'react';
import { createDatafeed } from '../services/datafeed';
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

export default function TradingViewChart({ address, onTrade }) {
  const containerRef = useRef(null);
  const widgetRef = useRef(null);
  const readyRef = useRef(false);
  const onTradeRef = useRef(onTrade);
  const addressRef = useRef(address); // the market we should show
  const shownRef = useRef(null);      // the market the chart was last told to show
  const [error, setError] = useState(null);
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
    if (widget && readyRef.current && shownRef.current !== address) widget.activeChart().setSymbol((shownRef.current = address));
  }, [address]);

  return (
    <div className="tv-wrap">
      {error ? <div className="tv-error">{error}</div> : <div ref={containerRef} className="tv-container" />}
    </div>
  );
}
