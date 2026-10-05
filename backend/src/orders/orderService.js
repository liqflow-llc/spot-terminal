// Builds, verifies and submits Manifest order transactions.
//
// Wallet abstraction: the user never deposits or withdraws by hand.
//  - Placing an order is ONE wallet prompt that signs two transactions:
//      1. place: create token accounts, wrap SOL if needed, claim a seat, deposit exactly what
//         the order locks, place it, unwrap leftover SOL.
//      2. claim: a durable-nonce transaction that withdraws the order's full-fill proceeds to the
//         user's own wallet (unwrapping SOL). We keep it and the keeper submits it the moment the
//         order has fully filled. It can only ever pay the user.
//  - Cancelling withdraws everything back to the wallet in the same transaction and advances the
//    nonce, which invalidates the unused claim.
//  - A wallet's first order needs a one-time setup transaction that creates its nonce accounts
//    (refundable rent), because a claim must reference a nonce that already exists on-chain.
import crypto from 'crypto';
import {
    ComputeBudgetProgram, Keypair, NONCE_ACCOUNT_LENGTH, NonceAccount, PublicKey,
    SystemProgram, Transaction, VersionedTransaction,
} from '@solana/web3.js';
import { Market } from '@bonasa-tech/manifest-sdk';
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import { getGlobalAddress } from '@bonasa-tech/manifest-sdk';
import { connection } from '../solana.js';
import {
    OrderType, ataIx, batchUpdateIx, claimSeatIx, depositIx, encodePrice, isNativeMint,
    orderEconomics, quoteForBase, unwrapSolIx, withdrawIx, wrapSolIxs,
} from '../venues/manifest/instructions.js';
import { parseBatchUpdateReturn } from '../venues/manifest/fills.js';

const PLACE_CU = 400_000;
const CLAIM_CU = 120_000;
const CANCEL_CU = 300_000;
const PRIORITY_MICROLAMPORTS = 50_000;
const PREPARE_TTL_MS = 3 * 60 * 1000;
const NONCES_PER_SETUP = 2;

export class UserError extends Error {
    constructor(message) {
        super(message);
        this.status = 400;
    }
}

/** "12.345" -> atoms (BigInt), flooring extra precision. Avoids float rounding on sizes. */
export function toAtoms(amount, decimals) {
    const str = typeof amount === 'number' ? amount.toFixed(Math.min(20, decimals + 2)) : String(amount).trim();
    if (!/^\d*\.?\d*$/.test(str) || str === '' || str === '.') throw new UserError('Invalid amount');
    const [whole, frac = ''] = str.split('.');
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

const priorityIxs = (units) => [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }),
];

function parseWallet(wallet) {
    try {
        return new PublicKey(wallet);
    } catch {
        throw new UserError('Invalid wallet address');
    }
}

export class OrderService {
    constructor({ markets, store, keeperPubkey }) {
        this.markets = markets;
        this.store = store;
        this.keeperPubkey = keeperPubkey;
        this.pending = new Map(); // prepared-but-unsigned transactions, by id
        setInterval(() => {
            const now = Date.now();
            for (const [id, p] of this.pending) if (now - p.createdAt > PREPARE_TTL_MS) this.pending.delete(id);
        }, 30_000).unref();
    }

    // ---------- context ----------

    async loadContext(walletPk, marketAddress) {
        const market = await this.markets.refresh(marketAddress);
        const baseMint = market.baseMint(), quoteMint = market.quoteMint();
        const nonceAddrs = this.store.noncesFor(walletPk.toBase58()).map(a => new PublicKey(a));
        const infos = await connection.getMultipleAccountsInfo(
            [baseMint, quoteMint, getGlobalAddress(baseMint), getGlobalAddress(quoteMint), walletPk, ...nonceAddrs],
            'confirmed',
        );
        const [baseInfo, quoteInfo, baseGlobal, quoteGlobal, walletInfo] = infos;
        if (!baseInfo || !quoteInfo) throw new Error('Market mints not found');

        const inUse = this.noncesSpokenFor(walletPk.toBase58());
        const nonces = [];
        nonceAddrs.forEach((addr, i) => {
            const info = infos[5 + i];
            if (!info || !info.owner.equals(SystemProgram.programId) || info.data.length !== NONCE_ACCOUNT_LENGTH) return;
            const n = NonceAccount.fromAccountData(info.data);
            if (!n.authorizedPubkey.equals(walletPk)) return;
            nonces.push({ address: addr.toBase58(), value: n.nonce, free: !inUse.has(addr.toBase58()) });
        });

        return {
            market,
            marketAddress,
            baseMint: baseMint.toBase58(),
            quoteMint: quoteMint.toBase58(),
            baseDecimals: market.baseDecimals(),
            quoteDecimals: market.quoteDecimals(),
            baseTokenProgram: baseInfo.owner,
            quoteTokenProgram: quoteInfo.owner,
            globals: { base: !!baseGlobal, quote: !!quoteGlobal },
            lamports: walletInfo?.lamports ?? 0,
            nonces,
            freeNonces: nonces.filter(n => n.free),
        };
    }

