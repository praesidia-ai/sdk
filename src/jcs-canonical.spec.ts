import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  jcsCanonicalize,
  jcsCommitment,
  JcsCanonicalizationError,
  type JsonValue,
} from './jcs-canonical.js';

interface GoldenCase {
  name: string;
  description?: string;
  input?: unknown;
  canonicalUtf8?: string;
  sha256Hex?: string;
  expectThrow?: boolean;
  throwReasonContains?: string;
}

// SEC-PA01-11/TICKET-213 (mirrored) — deliberately NOT a static
// `import ... from '....json'`. A JSON-to-ESM import transform (esbuild,
// used by both tsc's bundler resolution and vitest) can emit the parsed
// JSON as a literal JS object initializer, and `{"__proto__": {...}, ...}`
// as an OBJECT-LITERAL property (not a runtime assignment) sets the
// object's prototype per the ECMAScript object-initializer special case,
// silently dropping the "proto-literal-key" fixture's own key — the exact
// trap this fixture case exists to catch, one level up the pipeline. A
// runtime `readFileSync` + `JSON.parse` uses `CreateDataProperty`, which
// has no such special case, so `__proto__` survives as an ordinary own key
// (this bit `be`'s own fixture-generation script during authoring — see
// the fixture file's own "number-negative-zero" case description for the
// sibling gotcha it documents).
const fixturesPath = fileURLToPath(
  new URL('./__fixtures__/jcs-golden-fixtures.json', import.meta.url),
);
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as {
  cases: GoldenCase[];
};
const cases = fixtures.cases;

/**
 * PA01 DoD 4 — byte-compare every non-throw fixture case, confirm every
 * `expectThrow` case raises. This is the ONE test that would catch a
 * TS/Python canonicalization disagreement before it silently breaks a
 * Permit binding (see the fixture file's own `notes` field and
 * `.claude/tickets/PA01-CONTRACT-action-fixtures.md`).
 */
describe('jcsCanonicalize / jcsCommitment — golden fixtures (PA-0003)', () => {
  for (const c of cases) {
    if (c.expectThrow) {
      it(`${c.name} — refuses`, () => {
        // The "non-finite-number-nan" case is represented as a sentinel
        // string in the on-disk JSON (NaN is not valid JSON); substitute
        // the real NaN before calling the implementation, exactly as the
        // fixture file's own `note` instructs.
        const input =
          c.name === 'non-finite-number-nan'
            ? ({ n: NaN } as unknown as JsonValue)
            : (c.input as JsonValue);
        expect(() => jcsCanonicalize(input)).toThrow(JcsCanonicalizationError);
        if (c.throwReasonContains) {
          expect(() => jcsCanonicalize(input)).toThrow(c.throwReasonContains);
        }
      });
    } else {
      it(`${c.name} — byte-compares canonicalUtf8 + sha256Hex`, () => {
        const input = c.input as JsonValue;
        const bytes = jcsCanonicalize(input);
        expect(bytes.toString('utf8')).toBe(c.canonicalUtf8);
        expect(jcsCommitment(input)).toBe(c.sha256Hex);
      });
    }
  }
});

/**
 * The fixture file's own note: its on-disk `-0` text cannot be trusted to
 * survive a generic JSON-loading pipeline with the sign bit intact, so this
 * module additionally unit-tests in-memory `-0` handling directly.
 */
describe('jcsCanonicalize — in-memory -0 handling', () => {
  it('negative zero literal serializes as "0"', () => {
    const bytes = jcsCanonicalize({ n: -0 });
    expect(bytes.toString('utf8')).toBe('{"n":0}');
  });
});

describe('jcsCanonicalize — additional refusals not in the shared fixture set', () => {
  it('throws on a top-level undefined', () => {
    expect(() =>
      jcsCanonicalize(undefined as unknown as JsonValue),
    ).toThrow(JcsCanonicalizationError);
  });

  it('throws on Infinity', () => {
    expect(() => jcsCanonicalize({ n: Infinity } as unknown as JsonValue)).toThrow(
      JcsCanonicalizationError,
    );
  });

  it('throws on a Date value', () => {
    expect(() =>
      jcsCanonicalize({ d: new Date() } as unknown as JsonValue),
    ).toThrow(JcsCanonicalizationError);
  });

  it('throws on a Buffer value', () => {
    expect(() =>
      jcsCanonicalize({ b: Buffer.from('x') } as unknown as JsonValue),
    ).toThrow(JcsCanonicalizationError);
  });

  it('throws on a BigInt value', () => {
    expect(() =>
      jcsCanonicalize({ b: 10n } as unknown as JsonValue),
    ).toThrow(JcsCanonicalizationError);
  });
});
