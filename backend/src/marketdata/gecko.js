// One shared, rate-limited client for GeckoTerminal's free API, so the
// stats poller and chart backfills can't push each other over the limit. Chart requests (a
// visitor is waiting) go ahead of background stats refreshes, and background requests wait until
// charts have been quiet for a minute, so they don't spend the budget a visitor is about to need
// (or set off a minute-long 429 pause just before a chart loads).
// The documented free limit is 30/minute, but from this server it's about 5/minute (measured
// October 24, 2026: one call every 7s got a 429 about every other time, and a 429 clears within
// 7-15s). So: one call per 12s, and after a 429 a short pause and retry (a minute-long pause
// left charts loading for over a minute).
const MIN_GAP_MS = 12_000;
const COOLDOWN_MS = 20_000;
const LOW_AFTER_HIGH_MS = 60_000;
const MAX_RETRIES = 3;
const queues = { high: [], low: [] };
let last = 0;
let lastHigh = 0;
let pumping = false;
let lowTimer = null;

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        for (;;) {
            const lowWait = lastHigh + LOW_AFTER_HIGH_MS - Date.now();
            const job = queues.high.shift() || (lowWait <= 0 ? queues.low.shift() : null);
            if (!job) {
                if (queues.low.length && !lowTimer) lowTimer = setTimeout(() => { lowTimer = null; pump(); }, lowWait).unref();
                break;
            }
            const wait = last + MIN_GAP_MS - Date.now();
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            last = Date.now();
            try {
                const res = await fetch(job.url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
                if (res.status === 429 && (job.retries || 0) < MAX_RETRIES) {
                    // Throttled: pause everything, then retry this request first.
                    job.retries = (job.retries || 0) + 1;
                    last = Date.now() + COOLDOWN_MS - MIN_GAP_MS;
                    queues[job.queue].unshift(job);
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
        const queue = priority === 'low' ? 'low' : 'high';
        if (queue === 'high') lastHigh = Date.now();
        queues[queue].push({ url, queue, resolve, reject });
        pump();
    });
}
