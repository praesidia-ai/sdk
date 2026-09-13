import { createHash } from 'node:crypto';

import { PraesidiaApiError } from './errors.js';
import {
  encodePathSegment,
  normalizeBaseUrl,
  readBoundedErrorResponse,
  readBoundedJsonResponse,
  resolveRequestTimeoutMs,
} from './client.js';
import {
  canonicalJson,
  ed25519PublicKeyFromJwk,
  p256PublicKeyFromJwk,
  verifyEd25519,
  verifyEs256,
} from './crypto.js';
import type {
  TrustAnchorJwk,
  TrustFetchAndVerifyOptions,
  TrustFetchAndVerifyResult,
  TrustPassport,
  TrustPassportVerifyBundle,
  TrustVerificationResult,
} from './types.js';
import type { GuardConfig } from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

/**
 * PraesidiaTrust — fetch + OFFLINE-verify a peer agent's trust passport (H3-02f).
 *
 * This is the local cryptographic verification client. It fetches the signed,
 * W3C-Verifiable-Credential-shaped trust passport
 * from the PUBLIC (unauthenticated) trust routes and verifies the detached
 * Ed25519 or ES256 proof LOCALLY against the org public key JWK — the same
 * offline-verify pattern as the `@praesidia/audit-verifier` package. A passing
 * verification
 * means the aggregate reputation claims (trust score/level, posture, red-team
 * evidence, attestation & compliance summary) were signed by the issuing org's
 * key and have not been tampered with in transit.
 *
 * `verifyPassport` treats the caller-supplied JWK as its trust anchor. Obtain
 * that JWK from a trusted DID document/bundle; signature verification alone
 * cannot establish that an arbitrary key is authorized for a claimed issuer.
 *
 * The routes are public, so no API key is needed — but a passport fetched from
 * a public route and checked with the key from that SAME response proves
 * nothing, so `fetchAndVerify` requires an out-of-band trust anchor before it
 * will report `verified: true` (SEC-2026-09-12 MCPSDK-04):
 *   const trust = new PraesidiaTrust();
 *   const { passport, verified } = await trust.fetchAndVerify(peerAgentId, {
 *     trustedKeys: [issuerJwkFromYourDidDocument],
 *   });
 *   if (verified && passport.credentialSubject.trustScore >= 70) { ...trust... }
 *
 * The crypto lives in `crypto.ts` (hand-written, not part of any generated
 * client surface): `verifyEd25519`, `verifyEs256`, `canonicalJson`, and their
 * algorithm-specific JWK decoders.
 */
export class PraesidiaTrust {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(config: Pick<GuardConfig, 'baseUrl' | 'requestTimeoutMs'> = {}) {
    this.baseUrl = normalizeBaseUrl(
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL,
    );
    this.requestTimeoutMs = resolveRequestTimeoutMs(config.requestTimeoutMs);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Fetch an agent's signed trust passport. GET /trust/passport/:agentId
   * (public — no auth). Throws `PraesidiaApiError` (404) for unknown, inactive,
   * soft-deleted, or non-PUBLIC agents.
   */
  async fetchPassport(agentId: string): Promise<TrustPassport> {
    return this.publicGet<TrustPassport>(
      `/trust/passport/${encodePathSegment(agentId, 'agentId')}`,
    );
  }

  /**
   * Fetch the verification bundle (passport + org public key JWK +
   * didDocumentUrl + hint). GET /trust/passport/:agentId/verify (public).
   */
  async fetchVerifyBundle(
    agentId: string,
  ): Promise<TrustPassportVerifyBundle> {
    return this.publicGet<TrustPassportVerifyBundle>(
      `/trust/passport/${encodePathSegment(agentId, 'agentId')}/verify`,
    );
  }

  /**
   * OFFLINE-verify a passport's detached Ed25519/ES256 proof against a JWK.
   *
   * Reconstructs the canonical JSON of the passport WITH its `proof` member
   * removed (RFC-8785-style, keys sorted lexicographically — byte-identical to
   * how be-core signed it), base64-decodes `proof.proofValue`, and verifies the
   * substrate-selected signature over those raw bytes. Also checks expiry.
   *
   * Pure local computation against the supplied trust anchor. Never throws;
   * a malformed passport / key yields `{ verified: false, reason }`.
   */
  verifyPassport(
    passport: TrustPassport,
    publicKeyJwk: Record<string, unknown>,
  ): TrustVerificationResult {
    try {
      return this.verifyPassportUnchecked(passport, publicKeyJwk);
    } catch {
      return {
        verified: false,
        signatureValid: false,
        expired: false,
        reason: 'malformed-passport',
      };
    }
  }

