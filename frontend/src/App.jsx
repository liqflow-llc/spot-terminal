import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import TradePage from './components/TradePage.jsx';
import { lazy, Suspense } from 'react';
// Pages most visits never open load on demand.
const AccountPage = lazy(() => import('./components/AccountPage.jsx'));
const Terms = lazy(() => import('./legal/Terms.jsx'));
const Privacy = lazy(() => import('./legal/Privacy.jsx'));
const pageFallback = <div className="boot"><span className="spinner" /></div>;
import { getJSON } from './services/api';
import { useBrandTitleWhileConnecting } from './pageTitle';

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
  useBrandTitleWhileConnecting();
  return (
    <Routes>
      <Route path="/" element={<DefaultMarket />} />
      <Route path="/trade/:address" element={<TradePage />} />
      <Route path="/account" element={<Suspense fallback={pageFallback}><AccountPage /></Suspense>} />
      <Route path="/terms" element={<Suspense fallback={pageFallback}><Terms /></Suspense>} />
      <Route path="/privacy" element={<Suspense fallback={pageFallback}><Privacy /></Suspense>} />
      <Route path="/orderbook" element={<LegacyOrderbook />} />
      <Route path="*" element={<DefaultMarket />} />
    </Routes>
  );
}
