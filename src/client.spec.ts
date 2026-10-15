import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BINARY_RESPONSE_BYTES,
  MAX_ERROR_RESPONSE_BYTES,
  MAX_JSON_RESPONSE_BYTES,
  normalizeBaseUrl,
  encodePathSegment,
  PraesidiaClient,
  readBoundedResponseBytes,
  resolveRequestTimeoutMs,
} from "./client.js";
import { PraesidiaApiError, isOutage } from "./errors.js";

describe("PraesidiaClient availability and configuration boundaries", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("aborts a backend request at the configured deadline", async () => {
    globalThis.fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          expect(signal).toBeInstanceOf(AbortSignal);
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    ) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      20,
    );
    await expect(client.get("/health")).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("normalizes a trailing slash and rejects unsafe base URLs/timeouts", () => {
    expect(normalizeBaseUrl("https://api.example.test/")).toBe(
      "https://api.example.test",
    );
    expect(() => normalizeBaseUrl("https://user:pass@example.test")).toThrow(
      /credentials/,
    );
    expect(() => normalizeBaseUrl("https://api example.test")).toThrow(
      /whitespace/,
    );
    expect(() => normalizeBaseUrl("https:\\evil.example.test")).toThrow(
      /backslashes/,
    );
    expect(() => resolveRequestTimeoutMs(0)).toThrow(/integer/);
    expect(
      () => new PraesidiaClient("https://api.example.test", "   "),
    ).toThrow(/apiKey/);
    expect(
      () => new PraesidiaClient("https://api.example.test", " key"),
    ).toThrow(/apiKey/);
  });

  it("rejects unsafe header values and path segments before fetch", () => {
    const client = new PraesidiaClient("https://api.example.test", "pk_test");
    expect(() => client.setChainId("chain\r\ninjected: true")).toThrow(
      /chainId/,
    );
    expect(() => encodePathSegment("", "agentId")).toThrow(/agentId/);
    expect(() => encodePathSegment(" ", "agentId")).toThrow(/agentId/);
    expect(() => encodePathSegment("..", "agentId")).toThrow(/agentId/);
    expect(encodePathSegment("../agent", "agentId")).toBe("..%2Fagent");
  });

  it("bounds streamed bodies even when Content-Length is absent", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5]));
          controller.close();
        },
      }),
    );

    await expect(
      readBoundedResponseBytes(response, 4, "/stream", "test body"),
    ).rejects.toThrow(/test body exceeds 4-byte limit/);
  });

  it("rejects an oversized JSON response before buffering it", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "Content-Length": String(MAX_JSON_RESPONSE_BYTES + 1),
          },
        }),
    ) as typeof fetch;
    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      false,
    );

    await expect(client.get("/large")).rejects.toThrow(
      /JSON response body exceeds 16777216-byte limit/,
    );
  });

  it("bounds error bodies while preserving the upstream status", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("failure", {
          status: 502,
          headers: {
            "Content-Length": String(MAX_ERROR_RESPONSE_BYTES + 1),
          },
        }),
    ) as typeof fetch;
    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      false,
    );

    const request = client.get("/large-error");
    await expect(request).rejects.toMatchObject({
      status: 502,
      path: "/large-error",
    });
    await expect(request).rejects.toThrow(
      /error response body exceeds 65536-byte limit/,
    );
  });

  it("rejects an oversized binary response before buffering it", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("small-placeholder", {
          status: 200,
          headers: {
            "Content-Length": String(MAX_BINARY_RESPONSE_BYTES + 1),
          },
        }),
    ) as typeof fetch;
    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      false,
    );

    await expect(client.getBytes("/report.pdf")).rejects.toThrow(
      /binary response body exceeds 134217728-byte limit/,
    );
  });
});

