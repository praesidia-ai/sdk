import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';

import { canonicalJson } from './crypto.js';
import { PraesidiaTrust } from './trust.js';
import type { AiSystemTrustPassport, TrustPassport } from './types.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

// SDK-0363 / ADR-0004 / AV-0018 contract: format 2 signs
// ASCII("praesidia:" + purpose + ":v2\n") || canonical(passport without proof).

const ISSUED = '2026-09-28T00:00:00.000Z';
const ISSUER = 'did:web:praesidia.ai:orgs:org-1';
const envelope = (type: string, subjectId: string) => ({
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential', type],
  id: `https://api.praesidia.ai/trust/passport/x#${ISSUED}`,
  issuer: ISSUER,
  issuanceDate: ISSUED,
  expirationDate: '2999-01-01T00:00:00.000Z',
  subjectId,
});
const attestations = {
  activeCount: 1,
  identityVerified: true,
  guardrailsActive: true,
  auditTrailEnabled: true,
  spendCapConfigured: false,
};

function agentUnsigned(): Omit<TrustPassport, 'proof'> {
  const { subjectId, ...env } = envelope('TrustPassport', 'did:web:praesidia.ai:agents:a-1');
  return {
    ...env,
    credentialSubject: {
      id: subjectId,
      agentName: 'Nova',
      trustLevel: 'TRUSTED',
      trustScore: 80,
      posture: { status: 'verified', expiresAt: null },
      redTeam: { completedRuns: 0, lastTestedAt: null },
      attestations,
      compliance: ['GDPR'],
    },
  };
}

function aiSystemUnsigned(): Omit<AiSystemTrustPassport, 'proof'> {
  const { subjectId, ...env } = envelope('AiSystemTrustPassport', 'did:web:praesidia.ai:ai-systems:s-1');
  const on = { available: true } as const;
  return {
    ...env,
    credentialSubject: {
      id: subjectId,
      aiSystemName: 'Fraud Triage',
      attestations,
      frameworks: ['GDPR'],
      posture: on,
      redTeam: on,
      regulatoryClassification: on,
      aibom: on,
      dataCategories: on,
      incidents: on,
      models: on,
      permissions: { available: false, reason: 'n/a' },
      evidenceRoot: on,
    },
  };
}

const P256_HALF_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n >> 1n;

/** The SDK accepts canonical low-S DER only; ECDSA is randomized, so re-sign. */
function lowSDer(message: Buffer, key: KeyObject): Buffer {
  for (;;) {
    const der = nodeSign('sha256', message, key);
    const s = der.subarray(6 + der[3]!); // 30 L 02 rl r 02 sl s
    if (BigInt(`0x${s.toString('hex')}`) <= P256_HALF_N) return der;
  }
}

type Alg = 'Ed25519' | 'ES256';
type Format = 1 | 2 | undefined | null | '2' | 3;

/** Sign like be: format 1 = canonical bytes; format 2 = purpose tag || canonical. */
function sign<T extends object>(
  unsigned: T,
  alg: Alg,
  opts: { format: Format; purpose?: string },
) {
  const { publicKey, privateKey } =
    alg === 'Ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const canonical = Buffer.from(canonicalJson(unsigned));
  const tagged = opts.purpose
    ? Buffer.concat([Buffer.from(`praesidia:${opts.purpose}:v2\n`, 'ascii'), canonical])
    : canonical;
  const signature =
    alg === 'Ed25519'
      ? nodeSign(null, tagged, privateKey)
      : lowSDer(tagged, privateKey);
  const proof: Record<string, unknown> = {
    type: alg === 'Ed25519' ? 'Ed25519Signature2020' : 'EcdsaSecp256r1Signature2019',
    created: ISSUED,
    proofPurpose: 'assertionMethod',
    verificationMethod: `${ISSUER}#key-1`,
    keyVersion: 1,
    proofValue: signature.toString('base64'),
  };
  if (opts.format !== undefined) proof['signatureFormat'] = opts.format;
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { passport: { ...unsigned, proof } as T & { proof: never }, jwk };
}

const trust = new PraesidiaTrust();
const verifyAgent = (p: unknown, jwk: Record<string, unknown>) =>
  trust.verifyPassport(p as TrustPassport, jwk);
const verifyAiSystem = (p: unknown, jwk: Record<string, unknown>) =>
  trust.verifyAiSystemPassport(p as AiSystemTrustPassport, jwk);

describe.each([
  ['agent passport', agentUnsigned, verifyAgent],
  ['AI System passport', aiSystemUnsigned, verifyAiSystem],
] as const)('%s signature formats (SDK-0363)', (_name, build, verify) => {
  describe.each(['Ed25519', 'ES256'] as const)('%s', (alg) => {
    it('format 1 (signatureFormat absent) verifies unchanged', () => {
      const { passport, jwk } = sign(build(), alg, { format: undefined });
      expect(verify(passport, jwk)).toEqual({
        verified: true,
        signatureValid: true,
        expired: false,
        reason: 'ok',
      });
    });

    it('explicit signatureFormat 1 verifies over the untagged bytes', () => {
      const { passport, jwk } = sign(build(), alg, { format: 1 });
      expect(verify(passport, jwk).reason).toBe('ok');
    });

    it('format 2 with purpose trust-passport verifies', () => {
      const { passport, jwk } = sign(build(), alg, { format: 2, purpose: 'trust-passport' });
      expect(verify(passport, jwk)).toMatchObject({ verified: true, reason: 'ok' });
    });

    it('format 2 signed with purpose governance-badge is signature-mismatch', () => {
      const { passport, jwk } = sign(build(), alg, { format: 2, purpose: 'governance-badge' });
      expect(verify(passport, jwk)).toMatchObject({
        verified: false,
        signatureValid: false,
        reason: 'signature-mismatch',
      });
    });

    it('a format-2 signature relabelled as format 1 (or unlabelled) fails', () => {
      const { passport, jwk } = sign(build(), alg, { format: 2, purpose: 'trust-passport' });
      for (const format of [1, undefined]) {
        const proof = { ...passport.proof, signatureFormat: format };
        expect(verify({ ...passport, proof }, jwk).reason).toBe('signature-mismatch');
      }
    });

    it('a format-1 signature relabelled as format 2 fails', () => {
      const { passport, jwk } = sign(build(), alg, { format: 1 });
      const proof = { ...passport.proof, signatureFormat: 2 };
      expect(verify({ ...passport, proof }, jwk).reason).toBe('signature-mismatch');
    });

    it.each([null, '2', 3] as const)('signatureFormat %j fails closed as malformed-passport', (format) => {
      const { passport, jwk } = sign(build(), alg, { format, purpose: 'trust-passport' });
      expect(verify(passport, jwk)).toMatchObject({
        verified: false,
        signatureValid: false,
        reason: 'malformed-passport',
      });
    });
  });
});

describe('fetchAndVerify accepts a format-2 passport under a pinned key (SDK-0363)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('verifies, and rejects a governance-badge-purpose signature', async () => {
    for (const [purpose, verified] of [
      ['trust-passport', true],
      ['governance-badge', false],
    ] as const) {
      const { passport, jwk } = sign(agentUnsigned(), 'Ed25519', { format: 2, purpose });
      globalThis.fetch = makeFetchMock([
        { status: 200, json: { passport, publicKeyJwk: jwk, verificationHint: 'h' } },
      ]);
      const result = await new PraesidiaTrust({ baseUrl: 'https://api.praesidia.ai' }).fetchAndVerify(
        'a-1',
        { trustedKeys: [jwk] },
      );
      expect(result.verified).toBe(verified);
    }
  });
});
