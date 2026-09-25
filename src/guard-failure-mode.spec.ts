/**
 * SDK-0335 — bounded degradation when the control plane is unreachable:
 * `failureMode` (with legacy strict/failOpen mapping), `maxDegradedMs`,
 * `onDegraded`, and `degraded: true` on locally-served results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PraesidiaGuard } from "./guard.js";
import { PraesidiaApiError, PraesidiaConfigError } from "./errors.js";
import { makeFetchMock } from "./__tests__/fetch-mock.js";
import type { GuardConfig } from "./types.js";

const PASS = { passed: true, triggered: [], processingTimeMs: 1 };
const DOWN = { ok: false, status: 503, body: { message: "unavailable" } };
const UP = { ok: true, body: PASS };
const base = { apiKey: "pk_test_key", orgId: "org-uuid-123" };

describe("PraesidiaGuard failure modes (SDK-0335)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("legacy flag mapping", () => {
    const cases: Array<[Partial<GuardConfig>, string]> = [
      [{}, "local_rules"],
      [{ strict: true }, "fail_closed"],
      [{ failOpen: true }, "fail_open"],
      [{ strict: true, failOpen: true }, "fail_open"],
    ];
    it.each(cases)("%j maps to %s", async (flags, mode) => {
      globalThis.fetch = makeFetchMock([DOWN]);
      const onDegraded = vi.fn();
      const guard = new PraesidiaGuard({ ...base, ...flags, onDegraded });
      const call = guard.checkInput("hello");
      if (mode === "fail_closed") {
        await expect(call).rejects.toThrow(PraesidiaApiError);
      } else {
        const r = await call;
        expect(r).toMatchObject({ local: true, degraded: true, passed: true });
      }
      expect(onDegraded).toHaveBeenCalledWith(
        expect.objectContaining({ mode, operation: "guardrails/validate" }),
      );
      // local_rules warns; fail_open stays silent (legacy failOpen behaviour).
      expect(console.warn).toHaveBeenCalledTimes(
        mode === "local_rules" ? 1 : 0,
      );
    });

    it("explicit failureMode wins over legacy flags", async () => {
      globalThis.fetch = makeFetchMock([DOWN]);
      const guard = new PraesidiaGuard({
        ...base,
        failOpen: true,
        failureMode: "fail_closed",
      });
      await expect(guard.checkInput("hello")).rejects.toThrow(
        PraesidiaApiError,
      );
    });

    it("rejects an unknown failureMode / invalid maxDegradedMs", () => {
      expect(
        () =>
          new PraesidiaGuard({
            ...base,
            failureMode: "open" as GuardConfig["failureMode"],
          }),
      ).toThrow(PraesidiaConfigError);
      expect(() => new PraesidiaGuard({ ...base, maxDegradedMs: -1 })).toThrow(
        PraesidiaConfigError,
      );
    });
  });

  it("fail_closed throws on a network error", async () => {
    globalThis.fetch = makeFetchMock([DOWN]);
    const guard = new PraesidiaGuard({ ...base, failureMode: "fail_closed" });
    await expect(guard.checkOutput("x")).rejects.toThrow(PraesidiaApiError);
  });

  it("local_rules returns degraded: true; a healthy result is not degraded", async () => {
    globalThis.fetch = makeFetchMock([DOWN, UP]);
    const guard = new PraesidiaGuard({ ...base, failureMode: "local_rules" });
    expect(await guard.checkInput("hi")).toMatchObject({
      local: true,
      degraded: true,
    });
    const ok = await guard.checkInput("hi");
    expect(ok.local).toBe(false);
    expect(ok.degraded).toBeUndefined();
  });

  it("offline mode (no key) is not reported as degraded", async () => {
    const guard = new PraesidiaGuard({ apiKey: undefined, orgId: undefined });
    const r = await guard.checkInput("hi");
    expect(r.local).toBe(true);
    expect(r.degraded).toBeUndefined();
  });

  it.each(["local_rules", "fail_open"] as const)(
    "maxDegradedMs escalates %s to fail_closed until one success",
    async (failureMode) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000_000);
      globalThis.fetch = makeFetchMock([DOWN, DOWN, DOWN, UP, DOWN]);
      const guard = new PraesidiaGuard({
        ...base,
        failureMode,
        maxDegradedMs: 60_000,
      });
      expect((await guard.checkInput("a")).degraded).toBe(true);
      vi.setSystemTime(1_000_000 + 60_000); // at the bound: still degraded
      expect((await guard.checkInput("a")).degraded).toBe(true);
      vi.setSystemTime(1_000_000 + 60_001); // past the bound: fail closed
      await expect(guard.checkInput("a")).rejects.toThrow(PraesidiaApiError);
      expect(console.error).toHaveBeenCalledOnce(); // loud escalation signal
      expect((await guard.checkInput("a")).local).toBe(false); // success resets
      vi.setSystemTime(1_000_000 + 200_000); // new episode starts its own clock
      expect((await guard.checkInput("a")).degraded).toBe(true);
    },
  );

  it("onDegraded fires once per episode and resets after success", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(5_000);
    globalThis.fetch = makeFetchMock([DOWN, DOWN, UP, DOWN]);
    const onDegraded = vi.fn();
    const guard = new PraesidiaGuard({ ...base, onDegraded });
    await guard.checkInput("a");
    vi.setSystemTime(6_000);
    await guard.checkInput("a");
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onDegraded).toHaveBeenCalledWith({
      operation: "guardrails/validate",
      since: 5_000,
      mode: "local_rules",
    });
    await guard.checkInput("a"); // success ends the episode
    vi.setSystemTime(9_000);
    await guard.checkInput("a");
    expect(onDegraded).toHaveBeenCalledTimes(2);
    expect(onDegraded).toHaveBeenLastCalledWith(
      expect.objectContaining({ since: 9_000 }),
    );
  });

  it("a throwing onDegraded callback does not break the degraded path", async () => {
    globalThis.fetch = makeFetchMock([DOWN]);
    const guard = new PraesidiaGuard({
      ...base,
      onDegraded: () => {
        throw new Error("pager down");
      },
    });
    expect((await guard.checkInput("a")).degraded).toBe(true);
  });
});
