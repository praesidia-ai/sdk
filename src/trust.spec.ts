import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createHash,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from 'node:crypto';
import { PraesidiaTrust, jwkThumbprint, jwkThumbprintHex } from './trust.js';
import { PraesidiaApiError } from './errors.js';
import {
  canonicalJson,
  ed25519PublicKeyFromJwk,
  p256PublicKeyFromJwk,
  verifyEd25519,
  verifyEs256,
} from './crypto.js';
import type {
  AiSystemTrustPassport,
  AiSystemTrustPassportVerifyBundle,
  TrustPassport,
} from './types.js';
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
    // MCPSDK-04 — this assertion used to pass with NO anchor, which was the
    // bug: the key came from the same response. It now needs a pinned key.
    const result = await trust.fetchAndVerify('agent-1', {
      trustedKeys: [publicKeyJwk],
    });

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

  // ── fetchAndVerify trust anchor (SEC-2026-09-12 MCPSDK-04) ─────────────────

  function mockBundle(bundleParts: {
    passport: TrustPassport;
    publicKeyJwk: Record<string, unknown>;
  }) {
    globalThis.fetch = makeFetchMock([
      {
        ok: true,
        status: 200,
        json: {
          ...bundleParts,
          didDocumentUrl:
            'https://api.praesidia.ai/agents/agent-1/did.json',
        },
      },
    ]);
    return new PraesidiaTrust({ baseUrl: 'https://api.praesidia.ai' });
  }

  it('fetchAndVerify without an anchor refuses to call the result verified', async () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    const trust = mockBundle({ passport, publicKeyJwk });

    const result = await trust.fetchAndVerify('agent-1');

    // The key came from the same unauthenticated GET as the passport, so the
    // signature check proves integrity only — never authenticity.
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('unpinned_key');
    // ...but the signature state stays truthful so callers can tell a mangled
    // passport from an unpinned one.
    expect(result.signatureValid).toBe(true);
    expect(result.expired).toBe(false);
    expect(result.publicKeyJwk).toEqual(publicKeyJwk);
  });

  it('fetchAndVerify without an anchor still reports a broken signature honestly', async () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    const tampered = {
      ...passport,
      credentialSubject: { ...passport.credentialSubject, trustScore: 99 },
    };
    const trust = mockBundle({ passport: tampered, publicKeyJwk });

    const result = await trust.fetchAndVerify('agent-1');

    expect(result.verified).toBe(false);
    expect(result.signatureValid).toBe(false);
    expect(result.reason).toBe('signature-mismatch');
  });

  it('fetchAndVerify verifies against a matching trustedKeys anchor', async () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    const trust = mockBundle({ passport, publicKeyJwk });

    const result = await trust.fetchAndVerify('agent-1', {
      trustedKeys: [publicKeyJwk],
    });

    expect(result).toMatchObject({
      verified: true,
      signatureValid: true,
      expired: false,
      reason: 'ok',
    });
  });

  it('fetchAndVerify accepts the map form of trustedKeys', async () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    const other = makeKeypairAndPassport().publicKeyJwk;
    const trust = mockBundle({ passport, publicKeyJwk });

    const result = await trust.fetchAndVerify('agent-1', {
      trustedKeys: { 'key-0': other, 'key-1': publicKeyJwk },
    });

    expect(result.verified).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('fetchAndVerify rejects a passport signed by a key outside the anchor', async () => {
    // The attacker controls the response: passport + matching key are both
    // theirs. Under the old code this returned verified: true.
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    const trustedKey = makeKeypairAndPassport().publicKeyJwk;
    const trust = mockBundle({ passport, publicKeyJwk });

    const result = await trust.fetchAndVerify('agent-1', {
      trustedKeys: [trustedKey],
    });

    expect(result.verified).toBe(false);
    expect(result.signatureValid).toBe(false);
    expect(result.reason).toBe('untrusted_key');
  });

  it('fetchAndVerify treats an empty trustedKeys list as a failed anchor, not an absent one', async () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    const trust = mockBundle({ passport, publicKeyJwk });

    const result = await trust.fetchAndVerify('agent-1', { trustedKeys: [] });

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('untrusted_key');
  });

  it('fetchAndVerify keeps the expiry reason when the anchor key matches', async () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport(
      '2026-07-07T00:00:00.000Z',
    );
    const trust = mockBundle({ passport, publicKeyJwk });

    const result = await trust.fetchAndVerify('agent-1', {
      trustedKeys: [publicKeyJwk],
    });

    expect(result).toMatchObject({
      verified: false,
      signatureValid: true,
      expired: true,
      reason: 'expired',
    });
  });

  it('fetchAndVerify accepts a matching expectedFingerprint (base64url and hex)', async () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();

    for (const fingerprint of [
      jwkThumbprint(publicKeyJwk) as string,
      jwkThumbprintHex(publicKeyJwk) as string,
      `sha256:${jwkThumbprintHex(publicKeyJwk) as string}`,
    ]) {
      const trust = mockBundle({ passport, publicKeyJwk });
      const result = await trust.fetchAndVerify('agent-1', {
        expectedFingerprint: fingerprint,
      });
      expect(result.verified).toBe(true);
      expect(result.reason).toBe('ok');
    }
  });

  it('fetchAndVerify rejects a served key whose fingerprint is not the pinned one', async () => {
    const { passport, publicKeyJwk } = makeKeypairAndPassport();
    const pinned = jwkThumbprint(
      makeKeypairAndPassport().publicKeyJwk,
    ) as string;
    const trust = mockBundle({ passport, publicKeyJwk });

    const result = await trust.fetchAndVerify('agent-1', {
      expectedFingerprint: pinned,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('fingerprint_mismatch');
    // The served key does sign this passport — that is exactly why the
    // self-referential check was worthless.
    expect(result.signatureValid).toBe(true);
  });

  it('jwkThumbprint is the RFC 7638 SHA-256 thumbprint and is null for unusable keys', () => {
    const { publicKeyJwk } = makeKeypairAndPassport();
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          crv: publicKeyJwk['crv'],
          kty: 'OKP',
          x: publicKeyJwk['x'],
        }),
      )
      .digest();
    expect(jwkThumbprint(publicKeyJwk)).toBe(expected.toString('base64url'));
    expect(jwkThumbprintHex(publicKeyJwk)).toBe(expected.toString('hex'));
    expect(jwkThumbprint({ kty: 'RSA', n: 'x', e: 'AQAB' })).toBeNull();
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

  // ── SDK-0306: AI System trust-passport PDF (BE-0541, binary response) ─────

  it('fetchAiSystemPassportPdf returns the exact PDF bytes, unauthenticated', async () => {
    // A real PDF header + the high-bit "binary marker" comment line: any
    // text/JSON decode on the way through would corrupt these bytes.
    const pdf = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, // %PDF-1.7\n
      0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x00, 0xff,
    ]);
    globalThis.fetch = makeFetchMock([{ ok: true, status: 200, bytes: pdf }]);

    const trust = new PraesidiaTrust({ baseUrl: 'https://api.praesidia.ai' });
    const bytes = await trust.fetchAiSystemPassportPdf('sys-1');

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual(Array.from(pdf));
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.praesidia.ai/trust/passport/ai-systems/sys-1/passport.pdf',
    );
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Accept']).toBe('application/pdf');
  });

  it('fetchAiSystemPassportPdf raises PraesidiaApiError with the parsed JSON error envelope', async () => {
    // be's http-exception.filter envelope for an unknown AI System.
    globalThis.fetch = makeFetchMock([
      {
        ok: false,
        status: 404,
        json: {
          statusCode: 404,
          path: '/trust/passport/ai-systems/nope/passport.pdf',
          method: 'GET',
          requestId: 'req-404',
          message: 'AI System not found',
        },
      },
    ]);

    const trust = new PraesidiaTrust();
    const err = await trust.fetchAiSystemPassportPdf('nope').catch((e) => e);

    expect(err).toBeInstanceOf(PraesidiaApiError);
    expect(err.status).toBe(404);
    expect(err.requestId).toBe('req-404');
    expect(err.body?.message).toBe('AI System not found');
    expect(err.retryable).toBe(false);
  });

  // ── SDK-0307: AI System trust passport JSON + badge routes (BE-0540) ──────

  const aiSystemPassport: AiSystemTrustPassport = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential', 'AiSystemTrustPassport'],
    id: 'https://api.praesidia.ai/trust/passport/ai-systems/sys-1#2026-09-22T00:00:00.000Z',
    issuer: 'did:web:praesidia.ai:orgs:org-1',
    issuanceDate: '2026-09-22T00:00:00.000Z',
    expirationDate: '2026-09-23T00:00:00.000Z',
    credentialSubject: {
      id: 'did:web:praesidia.ai:ai-systems:sys-1',
      aiSystemName: 'Fraud Triage',
      posture: { available: true, counts: { verified: 2 }, updatedAt: null },
      redTeam: { available: false, reason: 'AISYS-0031' },
      attestations: {
        activeCount: 2,
        identityVerified: true,
        guardrailsActive: true,
        auditTrailEnabled: true,
        spendCapConfigured: false,
      },
      frameworks: ['EU-AI-Act'],
      regulatoryClassification: { available: true, counts: { high: 1 } },
      aibom: { available: true, digest: 'sha256:abc', version: 3 },
      dataCategories: { available: true, counts: {} },
      incidents: { available: true, counts: { open: 0 } },
      models: { available: true, counts: { openai: 1 } },
      permissions: { available: false, reason: 'AISYS-0040' },
      evidenceRoot: { available: false, reason: 'AISYS-0041' },
    },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2026-09-22T00:00:00.000Z',
      proofPurpose: 'assertionMethod',
      verificationMethod: 'did:web:praesidia.ai:orgs:org-1#key-1',
      keyVersion: 1,
      proofValue: 'c2ln',
    },
  };

  function lastCall(): [string, Record<string, string>] {
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    return [url, init.headers as Record<string, string>];
  }

  it('fetchAiSystemPassport returns the typed passport, unauthenticated', async () => {
    globalThis.fetch = makeFetchMock([{ status: 200, json: aiSystemPassport }]);

    const trust = new PraesidiaTrust({ baseUrl: 'https://api.praesidia.ai' });
    const passport = await trust.fetchAiSystemPassport('sys 1');

    expect(passport).toEqual(aiSystemPassport);
    expect(passport.credentialSubject.aibom.digest).toBe('sha256:abc');
    const [url, headers] = lastCall();
    expect(url).toBe('https://api.praesidia.ai/trust/passport/ai-systems/sys%201');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Accept']).toBe('application/json');
  });

  it('fetchAiSystemVerifyBundle returns passport + JWK + hint + embed, unauthenticated', async () => {
    const bundle: AiSystemTrustPassportVerifyBundle = {
      passport: aiSystemPassport,
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' },
      verificationHint: 'Import publicKeyJwk as an OKP Ed25519 key (alg: EdDSA).',
      embed: {
        badgeUrl: 'https://api.praesidia.ai/trust/passport/ai-systems/sys-1/badge.svg',
        verifyUrl: 'https://api.praesidia.ai/trust/passport/ai-systems/sys-1/verify',
        html: '<a href="…"><img src="…" /></a>',
        markdown: '[![…](…)](…)',
      },
    };
    globalThis.fetch = makeFetchMock([{ status: 200, json: bundle }]);

    const trust = new PraesidiaTrust({ baseUrl: 'https://api.praesidia.ai' });
    expect(await trust.fetchAiSystemVerifyBundle('sys-1')).toEqual(bundle);
    const [url, headers] = lastCall();
    expect(url).toBe(
      'https://api.praesidia.ai/trust/passport/ai-systems/sys-1/verify',
    );
    expect(headers['Authorization']).toBeUndefined();
  });

  it('fetchAiSystemBadgeSvg returns the SVG markup as a string, unauthenticated', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20"><text>EU AI Act · high</text></svg>';
    globalThis.fetch = makeFetchMock([{ status: 200, text: svg }]);

    const trust = new PraesidiaTrust({ baseUrl: 'https://api.praesidia.ai' });
    expect(await trust.fetchAiSystemBadgeSvg('sys-1')).toBe(svg);
    const [url, headers] = lastCall();
    expect(url).toBe(
      'https://api.praesidia.ai/trust/passport/ai-systems/sys-1/badge.svg',
    );
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Accept']).toBe('image/svg+xml');
  });

  it.each([
    ['fetchAiSystemPassport', ''],
    ['fetchAiSystemVerifyBundle', '/verify'],
    ['fetchAiSystemBadgeSvg', '/badge.svg'],
  ] as const)('%s raises a typed PraesidiaApiError on 404', async (method, suffix) => {
    // be's http-exception.filter envelope; message from AiSystemTrustPassportService.
    globalThis.fetch = makeFetchMock([
      {
        status: 404,
        json: {
          statusCode: 404,
          path: `/trust/passport/ai-systems/nope${suffix}`,
          method: 'GET',
          requestId: 'req-404',
          message: 'Trust passport not found',
        },
      },
    ]);

    const err = await new PraesidiaTrust()[method]('nope').catch((e) => e);

    expect(err).toBeInstanceOf(PraesidiaApiError);
    expect(err.status).toBe(404);
    expect(err.requestId).toBe('req-404');
    expect(err.body?.message).toBe('Trust passport not found');
    expect(err.retryable).toBe(false);
  });

  it('fetchAiSystemVerifyBundle surfaces be 503 (signing-key lookup failed) as retryable', async () => {
    globalThis.fetch = makeFetchMock([
      { status: 503, json: { statusCode: 503, message: 'Service Unavailable' } },
    ]);

    const err = await new PraesidiaTrust()
      .fetchAiSystemVerifyBundle('sys-1')
      .catch((e) => e);

    expect(err).toBeInstanceOf(PraesidiaApiError);
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });
});
