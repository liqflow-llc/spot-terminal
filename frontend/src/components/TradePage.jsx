import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import TopBar from './TopBar.jsx';
import MarketHeader from './MarketHeader.jsx';
import OrderBook from './OrderBook.jsx';
import Trades from './Trades.jsx';
import TradingViewChart from './TradingViewChart.jsx';
import OrderForm from './OrderForm.jsx';
import AccountPanel from './AccountPanel.jsx';
import { useMarketStream } from '../hooks/useMarketStream';
import { useAccount } from '../hooks/useAccount';
import './TradePage.css';

const MOBILE_TABS = ['Chart', 'Book', 'Trades'];

export default function TradePage() {
  const { address } = useParams();
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() || null;
  const { market, book, trades, onTrade, error } = useMarketStream(address);
  const { account, refresh } = useAccount(wallet, address);
  const [pickedPrice, setPickedPrice] = useState(null);
  const [mobileTab, setMobileTab] = useState('Chart');

  useEffect(() => {
    if (market) document.title = `${market.last ? market.last.toPrecision(6) : ''} ${market.symbol} · Spot`;
  }, [market]);

  // Clicking a book level fills the order form's price.
  const pickPrice = useCallback((price) => setPickedPrice({ price, at: Date.now() }), []);

  if (error) {
    return (
      <div className="app">
        <TopBar />
        <div className="boot">Market not found. <a href="/">Go to SOL/USDC</a></div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar />
      <MarketHeader market={market} />
      <div className="mobile-tabs">
        {MOBILE_TABS.map(t => (
          <button key={t} type="button" className={`tab ${mobileTab === t ? 'active' : ''}`} onClick={() => setMobileTab(t)}>{t}</button>
        ))}
      </div>
      <main className={`trade-grid show-${mobileTab.toLowerCase()}`}>
        <section className="panel area-book">
          <OrderBook book={book} market={market} onPick={pickPrice} />
        </section>
        <section className="panel area-chart">
          <TradingViewChart address={address} market={market} onTrade={onTrade} />
        </section>
        <section className="panel area-form">
          <OrderForm market={market} book={book} account={account} pickedPrice={pickedPrice} onPlaced={refresh} />
        </section>
        <section className="panel area-trades">
          <Trades trades={trades} market={market} />
        </section>
        <section className="panel area-account">
          <AccountPanel account={account} market={market} wallet={wallet} onChange={refresh} />
        </section>
      </main>
    </div>
  );
}
