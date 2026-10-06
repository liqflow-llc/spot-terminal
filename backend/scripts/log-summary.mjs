// A quick read of the app's logs: what happened, what went wrong, the latest health line.
//
//   node backend/scripts/log-summary.mjs        # last 24 hours
//   node backend/scripts/log-summary.mjs 6      # last 6 hours
//
// Reads pm2's files in logs/ (current + the rotated .1 copies).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const hours = Number(process.argv[2]) || 24;
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../logs');
const since = Date.now() - hours * 3600_000;

const files = fs.readdirSync(dir).filter(f => /^pm2-(out|error)-?\d*\.log(\.1)?$/.test(f));
const lines = [];
for (const f of files) {
    for (const raw of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        // pm2 prefixes "YYYY-MM-DDTHH:MM:SS: "
        const m = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}): (.*)$/);
        if (!m) continue;
        const t = Date.parse(m[1]); // pm2 writes local time, which is how JS parses this form
        if (t >= since) lines.push({ t, at: m[1], text: m[2] });
    }
}
lines.sort((a, b) => a.t - b.t);

const event = (text) => {
    const m = text.match(/^(?:(WARN|ERROR) )?\[([\w-]+)\] (\S+)/);
    return m ? { level: m[1] || 'INFO', area: m[2], name: m[3] } : null;
};

const tally = new Map();
const problems = [];
let health = null;
for (const l of lines) {
    const e = event(l.text);
    if (!e) {
        if (/error|fail/i.test(l.text)) problems.push(l); // something not using the logger
        continue;
    }
    const key = `${e.level.padEnd(5)} [${e.area}] ${e.name}`;
    tally.set(key, (tally.get(key) || 0) + 1);
    if (e.level !== 'INFO') problems.push(l);
    if (e.area === 'health') health = l;
}

console.log(`\n== Last ${hours}h: ${lines.length} log lines ==\n`);
const order = ['ERROR', 'WARN ', 'INFO '];
for (const [key, n] of [...tally].sort((a, b) => order.indexOf(a[0].slice(0, 5)) - order.indexOf(b[0].slice(0, 5)) || b[1] - a[1])) {
    console.log(`${String(n).padStart(6)}  ${key}`);
}
console.log('\n== Latest health ==');
console.log(health ? `${health.at}  ${health.text}` : '(none yet: written every 15 minutes)');
console.log('\n== Last 25 warnings/errors ==');
for (const l of problems.slice(-25)) console.log(`${l.at}  ${l.text.slice(0, 260)}`);
console.log('');