    /** Nonces backing live orders, orders being placed, or a refund the user is signing. */
    noncesSpokenFor(wallet) {
        const used = this.store.noncesInUse(wallet);
        for (const o of this.store.forWallet(wallet)) if (o.status === 'placing') used.add(o.nonce);
        for (const p of this.pending.values()) {
            if (p.wallet !== wallet) continue;
            if (p.kind === 'order') used.add(p.order.nonce);
            if (p.kind === 'closePayout') p.nonceAddresses.forEach(a => used.add(a));
        }
        return used;
    }

    async tokenBalanceAtoms(walletPk, mint, tokenProgram, lamports) {
        if (isNativeMint(mint)) return BigInt(lamports);
        const ata = getAssociatedTokenAddressSync(new PublicKey(mint), walletPk, true, tokenProgram);
        try {
            const bal = await connection.getTokenAccountBalance(ata, 'confirmed');
            return BigInt(bal.value.amount);
        } catch {
            return 0n;
        }
    }

    // ---------- nonce setup ----------

    async prepareNonceSetup(walletPk) {
        const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({ feePayer: walletPk, blockhash, lastValidBlockHeight });
        tx.add(...priorityIxs(20_000));
        const keypairs = [];
        for (let i = 0; i < NONCES_PER_SETUP; i++) {
            const kp = Keypair.generate();
            keypairs.push(kp);
            tx.add(...SystemProgram.createNonceAccount({
                fromPubkey: walletPk, noncePubkey: kp.publicKey, authorizedPubkey: walletPk, lamports: rent,
            }).instructions);
        }
        // The nonce keypairs only sign their own creation; control rests with the wallet (authority).
        tx.partialSign(...keypairs);
        const id = crypto.randomUUID();
        this.pending.set(id, {
            kind: 'setup', wallet: walletPk.toBase58(), createdAt: Date.now(),
            messages: [tx.serializeMessage()], blockhash, lastValidBlockHeight,
            nonceAddresses: keypairs.map(k => k.publicKey.toBase58()),
        });
        return {
            step: 'setup',
            id,
            transactions: [tx.serialize({ requireAllSignatures: false }).toString('base64')],
            summary: {
                title: 'Enable instant payouts',
                detail: `One-time setup: creates ${NONCES_PER_SETUP} payout accounts so filled orders return to your wallet automatically. Refundable deposit ${((rent * NONCES_PER_SETUP) / 1e9).toFixed(5)} SOL.`,
                depositSol: (rent * NONCES_PER_SETUP) / 1e9,
            },
        };
    }

    // ---------- place ----------