// ---------------------------------------------------------------------------
// FINDING-4 — retry behavior. Uses a tiny backoff config so specs run fast
// and deterministically (no fake timers needed).
// ---------------------------------------------------------------------------
describe("PraesidiaClient retry (FINDING-4)", () => {
  const originalFetch = globalThis.fetch;
  const fastRetry = {
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 2,
    maxElapsedMs: 5000,
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("retries a GET on a 503 and succeeds on the next attempt", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    const result = await client.get<{ ok: boolean }>("/health");
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  // PRA-85 — a hanging fetch that only ends when its signal aborts.
  const hangUntilAbort = (init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });

  it("caps a retry attempt's timeout to the remaining total budget (PRA-85)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      return hangUntilAbort(init);
    }) as typeof fetch;

    const client = new PraesidiaClient("https://api.example.test", "pk_test", 5000, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
      maxElapsedMs: 150,
    });
    const t0 = performance.now();
    await expect(client.get("/health")).rejects.toBeDefined();
    expect(calls).toBe(2);
    expect(performance.now() - t0).toBeLessThan(1000);
  }, 3000);

  it("zero budget makes exactly one attempt with a 1 ms timeout (PRA-85)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls += 1;
      return hangUntilAbort(init);
    }) as typeof fetch;

    const client = new PraesidiaClient("https://api.example.test", "pk_test", 5000, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
      maxElapsedMs: 0,
    });
    const t0 = performance.now();
    await expect(client.get("/health")).rejects.toBeDefined();
    expect(calls).toBe(1);
    expect(performance.now() - t0).toBeLessThan(1000);
  }, 3000);

  // PRA-85 — controlled monotonic clock: every attempt's timeout is the
  // remaining budget, and no retry starts once the budget is spent.
  const controlledClock = () => {
    const clock = { now: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });
    return { clock, timeouts };
  };
  const budget100 = { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2, maxElapsedMs: 100 };

  it("controlled clock: attempt 2 gets only the remaining budget; no attempt after the deadline (PRA-85)", async () => {
    const { clock, timeouts } = controlledClock();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      clock.now = calls === 1 ? 40 : 240;
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const client = new PraesidiaClient("https://api.example.test", "pk_test", 5000, budget100);
    const err = await client.get("/health").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PraesidiaApiError);
    expect(calls).toBe(2);
    expect(timeouts).toEqual([100, 60]);
  });

  it("controlled clock: a transport failure at the deadline is not retried (PRA-85)", async () => {
    const { clock } = controlledClock();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      clock.now = 100;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const client = new PraesidiaClient("https://api.example.test", "pk_test", 5000, budget100);
    await expect(client.get("/health")).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });

  it("controlled clock: Retry-After past the deadline does not extend it (PRA-85)", async () => {
    controlledClock();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("busy", { status: 503, headers: { "Retry-After": "1" } });
    }) as typeof fetch;
    const client = new PraesidiaClient("https://api.example.test", "pk_test", 5000, budget100);
    const err = await client.get("/health").catch((e: unknown) => e);
    expect((err as PraesidiaApiError).status).toBe(503);
    expect(calls).toBe(1);
  });

  it("controlled clock: a keyed POST retry reuses its Idempotency-Key within the remaining budget (PRA-85)", async () => {
    const { clock, timeouts } = controlledClock();
    const keys: string[] = [];
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
      clock.now += 30;
      return keys.length === 1
        ? new Response("unavailable", { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 201 });
    }) as typeof fetch;
    const client = new PraesidiaClient("https://api.example.test", "pk_test", 5000, budget100);
    await expect(
      client.post("/organizations/org_1/tasks", {}, undefined, { idempotencyKey: "idem-85" }),
    ).resolves.toEqual({ ok: true });
    expect(keys).toEqual(["idem-85", "idem-85"]);
    expect(timeouts).toEqual([100, 70]);
  });

  it("controlled clock: a bare POST is sent once even with budget left (PRA-85)", async () => {
    controlledClock();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const client = new PraesidiaClient("https://api.example.test", "pk_test", 5000, budget100);
    await expect(client.post("/things", {})).rejects.toBeInstanceOf(PraesidiaApiError);
    expect(calls).toBe(1);
  });

  // PRA-85 — owned local fixtures: a server that stalls before headers, and
  // one that sends 200 headers then stalls the body. The 300 ms total budget
  // must cancel both far inside the 10 s requestTimeout (tolerance: 2 s).
  for (const stall of ["headers", "body"] as const) {
    it(`local fixture: a stalled ${stall} is cancelled by the total budget, not requestTimeout (PRA-85)`, async () => {
      globalThis.fetch = originalFetch;
      const { createServer } = await import("node:http");
      let hits = 0;
      const server = createServer((_req, res) => {
        hits += 1;
        if (stall === "body") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"ok":');
        }
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as { port: number };
      const client = new PraesidiaClient(`http://127.0.0.1:${port}`, "pk_test", 10_000, {
        maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, maxElapsedMs: 300,
      });
      const t0 = performance.now();
      try {
        await expect(client.get("/slow")).rejects.toBeDefined();
        expect(performance.now() - t0).toBeLessThan(2000);
        expect(hits).toBeGreaterThanOrEqual(1);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    }, 8000);
  }

  it("cancels a discarded retryable response body before the next attempt", async () => {
    let calls = 0;
    let cancelled = false;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const body = new ReadableStream({
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    await expect(client.get("/health")).resolves.toEqual({ ok: true });
    expect(cancelled).toBe(true);
    expect(calls).toBe(2);
  });

  // PRA-70 — a reset after 200 headers, while the body streams, is retried.
  const resetBody = (): Response =>
    new Response(
      new ReadableStream({
        pull(c) {
          c.error(new TypeError("terminated: ECONNRESET"));
        },
      }),
      { status: 200 },
    );

  it("retries a GET whose 200 body stream resets, then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? resetBody()
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const client = new PraesidiaClient("https://api.example.test", "pk_test", undefined, fastRetry);
    await expect(client.get("/health")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("surfaces the body failure as an outage once GET attempts are exhausted", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return resetBody();
    }) as typeof fetch;
    const client = new PraesidiaClient("https://api.example.test", "pk_test", undefined, fastRetry);
    const err = await client.get("/health").catch((e: unknown) => e);
    expect(isOutage(err)).toBe(true);
    expect(calls).toBe(fastRetry.maxAttempts);
  });

  it("does not retry an oversized GET body (resource limit, not transport)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("x".repeat(16 * 1024 * 1024 + 1), { status: 200 });
    }) as typeof fetch;
    const client = new PraesidiaClient("https://api.example.test", "pk_test", undefined, fastRetry);
    await expect(client.get("/big")).rejects.toBeInstanceOf(PraesidiaApiError);
    expect(calls).toBe(1);
  });

  it("retries a binary GET whose 200 body stream resets, then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? resetBody()
        : new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "x-praesidia-window": "w1" },
          });
    }) as typeof fetch;
    const client = new PraesidiaClient("https://api.example.test", "pk_test", undefined, fastRetry);
    const res = await client.getBytesResponse("/bundle");
    expect(Array.from(res.bytes)).toEqual([1, 2, 3]);
    expect(res.headers.get("x-praesidia-window")).toBe("w1");
    expect(calls).toBe(2);
  });

  it("does not retry an oversized binary GET body (resource limit)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(new Uint8Array(128 * 1024 * 1024 + 1), { status: 200 });
    }) as typeof fetch;
    const client = new PraesidiaClient("https://api.example.test", "pk_test", undefined, fastRetry);
    await expect(client.getBytes("/big")).rejects.toBeInstanceOf(PraesidiaApiError);
    expect(calls).toBe(1);
  });

  it("sends a bare POST exactly once when its 200 body resets", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return resetBody();
    }) as typeof fetch;
    const client = new PraesidiaClient("https://api.example.test", "pk_test", undefined, fastRetry);
    await client.post("/things", {}).catch(() => undefined);
    expect(calls).toBe(1);
  });

  it("honours Retry-After on a 429 before retrying", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    const result = await client.get<{ ok: boolean }>("/health");
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("retries DELETE on a transient 500", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("boom", { status: 500 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    await client.del("/resource/1");
    expect(calls).toBe(2);
  });

  it("treats retry 404 as a committed DELETE whose first response was lost", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset after commit");
      return new Response("already deleted", { status: 404 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    await expect(client.del("/resource/1")).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("still reports an initial DELETE 404 as not found", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("missing", { status: 404 }),
    ) as typeof fetch;
    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );

    await expect(client.del("/resource/typo")).rejects.toMatchObject({
      status: 404,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("releases an unexpected successful DELETE response body", async () => {
    let cancelled = false;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    await client.del("/resource/1");
    expect(cancelled).toBe(true);
  });

  it("NEVER retries a bare POST (would risk a double-create/double-charge)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("boom", { status: 503 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    await expect(
      client.post("/organizations/org_1/tasks", { input: {} }),
    ).rejects.toThrow(PraesidiaApiError);
    expect(calls).toBe(1);
  });

  it("retries a POST carrying an idempotencyKey on a route be-core dedups, and sends the Idempotency-Key header", async () => {
    let calls = 0;
    const seenHeaders: Record<string, string>[] = [];
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls += 1;
      seenHeaders.push({ ...(init?.headers as Record<string, string>) });
      if (calls === 1) return new Response("boom", { status: 503 });
      return new Response(JSON.stringify({ created: true }), { status: 201 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    const result = await client.post<{ created: boolean }>(
      "/organizations/org_1/tasks",
      { input: {} },
      undefined,
      { idempotencyKey: "idem-123" },
    );
    expect(result).toEqual({ created: true });
    expect(calls).toBe(2);
    expect(seenHeaders[0]["Idempotency-Key"]).toBe("idem-123");
  });

  it("R-SDK-1: refuses an idempotencyKey on a route be-core does not dedup, without calling fetch", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "x" }), { status: 201 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    await expect(
      client.post("/organizations/org_1/agents", { name: "a" }, undefined, {
        idempotencyKey: "idem-123",
      }),
    ).rejects.toThrow(/does not honour Idempotency-Key/);
    await expect(
      client.patch("/organizations/org_1/tasks", { name: "a" }, undefined, {
        idempotencyKey: "idem-123",
      }),
    ).rejects.toThrow(/does not honour Idempotency-Key/);
    expect(calls).toBe(0);
  });

  it.each(["", " key", "key\r\ninjected: true"])(
    "rejects an unsafe idempotency key before fetch: %j",
    async (idempotencyKey) => {
      const spy = vi.fn();
      globalThis.fetch = spy as typeof fetch;
      const client = new PraesidiaClient(
        "https://api.example.test",
        "pk_test",
        undefined,
        fastRetry,
      );
      await expect(
        client.post("/organizations/org_1/tasks", {}, undefined, {
          idempotencyKey,
        }),
      ).rejects.toThrow(/idempotencyKey/);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("R-SDK-1: honours the idempotencyKey allow-list for the A2A inbound routes", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 201 }),
    ) as typeof fetch;
    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    await expect(
      client.post("/a2a/tasks", {}, undefined, { idempotencyKey: "k" }),
    ).resolves.toEqual({ ok: true });
    await expect(
      client.post("/a2a/tasks/task-1/result", {}, undefined, {
        idempotencyKey: "k",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("gives up after maxAttempts and surfaces the final error response", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("still down", { status: 503 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    await expect(client.get("/health")).rejects.toThrow(PraesidiaApiError);
    expect(calls).toBe(fastRetry.maxAttempts);
  });

  it("never retries when retry is disabled (retry: false)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("down", { status: 503 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      false,
    );
    await expect(client.get("/health")).rejects.toThrow(PraesidiaApiError);
    expect(calls).toBe(1);
  });

  it("retries a network-level failure (fetch rejects), not just HTTP error statuses", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new PraesidiaClient(
      "https://api.example.test",
      "pk_test",
      undefined,
      fastRetry,
    );
    const result = await client.get<{ ok: boolean }>("/health");
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
