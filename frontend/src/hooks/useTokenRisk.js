import { useEffect, useState } from 'react';
import { getJSON } from '../services/api';

/**
 * Safety warnings for a market's tokens. Fetched only once `active` (the user has started
 * filling in the order form), so nobody sees warnings just for browsing.
 */
export function useTokenRisk(marketAddress, active) {
  const [risk, setRisk] = useState(null); // { address, base: [], quote: [] }
  useEffect(() => {
    if (!active || !marketAddress || risk?.address === marketAddress) return undefined;
    let live = true;
    getJSON(`/api/markets/${marketAddress}/risk`)
      .then(r => live && setRisk({ address: marketAddress, base: r.base || [], quote: r.quote || [] }))
      .catch(() => {});
    return () => { live = false; };
  }, [marketAddress, active, risk?.address]);
  if (!active || risk?.address !== marketAddress) return [];
  return [...risk.base, ...risk.quote];
}
