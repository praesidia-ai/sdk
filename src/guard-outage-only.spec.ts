/**
 * SDK-0348 — the guard degrades to local rules only on an OUTAGE (network
 * error, timeout, 408, 5xx). A caller-triggerable 4xx (oversized content → 400,
 * shared-egress rate limit → 429, auth → 401/403) must fail closed in every
 * failureMode, or an end user can switch the org's guardrails off at will.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PraesidiaGuard } from "./guard.js";
import { GuardContentTooLargeError, PraesidiaApiError } from "./errors.js";
import { MAX_GUARD_CONTENT_LENGTH } from "./index.js";
import { makeFetchMock } from "./__tests__/fetch-mock.js";
import type { GuardFailureMode } from "./types.js";

const PASS = { passed: true, triggered: [], processingTimeMs: 1 };
const base = { apiKey: "pk_test_key", orgId: "org-uuid-123", connectionId: "11111111-1111-4111-8111-111111111111" };
const DEGRADING: GuardFailureMode[] = ["local_rules", "fail_open"];

describe("PraesidiaGuard degrades only on outages (SDK-0348)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe.each(DEGRADING)("failureMode %s", (failureMode) => {
    it.each([400, 401, 403, 404, 413, 422, 429])(
      "validate %i fails closed instead of serving local rules",
      async (status) => {
        globalThis.fetch = makeFetchMock([{ status, body: { message: "no" } }]);
        const onDegraded = vi.fn();
        const guard = new PraesidiaGuard({ ...base, failureMode, onDegraded });
        await expect(guard.checkInput("hello")).rejects.toMatchObject({
          name: "PraesidiaApiError",
          status,
        });
        expect(onDegraded).not.toHaveBeenCalled();
      },
    );

    it("logTask 400 fails closed", async () => {
      globalThis.fetch = makeFetchMock([{ status: 400, body: { message: "bad" } }]);
      const guard = new PraesidiaGuard({ ...base, failureMode });
      await expect(guard.logTask({ input: "hi" })).rejects.toThrow(PraesidiaApiError);
    });

    it("503 still degrades to local rules", async () => {
      globalThis.fetch = makeFetchMock([{ status: 503, body: { message: "down" } }]);
      const guard = new PraesidiaGuard({ ...base, failureMode });
      expect(await guard.checkInput("hello")).toMatchObject({ local: true, degraded: true, passed: true });
    });

    it("ECONNREFUSED still degrades to local rules", async () => {
      const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      globalThis.fetch = vi.fn<typeof fetch>().mockRejectedValue(refused);
      const guard = new PraesidiaGuard({ ...base, failureMode });
      expect(await guard.checkInput("hello")).toMatchObject({ local: true, degraded: true });
    });
  });

  it("rejects content over the server max locally, before any request", async () => {
    expect(MAX_GUARD_CONTENT_LENGTH).toBe(100_000);
    const fetchMock = makeFetchMock([{ body: PASS }]);
    globalThis.fetch = fetchMock;
    const guard = new PraesidiaGuard({ ...base, failureMode: "local_rules" });
    const err = await guard.checkInput("a".repeat(MAX_GUARD_CONTENT_LENGTH + 1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardContentTooLargeError);
    expect(err).toMatchObject({ code: "CONTENT_TOO_LARGE", length: MAX_GUARD_CONTENT_LENGTH + 1, maxLength: 100_000 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts code points like the server: max-length astral text is sent", async () => {
    const fetchMock = makeFetchMock([{ body: PASS }]);
    globalThis.fetch = fetchMock;
    const guard = new PraesidiaGuard({ ...base, failureMode: "local_rules" });
    const r = await guard.checkOutput("\u{1F600}".repeat(MAX_GUARD_CONTENT_LENGTH));
    expect(r.local).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
