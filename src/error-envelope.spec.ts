import { afterEach, describe, expect, it, vi } from "vitest";
import { PraesidiaClient } from "./client.js";
import { PraesidiaApiError } from "./errors.js";

/**
 * SCAN2-007 — be returns a structured JSON error envelope
 * ({statusCode, timestamp, path, method, requestId, message, details?,
 * retryAfter?, code?, ...extra}, see be/src/common/filters/http-exception.filter.ts).
 * Today PraesidiaApiError flattens the whole body into a single opaque
 * `message` string (CT-01). These tests drive the real HTTP boundary (a
 * stubbed `fetch`, exercising the real `client.get`/error-construction path,
 * not a hand-built error object) and assert the thrown error exposes the
 * envelope's fields as typed properties.
 */
describe("PraesidiaApiError exposes be's structured error envelope (SCAN2-007)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetchOnce(status: number, body: unknown, headers?: Record<string, string>) {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify(body), { status, headers });
    }) as typeof fetch;
  }

  it("exposes code, requestId, details, retryAfter and retryable=true on a 429 envelope", async () => {
    const envelope = {
      statusCode: 429,
      timestamp: "2026-09-07T00:00:00.000Z",
      path: "/organizations/org-1/agents",
      method: "GET",
      requestId: "req-abc123",
      message: "Too many requests. Please try again later.",
      code: "RATE_LIMITED",
      details: { limit: 100, windowSeconds: 60 },
      retryAfter: 30,
    };
    stubFetchOnce(429, envelope);

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      false, // retryConfig=false — disable client-side auto-retry so the error surfaces
    );

    let caught: unknown;
    try {
      await client.get("/organizations/org-1/agents");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PraesidiaApiError);
    const err = caught as PraesidiaApiError;
    expect(err.status).toBe(429);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.requestId).toBe("req-abc123");
    expect(err.details).toEqual({ limit: 100, windowSeconds: 60 });
    expect(err.retryAfter).toBe(30);
    expect(err.retryable).toBe(true);
    // Forward compatibility: the full raw envelope stays available so a
    // field be adds later is not silently dropped by an older SDK.
    expect(err.body).toEqual(envelope);
    // Backwards compatibility: existing callers reading .message still work.
    expect(typeof err.message).toBe("string");
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("exposes retryable=false and no retryAfter on a fatal 400", async () => {
    const envelope = {
      statusCode: 400,
      timestamp: "2026-09-07T00:00:00.000Z",
      path: "/organizations/org-1/agents",
      method: "POST",
      requestId: "req-def456",
      message: "Validation failed",
      code: "VALIDATION_FAILED",
      details: [{ field: "name", constraint: "isNotEmpty" }],
    };
    stubFetchOnce(400, envelope);

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      false,
    );

    let caught: unknown;
    try {
      await client.get("/organizations/org-1/agents");
    } catch (err) {
      caught = err;
    }

    const err = caught as PraesidiaApiError;
    expect(err.status).toBe(400);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.retryAfter).toBeUndefined();
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual([{ field: "name", constraint: "isNotEmpty" }]);
  });

  it("degrades gracefully (undefined structured fields, unchanged message) on a non-JSON error body", async () => {
    globalThis.fetch = vi.fn(async () => new Response("upstream gateway is down", { status: 502 })) as typeof fetch;
    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      false,
    );

    let caught: unknown;
    try {
      await client.get("/health");
    } catch (err) {
      caught = err;
    }

    const err = caught as PraesidiaApiError;
    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
    expect(err.requestId).toBeUndefined();
    expect(err.details).toBeUndefined();
    expect(err.body).toBeUndefined();
    expect(err.retryable).toBe(true); // 5xx is still retryable even unparsed
    expect(err.message).toContain("upstream gateway is down");
  });

  it("never lets the configured API key reach the thrown error's message, JSON.stringify, or String() form", async () => {
    const secretKey = "sk_live_SUPER_SECRET_DO_NOT_LEAK";
    const envelope = {
      statusCode: 403,
      timestamp: "2026-09-07T00:00:00.000Z",
      path: "/organizations/org-1/agents",
      method: "GET",
      requestId: "req-sec789",
      message: "Forbidden",
      code: "FORBIDDEN",
    };
    stubFetchOnce(403, envelope);

    const client = new PraesidiaClient(
      "https://api.example.test",
      secretKey,
      undefined,
      false,
    );

    let caught: unknown;
    try {
      await client.get("/organizations/org-1/agents");
    } catch (err) {
      caught = err;
    }

    const err = caught as PraesidiaApiError;
    expect(err.message).not.toContain(secretKey);
    expect(String(err)).not.toContain(secretKey);
    expect(JSON.stringify(err)).not.toContain(secretKey);
    expect(JSON.stringify(err.body)).not.toContain(secretKey);
  });
});
