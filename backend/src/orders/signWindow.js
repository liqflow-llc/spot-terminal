// A longer time to approve transactions in the wallet.
//
// A transaction built on a recent blockhash dies ~60-90 s later, so a user who reads the wallet
// prompt carefully gets "expired". Instead, every transaction the user signs is built on a durable
// nonce from this pool (owned by the keeper): it stays valid until that nonce advances, and the
// server enforces the window (5 minutes) itself.
//
// Safety rules, because a durable transaction never expires on its own:
//  - A nonce is handed out for one transaction at a time.
//  - It is reused only after it has advanced: either our transaction landed (which advances it) or
//    we advanced it ourselves ("voided" it), which kills any signed copy of the old transaction.
//    Every lease that ends without landing is voided before the nonce is reused.
//  - The keeper's signature on a user's transaction only authorises the nonce advance: signLegacy
//    and signVersioned refuse any transaction that uses the keeper anywhere else.
//
// The keeper pays rent for the pool (~0.0015 SOL per nonce) and 5000 lamports per void, batched.
// When the pool is empty or unavailable, callers fall back to a recent blockhash (~1 minute).
import fs from 'fs';
import path from 'path';
import { Keypair, NONCE_ACCOUNT_LENGTH, NonceAccount, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { connection } from '../solana.js';
import { config } from '../config.js';
import { errorDetail, log, short } from '../log.js';

const VOIDS_PER_TX = 10;
const SWEEP_MS = 15_000;
const MAX_LEASES_PER_WALLET = 3;
const MAX_POOL = 40;
const GROW_BY = 4;
const MIN_KEEPER_LAMPORTS_TO_GROW = 50_000_000; // keep the keeper's claim-fee money

export class SignWindowPool {
    constructor({ keypair, size = 12, windowMs = 5 * 60_000, file = path.join(config.dataDir, 'sign-window-nonces.json') }) {
        this.keypair = keypair;
        this.size = size;
        this.windowMs = windowMs;
        this.file = file;
        this.nonces = new Map(); // address -> { address, value, state: free|leased|dirty|stale, lease }
        this.timer = null;
        this.growing = null;
        this.ready = false; // until start() has read the pool, everyone gets the short window
    }

    get authority() {
        return this.keypair.publicKey;
    }

    async start() {
        let saved = [];
        try {
            saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch { /* first run */ }
        for (const address of saved) this.nonces.set(address, { address, value: null, state: 'stale' });
        await this.refresh();
        if (this.nonces.size < this.size) await this.grow(this.size - this.nonces.size);
        this.timer = setInterval(() => this.sweep().catch(err => log.warn('sign-window', 'sweep_failed', { msg: errorDetail(err) })), SWEEP_MS);
        this.timer.unref?.();
        this.ready = true;
        log.info('sign-window', 'ready', { nonces: this.nonces.size, free: this.freeCount(), windowS: this.windowMs / 1000 });
    }

    stop() {
        clearInterval(this.timer);
    }

    freeCount() {
        return [...this.nonces.values()].filter(n => n.state === 'free').length;
    }

    /**
     * A nonce for one transaction `wallet` will sign, or null (use a recent blockhash instead).
     * A wallet holding too many already gives up its oldest (that request can no longer be sent).
     */
    acquire(wallet) {
        if (!this.ready) return null;
        const mine = [...this.nonces.values()].filter(n => n.state === 'leased' && n.lease.wallet === wallet)
            .sort((a, b) => a.lease.at - b.lease.at);
        while (mine.length >= MAX_LEASES_PER_WALLET) this.release(mine.shift().lease, false);
        const n = [...this.nonces.values()].find(x => x.state === 'free');
        if (!n) {
            log.warn('sign-window', 'pool_empty', { nonces: this.nonces.size });
            this.grow(GROW_BY).catch(() => {});
            return null;
        }
        n.state = 'leased';
        n.lease = { address: n.address, value: n.value, wallet, at: Date.now(), done: false };
        return n.lease;
    }

    /** Hand back a lease nothing was signed with (the transaction was never built): no void needed. */
    unuse(lease) {
        if (!lease || lease.done) return;
        lease.done = true;
        const n = this.nonces.get(lease.address);
        if (n && n.lease === lease) {
            n.lease = null;
            n.state = 'free';
        }
    }

    /** The instruction a durable transaction must start with. */
    advanceIx(lease) {
        return SystemProgram.nonceAdvance({ noncePubkey: new PublicKey(lease.address), authorizedPubkey: this.authority });
    }

    /** nonceInfo for a legacy Transaction built on this lease. */
    nonceInfo(lease) {
        return { nonce: lease.value, nonceInstruction: this.advanceIx(lease) };
    }

    /** Refuse to sign anything where the keeper's signature means more than "advance this nonce". */
    assertOnlyAdvance(instructions, lease) {
        const keeper = this.authority;
        const [first, ...rest] = instructions;
        const isAdvance = first && first.programId.equals(SystemProgram.programId)
            && first.keys[0]?.pubkey.equals(new PublicKey(lease.address)) && first.keys[2]?.pubkey.equals(keeper)
            && first.data.readUInt32LE(0) === 4; // SystemInstruction::AdvanceNonceAccount
        if (!isAdvance) throw new Error('sign-window: transaction does not start with our nonce advance');
        if (rest.some(ix => ix.keys.some(k => k.pubkey.equals(keeper)) || ix.programId.equals(keeper))) {
            throw new Error('sign-window: refusing to sign a transaction that uses the keeper elsewhere');
        }
    }

    signLegacy(tx, lease) {
        tx.recentBlockhash = lease.value;
        tx.nonceInfo = this.nonceInfo(lease);
        // compileMessage puts nonceInfo's advance first, ahead of tx.instructions.
        this.assertOnlyAdvance([tx.nonceInfo.nonceInstruction, ...tx.instructions], lease);
        tx.partialSign(this.keypair);
    }

    signVersioned(vtx, lease, instructions) {
        this.assertOnlyAdvance(instructions, lease);
        vtx.sign([this.keypair]);
    }

    /**
     * The transaction built on `lease` is finished with. landed: it executed (so the nonce has
     * advanced). Otherwise the nonce is voided before anyone gets it again.
     */
    release(lease, landed) {
        if (!lease || lease.done) return;
        lease.done = true;
        const n = this.nonces.get(lease.address);
        if (!n || n.lease !== lease) return;
        n.lease = null;
        n.state = landed ? 'stale' : 'dirty';
        // Free it again soon rather than at the next sweep.
        setTimeout(() => this.sweep().catch(() => {}), 200).unref?.();
    }

    /** Void one lease now (when we can't tell whether its transaction will still land). */
    async voidNow(lease) {
        const n = this.nonces.get(lease.address);
        if (n && n.lease === lease) {
            n.lease = null;
            lease.done = true;
            n.state = 'dirty';
        }
        await this.advance([lease.address]);
    }

    async sweep() {
        if (this.sweeping) return this.sweeping;
        this.sweeping = (async () => {
            const now = Date.now();
            for (const n of this.nonces.values()) {
                // A lease nobody released (a bug, or a crashed request): void it after the window.
                if (n.state === 'leased' && now - n.lease.at > this.windowMs + 60_000) {
                    log.warn('sign-window', 'lease_leaked', { nonce: short(n.address), wallet: short(n.lease.wallet) });
                    n.lease.done = true;
                    n.lease = null;
                    n.state = 'dirty';
                }
            }
            const dirty = [...this.nonces.values()].filter(n => n.state === 'dirty').map(n => n.address);
            for (let i = 0; i < dirty.length; i += VOIDS_PER_TX) await this.advance(dirty.slice(i, i + VOIDS_PER_TX));
            if ([...this.nonces.values()].some(n => n.state === 'stale')) await this.refresh();
        })().finally(() => { this.sweeping = null; });
        return this.sweeping;
    }

    /** Advance nonces we hold (voiding any transaction built on their current value). */
    async advance(addresses) {
        if (!addresses.length) return;
        const tx = new Transaction();
        for (const a of addresses) tx.add(SystemProgram.nonceAdvance({ noncePubkey: new PublicKey(a), authorizedPubkey: this.authority }));
        try {
            await this.sendOwn(tx, [this.keypair]);
            log.info('sign-window', 'voided', { nonces: addresses.length });
        } catch (err) {
            // A nonce already advanced by the transaction landing makes the advance fail with the
            // same value; re-reading tells us the truth either way.
            log.warn('sign-window', 'void_failed', { nonces: addresses.length, msg: errorDetail(err) });
            const before = new Map(addresses.map(a => [a, this.nonces.get(a)?.value]));
            await this.refresh(addresses);
            for (const a of addresses) {
                const n = this.nonces.get(a);
                if (n && n.value === before.get(a)) n.state = 'dirty'; // unchanged: still needs voiding
            }
            return;
        }
        for (const a of addresses) {
            const n = this.nonces.get(a);
            if (n) n.state = 'stale';
        }
        await this.refresh(addresses);
    }

    /** Re-read nonce values; a stale nonce becomes free once its value is known. */
    async refresh(addresses = [...this.nonces.keys()]) {
        for (let i = 0; i < addresses.length; i += 100) {
            const batch = addresses.slice(i, i + 100);
            const infos = await connection.getMultipleAccountsInfo(batch.map(a => new PublicKey(a)), 'confirmed');
            batch.forEach((a, j) => {
                const n = this.nonces.get(a);
                const info = infos[j];
                if (!n) return;
                if (!info || info.data.length !== NONCE_ACCOUNT_LENGTH) {
                    this.nonces.delete(a);
                    return;
                }
                const value = NonceAccount.fromAccountData(info.data).nonce;
                if (n.state === 'stale' || (n.state === 'free' && value !== n.value)) {
                    n.value = value;
                    n.state = 'free';
                }
            });
        }
        this.save();
    }

    async grow(count) {
        if (this.growing) return this.growing;
        this.growing = (async () => {
            count = Math.min(count, MAX_POOL - this.nonces.size);
            if (count <= 0) return;
            const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
            const balance = await connection.getBalance(this.authority, 'confirmed');
            if (balance - rent * count < MIN_KEEPER_LAMPORTS_TO_GROW) {
                log.warn('sign-window', 'cannot_grow', { keeperSol: balance / 1e9, want: count });
                return;
            }
            const created = [];
            for (let i = 0; i < count; i += 4) {
                const kps = Array.from({ length: Math.min(4, count - i) }, () => Keypair.generate());
                const tx = new Transaction();
                for (const kp of kps) {
                    tx.add(...SystemProgram.createNonceAccount({
                        fromPubkey: this.authority, noncePubkey: kp.publicKey, authorizedPubkey: this.authority, lamports: rent,
                    }).instructions);
                }
                await this.sendOwn(tx, [this.keypair, ...kps]);
                for (const kp of kps) {
                    const address = kp.publicKey.toBase58();
                    this.nonces.set(address, { address, value: null, state: 'stale' });
                    created.push(address);
                }
            }
            await this.refresh(created);
            log.info('sign-window', 'grew', { added: created.length, nonces: this.nonces.size });
        })().catch((err) => {
            log.warn('sign-window', 'grow_failed', { msg: errorDetail(err) });
        }).finally(() => { this.growing = null; });
        return this.growing;
    }

    /** Send a keeper-paid transaction on a fresh blockhash (web3.js would reuse one up to 30 s old). */
    async sendOwn(tx, signers) {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        tx.feePayer = this.authority;
        tx.recentBlockhash = blockhash;
        tx.sign(...signers);
        const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
        const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`);
        return signature;
    }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.nonces.keys()]));
        fs.renameSync(`${this.file}.tmp`, this.file);
    }
}
