// Manifest core-program instruction builders and the exact price/size math they depend on.
// Talks to the core program directly (as market makers do) rather than the reference wrapper,
// so users need no extra wrapper account.
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    createSyncNativeInstruction,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
    OrderType,
    createBatchUpdateInstruction,
    createClaimSeatInstruction,
    getGlobalAddress,
    getGlobalVaultAddress,
    toMantissaAndExponent,
} from '@bonasa-tech/manifest-sdk';
import { MANIFEST_PROGRAM_ID } from './markets.js';

export { OrderType };

// Leave a few atoms behind on sell-side claims so rounding across many partial fills can never
// make a pre-signed claim ask for more than the seat holds. Worth far less than a cent.
const SELL_CLAIM_SLACK_ATOMS = 10n;

export function vaultAddress(market, mint) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('vault'), new PublicKey(market).toBuffer(), new PublicKey(mint).toBuffer()],
        MANIFEST_PROGRAM_ID,
    )[0];
}

/**
 * Encode a token price (quote tokens per base token) the way Manifest stores it:
 * quote atoms per base atom = mantissa * 10^exponent. Exponents below -18 lose precision
 * on-chain (prices are 18-decimal fixed point), so they are rejected.
 */
export function encodePrice(tokenPrice, baseDecimals, quoteDecimals) {
    if (!(tokenPrice > 0) || !isFinite(tokenPrice)) throw new Error('Price must be a positive number');
    const atomPrice = tokenPrice * 10 ** (quoteDecimals - baseDecimals);
    const { priceMantissa, priceExponent } = toMantissaAndExponent(atomPrice, 8);
    if (priceExponent < -18) throw new Error('Price is too small for this market');
    if (priceMantissa <= 0) throw new Error('Price rounds to zero for this market');
    return {
        mantissa: priceMantissa,
        exponent: priceExponent,
        // The price that will actually rest on the book, back in token units.
        effectiveTokenPrice: priceMantissa * 10 ** priceExponent * 10 ** (baseDecimals - quoteDecimals),
    };
}

/** Exact quote atoms for `baseAtoms` at mantissa*10^exponent, matching the program's rounding. */
export function quoteForBase(mantissa, exponent, baseAtoms, roundUp) {
    const num = BigInt(mantissa) * BigInt(baseAtoms);
    if (exponent >= 0) return num * 10n ** BigInt(exponent);
    const den = 10n ** BigInt(-exponent);
    const q = num / den;
    return roundUp && q * den !== num ? q + 1n : q;
}

/**
 * Funds an order locks, and the minimum its owner is credited once it has fully filled.
 *  - sell (ask): locks base; fully filled it yields >= floor(base * price) quote
 *  - buy (bid): locks ceil(base * price) quote; fully filled it yields exactly `base` base
 */
export function orderEconomics({ isBid, baseAtoms, mantissa, exponent }) {
    if (isBid) {
        return {
            lockMint: 'quote',
            lockAtoms: quoteForBase(mantissa, exponent, baseAtoms, true),
            proceedsMint: 'base',
            claimAtoms: BigInt(baseAtoms),
        };
    }
    const proceeds = quoteForBase(mantissa, exponent, baseAtoms, false);
    return {
        lockMint: 'base',
        lockAtoms: BigInt(baseAtoms),
        proceedsMint: 'quote',
        claimAtoms: proceeds > SELL_CLAIM_SLACK_ATOMS * 2n ? proceeds - SELL_CLAIM_SLACK_ATOMS : proceeds,
    };
}

// ---------- instructions ----------

export function claimSeatIx({ trader, market }) {
    return createClaimSeatInstruction({ payer: new PublicKey(trader), market: new PublicKey(market) });
}

// Deposit and Withdraw are encoded by hand: the SDK's core builders append a second
// traderIndexHint byte, which the program's strict Borsh parsing rejects (BorshIoError).
// Layout (programs/manifest/src/program/processor/{deposit,withdraw}.rs):
//   tag u8 | amount_atoms u64 | trader_index_hint Option<u32> (always None here)
const DEPOSIT_TAG = 2;
const WITHDRAW_TAG = 3;

