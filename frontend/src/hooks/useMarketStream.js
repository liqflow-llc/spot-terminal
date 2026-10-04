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

    const es = new EventSource(`/api/stream?market=${encodeURIComponent(address)}`);
    es.addEventListener('book', (e) => setBook(JSON.parse(e.data)));
    es.addEventListener('ticker', (e) => setMarket(JSON.parse(e.data)));
    es.addEventListener('trade', (e) => {
      const trade = JSON.parse(e.data);
      setTrades(ts => [trade, ...ts].slice(0, 120));
      tradeListeners.current.forEach(fn => fn(trade));
    });
    return () => {
      closed = true;
      es.close();
    };
  }, [address]);

  /** Subscribe to live trades (used by the chart). Returns an unsubscribe function. */
  const onTrade = useCallback((fn) => {
    tradeListeners.current.add(fn);
    return () => tradeListeners.current.delete(fn);
  }, []);

  return { market, book, trades, onTrade, error };
}
