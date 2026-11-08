#!/usr/bin/env node
// `npm start` in the repo root: installs what's missing, then runs the API and the app together
// in this one terminal. Ctrl+C stops both. No dependencies of its own (plain Node 20+).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_URL = 'http://localhost:5180';
const color = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
    console.error(`SpotTerminal needs Node.js 20 or newer (this is ${process.version}). Get it from https://nodejs.org`);
    process.exit(1);
}

// npm install where node_modules is missing or older than the lockfile (after a git pull).
for (const dir of ['backend', 'frontend']) {
    const cwd = path.join(root, dir);
    const stamp = path.join(cwd, 'node_modules', '.package-lock.json');
    const lock = path.join(cwd, 'package-lock.json');
    const stale = !fs.existsSync(stamp) || fs.statSync(lock).mtimeMs > fs.statSync(stamp).mtimeMs;
    if (!stale) continue;
    console.log(color(36, `Installing ${dir} packages (first run only, a minute or two)…`));
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) {
        console.error(`npm install failed in ${dir}/`);
        process.exit(r.status || 1);
    }
}

// Both run straight on this Node (no npm or shell in between), so stopping them is reliable.
const children = [];
let stopping = false;
function run(name, code, dir, args) {
    const child = spawn(process.execPath, args, { cwd: path.join(root, dir), env: { ...process.env, FORCE_COLOR: '1' } });
    const tag = color(code, `[${name}]`.padEnd(6));
    for (const stream of [child.stdout, child.stderr]) {
        let rest = '';
        stream.on('data', (chunk) => {
            const lines = (rest + chunk).split('\n');
            rest = lines.pop();
            for (const line of lines) {
                // Vite prints its own URL; the API's line is the one that means "ready".
                if (name === 'api' && line.includes('listening')) {
                    console.log(color(32, `\n  SpotTerminal is running: open ${APP_URL}\n`));
                }
                console.log(`${tag} ${line}`);
            }
        });
    }
    child.on('exit', (status) => {
        if (stopping) return;
        console.error(`${tag} stopped (exit ${status}); stopping the other one too.`);
        stop(status || 1);
    });
    children.push(child);
}

function stop(status = 0) {
    stopping = true;
    for (const c of children) if (c.exitCode == null) c.kill();
    setTimeout(() => process.exit(status), 500).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('api', 35, 'backend', ['src/server.js']);
run('app', 34, 'frontend', ['node_modules/vite/bin/vite.js']);
