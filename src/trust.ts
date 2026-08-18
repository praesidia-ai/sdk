import { PraesidiaApiError } from './errors.js';
import {
  encodePathSegment,
  normalizeBaseUrl,
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
 * The routes are public, so no API key is needed:
 *   const trust = new PraesidiaTrust();
 *   const { passport, verified } = await trust.fetchAndVerify(peerAgentId);
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
   */
  async fetchAndVerify(
    agentId: string,
  ): Promise<TrustFetchAndVerifyResult> {
    const bundle = await this.fetchVerifyBundle(agentId);
    const result = this.verifyPassport(bundle.passport, bundle.publicKeyJwk);
    return {
      ...result,
      passport: bundle.passport,
      publicKeyJwk: bundle.publicKeyJwk,
      didDocumentUrl: bundle.didDocumentUrl,
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
      const text = await response.text().catch(() => '');
      throw new PraesidiaApiError(response.status, path, text);
    }
    return response.json() as Promise<T>;
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
