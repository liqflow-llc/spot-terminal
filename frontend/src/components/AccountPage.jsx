import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import TopBar from './TopBar.jsx';
import Modal from './Modal.jsx';
import { useToast } from './Toasts.jsx';
import { getJSON, postJSON } from '../services/api';
import { explorerTx, isUserRejection, signAndSubmit } from '../services/signing';
import { CONTACT_EMAIL } from '../legal/legalMeta.js';
import '../legal/Legal.css';
import './AccountPage.css';
import { reportError } from '../services/report';
import { formatAmount } from '../utils/format';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { useTheme } from '../theme';
import { setPageTitle } from '../pageTitle';
import { BRAND } from '../brand';

const sol = (n) => `${Number(n || 0).toFixed(5)} SOL`;
const explorerAccount = (address) => `https://solscan.io/account/${address}`;
const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

// One CSV per tax app, each in the format that app documents for custom imports.
const TAX_APPS = [
  { id: 'koinly', name: 'Koinly', howto: 'Add a new wallet named SpotTerminal (pick the custom / other option if asked), then use Import from file and upload the Koinly CSV. Koinly matches its deposits and withdrawals with your imported Solana wallet by transaction ID, and the token columns include each mint address so the right token is picked.' },
  { id: 'cointracker', name: 'CoinTracker', howto: 'Go to Wallets → Add wallets, search for CSV, and upload the CoinTracker CSV as a wallet named SpotTerminal. CoinTracker pairs its sends and receives with your Solana wallet as transfers.' },
  { id: 'coinledger', name: 'CoinLedger', howto: 'Upload the CoinLedger CSV under Import → Other Account (the universal manual import), then use Edit Name to call it SpotTerminal. Deposits and withdrawals are self-transfers there.' },
  { id: 'awaken', name: 'Awaken', howto: 'Add a new account using CSV upload and upload the Awaken CSV. With your Solana wallet also imported, Awaken matches the transfers between the two accounts. Amounts are limited to 8 decimal places, so dust below that is left out.' },
  { id: 'cointracking', name: 'CoinTracking', howto: 'Use the bulk import (Enter Coins → Import). The file follows the bulk-import column order with Trade, Deposit and Withdrawal types and SpotTerminal as the exchange. If it only accepts its Excel template, paste these rows into the template.' },
];

