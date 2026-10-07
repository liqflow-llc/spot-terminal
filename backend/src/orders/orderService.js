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
import bs58 from 'bs58';
import {
    AddressLookupTableAccount, ComputeBudgetProgram, Keypair, NONCE_ACCOUNT_LENGTH, NonceAccount, PublicKey,
    SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { Market } from '@bonasa-tech/manifest-sdk';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getGlobalAddress } from '@bonasa-tech/manifest-sdk';
import { connection } from '../solana.js';
import {
    OrderType, ataIx, batchUpdateIx, claimSeatIx, depositIx, encodePrice, isNativeMint,
    orderEconomics, quoteForBase, unwrapSolIx, withdrawIx, wrapSolIxs,
} from '../venues/manifest/instructions.js';
import { errorDetail, log, short } from '../log.js';
import { claimReservations } from './orderStore.js';
import { placedSequenceNumber } from './sequence.js';

const PLACE_CU = 400_000;
const CLAIM_CU = 120_000;
const CANCEL_CU = 300_000;
const PRIORITY_MICROLAMPORTS = 50_000;
const PREPARE_TTL_MS = 3 * 60 * 1000;
const NONCES_PER_SETUP = 2;
const CREATE_MARKET_CU = 100_000;
const MAX_SLIPPAGE_BPS = 1000;
const CANCEL_ALL_MAX = 6;
const SLOT_SECONDS = 0.4; // Solana's target slot time; real slots run a little slower, so expiry errs late
const MAX_EXPIRY_SECONDS = 30 * 24 * 3600;
const QUOTE_CACHE_MS = 3000;
const SWAP_MAX_PRIORITY_LAMPORTS = 1_000_000; // cap on Jupiter's priority fee (0.001 SOL)
/** Buying this far above (or selling this far below) the market price needs explicit consent. */
export const PRICE_WARN_DEVIATION = 0.05;

/** How much worse than the reference price an order is on the side that loses money, or null. */
export function adverseDeviation(side, price, reference) {
    if (!(reference > 0) || !(price > 0)) return null;
    return side === 'buy' ? price / reference - 1 : 1 - price / reference;
}

/** What a failed send means for the user; null if it isn't one we can explain. */
function explainSendError(err) {
    const msg = err?.message || '';
    if (/blockhash not found|block height exceeded|has expired/i.test(msg)) {
        return 'This took too long to approve and expired, so nothing was sent. Please try again.';
    }
    if (/insufficient (funds|lamports)|no record of a prior credit/i.test(msg)) {
        return 'Not enough SOL in your wallet to pay for this transaction (network fee and any deposit). Nothing was sent.';
    }
    // The pre-send simulation failed: the chain changed between prepare and approval.
    if (/simulation failed/i.test(msg)) {
        return "This can't go through anymore: something changed since it was prepared (for example the order filled, or a balance moved). Nothing was sent. Please try again.";
    }
    return null;
}

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

/** The bits of a pending request worth seeing in a log line. */
function describePending(p) {
    if (p.kind === 'order') {
        const o = p.order;
        return { market: short(o.market), side: o.side, price: o.price, base: o.baseAtoms, nonce: short(o.nonce), replaces: p.replaces, expires: o.expiresAt ? new Date(o.expiresAt).toISOString() : undefined };
    }
    if (p.kind === 'swap') return { in: p.result?.inAmount, out: p.result?.outAmount, price: p.result?.price };
    if (p.kind === 'smart') return { now_in: p.swap?.result?.inAmount, now_out: p.swap?.result?.outAmount, now_price: p.swap?.result?.price, rest: p.order?.baseAtoms, limit: p.order?.price, market: short(p.market) };
    if (p.kind === 'cancel') return { order: p.orderId };
    if (p.kind === 'cancelAll') return { orders: p.orderIds?.length };
    if (p.kind === 'createMarket') return { market: short(p.market) };
    if (p.kind === 'closePayout') return { accounts: p.nonceAddresses?.length, sol: p.refundLamports / 1e9 };
    if (p.kind === 'setup') return { accounts: p.nonceAddresses?.length };
    return {};
}

/**
 * A Jupiter Swap API v2 /build response as an unsigned v0 transaction paid by the wallet.
 * Jupiter includes each lookup table's addresses, so no extra RPC calls are needed.
 */
export function buildJupiterTransaction(built, payer) {
    const toIx = (i) => new TransactionInstruction({
        programId: new PublicKey(i.programId),
        keys: i.accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
        data: Buffer.from(i.data, 'base64'),
    });
    const instructions = [
        ...(built.computeBudgetInstructions || []),
        ...(built.setupInstructions || []),
        built.swapInstruction,
        built.cleanupInstruction,
        ...(built.otherInstructions || []),
        built.tipInstruction,
    ].filter(Boolean).map(toIx);
    // Make sure it carries a priority fee (Jupiter's budget instructions may only set the CU limit).
    const SET_PRICE = 3;
    if (!instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === SET_PRICE)) {
        instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }));
    }
    const lookupTables = Object.entries(built.addressesByLookupTableAddress || {}).map(([key, addresses]) => new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addresses.map(a => new PublicKey(a)) },
    }));
    const blockhash = bs58.encode(Uint8Array.from(built.blockhashWithMetadata.blockhash));
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(lookupTables);
    return new VersionedTransaction(message);
}

/**
 * Lamports a Jupiter swap transaction costs: the 5000-lamport signature fee plus the priority fee
 * (compute-unit limit x price from its budget instructions; our default price if it sets none).
 */
function swapFeeLamports(built) {
    let units = 200_000, microLamports = null;
    for (const ix of built.computeBudgetInstructions || []) {
        const data = Buffer.from(ix.data, 'base64');
        if (data[0] === 2) units = data.readUInt32LE(1);               // SetComputeUnitLimit
        if (data[0] === 3) microLamports = Number(data.readBigUInt64LE(1)); // SetComputeUnitPrice
    }
    return 5000 + Math.ceil((units * (microLamports ?? PRIORITY_MICROLAMPORTS)) / 1e6);
}

/** 1234500n, 6 -> "1.2345" */
function atomsToDecimal(atoms, decimals) {
    const s = atoms.toString().padStart(decimals + 1, '0');
    const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
}

