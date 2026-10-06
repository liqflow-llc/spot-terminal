import { useCallback, useEffect, useRef, useState } from 'react';
import { getJSON } from '../services/api';

/** Live data for one market: ticker, aggregated book and recent trades, over one EventSource. */
export function useMarketStream(address) {
  const [market, setMarket] = useState(null);
  const [book, setBook] = useState(null);
  const [trades, setTrades] = useState([]);
  const [error, setError] = useState(null);
  const tradeListeners = useRef(new Set());

  useEffect(() => {
    if (!address) return undefined;
    let closed = false;
    setMarket(null);
    setBook(null);
    setTrades([]);
    setError(null);

    getJSON(`/api/markets/${address}`).then(m => !closed && setMarket(m)).catch(err => !closed && setError(err.message));
    getJSON(`/api/markets/${address}/trades?limit=80`).then(r => !closed && setTrades(r.trades)).catch(() => {});

    // The server polls the chain for every open stream, so drop it while the tab is hidden and
    // reconnect (with a fresh book) when it's visible again.
    let es = null;
    const open = () => {
      if (es || closed) return;
      es = new EventSource(`/api/stream?market=${encodeURIComponent(address)}`);
      es.addEventListener('book', (e) => setBook(JSON.parse(e.data)));
      es.addEventListener('ticker', (e) => setMarket(JSON.parse(e.data)));
      es.addEventListener('trade', (e) => {
        const trade = JSON.parse(e.data);
        setTrades(ts => [trade, ...ts].slice(0, 120));
        // The chart is the Manifest market's own; Archer trades show in the list only.
        if (trade.venue !== 'archer') tradeListeners.current.forEach(fn => fn(trade));
      });
      // A batch of recent Archer trades when its stream (re)connects: merge without duplicates.
      es.addEventListener('trades', (e) => {
        const batch = JSON.parse(e.data);
        setTrades(ts => {
          const seen = new Set(ts.map(t => `${t.signature}|${t.time}|${t.size}`));
          return [...ts, ...batch.filter(t => !seen.has(`${t.signature}|${t.time}|${t.size}`))]
            .sort((a, b) => b.time - a.time).slice(0, 120);
        });
      });
    };
    const close = () => {
      es?.close();
      es = null;
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? close() : open());
    if (document.visibilityState !== 'hidden') open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    };
  }, [address]);

  /** Subscribe to live trades (used by the chart). Returns an unsubscribe function. */
  const onTrade = useCallback((fn) => {
    tradeListeners.current.add(fn);
    return () => tradeListeners.current.delete(fn);
  }, []);

  return { market, book, trades, onTrade, error };
}
