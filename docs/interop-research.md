# Developer integration gaps and evidence readback

Reviewed 2026-09-05 against primary specifications and the local repositories.
This is a source and client-contract assessment, not a production-conformance
claim or an external security audit.

## What a usable integration needs

MCP's 2025-11-25 HTTP authorization profile requires protected-resource
discovery, resource-bound access tokens, and handling authentication and
scope challenges. Upstream tokens are separate from tokens accepted by an
MCP server. Praesidia's management keys and task capability headers are a
different interface and must not be presented as implementing this entire
profile. [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

A2A clients discover authentication requirements in an Agent Card, obtain
credentials through the applicable external flow, and authenticate each
request. The protocol also defines task operations, lifecycle states, and
standard bindings. A proprietary task API can support useful orchestration
without establishing interoperability with those bindings. [A2A specification, authentication and authorization](https://a2a-protocol.org/latest/specification/#7-authentication-and-authorization).

OpenTelemetry provides shared GenAI names such as `gen_ai.operation.name`
and tool attributes. Its older GenAI agent-span page now points to a separate
conventions repository. Existing instrumentation should pin the convention
version and verify emitted fields against its chosen collector contract;
trace correlation alone is not proof that a tool action was authorized.
[OpenTelemetry GenAI attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/),
[GenAI conventions migration notice](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/).

RFC 9943 separates signed statements from transparency receipts. Verification
depends on a relying party's trusted issuer key, and richer per-component
results can describe what was established. Praesidia's current JSON/ZIP
evidence format must remain labeled as its own format; adding SDK download
methods does not turn it into SCITT COSE receipts.
[RFC 9943, transparent statements and validation](https://www.rfc-editor.org/rfc/rfc9943.html#section-7).

## Ranked gaps

| Priority | Observed gap | Evidence and action |
| --- | --- | --- |
| 1 | A governed call returns an action ID but SDK consumers cannot retrieve its lifecycle or signed bundle through a supported resource. | `sdk/src/guard.ts:protectAction` and `sdk-python/praesidia/agents.py:protect_action` already execute managed MCP calls. Backend `protected-actions.controller.ts` exposes five read paths and `audit.controller.ts` exposes signed bundle export. Closed by this change. |
| 1 | Evidence reads had session-only authentication, despite SDKs authenticating with management keys. | Backend `ProtectedActionsController` used `JwtAuthGuard`. Coordinated backend work admits personal user-backed keys with `audit:read`, retaining membership, feature, and permission checks; workload credentials remain excluded. |
| 2 | Direct protocol integration and a management API can be confused. | SDK tool calls use Praesidia's `/organizations/.../mcp-servers/.../tools/.../call` plus task/agent/capability headers. Native MCP OAuth discovery and A2A binding conformance need their own adapter and interoperability tests; they are not implemented by evidence reads. |
| 2 | Evidence availability and operational outcome can be misread as an independent verdict. | Backend detail DTO separates `closure`, `completenessStatus`, and `verificationStatus`; event DTO contains signatures and string sequences. The new resources preserve these separately and never synthesize a verification status or coverage percentage. |
| 3 | Cross-language observability and local lifecycle helpers differ. | Both SDKs contain GenAI OTLP emitters and managed protected calls; Python remains synchronous and does not mirror TypeScript's local `beginTask`/`TaskHandle` surface. Prioritize a shared convention fixture and common asynchronous lifecycle semantics before adding more independent helpers. |
| 3 | Standardized receipts and production trust provisioning remain separate deliverables. | The audit verifier already checks Praesidia bundles and requires an independently trusted platform key. The source/distribution trust-anchor release gate and SCITT conversion/conformance are not bypassed or claimed complete by these SDK additions. |

## Implemented contract

- TypeScript `PraesidiaProof`: `list`, `get`, `events`, `captureScope`,
  `coverageSummary`, and credential refresh. Python: the corresponding
  `client.proof` methods using Python naming conventions.
- Signed ZIP download: `PraesidiaAudit.exportBundle({from,to})` and
  `client.audit.export_bundle(from_date=..., to_date=...)`.
- Exact server pagination envelope, signature strings, decimal bigint event
  sequences, explicit nulls, declared capture scope, and aggregate counts
  remain intact. No SDK-generated success or verification verdict is added.
- Timezone-explicit date windows, 90-day bundle limit, bounded binary
  transport, normal authentication errors, and existing finite timeouts.
- Tests exercise both languages' paths, query names, permission-denial
  propagation, unusual sequence values, redaction, credential rotation,
  date/range validation, and binary download limits. Build and route-contract
  checks validate integration with the existing backend API catalogue.
