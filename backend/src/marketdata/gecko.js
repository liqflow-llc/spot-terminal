// One shared, rate-limited client for GeckoTerminal's free API, so the
// stats poller and chart backfills can't push each other over the limit. Chart requests (a
// visitor is waiting) go ahead of background stats refreshes.
// The documented free limit is 30/minute, but in practice it throttles well below that.
const MIN_GAP_MS = 6500;
const COOLDOWN_MS = 60_000;
const MAX_RETRIES = 2;
const queues = { high: [], low: [] };
let last = 0;
let pumping = false;

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        for (;;) {
            const job = queues.high.shift() || queues.low.shift();
            if (!job) break;
            const wait = last + MIN_GAP_MS - Date.now();
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            last = Date.now();
            try {
                const res = await fetch(job.url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
                if (res.status === 429 && (job.retries || 0) < MAX_RETRIES) {
                    // Throttled: pause everything, then retry this request first.
                    job.retries = (job.retries || 0) + 1;
                    last = Date.now() + COOLDOWN_MS - MIN_GAP_MS;
                    queues.high.unshift(job);
                    continue;
                }
                if (res.status === 404) job.resolve(null);
                else if (!res.ok) job.reject(new Error(`GeckoTerminal HTTP ${res.status}`));
                else job.resolve(await res.json());
            } catch (err) {
                job.reject(err);
            }
        }
    } finally {
        pumping = false;
    }
}

export function geckoFetch(url, { priority = 'high' } = {}) {
    return new Promise((resolve, reject) => {
        queues[priority === 'low' ? 'low' : 'high'].push({ url, resolve, reject });
        pump();
    });
}
