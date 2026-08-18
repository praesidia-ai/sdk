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
  p256PublicKeyFromJwk,
  verifyEd25519,
  verifyEs256,
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

const P256_N = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);

function parseEcdsaDer(signature: Buffer): { r: bigint; s: bigint } {
  const rLength = signature[3]!;
  const rStart = 4;
  const rEnd = rStart + rLength;
  const sLength = signature[rEnd + 1]!;
  const sStart = rEnd + 2;
  return {
    r: BigInt(`0x${signature.subarray(rStart, rEnd).toString('hex')}`),
    s: BigInt(
      `0x${signature.subarray(sStart, sStart + sLength).toString('hex')}`,
    ),
  };
}

function encodeDerInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  let magnitude = Buffer.from(hex, 'hex');
  if ((magnitude[0]! & 0x80) !== 0) {
    magnitude = Buffer.concat([Buffer.from([0]), magnitude]);
  }
  return Buffer.concat([Buffer.from([0x02, magnitude.length]), magnitude]);
}

function encodeEcdsaDer(r: bigint, s: bigint): Buffer {
  const body = Buffer.concat([encodeDerInteger(r), encodeDerInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function canonicalP256Signature(message: Uint8Array, privateKey: KeyObject) {
  const signature = nodeSign('sha256', Buffer.from(message), privateKey);
  const { r, s } = parseEcdsaDer(signature);
  return s <= P256_N / 2n ? signature : encodeEcdsaDer(r, P256_N - s);
}

function makeP256KeypairAndPassport() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const publicKeyJwk = {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    use: 'sig',
    alg: 'ES256',
  };
  const unsigned = buildUnsignedPassport();
  const message = canonicalJson(unsigned);
  const signature = canonicalP256Signature(message, privateKey);
  const passport: TrustPassport = {
    ...unsigned,
    proof: {
      type: 'EcdsaSecp256r1Signature2019',
      created: '2026-07-06T00:00:00.000Z',
      proofPurpose: 'assertionMethod',
      verificationMethod: 'did:web:praesidia.ai:orgs:org-1#key-1',
      keyVersion: 1,
      proofValue: signature.toString('base64'),
    },
  };
  return { passport, publicKeyJwk, privateKey, message, signature };
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

  it('ed25519PublicKeyFromJwk rejects non-canonical base64url coordinates', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    expect(ed25519PublicKeyFromJwk({ ...jwk, x: `${String(jwk['x'])}!` })).toBeNull();
    expect(ed25519PublicKeyFromJwk({ ...jwk, alg: 'ES256' })).toBeNull();
    expect(ed25519PublicKeyFromJwk({ ...jwk, d: 'private' })).toBeNull();
  });

  it('validates a P-256 JWK and verifies a canonical KMS-style ES256 signature', () => {
    const { publicKeyJwk, message, signature } = makeP256KeypairAndPassport();
    const spki = p256PublicKeyFromJwk(publicKeyJwk);
    expect(spki).not.toBeNull();
    expect(verifyEs256(message, signature.toString('base64'), spki!)).toBe(
      true,
    );
    expect(
      verifyEs256(Buffer.from('tampered'), signature.toString('base64'), spki!),
    ).toBe(false);
  });

  it('rejects malformed or algorithm-confused P-256 JWKs', () => {
    const { publicKeyJwk } = makeP256KeypairAndPassport();
    expect(p256PublicKeyFromJwk({ ...publicKeyJwk, alg: 'EdDSA' })).toBeNull();
    expect(p256PublicKeyFromJwk({ ...publicKeyJwk, use: 'enc' })).toBeNull();
    expect(p256PublicKeyFromJwk({ ...publicKeyJwk, d: 'private' })).toBeNull();
    expect(p256PublicKeyFromJwk({ ...publicKeyJwk, x: 'bad' })).toBeNull();
  });

  it('rejects a mathematically valid but malleable high-s ES256 signature', () => {
    const { publicKeyJwk, message, signature } = makeP256KeypairAndPassport();
    const { r, s } = parseEcdsaDer(signature);
    const highS = encodeEcdsaDer(r, P256_N - s);
    const spki = p256PublicKeyFromJwk(publicKeyJwk)!;
    expect(verifyEs256(message, highS.toString('base64'), spki)).toBe(false);
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
    expect(verifyEd25519(msg, `${sig}!`, raw)).toBe(false);
  });
});

