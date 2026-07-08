/**
 * Typed test doubles for the DOM `fetch` / `Response` pair.
 *
 * The SDK talks to be-core exclusively through the global `fetch` (Node 18+
 * undici). Specs replace `globalThis.fetch` with a mock; hand-rolling that mock
 * as a plain object literal never satisfies the full `Response` shape, which
 * forced a `... as unknown as typeof fetch` (or the narrower `as typeof fetch`)
 * cast on every call site — ~40 `TS2352` "conversion may be a mistake" errors
 * under `tsc -p tsconfig.spec.json`.
 *
 * This helper builds REAL `Response` objects and a `fetch`-typed mock, so the
 * mock is directly assignable to `globalThis.fetch` with NO cast at the call
 * site.
 *
 * Fidelity: the SDK only ever reads `response.ok`, `response.status`, and
 * exactly ONE of `.json()` / `.text()` / `.arrayBuffer()` per response (see
 * `client.ts` and `trust.ts`), and never branches on a specific status code, so
 * a single-use undici `Response` is a faithful stand-in for the hand-rolled
 * object literals it replaces.
 */
import { vi } from 'vitest';

/**
 * One queued response.
 *
 * `json` and `body` are equivalent aliases for a JSON body (different SDK specs
 * historically used one or the other); pass at most one of `json`/`body`/`text`/
 * `bytes`.
 */
export interface MockResponseInit {
  /** HTTP ok flag. Only used to derive a default status; the real `Response`
   *  derives `ok` from `status`. Defaults to `true`. */
  ok?: boolean;
  /** HTTP status. Defaults to 200 when ok, 400 when `ok: false`. */
  status?: number;
  /** JSON body — serialized and readable via `response.json()`/`.text()`. */
  json?: unknown;
  /** Alias for `json`, kept for specs that pass `body`. */
  body?: unknown;
  /** Raw text body — readable via `response.text()`. */
  text?: string;
  /** Binary body — readable via `response.arrayBuffer()`. */
  bytes?: Uint8Array;
}

/** Statuses that must not carry a body (undici's `Response` throws otherwise). */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/** The body type `Response`'s constructor accepts (undici `BodyInit | null`),
 *  derived from the constructor so no DOM-lib global is required. */
type ResponseBody = ConstructorParameters<typeof Response>[0];

/**
 * Build a real, properly-typed `Response` from a spec object. The returned
 * `Response` is genuine (undici), so `.ok`/`.status`/`.headers` are consistent
 * and `.json()`/`.text()`/`.arrayBuffer()` behave exactly as in production.
 */
export function mockResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? (init.ok === false ? 400 : 200);

  let body: ResponseBody = null;
  if (!NULL_BODY_STATUS.has(status)) {
    // Copy into a fresh ArrayBuffer: a bare `Uint8Array` is accepted as a body
    // by the SDK's own (bundler) tsconfig but not by the repo-root `nodenext`
    // sweep's stricter `BodyInit`; an `ArrayBuffer` satisfies both.
    if (init.bytes !== undefined) body = new Uint8Array(init.bytes).buffer;
    else if (init.text !== undefined) body = init.text;
    else if (init.json !== undefined) body = JSON.stringify(init.json);
    else if (init.body !== undefined) body = JSON.stringify(init.body);
  }

  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A `fetch` mock that returns each queued response in order, clamping to the
 * last entry once the queue is exhausted (so pollers keep observing the final
 * state — e.g. compliance `waitForReport`). Returned as a vitest mock that is
 * directly assignable to `globalThis.fetch`:
 *
 * ```ts
 * globalThis.fetch = makeFetchMock([{ ok: true, json: { passed: true } }]);
 * ```
 *
 * No `as typeof fetch` cast is required. The mock still records call arguments,
 * so `(globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls` works as before.
 */
export function makeFetchMock(responses: MockResponseInit[]) {
  let call = 0;
  const impl: typeof fetch = async () => {
    const spec =
      responses.length === 0
        ? {}
        : responses[Math.min(call, responses.length - 1)];
    call += 1;
    return mockResponse(spec);
  };
  return vi.fn(impl);
}
