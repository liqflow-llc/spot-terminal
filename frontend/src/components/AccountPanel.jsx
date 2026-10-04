import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useToast } from './Toasts.jsx';
import { postJSON } from '../services/api';
import { explorerTx, isUserRejection, signAndSubmit } from '../services/signing';
import { formatAmount, formatDateTime, formatPrice } from '../utils/format';
import './AccountPanel.css';

const OPEN = new Set(['placing', 'open', 'claiming']);
const TABS = ['Open orders', 'Order history', 'Balances'];

const STATUS = {
  placing: 'Placing',
  open: 'Open',
  claiming: 'Paying out',
  claimed: 'Filled · paid to wallet',
  cancelled: 'Cancelled',
  closed: 'Closed',
  failed: 'Failed',
  claim_failed: 'Filled · withdraw needed',
};

export default function AccountPanel({ account, market, wallet, onChange }) {
  const { signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();
  const toast = useToast();
  const [tab, setTab] = useState(TABS[0]);
  const [busy, setBusy] = useState(null);

  const orders = account?.orders || [];
  const open = orders.filter(o => OPEN.has(o.status));
  const history = orders.filter(o => !OPEN.has(o.status));

  async function run(key, request, successTitle) {
    setBusy(key);
    try {
      const prepared = await postJSON(request.url, { wallet, ...request.body });
      const res = await signAndSubmit(prepared, signAllTransactions);
      toast({ kind: 'success', title: successTitle, link: explorerTx(res.signature) });
      onChange?.();
    } catch (err) {
      if (isUserRejection(err)) toast({ title: 'Cancelled in wallet' });
      else toast({ kind: 'error', title: 'Failed', message: err.message });
    } finally {
      setBusy(null);
    }
  }

  const cancel = (o) => run(o.id, { url: '/api/orders/cancel', body: { orderId: o.id } }, 'Order cancelled, funds returned');
  const withdraw = () => run('withdraw', { url: '/api/orders/withdraw', body: { market: market.address } }, 'Withdrawn to wallet');

  return (
    <>
      <div className="panel-title">
        <div className="tabs">
          {TABS.map(t => (
            <button key={t} type="button" className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t}{t === 'Open orders' && open.length ? ` (${open.length})` : ''}
            </button>
          ))}
        </div>
      </div>
      <div className="ap-body">
        {!wallet ? (
          <div className="ap-empty">
            <button type="button" className="btn" onClick={() => setVisible(true)}>Connect wallet</button>
            <span className="muted">to see your orders and balances</span>
          </div>
        ) : !account ? (
          <div className="ap-empty"><span className="spinner" /></div>
        ) : tab === 'Balances' ? (
          <Balances account={account} market={market} onWithdraw={withdraw} busy={busy === 'withdraw'} />
        ) : (
          <OrdersTable
            orders={tab === 'Open orders' ? open : history}
            market={market}
            onCancel={tab === 'Open orders' ? cancel : null}
            busy={busy}
            empty={tab === 'Open orders' ? 'No open orders' : 'No past orders yet'}
          />
        )}
      </div>
    </>
  );
}

function OrdersTable({ orders, market, onCancel, busy, empty }) {
  if (!orders.length) return <div className="ap-empty muted">{empty}</div>;
  return (
    <table className="ap-table">
      <thead>
        <tr>
          <th>Time</th><th>Pair</th><th>Side</th><th className="r">Price</th><th className="r">Amount</th>
          <th className="r">Filled</th><th>Status</th><th />
        </tr>
      </thead>
      <tbody>
        {orders.map(o => {
          const filled = o.status === 'claimed' ? 1 : o.remaining != null ? 1 - o.remaining / o.size : null;
          const link = o.claimSignature || o.cancelSignature || o.placeSignature;
          return (
            <tr key={o.id} className={o.market === market?.address ? '' : 'other-market'}>
              <td className="num muted">{formatDateTime(o.createdAt)}</td>
              <td>{o.symbol || '—'}</td>
              <td className={o.side === 'buy' ? 'bid' : 'ask'}>{o.side === 'buy' ? 'Buy' : 'Sell'}</td>
              <td className="r num">{formatPrice(o.price)}</td>
              <td className="r num">{formatAmount(o.size)}</td>
              <td className="r num">{filled == null ? '—' : `${Math.max(0, Math.min(100, filled * 100)).toFixed(1)}%`}</td>
              <td>
                <span className={`status ${o.status}`} title={o.error || o.note || ''}>{STATUS[o.status] || o.status}</span>
                {link && <a className="tx-link" href={explorerTx(link)} target="_blank" rel="noreferrer">↗</a>}
              </td>
              <td className="r">
                {onCancel && o.status === 'open' && (
                  <button type="button" className="btn small" disabled={busy === o.id} onClick={() => onCancel(o)}>
                    {busy === o.id ? '…' : 'Cancel'}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Balances({ account, market, onWithdraw, busy }) {
  if (!market) return null;
  const inMarket = account.inMarket;
  const hasLeftovers = inMarket && (inMarket.base > 0 || inMarket.quote > 0);
  return (
    <div className="ap-balances">
      <table className="ap-table">
        <thead><tr><th>Token</th><th className="r">In wallet</th><th className="r">Waiting in market</th></tr></thead>
        <tbody>
          <tr><td>{market.base.symbol}</td><td className="r num">{formatAmount(account.wallet?.base)}</td><td className="r num">{formatAmount(inMarket?.base || 0)}</td></tr>
          <tr><td>{market.quote.symbol}</td><td className="r num">{formatAmount(account.wallet?.quote)}</td><td className="r num">{formatAmount(inMarket?.quote || 0)}</td></tr>
        </tbody>
      </table>
      <div className="ap-withdraw">
        <span className="muted">
          {hasLeftovers
            ? 'Partial fills and leftovers wait in the market until the order completes or is cancelled. You can move them now.'
            : 'Nothing waiting in this market. Filled orders pay out to your wallet automatically.'}
        </span>
        {hasLeftovers && <button type="button" className="btn small" disabled={busy} onClick={onWithdraw}>{busy ? '…' : 'Withdraw to wallet'}</button>}
      </div>
    </div>
  );
}