    async prepareOrder({ wallet, market, side, price, size, postOnly = false }) {
        const walletPk = parseWallet(wallet);
        if (side !== 'buy' && side !== 'sell') throw new UserError('side must be buy or sell');
        const tokenPrice = Number(price);
        if (!(tokenPrice > 0)) throw new UserError('Enter a price above zero');

        const ctx = await this.loadContext(walletPk, market);
        if (!ctx.freeNonces.length) return this.prepareNonceSetup(walletPk);

        const isBid = side === 'buy';
        const baseAtoms = toAtoms(size, ctx.baseDecimals);
        if (baseAtoms <= 0n) throw new UserError('Order size is too small');
        let encoded;
        try {
            encoded = encodePrice(tokenPrice, ctx.baseDecimals, ctx.quoteDecimals);
        } catch (err) {
            throw new UserError(err.message);
        }
        const econ = orderEconomics({ isBid, baseAtoms, mantissa: encoded.mantissa, exponent: encoded.exponent });
        const lockMint = econ.lockMint === 'base' ? ctx.baseMint : ctx.quoteMint;
        const lockProgram = econ.lockMint === 'base' ? ctx.baseTokenProgram : ctx.quoteTokenProgram;
        const proceedsMint = econ.proceedsMint === 'base' ? ctx.baseMint : ctx.quoteMint;
        const proceedsProgram = econ.proceedsMint === 'base' ? ctx.baseTokenProgram : ctx.quoteTokenProgram;

        const hasSeat = ctx.market.hasSeat(walletPk);
        const freeLocked = hasSeat ? BigInt(ctx.market.getWithdrawableBalanceAtoms(walletPk, econ.lockMint === 'base').toString()) : 0n;
        const depositAtoms = econ.lockAtoms > freeLocked ? econ.lockAtoms - freeLocked : 0n;

        // Friendly balance check before asking for a signature.
        const walletBalance = await this.tokenBalanceAtoms(walletPk, lockMint, lockProgram, ctx.lamports);
        const solReserve = isNativeMint(lockMint) ? 10_000_000n : 0n; // keep ~0.01 SOL for fees/rent
        if (depositAtoms + solReserve > walletBalance) {
            throw new UserError(`Insufficient balance: this order needs ${formatAtoms(depositAtoms, econ.lockMint === 'base' ? ctx.baseDecimals : ctx.quoteDecimals)} more ${isNativeMint(lockMint) ? 'SOL (plus ~0.01 for fees)' : 'tokens'}.`);
        }

        // ----- place transaction (user pays) -----
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const place = new Transaction({ feePayer: walletPk, blockhash, lastValidBlockHeight });
        place.add(...priorityIxs(PLACE_CU));
        place.add(ataIx({ payer: walletPk, owner: walletPk, mint: ctx.baseMint, tokenProgram: ctx.baseTokenProgram }));
        place.add(ataIx({ payer: walletPk, owner: walletPk, mint: ctx.quoteMint, tokenProgram: ctx.quoteTokenProgram }));
        const wrapsSol = isNativeMint(lockMint) && depositAtoms > 0n;
        if (wrapsSol) place.add(...wrapSolIxs({ owner: walletPk, lamports: depositAtoms }));
        if (!hasSeat) place.add(claimSeatIx({ trader: walletPk, market }));
        if (depositAtoms > 0n) {
            place.add(depositIx({ trader: walletPk, market, mint: lockMint, tokenProgram: lockProgram, amountAtoms: depositAtoms }));
        }
        place.add(batchUpdateIx({
            trader: walletPk, market,
            baseMint: ctx.baseMint, quoteMint: ctx.quoteMint,
            baseTokenProgram: ctx.baseTokenProgram, quoteTokenProgram: ctx.quoteTokenProgram,
            globals: ctx.globals,
            place: [{ baseAtoms, mantissa: encoded.mantissa, exponent: encoded.exponent, isBid, orderType: postOnly ? OrderType.PostOnly : OrderType.Limit }],
        }));
        if (isNativeMint(ctx.baseMint) || isNativeMint(ctx.quoteMint)) place.add(unwrapSolIx({ owner: walletPk }));

        // Keep one spare nonce ready so the next order is a single prompt too.
        let replenish = null;
        if (ctx.freeNonces.length === 1) {
            replenish = Keypair.generate();
            const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
            place.add(...SystemProgram.createNonceAccount({
                fromPubkey: walletPk, noncePubkey: replenish.publicKey, authorizedPubkey: walletPk, lamports: rent,
            }).instructions);
            place.partialSign(replenish);
        }

        await this.simulateOrThrow(place, replenish ? [replenish] : []);

        // ----- claim transaction (durable nonce, keeper pays the fee) -----
        const nonce = ctx.freeNonces[0];
        const claim = this.buildClaim({
            walletPk, nonce, market, proceedsMint, proceedsProgram, claimAtoms: econ.claimAtoms,
        });

        const id = crypto.randomUUID();
        const order = {
            id,
            wallet: walletPk.toBase58(),
            venue: 'manifest',
            market,
            baseMint: ctx.baseMint,
            quoteMint: ctx.quoteMint,
            baseDecimals: ctx.baseDecimals,
            quoteDecimals: ctx.quoteDecimals,
            side,
            isBid,
            price: encoded.effectiveTokenPrice,
            baseAtoms: baseAtoms.toString(),
            mantissa: encoded.mantissa,
            exponent: encoded.exponent,
            postOnly: !!postOnly,
            lockMint,
            lockAtoms: econ.lockAtoms.toString(),
            proceedsMint,
            proceedsIsBase: econ.proceedsMint === 'base',
            claimAtoms: econ.claimAtoms.toString(),
            nonce: nonce.address,
        };
        this.pending.set(id, {
            kind: 'order', wallet: order.wallet, createdAt: Date.now(), order,
            messages: [place.serializeMessage(), claim.serializeMessage()],
            blockhash, lastValidBlockHeight,
            replenishNonce: replenish?.publicKey.toBase58() || null,
        });
        return {
            step: 'sign',
            id,
            transactions: [place, claim].map(t => t.serialize({ requireAllSignatures: false }).toString('base64')),
            summary: {
                title: `${isBid ? 'Buy' : 'Sell'} order`,
                detail: 'Signs the order and its automatic payout in one approval.',
                price: encoded.effectiveTokenPrice,
                size: Number(baseAtoms) / 10 ** ctx.baseDecimals,
                depositAtoms: depositAtoms.toString(),
            },
        };
    }

