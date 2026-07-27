import { randomBytes } from 'node:crypto';
import { PraesidiaClient } from './client.js';
import { PraesidiaConfigError } from './errors.js';
import type {
  GenAiSpanInput,
  GuardConfig,
  OtlpExportTraceServiceRequest,
  OtlpIngestAck,
  OtlpKeyValue,
  OtlpResourceSpans,
  OtlpSpan,
} from './types.js';
import { OTLP_MAX_BODY_BYTES, OTLP_MAX_RESOURCE_SPANS } from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

/** OTLP/HTTP GenAI trace ingest endpoint (org-key auth, top-level route). */
const OTLP_TRACES_PATH = '/telemetry/otlp/v1/traces';

/**
 * OpenTelemetry GenAI semantic-convention attribute keys the be-core receiver
 * (`telemetry-ingest.constants.ts` → GENAI_ATTR) reads. Kept in lock-step so an
 * SDK-emitted span materialises into an OBSERVED agent.
 */
const GENAI_ATTR = {
  system: 'gen_ai.system',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  agentName: 'gen_ai.agent.name',
  agentId: 'gen_ai.agent.id',
  operationName: 'gen_ai.operation.name',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
} as const;

/** Standard OTel resource attribute carrying the emitting service identity. */
const SERVICE_NAME_ATTR = 'service.name';

/** SPAN_KIND_CLIENT — a GenAI inference call is a client span. */
const SPAN_KIND_CLIENT = 3;

/**
 * PraesidiaTelemetry — the thin OTLP/HTTP GenAI trace EMITTER (H1-02).
 *
 * This is how an SDK-instrumented agent becomes an **OBSERVED** agent: it pushes
 * OTLP/HTTP GenAI-convention traces to `POST /telemetry/otlp/v1/traces`, which
 * buffers them and materialises the emitting agent from the GenAI spans (with
 * zero backend registration). It is a MINIMAL exporter — it does NOT vendor an
 * OpenTelemetry SDK (the TS SDK has zero runtime dependencies). If you already
 * run the OpenTelemetry SDK, point its OTLP/HTTP exporter at the endpoint below
 * with the `Authorization: Bearer <org pk_ key>` header instead; this class is
 * the dependency-free path for agents that don't.
 *
 * Auth: `Authorization: Bearer <apiKey>` where `apiKey` is an ORGANIZATION API
 * key (`pk_...`). The endpoint takes the tenant SOLELY from that key — there is
 * no orgId in the path — so this class only needs `apiKey` (+ optional baseUrl).
 *
 * Bounds mirrored from the server (fail-fast before the network):
 *   - ≤ {@link OTLP_MAX_RESOURCE_SPANS} (100) resourceSpans per request
 *   - ≤ {@link OTLP_MAX_BODY_BYTES} (2 MB) serialized body
 *   - 120 requests/min server-side rate limit (batch your spans)
 *
 * Usage (zero config — reads from env vars):
 *   const telemetry = new PraesidiaTelemetry();
 *   await telemetry.emitGenAiSpan({
 *     agentName: 'support-bot',
 *     system: 'openai',
 *     requestModel: 'gpt-4o',
 *     inputTokens: 812,
 *     outputTokens: 143,
 *   });
 */
export class PraesidiaTelemetry {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly client: PraesidiaClient;
  /** Optional service.name stamped on the OTLP Resource of built payloads. */
  private readonly serviceName: string | undefined;

