import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import Modal from './Modal.jsx';
import { useToast } from './Toasts.jsx';
import { getJSON, postJSON } from '../services/api';
import { explorerTx, isUserRejection, signAndSubmit } from '../services/signing';
import { formatAmount, formatPrice, priceDecimals, toInputString } from '../utils/format';
import '../legal/Legal.css';
import './OrderForm.css';

const SOL = 'So11111111111111111111111111111111111111112';
const SOL_RESERVE = 0.02; // keep some SOL for fees and token-account rent
const PERCENTS = [25, 50, 75, 100];
// Matches PRICE_WARN_DEVIATION on the backend, which refuses such orders without consent.
const WARN_DEVIATION = 0.05;
const SLOW_FILL_DEVIATION = 0.2;
const REFERENCE_REFRESH_MS = 30_000;

/** How much worse than the market an order is on the side that loses money (negative = safe side). */
function adverseDeviation(side, price, reference) {
  if (!(reference > 0) || !(price > 0)) return null;
  return side === 'buy' ? price / reference - 1 : 1 - price / reference;
}

export default function OrderForm({ market, book, account, pickedPrice, onPlaced }) {
  const { publicKey, signAllTransactions } = useWallet();
  const { setVisible } = useWalletModal();
  const toast = useToast();
  const [side, setSide] = useState('buy');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [postOnly, setPostOnly] = useState(false);
  const [busy, setBusy] = useState(null);
  const [setupPrompt, setSetupPrompt] = useState(null);
  const [riskPrompt, setRiskPrompt] = useState(null);
  const [reference, setReference] = useState(null); // { price, address }
  const seededFor = useRef(null);
  const priceTouched = useRef(false);

  const base = market?.base, quote = market?.quote;
  const pDecimals = priceDecimals(market?.last ?? book?.bestBid);

  useEffect(() => {
    priceTouched.current = false;
    setAmount('');
    setPrice(''); // re-seeded below from the new market's book, if it has one
  }, [market?.address]);

  // Default to the best price on your own side of the book (a resting order), once per market
  // and side, until the user sets a price themselves.
  useEffect(() => {
    if (!market || priceTouched.current) return;
    const key = `${market.address}|${side}`;
    if (seededFor.current === key) return;
    const ref = (side === 'buy' ? book?.bestBid : book?.bestAsk) ?? market.last;
    if (!ref) return;
    seededFor.current = key;
    setPrice(toInputString(ref, pDecimals + 2));
  }, [market, book, side, pDecimals]);

  const editPrice = (v) => {
    priceTouched.current = true;
    setPrice(v);
  };

  useEffect(() => {
    if (!pickedPrice) return;
    priceTouched.current = true;
    setPrice(toInputString(pickedPrice.price, pDecimals + 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedPrice]);

  // Market price from Jupiter (aggregated across all Solana venues): Manifest books alone are
  // often too thin to say what the market price is.
  useEffect(() => {
    if (!market?.address) return undefined;
    let live = true;
    const load = () => getJSON(`/api/markets/${market.address}/reference`)
      .then(r => live && setReference({ price: r.price, address: market.address }))
      .catch(() => {});
    setReference(null);
    load();
    const t = setInterval(load, REFERENCE_REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, [market?.address]);

  const p = Number(price), a = Number(amount);
  const refPrice = reference && reference.address === market?.address ? reference.price : undefined;
  const off = adverseDeviation(side, p, refPrice);
  const risky = off != null && off > WARN_DEVIATION;
  const overpay = risky && a > 0 ? Math.abs(p - refPrice) * a : null;
  const total = p > 0 && a > 0 ? p * a : 0;

  const available = useMemo(() => {
    if (!account?.wallet || !market) return null;
    const isBuy = side === 'buy';
    const mint = isBuy ? quote.mint : base.mint;
    let bal = isBuy ? account.wallet.quote : account.wallet.base;
    if (mint === SOL) bal = Math.max(0, bal - SOL_RESERVE);
    // Funds already sitting in the market from earlier fills count too.
    bal += (isBuy ? account.inMarket?.quote : account.inMarket?.base) || 0;
    return bal;
  }, [account, market, side, base, quote]);

  const setPercent = (pct) => {
    if (!available) return;
    if (side === 'buy') {
      if (!(p > 0)) return;
      setAmount(toInputString(((available * pct) / 100) / p, base.decimals));
    } else {
      setAmount(toInputString((available * pct) / 100, base.decimals));
    }
  };

  const setTotal = (value) => {
    const t = Number(value);
    if (p > 0 && t >= 0) setAmount(t ? toInputString(t / p, base.decimals) : '');
  };

  // Warn when a limit order would execute immediately against the book.
  const crosses = p > 0 && book && (side === 'buy' ? book.bestAsk && p >= book.bestAsk : book.bestBid && p <= book.bestBid);
  const insufficient = available != null && (side === 'buy' ? total > available + 1e-12 : a > available + 1e-12);

  async function prepare(acknowledgePriceRisk) {
    return postJSON('/api/orders/prepare', {
      wallet: publicKey.toBase58(), market: market.address, side, price, size: amount, postOnly, acknowledgePriceRisk,
    });
  }

  const confirmRisk = (detail) => new Promise(resolve => setRiskPrompt({ resolve, detail }))
    .finally(() => setRiskPrompt(null));

  /** Prepare, asking for explicit consent if the price is far through the market. */
  async function prepareChecked() {
    let ack = false;
    if (risky) {
      if (!await confirmRisk(null)) return null;
      ack = true;
      setBusy('Preparing…');
    }
    try {
      return await prepare(ack);
    } catch (err) {
      // The backend's own market price disagreed with ours (it moved): ask with its numbers.
      if (err.code !== 'PRICE_DEVIATION') throw err;
      setBusy(null);
      if (!await confirmRisk(err.message)) return null;
      setBusy('Preparing…');
      return prepare(true);
    }
  }

  async function submit() {
    if (!publicKey) return setVisible(true);
    if (!(p > 0) || !(a > 0)) return toast({ kind: 'error', title: 'Enter a price and amount' });
    setBusy(risky ? null : 'Preparing…');
    try {
      let prepared = await prepareChecked();
      if (!prepared) return;
      if (prepared.step === 'setup') {
        setBusy(null);
        const ok = await new Promise(resolve => setSetupPrompt({ resolve, summary: prepared.summary }));
        setSetupPrompt(null);
        if (!ok) return;
        setBusy('Approve setup in your wallet…');
        const setup = await signAndSubmit(prepared, signAllTransactions);
        toast({ kind: 'success', title: 'Instant payouts enabled', link: explorerTx(setup.signature) });
        setBusy('Preparing…');
        prepared = await prepare(true); // any price warning was already confirmed above
      }
      setBusy('Approve in your wallet…');
      const res = await signAndSubmit(prepared, signAllTransactions);
      toast({
        kind: 'success',
        title: `${side === 'buy' ? 'Buy' : 'Sell'} order placed`,
        message: `${formatAmount(a)} ${base.symbol} at ${price} ${quote.symbol}. Proceeds go to your wallet automatically when it fills.`,
        link: explorerTx(res.signature),
      });
      setAmount('');
      onPlaced?.();
    } catch (err) {
      if (isUserRejection(err)) toast({ title: 'Cancelled in wallet' });
      else toast({ kind: 'error', title: 'Order not placed', message: err.message });
    } finally {
      setBusy(null);
    }
  }

  if (!market) return <div className="of-loading"><span className="spinner" /></div>;

  return (
    <div className="order-form">
      <div className="of-sides">
        <button type="button" className={`of-side buy ${side === 'buy' ? 'active' : ''}`} onClick={() => setSide('buy')}>Buy</button>
        <button type="button" className={`of-side sell ${side === 'sell' ? 'active' : ''}`} onClick={() => setSide('sell')}>Sell</button>
      </div>

      <div className="of-type">
        <span className="of-type-active">Limit</span>
        <label className="of-check" title="Only rest on the book; never execute immediately">
          <input type="checkbox" checked={postOnly} onChange={e => setPostOnly(e.target.checked)} /> Post-only
        </label>
      </div>

      <div className="of-avail">
        <span className="muted">Available</span>
        <span className="num">{available == null ? '—' : `${formatAmount(available)} ${side === 'buy' ? quote.symbol : base.symbol}`}</span>
      </div>

      <Field label="Price" unit={quote.symbol} value={price} onChange={editPrice} />
      <Field label="Amount" unit={base.symbol} value={amount} onChange={setAmount} />
      <div className="of-percents">
        {PERCENTS.map(pct => (
          <button key={pct} type="button" className="of-pct" onClick={() => setPercent(pct)} disabled={!available}>{pct}%</button>
        ))}
      </div>
      <Field label="Total" unit={quote.symbol} value={total ? toInputString(total, quote.decimals) : ''} onChange={setTotal} />

      {risky && (
        <div className="of-note danger" role="alert">
          <strong>⚠ {(off * 100).toFixed(1)}% {side === 'buy' ? 'above' : 'below'} the market price</strong> ({formatPrice(refPrice)} {quote.symbol}).
          {' '}This order will likely fill right away at your price
          {overpay ? <>, costing about <strong>{formatAmount(overpay)} {quote.symbol}</strong> more than the market</> : null}.
        </div>
      )}
      {!risky && off != null && off < -SLOW_FILL_DEVIATION && (
        <div className="of-note">{(-off * 100).toFixed(0)}% {side === 'buy' ? 'below' : 'above'} the market price, so it may take a long time to fill.</div>
      )}
      {refPrice === null && p > 0 && (
        <div className="of-note">No reliable market price for this token. Double-check your price before placing.</div>
      )}
      {crosses && !postOnly && (
        <div className="of-note warn">This price crosses the book, so part or all of it will fill immediately.</div>
      )}
      {crosses && postOnly && (
        <div className="of-note warn">Post-only: this price crosses the book and would be rejected.</div>
      )}

      <button
        type="button"
        className={`of-submit ${side}`}
        onClick={submit}
        disabled={!!busy || (publicKey && (insufficient || !(p > 0) || !(a > 0)))}
      >
        {busy || (!publicKey ? 'Connect wallet' : insufficient ? 'Insufficient balance' : `${side === 'buy' ? 'Buy' : 'Sell'} ${base.symbol}`)}
      </button>

      <dl className="of-summary">
        <div><dt>{side === 'buy' ? 'You pay' : 'You sell'}</dt><dd className="num">{side === 'buy' ? `${formatAmount(total)} ${quote.symbol}` : `${formatAmount(a || 0)} ${base.symbol}`}</dd></div>
        <div><dt>You receive when filled</dt><dd className="num">{side === 'buy' ? `${formatAmount(a || 0)} ${base.symbol}` : `${formatAmount(total)} ${quote.symbol}`}</dd></div>
        <div><dt>Market price</dt><dd className="num" title="Jupiter's price across all Solana venues">{refPrice ? `${formatPrice(refPrice)} ${quote.symbol}` : '—'}</dd></div>
        <div><dt>Trading fee</dt><dd>0% <span className="muted">(Manifest)</span></dd></div>
        <div><dt>Payout</dt><dd>Automatic, straight to your wallet</dd></div>
      </dl>
      <p className="legal-links">
        <span>By trading you agree to the</span>
        <Link to="/terms">Terms</Link>
        <Link to="/privacy">Privacy</Link>
      </p>

      {riskPrompt && (
        <Modal
          title="Price far from market"
          danger
          onClose={() => riskPrompt.resolve(false)}
          actions={(
            <>
              <button type="button" className="btn primary" onClick={() => riskPrompt.resolve(false)}>Change price</button>
              <button type="button" className="btn danger" onClick={() => riskPrompt.resolve(true)}>Place anyway</button>
            </>
          )}
        >
          {riskPrompt.detail ? <p>{riskPrompt.detail}</p> : (
            <p>
              You are {side === 'buy' ? 'buying' : 'selling'} at <strong>{price} {quote.symbol}</strong>,{' '}
              <strong className="danger-text">{(off * 100).toFixed(1)}% {side === 'buy' ? 'above' : 'below'}</strong> the
              market price of {formatPrice(refPrice)} {quote.symbol}.
            </p>
          )}
          <p>
            {side === 'buy' ? 'Sellers' : 'Buyers'} will happily fill this at your price, so it will likely execute right away
            {overpay ? <> and cost you about <strong>{formatAmount(overpay)} {quote.symbol}</strong> compared with the market</> : null}.
            This can&rsquo;t be undone once filled.
          </p>
        </Modal>
      )}
      {setupPrompt && (
        <Modal
          title="One-time refundable deposit"
          onClose={() => setupPrompt.resolve(false)}
          actions={(
            <>
              <button type="button" className="btn" onClick={() => setupPrompt.resolve(false)}>Not now</button>
              <button type="button" className="btn primary" onClick={() => setupPrompt.resolve(true)}>Continue</button>
            </>
          )}
        >
          <p>
            Your first order needs a one-time deposit of{' '}
            <strong>{setupPrompt.summary?.depositSol ? `${setupPrompt.summary.depositSol.toFixed(4)} SOL` : 'a little SOL'}</strong>{' '}
            to set up your account. Get it back anytime on the <Link to="/account" target="_blank">Account page</Link>.
          </p>
        </Modal>
      )}
    </div>
  );
}

function Field({ label, unit, value, onChange }) {
  return (
    <label className="of-field">
      <span className="of-field-label">{label}</span>
      <input
        className="num"
        inputMode="decimal"
        value={value}
        onChange={e => {
          const v = e.target.value.replace(',', '.');
          if (/^\d*\.?\d*$/.test(v)) onChange(v);
        }}
        placeholder="0"
      />
      <span className="of-field-unit">{unit}</span>
    </label>
  );
}
