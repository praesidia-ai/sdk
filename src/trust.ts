import { PraesidiaApiError } from './errors.js';
import { normalizeBaseUrl, resolveRequestTimeoutMs } from './client.js';
import {
  canonicalJson,
  ed25519PublicKeyFromJwk,
  verifyEd25519,
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
 * This is the "verify a peer agent's reputation WITHOUT trusting Praesidia"
 * client. It fetches the signed, W3C-Verifiable-Credential-shaped trust passport
 * from the PUBLIC (unauthenticated) trust routes and verifies the detached
 * Ed25519 proof LOCALLY against the org public key JWK — the same offline-verify
 * pattern as the `@praesidia/audit-verifier` package. A passing verification
 * means the aggregate reputation claims (trust score/level, posture, red-team
 * evidence, attestation & compliance summary) were signed by the issuing org's
 * key and have not been tampered with in transit.
 *
 * The routes are public, so no API key is needed:
 *   const trust = new PraesidiaTrust();
 *   const { passport, verified } = await trust.fetchAndVerify(peerAgentId);
 *   if (verified && passport.credentialSubject.trustScore >= 70) { ...trust... }
 *
 * The crypto lives in `crypto.ts` (hand-written, not part of any generated
 * client surface): `verifyEd25519`, `canonicalJson`, `ed25519PublicKeyFromJwk`.
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
      `/trust/passport/${encodeURIComponent(agentId)}`,
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
      `/trust/passport/${encodeURIComponent(agentId)}/verify`,
    );
  }

  /**
   * OFFLINE-verify a passport's detached Ed25519 proof against a public key JWK.
   *
   * Reconstructs the canonical JSON of the passport WITH its `proof` member
   * removed (RFC-8785-style, keys sorted lexicographically — byte-identical to
   * how be-core signed it), base64-decodes `proof.proofValue`, and verifies the
   * EdDSA signature directly over those raw bytes. Also checks `expirationDate`.
   *
   * Pure local computation — no network, no trust in Praesidia. Never throws;
   * a malformed passport / key yields `{ verified: false, reason }`.
   */
  verifyPassport(
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

    const publicKey = ed25519PublicKeyFromJwk(publicKeyJwk);
    if (!publicKey) {
      return {
        verified: false,
        signatureValid: false,
        expired: false,
        reason: 'malformed-public-key',
      };
    }

    // Sign-the-doc / attach-the-proof: strip `proof`, canonicalize the rest.
    const { proof: _proof, ...unsigned } = passport;
    const message = canonicalJson(unsigned);
    const signatureValid = verifyEd25519(
      message,
      proof.proofValue,
      publicKey,
    );

    const expiration = expirationState(passport.expirationDate);
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

/** True when an ISO-8601 expiry timestamp is in the past. */
function expirationState(
  expirationDate: string | undefined,
): 'valid' | 'expired' | 'invalid' {
  if (!expirationDate) return 'invalid';
  const t = Date.parse(expirationDate);
  if (Number.isNaN(t)) return 'invalid';
  return t < Date.now() ? 'expired' : 'valid';
}