describe('PraesidiaTrust', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
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

  it('verifies a genuine KMS-backed P-256/ES256 passport', () => {
    const { passport, publicKeyJwk } = makeP256KeypairAndPassport();
    expect(new PraesidiaTrust().verifyPassport(passport, publicKeyJwk)).toEqual({
      verified: true,
      signatureValid: true,
      expired: false,
      reason: 'ok',
    });
  });

  it('fails closed when the proof type and public-key algorithm disagree', () => {
    const { passport, publicKeyJwk } = makeP256KeypairAndPassport();
    passport.proof.type = 'Ed25519Signature2020';
    const result = new PraesidiaTrust().verifyPassport(passport, publicKeyJwk);
    expect(result.verified).toBe(false);
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
      '2026-07-07T00:00:00.000Z',
    );
    const trust = new PraesidiaTrust();
    const result = trust.verifyPassport(passport, publicKeyJwk);
    expect(result.signatureValid).toBe(true);
    expect(result.expired).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('treats a passport expiring at the current instant as expired', () => {
    vi.useFakeTimers();
    const now = new Date('2030-01-01T00:00:00.000Z');
    vi.setSystemTime(now);
    const { passport, publicKeyJwk } = makeKeypairAndPassport(now.toISOString());
    const result = new PraesidiaTrust().verifyPassport(passport, publicKeyJwk);
    expect(result.signatureValid).toBe(true);
    expect(result.expired).toBe(true);
    expect(result.reason).toBe('expired');
  });

  it('verifyPassport fails closed for a signed but malformed expiration date', () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport('not-a-date');
    const result = new PraesidiaTrust().verifyPassport(passport, publicKeyJwk);
    expect(result.signatureValid).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('invalid-expiration');
  });

  it('rejects a non-canonical or pre-issuance expiration timestamp', () => {
    for (const expirationDate of [
      '2999-07-07T02:00:00+02:00',
      '2000-01-01T00:00:00.000Z',
    ]) {
      const { passport, publicKeyJwk } = makeKeypairAndPassport(expirationDate);
      const result = new PraesidiaTrust().verifyPassport(
        passport,
        publicKeyJwk,
      );
      expect(result.signatureValid).toBe(true);
      expect(result.reason).toBe('invalid-expiration');
    }
  });

  it('rejects malformed signed credential-subject summaries', () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    passport.credentialSubject.attestations.activeCount = -1;
    expect(
      new PraesidiaTrust().verifyPassport(passport, publicKeyJwk),
    ).toMatchObject({
      verified: false,
      signatureValid: false,
      reason: 'malformed-passport',
    });
  });

  it('verifyPassport returns malformed-public-key for a bad JWK', () => {
    const { passport } = makeKeypairAndPassport();
    const trust = new PraesidiaTrust();
    const result = trust.verifyPassport(passport, { kty: 'RSA' });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('malformed-public-key');
  });

  it('verifyPassport reports a missing proof without throwing', () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    delete (passport as Partial<TrustPassport>).proof;
    expect(new PraesidiaTrust().verifyPassport(passport, publicKeyJwk)).toEqual({
      verified: false,
      signatureValid: false,
      expired: false,
      reason: 'missing-proof',
    });
  });

  it.each([
    ['proofPurpose', 'authentication'],
    ['created', '2026-07-06T00:00:01.000Z'],
    ['keyVersion', 0],
    ['verificationMethod', 'did:web:attacker.example#key-1'],
  ] as const)(
    'rejects tampered detached-proof metadata: %s',
    (field, value) => {
      const { passport, publicKeyJwk } = makeKeypairAndPassport();
      (passport.proof as unknown as Record<string, unknown>)[field] = value;
      expect(
        new PraesidiaTrust().verifyPassport(passport, publicKeyJwk),
      ).toMatchObject({
        verified: false,
        signatureValid: false,
        reason: 'malformed-passport',
      });
    },
  );

  it('verifyPassport rejects a non-canonical base64 proof', () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    passport.proof.proofValue += '!';
    const result = new PraesidiaTrust().verifyPassport(passport, publicKeyJwk);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('signature-mismatch');
  });

  it('verifyPassport never throws for a malformed cyclic passport', () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    (passport as unknown as Record<string, unknown>)['cyclic'] = cyclic;

    expect(
      new PraesidiaTrust().verifyPassport(passport, publicKeyJwk),
    ).toEqual({
      verified: false,
      signatureValid: false,
      expired: false,
      reason: 'malformed-passport',
    });
  });

  it('verifyPassport never throws when hostile object accessors throw', () => {
    const passport = Object.defineProperty({}, 'proof', {
      get() {
        throw new Error('hostile getter');
      },
    }) as TrustPassport;
    expect(new PraesidiaTrust().verifyPassport(passport, {})).toEqual({
      verified: false,
      signatureValid: false,
      expired: false,
      reason: 'malformed-passport',
    });
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
