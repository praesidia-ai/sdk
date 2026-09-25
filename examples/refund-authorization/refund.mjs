#!/usr/bin/env node
/**
 * A governed EUR 8,250 Stripe refund (test mode only) with @praesidia/sdk.
 * See README.md for the env vars, the policy to paste and the exit codes:
 * 0 refunded · 1 failed · 2 refused (configuration, or allowed without an
 * approval) · 3 denied by Praesidia.
 */
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, CONFIG: 2, DENIED: 3 });
const AMOUNT_EUR = 8250;
const REQUIRED = ['PRAESIDIA_API_KEY', 'PRAESIDIA_ORG_ID', 'PRAESIDIA_AGENT_ID', 'STRIPE_SECRET_KEY', 'STRIPE_CHARGE_ID'];
const PACKAGE_WAIT_MS = 300_000;

/** `{ config }`, or `{ error }` when the run must be refused before any call. */
export function parseEnv(env) {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) return { error: `missing ${missing.join(', ')} (copy .env.example to .env)` };
  if (!env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    return { error: 'STRIPE_SECRET_KEY must be a Stripe test-mode secret key (sk_test_...); this example never moves real money' };
  }
  if (!/^(ch|pi)_[A-Za-z0-9]+$/.test(env.STRIPE_CHARGE_ID)) {
    return { error: 'STRIPE_CHARGE_ID must be a Stripe charge (ch_...) or payment intent (pi_...) id' };
  }
  return {
    config: {
      apiKey: env.PRAESIDIA_API_KEY,
      orgId: env.PRAESIDIA_ORG_ID,
      agentId: env.PRAESIDIA_AGENT_ID,
      baseUrl: env.PRAESIDIA_BASE_URL || undefined,
      inventoryApiKey: env.PRAESIDIA_INVENTORY_API_KEY || env.PRAESIDIA_API_KEY,
      stripeKey: env.STRIPE_SECRET_KEY,
      charge: env.STRIPE_CHARGE_ID,
      packageFile: env.AUDIT_PACKAGE_FILE || './audit-package.zip',
    },
  };
}

/** Step 1: agent -> Stripe edge in the asset graph. Idempotent: external ids, not creates. */
async function mapAgentToStripe(sdk, c, log) {
  const systems = new sdk.PraesidiaAiSystems({ apiKey: c.inventoryApiKey, orgId: c.orgId, baseUrl: c.baseUrl });
  const agentExternalId = `refund-example.agent.${c.agentId}`;
  try {
    const agent = await systems.putAssetByExternalId(agentExternalId, {
      name: 'Refund agent', assetType: 'AGENT', source: 'api', metadata: { praesidiaAgentId: c.agentId },
    });
    const stripe = await systems.putAssetByExternalId('refund-example.saas.stripe', {
      name: 'Stripe', assetType: 'VENDOR', source: 'api',
    });
    const edge = await systems.putRelationshipByExternalId(`${agentExternalId}.calls.stripe`, {
      sourceAssetId: agent.id, targetAssetId: stripe.id, relationshipType: 'CALLS', source: 'api',
    });
    log(`graph: agent -> Stripe edge ${edge.created ? 'created' : edge.changed ? 'updated' : 'unchanged'}`);
  } catch (err) {
    if (!(err instanceof sdk.PraesidiaApiError && err.status === 403)) throw err;
    log('graph: mapping skipped (403). Org API keys cannot reach the by-external-id routes; set PRAESIDIA_INVENTORY_API_KEY (README.md)');
  }
}

/** Step 4: the refund at Stripe, keyed by the approval so a retry cannot refund twice. */
async function refundAtStripe(fetch, c, approvalId) {
  try {
    const res = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': approvalId,
      },
      body: new URLSearchParams({
        [c.charge.startsWith('pi_') ? 'payment_intent' : 'charge']: c.charge,
        amount: String(AMOUNT_EUR * 100),
        'metadata[praesidia_approval_id]': approvalId,
      }),
    });
    const refund = await res.json();
    if (res.ok) return { status: 'succeeded', refund };
    // Stripe made no refund on a 4xx; a 5xx may or may not have refunded.
    return { status: res.status < 500 ? 'failed_no_effect' : 'unknown', refund };
  } catch (err) {
    return { status: 'unknown', refund: { error: { message: String(err) } } };
  }
}

