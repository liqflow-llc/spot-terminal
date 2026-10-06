// Keeps pm2's log files for this app from growing without bound: when one passes MAX_BYTES it is
// copied to <name>.1 (replacing the previous .1) and emptied. pm2 keeps appending to the same
// file, so this works without restarting anything or touching pm2's global settings.
import fs from 'fs';
import path from 'path';
import { log } from './log.js';

const MAX_BYTES = 20 * 1024 * 1024;
const CHECK_MS = 60 * 60 * 1000;

export function startLogRotation(dir) {
    const check = () => {
        let files = [];
        try {
            files = fs.readdirSync(dir).filter(f => /^pm2-.*\.log$/.test(f));
        } catch {
            return; // no logs dir (running outside pm2)
        }
        for (const f of files) {
            const file = path.join(dir, f);
            try {
                if (fs.statSync(file).size < MAX_BYTES) continue;
                fs.copyFileSync(file, `${file}.1`);
                fs.truncateSync(file, 0);
                log.info('server', 'log_rotated', { file: f });
            } catch (err) {
                log.warn('server', 'log_rotate_failed', { file: f, msg: err.message });
            }
        }
    };
    check();
    setInterval(check, CHECK_MS).unref();
}
