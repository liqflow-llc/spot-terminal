import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import TradePage from './components/TradePage.jsx';
import AccountPage from './components/AccountPage.jsx';
import { getJSON } from './services/api';

/** Send "/" to the busiest verified market. */
function DefaultMarket() {
  const [target, setTarget] = useState(null);
  useEffect(() => {
    getJSON('/api/markets?q=SOL/USDC&limit=1')
      .then(r => setTarget(r.markets[0]?.address || ''))
      .catch(() => setTarget(''));
  }, []);
  if (target === null) return <div className="boot"><span className="spinner" /> Loading markets…</div>;
  return <Navigate to={target ? `/trade/${target}` : '/trade'} replace />;
}

/** Old juporderbook.com links: /orderbook?token=<symbol or mint> -> that token's busiest market. */
function LegacyOrderbook() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [target, setTarget] = useState(null);
  useEffect(() => {
    getJSON(`/api/markets?q=${encodeURIComponent(token)}&limit=1`)
      .then(r => setTarget(r.markets[0]?.address || ''))
      .catch(() => setTarget(''));
  }, [token]);
  if (target === null) return <div className="boot"><span className="spinner" /> Loading…</div>;
  return target ? <Navigate to={`/trade/${target}`} replace /> : <Navigate to="/" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DefaultMarket />} />
      <Route path="/trade/:address" element={<TradePage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="/orderbook" element={<LegacyOrderbook />} />
      <Route path="*" element={<DefaultMarket />} />
    </Routes>
  );
}
