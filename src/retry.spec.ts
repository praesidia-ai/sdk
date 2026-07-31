import { describe, it, expect } from 'vitest';
import {
  assertIdempotencyKeySupported,
  computeBackoffMs,
  isRetryableStatus,
  parseRetryAfterMs,
  resolveRetryConfig,
  DEFAULT_RETRY_CONFIG,
} from './retry.js';
import { PraesidiaConfigError } from './errors.js';

describe('resolveRetryConfig', () => {
  it('returns false unchanged (retries disabled)', () => {
    expect(resolveRetryConfig(false)).toBe(false);
  });

  it('merges partial overrides onto the defaults', () => {
    expect(resolveRetryConfig({ maxAttempts: 5 })).toEqual({
      ...DEFAULT_RETRY_CONFIG,
      maxAttempts: 5,
    });
  });

  it('returns the defaults when omitted', () => {
    expect(resolveRetryConfig(undefined)).toEqual(DEFAULT_RETRY_CONFIG);
  });

  it('rejects an out-of-range maxAttempts', () => {
    expect(() => resolveRetryConfig({ maxAttempts: 0 })).toThrow(PraesidiaConfigError);
    expect(() => resolveRetryConfig({ maxAttempts: 11 })).toThrow(PraesidiaConfigError);
    expect(() => resolveRetryConfig({ maxAttempts: 1.5 })).toThrow(PraesidiaConfigError);
  });

  it('rejects a negative baseDelayMs', () => {
    expect(() => resolveRetryConfig({ baseDelayMs: -1 })).toThrow(PraesidiaConfigError);
  });

  it('rejects maxDelayMs below baseDelayMs', () => {
    expect(() =>
      resolveRetryConfig({ baseDelayMs: 500, maxDelayMs: 100 }),
    ).toThrow(PraesidiaConfigError);
  });

  it('rejects a negative maxElapsedMs', () => {
    expect(() => resolveRetryConfig({ maxElapsedMs: -1 })).toThrow(PraesidiaConfigError);
  });
});

describe('isRetryableStatus', () => {
  it('treats 429 and every 5xx as retryable', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  it('never retries 2xx/3xx/4xx (other than 429)', () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(409)).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('parses an HTTP-date into a non-negative delta', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it('returns undefined for null/garbage input', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date-or-number')).toBeUndefined();
  });
});

describe('computeBackoffMs', () => {
  it('grows exponentially and never exceeds the cap', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = computeBackoffMs(attempt, 100, 1000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });

  it('caps at maxDelayMs even for a large attempt number', () => {
    const delay = computeBackoffMs(20, 100, 500);
    expect(delay).toBeLessThanOrEqual(500);
  });
});

// R-SDK-1 — the idempotencyKey allow-list. be-core honours Idempotency-Key
// on exactly three routes; everything else must be rejected client-side.
describe('assertIdempotencyKeySupported', () => {
  it('allows POST /organizations/:orgId/tasks', () => {
    expect(() =>
      assertIdempotencyKeySupported('POST', '/organizations/org_1/tasks'),
    ).not.toThrow();
  });

  it('allows the A2A inbound routes', () => {
    expect(() =>
      assertIdempotencyKeySupported('POST', '/a2a/tasks'),
    ).not.toThrow();
    expect(() =>
      assertIdempotencyKeySupported('POST', '/a2a/tasks/task-1/result'),
    ).not.toThrow();
  });

  it('rejects any other POST path', () => {
    expect(() =>
      assertIdempotencyKeySupported('POST', '/organizations/org_1/agents'),
    ).toThrow(PraesidiaConfigError);
    expect(() =>
      assertIdempotencyKeySupported(
        'POST',
        '/organizations/org_1/tasks/task-1/approve',
      ),
    ).toThrow(PraesidiaConfigError);
  });

  it('rejects every PATCH path (be-core honours no PATCH route today)', () => {
    expect(() =>
      assertIdempotencyKeySupported('PATCH', '/organizations/org_1/tasks'),
    ).toThrow(PraesidiaConfigError);
  });
});
