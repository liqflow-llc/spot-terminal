// Browser push notifications for order events (filled and paid out, expired, payout failed).
// Works with the tab closed: the browser's push service delivers to our service worker
// (frontend/public/sw.js). Subscriptions are kept per wallet in data/push-subscriptions.json;
// the signing keys (VAPID) are generated once into data/vapid.json.
import fs from 'fs';
import path from 'path';
import webpush from 'web-push';
import { config } from './config.js';
import { log, short } from './log.js';

const KEYS_FILE = path.join(config.dataDir, 'vapid.json');
const SUBS_FILE = path.join(config.dataDir, 'push-subscriptions.json');
const MAX_PER_WALLET = 10;

export class Notifier {
    constructor({ contact = 'mailto:support@liqflow.app' } = {}) {
        fs.mkdirSync(config.dataDir, { recursive: true });
        if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
        this.keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
        webpush.setVapidDetails(contact, this.keys.publicKey, this.keys.privateKey);
        try {
            this.subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
        } catch {
            this.subs = {}; // wallet -> [{ endpoint, keys, addedAt }]
        }
    }

    get publicKey() {
        return this.keys.publicKey;
    }

    save() {
        fs.writeFileSync(`${SUBS_FILE}.tmp`, JSON.stringify(this.subs));
        fs.renameSync(`${SUBS_FILE}.tmp`, SUBS_FILE);
    }

    subscribe(wallet, sub) {
        if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Invalid subscription');
        const list = (this.subs[wallet] || []).filter(s => s.endpoint !== sub.endpoint);
        list.unshift({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, addedAt: Date.now() });
        this.subs[wallet] = list.slice(0, MAX_PER_WALLET);
        this.save();
        log.info('notify', 'subscribed', { wallet: short(wallet), devices: this.subs[wallet].length });
    }

    unsubscribe(endpoint) {
        let changed = false;
        for (const [wallet, list] of Object.entries(this.subs)) {
            const kept = list.filter(s => s.endpoint !== endpoint);
            if (kept.length !== list.length) {
                changed = true;
                if (kept.length) this.subs[wallet] = kept; else delete this.subs[wallet];
            }
        }
        if (changed) this.save();
    }

    isSubscribed(wallet, endpoint) {
        return (this.subs[wallet] || []).some(s => s.endpoint === endpoint);
    }

    /** Send to every device subscribed for `wallet`; drops subscriptions the browser revoked. */
    async send(wallet, payload) {
        const list = this.subs[wallet];
        if (!list?.length) return;
        const body = JSON.stringify(payload);
        await Promise.all(list.map(async (s) => {
            try {
                await webpush.sendNotification(s, body, { TTL: 24 * 3600 });
            } catch (err) {
                if (err.statusCode === 404 || err.statusCode === 410) this.unsubscribe(s.endpoint);
                else log.warn('notify', 'send_failed', { wallet: short(wallet), status: err.statusCode, msg: err.message });
            }
        }));
        log.info('notify', 'sent', { wallet: short(wallet), title: payload.title, devices: list.length });
    }
}
