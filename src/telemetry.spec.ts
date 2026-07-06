import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PraesidiaTelemetry, genAiSpan } from './telemetry.js';
import { PraesidiaConfigError } from './errors.js';
import { OTLP_MAX_RESOURCE_SPANS } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchMock(
  responses: Array<{ ok: boolean; status?: number; body: unknown }>,
) {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[call % responses.length];
    call++;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 202 : 400),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  });
}

const config = { apiKey: 'pk_test_key' };
const ACK = { accepted: true, buffered: 1 };

function findAttr(
  attrs: Array<{ key: string; value: Record<string, unknown> }>,
  key: string,
) {
  return attrs.find((a) => a.key === key)?.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PraesidiaTelemetry', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Construction ──────────────────────────────────────────────────────────

  it('throws PraesidiaConfigError when apiKey is missing', () => {
    expect(() => new PraesidiaTelemetry({ apiKey: undefined })).toThrow(
      PraesidiaConfigError,
    );
  });

  // ── emitGenAiSpan ─────────────────────────────────────────────────────────

  it('POSTs an OTLP ExportTraceServiceRequest to the ingest endpoint with Bearer auth', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: ACK }]) as typeof fetch;

    const telemetry = new PraesidiaTelemetry({
      ...config,
      serviceName: 'support-bot',
    });
    const ack = await telemetry.emitGenAiSpan({
      agentName: 'support-bot',
      system: 'openai',
      requestModel: 'gpt-4o',
      inputTokens: 812,
      outputTokens: 143,
    });

    expect(ack).toEqual(ACK);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toContain('/telemetry/otlp/v1/traces');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer pk_test_key',
    );
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body.resourceSpans)).toBe(true);
    const rs = body.resourceSpans[0];
    // Emitting service identity stamped as the resource service.name.
    expect(findAttr(rs.resource.attributes, 'service.name')).toEqual({
      stringValue: 'support-bot',
    });
    const span = rs.scopeSpans[0].spans[0];
    const attrs = span.attributes as Array<{
      key: string;
      value: Record<string, unknown>;
    }>;
    expect(findAttr(attrs, 'gen_ai.agent.name')).toEqual({
      stringValue: 'support-bot',
    });
    expect(findAttr(attrs, 'gen_ai.system')).toEqual({ stringValue: 'openai' });
    expect(findAttr(attrs, 'gen_ai.request.model')).toEqual({
      stringValue: 'gpt-4o',
    });
    // OTLP encodes intValue as a string.
    expect(findAttr(attrs, 'gen_ai.usage.input_tokens')).toEqual({
      intValue: '812',
    });
    expect(findAttr(attrs, 'gen_ai.usage.output_tokens')).toEqual({
      intValue: '143',
    });
  });

  it('rejects a batch that exceeds the resourceSpans cap without calling fetch', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const telemetry = new PraesidiaTelemetry(config);
    const tooMany = Array.from({ length: OTLP_MAX_RESOURCE_SPANS + 1 }, () => ({
      scopeSpans: [],
    }));

    await expect(telemetry.emit(tooMany)).rejects.toThrow(PraesidiaConfigError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('exposes the ingest endpoint for pointing an external OTel exporter', () => {
    const telemetry = new PraesidiaTelemetry({
      ...config,
      baseUrl: 'https://api.example.test',
    });
    expect(telemetry.tracesEndpoint).toBe(
      'https://api.example.test/telemetry/otlp/v1/traces',
    );
  });

  // ── genAiSpan builder ─────────────────────────────────────────────────────

  it('genAiSpan builds a CLIENT-kind span with hex trace/span ids', () => {
    const span = genAiSpan({ agentName: 'bot', requestModel: 'gpt-4o' });
    expect(span.kind).toBe(3);
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.startTimeUnixNano).toMatch(/^\d+$/);
    expect(span.name).toBe('chat gpt-4o');
  });
});
