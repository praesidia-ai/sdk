/**
 * SCAN2-011 — shared pagination helpers for the four list families
 * (`PraesidiaAgents.list`, `PraesidiaConnections.list`, `PraesidiaWorkflows.list`
 * / `.listRuns`) that previously unwrapped be's paginated envelope into a bare
 * array typed as "the collection", silently discarding `meta`
 * (`page`/`limit`/`total`/`totalPages`/`hasNextPage`) and any truncation
 * signal along with it (`be/src/common/dto/pagination.dto.ts`'s
 * `createPaginatedResult`).
 *
 * Backwards compatibility decision: each family's existing `list()` (or
 * `listRuns()`) keeps its exact prior signature — `Promise<XRecord[]>`,
 * still just the first page, still no truncation signal — because changing
 * a published method's return type is a breaking change. The fix is
 * additive: `listPage()` exposes the full envelope (mirrors
 * `PraesidiaMemory.list`'s existing shape, `src/memory.ts:162-192`), and
 * `listAll()` is an auto-paginating async generator so "give me all of
 * them" is correct by default (mirrors `PraesidiaAudit.stream`,
 * `src/audit.ts:88-104`) instead of correct only if the caller remembers to
 * page. `list()`/`listRuns()` are documented (JSDoc + README) as returning
 * only the first page — callers who need to detect truncation must use
 * `listPage`/`listAll`.
 */

/** be's pagination metadata (`be/src/common/dto/pagination.dto.ts`). */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage?: boolean;
}

/** A single page plus be's full pagination envelope. */
export interface PaginatedEnvelope<T> {
  data: T[];
  total: number;
  meta: PaginationMeta;
}

/**
 * Normalize a list response into `PaginatedEnvelope<T>` regardless of shape:
 * be's real `{data, total, meta}` envelope, a legacy/alternate
 * `{<dataKey>: T[]}` shape, or (defensively) a bare array. A bare array or a
 * response with no `meta` is treated as a single complete page — there is no
 * pagination signal to preserve, so `hasNextPage: false` is the honest
 * default, not an assumption that more data doesn't exist.
 */
export function normalizePagedEnvelope<T>(
  result: T[] | Record<string, unknown>,
  dataKey: string,
): PaginatedEnvelope<T> {
  if (Array.isArray(result)) {
    return {
      data: result,
      total: result.length,
      meta: {
        page: 1,
        limit: result.length,
        total: result.length,
        totalPages: 1,
        hasNextPage: false,
      },
    };
  }
  const data =
    (result['data'] as T[] | undefined) ??
    (result[dataKey] as T[] | undefined) ??
    [];
  const meta = result['meta'] as PaginationMeta | undefined;
  const total = (result['total'] as number | undefined) ?? meta?.total ?? data.length;
  return {
    data,
    total,
    meta: meta ?? {
      page: 1,
      limit: data.length,
      total,
      totalPages: 1,
      hasNextPage: false,
    },
  };
}

/**
 * Auto-paginate across every page of `fetchPage`, yielding items lazily.
 *
 * Terminal condition is an EMPTY page, not `meta.hasNextPage`/a short page —
 * matching `PraesidiaAudit.stream`'s established BUGHUNT-SDK-01 precedent
 * (`src/audit.ts:82-86`): trusting `hasNextPage` alone reintroduces the same
 * class of off-by-one this ticket exists to close if a future backend
 * response ever mis-sets it, whereas an empty page is unambiguous.
 */
export async function* paginateAll<T>(
  fetchPage: (page: number) => Promise<PaginatedEnvelope<T>>,
): AsyncGenerator<T, void, undefined> {
  let page = 1;
  for (;;) {
    const { data } = await fetchPage(page);
    if (data.length === 0) return;
    for (const item of data) yield item;
    page += 1;
  }
}
