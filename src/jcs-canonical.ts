/**
 * PA01 D2/D18 — RFC 8785 JSON Canonicalization Scheme, ported from the
 * reference implementation `be/src/protected-actions/utils/jcs-canonical.ts`
 * per `.claude/tickets/PA01-CONTRACT-action-fixtures.md`. Byte-compared
 * against the SAME golden fixtures `be` publishes
 * (`__fixtures__/jcs-golden-fixtures.json`, copied verbatim — see
 * `jcs-canonical.spec.ts`).
 *
 * This is a SEPARATE module from `crypto.ts`'s `canonicalJson` — that one
 * mirrors be-core's FROZEN `common/security/utils/canonical-json.ts` (used
 * for trust-passport signature verification) and deliberately COERCES
 * `undefined`/non-finite numbers/etc. This module is the NEW, stricter D2
 * profile used only for the protected-action request commitment: it THROWS
 * (never silently coerces) on anything not representable as strict JSON, per
 * corrigendum C2 / SEC-PA01-03/11. Do not merge the two — that was the exact
 * mistake C2 corrected in `be`.
 *
 * PA01 D8/D11 (scope correction, `.claude/backlog/PA-0013.md`): this SDK
 * version does not yet use this module to bind a client-side Permit — the
 * managed MCP path computes the ONE authoritative commitment edge-side
 * (D2). It is ported now so a TS/Python canonicalization disagreement is
 * caught by a byte-compare test (this ticket's DoD 4) before EDGE-003 (the
 * customer-controlled Proof Edge, out of PA01 scope) ever needs an
 * SDK-computed commitment for real.
 */

import { createHash } from 'node:crypto';

export class JcsCanonicalizationError extends Error {
  constructor(message: string) {
    super(`JCS canonicalization refused: ${message}`);
    this.name = 'JcsCanonicalizationError';
    Object.setPrototypeOf(this, JcsCanonicalizationError.prototype);
  }
}

/** A value producible by `JSON.parse`, and nothing else. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    if (isHighSurrogate) {
      const next = s.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i++; // consumed as a valid pair
    } else if (isLowSurrogate) {
      // A low surrogate not immediately preceded by a consumed high
      // surrogate is itself unpaired.
      return true;
    }
  }
  return false;
}

function canonicalize(v: JsonValue | undefined): string {
  if (v === undefined) {
    throw new JcsCanonicalizationError(
      'undefined is not a valid JSON value (top level, object value, or array element)',
    );
  }
  if (v === null) {
    return 'null';
  }
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new JcsCanonicalizationError(
        `non-finite number is not valid JSON: ${String(v)}`,
      );
    }
    // RFC 8785 §3.2.2.3 (ECMAScript Number::toString), including -0 -> "0" —
    // exactly what V8's JSON.stringify/String(number) already implement.
    return JSON.stringify(v);
  }
  if (typeof v === 'string') {
    if (hasUnpairedSurrogate(v)) {
      throw new JcsCanonicalizationError(
        'string contains an unpaired UTF-16 surrogate, which cannot be ' +
          'encoded to well-formed UTF-8 without a lossy substitution',
      );
    }
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return '[' + v.map((el) => canonicalize(el)).join(',') + ']';
  }
  if (typeof v === 'object') {
    if (v instanceof Date) {
      throw new JcsCanonicalizationError(
        'Date is not a JSON value — pass an explicit ISO string instead',
      );
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) {
      throw new JcsCanonicalizationError(
        'Buffer is not a JSON value — pass an explicit base64 string instead',
      );
    }
    // TICKET-213 precedent (mirrored from be's canonical-json.ts /
    // jcs-canonical.ts) — copy into a null-prototype accumulator via
    // Object.assign so "__proto__" behaves as an ordinary own string key
    // instead of resolving through the prototype chain.
    const own = Object.assign(
      Object.create(null) as Record<string, JsonValue>,
      v,
    );
    const keys = Object.keys(own).sort();
    const parts = keys.map((k) => {
      const val = own[k];
      if (val === undefined) {
        throw new JcsCanonicalizationError(
          `object key "${k}" has value undefined — omit the key entirely ` +
            'instead of setting it to undefined',
        );
      }
      return JSON.stringify(k) + ':' + canonicalize(val);
    });
    return '{' + parts.join(',') + '}';
  }
  if (typeof v === 'bigint') {
    throw new JcsCanonicalizationError(
      'BigInt is not a JSON value — pass an explicit string instead',
    );
  }
  throw new JcsCanonicalizationError(
    `value of type ${typeof v} is not a valid JSON value`,
  );
}

/**
 * Returns the RFC 8785 canonical UTF-8 bytes for `value`. Throws
 * `JcsCanonicalizationError` on anything not representable as a strict JSON
 * value — see the module docstring for the full, deliberate list.
 */
export function jcsCanonicalize(value: JsonValue): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}

/**
 * `sha256(JCS(value))`, hex, lowercase — the D2 commitment primitive. The ONE
 * shared helper; mirrors `be`'s single-helper discipline.
 */
export function jcsCommitment(value: JsonValue): string {
  return createHash('sha256').update(jcsCanonicalize(value)).digest('hex');
}
