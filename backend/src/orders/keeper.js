// Submits users' pre-signed claims as soon as their orders have fully filled.
//
// The keeper only ever adds its fee-payer signature to a transaction the user already signed;
// that transaction withdraws to the user's own token account, so the keeper cannot redirect funds.
import fs from 'fs';
import { EventEmitter } from 'events';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { connection } from '../solana.js';
import { config } from '../config.js';
import { claimReservations } from './orderStore.js';
import { errorDetail, log, short } from '../log.js';

const SWEEP_MS = 20_000;
const MAX_CLAIM_ATTEMPTS = 5;

export function loadKeeperKeypair() {
    if (!fs.existsSync(config.keeperKeypairPath)) {
        const kp = Keypair.generate();
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.writeFileSync(config.keeperKeypairPath, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
        log.warn('keeper', 'generated_keypair', { feePayer: kp.publicKey.toBase58(), note: 'fund it with a little SOL' });
        return kp;
    }
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(config.keeperKeypairPath, 'utf8'))));
}

/** Emits 'claimed', 'expired', 'closed' and 'claim_failed' with the order (for notifications). */
export class Keeper extends EventEmitter {
    constructor({ markets, store, keypair }) {
        super();
        this.markets = markets;
        this.store = store;
        this.keypair = keypair;
        this.releases = new Map(); // market -> release fn for its live subscription
        this.inFlight = new Set();
    }

    start() {
        this.markets.on('update', (market) => this.checkMarket(market));
        setInterval(() => this.sweep(), SWEEP_MS).unref();
        this.sweep();
        connection.getBalance(this.keypair.publicKey).then(lamports => {
            this.balanceSol = lamports / 1e9;
            log.info('keeper', 'started', { feePayer: this.keypair.publicKey.toBase58(), sol: this.balanceSol.toFixed(4) });
        }).catch(() => {});
    }

    track(orderId) {
        const order = this.store.get(orderId);
        if (order) this.watch(order.market);
        this.sweep();
    }

    watch(market) {
        if (!this.releases.has(market)) this.releases.set(market, this.markets.subscribe(market, { viewer: false }));
    }

    sweep() {
        const active = this.store.active();
        const marketsWithOrders = new Set(active.map(o => o.market));
        for (const m of marketsWithOrders) this.watch(m);
        for (const [m, release] of this.releases) {
            if (!marketsWithOrders.has(m)) {
                release();
                this.releases.delete(m);
            }
        }
        for (const m of marketsWithOrders) this.checkMarket(m);
    }

    checkMarket(marketAddress) {
        const market = this.markets.get(marketAddress);
        if (!market) return;
        const slot = this.markets.slot;
        const resting = new Set([...market.bids(), ...market.asks()].map(o => o.sequenceNumber.toString()));
        for (const order of this.store.active()) {
            if (order.market !== marketAddress || order.status !== 'open') continue;
            // Don't judge an order against market data older than the order itself.
            if (order.placeSlot && slot < order.placeSlot) continue;
            // Without a sequence number we can't tell whether the order is still resting, and the
            // seat may hold other funds, so never claim blind; the user can withdraw manually.
            if (!order.sequenceNumber) continue;
            // Judged by slot, not by the book: an unchanged market account is never re-parsed, so the
            // cached book can still list an order after its expiry slot.
            const expired = order.lastValidSlot && slot > order.lastValidSlot;
            if (!expired && resting.has(order.sequenceNumber)) continue;

            const wallet = new PublicKey(order.wallet);
            const balance = market.hasSeat(wallet)
                ? BigInt(market.getWithdrawableBalanceAtoms(wallet, order.proceedsIsBase).toString())
                : 0n;
            // The seat may also hold the wallet's other orders' proceeds; those don't count as a
            // fill of this one (e.g. right after the user cancelled it).
            const reserved = claimReservations(this.store, order.wallet, marketAddress, market, order.id);
            const free = balance - (order.proceedsIsBase ? reserved.base : reserved.quote);
            if (free >= BigInt(order.claimAtoms)) {
                this.submitClaim(order);
            } else if (expired) {
                // Manifest keeps an expired order's funds locked until its owner cancels it, which
                // needs their signature: the app shows a Withdraw button (and notifies them).
                this.store.update(order.id, { status: 'expired', expiredAt: Date.now(), note: 'Expired: withdraw to get the funds back.' });
                log.info('keeper', 'order_expired', { order: order.id, wallet: short(order.wallet), market: short(order.market) });
                this.emit('expired', this.store.get(order.id));
            } else if (!order.missingSince) {
                // Gone from the book without enough proceeds: cancelled elsewhere, expired, or
                // partially filled then removed. The user can withdraw from the app.
                this.store.update(order.id, { missingSince: Date.now() });
            } else if (Date.now() - order.missingSince > 5 * 60 * 1000) {
                this.store.update(order.id, { status: 'closed', note: 'Left the book without filling completely; withdraw any balance from the market.' });
                log.warn('keeper', 'order_closed_unfilled', { order: order.id, wallet: short(order.wallet), market: short(order.market) });
                this.emit('closed', this.store.get(order.id));
            }
        }
    }

    async submitClaim(order) {
        if (this.inFlight.has(order.id)) return;
        this.inFlight.add(order.id);
        this.store.update(order.id, { status: 'claiming' });
        try {
            const tx = Transaction.from(Buffer.from(order.claimTx, 'base64'));
            tx.partialSign(this.keypair);
            const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
            const res = await connection.confirmTransaction({
                signature,
                nonceAccountPubkey: new PublicKey(order.nonce),
                nonceValue: tx.recentBlockhash,
                minContextSlot: order.placeSlot || 0,
            }, 'confirmed');
            if (res.value.err) throw new Error(JSON.stringify(res.value.err));
            // Landed, so the nonce was unused: no cancel can have gone through first.
            this.store.update(order.id, { status: 'claimed', claimSignature: signature, claimedAt: Date.now() });
            log.info('keeper', 'claimed', { order: order.id, wallet: short(order.wallet), market: short(order.market), sig: signature });
            this.emit('claimed', this.store.get(order.id));
        } catch (err) {
            const attempts = (order.claimAttempts || 0) + 1;
            log.error('keeper', 'claim_failed', { order: order.id, wallet: short(order.wallet), attempt: attempts, msg: errorDetail(err) });
            // The user cancelled meanwhile (which voids the claim): keep that outcome.
            if (this.store.get(order.id)?.status !== 'claiming') return;
            this.store.update(order.id, {
                status: attempts >= MAX_CLAIM_ATTEMPTS ? 'claim_failed' : 'open',
                claimAttempts: attempts,
                error: err.message.slice(0, 300),
            });
            if (attempts >= MAX_CLAIM_ATTEMPTS) this.emit('claim_failed', this.store.get(order.id));
        } finally {
            this.inFlight.delete(order.id);
        }
    }
}
