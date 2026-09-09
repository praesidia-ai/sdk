# Durable approval and independently verifiable HTTP execution

`PraesidiaProtectedHttp` adds a protected HTTP POST boundary with a durable approval checkpoint. The Python SDK exposes `client.protected_http` and an optional LangGraph graph. The original requester prepares the action, a distinct human reviews the exact request in **Monitor → Governance → Approvals**, and the requester resumes after that durable decision. Arbitrary LangGraph resume values never substitute for approval.

## Operator setup

Enable `proof.actions` and approval workflows for the organization. The requester needs `workflows.execute` and a user-backed session or personal key with `agents:invoke`. Delegated user authority is checked again and held through the dispatch boundary. Workload credentials without a human requester do not inherit user roles.

Configure `PROTECTED_HTTP_TARGETS` on the backend as a JSON array:

```json
[{"id":"ledger","url":"https://ledger.example/record","keyId":"receipt-2026","publicKeyPem":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n","organizationIds":["your-org-id"],"timeoutMs":10000,"bearerToken":"target-ingress-credential-from-your-secret-store"}]
```

The operator supplies the target's Ed25519 public key separately from responses. URLs must be HTTPS with no embedded credentials, query, or fragment. Connections use the existing DNS/IP pinning policy; redirects are not followed. The optional ingress bearer token is kept out of approval/evidence payloads. Restrict the target's ingress to authorized callers; the target receipt attests this captured action and does not claim all other target ingress is governed. `allowLocalDevelopment:true` permits local acceptance targets only in development/test, never production.

The approval and event ledger contain the exact request and returned JSON result. Apply the platform's access, retention and export controls to that evidence; avoid sending secrets in the business body when a separate ingress credential is appropriate. Request bodies are limited to 64 KiB and target replies to 128 KiB.

## TypeScript lifecycle

```ts
import { PraesidiaProtectedHttp, verifyProtectedHttpResult } from '@praesidia/sdk';
const execution = new PraesidiaProtectedHttp({ apiKey, orgId, baseUrl });
const request = {
  targetId: 'ledger', body: { recordId: 'record-123', value: 'approved-value' },
  checkpoint: { runtime: 'custom' as const, threadId: 'case-123', nodeId: 'record-once' },
};
const checkpoint = await execution.prepare({ ...request, description: 'Record the approved value' });
// A distinct human reviews and approves checkpoint.approvalId in Praesidia.
const result = await execution.resume({ ...request, approvalId: checkpoint.approvalId });
const trustedTarget = { targetId: 'ledger', destination: 'https://ledger.example/record', keyId: 'receipt-2026', publicKeyPem };
if (!verifyProtectedHttpResult(result, request, trustedTarget, orgId)) throw new Error('Target receipt could not be independently verified');
await execution.acknowledge(result);
```

Repeated `prepare` with the same requester/runtime/thread/node recovers the same approval. A changed body, target identity/key/destination, checkpoint, or delegated grant fails. Use a new nodeId for a new logical action. `revoke(approvalId)` cancels a pending/approved checkpoint only before its atomic consumption. Expiry, rejected/cancelled decisions, revoked signing keys, frozen tenants and invalid live authority all fail closed. A resumed checkpoint consumes an existing short-lived permit and durable single-use nonce before dispatch.

A lost response is ambiguous. Do not repeat a dispatch: call `checkpoint(approvalId)` for recorded result/closure/evidence instead. A consumed checkpoint without a completed evidence record reports an unknown outcome. If the process dies between a consumption claim and network dispatch, operator review is required; at-most-once admission deliberately does not invent exactly-once external effects.

## LangGraph with durable state

Install `praesidia[langgraph]` on Python 3.10+. Pass a durable saver and the same real `configurable.thread_id` on every invocation. Preparation, interruption and execution are separate graph nodes because LangGraph re-executes an interrupted node from its beginning. The server's unique checkpoint also covers a crash after preparation commits but before LangGraph persists that node result. See [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) and [persistence](https://docs.langchain.com/oss/python/langgraph/persistence).

```python
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command
from praesidia.integrations.langgraph import protected_http_graph

config = {"configurable": {"thread_id": "case-123"}}
with SqliteSaver.from_conn_string("checkpoints.sqlite") as saver:
    graph = protected_http_graph(client.protected_http, checkpointer=saver)
    graph.invoke({"request": {
        "targetId": "ledger", "body": {"value": "approved-value"},
        "description": "Record the approved value",
        "checkpoint": {"runtime": "langgraph", "threadId": "case-123", "nodeId": "record-once"}
    }}, config)
# Process can stop here. Reopen the same saver and graph after human approval.
with SqliteSaver.from_conn_string("checkpoints.sqlite") as saver:
    graph = protected_http_graph(client.protected_http, checkpointer=saver)
    result = graph.invoke(Command(resume=True), config)
```

The Python `examples/protected_http_langgraph.py` runs those phases in separate processes against a real backend; `examples/protected-http-target.mjs` in the TypeScript SDK supplies an independently keyed local receipt target with a durable effect ledger.

## Receipt contract and trust

The request commitment is lowercase SHA-256 over RFC 8785 canonical JSON:

```json
{"version":"praesidia.http-request.v1","targetId":"ledger","destination":"https://ledger.example/record","targetKeyFingerprint":"sha256-of-Ed25519-SPKI-DER","method":"POST","contentType":"application/json","body":{}}
```

The target independently recomputes that commitment and returns `{result,receipt:{statement,signature}}`. The Ed25519 signature covers the strict canonical statement fields: `version:"praesidia.http-receipt.v1"`, `actionId`, `organizationId`, `targetId`, `keyId`, `requestCommitment`, `resultCommitment`, `effect`, `issuedAt` (UTC ISO milliseconds), and `targetTransactionId`. `resultCommitment` is SHA-256 of the canonical returned result. `effect` is `succeeded`, `failed_no_effect`, `partial`, or `unknown`. Backend receipt time tolerance is five minutes.

A valid independent target receipt can establish **A** for that target assertion. Missing/invalid receipts or transport failure remain **C / OUTCOME_UNKNOWN**. A signed partial effect remains **PARTIAL**, and a signed unknown effect remains **OUTCOME_UNKNOWN**. An HTTP 200 or a signature-shaped string alone never establishes A. A signed statement does not independently observe business effects outside the target. The authenticated caller's acknowledgment is a separate ledger event and does not upgrade target trust.

The offline audit verifier takes `targetPublicKeys` keyed by `organizationId:targetId:keyId`, or `--target-keys <json-file>`. Supply keys through an independent trust channel; the bundle cannot nominate its own trusted target key. The verifier reconstructs the original request/result, checks exact commitments, checks the target signature and closure consistency, and rejects unpinned/forged A claims. Platform attestation trust remains separate. Existing managed MCP evidence stays capped at C. Export manifests conservatively count HTTP actions at C; receipt verification derives stronger individual evidence only when the required independent pins and matching content are present.
