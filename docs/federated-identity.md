# Workload federation and delegated user credentials

Praesidia exchanges externally signed OIDC JWT assertions for short-lived, resource-bound `pfa_` credentials. Assertions must match an administrator-pinned issuer, public JWKS, input audience, and exact subject binding. The accepted algorithms are RS256, ES256, and EdDSA; symmetric/private keys and token-supplied key-discovery URLs are rejected. Assertions require `iss`, `sub`, `aud`, `iat`, and `exp`, with a maximum one-hour assertion lifetime. A derived credential lasts at most five minutes and never outlives its assertion, consent, or parent.

An organization owner with `security.manage` configures trust at `POST /organizations/:orgId/identity/providers`, then maps an exact external subject to a local active agent or user at `POST /organizations/:orgId/identity/bindings`. Each binding contains explicit resources and scopes. Resource strings match exactly. Wildcard scopes are prohibited. Public keys can be rotated, or an issuer disabled, using `PATCH /organizations/:orgId/identity/providers/:id`; previous grants are revoked. `DELETE /organizations/:orgId/identity/bindings/:id` disables a subject permanently. Configuration itself does not prove a successful assertion exchange.

User delegation requires a separate user binding and workload actor binding. The bound user approves an expiring consent at `POST /organizations/:orgId/identity/consents` from their own authenticated browser session. The request identifies `subjectBindingId`, `actorBindingId`, exact `resources`, exact `scopes`, and `expiresAt` (up to thirty days). Browser authorization code/PKCE clients use the same durable consent and grant service. An administrator cannot impersonate the user to approve their consent.

```ts
import { PraesidiaIdentity } from '@praesidia/sdk';

const identity = new PraesidiaIdentity({ baseUrl: 'https://api.example.com' });
const credential = await identity.exchange({
  organizationId: orgId,
  subjectBindingId: workloadBindingId,
  subjectToken: await obtainFreshOidcAssertion(),
  resource: 'https://api.example.com/a2a/v1/agents/' + targetAgentId,
  scopes: ['a2a:message', 'a2a:task'],
});
// Present credential.access_token to that exact resource's protocol adapter.
```

For delegated API operations, exchange the user assertion with `delegation: { actorBindingId, actorToken, consentId }`. The API checks the user's current membership, role, permissions, declared key scopes, feature gates, and live delegated authority. A bare workload credential cannot become a management user. Personal API keys and existing OAuth client credentials retain their existing paths.

```ts
const acquire = identity.credentialProvider(async () => ({
  organizationId: orgId,
  subjectBindingId: userBindingId,
  subjectToken: await obtainFreshUserAssertion(),
  delegation: {
    actorBindingId: workloadBindingId,
    actorToken: await obtainFreshWorkloadAssertion(),
    consentId,
  },
  resource: 'https://api.example.com',
  scopes: ['agents:invoke'],
}));

guard.refreshCredential(await acquire());
// Invoke the authorized protected action immediately after acquisition.
```

Assertions are one-use. Re-signing the same issuer/subject/`jti` does not reset replay protection; assertions without `jti` are deduplicated by their signed bytes. Clients never automatically retry an external exchange after a network error. Obtain a new assertion to retry.

MCP's audience is its configured canonical MCP URL. Before calling backend APIs, the MCP server down-exchanges the token with `subjectResource` set to that exact MCP audience and `resource` set to the API origin. Both resources must be allowed by the binding and user consent. The child preserves the actor/user and is a subset of the parent's scopes; omitting `scopes` preserves the exact parent scopes. Repeating the same down-exchange returns the same child without extending its expiration. Parent, consent, provider and binding state are rechecked on every use. A token for another resource cannot be passed through to the API.

`identity.introspect(apiToken)` performs a live API-audience check; it does not positively cache authorization. The MCP transport likewise introspects every authenticated HTTP request, including reconnects and session reuse.

Task authority is saved before queue handoff and rechecked by the worker, routed poll delivery, and task-scoped capability mint/verification. A continuation of a delegated task requires authenticated authority rather than silently dropping its provenance. Revoking a grant or consent rejects new uses immediately and persists cancellation work for active tasks through the existing lifecycle. Cancellation failures remain visible in `GET /organizations/:orgId/identity` as `pendingTaskRevocations` and retry automatically. A call already admitted by the shared authority lease can finish before revocation commits; remote side effects are not claimed to be reversible. Account erasure also revokes historical memberships' authority and scrubs external user subject strings.

Deployment requires applying the checked-in identity migration, importing `FederatedIdentityModule` in the API/worker graph, an enforcing RLS runtime role, the canonical `BACKEND_URL`, and operator-provided public issuer trust/binding configuration. Tests use generated keys and isolated PostgreSQL; they do not attest any customer's identity provider or workload hardware.

Protocol sources: [RFC 8693 token exchange](https://www.rfc-editor.org/rfc/rfc8693.html), [RFC 8707 resource indicators](https://www.rfc-editor.org/rfc/rfc8707.html), [JWT security BCP](https://www.rfc-editor.org/rfc/rfc8725.html), and [MCP 2025-11-25 authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