function fitsInPacket(tx) {
    try {
        return tx.serialize().length <= 1232;
    } catch {
        return false; // serialize throws when the transaction overruns the packet size
    }
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** A signed versioned transaction must carry exactly the message we built, signed by the wallet. */
function verifyVersioned(b64, expectedMessage, walletPk) {
    let tx;
    try {
        tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    } catch {
        throw new UserError('Malformed signed transaction');
    }
    const message = Buffer.from(tx.message.serialize());
    if (!message.equals(expectedMessage)) throw new UserError('Signed transaction does not match the prepared one');
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    const index = signers.findIndex(k => k.equals(walletPk));
    const signature = index >= 0 ? tx.signatures[index] : null;
    if (!signature || signature.every(b => b === 0)) throw new UserError('Transaction is missing the wallet signature');
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, walletPk.toBuffer()]), format: 'der', type: 'spki' });
    if (!crypto.verify(null, message, key, Buffer.from(signature))) throw new UserError('Invalid signature');
    return tx;
}

function parseMint(mint) {
    try {
        return new PublicKey(mint);
    } catch {
        throw new UserError('Invalid token address');
    }
}

export class OrderService {
    constructor({ markets, store, keeperPubkey, referencePrice = null, jupiter = null, usdPrices = null }) {
        this.markets = markets;
        this.usdPrices = usdPrices; // async (mints) => { mint: usd } (to value transaction fees)
        this.jupiter = jupiter; // (pathAndQuery, { method, body }) => Promise<json>, rate limited
        this.referencePrice = referencePrice; // async (marketAddress) => price | null
        this.store = store;
        this.keeperPubkey = keeperPubkey;
        this.pending = new Map(); // prepared-but-unsigned transactions, by id
        this.quoteCache = new Map(); // Jupiter quotes, briefly, so preview + order don't double-fetch
        setInterval(() => {
            const now = Date.now();
            for (const [id, p] of this.pending) if (now - p.createdAt > PREPARE_TTL_MS) this.pending.delete(id);
        }, 30_000).unref();
    }

    /** The user rejected the request in their wallet: free what it was holding right away. */
    abandon({ id }) {
        const p = typeof id === 'string' ? this.pending.get(id) : null;
        if (p) {
            log.info('orders', 'abandoned', { wallet: short(p.wallet), kind: p.kind });
            this.pending.delete(id);
        }
        return { ok: true };
    }

