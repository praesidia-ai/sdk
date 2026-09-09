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
export const GENAI_SEMCONV_VERSION = '1.37.0';

const GENAI_ATTR = {
  providerName: 'gen_ai.provider.name',
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
const MAX_AGENT_IDENTITY_LENGTH = 255;
const MAX_ATTRIBUTE_VALUE_LENGTH = 512;

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

    // SCAN2-013/CT-10 — no `this.apiKey = apiKey` here: this field was
    // write-only (assigned, never read again) and existed purely as a
    // runtime-enumerable leak surface. `this.client` already holds the key
    // behind `PraesidiaClient`'s true private `#apiKey` field.
    this.serviceName = validatedText(
      config.serviceName ?? process.env['PRAESIDIA_SERVICE_NAME'] ?? undefined,
      'serviceName',
      MAX_AGENT_IDENTITY_LENGTH,
    );
    this.client = new PraesidiaClient(
      this.baseUrl,
      apiKey,
      config.requestTimeoutMs,
      config.retry,
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
    if (resourceSpans.some((resourceSpan) => !isRecord(resourceSpan))) {
      throw new PraesidiaConfigError('each resourceSpans item must be an object');
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
    if (!Array.isArray(spans) || spans.length === 0) {
      throw new PraesidiaConfigError('spans must be a non-empty array');
    }
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
            schemaUrl: `https://opentelemetry.io/schemas/${GENAI_SEMCONV_VERSION}`,
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
const SDK_SCOPE_VERSION = '0.3.1';

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
  if (!isRecord(input)) {
    throw new PraesidiaConfigError('span input must be an object');
  }
  const agentName = validatedText(
    input.agentName,
    'agentName',
    MAX_AGENT_IDENTITY_LENGTH,
    true,
  )!;
  const agentId = validatedText(
    input.agentId,
    'agentId',
    MAX_AGENT_IDENTITY_LENGTH,
  );
  const system = validatedText(
    input.system,
    'system',
    MAX_ATTRIBUTE_VALUE_LENGTH,
  );
  const requestModel = validatedText(
    input.requestModel,
    'requestModel',
    MAX_ATTRIBUTE_VALUE_LENGTH,
  );
  const responseModel = validatedText(
    input.responseModel,
    'responseModel',
    MAX_ATTRIBUTE_VALUE_LENGTH,
  );
  const operationName = validatedText(
    input.operationName,
    'operationName',
    MAX_ATTRIBUTE_VALUE_LENGTH,
  );
  const name = validatedText(
    input.name,
    'name',
    MAX_AGENT_IDENTITY_LENGTH,
  );
  const inputTokens = validatedNonNegativeInteger(
    input.inputTokens,
    'inputTokens',
  );
  const outputTokens = validatedNonNegativeInteger(
    input.outputTokens,
    'outputTokens',
  );
  const durationMs = validatedNonNegativeInteger(
    input.durationMs ?? 0,
    'durationMs',
  )!;
  if (
    input.extraAttributes !== undefined &&
    (!Array.isArray(input.extraAttributes) ||
      input.extraAttributes.some((attribute) => !isRecord(attribute)))
  ) {
    throw new PraesidiaConfigError(
      'extraAttributes must be an array of OTLP attribute objects',
    );
  }
  const attributes: OtlpKeyValue[] = [
    strAttr(GENAI_ATTR.agentName, agentName),
  ];
  if (agentId) attributes.push(strAttr(GENAI_ATTR.agentId, agentId));
  if (system) {
    attributes.push(strAttr(GENAI_ATTR.providerName, system));
    attributes.push(strAttr(GENAI_ATTR.system, system));
  }
  if (requestModel)
    attributes.push(strAttr(GENAI_ATTR.requestModel, requestModel));
  if (responseModel)
    attributes.push(strAttr(GENAI_ATTR.responseModel, responseModel));
  if (operationName)
    attributes.push(strAttr(GENAI_ATTR.operationName, operationName));
  if (inputTokens !== undefined)
    attributes.push(intAttr(GENAI_ATTR.inputTokens, inputTokens));
  if (outputTokens !== undefined)
    attributes.push(intAttr(GENAI_ATTR.outputTokens, outputTokens));
  for (const [key, value] of [
    ['praesidia.task.id', input.taskId],
    ['praesidia.action.id', input.actionId],
  ] as const) {
    const id = validatedText(value, key, MAX_AGENT_IDENTITY_LENGTH);
    if (id) attributes.push(strAttr(key, id));
  }
  const reserved = new Set<string>([...Object.values(GENAI_ATTR), 'praesidia.task.id', 'praesidia.action.id']);
  attributes.push(...safeExtraAttributes(input, reserved));
  const parent = parseTraceparent(input.traceparent);

  const start = Date.now();
  const spanName =
    name ?? `${operationName ?? 'chat'} ${requestModel ?? ''}`.trim();

  return {
    traceId: parent?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    ...(parent ? { parentSpanId: parent.parentSpanId, flags: parent.flags } : {}),
    name: spanName,
    kind: SPAN_KIND_CLIENT,
    startTimeUnixNano: msToUnixNano(start),
    endTimeUnixNano: msToUnixNano(start + durationMs),
    attributes,
  };
}

function validatedText(
  value: unknown,
  label: string,
  maxLength: number,
  required = false,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > maxLength
  ) {
    throw new PraesidiaConfigError(
      `${label} must be ${required ? 'a non-empty' : 'a'} string without ` +
        `surrounding whitespace and at most ${maxLength} characters`,
    );
  }
  return value;
}

function validatedNonNegativeInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new PraesidiaConfigError(
      `${label} must be a non-negative integer`,
    );
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Random lowercase-hex id of `bytes` bytes (16→32-char traceId, 8→16 spanId). */
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** Convert epoch-millis to a unix-nanoseconds decimal string. */
function msToUnixNano(ms: number): string {
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

/** W3C processing: invalid context starts a new root; valid future versions retain the known prefix. */
export function parseTraceparent(value: unknown): { traceId: string; parentSpanId: string; flags: number } | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/.exec(value);
  if (!match || match[1] === 'ff' || /^0+$/.test(match[2]!) || /^0+$/.test(match[3]!)) return undefined;
  if (match[1] === '00' ? match[5] !== '' : match[5] !== '' && !match[5]!.startsWith('-')) return undefined;
  return { traceId: match[2]!, parentSpanId: match[3]!, flags: parseInt(match[4]!, 16) & 1 };
}

const CONTENT_KEY = /(?:^gen_ai\.(?:input\.messages|output\.messages|system_instructions|prompt|completion|retrieval\.(?:documents|query\.text))$|(?:^|[._-])(?:content|body|prompt|completion|messages)(?:$|[._-]))/i;
const SECRET_KEY = /(?:authorization|api[._-]?key|password|secret|cookie|access[._-]?token|refresh[._-]?token)/i;

function safeExtraAttributes(input: GenAiSpanInput, reserved: Set<string>): OtlpKeyValue[] {
  if (input.captureContent !== undefined && typeof input.captureContent !== 'boolean') throw new PraesidiaConfigError('captureContent must be a boolean');
  if (input.captureContent && typeof input.redactContent !== 'function') throw new PraesidiaConfigError('captureContent requires redactContent');
  const out: OtlpKeyValue[] = [];
  for (const attribute of input.extraAttributes ?? []) {
    if (typeof attribute.key !== 'string' || !attribute.key || attribute.key.length > 128 || !isRecord(attribute.value)) throw new PraesidiaConfigError('invalid extra attribute');
    if (reserved.has(attribute.key)) throw new PraesidiaConfigError('extraAttributes cannot override reserved identity or correlation keys');
    if (SECRET_KEY.test(attribute.key)) continue;
    if (CONTENT_KEY.test(attribute.key)) {
      if (!input.captureContent) continue;
      if (typeof attribute.value.stringValue !== 'string') throw new PraesidiaConfigError('captured content must be a string attribute');
      const redacted = input.redactContent!(attribute.value.stringValue);
      if (typeof redacted !== 'string' || Buffer.byteLength(redacted, 'utf8') > 16384) throw new PraesidiaConfigError('redactContent must return a string of at most 16384 bytes');
      out.push(strAttr(attribute.key, redacted));
    } else {
      out.push(attribute);
    }
    reserved.add(attribute.key);
  }
  return out;
}
