import { useState } from 'react';
import CreateMarketModal, { createPairProps } from './CreateMarketModal.jsx';
import './OrderBook.css';

/** "This market doesn't exist" with a button that creates it (book panel and Limit tab). */
export function NoMarketNotice({ market }) {
  const [creating, setCreating] = useState(false);
  if (!market) return <span className="spinner" />;
  return (
    <div className="no-market-notice">
      <p>This market doesn&rsquo;t exist. Either create the market or use a market order.</p>
      <button type="button" className="btn primary" onClick={() => setCreating(true)}>Create {market.symbol} market</button>
      {creating && <CreateMarketModal {...createPairProps(market.base.mint, market.quote.mint)} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** The order book's place on a pair with no Manifest market. */
export default function NoMarketPanel({ market }) {
  return (
    <>
      <div className="panel-title"><span>Order book</span></div>
      <div className="ob-nomarket"><NoMarketNotice market={market} /></div>
    </>
  );
}