    /**
     * A wallet asking for a new order while an earlier one is still unsigned: the earlier request's
     * payout account goes to the new one (people place one order at a time; the old request can no
     * longer be sent). Returns whether anything was freed.
     */
    supersedeUnsigned(wallet) {
        let freed = false;
        for (const [id, p] of this.pending) {
            if (p.wallet === wallet && (p.kind === 'order' || p.kind === 'smart')) {
                this.pending.delete(id);
                freed = true;
            }
        }
        if (freed) log.info('orders', 'superseded_unsigned', { wallet: short(wallet) });
        return freed;
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

    /** The payout-account setup on its own, built when the user agrees to it (a fresh blockhash). */
    async prepareSetup({ wallet }) {
        return this.prepareNonceSetup(parseWallet(wallet));
    }

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

    async prepareOrder({ wallet, market, side, price, size, postOnly = false, acknowledgePriceRisk = false, expiresInSeconds = null }) {
        const walletPk = parseWallet(wallet);
        if (side !== 'buy' && side !== 'sell') throw new UserError('side must be buy or sell');
        const tokenPrice = Number(price);
        if (!(tokenPrice > 0)) throw new UserError('Enter a price above zero');

        await this.checkPriceRisk(market, side, tokenPrice, acknowledgePriceRisk);

        let ctx = await this.loadContext(walletPk, market);
        if (!ctx.freeNonces.length && this.supersedeUnsigned(walletPk.toBase58())) ctx = await this.loadContext(walletPk, market);
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

        // Optional expiry: Manifest drops the order after this slot.
        let lastValidSlot = 0, expiresAt = null;
        if (expiresInSeconds != null) {
            const secs = Number(expiresInSeconds);
            if (!(secs >= 60 && secs <= MAX_EXPIRY_SECONDS)) throw new UserError('Pick an expiry between 1 minute and 30 days');
            lastValidSlot = (await connection.getSlot('confirmed')) + Math.ceil(secs / SLOT_SECONDS);
            expiresAt = Date.now() + secs * 1000;
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
            place: [{ baseAtoms, mantissa: encoded.mantissa, exponent: encoded.exponent, isBid, orderType: postOnly ? OrderType.PostOnly : OrderType.Limit, lastValidSlot }],
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
            lastValidSlot: lastValidSlot || null,
            expiresAt,
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

    /**
     * A bid far above the market (or an ask far below) is filled at the user's own price, by the
     * book or by arbitrageurs, so it needs an explicit OK (the order form warns first).
     */
    async checkPriceRisk(market, side, tokenPrice, acknowledged) {
        if (!this.referencePrice || acknowledged) return;
        const reference = await this.referencePrice(market).catch(() => null);
        const off = adverseDeviation(side, tokenPrice, reference);
        if (off != null && off > PRICE_WARN_DEVIATION) {
            const err = new UserError(`This ${side} price is ${(off * 100).toFixed(1)}% ${side === 'buy' ? 'above' : 'below'} the market price (${reference.toPrecision(6)}). Confirm the price warning to place it anyway.`);
            err.code = 'PRICE_DEVIATION';
            throw err;
        }
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
        const v = tx instanceof VersionedTransaction ? tx : new VersionedTransaction(tx.compileMessage());
        const sim = await connection.simulateTransaction(v, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
        if (sim.value.err) {
            const logs = sim.value.logs || [];
            const hint = logs.filter(l => /Error|error|insufficient|failed/.test(l)).slice(-3).join(' | ');
            log.warn('orders', 'simulation_failed', { err: sim.value.err, hint });
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
        if (pending.versioned) return signedB64.map((b64, i) => verifyVersioned(b64, pending.messages[i], walletPk));
        // A Jupiter swap (versioned) signed together with our order and payout (legacy).
        if (pending.versionFlags) {
            return signedB64.map((b64, i) => (pending.versionFlags[i]
                ? verifyVersioned(b64, pending.messages[i], walletPk)
                : this.verifyLegacy(b64, pending.messages[i], walletPk)));
        }
        return signedB64.map((b64, i) => this.verifyLegacy(b64, pending.messages[i], walletPk));
    }

    verifyLegacy(b64, expected, walletPk) {
        let tx;
        try {
            tx = Transaction.from(Buffer.from(b64, 'base64'));
        } catch {
            throw new UserError('Malformed signed transaction');
        }
        if (!tx.serializeMessage().equals(expected)) throw new UserError('Signed transaction does not match the prepared one');
        const sig = tx.signatures.find(x => x.publicKey.equals(walletPk));
        if (!sig?.signature) throw new UserError('Transaction is missing the wallet signature');
        if (!tx.verifySignatures(false)) throw new UserError('Invalid signature');
        return tx;
    }

    async send(tx, { blockhash, lastValidBlockHeight }) {
        let signature, res;
        try {
            signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
            res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        } catch (err) {
            // E.g. a transaction is only valid for ~60-90 s after it was prepared, and approving it
            // in the wallet took longer than that. Nothing happened on chain.
            const explained = explainSendError(err);
            if (explained) throw Object.assign(new UserError(explained), { cause: err });
            throw err;
        }
        if (res.value.err) throw new UserError(`Transaction failed: ${JSON.stringify(res.value.err)}`);
        return signature;
    }

    /** Send signed transactions; logs one line per outcome so problems show up in the logs. */
    async submit(body) {
        const pending = this.pending.get(body?.id);
        const started = Date.now();
        try {
            const result = await this.submitInner(body);
            // Our own transaction just changed the market: re-read it now so the book and the
            // wallet's order list are right on the next refresh, not one poll later.
            const market = pending?.order?.market || pending?.market;
            if (market) await this.markets.refresh(market).catch(() => {});
            if (pending) {
                log.info('orders', `${pending.kind}_ok`, {
                    wallet: short(pending.wallet), ...describePending(pending), order: result.orderId, sig: result.signature, ms: Date.now() - started,
                });
            }
            return result;
        } catch (err) {
            if (pending) {
                const fields = {
                    wallet: short(pending.wallet), ...describePending(pending), msg: errorDetail(err), ms: Date.now() - started,
                    ageS: pending.createdAt ? Math.round((started - pending.createdAt) / 1000) : undefined, // prepare -> signed
                };
                if (err instanceof UserError) log.warn('orders', `${pending.kind}_failed`, fields);
                else log.error('orders', `${pending.kind}_failed`, fields);
            }
            throw err;
        }
    }

    async submitInner({ id, signed }) {
        const pending = this.pending.get(id);
        if (!pending) throw new UserError('This request has expired or was already sent, so nothing more was sent. Please refresh and try again if needed.');
        const txs = this.verifySigned(pending, signed);
        this.pending.delete(id);

        if (pending.kind === 'setup') {
            const signature = await this.send(txs[0], pending);
            pending.nonceAddresses.forEach(a => this.store.addNonce(a, pending.wallet));
            return { ok: true, signature };
        }

        if (pending.kind === 'swap') {
            const signature = await this.send(txs[0], pending);
            return { ok: true, signature, ...pending.result };
        }

        if (pending.kind === 'createMarket') {
            const signature = await this.send(txs[0], pending);
            await this.markets.refresh(pending.market);
            return { ok: true, signature, market: pending.market };
        }

        if (pending.kind === 'closePayout') {
            const busy = this.store.noncesInUse(pending.wallet);
            if (pending.nonceAddresses.some(a => busy.has(a))) throw new UserError('An order started using these payout accounts, please try the refund again.');
            const signature = await this.send(txs[0], pending);
            pending.nonceAddresses.forEach(a => this.store.removeNonce(a));
            return { ok: true, signature, refundedSol: pending.refundLamports / 1e9 };
        }

        if (pending.kind === 'cancelAll') {
            const signature = await this.send(txs[0], pending);
            for (const orderId of pending.orderIds) this.store.update(orderId, { status: 'cancelled', cancelSignature: signature });
            return { ok: true, signature, cancelled: pending.orderIds.length };
        }

        if (pending.kind === 'cancel' || pending.kind === 'withdraw') {
            const signature = await this.send(txs[0], pending);
            if (pending.orderId) this.store.update(pending.orderId, { status: 'cancelled', cancelSignature: signature });
            return { ok: true, signature };
        }

        if (pending.kind === 'smart') {
            // The instant part first: if Jupiter's swap fails (the price moved), nothing else is sent.
            const [swapTx, ...orderTxs] = txs;
            let swapSignature;
            try {
                swapSignature = await this.send(swapTx, pending.swap);
            } catch (err) {
                throw new UserError(`The instant fill didn't go through (${err.message.slice(0, 100)}), so nothing was placed. Please try again.`);
            }
            const filledNow = { swapSignature, swap: pending.swap.result };
            if (!pending.order) return { ok: true, signature: swapSignature, ...filledNow };
            try {
                const placed = await this.submitOrderTxs(pending, orderTxs);
                return { ...placed, ...filledNow, restingSize: Number(pending.order.baseAtoms) / 10 ** pending.order.baseDecimals };
            } catch (err) {
                // The instant part already happened: report it, and that the rest wasn't placed.
                log.warn('orders', 'smart_rest_failed', { wallet: short(pending.wallet), msg: errorDetail(err) });
                return { ok: true, signature: swapSignature, ...filledNow, restFailed: err.message };
            }
        }

        return this.submitOrderTxs(pending, txs);
    }

    /** Send an order's place transaction (its pre-signed payout was recorded first). */
    async submitOrderTxs(pending, txs) {
        // Record the claim before sending so a crash can never lose it.
        if (!this.store.noncesFor(pending.wallet).includes(pending.order.nonce)) {
            throw new UserError('Your payout accounts were refunded, please place the order again.');
        }
        const [place, claim] = txs;
        // An edit replaces an order: keep the keeper off the old one while the swap lands.
        const replaced = pending.replaces ? this.store.get(pending.replaces) : null;
        if (replaced) {
            if (replaced.status !== 'open') throw new UserError(`The original order is ${replaced.status} now; nothing was changed.`);
            this.store.update(replaced.id, { status: 'replacing' });
        }
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
            if (replaced) this.store.update(replaced.id, { status: 'open' });
            throw err;
        }
        if (replaced) this.store.update(replaced.id, { status: 'cancelled', replacedBy: order.id, cancelSignature: signature });
        if (pending.replenishNonce) this.store.addNonce(pending.replenishNonce, pending.wallet);

        // The place transaction holds exactly one batch update placing one order. If the RPC can't
        // produce it yet, the keeper fills the sequence number in later (until then it won't pay out).
        const placed = await placedSequenceNumber(signature);
        const sequenceNumber = placed?.sequenceNumber ?? null;
        if (!sequenceNumber) log.warn('orders', 'no_sequence_number_yet', { order: order.id, sig: signature, note: 'keeper will look it up' });
        this.store.update(order.id, {
            status: 'open',
            placeSignature: signature,
            placeSlot: placed?.slot ?? null,
            sequenceNumber,
        });
        this.onPlaced?.(order.id);
        return { ok: true, signature, orderId: order.id, sequenceNumber };
    }

    // ---------- limit orders that take Jupiter's better price first ----------

    /**
     * A limit order whose price Jupiter can beat right now: take what Jupiter can fill at an
     * average at or better than the limit (guaranteed by the swap's minimum output), then rest the
     * remainder on Manifest at the limit. One approval signs the swap, the order and its payout.
     * Falls back to a plain limit order when Jupiter can't help.
     */
    async prepareSmartLimit(params) {
        const { wallet, market, side, price, size, acknowledgePriceRisk = false, expiresInSeconds = null } = params;
        const walletPk = parseWallet(wallet);
        const limit = Number(price);
        if (!(limit > 0)) throw new UserError('Enter a price above zero');
        if (!this.jupiter) return this.prepareOrder(params);
        // A wallet without free payout accounts needs the setup first: say so before any Jupiter calls.
        const hasFree = () => {
            const spoken = this.noncesSpokenFor(walletPk.toBase58());
            return this.store.noncesFor(walletPk.toBase58()).some(a => !spoken.has(a));
        };
        if (!hasFree() && !(this.supersedeUnsigned(walletPk.toBase58()) && hasFree())) return this.prepareNonceSetup(walletPk);
        const s = this.markets.summary(market);
        if (!s) throw new UserError('Unknown market');
        await this.checkPriceRisk(market, side, limit, acknowledgePriceRisk);

        // Only worth the Jupiter calls when the limit is through the market price.
        const reference = this.referencePrice ? await this.referencePrice(market).catch(() => null) : null;
        const crosses = reference && (side === 'buy' ? limit >= reference * 0.999 : limit <= reference * 1.001);
        if (!crosses) return this.prepareOrder({ ...params, acknowledgePriceRisk: true });

        const sizeAtoms = toAtoms(size, s.baseDecimals);
        // The swap transaction's network + priority fee counts against Jupiter's price, valued in the
        // quote token: a bid only goes to Jupiter if it still beats the limit after that fee.
        const prices = this.usdPrices ? await this.usdPrices([NATIVE_MINT.toBase58(), s.quoteMint]).catch(() => ({})) : {};
        const solInQuote = isNativeMint(s.quoteMint) ? 1 : (prices[NATIVE_MINT.toBase58()] > 0 && prices[s.quoteMint] > 0 ? prices[NATIVE_MINT.toBase58()] / prices[s.quoteMint] : null);
        if (solInQuote == null) return this.prepareOrder({ ...params, acknowledgePriceRisk: true }); // can't value the fee: don't risk it
        const take = await this.findJupiterTake({ side, limit, sizeAtoms, s, taker: walletPk.toBase58(), solInQuote }).catch((err) => {
            log.warn('orders', 'smart_take_failed', { market: short(market), msg: err.message });
            return null;
        });
        if (!take) return this.prepareOrder({ ...params, acknowledgePriceRisk: true });

        // Enough in the wallet for both parts?
        const isBuy = side === 'buy';
        const remainder = sizeAtoms > take.baseAtoms ? sizeAtoms - take.baseAtoms : 0n;
        const restAtoms = remainder * 200n > sizeAtoms ? remainder : 0n; // skip a dust remainder (<0.5%)
        const spendMint = isBuy ? s.quoteMint : s.baseMint;
        const spendProgram = (await connection.getAccountInfo(new PublicKey(spendMint), 'confirmed'))?.owner;
        const lamports = await connection.getBalance(walletPk, 'confirmed');
        const have = await this.tokenBalanceAtoms(walletPk, spendMint, spendProgram, lamports);
        const restLock = isBuy ? BigInt(Math.ceil(Number(restAtoms) * limit * 10 ** (s.quoteDecimals - s.baseDecimals))) : restAtoms;
        const reserve = isNativeMint(spendMint) ? 20_000_000n : 0n;
        if (take.inAtoms + restLock + reserve > have) throw new UserError('Insufficient balance for this order.');

        const swapTx = buildJupiterTransaction(take.quote, walletPk);
        if (!fitsInPacket(swapTx)) return this.prepareOrder({ ...params, acknowledgePriceRisk: true });
        await this.simulateOrThrow(swapTx);
        const swapResult = {
            inAmount: Number(take.inAtoms) / 10 ** (isBuy ? s.quoteDecimals : s.baseDecimals),
            outAmount: Number(take.outAtoms) / 10 ** (isBuy ? s.baseDecimals : s.quoteDecimals),
        };
        swapResult.price = isBuy ? swapResult.inAmount / swapResult.outAmount : swapResult.outAmount / swapResult.inAmount;
        // Including the transaction fee, as the limit check does.
        swapResult.allInPrice = isBuy
            ? (swapResult.inAmount + take.feeQuote) / swapResult.outAmount
            : (swapResult.outAmount - take.feeQuote) / swapResult.inAmount;
        const swapPart = {
            message: Buffer.from(swapTx.message.serialize()),
            b64: Buffer.from(swapTx.serialize()).toString('base64'),
            blockhash: swapTx.message.recentBlockhash,
            lastValidBlockHeight: take.quote.blockhashWithMetadata.lastValidBlockHeight,
            result: swapResult,
        };

        let orderPrepared = null, orderPending = null;
        if (restAtoms > 0n) {
            orderPrepared = await this.prepareOrder({
                wallet, market, side, price, size: atomsToDecimal(restAtoms, s.baseDecimals), acknowledgePriceRisk: true, expiresInSeconds,
            });
            if (orderPrepared.step === 'setup') return orderPrepared; // payout accounts first, then re-prepare
            orderPending = this.pending.get(orderPrepared.id);
            this.pending.delete(orderPrepared.id);
        }

        const id = crypto.randomUUID();
        this.pending.set(id, {
            kind: 'smart', wallet: walletPk.toBase58(), market, createdAt: Date.now(),
            messages: [swapPart.message, ...(orderPending?.messages || [])],
            versionFlags: [true, ...(orderPending?.messages || []).map(() => false)],
            swap: { blockhash: swapPart.blockhash, lastValidBlockHeight: swapPart.lastValidBlockHeight, result: swapResult },
            order: orderPending?.order || null,
            blockhash: orderPending?.blockhash, lastValidBlockHeight: orderPending?.lastValidBlockHeight,
            replenishNonce: orderPending?.replenishNonce || null,
        });
        return {
            step: 'sign',
            id,
            versionFlags: [true, ...(orderPrepared?.transactions || []).map(() => false)],
            transactions: [swapPart.b64, ...(orderPrepared?.transactions || [])],
            summary: {
                title: 'Limit order',
                now: swapResult,
                restSize: Number(restAtoms) / 10 ** s.baseDecimals,
                limit,
                networkFee: take.feeQuote,
                venues: [...new Set((take.quote.routePlan || []).map(r => r.swapInfo?.label).filter(Boolean))],
            },
        };
    }

    /**
     * How much of a limit order Jupiter can fill right now at an average at or better than the
     * limit, as a ready-to-build quote whose minimum output enforces that average. Null if none.
     */
    async findJupiterTake({ side, limit, sizeAtoms, s, taker, solInQuote }) {
        const isBuy = side === 'buy';
        const inMint = isBuy ? s.quoteMint : s.baseMint, outMint = isBuy ? s.baseMint : s.quoteMint;
        const scale = 10 ** (s.quoteDecimals - s.baseDecimals); // quote atoms per base atom at price 1
        const build = (amount, slippageBps = 50) => this.jupiter(
            `/swap/v2/build?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}&taker=${taker}&maxAccounts=40`);
        // Jupiter's quoted output is already net of every venue's trading fee (and Jupiter adds
        // none); what's left to count is this transaction's network + priority fee, in quote atoms.
        const feeQuoteAtoms = (q) => (swapFeeLamports(q) / 1e9) * solInQuote * 10 ** s.quoteDecimals;
        // The fewest output atoms that keep the all-in average at or better than the limit.
        const limitMinOut = (inAtoms, q) => (isBuy
            ? Math.ceil((inAtoms + feeQuoteAtoms(q)) / (limit * scale)) // (spent + fee) / got <= limit
            : Math.ceil(inAtoms * limit * scale + feeQuoteAtoms(q)));  // (got - fee) / sold >= limit
        const S = Number(sizeAtoms);
        const tryIn = async (inAtoms) => {
            const q = await build(Math.floor(inAtoms));
            const out = Number(q.outAmount);
            return { inAtoms: Math.floor(inAtoms), out, q, ok: out >= limitMinOut(inAtoms, q) };
        };

        let best = null;
        if (!isBuy) {
            // Sell: spend base; try all of it, else bisect.
            const full = await tryIn(S);
            if (full.ok) best = full;
            else {
                let lo = 0, hi = S;
                for (let i = 0; i < 3; i++) {
                    const mid = (lo + hi) / 2;
                    const r = await tryIn(mid);
                    if (r.ok) { best = r; lo = mid; } else hi = mid;
                }
            }
        } else {
            // Buy: spend quote. Size the spend to come out at about S base, then check the average.
            const budget = Math.ceil(S * limit * scale);
            const probe = await tryIn(budget);
            if (probe.out >= S) {
                const r = await tryIn(budget * (S / probe.out) * 1.0005);
                if (r.ok) best = r;
            }
            if (!best) {
                let lo = 0, hi = probe.out >= S ? budget * (S / probe.out) : budget;
                for (let i = 0; i < 3; i++) {
                    const mid = (lo + hi) / 2;
                    const r = await tryIn(mid);
                    if (r.ok) { best = r; lo = mid; } else hi = mid;
                }
            }
        }
        const baseOf = (r) => (isBuy ? r.out : r.inAtoms);
        if (!best || baseOf(best) < S * 0.01) return null;

        // Final build with a slippage that guarantees the all-in limit average (or 0.5%, if tighter).
        const minOut = limitMinOut(best.inAtoms, best.q);
        const slippageBps = Math.max(1, Math.min(50, Math.floor((1 - minOut / best.out) * 10_000)));
        const quote = await build(best.inAtoms, slippageBps);
        if (Number(quote.otherAmountThreshold) < limitMinOut(best.inAtoms, quote)) return null; // price moved against us meanwhile
        return {
            quote,
            feeQuote: feeQuoteAtoms(quote) / 10 ** s.quoteDecimals,
            inAtoms: BigInt(best.inAtoms),
            outAtoms: BigInt(quote.outAmount),
            baseAtoms: BigInt(isBuy ? quote.outAmount : best.inAtoms),
        };
    }

    // ---------- market orders (Jupiter) ----------

    /**
     * Price a market order through Jupiter, which routes across every Solana venue (Manifest,
     * Archer, AMMs) for the best price. Buys spend `amount` quote tokens; sells sell `amount`
     * base tokens.
     */
    async quoteSwap({ market, side, amount, slippageBps = 50, wallet = null, maxAccounts = null }) {
        if (!this.jupiter) throw new UserError('Market orders are unavailable');
        if (side !== 'buy' && side !== 'sell') throw new UserError('side must be buy or sell');
        const s = this.markets.summary(market);
        if (!s) throw new UserError('Unknown market');
        const slippage = Math.round(Number(slippageBps));
        if (!(slippage >= 1 && slippage <= MAX_SLIPPAGE_BPS)) throw new UserError(`Slippage must be between 0.01% and ${MAX_SLIPPAGE_BPS / 100}%`);
        const isBuy = side === 'buy';
        const [inMint, outMint, inDecimals, outDecimals] = isBuy
            ? [s.quoteMint, s.baseMint, s.quoteDecimals, s.baseDecimals]
            : [s.baseMint, s.quoteMint, s.baseDecimals, s.quoteDecimals];
        const inAtoms = toAtoms(amount, inDecimals);
        if (inAtoms <= 0n) throw new UserError('Enter an amount');

        // Swap API v2 /build quotes and returns the instructions in one call. It needs a taker;
        // without a wallet (just previewing) the keeper's address stands in: same route and amounts.
        const taker = wallet ? parseWallet(wallet).toBase58() : this.keeperPubkey.toBase58();
        const key = `${inMint}|${outMint}|${inAtoms}|${slippage}|${taker}|${maxAccounts}`;
        const cached = this.quoteCache.get(key);
        let quote = cached && Date.now() - cached.at < QUOTE_CACHE_MS ? cached.quote : null;
        if (!quote) {
            try {
                quote = await this.jupiter(`/swap/v2/build?inputMint=${inMint}&outputMint=${outMint}&amount=${inAtoms}&slippageBps=${slippage}&taker=${taker}${maxAccounts ? `&maxAccounts=${maxAccounts}` : ''}`);
            } catch (err) {
                if (err.status === 400 || err.status === 404) throw new UserError('No route found for this trade on any Solana venue.');
                throw err;
            }
            this.quoteCache.set(key, { at: Date.now(), quote });
            for (const [k, v] of this.quoteCache) if (Date.now() - v.at > QUOTE_CACHE_MS) this.quoteCache.delete(k);
        }

        const inUi = Number(quote.inAmount) / 10 ** inDecimals;
        const outUi = Number(quote.outAmount) / 10 ** outDecimals;
        const minOutUi = Number(quote.otherAmountThreshold) / 10 ** outDecimals;
        const baseUi = isBuy ? outUi : inUi, quoteUi = isBuy ? inUi : outUi;
        const price = baseUi > 0 ? quoteUi / baseUi : null;
        // Worst price the slippage limit allows, in quote per base.
        const worstPrice = isBuy ? (minOutUi > 0 ? inUi / minOutUi : null) : (inUi > 0 ? minOutUi / inUi : null);
        const reference = this.referencePrice ? await this.referencePrice(market).catch(() => null) : null;
        const venues = [...new Set((quote.routePlan || []).map(r => r.swapInfo?.label).filter(Boolean))];
        return {
            quote,
            summary: {
                side, inAmount: inUi, outAmount: outUi, minOut: minOutUi, price, worstPrice,
                priceImpact: Number(quote.priceImpactPct) || 0,
                reference, deviation: adverseDeviation(side, worstPrice, reference),
                venues, slippageBps: slippage,
            },
        };
    }

    async prepareSwap({ wallet, market, side, amount, slippageBps, acknowledgePriceRisk = false }) {
        const walletPk = parseWallet(wallet);
        // Long multi-hop routes can come out bigger than a transaction allows; then ask again for a
        // route that touches fewer accounts (usually a hair worse price, shown before signing).
        let quote, summary, tx;
        for (const maxAccounts of [null, 40, 28]) {
            ({ quote, summary } = await this.quoteSwap({ market, side, amount, slippageBps, wallet: walletPk.toBase58(), maxAccounts }));
            tx = buildJupiterTransaction(quote, walletPk);
            if (fitsInPacket(tx)) break;
            log.info('orders', 'swap_route_too_big', { maxAccounts, hops: quote.routePlan?.length });
            tx = null;
        }
        if (!tx) throw new UserError('Could not fit this trade in one transaction. Try a smaller amount.');
        // Judge the WORST price the order allows (slippage included), not the hoped-for one.
        const off = Math.max(summary.deviation ?? -1, summary.priceImpact);
        if (!acknowledgePriceRisk && off > PRICE_WARN_DEVIATION) {
            const err = new UserError(`This market order could fill up to ${(off * 100).toFixed(1)}% worse than the market price. Confirm the price warning to place it anyway.`);
            err.code = 'PRICE_DEVIATION';
            throw err;
        }
        await this.simulateOrThrow(tx);
        const id = crypto.randomUUID();
        this.pending.set(id, {
            kind: 'swap', versioned: true, wallet: walletPk.toBase58(), createdAt: Date.now(),
            messages: [Buffer.from(tx.message.serialize())],
            blockhash: tx.message.recentBlockhash, lastValidBlockHeight: quote.blockhashWithMetadata.lastValidBlockHeight,
            result: { inAmount: summary.inAmount, outAmount: summary.outAmount, price: summary.price },
        });
        return {
            step: 'sign',
            id,
            versioned: true,
            transactions: [Buffer.from(tx.serialize()).toString('base64')],
            summary: { title: `Market ${side}`, ...summary },
        };
    }

    // ---------- new markets ----------

    /**
     * Create a Manifest market for base/quote, paid for by the wallet. Manifest markets are
     * permissionless; the market account's keypair is generated here and signs before the wallet.
     */
    async prepareCreateMarket({ wallet, baseMint, quoteMint }) {
        const walletPk = parseWallet(wallet);
        const base = parseMint(baseMint), quote = parseMint(quoteMint);
        if (base.equals(quote)) throw new UserError('Pick two different tokens');
        const existing = this.markets.marketsForPair(base.toBase58(), quote.toBase58()).find(m => m.baseMint === base.toBase58());
        if (existing) return { step: 'exists', market: existing.address };

        const [baseInfo, quoteInfo, walletInfo] = await connection.getMultipleAccountsInfo([base, quote, walletPk], 'confirmed');
        for (const info of [baseInfo, quoteInfo]) {
            if (!info || !(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) {
                throw new UserError('That address is not a token mint');
            }
        }
        const { ixs, signers } = await Market.setupIxs(connection, base, quote, walletPk);
        const marketKeypair = signers[0];
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({ feePayer: walletPk, blockhash, lastValidBlockHeight });
        tx.add(...priorityIxs(CREATE_MARKET_CU), ...ixs);
        tx.partialSign(marketKeypair);

        // Exact cost (rent for the market and its two vaults, plus fees) from the simulation.
        const sim = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
            sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
            accounts: { encoding: 'base64', addresses: [walletPk.toBase58()] },
        });
        if (sim.value.err) {
            const hint = (sim.value.logs || []).filter(l => /Error|error|insufficient|failed/.test(l)).slice(-3).join(' | ');
            log.warn('orders', 'create_market_simulation_failed', { err: sim.value.err, hint });
            throw new UserError(walletInfo && walletInfo.lamports < 10_000_000
                ? 'Not enough SOL in your wallet to create a market.'
                : `Creating the market would fail on-chain: ${hint || JSON.stringify(sim.value.err)}`);
        }
        const costLamports = (walletInfo?.lamports ?? 0) - (sim.value.accounts?.[0]?.lamports ?? walletInfo?.lamports ?? 0);

        const id = crypto.randomUUID();
        const market = marketKeypair.publicKey.toBase58();
        this.pending.set(id, {
            kind: 'createMarket', wallet: walletPk.toBase58(), createdAt: Date.now(),
            messages: [tx.serializeMessage()], blockhash, lastValidBlockHeight, market,
        });
        return {
            step: 'sign',
            id,
            market,
            transactions: [tx.serialize({ requireAllSignatures: false }).toString('base64')],
            summary: { title: 'Create market', detail: 'Creates a new Manifest market.', costSol: costLamports / 1e9 },
        };
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
        if (order.status !== 'open' && order.status !== 'expired') throw new UserError(`Order is ${order.status}`);
        const ctx = await this.loadContext(walletPk, order.market);
        // Expired orders are hidden by the SDK but still hold funds until cancelled.
        const onBook = order.sequenceNumber && this.markets.allOrders(order.market)
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
        this.pending.set(id, { kind: 'cancel', orderId, market: order.market, wallet: walletPk.toBase58(), createdAt: Date.now(), messages: [tx.serializeMessage()], blockhash, lastValidBlockHeight });
        return { step: 'sign', id, transactions: [tx.serialize({ requireAllSignatures: false }).toString('base64')], summary: { title: 'Cancel order', detail: 'Cancels the order and returns its funds to your wallet.' } };
    }

    /**
     * Change an open order's price and/or size in ONE transaction: cancel it, place the new one,
     * return the old order's partial-fill proceeds and any surplus to the wallet, and sign a new
     * payout. The old payout is voided by advancing its nonce.
     */
    async prepareEdit({ wallet, orderId, price, size, acknowledgePriceRisk = false }) {
        const walletPk = parseWallet(wallet);
        const old = this.store.get(orderId);
        if (!old || old.wallet !== walletPk.toBase58()) throw new UserError('Order not found');
        if (old.status !== 'open') throw new UserError(`Order is ${old.status}`);
        const tokenPrice = Number(price);
        if (!(tokenPrice > 0)) throw new UserError('Enter a price above zero');
        await this.checkPriceRisk(old.market, old.side, tokenPrice, acknowledgePriceRisk);

        let ctx = await this.loadContext(walletPk, old.market);
        if (!ctx.freeNonces.some(n => n.address !== old.nonce) && this.supersedeUnsigned(walletPk.toBase58())) ctx = await this.loadContext(walletPk, old.market);
        const resting = this.markets.allOrders(old.market).find(o => o.sequenceNumber.toString() === old.sequenceNumber);
        if (!resting) throw new UserError('This order has already filled or left the book.');
        if (old.lastValidSlot && this.markets.slot > old.lastValidSlot) throw new UserError('This order has expired; withdraw it instead.');
        const nonce = ctx.freeNonces.find(n => n.address !== old.nonce);
        if (!nonce) throw new UserError('No spare payout account for the edited order. Cancel it and place a new one.');

        const isBid = old.isBid;
        const baseAtoms = toAtoms(size, ctx.baseDecimals);
        if (baseAtoms <= 0n) throw new UserError('Order size is too small');
        let encoded;
        try {
            encoded = encodePrice(tokenPrice, ctx.baseDecimals, ctx.quoteDecimals);
        } catch (err) {
            throw new UserError(err.message);
        }
        const econ = orderEconomics({ isBid, baseAtoms, mantissa: encoded.mantissa, exponent: encoded.exponent });
        const lockIsBase = econ.lockMint === 'base';
        const lockMint = lockIsBase ? ctx.baseMint : ctx.quoteMint;
        const lockProgram = lockIsBase ? ctx.baseTokenProgram : ctx.quoteTokenProgram;
        const proceedsMint = lockIsBase ? ctx.quoteMint : ctx.baseMint;
        const proceedsProgram = lockIsBase ? ctx.quoteTokenProgram : ctx.baseTokenProgram;

        // What the cancel releases, and the old order's own proceeds from partial fills.
        const remaining = BigInt(resting.numBaseAtoms.toString());
        const oldLock = isBid ? quoteForBase(old.mantissa, old.exponent, remaining, true) : remaining;
        const filled = BigInt(old.baseAtoms) - remaining;
        const oldProceeds = filled > 0n ? (isBid ? filled : quoteForBase(old.mantissa, old.exponent, filled, false)) : 0n;
        // Free funds already in the seat, minus what other orders' payouts are counting on.
        const seat = ctx.market.hasSeat(walletPk);
        const freeLock = seat ? BigInt(ctx.market.getWithdrawableBalanceAtoms(walletPk, lockIsBase).toString()) : 0n;
        const reserved = claimReservations(this.store, walletPk.toBase58(), old.market, ctx.market, old.id);
        const reservedLock = lockIsBase ? reserved.base : reserved.quote;
        const available = (freeLock > reservedLock ? freeLock - reservedLock : 0n) + oldLock;
        const depositAtoms = econ.lockAtoms > available ? econ.lockAtoms - available : 0n;
        const surplus = available > econ.lockAtoms ? available - econ.lockAtoms : 0n;

        if (depositAtoms > 0n) {
            const walletBalance = await this.tokenBalanceAtoms(walletPk, lockMint, lockProgram, ctx.lamports);
            const solReserve = isNativeMint(lockMint) ? 10_000_000n : 0n;
            if (depositAtoms + solReserve > walletBalance) {
                throw new UserError(`Insufficient balance: the bigger order needs ${formatAtoms(depositAtoms, lockIsBase ? ctx.baseDecimals : ctx.quoteDecimals)} more ${isNativeMint(lockMint) ? 'SOL (plus ~0.01 for fees)' : 'tokens'}.`);
            }
        }

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({ feePayer: walletPk, blockhash, lastValidBlockHeight });
        tx.add(...priorityIxs(PLACE_CU));
        tx.add(ataIx({ payer: walletPk, owner: walletPk, mint: ctx.baseMint, tokenProgram: ctx.baseTokenProgram }));
        tx.add(ataIx({ payer: walletPk, owner: walletPk, mint: ctx.quoteMint, tokenProgram: ctx.quoteTokenProgram }));
        // Voids the old order's pre-signed payout.
        tx.add(SystemProgram.nonceAdvance({ noncePubkey: new PublicKey(old.nonce), authorizedPubkey: walletPk }));
        if (isNativeMint(lockMint) && depositAtoms > 0n) tx.add(...wrapSolIxs({ owner: walletPk, lamports: depositAtoms }));
        if (depositAtoms > 0n) tx.add(depositIx({ trader: walletPk, market: old.market, mint: lockMint, tokenProgram: lockProgram, amountAtoms: depositAtoms }));
        tx.add(batchUpdateIx({
            trader: walletPk, market: old.market,
            baseMint: ctx.baseMint, quoteMint: ctx.quoteMint,
            baseTokenProgram: ctx.baseTokenProgram, quoteTokenProgram: ctx.quoteTokenProgram,
            globals: ctx.globals,
            cancel: [old.sequenceNumber],
            place: [{ baseAtoms, mantissa: encoded.mantissa, exponent: encoded.exponent, isBid, orderType: old.postOnly ? OrderType.PostOnly : OrderType.Limit, lastValidSlot: old.lastValidSlot || 0 }],
        }));
        if (surplus > 0n) tx.add(withdrawIx({ trader: walletPk, market: old.market, mint: lockMint, tokenProgram: lockProgram, amountAtoms: surplus }));
        if (oldProceeds > 0n) tx.add(withdrawIx({ trader: walletPk, market: old.market, mint: proceedsMint, tokenProgram: proceedsProgram, amountAtoms: oldProceeds }));
        if (isNativeMint(ctx.baseMint) || isNativeMint(ctx.quoteMint)) tx.add(unwrapSolIx({ owner: walletPk }));
        await this.simulateOrThrow(tx);

        const claim = this.buildClaim({ walletPk, nonce, market: old.market, proceedsMint, proceedsProgram, claimAtoms: econ.claimAtoms });
        const id = crypto.randomUUID();
        const order = {
            ...Object.fromEntries(Object.entries(old).filter(([k]) => ['wallet', 'venue', 'market', 'baseMint', 'quoteMint', 'baseDecimals', 'quoteDecimals', 'side', 'isBid', 'postOnly', 'lastValidSlot', 'expiresAt'].includes(k))),
            id,
            price: encoded.effectiveTokenPrice,
            baseAtoms: baseAtoms.toString(),
            mantissa: encoded.mantissa,
            exponent: encoded.exponent,
            lockMint,
            lockAtoms: econ.lockAtoms.toString(),
            proceedsMint,
            proceedsIsBase: !lockIsBase,
            claimAtoms: econ.claimAtoms.toString(),
            nonce: nonce.address,
            replaces: old.id,
        };
        this.pending.set(id, {
            kind: 'order', wallet: order.wallet, createdAt: Date.now(), order, replaces: old.id,
            messages: [tx.serializeMessage(), claim.serializeMessage()],
            blockhash, lastValidBlockHeight, replenishNonce: null,
        });
        return {
            step: 'sign',
            id,
            transactions: [tx, claim].map(t => t.serialize({ requireAllSignatures: false }).toString('base64')),
            summary: { title: 'Edit order', detail: 'Replaces the order and its automatic payout in one approval.' },
        };
    }

    /** Cancel the wallet's open (and expired) orders on a market and withdraw everything. */
    async prepareCancelAll({ wallet, market }) {
        const walletPk = parseWallet(wallet);
        const all = this.store.forWallet(walletPk.toBase58())
            .filter(o => o.market === market && (o.status === 'open' || o.status === 'expired'));
        if (!all.length) throw new UserError('No open orders on this market');
        const batch = all.slice(0, CANCEL_ALL_MAX); // transaction size limit; the rest on a second click
        const ctx = await this.loadContext(walletPk, market);
        const onBook = new Set(this.markets.allOrders(market).map(o => o.sequenceNumber.toString()));
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({ feePayer: walletPk, blockhash, lastValidBlockHeight });
        tx.add(...priorityIxs(CANCEL_CU + 25_000 * batch.length));
        for (const o of batch) tx.add(SystemProgram.nonceAdvance({ noncePubkey: new PublicKey(o.nonce), authorizedPubkey: walletPk }));
        const seqs = batch.map(o => o.sequenceNumber).filter(seq => seq && onBook.has(seq));
        if (seqs.length) {
            tx.add(batchUpdateIx({
                trader: walletPk, market, baseMint: ctx.baseMint, quoteMint: ctx.quoteMint,
                baseTokenProgram: ctx.baseTokenProgram, quoteTokenProgram: ctx.quoteTokenProgram,
                globals: ctx.globals, cancel: seqs,
            }));
        }
        await this.appendWithdrawAll(tx, walletPk, ctx, { excludeOrderId: new Set(batch.map(o => o.id)) });
        const id = crypto.randomUUID();
        this.pending.set(id, {
            kind: 'cancelAll', orderIds: batch.map(o => o.id), market, wallet: walletPk.toBase58(), createdAt: Date.now(),
            messages: [tx.serializeMessage()], blockhash, lastValidBlockHeight,
        });
        return {
            step: 'sign', id,
            transactions: [tx.serialize({ requireAllSignatures: false }).toString('base64')],
            remaining: all.length - batch.length,
            summary: { title: `Cancel ${batch.length} order${batch.length === 1 ? '' : 's'}`, detail: 'Cancels them and returns their funds to your wallet.' },
        };
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
        this.pending.set(id, { kind: 'withdraw', market, wallet: walletPk.toBase58(), createdAt: Date.now(), messages: [tx.serializeMessage()], blockhash, lastValidBlockHeight });
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
        const reserved = claimReservations(this.store, walletPk.toBase58(), ctx.marketAddress, market, excludeOrderId);
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

function formatAtoms(atoms, decimals) {
    return (Number(atoms) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: Math.min(decimals, 9) });
}
