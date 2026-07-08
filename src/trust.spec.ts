import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from 'node:crypto';
import { PraesidiaTrust } from './trust.js';
import { PraesidiaApiError } from './errors.js';
import {
  canonicalJson,
  ed25519PublicKeyFromJwk,
  verifyEd25519,
} from './crypto.js';
import type { TrustPassport } from './types.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

// ---------------------------------------------------------------------------
// Fixture: mint a real Ed25519 keypair and sign a passport exactly like be-core
// (sign the canonical JSON of the doc WITHOUT its proof member; base64 sig;
// public key exported as an OKP/Ed25519 JWK).
// ---------------------------------------------------------------------------

function buildUnsignedPassport(): Omit<TrustPassport, 'proof'> {
  return {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://praesidia.ai/credentials/trust-passport/v1',
    ],
    type: ['VerifiableCredential', 'TrustPassport'],
    id: 'https://api.praesidia.ai/trust/passport/agent-1#2026-07-06T00:00:00.000Z',
    issuer: 'did:web:praesidia.ai:orgs:org-1',
    issuanceDate: '2026-07-06T00:00:00.000Z',
    expirationDate: '2999-07-07T00:00:00.000Z',
    credentialSubject: {
      id: 'did:web:praesidia.ai:agents:agent-1',
      agentName: 'Nova',
      trustLevel: 'TRUSTED',
      trustScore: 87,
      posture: { status: 'verified', expiresAt: null },
      redTeam: { completedRuns: 3, lastTestedAt: null },
      attestations: {
        activeCount: 2,
        identityVerified: true,
        guardrailsActive: true,
        auditTrailEnabled: true,
        spendCapConfigured: true,
      },
      compliance: ['EU-AI-Act', 'GDPR'],
    },
  };
}

function signPassport(
  unsigned: Omit<TrustPassport, 'proof'>,
  privateKey: KeyObject,
  expirationDate?: string,
): { passport: TrustPassport; publicKeyJwk: Record<string, unknown> } {
  const doc = expirationDate ? { ...unsigned, expirationDate } : unsigned;
  const message = Buffer.from(canonicalJson(doc));
  const signature = nodeSign(null, message, privateKey).toString('base64');
  const passport: TrustPassport = {
    ...doc,
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-07-06T00:00:00.000Z',
      proofPurpose: 'assertionMethod',
      verificationMethod: 'did:web:praesidia.ai:orgs:org-1#key-1',
      keyVersion: 1,
      proofValue: signature,
    },
  };
  return { passport, publicKeyJwk: {} };
}

function makeKeypairAndPassport(expirationDate?: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyJwk = publicKey.export({ format: 'jwk' }) as Record<
    string,
    unknown
  >;
  const { passport } = signPassport(
    buildUnsignedPassport(),
    privateKey,
    expirationDate,
  );
  return { passport, publicKeyJwk, privateKey };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('crypto helpers (offline verify)', () => {
  it('ed25519PublicKeyFromJwk decodes a well-formed OKP JWK to 32 raw bytes', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const raw = ed25519PublicKeyFromJwk(jwk);
    expect(raw).not.toBeNull();
    expect(raw!.length).toBe(32);
  });

  it('ed25519PublicKeyFromJwk rejects a non-Ed25519 JWK', () => {
    expect(
      ed25519PublicKeyFromJwk({ kty: 'EC', crv: 'P-256', x: 'abc' }),
    ).toBeNull();
    expect(ed25519PublicKeyFromJwk({})).toBeNull();
    expect(ed25519PublicKeyFromJwk(null)).toBeNull();
  });

  it('canonicalJson sorts object keys (byte-stable)', () => {
    const bytes = canonicalJson({ b: 1, a: 2, '@c': 3 });
    expect(Buffer.from(bytes).toString('utf8')).toBe('{"@c":3,"a":2,"b":1}');
  });

  it('verifyEd25519 rejects a tampered message', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const raw = ed25519PublicKeyFromJwk(jwk)!;
    const msg = Buffer.from('hello', 'utf8');
    const sig = nodeSign(null, msg, privateKey).toString('base64');
    expect(verifyEd25519(msg, sig, raw)).toBe(true);
    expect(verifyEd25519(Buffer.from('hell0', 'utf8'), sig, raw)).toBe(false);
  });
});

describe('PraesidiaTrust', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── verifyPassport (offline) ────────────────────────────────────────────────

  it('verifyPassport returns verified=true for a genuine signature', () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    const trust = new PraesidiaTrust();
    const result = trust.verifyPassport(passport, publicKeyJwk);
    expect(result.verified).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('verifyPassport returns signature-mismatch when the passport is tampered', () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    // Mutate a signed field — the detached proof must no longer verify.
    passport.credentialSubject.trustScore = 100;
    const trust = new PraesidiaTrust();
    const result = trust.verifyPassport(passport, publicKeyJwk);
    expect(result.verified).toBe(false);
    expect(result.signatureValid).toBe(false);
    expect(result.reason).toBe('signature-mismatch');
  });

  it('verifyPassport fails closed against the WRONG public key', () => {
    const { passport } = makeKeypairAndPassport();
    const { publicKey: otherPub } = generateKeyPairSync('ed25519');
    const otherJwk = otherPub.export({ format: 'jwk' }) as Record<
      string,
      unknown
    >;
    const trust = new PraesidiaTrust();
    expect(trust.verifyPassport(passport, otherJwk).verified).toBe(false);
  });

  it('verifyPassport reports expired for a valid signature past expiry', () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport(
      '2000-01-01T00:00:00.000Z',
    );
    const trust = new PraesidiaTrust();
    const result = trust.verifyPassport(passport, publicKeyJwk);
    expect(result.signatureValid).toBe(true);
    expect(result.expired).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('verifyPassport returns malformed-public-key for a bad JWK', () => {
    const { passport } = makeKeypairAndPassport();
    const trust = new PraesidiaTrust();
    const result = trust.verifyPassport(passport, { kty: 'RSA' });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('malformed-public-key');
  });

  // ── fetchAndVerify ──────────────────────────────────────────────────────────

  it('fetchAndVerify GETs the public verify route and verifies offline', async () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    const bundle = {
      passport,
      publicKeyJwk,
      didDocumentUrl: 'https://api.praesidia.ai/agents/agent-1/did.json',
      verificationHint: 'Import publicKeyJwk...',
    };
    globalThis.fetch = makeFetchMock([{ ok: true, status: 200, json: bundle }]);

    const trust = new PraesidiaTrust({ baseUrl: 'https://api.praesidia.ai' });
    const result = await trust.fetchAndVerify('agent-1');

    expect(result.verified).toBe(true);
    expect(result.passport.credentialSubject.agentName).toBe('Nova');
    expect(result.didDocumentUrl).toContain('/agents/agent-1/did.json');

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.praesidia.ai/trust/passport/agent-1/verify');
    // Public route — no Authorization header is sent.
    expect(
      (init.headers as Record<string, string>)['Authorization'],
    ).toBeUndefined();
  });

  it('fetchPassport surfaces a 404 as PraesidiaApiError', async () => {
    globalThis.fetch = makeFetchMock([
      { ok: false, status: 404, text: 'not found' },
    ]);

    const trust = new PraesidiaTrust();
    await expect(trust.fetchPassport('nope')).rejects.toThrow(
      PraesidiaApiError,
    );
  });
});
