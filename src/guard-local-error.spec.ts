/**
 * SDK-0357 (TS twin of python SDK-0355) — isOutage is an allowlist. A request
 * body JSON.stringify cannot encode (BigInt, circular) is a local error: it
 * raises PraesidiaConfigError in every failureMode and never degrades to local
 * rules. Transport errors, 503 and a malformed 2xx still degrade.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PraesidiaGuard } from "./guard.js";
import { PraesidiaInteractionHooks } from "./interaction-hooks.js";
import { PraesidiaConfigError, PraesidiaApiError, isOutage } from "./errors.js";
import { makeFetchMock } from "./__tests__/fetch-mock.js";
import type { GuardFailureMode } from "./types.js";

const base = { apiKey: "pk_test_key", orgId: "org-uuid-123", connectionId: "11111111-1111-4111-8111-111111111111" };
const circular: Record<string, unknown> = { a: 1 };
circular.self = circular;
const UNENCODABLE: Array<[string, Record<string, unknown>]> = [
  ["BigInt", { amount: 10n }],
  ["circular", circular],
];

describe("Guard never degrades on a local serialisation error (SDK-0357)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe.each(["local_rules", "fail_open", "fail_closed"] as GuardFailureMode[])("failureMode %s", (failureMode) => {
    it.each(UNENCODABLE)("%s context raises PraesidiaConfigError, not local rules", async (_n, context) => {
      const fetchMock = makeFetchMock([{ body: { passed: true, triggered: [], processingTimeMs: 1 } }]);
      globalThis.fetch = fetchMock;
      const onDegraded = vi.fn();
      const guard = new PraesidiaGuard({ ...base, failureMode, onDegraded });
      const err = await guard.checkInput("hello", { context }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PraesidiaConfigError);
      expect((err as Error).cause).toBeInstanceOf(TypeError);
      expect(onDegraded).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe.each(["local_rules", "fail_open"] as GuardFailureMode[])("failureMode %s still degrades", (failureMode) => {
    it.each([
      ["ECONNREFUSED", () => vi.fn<typeof fetch>().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))],
      ["timeout", () => vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timed out", "TimeoutError"))],
      ["503", () => makeFetchMock([{ status: 503, body: { message: "down" } }])],
      ["malformed 2xx", () => makeFetchMock([{ status: 200, text: "<html>proxy</html>" }])],
      ["2xx JSON null", () => makeFetchMock([{ status: 200, text: "null" }])],
    ])("%s", async (_n, mock) => {
      globalThis.fetch = mock();
      const guard = new PraesidiaGuard({ ...base, failureMode });
      expect(await guard.checkInput("hello", { context: { k: "v" } })).toMatchObject({ local: true, degraded: true });
    });
  });

  it("isOutage: a bare local TypeError / SyntaxError is not an outage; 503 and 408 are", () => {
    expect(isOutage(new TypeError("Do not know how to serialize a BigInt"))).toBe(false);
    expect(isOutage(new SyntaxError("Unexpected token"))).toBe(false);
    expect(isOutage(new PraesidiaApiError(503, "/x", "down"))).toBe(true);
    expect(isOutage(new PraesidiaApiError(408, "/x", "slow"))).toBe(true);
    expect(isOutage(new PraesidiaApiError(429, "/x", "slow down"))).toBe(false);
  });

  it("interaction hooks: an explicit fail-open override still permits a malformed 2xx", async () => {
    globalThis.fetch = makeFetchMock([{ status: 200, text: "not json" }]);
    const hooks = new PraesidiaInteractionHooks({ apiKey: "pk_test", orgId: base.orgId, agentId: base.connectionId, baseUrl: "https://api.example", failMode: { toolCall: "open" } });
    const r = await hooks.beforeToolCall({ toolName: "search", arguments: { q: "x" } });
    expect(r.decision).toBeNull();
    expect(r.failOpenError).toBeInstanceOf(SyntaxError);
  });
});
