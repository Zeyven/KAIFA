import { randomFillSync } from 'node:crypto';

/**
 * UUIDv7 generator (RFC 9562) — ADR-0004.
 *
 * Layout: 48-bit unix-ms timestamp | 4-bit version (0111) | 12-bit rand_a |
 *         2-bit variant (10)      | 62-bit rand_b
 *
 * Same-millisecond IDs from one process increment rand_a so they sort
 * chronologically. Cross-process same-ms ordering is best-effort per RFC 9562;
 * strict ordering always uses an explicit sequence column (e.g. store_seq).
 */

const HEX = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  return out;
}

export interface UuidParts {
  timestampMs: bigint;
  version: number;
  variantBits: number;
}

/** Parse structural fields of any UUID for verification/testing. */
export function parseUuidParts(uuid: string): UuidParts {
  // 8-4-4-4-12; version = first nibble of group 3, variant = first nibble of group 4
  const m =
    /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{12}$/.exec(
      uuid.toLowerCase(),
    );
  if (!m) throw new Error(`not a uuid: ${uuid}`);
  const version = Number.parseInt(m[1]!, 16);
  const variantBits = Number.parseInt(m[2]!, 16) >> 2; // top 2 bits
  const hex = uuid.replaceAll('-', '').toLowerCase();
  const timestampMs = BigInt(`0x${hex.slice(0, 12)}`);
  return { timestampMs, version, variantBits };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(uuid: string): boolean {
  return UUID_RE.test(uuid.toLowerCase());
}

let lastMs = -1n;
let randA = 0;

function nextBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);
  return bytes;
}

/** Generate one UUIDv7. Monotonic within this process for equal timestamps. */
export function newUuidv7(nowMs: number = Date.now()): string {
  const ms = BigInt(nowMs);
  if (ms === lastMs) {
    randA += 1;
    if (randA > 0xfff) {
      // rand_a exhausted inside 1ms (theoretical): bump to next millisecond.
      randA = 0;
      lastMs = ms + 1n;
      return emit(lastMs, randA);
    }
  } else if (ms > lastMs) {
    lastMs = ms;
    randA = Math.floor(Math.random() * 0x1000);
  } else {
    // clock moved backwards — keep monotonicity of the previous value
    randA += 1;
    if (randA > 0xfff) {
      randA = 0;
      lastMs += 1n;
    }
    return emit(lastMs, randA);
  }
  return emit(lastMs, randA);
}

function emit(ms: bigint, randA12: number): string {
  const bytes = nextBytes();
  const tsHex = ms.toString(16).padStart(12, '0');
  const verA = ((7 << 12) | randA12).toString(16).padStart(4, '0');
  // force variant bits (10xx) on byte 8's high nibble, keep 62 random bits
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const restHex = bytesToHex(bytes.subarray(8));
  const hex = tsHex + verA + restHex;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
