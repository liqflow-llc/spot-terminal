// Submits users' pre-signed claims as soon as their orders have fully filled.
//
// The keeper only ever adds its fee-payer signature to a transaction the user already signed;
// that transaction withdraws to the user's own token account, so the keeper cannot redirect funds.
import fs from 'fs';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { connection } from '../solana.js';
import { config } from '../config.js';

const SWEEP_MS = 20_000;
const MAX_CLAIM_ATTEMPTS = 5;

export function loadKeeperKeypair() {
    if (!fs.existsSync(config.keeperKeypairPath)) {
        const kp = Keypair.generate();
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.writeFileSync(config.keeperKeypairPath, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
        console.warn(`Keeper: generated new fee-payer keypair ${kp.publicKey.toBase58()} — fund it with a little SOL`);
        return kp;
    }
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(config.keeperKeypairPath, 'utf8'))));
}

export class Keeper {
    constructor({ markets, store, keypair }) {
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
            console.log(`Keeper: fee payer ${this.keypair.publicKey.toBase58()} has ${(lamports / 1e9).toFixed(4)} SOL`);
        }).catch(() => {});
    }

    /** Called by the fill feed: a resting order on `market` just traded. */
    onFill(fill) {
        if (this.releases.has(fill.market)) setTimeout(() => this.checkMarket(fill.market), 1500);
    }

    track(orderId) {
        const order = this.store.get(orderId);
        if (order) this.watch(order.market);
        this.sweep();
    }

    watch(market) {
        if (!this.releases.has(market)) this.releases.set(market, this.markets.subscribe(market));
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
            if (resting.has(order.sequenceNumber)) continue;

            const wallet = new PublicKey(order.wallet);
            const free = market.hasSeat(wallet)
                ? BigInt(market.getWithdrawableBalanceAtoms(wallet, order.proceedsIsBase).toString())
                : 0n;
            if (free >= BigInt(order.claimAtoms)) {
                this.submitClaim(order);
            } else if (!order.missingSince) {
                // Gone from the book without enough proceeds: cancelled elsewhere, expired, or
                // partially filled then removed. The user can withdraw from the app.
                this.store.update(order.id, { missingSince: Date.now() });
            } else if (Date.now() - order.missingSince > 5 * 60 * 1000) {
                this.store.update(order.id, { status: 'closed', note: 'Left the book without filling completely; withdraw any balance from the market.' });
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
            this.store.update(order.id, { status: 'claimed', claimSignature: signature, claimedAt: Date.now() });
            console.log(`Keeper: claimed order ${order.id} -> ${signature}`);
        } catch (err) {
            const attempts = (order.claimAttempts || 0) + 1;
            console.error(`Keeper: claim for ${order.id} failed (attempt ${attempts}):`, err.message);
            this.store.update(order.id, {
                status: attempts >= MAX_CLAIM_ATTEMPTS ? 'claim_failed' : 'open',
                claimAttempts: attempts,
                error: err.message.slice(0, 300),
            });
        } finally {
            this.inFlight.delete(order.id);
        }
    }
}
