import { useCallback, useEffect, useState } from 'react';
import { getJSON } from '../services/api';

const POLL_MS = 6000;

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
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [wallet, market, refresh]);

  return { account, refresh };
}
