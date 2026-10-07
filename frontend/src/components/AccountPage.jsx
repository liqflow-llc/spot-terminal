import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import TopBar from './TopBar.jsx';
import Modal from './Modal.jsx';
import { useToast } from './Toasts.jsx';
import { getJSON, postJSON } from '../services/api';
import { explorerTx, isUserRejection, signAndSubmit } from '../services/signing';
import '../legal/Legal.css';
import './AccountPage.css';
import { reportError } from '../services/report';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { useTheme } from '../theme';

const sol = (n) => `${Number(n || 0).toFixed(5)} SOL`;

export default function AccountPage() {
  const { publicKey, signAllTransactions } = useWallet();
  const wallet = publicKey?.toBase58() || null;
  const toast = useToast();
  const [payout, setPayout] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => { document.title = 'Account · Spot'; }, []);

  const load = useCallback(() => {
    if (!wallet) return setPayout(null);
    setError(null);
    getJSON(`/api/payout-accounts?wallet=${wallet}`).then(setPayout).catch(err => setError(err.message));
  }, [wallet]);
  useEffect(load, [load]);

  async function closeAccount() {
    setConfirming(false);
    setBusy('Preparing…');
    try {
      const prepared = await postJSON('/api/payout-accounts/close', { wallet });
      setBusy('Approve in your wallet…');
      const res = await signAndSubmit(prepared, signAllTransactions);
      toast({
        kind: 'success',
        title: `Account closed: refunded ${sol(res.refundedSol)}`,
        message: res.cancelled ? `${res.cancelled} open order${res.cancelled === 1 ? ' was' : 's were'} cancelled and the funds returned to your wallet.` : undefined,
        link: explorerTx(res.signature),
      });
    } catch (err) {
      if (!isUserRejection(err)) {
        toast({ kind: 'error', title: 'Account not closed', message: err.message });
        reportError('close_account_failed', err, { wallet });
      }
    } finally {
      setBusy(null);
      load();
    }
  }

  const count = payout?.accounts.length || 0;
  const openOrders = payout?.openOrders || 0;
  const ordersText = `${openOrders} open order${openOrders === 1 ? '' : 's'}`;
  const push = usePushNotifications(wallet);
  const { pref: themePref, setPref: setThemePref } = useTheme();

  return (
    <div className="app account-page">
      <TopBar />
      <main className="account-main">
        <h1>Account</h1>

        <section className="account-card">
          <h2>Notifications</h2>
          <p className="muted">
            Get a notification on this device when an order fills and is paid out, expires, or needs
            you to withdraw. Works with the site closed.
          </p>
          {!wallet ? (
            <div className="account-connect">
              <span>Connect your wallet to turn on notifications.</span>
              <WalletMultiButton />
            </div>
          ) : push.status === 'unsupported' ? (
            <p className="muted small">
              This browser doesn&apos;t support notifications. On iPhone, add this site to your home screen
              (Share → Add to Home Screen) and open it from there.
            </p>
          ) : push.status === 'blocked' ? (
            <p className="muted small">Notifications are blocked for this site. Allow them in your browser&apos;s site settings, then reload.</p>
          ) : (
            <>
              <div className="account-row">
                {push.status === 'on' ? '🔔 On for this device' : '🔕 Off'}
              </div>
              <button
                type="button"
                className={`btn ${push.status === 'on' ? '' : 'primary'}`}
                disabled={push.status === 'working'}
                onClick={push.status === 'on' ? push.disable : push.enable}
              >
                {push.status === 'working' ? '…' : push.status === 'on' ? 'Turn off' : 'Turn on notifications'}
              </button>
              {push.error && <div className="account-row error">{push.error}</div>}
            </>
          )}
        </section>

        <section className="account-card">
          <h2>Appearance</h2>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={themePref === value}
                className={themePref === value ? 'active' : ''}
                onClick={() => setThemePref(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="muted small">System follows your device&apos;s light or dark setting. Saved in this browser.</p>
        </section>

        <section className="account-card">
          <h2>Close account and refund SOL rent</h2>
          <p className="muted">
            Your payout accounts (they send filled orders straight to your wallet) hold a small SOL rent.
            Closing your account refunds it. Your next order sets them up again.
          </p>

          {!wallet && (
            <div className="account-connect">
              <span>Connect your wallet to see your account.</span>
              <WalletMultiButton />
            </div>
          )}

          {wallet && !payout && !error && <div className="account-row"><span className="spinner" /> Loading…</div>}
          {wallet && error && <div className="account-row error">{error} <button type="button" className="btn small" onClick={load}>Retry</button></div>}

          {wallet && payout && (
            count === 0 && openOrders === 0 ? (
              <div className="account-row">Nothing to close. Your account is set up with your first order.</div>
            ) : (
              <>
                {openOrders > 0 && (
                  <p className="account-warning">This also cancels your {ordersText} and returns their funds to your wallet.</p>
                )}
                <button
                  type="button"
                  className="btn danger"
                  disabled={!!busy}
                  onClick={() => (openOrders > 0 ? setConfirming(true) : closeAccount())}
                >
                  {busy || `Close account and refund ${sol(payout.totalSol)}`}
                </button>
              </>
            )
          )}
        </section>

        {confirming && (
          <Modal
            title="Close account?"
            danger
            onClose={() => setConfirming(false)}
            actions={(
              <>
                <button type="button" className="btn" onClick={() => setConfirming(false)}>Keep account</button>
                <button type="button" className="btn danger" onClick={closeAccount}>Cancel orders and close</button>
              </>
            )}
          >
            <p>
              This cancels your <strong>{ordersText}</strong>, returns their funds to your wallet and refunds{' '}
              <strong>{sol(payout?.totalSol)}</strong> of rent.
            </p>
          </Modal>
        )}

        <p className="legal-links account-legal">
          <Link to="/terms">Terms of Service</Link>
          <Link to="/privacy">Privacy Policy</Link>
        </p>
      </main>
    </div>
  );
}
