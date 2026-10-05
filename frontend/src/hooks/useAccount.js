import { useCallback, useEffect, useState } from 'react';
import { getJSON } from '../services/api';

const POLL_MS = 10_000;

/** Wallet balances, balances held in the market, and this app's orders for the wallet. */
export function useAccount(wallet, market) {
  const [account, setAccount] = useState(null);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    try {
      setAccount(await getJSON(`/api/account?wallet=${wallet}&market=${market || ''}`));
    } catch {
      // Keep the last good view.
    }
  }, [wallet, market]);

  useEffect(() => {
    setAccount(null);
    if (!wallet) return undefined;
    refresh();
    // Every refresh costs an RPC call: skip it while the tab is in the background.
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [wallet, market, refresh]);

  return { account, refresh };
}
