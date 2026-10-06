// Warnings about a token's on-chain settings, shown in the order form once someone starts filling
// it in. Only for tokens NOT on Jupiter's verified list: verified tokens are well known (USDC, for
// one, legitimately has a freeze authority), and warning on them would just be noise.
import { PublicKey } from '@solana/web3.js';
import { connection } from '../solana.js';

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // mint -> { at, warnings }

/** @returns {Promise<{ level: 'danger'|'caution', text: string }[]>} */
export async function tokenWarnings(registry, mint, symbol) {
    if (registry.get(mint)?.verified) return [];
    const hit = cache.get(mint);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.warnings;

    const warnings = [{ level: 'caution', text: `${symbol} isn't on Jupiter's verified list. Make sure this is the token you mean by checking its address.` }];
    const info = (await connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed')).value?.data?.parsed?.info;
    if (info) {
        if (info.freezeAuthority) warnings.push({ level: 'danger', text: `Its creator can freeze ${symbol} in any wallet, so you might not be able to sell it.` });
        if (info.mintAuthority) warnings.push({ level: 'caution', text: `Its creator can still mint more ${symbol}, which can dilute its value.` });
        for (const ext of info.extensions || []) {
            const s = ext.state || {};
            switch (ext.extension) {
                case 'transferFeeConfig': {
                    const bps = Math.max(Number(s.newerTransferFee?.transferFeeBasisPoints) || 0, Number(s.olderTransferFee?.transferFeeBasisPoints) || 0);
                    if (bps > 0) warnings.push({ level: 'danger', text: `Every ${symbol} transfer pays a ${(bps / 100).toFixed(2)}% fee to its creator, including this trade.` });
                    break;
                }
                case 'transferHook':
                    if (s.programId) warnings.push({ level: 'danger', text: `${symbol} transfers run a program chosen by its creator, which could block selling.` });
                    break;
                case 'permanentDelegate':
                    if (s.delegate) warnings.push({ level: 'danger', text: `Its creator can move or burn ${symbol} in any wallet, including yours.` });
                    break;
                case 'nonTransferable':
                    warnings.push({ level: 'danger', text: `${symbol} can't be transferred, so it can't be traded normally.` });
                    break;
                case 'defaultAccountState':
                    if (s.accountState === 'frozen') warnings.push({ level: 'danger', text: `New ${symbol} accounts start frozen until its creator unfreezes them.` });
                    break;
                case 'pausableConfig':
                    if (s.authority) warnings.push({ level: 'danger', text: `Its creator can pause all ${symbol} transfers.` });
                    break;
                default:
            }
        }
    }
    cache.set(mint, { at: Date.now(), warnings });
    return warnings;
}
