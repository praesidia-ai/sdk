import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PraesidiaTelemetry, genAiSpan } from './telemetry.js';
import { PraesidiaConfigError } from './errors.js';
import { OTLP_MAX_BODY_BYTES, OTLP_MAX_RESOURCE_SPANS } from './types.js';
import type { OtlpKeyValue } from './types.js';
import { makeFetchMock } from './__tests__/fetch-mock.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const config = { apiKey: 'pk_test_key' };
const ACK = { accepted: true, buffered: 1 };

function findAttr(
  attrs: OtlpKeyValue[],
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

  it('rejects an unsafe rotated credential', () => {
    const telemetry = new PraesidiaTelemetry({ apiKey: 'pk_x', orgId: 'org-1' });
    expect(() => telemetry.refreshCredential('bad\r\nkey')).toThrow(
      PraesidiaConfigError,
    );
  });

  it('rejects a non-object span input at runtime', () => {
    expect(() => genAiSpan(null as never)).toThrow(PraesidiaConfigError);
  });

  // ── Construction ──────────────────────────────────────────────────────────

  it('throws PraesidiaConfigError when apiKey is missing', () => {
    expect(() => new PraesidiaTelemetry({ apiKey: undefined })).toThrow(
      PraesidiaConfigError,
    );
  });

  it.each(['', ' service', 'x'.repeat(256)])(
    'rejects an invalid serviceName: %s',
    (serviceName) => {
      expect(
        () => new PraesidiaTelemetry({ ...config, serviceName }),
      ).toThrow(PraesidiaConfigError);
    },
  );

  // ── emitGenAiSpan ─────────────────────────────────────────────────────────

  it('POSTs an OTLP ExportTraceServiceRequest to the ingest endpoint with Bearer auth', async () => {
    globalThis.fetch = makeFetchMock([{ ok: true, body: ACK }]);

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
    const attrs = span.attributes as OtlpKeyValue[];
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
    const spy = makeFetchMock([]);
    globalThis.fetch = spy;

    const telemetry = new PraesidiaTelemetry(config);
    const tooMany = Array.from({ length: OTLP_MAX_RESOURCE_SPANS + 1 }, () => ({
      scopeSpans: [],
    }));

    await expect(telemetry.emit(tooMany)).rejects.toThrow(PraesidiaConfigError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects malformed or oversized raw batches without calling fetch', async () => {
    const spy = makeFetchMock([]);
    globalThis.fetch = spy;
    const telemetry = new PraesidiaTelemetry(config);

    await expect(telemetry.emit(['invalid'] as never)).rejects.toThrow(
      PraesidiaConfigError,
    );
    await expect(
      telemetry.emit([
        { scopeSpans: [], padding: 'x'.repeat(OTLP_MAX_BODY_BYTES) },
      ] as never),
    ).rejects.toThrow(PraesidiaConfigError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an empty built span batch', () => {
    const telemetry = new PraesidiaTelemetry(config);
    expect(() => telemetry.buildGenAiResourceSpans([])).toThrow(
      PraesidiaConfigError,
    );
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
    const span = genAiSpan({
      agentName: 'bot',
      agentId: 'agent-1',
      system: 'openai',
      requestModel: 'gpt-4o',
      responseModel: 'gpt-4o-2026-08-01',
      operationName: 'chat',
      inputTokens: 10,
      outputTokens: 5,
      name: 'named-span',
      durationMs: 25,
      extraAttributes: [
        { key: 'custom', value: { stringValue: 'value' } },
      ],
    });
    expect(span.kind).toBe(3);
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.startTimeUnixNano).toMatch(/^\d+$/);
    expect(span.name).toBe('named-span');
    expect(
      BigInt(span.endTimeUnixNano!) - BigInt(span.startTimeUnixNano!),
    ).toBe(25_000_000n);
    expect(findAttr(span.attributes!, 'gen_ai.agent.id')).toEqual({
      stringValue: 'agent-1',
    });
    expect(findAttr(span.attributes!, 'gen_ai.response.model')).toEqual({
      stringValue: 'gpt-4o-2026-08-01',
    });
    expect(findAttr(span.attributes!, 'custom')).toEqual({
      stringValue: 'value',
    });
  });

  it.each([
    { agentName: '' },
    { agentName: ' bot' },
    { agentName: 'bot', requestModel: ' model' },
    { agentName: 'bot', inputTokens: -1 },
    { agentName: 'bot', inputTokens: 1.5 },
    { agentName: 'bot', outputTokens: Number.NaN },
    { agentName: 'bot', durationMs: -1 },
    { agentName: 'bot', extraAttributes: ['invalid'] },
  ])('genAiSpan rejects backend-invalid input: %o', (input) => {
    expect(() => genAiSpan(input as never)).toThrow(PraesidiaConfigError);
  });
});
