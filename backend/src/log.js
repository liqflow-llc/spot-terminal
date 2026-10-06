// Logging: one line per event, `[area] event key=value ...`, so the logs can be grepped and read
// at a glance (pm2 adds the timestamp). Warnings and errors go to the error log.
//
// The same failure repeating (every poll during an RPC outage, say) is printed once, then as a
// single "repeated N times" line per minute instead of flooding the file.
//
// Read them with: node backend/scripts/log-summary.mjs [hours]

const REPEAT_WINDOW_MS = 60_000;
const repeats = new Map(); // key -> { count, line, level, timer }
const counts = { warn: new Map(), error: new Map() }; // area -> count since the last health line

function format(area, event, fields) {
    const parts = [`[${area}] ${event}`];
    for (const [k, v] of Object.entries(fields || {})) {
        if (v === undefined || v === null || v === '') continue;
        let s;
        if (typeof v === 'string') s = v;
        else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
        else if (v && typeof v === 'object' && !Array.isArray(v)) s = Object.entries(v).map(([a, b]) => `${a}:${b && typeof b === 'object' ? JSON.stringify(b) : b}`).join(',') || 'none';
        else s = JSON.stringify(v);
        s = s.replace(/\s+/g, ' ').slice(0, 300);
        parts.push(`${k}=${/[\s"=]/.test(s) ? JSON.stringify(s) : s}`);
    }
    return parts.join(' ');
}

function write(level, line) {
    if (level === 'info') console.log(line);
    else console.error(level === 'warn' ? `WARN ${line}` : `ERROR ${line}`);
}

function emit(level, area, event, fields) {
    const line = format(area, event, fields);
    if (level !== 'info') counts[level].set(area, (counts[level].get(area) || 0) + 1);
    if (level === 'info') return write(level, line);
    // Collapse identical warnings/errors within a minute.
    const key = `${level}|${line}`;
    const seen = repeats.get(key);
    if (seen) {
        seen.count++;
        return;
    }
    write(level, line);
    const entry = { count: 0, line, level };
    entry.timer = setTimeout(() => {
        repeats.delete(key);
        if (entry.count) write(level, `${line} (repeated ${entry.count}x in the last minute)`);
    }, REPEAT_WINDOW_MS);
    entry.timer.unref?.();
    repeats.set(key, entry);
}

export const log = {
    info: (area, event, fields) => emit('info', area, event, fields),
    warn: (area, event, fields) => emit('warn', area, event, fields),
    error: (area, event, fields) => emit('error', area, event, fields),
};

/** Warning/error counts per area since the last call (for the periodic health line). */
export function takeProblemCounts() {
    const out = {};
    for (const level of ['warn', 'error']) {
        for (const [area, n] of counts[level]) out[`${level}.${area}`] = n;
        counts[level].clear();
    }
    return out;
}

/** "56Pk…4wzR" — enough to recognise a wallet in the logs. */
export const short = (address) => (address ? `${String(address).slice(0, 4)}…${String(address).slice(-4)}` : undefined);

/** An error's message plus the useful tail of a failed transaction's program logs. */
export function errorDetail(err) {
    const msg = err?.message || String(err);
    const logs = err?.logs || err?.transactionLogs;
    const tail = Array.isArray(logs) ? logs.filter(l => /error|failed|insufficient/i.test(l)).slice(-2).join(' | ') : '';
    return tail ? `${msg} :: ${tail}` : msg;
}
