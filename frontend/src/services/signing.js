import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { postJSON } from './api';

/**
 * Sign every transaction the backend prepared in ONE wallet approval, then hand them back.
 * The backend checks they are byte-for-byte what it built before sending anything.
 */
export async function signAndSubmit(prepared, signAllTransactions) {
  // Market orders come from Jupiter as versioned transactions; everything else is legacy.
  const txs = prepared.transactions.map(b64 => (prepared.versioned
    ? VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))
    : Transaction.from(Buffer.from(b64, 'base64'))));
  const signed = await signAllTransactions(txs);
  return postJSON('/api/tx/submit', {
    id: prepared.id,
    signed: signed.map(t => Buffer.from(t instanceof VersionedTransaction ? t.serialize() : t.serialize({ requireAllSignatures: false })).toString('base64')),
  });
}

export const explorerTx = (sig) => `https://solscan.io/tx/${sig}`;

/** Wallet rejections shouldn't read like errors. */
export function isUserRejection(err) {
  return /reject|denied|cancel/i.test(err?.message || '');
}
