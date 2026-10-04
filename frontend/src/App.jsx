import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import TradePage from './components/TradePage.jsx';
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

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DefaultMarket />} />
      <Route path="/trade/:address" element={<TradePage />} />
      <Route path="*" element={<DefaultMarket />} />
    </Routes>
  );
}
