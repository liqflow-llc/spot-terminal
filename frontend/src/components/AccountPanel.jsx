import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useToast } from './Toasts.jsx';
import { postJSON } from '../services/api';
import { explorerTx, isUserRejection, signAndSubmit } from '../services/signing';
import { formatAmount, formatDateTime, formatPrice } from '../utils/format';
import { reportError } from '../services/report';
import './AccountPanel.css';
import EditOrderModal from './EditOrderModal.jsx';

const OPEN = new Set(['placing', 'open', 'claiming', 'expired', 'replacing']);
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
  expired: 'Expired · withdraw',
  replacing: 'Updating',
};

// An open order filled all but a sliver: its pre-signed payout is for the full amount, so it waits
// on a remainder nobody will take. Cancelling collects everything (one approval).
const DUST_LEFT = 0.001;
const isDustLeft = (o) => o.status === 'open' && o.remaining > 0 && o.remaining / o.size <= DUST_LEFT;

export default function AccountPanel({ account, market, wallet, onChange, action }) {
  const { signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();
  const toast = useToast();
  const [tab, setTab] = useState(TABS[0]);
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(null);

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
      else {
        toast({ kind: 'error', title: 'Failed', message: err.message });
        reportError(`${request.url.split('/').pop()}_failed`, err, { wallet, market: market?.address });
      }
    } finally {
      setBusy(null);
    }
  }

  const cancel = (o) => run(o.id, { url: '/api/orders/cancel', body: { orderId: o.id } },
    o.status === 'expired' ? 'Withdrawn to wallet' : isDustLeft(o) ? 'Collected to wallet' : 'Order cancelled, funds returned');
  // Actions started from the chart's order lines.
  useEffect(() => {
    if (!action) return;
    if (action.type === 'cancel') cancel(action.order);
    else if (action.type === 'edit' && action.order.status === 'open') setEditing({ ...action.order, initialPrice: action.price });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);
  const cancellable = open.filter(o => o.market === market?.address && (o.status === 'open' || o.status === 'expired'));
  const cancelAll = () => run('cancel-all', { url: '/api/orders/cancel-all', body: { market: market.address } }, 'Orders cancelled, funds returned');
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
        <div className="ap-title-actions">
        {tab === 'Open orders' && cancellable.length > 1 && (
          <button type="button" className="btn small" disabled={busy === 'cancel-all'} onClick={cancelAll} title="Cancel every open order on this market and return the funds">
            {busy === 'cancel-all' ? '…' : `Cancel all (${cancellable.length})`}
          </button>
        )}
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
            onEdit={tab === 'Open orders' ? setEditing : null}
            busy={busy}
            empty={tab === 'Open orders' ? 'No open orders' : 'No past orders yet'}
          />
        )}
      </div>
      {editing && <EditOrderModal order={editing} onClose={() => setEditing(null)} onDone={onChange} />}
    </>
  );
}

/** "3h 20m" / "2d 4h" until an order expires, or null. */
function expiresIn(o) {
  if (!o.expiresAt) return null;
  const m = Math.max(1, Math.floor((o.expiresAt - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

function OrdersTable({ orders, market, onCancel, onEdit, busy, empty }) {
  if (!orders.length) return <div className="ap-empty muted">{empty}</div>;
  return (
    <table className="ap-table">
      <thead>
        <tr>
          <th>Time</th><th>Pair</th><th>Side</th><th className="r">Price</th><th className="r">Amount</th>
          <th className="r">Filled</th><th>Status</th>{onCancel && <th>Expires</th>}<th />
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
                {isDustLeft(o)
                  ? <span className="status claiming" title={`Filled except ${formatAmount(o.remaining)}, too little for anyone to take, so the automatic payout can't run. Collect moves everything to your wallet.`}>Filled · collect</span>
                  : o.status === 'claimed' && o.remainderOnBook
                    ? <span className="status claimed" title="Paid out. What was left (worth under $5) is still on the book; cancel it and withdraw from the Account page.">Filled · paid to wallet*</span>
                    : <span className={`status ${o.status}`} title={o.error || o.note || ''}>{STATUS[o.status] || o.status}</span>}
                {link && <a className="tx-link" href={explorerTx(link)} target="_blank" rel="noreferrer">↗</a>}
              </td>
              {onCancel && <td className="num muted">{o.status === 'expired' ? 'expired' : (expiresIn(o) || 'never')}</td>}
              <td className="r ap-actions">
                {onEdit && o.status === 'open' && !isDustLeft(o) && o.market === market?.address && (
                  <button type="button" className="btn small" disabled={!!busy} onClick={() => onEdit(o)}>Edit</button>
                )}
                {onCancel && (o.status === 'open' || o.status === 'expired') && (
                  <button type="button" className={`btn small ${o.status === 'expired' || isDustLeft(o) ? 'primary' : ''}`} disabled={busy === o.id} onClick={() => onCancel(o)}>
                    {busy === o.id ? '…' : o.status === 'expired' ? 'Withdraw' : isDustLeft(o) ? 'Collect' : 'Cancel'}
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
