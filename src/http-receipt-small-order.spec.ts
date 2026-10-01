// SDK-2802 — verifyHttpReceipt must apply the SDK-2801 small-order / non-canonical
// guard to the target key and to R (the audit-verifier twin is AV-2702). Real
// crypto only: node:crypto is not mocked, so a forgery here is one OpenSSL
// would accept without the guard.
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HTTP_RECEIPT_VERSION, verifyHttpReceipt, type HttpReceiptStatement } from './http-receipt.js';
import { jcsCanonicalize, type JsonValue } from './jcs-canonical.js';

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const IDENTITY = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]); // y = 1, the order-1 point

const le = (b: Uint8Array): bigint => b.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);
const le32 = (n: bigint): Buffer => Buffer.from(Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn)));
const pem = (raw: Uint8Array): string =>
  createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }).toString();

/** A real Ed25519 key: raw public key A, private scalar a (RFC 8032 §5.1.5), and its KeyObject. */
function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const h = createHash('sha512').update(Buffer.from(jwk.d!, 'base64url')).digest();
  h[0]! &= 248; h[31]! &= 127; h[31]! |= 64;
  return { A: Buffer.from(jwk.x!, 'base64url'), a: le(h.subarray(0, 32)), privateKey, pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

const STATEMENT: HttpReceiptStatement = {
  version: HTTP_RECEIPT_VERSION,
  actionId: '11111111-1111-7111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  targetId: 'fixture-target',
  keyId: 'fixture-key',
  requestCommitment: 'a'.repeat(64),
  resultCommitment: 'b'.repeat(64),
  effect: 'succeeded',
  issuedAt: '2026-10-01T12:00:00.000Z',
  targetTransactionId: 'txn-1',
};
const { version: _v, effect: _e, issuedAt: _i, targetTransactionId: _t, ...EXPECTED } = STATEMENT;
const MESSAGE = Buffer.from(jcsCanonicalize(STATEMENT as unknown as JsonValue));
const receipt = (sig: Uint8Array) => ({ statement: STATEMENT, signature: Buffer.from(sig).toString('base64') });

describe('verifyHttpReceipt small-order / non-canonical guard (SDK-2802)', () => {
  it('control: an honest signature by a real key verifies', () => {
    const k = keypair();
    expect(verifyHttpReceipt(receipt(sign(null, MESSAGE, k.privateKey)), k.pem, EXPECTED)).toBe(true);
  });

  it('rejects a valid key with a small-order R (identity R, S = k·a mod L)', () => {
    const k = keypair();
    const challenge = le(createHash('sha512').update(IDENTITY).update(k.A).update(MESSAGE).digest()) % L;
    const sig = Buffer.concat([IDENTITY, le32((challenge * k.a) % L)]); // [S]B = [k]A = R + [k]A
    expect(verifyHttpReceipt(receipt(sig), k.pem, EXPECTED)).toBe(false);
  });

  // [k]A is the identity for every message, so R = [s]B with S = s verifies anything.
  it.each([
    ['canonical identity key (y = 1)', IDENTITY],
    ['non-canonical identity key (y = p + 1)', le32(P + 1n)],
  ])('rejects a small-order key alone: %s', (_name, key) => {
    const s = keypair();
    const sig = Buffer.concat([s.A, le32(s.a % L)]);
    expect(verifyHttpReceipt(receipt(sig), pem(key), EXPECTED)).toBe(false);
  });
});
