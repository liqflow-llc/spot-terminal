import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import Modal from './Modal.jsx';
import { useToast } from './Toasts.jsx';
import { postJSON } from '../services/api';
import { reportError } from '../services/report';
import { explorerTx, isUserRejection, signAndSubmit } from '../services/signing';
import { toInputString } from '../utils/format';

/** Change an open order's price and amount: one approval replaces the order and its payout. */
export default function EditOrderModal({ order, onClose, onDone }) {
  const { publicKey, signAllTransactions } = useWallet();
  const toast = useToast();
  const [price, setPrice] = useState(toInputString(order.price, 10));
  const [amount, setAmount] = useState(toInputString(order.size, order.baseDecimals));
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [riskMessage, setRiskMessage] = useState(null); // backend's far-from-market warning

  async function save(acknowledgePriceRisk = false) {
    setError(null);
    setBusy('Preparing…');
    try {
      const prepared = await postJSON('/api/orders/edit', { wallet: publicKey.toBase58(), orderId: order.id, price, size: amount, acknowledgePriceRisk });
      setBusy('Approve in your wallet…');
      const res = await signAndSubmit(prepared, signAllTransactions);
      toast({ kind: 'success', title: 'Order updated', message: `${amount} at ${price}. Any change in funds went back to your wallet.`, link: explorerTx(res.signature) });
      onDone?.();
      onClose();
    } catch (err) {
      if (err.code === 'PRICE_DEVIATION') setRiskMessage(err.message);
      else if (!isUserRejection(err)) {
        setError(err.message);
        reportError('edit_failed', err, { wallet: publicKey?.toBase58(), market: order.market });
      }
    } finally {
      setBusy(null);
    }
  }

  const valid = Number(price) > 0 && Number(amount) > 0;
  const clean = (v) => v.replace(/[^0-9.]/g, '');
  return (
    <Modal
      title={`Edit ${order.side === 'buy' ? 'buy' : 'sell'} order · ${order.symbol}`}
      danger={!!riskMessage}
      onClose={() => !busy && onClose()}
      actions={(
        <>
          <button type="button" className="btn" disabled={!!busy} onClick={onClose}>Cancel</button>
          {riskMessage
            ? <button type="button" className="btn danger" disabled={!!busy} onClick={() => save(true)}>{busy || 'Edit anyway'}</button>
            : <button type="button" className="btn primary" disabled={!!busy || !valid} onClick={() => save(false)}>{busy || 'Save'}</button>}
        </>
      )}
    >
      <div className="edit-order">
        <label className="of-field"><span className="of-field-label">Price</span><input inputMode="decimal" value={price} onChange={e => { setRiskMessage(null); setPrice(clean(e.target.value)); }} autoFocus /></label>
        <label className="of-field"><span className="of-field-label">Amount</span><input inputMode="decimal" value={amount} onChange={e => setAmount(clean(e.target.value))} /></label>
        <p className="muted small">Replaces the order in one transaction. Anything already filled, and any funds the new order doesn&apos;t need, go straight back to your wallet.</p>
        {riskMessage && <p className="danger-text small">{riskMessage}</p>}
        {error && <p className="danger-text small">{error}</p>}
      </div>
    </Modal>
  );
}