export async function run({
  env = process.env,
  sdk,
  fetch = globalThis.fetch,
  log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  approvalPollIntervalMs,
} = {}) {
  const { config: c, error } = parseEnv(env);
  if (error) {
    log(`refused: ${error}`);
    return EXIT.CONFIG;
  }
  const praesidia = { apiKey: c.apiKey, orgId: c.orgId, agentId: c.agentId, baseUrl: c.baseUrl };
  await mapAgentToStripe(sdk, c, log);

  // Steps 2-3: ask first; on require_approval the SDK re-asks until a human decides.
  const hooks = new sdk.PraesidiaInteractionHooks({
    ...praesidia,
    approvalPollIntervalMs,
    onApprovalRequired: (d) => log(`approval required: ${d.approvalId} (approve it in Praesidia under Approvals); waiting...`),
  });
  const action = { name: 'stripe.refund', arguments: { amount: AMOUNT_EUR, currency: 'EUR', charge: c.charge } };
  let decision;
  try {
    ({ decision } = await hooks.beforeInteraction('agent_to_saas', action, { failMode: 'closed' }));
  } catch (err) {
    if (!(err instanceof sdk.InteractionDeniedError)) throw err;
    log(`denied: ${err.reasonCode} (decision ${err.decision.decisionId}); Stripe was not called`);
    return EXIT.DENIED;
  }
  if (decision?.reasonCode !== 'approval_consumed' || !decision.approvalId) {
    log(`refused: allowed without an approval (${decision?.reasonCode}, mode ${decision?.enforcementMode}). ` +
      'Put the org in enforce mode and paste the STEP_UP policy from README.md');
    return EXIT.CONFIG;
  }

  const { status, refund } = await refundAtStripe(fetch, c, decision.approvalId);
  // Step 5: record what happened; only a hash of the Stripe response leaves this process.
  const outcome = await hooks.reportOutcome({
    approvalId: decision.approvalId,
    status,
    result: refund,
    targetSystem: 'stripe',
    ...(status === 'succeeded' ? { targetTransactionId: refund.id } : {}),
  });
  log(`outcome: ${status} recorded as decision ${outcome.decisionId}`);
  if (status !== 'succeeded') {
    log(`Stripe did not refund: ${refund?.error?.message ?? JSON.stringify(refund)}`);
    return EXIT.FAILED;
  }
  log(`refunded: ${refund.id}`);

  // Step 6: evidence.
  const audit = new sdk.PraesidiaAudit(praesidia);
  log(`receipt: ${JSON.stringify(await audit.getDecisionReceipt(decision.decisionId), null, 2)}`);
  const deadline = Date.now() + PACKAGE_WAIT_MS;
  let job = await audit.requestPackage({ from: new Date(Date.now() - 86_400_000).toISOString() });
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() > deadline) {
      log(`audit package ${job.id} still ${job.status} after ${PACKAGE_WAIT_MS / 1000}s; fetch it later with getPackage()`);
      return EXIT.FAILED;
    }
    await sleep(2000);
    job = await audit.getPackage(job.id);
  }
  if (job.status !== 'done') {
    log(`audit package ${job.id} failed: ${job.error}`);
    return EXIT.FAILED;
  }
  await writeFile(c.packageFile, await audit.downloadPackage(job.id));
  log(`audit package: ${c.packageFile}\nverify offline: npx @praesidia/audit-verifier ${c.packageFile} --summary`);
  return EXIT.OK;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const pkg = '@praesidia/sdk'; // a variable, so bundlers and test runners do not pre-resolve it
    process.exitCode = await run({ sdk: await import(pkg) });
  } catch (err) {
    console.error(err);
    process.exitCode = EXIT.FAILED;
  }
}
