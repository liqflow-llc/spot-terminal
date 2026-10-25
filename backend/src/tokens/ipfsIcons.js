// Token icons hosted on IPFS, served from our own origin.
//
// Many token icons link straight to a public IPFS gateway (ipfs.io, dweb.link, ...), which now
// refuse hotlinked requests (429/403), so those icons showed up blank. IPFS content never changes
// (the address is the hash), so we fetch each one once from whichever gateway answers, keep it on
// disk, and serve it with a long immutable cache (Cloudflare caches it too). The gateways are a
// fixed list: the only input is a validated CID, so this can't be used to fetch arbitrary URLs.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';
import { log } from '../log.js';

const GATEWAYS = [
    'https://ipfs.filebase.io/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://ipfs.io/ipfs/',
    'https://dweb.link/ipfs/',
];
const DIR = path.join(config.dataDir, 'icon-cache');
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 8000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
// CIDv0 (Qm...) or CIDv1 base32 (b...), optionally a path inside it (ipfs/<cid>/logo.png).
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/;
const SUBPATH_RE = /^(?!.*\.\.)[\w.\-/]{1,120}$/; // no '..' segments

/** "<cid>" or "<cid>/<path>" for an icon URL served by a public IPFS gateway, else null. */
export function ipfsRef(url) {
    if (typeof url !== 'string') return null;
    // Helius's image CDN wraps IPFS links and serves them fine: leave those alone.
    if (url.startsWith('https://cdn.helius-rpc.com/')) return null;
    const m = url.match(/^ipfs:\/\/(?:ipfs\/)?([^/?#]+)(\/[^?#]*)?/) || url.match(/^https?:\/\/[^/]+\/ipfs\/([^/?#]+)(\/[^?#]*)?/)
        || url.match(/^https?:\/\/([a-z2-7]{50,120})\.ipfs\.[^/]+(\/[^?#]*)?/);
    if (!m || !CID_RE.test(m[1])) return null;
    const sub = (m[2] || '').replace(/^\/+/, '');
    if (sub && !SUBPATH_RE.test(sub)) return null;
    return sub ? `${m[1]}/${sub}` : m[1];
}

/** The icon URL to give browsers: ours for public-gateway IPFS links, otherwise unchanged. */
export function iconUrl(url) {
    const ref = ipfsRef(url);
    return ref ? `/api/ipfs/${ref}` : url;
}

const failures = new Map(); // ref -> time of the last failure
const inflight = new Map(); // ref -> Promise<{ type, file } | null>

function cachePaths(ref) {
    const key = crypto.createHash('sha256').update(ref).digest('hex').slice(0, 40);
    return { file: path.join(DIR, key), meta: path.join(DIR, `${key}.json`) };
}

async function fetchFromGateways(ref) {
    for (const gw of GATEWAYS) {
        try {
            const res = await fetch(gw + ref, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'image/*' } });
            const type = (res.headers.get('content-type') || '').split(';')[0].trim();
            if (!res.ok || !type.startsWith('image/')) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > MAX_BYTES) return null; // too big to be an icon
            return { type, buf };
        } catch { /* next gateway */ }
    }
    return null;
}

/** { type, file } for a cached-or-fetched icon, or null if no gateway has it. */
export async function getIpfsIcon(ref) {
    const [cid, ...rest] = ref.split('/');
    const sub = rest.join('/');
    if (!CID_RE.test(cid) || (sub && !SUBPATH_RE.test(sub))) return null;
    const { file, meta } = cachePaths(ref);
    try {
        return { type: JSON.parse(fs.readFileSync(meta, 'utf8')).type, file };
    } catch { /* not cached yet */ }
    if (Date.now() - (failures.get(ref) || 0) < FAILURE_TTL_MS) return null;
    if (!inflight.has(ref)) {
        inflight.set(ref, (async () => {
            const got = await fetchFromGateways(ref);
            if (!got) {
                failures.set(ref, Date.now());
                log.warn('icons', 'ipfs_unavailable', { ref: ref.slice(0, 24) });
                return null;
            }
            fs.mkdirSync(DIR, { recursive: true });
            fs.writeFileSync(file, got.buf);
            fs.writeFileSync(meta, JSON.stringify({ type: got.type, ref }));
            return { type: got.type, file };
        })().finally(() => inflight.delete(ref)));
    }
    return inflight.get(ref);
}
