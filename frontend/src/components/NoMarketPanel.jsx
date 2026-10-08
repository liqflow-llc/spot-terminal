import { useState } from 'react';
import CreateMarketModal, { createPairProps } from './CreateMarketModal.jsx';
import { formatPrice } from '../utils/format';
import './OrderBook.css';

/**
 * The order book's place on a pair with no Manifest market yet: what that means, and the button
 * that creates one (then limit orders can rest on it).
 */
export default function NoMarketPanel({ market }) {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="panel-title"><span>Order book</span></div>
      <div className="ob-nomarket">
        {!market ? <span className="spinner" /> : (
          <>
            <p className="ob-nomarket-title">No {market.symbol} order book yet</p>
            <p className="muted">
              You can still trade {market.base.symbol} now: market orders, and limit orders Jupiter can fill
              in full at your price, go through Jupiter at the best price across every Solana DEX.
            </p>
            {market.last ? (
              <p className="ob-nomarket-price">
                <span className="muted">Market price</span>{' '}
                <strong className="num">{formatPrice(market.last)} {market.quote.symbol}</strong>
              </p>
            ) : null}
            <p className="muted">
              To place a limit order that waits for its price, create the market first. It becomes a
              zero-fee {market.symbol} order book anyone can trade.
            </p>
            <button type="button" className="btn primary" onClick={() => setCreating(true)}>Create {market.symbol} market</button>
          </>
        )}
      </div>
      {creating && market && <CreateMarketModal {...createPairProps(market.base.mint, market.quote.mint)} onClose={() => setCreating(false)} />}
    </>
  );
}