  private verifyPassportUnchecked(
    passport: TrustPassport,
    publicKeyJwk: Record<string, unknown>,
  ): TrustVerificationResult {
    const proof = passport?.proof;
    if (!proof || typeof proof.proofValue !== 'string') {
      return {
        verified: false,
        signatureValid: false,
        expired: false,
        reason: 'missing-proof',
      };
    }
    if (!isPassportEnvelopeWellFormed(passport)) {
      return {
        verified: false,
        signatureValid: false,
        expired: false,
        reason: 'malformed-passport',
      };
    }

    const verifier = resolvePassportVerifier(publicKeyJwk, proof.type);
    if (verifier === 'malformed-key') {
      return {
        verified: false,
        signatureValid: false,
        expired: false,
        reason: 'malformed-public-key',
      };
    }

    // Sign-the-doc / attach-the-proof: strip `proof`, canonicalize the rest.
    let message: Uint8Array;
    try {
      const { proof: _proof, ...unsigned } = passport;
      message = canonicalJson(unsigned);
    } catch {
      return {
        verified: false,
        signatureValid: false,
        expired: false,
        reason: 'malformed-passport',
      };
    }
    const signatureValid =
      verifier === 'proof-mismatch'
        ? false
        : verifier(message, proof.proofValue);

    const expiration = expirationState(
      passport.expirationDate,
      passport.issuanceDate,
    );
    const expired = expiration === 'expired';

    if (!signatureValid) {
      return {
        verified: false,
        signatureValid: false,
        expired,
        reason: 'signature-mismatch',
      };
    }
    if (expiration === 'invalid') {
      return {
        verified: false,
        signatureValid: true,
        expired: false,
        reason: 'invalid-expiration',
      };
    }
    if (expired) {
      return {
        verified: false,
        signatureValid: true,
        expired: true,
        reason: 'expired',
      };
    }
    return { verified: true, signatureValid: true, expired: false, reason: 'ok' };
  }

  /**
   * Fetch the verification bundle AND verify it offline in one call. Returns the
   * passport, the public key JWK, the DID document URL, and the verification
   * result flattened in.
   *
   * SEC-2026-09-12 MCPSDK-04 — `GET /trust/passport/:agentId/verify` is a
   * PUBLIC, unauthenticated route that returns the passport AND the key that
   * "verifies" it. Checking one against the other is self-referential: anyone
   * who can answer that request (a TLS-terminating proxy, DNS control, a
   * compromised API) can mint a passport plus a matching key. So the trust
   * anchor must come from somewhere else:
   *
   * - `options.trustedKeys` — one or more JWKs you resolved out-of-band (DID
   *   document, vendor onboarding, config). The passport must verify under one
   *   of them. Same shape of guarantee as `verifyProtectedHttpResult`, whose
   *   target key is likewise caller-supplied and never taken from the response.
   * - `options.expectedFingerprint` — the RFC 7638 SHA-256 thumbprint the
   *   returned key must match, when you can pin the fingerprint but not the key.
   *
   * With NO anchor the signature is still checked (so `signatureValid` stays
   * truthful and you can tell a mangled passport from a substituted one), but
   * the result is `verified: false, reason: 'unpinned_key'` — an integrity
   * check against an unauthenticated key is not an assurance and must not read
   * like one.
   */
  async fetchAndVerify(
    agentId: string,
    options?: TrustFetchAndVerifyOptions,
  ): Promise<TrustFetchAndVerifyResult> {
    const bundle = await this.fetchVerifyBundle(agentId);
    const result = this.verifyAgainstAnchor(
      bundle.passport,
      bundle.publicKeyJwk,
      options,
    );
    return {
      ...result,
      passport: bundle.passport,
      publicKeyJwk: bundle.publicKeyJwk,
      didDocumentUrl: bundle.didDocumentUrl,
    };
  }

