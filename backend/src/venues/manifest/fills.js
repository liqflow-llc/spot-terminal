// Live Manifest fills from a logs subscription (no per-transaction fetches).
// Manifest writes each fill as a `Program data:` log line holding a FillLog.
import { EventEmitter } from 'events';
import bs58 from 'bs58';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { FillLog } from '@bonasa-tech/manifest-sdk';
import { connection } from '../../solana.js';
import { MANIFEST_PROGRAM_ID } from './markets.js';

const PROGRAM = MANIFEST_PROGRAM_ID.toBase58();
const logDiscriminator = (name) => Buffer.from(
    keccak_256(Buffer.concat([Buffer.from(bs58.decode(PROGRAM)), Buffer.from(`manifest::logs::${name}`)])),
).subarray(0, 8);
const FILL_DISCRIMINATOR = logDiscriminator('FillLog');

/**
 * `Program data:` payloads emitted while Manifest itself was executing. Any program can log the
 * same bytes, so we track the invocation stack rather than trusting every data line.
 */
export function manifestDataLogs(logs) {
    const stack = [];
    const out = [];
    for (const line of logs || []) {
        let m;
        if ((m = /^Program (\w+) invoke \[\d+\]$/.exec(line))) stack.push(m[1]);
        else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
        else if (line.startsWith('Program data: ') && stack.at(-1) === PROGRAM) out.push(line.slice(14));
    }
    return out;
}

export function parseFills(logs) {
    const fills = [];
    for (const data of manifestDataLogs(logs)) {
        const buf = Buffer.from(data, 'base64');
        if (buf.length < 8 + FillLog.byteSize || !buf.subarray(0, 8).equals(FILL_DISCRIMINATOR)) continue;
        try {
            const [log] = FillLog.deserialize(buf.subarray(8));
            fills.push({
                market: log.market.toBase58(),
                maker: log.maker.toBase58(),
                taker: log.taker.toBase58(),
                baseAtoms: BigInt(log.baseAtoms.inner.toString()),
                quoteAtoms: BigInt(log.quoteAtoms.inner.toString()),
                takerIsBuy: log.takerIsBuy,
                makerSequenceNumber: log.makerSequenceNumber.toString(),
            });
        } catch {
            // Malformed payload; ignore.
        }
    }
    return fills;
}

/**
 * Sequence numbers of the orders a batch update placed, in placement order. The program no longer
 * logs PlaceOrderLog; it returns `u32 count | (u64 sequence_number, u32 order_index)*` as the
 * instruction's return data, which the runtime writes to the log as `Program return: <id> <b64>`.
 * Every placed order gets a sequence number, including ones that fully matched on arrival.
 */
export function parseBatchUpdateReturn(logs) {
    const prefix = `Program return: ${PROGRAM} `;
    const line = (logs || []).filter(l => l.startsWith(prefix)).at(-1);
    if (!line) return null;
    const buf = Buffer.from(line.slice(prefix.length), 'base64');
    if (buf.length < 4) return null;
    const count = buf.readUInt32LE(0);
    if (buf.length < 4 + count * 12) return null;
    const out = [];
    for (let i = 0; i < count; i++) out.push(buf.readBigUInt64LE(4 + i * 12).toString());
    return out;
}

/** Emits 'fill' for every Manifest fill seen on-chain, with `signature`, `slot` and `time` (ms). */
export class ManifestFillFeed extends EventEmitter {
    start() {
        this.subscriptionId = connection.onLogs(MANIFEST_PROGRAM_ID, (result, ctx) => {
            if (result.err) return;
            const time = Date.now();
            for (const fill of parseFills(result.logs)) {
                this.emit('fill', { ...fill, signature: result.signature, slot: ctx.slot, time });
            }
        }, 'confirmed');
        console.log('Manifest: subscribed to fill logs');
    }
}
