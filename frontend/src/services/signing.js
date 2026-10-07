import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { postJSON } from './api';

/**
 * Sign every transaction the backend prepared in ONE wallet approval, then hand them back.
 * The backend checks they are byte-for-byte what it built before sending anything.
 */
export async function signAndSubmit(prepared, signAllTransactions) {
  // Market orders come from Jupiter as versioned transactions; everything else is legacy.
  // A limit order that fills partly through Jupiter mixes both kinds (versionFlags per tx).
  const isVersioned = (i) => (prepared.versionFlags ? prepared.versionFlags[i] : prepared.versioned);
  const txs = prepared.transactions.map((b64, i) => (isVersioned(i)
    ? VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))
    : Transaction.from(Buffer.from(b64, 'base64'))));
  let signed;
  try {
    signed = await signAllTransactions(txs);
  } catch (err) {
    // Rejected (or the wallet failed): let the server free what this request was holding, so the
    // next attempt doesn't wait for it to time out.
    postJSON('/api/tx/abandon', { id: prepared.id }).catch(() => {});
    throw err;
  }
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