  constructor(config: GuardConfig & { serviceName?: string } = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    this.baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;

    if (!apiKey) {
      throw new PraesidiaConfigError(
        'PraesidiaTelemetry requires PRAESIDIA_API_KEY (an organization API key)',
      );
    }

    this.apiKey = apiKey;
    this.serviceName =
      config.serviceName ?? process.env['PRAESIDIA_SERVICE_NAME'] ?? undefined;
    this.client = new PraesidiaClient(
      this.baseUrl,
      apiKey,
      config.requestTimeoutMs,
    );
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Emit a raw OTLP/HTTP ExportTraceServiceRequest (`{ resourceSpans: [...] }`).
   *
   * Use this when you already have OTLP resourceSpans (e.g. from an OTel SDK).
   * The batch is validated against the server bounds BEFORE sending so a
   * too-large payload fails fast with a `PraesidiaConfigError` rather than a
   * 413/422 round-trip. Returns the ingest ack (`{ accepted, buffered }`).
   */
  async emit(
    resourceSpans: OtlpResourceSpans[],
  ): Promise<OtlpIngestAck> {
    if (!Array.isArray(resourceSpans)) {
      throw new PraesidiaConfigError('emit() requires a resourceSpans array');
    }
    if (resourceSpans.length > OTLP_MAX_RESOURCE_SPANS) {
      throw new PraesidiaConfigError(
        `Too many resourceSpans (${resourceSpans.length} > ${OTLP_MAX_RESOURCE_SPANS}); ` +
          'split into smaller batches.',
      );
    }
    const body: OtlpExportTraceServiceRequest = { resourceSpans };
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, 'utf8') > OTLP_MAX_BODY_BYTES) {
      throw new PraesidiaConfigError(
        `OTLP payload exceeds the ${OTLP_MAX_BODY_BYTES}-byte body limit; ` +
          'reduce the batch size.',
      );
    }
    // The endpoint answers 202 Accepted with the ack body; PraesidiaClient.post
    // treats any 2xx as ok.
    return this.client.post<OtlpIngestAck>(OTLP_TRACES_PATH, body);
  }

  /**
   * Emit one or more GenAI-convention spans as a single OTLP batch. Convenience
   * over {@link emit} that builds the resourceSpans for you via
   * {@link buildGenAiResourceSpans}. Returns the ingest ack.
   */
  async emitGenAiSpans(
    spans: GenAiSpanInput[],
  ): Promise<OtlpIngestAck> {
    return this.emit(this.buildGenAiResourceSpans(spans));
  }

  /** Emit a single GenAI-convention span. Returns the ingest ack. */
  async emitGenAiSpan(span: GenAiSpanInput): Promise<OtlpIngestAck> {
    return this.emitGenAiSpans([span]);
  }

  /**
   * Build the OTLP resourceSpans for a set of GenAI spans WITHOUT sending them —
   * useful if you want to merge them into a larger batch or emit later. The
   * emitting service identity is stamped as the resource `service.name`.
   */
  buildGenAiResourceSpans(
    spans: GenAiSpanInput[],
  ): OtlpResourceSpans[] {
    const resource = this.serviceName
      ? {
          attributes: [strAttr(SERVICE_NAME_ATTR, this.serviceName)],
        }
      : undefined;
    return [
      {
        ...(resource ? { resource } : {}),
        scopeSpans: [
          {
            scope: { name: '@praesidia/sdk', version: SDK_SCOPE_VERSION },
            spans: spans.map((s) => genAiSpan(s)),
          },
        ],
      },
    ];
  }

  /** The OTLP ingest endpoint path (for pointing an external OTel exporter). */
  get tracesEndpoint(): string {
    return `${this.baseUrl}${OTLP_TRACES_PATH}`;
  }

  /**
   * Adopt a rotated credential in-process (zero-downtime swap). The new key is
   * held only in memory and never logged.
   */
  refreshCredential(apiKey: string): void {
    this.client.setApiKey(apiKey);
  }
}

/** Version stamped on the SDK's OTLP instrumentation scope. */
const SDK_SCOPE_VERSION = '0.1.0';

/** Build an OTLP string KeyValue attribute. */
function strAttr(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

/** Build an OTLP int KeyValue attribute (OTLP encodes intValue as a string). */
function intAttr(key: string, value: number): OtlpKeyValue {
  return { key, value: { intValue: String(value) } };
}

/**
 * H1-02 — synthesize ONE OTLP GenAI-convention span from simple inputs. The
 * attribute keys mirror the backend GenAI parser exactly so the emitting agent
 * is materialised as an OBSERVED agent. Exported for direct use / testing.
 */
export function genAiSpan(input: GenAiSpanInput): OtlpSpan {
  const attributes: OtlpKeyValue[] = [
    strAttr(GENAI_ATTR.agentName, input.agentName),
  ];
  if (input.agentId) attributes.push(strAttr(GENAI_ATTR.agentId, input.agentId));
  if (input.system) attributes.push(strAttr(GENAI_ATTR.system, input.system));
  if (input.requestModel)
    attributes.push(strAttr(GENAI_ATTR.requestModel, input.requestModel));
  if (input.responseModel)
    attributes.push(strAttr(GENAI_ATTR.responseModel, input.responseModel));
  if (input.operationName)
    attributes.push(strAttr(GENAI_ATTR.operationName, input.operationName));
  if (typeof input.inputTokens === 'number')
    attributes.push(intAttr(GENAI_ATTR.inputTokens, input.inputTokens));
  if (typeof input.outputTokens === 'number')
    attributes.push(intAttr(GENAI_ATTR.outputTokens, input.outputTokens));
  if (input.extraAttributes) attributes.push(...input.extraAttributes);

  const start = Date.now();
  const durationMs = input.durationMs ?? 0;
  const name =
    input.name ??
    `${input.operationName ?? 'chat'} ${input.requestModel ?? ''}`.trim();

  return {
    traceId: randomHex(16),
    spanId: randomHex(8),
    name,
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: msToUnixNano(start),
    endTimeUnixNano: msToUnixNano(start + durationMs),
    attributes,
  };
}

/** Random lowercase-hex id of `bytes` bytes (16→32-char traceId, 8→16 spanId). */
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** Convert epoch-millis to a unix-nanoseconds decimal string. */
function msToUnixNano(ms: number): string {
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}