    buildClaim({ walletPk, nonce, market, proceedsMint, proceedsProgram, claimAtoms }) {
        const noncePk = new PublicKey(nonce.address);
        const claim = new Transaction({
            feePayer: this.keeperPubkey,
            nonceInfo: {
                nonce: nonce.value,
                nonceInstruction: SystemProgram.nonceAdvance({ noncePubkey: noncePk, authorizedPubkey: walletPk }),
            },
        });
        claim.add(...priorityIxs(CLAIM_CU));
        const native = isNativeMint(proceedsMint);
        // The user pays this (refunded by the close below) so the keeper can't be drained of rent.
        if (native) claim.add(ataIx({ payer: walletPk, owner: walletPk, mint: NATIVE_MINT, tokenProgram: proceedsProgram }));
        claim.add(withdrawIx({ trader: walletPk, market, mint: proceedsMint, tokenProgram: proceedsProgram, amountAtoms: claimAtoms }));
        if (native) claim.add(unwrapSolIx({ owner: walletPk }));
        // compileMessage() inserts the nonce-advance instruction first; do it now so the message is final.
        claim.recentBlockhash = nonce.value;
        return claim;
    }

    async simulateOrThrow(tx, extraSigners = []) {
        const v = new VersionedTransaction(tx.compileMessage());
        const sim = await connection.simulateTransaction(v, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
        if (sim.value.err) {
            const logs = sim.value.logs || [];
            const hint = logs.filter(l => /Error|error|insufficient|failed/.test(l)).slice(-3).join(' | ');
            console.warn('Simulation failed:', JSON.stringify(sim.value.err), hint);
            throw new UserError(`The order would fail on-chain: ${hint || JSON.stringify(sim.value.err)}`);
        }
        return sim.value;
    }

    // ---------- submit ----------

    /** Check that the client returned exactly what we built, correctly signed by the wallet. */
    verifySigned(pending, signedB64) {
        if (!Array.isArray(signedB64) || signedB64.length !== pending.messages.length) {
            throw new UserError('Unexpected number of signed transactions');
        }
        const walletPk = new PublicKey(pending.wallet);
        return signedB64.map((b64, i) => {
            let tx;
            try {
                tx = Transaction.from(Buffer.from(b64, 'base64'));
            } catch {
                throw new UserError('Malformed signed transaction');
            }
            if (!tx.serializeMessage().equals(pending.messages[i])) throw new UserError('Signed transaction does not match the prepared one');
            const sig = tx.signatures.find(s => s.publicKey.equals(walletPk));
            if (!sig?.signature) throw new UserError('Transaction is missing the wallet signature');
            if (!tx.verifySignatures(false)) throw new UserError('Invalid signature');
            return tx;
        });
    }

    async send(tx, { blockhash, lastValidBlockHeight }) {
        const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
        const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (res.value.err) throw new UserError(`Transaction failed: ${JSON.stringify(res.value.err)}`);
        return signature;
    }

    async submit({ id, signed }) {
        const pending = this.pending.get(id);
        if (!pending) throw new UserError('This request expired, please try again');
        const txs = this.verifySigned(pending, signed);
        this.pending.delete(id);

        if (pending.kind === 'setup') {
            const signature = await this.send(txs[0], pending);
            pending.nonceAddresses.forEach(a => this.store.addNonce(a, pending.wallet));
            return { ok: true, signature };
        }

        if (pending.kind === 'closePayout') {
            const busy = this.store.noncesInUse(pending.wallet);
            if (pending.nonceAddresses.some(a => busy.has(a))) throw new UserError('An order started using these payout accounts, please try the refund again.');
            const signature = await this.send(txs[0], pending);
            pending.nonceAddresses.forEach(a => this.store.removeNonce(a));
            return { ok: true, signature, refundedSol: pending.refundLamports / 1e9 };
        }

        if (pending.kind === 'cancel' || pending.kind === 'withdraw') {
            const signature = await this.send(txs[0], pending);
            if (pending.orderId) this.store.update(pending.orderId, { status: 'cancelled', cancelSignature: signature });
            return { ok: true, signature };
        }

        // Order: record the claim before sending so a crash can never lose it.
        if (!this.store.noncesFor(pending.wallet).includes(pending.order.nonce)) {
            throw new UserError('Your payout accounts were refunded, please place the order again.');
        }
        const [place, claim] = txs;
        const order = this.store.put({
            ...pending.order,
            status: 'placing',
            claimTx: claim.serialize({ requireAllSignatures: false }).toString('base64'),
            createdAt: Date.now(),
        });
        let signature;
        try {
            signature = await this.send(place, pending);
        } catch (err) {
            this.store.update(order.id, { status: 'failed', error: err.message });
            throw err;
        }
        if (pending.replenishNonce) this.store.addNonce(pending.replenishNonce, pending.wallet);

        const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        // The place transaction holds exactly one batch update placing one order.
        const sequenceNumber = parseBatchUpdateReturn(tx?.meta?.logMessages)?.[0] ?? null;
        if (!sequenceNumber) console.warn(`Order ${order.id}: could not read its sequence number (truncated logs?)`);
        this.store.update(order.id, {
            status: 'open',
            placeSignature: signature,
            placeSlot: tx?.slot ?? null,
            sequenceNumber,
        });
        this.onPlaced?.(order.id);
        return { ok: true, signature, orderId: order.id, sequenceNumber };
    }

    // ---------- payout accounts (durable nonces) ----------

    /** A wallet's payout accounts and how much of their deposit can be refunded right now. */
    async payoutAccounts(wallet) {
        const walletPk = parseWallet(wallet);
        const addrs = this.store.noncesFor(walletPk.toBase58());
        const infos = addrs.length ? await connection.getMultipleAccountsInfo(addrs.map(a => new PublicKey(a)), 'confirmed') : [];
        const inUse = this.noncesSpokenFor(walletPk.toBase58());
        const accounts = [];
        addrs.forEach((address, i) => {
            const info = infos[i];
            if (!info || !info.owner.equals(SystemProgram.programId) || info.data.length !== NONCE_ACCOUNT_LENGTH) return;
            if (!NonceAccount.fromAccountData(info.data).authorizedPubkey.equals(walletPk)) return;
            accounts.push({ address, lamports: info.lamports, inUse: inUse.has(address) });
        });
        const free = accounts.filter(a => !a.inUse);
        return {
            accounts,
            refundableSol: free.reduce((s, a) => s + a.lamports, 0) / 1e9,
            lockedSol: accounts.filter(a => a.inUse).reduce((s, a) => s + a.lamports, 0) / 1e9,
            inUseCount: accounts.length - free.length,
        };
    }

    /**
     * Close every payout account not backing an open order, returning its deposit to the wallet.
     * Accounts backing open orders stay: closing one would void that order's automatic payout.
     */
    async prepareClosePayout({ wallet }) {
        const walletPk = parseWallet(wallet);
        const { accounts, inUseCount } = await this.payoutAccounts(wallet);
        const closable = accounts.filter(a => !a.inUse);
        if (!closable.length) {
            throw new UserError(inUseCount
                ? 'Your payout accounts are backing open orders. Cancel or wait for those orders to fill, then try again.'
                : 'You have no payout accounts to refund.');
        }
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({ feePayer: walletPk, blockhash, lastValidBlockHeight });
        tx.add(...priorityIxs(5_000 + closable.length * 2_000));
        // Withdrawing a nonce account's whole balance closes it.
        for (const a of closable) {
            tx.add(SystemProgram.nonceWithdraw({
                noncePubkey: new PublicKey(a.address), authorizedPubkey: walletPk, toPubkey: walletPk, lamports: a.lamports,
            }));
        }
        await this.simulateOrThrow(tx);
        const refundLamports = closable.reduce((s, a) => s + a.lamports, 0);
        const id = crypto.randomUUID();
        this.pending.set(id, {
            kind: 'closePayout', wallet: walletPk.toBase58(), createdAt: Date.now(),
            messages: [tx.serializeMessage()], blockhash, lastValidBlockHeight,
            nonceAddresses: closable.map(a => a.address), refundLamports,
        });
        return {
            step: 'sign',
            id,
            transactions: [tx.serialize({ requireAllSignatures: false }).toString('base64')],
            summary: { title: 'Refund deposit', detail: `Returns ${(refundLamports / 1e9).toFixed(5)} SOL to your wallet.` },
        };
    }

    // ---------- cancel / withdraw ----------

    async prepareCancel({ wallet, orderId }) {
        const walletPk = parseWallet(wallet);
        const order = this.store.get(orderId);
        if (!order || order.wallet !== walletPk.toBase58()) throw new UserError('Order not found');
        if (order.status !== 'open') throw new UserError(`Order is ${order.status}`);
        const ctx = await this.loadContext(walletPk, order.market);
        const onBook = order.sequenceNumber && [...ctx.market.bids(), ...ctx.market.asks()]
            .some(o => o.sequenceNumber.toString() === order.sequenceNumber);

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({ feePayer: walletPk, blockhash, lastValidBlockHeight });
        tx.add(...priorityIxs(CANCEL_CU));
        // Advancing the nonce voids the order's unused pre-signed claim and frees the nonce.
        tx.add(SystemProgram.nonceAdvance({ noncePubkey: new PublicKey(order.nonce), authorizedPubkey: walletPk }));
        if (onBook) {
            tx.add(batchUpdateIx({
                trader: walletPk, market: order.market, baseMint: ctx.baseMint, quoteMint: ctx.quoteMint,
                baseTokenProgram: ctx.baseTokenProgram, quoteTokenProgram: ctx.quoteTokenProgram,
                globals: ctx.globals, cancel: [order.sequenceNumber],
            }));
        }
        await this.appendWithdrawAll(tx, walletPk, ctx, { excludeOrderId: order.id });
        const id = crypto.randomUUID();
        this.pending.set(id, { kind: 'cancel', orderId, wallet: walletPk.toBase58(), createdAt: Date.now(), messages: [tx.serializeMessage()], blockhash, lastValidBlockHeight });
        return { step: 'sign', id, transactions: [tx.serialize({ requireAllSignatures: false }).toString('base64')], summary: { title: 'Cancel order', detail: 'Cancels the order and returns its funds to your wallet.' } };
    }

    /** Withdraw everything this wallet has sitting in a market (partial fills, leftovers). */
    async prepareWithdraw({ wallet, market }) {
        const walletPk = parseWallet(wallet);
        const ctx = await this.loadContext(walletPk, market);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({ feePayer: walletPk, blockhash, lastValidBlockHeight });
        tx.add(...priorityIxs(CANCEL_CU));
        const added = await this.appendWithdrawAll(tx, walletPk, ctx);
        if (!added) throw new UserError('Nothing to withdraw on this market');
        const id = crypto.randomUUID();
        this.pending.set(id, { kind: 'withdraw', wallet: walletPk.toBase58(), createdAt: Date.now(), messages: [tx.serializeMessage()], blockhash, lastValidBlockHeight });
        return { step: 'sign', id, transactions: [tx.serialize({ requireAllSignatures: false }).toString('base64')], summary: { title: 'Withdraw to wallet', detail: 'Moves your filled proceeds and leftovers back to your wallet.' } };
    }

    /**
     * Append withdrawals of every free balance the wallet will have after the instructions already
     * in `tx` run. Simulates `tx` first so cancelled orders' released funds are included exactly.
     */
    async appendWithdrawAll(tx, walletPk, ctx, { excludeOrderId = null } = {}) {
        let market = ctx.market;
        if (tx.instructions.length > 2) {
            const v = new VersionedTransaction(tx.compileMessage());
            const sim = await connection.simulateTransaction(v, {
                sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
                accounts: { encoding: 'base64', addresses: [ctx.marketAddress] },
            });
            if (sim.value.err) throw new UserError(`Cancel would fail on-chain: ${JSON.stringify(sim.value.err)}`);
            const acct = sim.value.accounts?.[0];
            if (acct) {
                market = Market.loadFromBuffer({ address: new PublicKey(ctx.marketAddress), buffer: Buffer.from(acct.data[0], 'base64'), slot: sim.context.slot });
            }
        }
        if (!market.hasSeat(walletPk)) return false;
        // Leave behind what other open orders' pre-signed claims will need, or they'd come up short.
        const reserved = this.claimReservations(walletPk.toBase58(), ctx.marketAddress, market, excludeOrderId);
        const sub = (a, b) => (a > b ? a - b : 0n);
        const base = sub(BigInt(market.getWithdrawableBalanceAtoms(walletPk, true).toString()), reserved.base);
        const quote = sub(BigInt(market.getWithdrawableBalanceAtoms(walletPk, false).toString()), reserved.quote);
        if (base === 0n && quote === 0n) return false;
        tx.add(ataIx({ payer: walletPk, owner: walletPk, mint: ctx.baseMint, tokenProgram: ctx.baseTokenProgram }));
        tx.add(ataIx({ payer: walletPk, owner: walletPk, mint: ctx.quoteMint, tokenProgram: ctx.quoteTokenProgram }));
        if (base > 0n) tx.add(withdrawIx({ trader: walletPk, market: ctx.marketAddress, mint: ctx.baseMint, tokenProgram: ctx.baseTokenProgram, amountAtoms: base }));
        if (quote > 0n) tx.add(withdrawIx({ trader: walletPk, market: ctx.marketAddress, mint: ctx.quoteMint, tokenProgram: ctx.quoteTokenProgram, amountAtoms: quote }));
        if (isNativeMint(ctx.baseMint) || isNativeMint(ctx.quoteMint)) tx.add(unwrapSolIx({ owner: walletPk }));
        return true;
    }
}

/**
 * Proceeds already credited to this wallet's other open orders on `marketAddress` (their partial
 * fills). Those stay in the market so each order's claim can still withdraw its full amount.
 */
OrderService.prototype.claimReservations = function claimReservations(wallet, marketAddress, market, excludeOrderId) {
    const remaining = new Map([...market.bids(), ...market.asks()].map(o => [o.sequenceNumber.toString(), BigInt(o.numBaseAtoms.toString())]));
    const out = { base: 0n, quote: 0n };
    for (const o of this.store.active()) {
        if (o.wallet !== wallet || o.market !== marketAddress || o.id === excludeOrderId) continue;
        const total = BigInt(o.baseAtoms);
        const left = o.sequenceNumber && remaining.has(o.sequenceNumber) ? remaining.get(o.sequenceNumber) : 0n;
        const filled = total > left ? total - left : 0n;
        if (filled === 0n) continue;
        if (o.isBid) out.base += filled;
        else out.quote += left === 0n ? BigInt(o.claimAtoms) : quoteForBase(o.mantissa, o.exponent, filled, false);
    }
    return out;
};

function formatAtoms(atoms, decimals) {
    return (Number(atoms) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: Math.min(decimals, 9) });
}
