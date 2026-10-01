// SDK-2801 — small-order / non-canonical Ed25519 guard (mirrors be BE-2858).
// OpenSSL builds differ on whether they reject small-order keys and R values
// (an all-zero key + all-zero signature verified 481/2000 messages on
// node 24.14 / OpenSSL 3.5.5), so verifyEd25519 must reject them itself.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import * as nodeCrypto from 'node:crypto';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

import {
  verifyEd25519,
  isRejectedEd25519Point,
  ED25519_SMALL_ORDER_Y,
} from './crypto.js';

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function powMod(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = mod(r * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return r;
}
const inv = (a: bigint) => powMod(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = powMod(2n, (P - 1n) / 4n);

type Pt = [bigint, bigint]; // affine (x, y)
function add([x1, y1]: Pt, [x2, y2]: Pt): Pt {
  const t = mod(D * x1 * x2 * y1 * y2);
  return [
    mod((x1 * y2 + x2 * y1) * inv(1n + t)),
    mod((y1 * y2 + x1 * x2) * inv(1n - t)),
  ];
}
function mul(p: Pt, k: bigint): Pt {
  let q: Pt = [0n, 1n];
  while (k > 0n) {
    if (k & 1n) q = add(q, p);
    p = add(p, p);
    k >>= 1n;
  }
  return q;
}
/** Any curve point with the given y, or null when x^2 is a non-residue. */
function pointWithY(y: bigint): Pt | null {
  const xx = mod((y * y - 1n) * inv(D * y * y + 1n));
  let x = powMod(xx, (P + 3n) / 8n);
  if (mod(x * x - xx) !== 0n) x = mod(x * SQRT_M1);
  return mod(x * x - xx) === 0n ? [x, y] : null;
}
function encode([x, y]: Pt, signBit = x & 1n): Uint8Array {
  const v = y | (signBit << 255n);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return out;
}
function encodeRaw(yWithSign: bigint): Uint8Array {
  return encode([0n, yWithSign & ((1n << 255n) - 1n)], yWithSign >> 255n);
}
const key = (p: Pt) => `${p[0]},${p[1]}`;

/** The full 8-torsion subgroup, derived from scratch: [L]·P for curve points P. */
function deriveTorsion(): Pt[] {
  for (let y = 2n; y < 100n; y++) {
    const p = pointWithY(y);
    if (!p) continue;
    const t = mul(p, L); // lands in E[8]
    const orbit = new Map<string, Pt>();
    let q: Pt = [0n, 1n];
    for (let i = 0; i < 8; i++) {
      orbit.set(key(q), q);
      q = add(q, t);
    }
    if (orbit.size === 8) return [...orbit.values()];
  }
  throw new Error('no order-8 generator found');
}

const verifyMock = vi.mocked(nodeCrypto.verify);
const ZERO_SIG_TAIL = Buffer.alloc(32);
const sigWithR = (r: Uint8Array) =>
  Buffer.concat([Buffer.from(r), ZERO_SIG_TAIL]).toString('base64');

function realKeyAndSig(msg: Buffer) {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const sig = nodeCrypto.sign(null, msg, privateKey);
  return { raw: new Uint8Array(raw), sig };
}

describe('Ed25519 small-order / non-canonical guard (SDK-2801)', () => {
  let actualVerify: typeof nodeCrypto.verify;
  beforeAll(async () => {
    actualVerify = (await vi.importActual<typeof nodeCrypto>('node:crypto')).verify;
  });
  afterEach(() => verifyMock.mockReset().mockImplementation(actualVerify));

  const torsion = deriveTorsion();
  const smallOrder = torsion.map((p) => encode(p));
  const nonCanonical = [P, P + 1n, 2n ** 255n - 1n].flatMap((y) => [
    encodeRaw(y),
    encodeRaw(y | (1n << 255n)),
  ]);

  it('the constant table equals the y set of the derived 8-torsion', () => {
    expect(torsion).toHaveLength(8);
    for (const p of torsion) expect(mul(p, 8n)).toEqual([0n, 1n]);
    const derived = [...new Set(torsion.map((p) => p[1]))].sort();
    expect([...ED25519_SMALL_ORDER_Y].sort()).toEqual(derived);
    expect(derived).toHaveLength(5);
  });

  it('flags all 8 small-order points (both sign bits) and non-canonical y', () => {
    for (const enc of smallOrder) {
      expect(isRejectedEd25519Point(enc)).toBe(true);
      const flipped = Uint8Array.from(enc);
      flipped[31]! ^= 0x80;
      expect(isRejectedEd25519Point(flipped)).toBe(true);
    }
    for (const enc of nonCanonical) expect(isRejectedEd25519Point(enc)).toBe(true);
    expect(isRejectedEd25519Point(encodeRaw(P - 2n))).toBe(false);
  });

  it('rejects small-order / non-canonical key and R even when OpenSSL would accept', () => {
    verifyMock.mockImplementation(() => true);
    const msg = Buffer.from('msg');
    const { raw, sig } = realKeyAndSig(msg);
    const bad = [...smallOrder, ...nonCanonical];
    for (const enc of bad) {
      // as the public key, with an otherwise well-formed signature
      expect(verifyEd25519(msg, sig.toString('base64'), enc)).toBe(false);
      // as R, with a genuine public key
      expect(verifyEd25519(msg, sigWithR(enc), raw)).toBe(false);
    }
    // the guard does not swallow honest inputs: the mock is reached and passes
    expect(verifyMock).not.toHaveBeenCalled();
    expect(verifyEd25519(msg, sig.toString('base64'), raw)).toBe(true);
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it('a real generated key and signature still verify against real OpenSSL', () => {
    const msg = Buffer.from('praesidia');
    const { raw, sig } = realKeyAndSig(msg);
    expect(verifyEd25519(msg, sig.toString('base64'), raw)).toBe(true);
    expect(verifyEd25519(Buffer.from('praesidiA'), sig.toString('base64'), raw)).toBe(false);
  });

  it('all-zero key + all-zero signature never verifies (481/2000 repro)', () => {
    const zeroKey = new Uint8Array(32);
    const zeroSig = Buffer.alloc(64).toString('base64');
    let accepted = 0;
    for (let i = 0; i < 2000; i++) {
      if (verifyEd25519(Buffer.from(`m${i}`), zeroSig, zeroKey)) accepted++;
    }
    expect(accepted).toBe(0);
  });
});
