/**
 * SDK-0358 — a header value fetch cannot send (CR/LF/NUL, e.g. an end-user
 * derived chainId) must raise PraesidiaConfigError before anything is sent, in
 * every failureMode. Before the fix fetch rejected with a TypeError that was
 * tagged as transport, so the guard degraded to local-only rules.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PraesidiaGuard } from "./guard.js";
import { PraesidiaClient } from "./client.js";
import { PraesidiaConfigError } from "./errors.js";
import { makeFetchMock } from "./__tests__/fetch-mock.js";
import type { GuardFailureMode } from "./types.js";

const base = { apiKey: "pk_test_key", orgId: "org-uuid-123", connectionId: "11111111-1111-4111-8111-111111111111" };
const MODES: GuardFailureMode[] = ["local_rules", "fail_open", "fail_closed"];
const CHAIN = "22222222-2222-4222-8222-222222222222";

describe("header values are validated before the request is built (SDK-0358)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe.each(MODES)("failureMode %s", (failureMode) => {
    it.each(["a\r\nX-Injected: 1", "a\nb", "a\u0000b"])(
      "chainId %j throws PraesidiaConfigError and sends nothing",
      async (chainId) => {
        const real = originalFetch;
        const spy = vi.fn<typeof fetch>((u, i) => real(u, i));
        globalThis.fetch = spy;
        const onDegraded = vi.fn();
        const guard = new PraesidiaGuard({ ...base, failureMode, onDegraded });
        await expect(guard.checkInput("hello", { chainId })).rejects.toBeInstanceOf(PraesidiaConfigError);
        expect(spy).not.toHaveBeenCalled();
        expect(onDegraded).not.toHaveBeenCalled();
      },
    );
  });

  it("a valid UUID chainId still reaches the server", async () => {
    const mock = makeFetchMock([{ status: 200, body: { passed: true, triggered: [], processingTimeMs: 1 } }]);
    globalThis.fetch = mock;
    const guard = new PraesidiaGuard({ ...base, failureMode: "fail_closed" });
    expect(await guard.checkInput("hello", { chainId: CHAIN })).toMatchObject({ local: false, passed: true });
    const headers = mock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["X-Praesidia-Chain-Id"]).toBe(CHAIN);
  });

  it("a real connection refused still degrades", async () => {
    const guard = new PraesidiaGuard({
      ...base,
      baseUrl: "http://127.0.0.1:1",
      allowInsecureHttp: true,
      failureMode: "local_rules",
    });
    expect(await guard.checkInput("hello", { chainId: CHAIN })).toMatchObject({ local: true, degraded: true });
  });

  it("client rejects a caller header value outside RFC 9110 field-value, retry path too", async () => {
    const spy = vi.fn<typeof fetch>();
    globalThis.fetch = spy;
    const client = new PraesidiaClient("https://api.example.test", "pk_test_key");
    await expect(client.post("/x", {}, { "X-Custom": "a\rb" })).rejects.toBeInstanceOf(PraesidiaConfigError);
    await expect(client.get("/x", { "X-Custom": "☃" })).rejects.toBeInstanceOf(PraesidiaConfigError);
    await expect(client.get("/x", { "Bad Name": "v" })).rejects.toBeInstanceOf(PraesidiaConfigError);
    expect(spy).not.toHaveBeenCalled();
  });
});
