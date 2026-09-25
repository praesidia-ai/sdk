# Refund authorization: a governed EUR 8,250 Stripe refund

A standalone example that installs `@praesidia/sdk` by version. It does not use a
workspace link or a checkout. `refund.mjs` does the following:

1. Maps the agent -> Stripe edge in the asset graph with external-id upserts, so a
   re-run changes nothing.
2. Asks Praesidia before moving money:
   `beforeInteraction('agent_to_saas', { name: 'stripe.refund', arguments: { amount: 8250, currency: 'EUR', charge } }, { failMode: 'closed' })`.
3. On `require_approval`, prints the approval id and waits while the SDK polls.
   A person approves it in the app.
4. On `allow`, calls Stripe **test mode** `POST /v1/refunds` for EUR 8,250
   (`amount=825000` cents) with `Idempotency-Key: <approvalId>`. If the call is
   retried, Stripe does not refund twice.
5. Reports the result with `reportOutcome({ approvalId, status, result, targetSystem: 'stripe', targetTransactionId })`.
   Only a sha256 commitment of the Stripe response is sent.
6. Prints `getDecisionReceipt(decisionId)`, requests the audit package, downloads it to
   `./audit-package.zip` and prints the offline verify command.

The script does not use mocks. It refuses to run (exit 2) unless `STRIPE_SECRET_KEY` is an `sk_test_` key.

| Exit | Meaning |
|---|---|
| 0 | Refunded; outcome, receipt and audit package written |
| 1 | Failed: Stripe answered 4xx (outcome `failed_no_effect`) or 5xx/network error (outcome `unknown`), Praesidia unreachable (fail-closed), or the audit package did not finish |
| 2 | Refused: a missing variable or a Stripe key that is not `sk_test_` (before any call), or Praesidia allowed without an approval (org not in `enforce`; Stripe not called) |
| 3 | Denied by Praesidia (policy deny, approval rejected/expired, or wait timeout); Stripe was not called |

"Under 10 minutes" from a clean start: **not yet measured**.

## Install

This example needs `@praesidia/sdk` **0.4.0**. That version adds `getDecisionReceipt`
and the audit-package methods. **0.4.0 is not yet published to npm.** Until it is,
build a tarball from an SDK checkout and install that tarball without saving it.
Using `--no-save` keeps `package.json` on `^0.4.0` rather than a `file:` path:

```bash
# in an @praesidia/sdk checkout
npm ci && npm run build && npm pack          # -> praesidia-sdk-<version>.tgz

# in a copy of this directory
npm install --no-save /path/to/praesidia-sdk-<version>.tgz
npm run selfcheck                            # offline: no network, no keys
```

After 0.4.0 is published, run `npm install`.

Node 20.6 or later is required, for `--env-file`.

## Configure

Copy `.env.example` to `.env` and fill in each variable. Never commit `.env`.

| Variable | What it is | Where to get it |
|---|---|---|
| `PRAESIDIA_API_KEY` | Organization API key with scopes **`ai-systems:write`** (step 1, asset graph), **`agents:invoke`** (decision + outcome) and **`audit:read`** (receipt + audit package) | App: Configure -> Integrations -> API keys (`/configure/integrations/api-keys`). The key is shown once. |
| `PRAESIDIA_ORG_ID` | Your organization id (UUID) | Shown in the app; see the SDK credentials docs (docs.praesidia.ai, DOCS-0713) |
| `PRAESIDIA_AGENT_ID` | The id of the agent that performs refunds | Manage -> Agents (`/manage/agents`), in the agent's details |
| `PRAESIDIA_BASE_URL` | Optional; default `https://api.praesidia.ai` | Your Praesidia API URL |
| `PRAESIDIA_INVENTORY_API_KEY` | Optional; leave empty. Overrides `PRAESIDIA_API_KEY` for step 1 only, for a server older than the `ai-systems:write` scope (see below) | A personal API key of a user with the `ai_systems.create` permission |
| `STRIPE_SECRET_KEY` | Stripe **test-mode** secret key, `sk_test_...` | Stripe Dashboard -> Developers -> API keys, with test mode on |
| `STRIPE_CHARGE_ID` | A test charge (`ch_...`) or payment intent (`pi_...`) of exactly EUR 8,250 (a larger one could take a second, separately approved refund) | Create one in test mode, e.g. a PaymentIntent for `825000` `eur` confirmed with `pm_card_visa` |
| `AUDIT_PACKAGE_FILE` | Optional; default `./audit-package.zip` | |

**Step 1 and the key's scopes.** Step 1 calls three asset-graph routes:
`PUT .../ai-assets/by-external-id/:externalId` (twice) and
`PUT .../asset-relationships/by-external-id/:externalId`. They take the
`ai-systems:write` scope, and the organization needs the AI Systems feature. A key
without that scope gets a 403. `refund.mjs` then prints
`graph: mapping skipped (403). The API key lacks the ai-systems:write scope` and
continues, because the mapping is inventory and not the control. Steps 2 to 6 use
`agents:invoke` (`POST .../interaction-decisions`, `POST .../interaction-decisions/outcome`)
and `audit:read` (`GET .../audit/decisions/:decisionId/receipt`, `POST .../audit/packages`,
`GET .../audit/packages/:id`, `GET .../audit/packages/:id/download`). On a server that
predates `ai-systems:write`, set `PRAESIDIA_INVENTORY_API_KEY` to a personal key for
step 1.

## The policy to paste

Put the organization in **`enforce`** mode first (see the refund golden-path guide,
DOCS-0710). Governance defaults to `observe`. In `observe` a step-up policy answers
`allow` without an approval. `refund.mjs` then refuses to call Stripe and exits 2.

Add these two rules on the agent: Manage -> Agents -> the agent -> Tool policies, or
`POST /organizations/{orgId}/agents/{agentId}/tool-policies` with a user session.
Praesidia matches the action as `<interactionType>.<name>`, so the pattern is
`agent_to_saas.stripe.refund`. Evaluation is first-match-wins, with the lower
`priority` first. If no rule matches, the result is a deny (`no_policy_matched`).

```json
{
  "toolPattern": "agent_to_saas.stripe.refund",
  "mode": "STEP_UP",
  "priority": 10,
  "conditions": { "all": [{ "path": "amount", "op": "gt", "value": 5000 }] }
}
```

```json
{
  "toolPattern": "agent_to_saas.stripe.refund",
  "mode": "ALLOW",
  "priority": 20
}
```

A refund above EUR 5,000 steps up to a human. A smaller one is allowed without an
approval, which this script refuses because it only refunds against an approval.
If `amount` is missing, or is not a number, the rule cannot be decided and the call
is denied (`policy_condition_indeterminate`). It never falls through to the ALLOW rule.

## Run

```bash
npm start            # node --env-file=.env refund.mjs
```

Approve the printed approval id in the app under Monitor -> Governance -> Approvals
(`/monitor/governance/approvals`). The script then refunds, records the outcome,
prints the Decision Receipt and writes `./audit-package.zip`. Verify the package offline:

```bash
npx @praesidia/audit-verifier ./audit-package.zip --summary
```

Running it again with the same charge asks for a new approval. After that approval,
Stripe refuses a second full refund of the same charge. The outcome is recorded as
`failed_no_effect` and the script exits 1. The charge is never refunded twice.
