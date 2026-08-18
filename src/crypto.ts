/**
 * H3-02f — hand-written offline verification primitives for the trust-passport
 * verify client. NOT part of the OpenAPI-generated / typed-client surface.
 *
 * These are deliberately byte-for-byte compatible with the be-core primitives
 * that PRODUCE a signed trust passport, so a third party can verify an agent's
 * reputation OFFLINE against a caller-trusted public key — the same way the
 * `@praesidia/audit-verifier` package verifies an exported audit bundle:
 *
 * - {@link verifyEd25519}  mirrors be-core `CryptoUtilsService.verifyEd25519`
 *                          (AGV-003): same SPKI DER prefix, same 64-byte
 *                          signature guard, never throws.
 * - {@link verifyEs256}    mirrors be-core's KMS-backed P-256 verification:
 *                          strict DER/base64 input, canonical low-s signature,
 *                          SHA-256 over the canonical passport bytes.
 * - {@link canonicalJson}  mirrors be-core `canonicalJson` (AGV-030 / JCS-style)
 *                          — object keys sorted in `Array.prototype.sort` order,
 *                          the exact bytes the passport `proof` is signed over.
 * - {@link ed25519PublicKeyFromJwk}  decodes an OKP/Ed25519 JWK's base64url `x`
 *                          coordinate into the raw 32-byte public key.
 * - {@link p256PublicKeyFromJwk} validates an EC/P-256 JWK and returns its
 *                          SPKI-DER public key bytes.
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

const P256_N = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);
const P256_HALF_N = P256_N >> 1n;

/** Decode canonical padded standard base64 without Node's junk tolerance. */
function decodeBase64Strict(
  value: unknown,
  expectedLength?: number,
): Buffer | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) return null;
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    return null;
  }
  return decoded;
}

function decodeBase64UrlCoordinate(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === value
    ? decoded
    : null;
}

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
    // Ed25519 signatures are always 64 bytes; reject malformed inputs before
    // handing them to the OpenSSL bindings.
    const sig = decodeBase64Strict(signatureB64, 64);
    if (!sig) return false;
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
  if (
    (jwk['alg'] !== undefined && jwk['alg'] !== 'EdDSA') ||
    (jwk['use'] !== undefined && jwk['use'] !== 'sig') ||
    jwk['d'] !== undefined
  ) {
    return null;
  }
  try {
    const raw = decodeBase64UrlCoordinate(jwk['x']);
    if (!raw) return null;
    return new Uint8Array(raw);
  } catch {
    return null;
  }
}

/**
 * Validate an EC/P-256 public JWK and return its SPKI-DER representation.
 * Optional `alg`/`use` members must describe an ES256 signing key when present.
 * Private-key material is rejected. Returns `null` (never throws) on malformed
 * or algorithm-confused input.
 */
export function p256PublicKeyFromJwk(
  jwk: Record<string, unknown> | null | undefined,
): Uint8Array | null {
  if (!jwk || typeof jwk !== 'object') return null;
  if (
    jwk['kty'] !== 'EC' ||
    jwk['crv'] !== 'P-256' ||
    (jwk['alg'] !== undefined && jwk['alg'] !== 'ES256') ||
    (jwk['use'] !== undefined && jwk['use'] !== 'sig') ||
    jwk['d'] !== undefined
  ) {
    return null;
  }
  const x = decodeBase64UrlCoordinate(jwk['x']);
  const y = decodeBase64UrlCoordinate(jwk['y']);
  if (!x || !y) return null;

  try {
    const keyObject = crypto.createPublicKey({
      key: jwk as crypto.JsonWebKey,
      format: 'jwk',
    });
    if (
      keyObject.asymmetricKeyType !== 'ec' ||
      keyObject.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) {
      return null;
    }
    const roundTrip = keyObject.export({ format: 'jwk' });
    if (roundTrip.x !== jwk['x'] || roundTrip.y !== jwk['y']) return null;
    return new Uint8Array(
      keyObject.export({ format: 'der', type: 'spki' }),
    );
  } catch {
    return null;
  }
}

/**
 * Verify a canonical KMS-style ES256 signature over `message`.
 * `signatureB64` must be standard base64 containing strict ASN.1 DER `(r,s)`;
 * high-s/malleable signatures are rejected to match be-core. Returns false on
 * every malformed input and never throws.
 */
export function verifyEs256(
  message: Uint8Array,
  signatureB64: string,
  publicKeySpki: Uint8Array,
): boolean {
  try {
    const signature = decodeBase64Strict(signatureB64);
    if (!signature || !isLowSP256Der(signature)) return false;
    const keyObject = crypto.createPublicKey({
      key: Buffer.from(publicKeySpki),
      format: 'der',
      type: 'spki',
    });
    if (
      keyObject.asymmetricKeyType !== 'ec' ||
      keyObject.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) {
      return false;
    }
    return crypto.verify(
      'sha256',
      Buffer.from(message),
      keyObject,
      signature,
    );
  } catch {
    return false;
  }
}

function isLowSP256Der(signature: Buffer): boolean {
  if (
    signature.length < 8 ||
    signature.length > 72 ||
    signature[0] !== 0x30 ||
    signature[1] !== signature.length - 2
  ) {
    return false;
  }

  let offset = 2;
  const r = readCanonicalDerInteger(signature, offset);
  if (!r) return false;
  offset = r.nextOffset;
  const s = readCanonicalDerInteger(signature, offset);
  if (!s || s.nextOffset !== signature.length) return false;
  return (
    r.value > 0n &&
    r.value < P256_N &&
    s.value > 0n &&
    s.value <= P256_HALF_N
  );
}

function readCanonicalDerInteger(
  signature: Buffer,
  offset: number,
): { value: bigint; nextOffset: number } | null {
  if (signature[offset] !== 0x02) return null;
  const length = signature[offset + 1];
  if (length === undefined || length < 1 || length > 33) return null;
  const start = offset + 2;
  const end = start + length;
  if (end > signature.length) return null;
  let magnitude = signature.subarray(start, end);
  if ((magnitude[0]! & 0x80) !== 0) return null;
  if (magnitude.length > 1 && magnitude[0] === 0) {
    if ((magnitude[1]! & 0x80) === 0) return null;
    magnitude = magnitude.subarray(1);
  }
  if (magnitude.length > 32) return null;
  return {
    value: BigInt(`0x${magnitude.toString('hex')}`),
    nextOffset: end,
  };
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