function tokenMoveIx(tag, { trader, market, mint, tokenProgram, amountAtoms }) {
    const owner = new PublicKey(trader);
    const mintPk = new PublicKey(mint);
    const data = Buffer.alloc(10);
    data.writeUInt8(tag, 0);
    data.writeBigUInt64LE(BigInt(amountAtoms), 1);
    data.writeUInt8(0, 9); // None
    return new TransactionInstruction({
        programId: MANIFEST_PROGRAM_ID,
        keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: new PublicKey(market), isSigner: false, isWritable: true },
            { pubkey: getAssociatedTokenAddressSync(mintPk, owner, true, tokenProgram), isSigner: false, isWritable: true },
            { pubkey: vaultAddress(market, mint), isSigner: false, isWritable: true },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
            { pubkey: mintPk, isSigner: false, isWritable: false },
        ],
        data,
    });
}

export const depositIx = (args) => tokenMoveIx(DEPOSIT_TAG, args);
export const withdrawIx = (args) => tokenMoveIx(WITHDRAW_TAG, args);

/**
 * Place and/or cancel orders. `globals` lists the base/quote global accounts that exist; they
 * must be passed for orders that may match against global (capital-efficient) resting orders.
 */
export function batchUpdateIx({ trader, market, baseMint, quoteMint, baseTokenProgram, quoteTokenProgram, globals, place = [], cancel = [] }) {
    const accounts = {
        payer: new PublicKey(trader),
        market: new PublicKey(market),
        systemProgram: SystemProgram.programId,
    };
    if (globals?.base || globals?.quote) {
        Object.assign(accounts, {
            baseMint: new PublicKey(baseMint),
            baseGlobal: getGlobalAddress(new PublicKey(baseMint)),
            baseGlobalVault: getGlobalVaultAddress(new PublicKey(baseMint)),
            baseMarketVault: vaultAddress(market, baseMint),
            baseTokenProgram,
            quoteMint: new PublicKey(quoteMint),
            quoteGlobal: getGlobalAddress(new PublicKey(quoteMint)),
            quoteGlobalVault: getGlobalVaultAddress(new PublicKey(quoteMint)),
            quoteMarketVault: vaultAddress(market, quoteMint),
            quoteTokenProgram,
        });
    }
    return createBatchUpdateInstruction(accounts, {
        params: {
            traderIndexHint: null,
            cancels: cancel.map(seq => ({ orderSequenceNumber: seq.toString(), orderIndexHint: null })),
            orders: place.map(o => ({
                baseAtoms: o.baseAtoms.toString(),
                priceMantissa: o.mantissa,
                priceExponent: o.exponent,
                isBid: o.isBid,
                lastValidSlot: o.lastValidSlot || 0,
                orderType: o.orderType ?? OrderType.Limit,
            })),
        },
    });
}

// ---------- token account helpers ----------

export function ataIx({ payer, owner, mint, tokenProgram }) {
    const ownerPk = new PublicKey(owner);
    const mintPk = new PublicKey(mint);
    return createAssociatedTokenAccountIdempotentInstruction(
        new PublicKey(payer), getAssociatedTokenAddressSync(mintPk, ownerPk, true, tokenProgram), ownerPk, mintPk, tokenProgram,
    );
}

/** Move native SOL into the owner's wSOL account (which must already exist). */
export function wrapSolIxs({ owner, lamports }) {
    const ownerPk = new PublicKey(owner);
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, ownerPk, true, TOKEN_PROGRAM_ID);
    return [
        SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: wsol, lamports: BigInt(lamports) }),
        createSyncNativeInstruction(wsol, TOKEN_PROGRAM_ID),
    ];
}

/** Close the owner's wSOL account, returning everything in it as native SOL. */
export function unwrapSolIx({ owner }) {
    const ownerPk = new PublicKey(owner);
    return createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, ownerPk, true, TOKEN_PROGRAM_ID), ownerPk, ownerPk, [], TOKEN_PROGRAM_ID);
}

export const isNativeMint = (mint) => new PublicKey(mint).equals(NATIVE_MINT);