export default function AccountPage() {
  const { publicKey, signAllTransactions } = useWallet();
  const wallet = publicKey?.toBase58() || null;
  const toast = useToast();
  const [payout, setPayout] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => { setPageTitle(`Account · ${BRAND}`); }, []);

  const load = useCallback(() => {
    if (!wallet) return setPayout(null);
    setError(null);
    getJSON(`/api/payout-accounts?wallet=${wallet}`).then(setPayout).catch(err => setError(err.message));
  }, [wallet]);
  useEffect(load, [load]);

  // Fill proceeds and leftovers waiting in Manifest markets (in the wallet's seat there).
  const [funds, setFunds] = useState(null);
  const loadFunds = useCallback(() => {
    if (!wallet) return setFunds(null);
    getJSON(`/api/account/funds?wallet=${wallet}`).then(r => setFunds(r.markets)).catch(() => setFunds([]));
  }, [wallet]);
  useEffect(loadFunds, [loadFunds]);

  // Payout accounts the chain shows this wallet set up through another SpotTerminal server.
  const [chainPayout, setChainPayout] = useState([]);
  useEffect(() => {
    if (!wallet) return setChainPayout([]);
    let live = true;
    getJSON(`/api/history?wallet=${wallet}`).then(r => live && setChainPayout((r.payoutAccounts || []).filter(a => !a.knownHere))).catch(() => {});
    return () => { live = false; };
  }, [wallet, payout]);

  async function moveFunds(m) {
    setBusy(`funds:${m.market}`);
    try {
      const prepared = m.collectOrderId
        ? await postJSON('/api/orders/cancel', { wallet, orderId: m.collectOrderId })
        : await postJSON('/api/orders/withdraw', { wallet, market: m.market });
      const res = await signAndSubmit(prepared, signAllTransactions);
      toast({ kind: 'success', title: m.collectOrderId ? 'Collected to wallet' : 'Withdrawn to wallet', link: explorerTx(res.signature) });
    } catch (err) {
      if (!isUserRejection(err)) {
        toast({ kind: 'error', title: 'Not withdrawn', message: err.message });
        reportError('account_withdraw_failed', err, { wallet, market: m.market });
      }
    } finally {
      setBusy(null);
      loadFunds();
      load();
    }
  }

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
  const [tax, setTax] = useState(null); // { entries, years }
  const [taxYear, setTaxYear] = useState('');
  useEffect(() => {
    if (!wallet) return setTax(null);
    getJSON(`/api/tax/summary?wallet=${wallet}`).then(setTax).catch(() => setTax(null));
  }, [wallet, payout]);

  return (
    <div className="app account-page">
      <TopBar />
      <main className="account-main">
        <h1>Account</h1>

        <section className="account-card">
          <h2>Your funds on SpotTerminal</h2>
          <p className="muted">
            When an order fills, Manifest credits what you bought (or the proceeds of a sale) to your balance
            inside that market, and the payout moves it to your wallet. Anything still waiting is listed here;
            only your wallet can withdraw it.
          </p>
          {!wallet ? (
            <div className="account-connect">
              <span>Connect your wallet to see your funds.</span>
              <WalletMultiButton />
            </div>
          ) : !funds ? (
            <div className="account-row"><span className="spinner" /> Loading…</div>
          ) : funds.length === 0 ? (
            <div className="account-row">Nothing waiting in any market.</div>
          ) : (
            <table className="funds-table">
              <thead><tr><th>Market</th><th className="r">Waiting</th><th /></tr></thead>
              <tbody>
                {funds.map(m => {
                  const canWithdraw = m.base.free > 0 || m.quote.free > 0;
                  return (
                    <tr key={m.market}>
                      <td><Link to={`/trade/${m.market}`}>{m.symbol}</Link></td>
                      <td className="r num">
                        {[m.base, m.quote].filter(t => t.amount > 0).map(t => (
                          <div key={t.symbol}>{formatAmount(t.amount)} {t.symbol}</div>
                        ))}
                        {m.remainder > 0 && <div className="muted small">{formatAmount(m.remainder)} {m.base.symbol} still on the book</div>}
                      </td>
                      <td className="r">
                        {m.collectOrderId || canWithdraw ? (
                          <button type="button" className="btn small primary" disabled={!!busy} onClick={() => moveFunds(m)}>
                            {busy === `funds:${m.market}` ? '…' : m.collectOrderId ? 'Collect' : 'Withdraw'}
                          </button>
                        ) : (
                          <span className="muted small" title="Held for your open order's automatic payout">Paid out when the order fills</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {funds?.some(m => m.collectOrderId) && (
            <p className="muted small">
              Collect cancels what&apos;s left of a filled order (a remainder worth under $5, already paid out, or a
              sliver too small for its automatic payout) and moves everything in that market to your wallet.
            </p>
          )}

          {wallet && (payout?.accounts.length > 0 || chainPayout.length > 0) && (
            <>
              <h3>Payout accounts</h3>
              <p className="muted small">
                Two small accounts your wallet controls, set up with your first order. They hold no tokens: each
                one lets a filled order&apos;s pre-signed payout run without you. Their SOL is refundable rent
                (below).
              </p>
              <ul className="payout-list">
                {chainPayout.map(a => (
                  <li key={a.address}>
                    <a href={explorerAccount(a.address)} target="_blank" rel="noreferrer" className="num">{shortAddr(a.address)}</a>
                    <span className="num">{sol(a.lamports / 1e9)}</span>
                    <span className="muted" title="Found on the blockchain: set up through another SpotTerminal server, which may be using it for an order's payout.">found on-chain</span>
                  </li>
                ))}
                {(payout?.accounts || []).map(a => (
                  <li key={a.address}>
                    <a href={explorerAccount(a.address)} target="_blank" rel="noreferrer" className="num">{shortAddr(a.address)}</a>
                    <span className="num">{sol(a.lamports / 1e9)}</span>
                    <span className="muted">{a.inUse ? 'backing an open order' : 'free'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

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
          <h2>Tax reports</h2>
          <p className="muted">
            Your SpotTerminal activity as a CSV file for your tax app. Import your Solana wallet in the app as usual,
            then add this file as a separate account named SpotTerminal. Money moving into and out of SpotTerminal keeps
            your wallet&apos;s transaction IDs, so the app pairs it as transfers between your own accounts, and each
            limit order fill is a trade at your order&apos;s price.
          </p>
          {!wallet ? (
            <div className="account-row">Connect your wallet to download your reports.</div>
          ) : !tax ? (
            <div className="account-row"><span className="spinner" /> Loading…</div>
          ) : tax.entries === 0 ? (
            <div className="account-row">No SpotTerminal activity yet.</div>
          ) : (
            <>
              <label className="account-row tax-year">
                Period
                <select value={taxYear} onChange={e => setTaxYear(e.target.value)}>
                  <option value="">All time</option>
                  {tax.years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </label>
              <div className="tax-apps">
                {TAX_APPS.map(a => (
                  <a
                    key={a.id}
                    className="btn"
                    href={`/api/tax/export?wallet=${wallet}&app=${a.id}${taxYear ? `&year=${taxYear}` : ''}`}
                    download
                  >
                    {a.name} CSV
                  </a>
                ))}
              </div>
              <div className="tax-howto">
                {TAX_APPS.map(a => (
                  <details key={a.id}>
                    <summary>How to import into {a.name}</summary>
                    <p>{a.howto}</p>
                  </details>
                ))}
              </div>
              <p className="muted small">
                Market orders and instant fills through Jupiter, and network fees, are ordinary transactions in your
                wallet, so they come in with your wallet import, not this file. Import each period once: re-importing
                the same rows can create duplicates in some apps.
              </p>
            </>
          )}
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
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      </main>
    </div>
  );
}