  /**
   * Verify `passport` against the caller's anchor, falling back to a truthful
   * but explicitly unpinned result when no anchor was supplied.
   *
   * `servedKeyJwk` is the key that arrived with the passport; it is only ever
   * used to compute an honest `signatureValid`, or after its fingerprint has
   * been pinned by the caller.
   */
  private verifyAgainstAnchor(
    passport: TrustPassport,
    servedKeyJwk: Record<string, unknown>,
    options?: TrustFetchAndVerifyOptions,
  ): TrustVerificationResult {
    const anchors = normalizeTrustedKeys(options?.trustedKeys);
    const expectedFingerprint = options?.expectedFingerprint;
    const hasFingerprint =
      typeof expectedFingerprint === 'string' && expectedFingerprint.length > 0;

    if (!anchors && !hasFingerprint) {
      // Unpinned: report the real signature/expiry state, deny the assurance.
      // A concrete failure (signature-mismatch, expired, ...) is kept because
      // it is strictly more informative; only an otherwise-'ok' check is
      // downgraded to 'unpinned_key'.
      const served = this.verifyPassport(passport, servedKeyJwk);
      return served.reason === 'ok'
        ? { ...served, verified: false, reason: 'unpinned_key' }
        : { ...served, verified: false };
    }

    if (hasFingerprint && !jwkMatchesFingerprint(servedKeyJwk, expectedFingerprint)) {
      const served = this.verifyPassport(passport, servedKeyJwk);
      return { ...served, verified: false, reason: 'fingerprint_mismatch' };
    }

    if (!anchors) {
      // Fingerprint-only anchor, and the served key matched it.
      return this.verifyPassport(passport, servedKeyJwk);
    }

    // Key anchor: the passport must verify under one of the caller's keys.
    let underTrustedKey: TrustVerificationResult | undefined;
    for (const anchor of anchors) {
      const result = this.verifyPassport(passport, anchor);
      if (result.verified) return result;
      // Signature is good under a trusted key but something else failed
      // (expired / invalid expiration) — that reason is more useful than
      // 'untrusted_key'.
      if (result.signatureValid && !underTrustedKey) underTrustedKey = result;
    }
    if (underTrustedKey) return underTrustedKey;
    return {
      verified: false,
      signatureValid: false,
      expired: false,
      reason: 'untrusted_key',
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Unauthenticated GET against a public trust route. */
  private async publicGet<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      const text = await readBoundedErrorResponse(response, path);
      throw new PraesidiaApiError(response.status, path, text);
    }
    return readBoundedJsonResponse<T>(response, path);
  }
}

type PassportVerifier = (message: Uint8Array, signature: string) => boolean;

function isPassportEnvelopeWellFormed(passport: TrustPassport): boolean {
  const subject = passport.credentialSubject;
  const proof = passport.proof;
  return (
    Array.isArray(passport['@context']) &&
    passport['@context'].includes('https://www.w3.org/2018/credentials/v1') &&
    Array.isArray(passport.type) &&
    passport.type.includes('VerifiableCredential') &&
    passport.type.includes('TrustPassport') &&
    isNonEmptyString(passport.id) &&
    isNonEmptyString(passport.issuer) &&
    isIsoInstant(passport.issuanceDate) &&
    typeof passport.expirationDate === 'string' &&
    !!subject &&
    typeof subject === 'object' &&
    isNonEmptyString(subject.id) &&
    isNonEmptyString(subject.agentName) &&
    isNonEmptyString(subject.trustLevel) &&
    Number.isFinite(subject.trustScore) &&
    subject.trustScore >= 0 &&
    subject.trustScore <= 100 &&
    Array.isArray(subject.compliance) &&
    subject.compliance.every(isNonEmptyString) &&
    !!subject.posture &&
    typeof subject.posture === 'object' &&
    isNonEmptyString(subject.posture.status) &&
    isNullableIsoInstant(subject.posture.expiresAt) &&
    !!subject.redTeam &&
    typeof subject.redTeam === 'object' &&
    Number.isInteger(subject.redTeam.completedRuns) &&
    subject.redTeam.completedRuns >= 0 &&
    isNullableIsoInstant(subject.redTeam.lastTestedAt) &&
    !!subject.attestations &&
    typeof subject.attestations === 'object' &&
    Number.isInteger(subject.attestations.activeCount) &&
    subject.attestations.activeCount >= 0 &&
    typeof subject.attestations.identityVerified === 'boolean' &&
    typeof subject.attestations.guardrailsActive === 'boolean' &&
    typeof subject.attestations.auditTrailEnabled === 'boolean' &&
    typeof subject.attestations.spendCapConfigured === 'boolean' &&
    isNonEmptyString(proof.type) &&
    proof.created === passport.issuanceDate &&
    proof.proofPurpose === 'assertionMethod' &&
    Number.isInteger(proof.keyVersion) &&
    proof.keyVersion > 0 &&
    proof.verificationMethod === `${passport.issuer}#key-${proof.keyVersion}`
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIsoInstant(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function isNullableIsoInstant(value: unknown): value is string | null {
  return value === null || isIsoInstant(value);
}

function resolvePassportVerifier(
  jwk: Record<string, unknown>,
  proofType: unknown,
): PassportVerifier | 'malformed-key' | 'proof-mismatch' {
  if (jwk?.['kty'] === 'OKP' && jwk['crv'] === 'Ed25519') {
    const key = ed25519PublicKeyFromJwk(jwk);
    if (!key) return 'malformed-key';
    if (proofType !== 'Ed25519Signature2020') return 'proof-mismatch';
    return (message, signature) => verifyEd25519(message, signature, key);
  }
  if (jwk?.['kty'] === 'EC' && jwk['crv'] === 'P-256') {
    const key = p256PublicKeyFromJwk(jwk);
    if (!key) return 'malformed-key';
    if (proofType !== 'EcdsaSecp256r1Signature2019') {
      return 'proof-mismatch';
    }
    return (message, signature) => verifyEs256(message, signature, key);
  }
  return 'malformed-key';
}

/** True when an ISO-8601 expiry timestamp is at or before the current instant. */
function expirationState(
  expirationDate: string | undefined,
  issuanceDate: string,
): 'valid' | 'expired' | 'invalid' {
  if (!isIsoInstant(expirationDate)) return 'invalid';
  const t = Date.parse(expirationDate);
  if (t <= Date.parse(issuanceDate)) return 'invalid';
  return t <= Date.now() ? 'expired' : 'valid';
}


/**
 * RFC 7638 JWK thumbprint (SHA-256) of an Ed25519 (OKP) or P-256 (EC) public
 * key, base64url-encoded. Returns `null` for anything else. Exposed so callers
 * can print the fingerprint of a key they trust and pin it via
 * `TrustFetchAndVerifyOptions.expectedFingerprint`.
 */
export function jwkThumbprint(jwk: Record<string, unknown>): string | null {
  const bytes = thumbprintDigest(jwk);
  return bytes ? bytes.toString('base64url') : null;
}

/** Same thumbprint as {@link jwkThumbprint}, lowercase hex. */
export function jwkThumbprintHex(jwk: Record<string, unknown>): string | null {
  const bytes = thumbprintDigest(jwk);
  return bytes ? bytes.toString('hex') : null;
}

function thumbprintDigest(jwk: Record<string, unknown>): Buffer | null {
  try {
    const kty = jwk?.['kty'];
    const crv = jwk?.['crv'];
    const x = jwk?.['x'];
    let required: Record<string, string>;
    if (kty === 'OKP' && typeof crv === 'string' && typeof x === 'string') {
      // RFC 7638 requires the required members only, in lexicographic order.
      required = { crv, kty: 'OKP', x };
    } else if (
      kty === 'EC' &&
      typeof crv === 'string' &&
      typeof x === 'string' &&
      typeof jwk['y'] === 'string'
    ) {
      required = { crv, kty: 'EC', x, y: jwk['y'] as string };
    } else {
      return null;
    }
    return createHash('sha256').update(JSON.stringify(required), 'utf8').digest();
  } catch {
    return null;
  }
}

/**
 * True when `expected` is the RFC 7638 thumbprint of `jwk`. Accepts base64url
 * or hex, with an optional `sha256:` prefix, so a fingerprint copied from a
 * console, a DID document or the CLI all work.
 */
function jwkMatchesFingerprint(
  jwk: Record<string, unknown>,
  expected: string,
): boolean {
  const bytes = thumbprintDigest(jwk);
  if (!bytes) return false;
  const candidate = expected.trim().replace(/^sha-?256:/i, '');
  if (candidate.length === 0) return false;
  return (
    candidate === bytes.toString('base64url') ||
    candidate.toLowerCase() === bytes.toString('hex')
  );
}

/** Accept both anchor shapes (array or map) as a flat candidate list. */
function normalizeTrustedKeys(
  trustedKeys: TrustFetchAndVerifyOptions['trustedKeys'],
): TrustAnchorJwk[] | undefined {
  if (trustedKeys === undefined || trustedKeys === null) return undefined;
  const list = Array.isArray(trustedKeys)
    ? trustedKeys
    : Object.values(trustedKeys);
  const keys = list.filter(
    (key): key is TrustAnchorJwk => !!key && typeof key === 'object',
  );
  return keys.length > 0 ? keys : [];
}
