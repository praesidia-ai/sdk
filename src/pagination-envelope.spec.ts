import { afterEach, describe, expect, it, vi } from "vitest";
import { PraesidiaAgents } from "./agents.js";
import { PraesidiaConnections } from "./connections.js";
import { PraesidiaWorkflows } from "./workflows.js";

/**
 * SCAN2-011 — `list()`/`listRuns()` unwrap be's paginated envelope into a
 * bare array typed as the whole collection, discarding `meta` entirely. A
 * caller iterating the returned array has no way to detect that more rows
 * exist. These tests drive the real HTTP boundary (a stubbed `fetch`) and
 * assert (a) the new `listPage()`/`listAll()` give the caller a way to
 * detect/consume truncation and (b) the original `list()`/`listRuns()`
 * keep their exact prior array-returning signature (backwards compatible).
 */
describe("SDK list-family pagination (SCAN2-011)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function envelope(page: number, ids: string[], total: number, limit: number) {
    return {
      data: ids.map((id) => ({ id })),
      total,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  function stubPagedFetch(pages: Record<number, unknown>) {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page") ?? "1");
      const body = pages[page] ?? { data: [], total: 0, meta: { page, limit: 20, total: 0, totalPages: 0, hasNextPage: false } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
  }

  it("agents.list() stays a bare array (backwards compatible) with no truncation signal", async () => {
    stubPagedFetch({ 1: envelope(1, ["a1", "a2"], 100, 2) });
    const agents = new PraesidiaAgents({ apiKey: "k", orgId: "org-1", baseUrl: "https://api.example.test" });
    const result = await agents.list();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([{ id: "a1" }, { id: "a2" }]);
    // No .meta/.total on a bare array — that's the pre-existing, now-documented limitation.
    expect((result as unknown as { meta?: unknown }).meta).toBeUndefined();
  });

  it("agents.listPage() exposes the full envelope including meta.total/hasNextPage", async () => {
    stubPagedFetch({ 1: envelope(1, ["a1", "a2"], 100, 2) });
    const agents = new PraesidiaAgents({ apiKey: "k", orgId: "org-1", baseUrl: "https://api.example.test" });
    const page = await agents.listPage();
    expect(page.data).toEqual([{ id: "a1" }, { id: "a2" }]);
    expect(page.total).toBe(100);
    expect(page.meta.hasNextPage).toBe(true);
  });

  it("agents.listAll() auto-paginates across every page and yields every row", async () => {
    stubPagedFetch({
      1: envelope(1, ["a1", "a2"], 5, 2),
      2: envelope(2, ["a3", "a4"], 5, 2),
      3: envelope(3, ["a5"], 5, 2),
    });
    const agents = new PraesidiaAgents({ apiKey: "k", orgId: "org-1", baseUrl: "https://api.example.test" });
    const all: unknown[] = [];
    for await (const item of agents.listAll()) all.push(item);
    expect(all).toEqual([{ id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "a4" }, { id: "a5" }]);
  });

  it("connections.listPage() and .listAll() give the same guarantees", async () => {
    stubPagedFetch({
      1: envelope(1, ["c1"], 2, 1),
      2: envelope(2, ["c2"], 2, 1),
    });
    const connections = new PraesidiaConnections({ apiKey: "k", orgId: "org-1", baseUrl: "https://api.example.test" });
    const page = await connections.listPage();
    expect(page.total).toBe(2);
    expect(page.meta.hasNextPage).toBe(true);
    const all: unknown[] = [];
    for await (const item of connections.listAll()) all.push(item);
    expect(all).toEqual([{ id: "c1" }, { id: "c2" }]);
  });

  it("workflows.listPage()/.listAll() and .listRunsPage()/.listRunsAll() give the same guarantees", async () => {
    stubPagedFetch({
      1: envelope(1, ["w1"], 2, 1),
      2: envelope(2, ["w2"], 2, 1),
    });
    const workflows = new PraesidiaWorkflows({ apiKey: "k", orgId: "org-1", baseUrl: "https://api.example.test" });
    const page = await workflows.listPage();
    expect(page.total).toBe(2);
    const all: unknown[] = [];
    for await (const item of workflows.listAll()) all.push(item);
    expect(all).toEqual([{ id: "w1" }, { id: "w2" }]);

    stubPagedFetch({
      1: envelope(1, ["r1"], 2, 1),
      2: envelope(2, ["r2"], 2, 1),
    });
    const runsPage = await workflows.listRunsPage("workflow-1");
    expect(runsPage.total).toBe(2);
    const allRuns: unknown[] = [];
    for await (const item of workflows.listRunsAll("workflow-1")) allRuns.push(item);
    expect(allRuns).toEqual([{ id: "r1" }, { id: "r2" }]);
  });
});
