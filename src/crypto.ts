/**
 * H3-02f — hand-written offline verification primitives for the trust-passport
 * verify client. NOT part of the OpenAPI-generated / typed-client surface.
 *
 * These are deliberately byte-for-byte compatible with the be-core primitives
 * that PRODUCE a signed trust passport, so a third party can verify an agent's
 * reputation OFFLINE — without trusting Praesidia — the same way the
 * `@praesidia/audit-verifier` package verifies an exported audit bundle:
 *
 * - {@link verifyEd25519}  mirrors be-core `CryptoUtilsService.verifyEd25519`
 *                          (AGV-003): same SPKI DER prefix, same 64-byte
 *                          signature guard, never throws.
 * - {@link canonicalJson}  mirrors be-core `canonicalJson` (AGV-030 / JCS-style)
 *                          — object keys sorted in `Array.prototype.sort` order,
 *                          the exact bytes the passport `proof` is signed over.
 * - {@link ed25519PublicKeyFromJwk}  decodes an OKP/Ed25519 JWK's base64url `x`
 *                          coordinate into the raw 32-byte public key.
 *
 * Zero runtime dependencies — pure Node `crypto`.
 */

import * as crypto from 'node:crypto';

// SubjectPublicKeyInfo (RFC 8410) wrapper for a raw 32-byte Ed25519 public key:
//   SEQUENCE (0x30 0x2a)
//     SEQUENCE (0x30 0x05)
//       OID 1.3.101.112 = Ed25519 (0x06 0x03 0x2b 0x65 0x70)
//     BIT STRING (0x03 0x21 0x00) — 32 raw public key bytes
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify an Ed25519 signature. Returns `false` (never throws) on any malformed
 * input or mismatched signature.
 *
 * @param message       The exact bytes that were signed.
 * @param signatureB64  The signature as STANDARD base64 (not base64url) — this
 *                      is how be-core emits `proof.proofValue`.
 * @param publicKey     Raw 32-byte Ed25519 public key.
 */
export function verifyEd25519(
  message: Uint8Array,
  signatureB64: string,
  publicKey: Uint8Array,
): boolean {
  try {
    if (publicKey.length !== 32) {
      return false;
    }
    if (typeof signatureB64 !== 'string' || signatureB64.length === 0) {
      return false;
    }
    const sig = Buffer.from(signatureB64, 'base64');
    // Ed25519 signatures are always 64 bytes; reject malformed inputs before
    // handing them to the OpenSSL bindings.
    if (sig.length !== 64) {
      return false;
    }
    const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]);
    const keyObject = crypto.createPublicKey({
      key: der,
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(message), keyObject, sig);
  } catch {
    return false;
  }
}

/**
 * Decode an OKP/Ed25519 JWK (the `publicKeyJwk` returned by the trust-passport
 * verify endpoint) into the raw 32-byte public key.
 *
 * The JWK shape be-core emits is `{ kty: 'OKP', crv: 'Ed25519', use: 'sig', x }`
 * where `x` is the base64url-encoded 32-byte public key. Returns `null` for any
 * JWK that is not a well-formed Ed25519 public key (wrong kty/crv, missing or
 * malformed `x`) so verification fails closed.
 */
export function ed25519PublicKeyFromJwk(
  jwk: Record<string, unknown> | null | undefined,
): Uint8Array | null {
  if (!jwk || typeof jwk !== 'object') {
    return null;
  }
  if (jwk['kty'] !== 'OKP' || jwk['crv'] !== 'Ed25519') {
    return null;
  }
  const x = jwk['x'];
  if (typeof x !== 'string' || x.length === 0) {
    return null;
  }
  try {
    const raw = Buffer.from(x, 'base64url');
    if (raw.length !== 32) {
      return null;
    }
    return new Uint8Array(raw);
  } catch {
    return null;
  }
}

/**
 * Deterministic JSON byte encoding — byte-for-byte identical to be-core's
 * `canonicalJson` (AGV-030). Object keys are sorted in `Array.prototype.sort`
 * order (lexicographic UTF-16 code-unit order, matching V8's default).
 *
 * This reproduces the exact bytes the trust-passport `proof` was signed over
 * (the passport document with its `proof` member removed).
 */
export function canonicalJson(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), 'utf8');
}

function canonicalize(v: unknown): string {
  if (v === null || v === undefined) {
    return 'null';
  }
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error('canonicalJson: non-finite number');
    }
    return JSON.stringify(v);
  }
  if (typeof v === 'string') {
    return JSON.stringify(v);
  }
  if (typeof v === 'bigint') {
    return JSON.stringify(v.toString());
  }
  if (Array.isArray(v)) {
    return '[' + v.map(canonicalize).join(',') + ']';
  }
  if (typeof v === 'object') {
    // TICKET-213 (mirrored) — copy into a null-prototype accumulator first so a
    // literal "__proto__" key is treated as an ordinary string key rather than
    // the prototype setter.
    const own = Object.assign(
      Object.create(null) as Record<string, unknown>,
      v,
    );
    const keys = Object.keys(own).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ':' + canonicalize(own[k]),
    );
    return '{' + parts.join(',') + '}';
  }
  return 'null';
}
