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
const HOUR_MS = 3_600_000;
// be roots each complete hour at :00 (merkle-root.service.ts, EVERY_HOUR); 80 min bounds the wait.
const WAIT_ROOTED_MS = 80 * 60_000;
const ROOT_POLL_MS = 2 * 60_000;
const KNOWN_CLAMPS = ['none', 'clamped_to_last_rooted_hour', 'no_rooted_hour'];

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
      // Optional override for servers older than ai-systems:write (be BE-1636).
      inventoryApiKey: env.PRAESIDIA_INVENTORY_API_KEY || env.PRAESIDIA_API_KEY,
      stripeKey: env.STRIPE_SECRET_KEY,
      charge: env.STRIPE_CHARGE_ID,
      packageFile: env.AUDIT_PACKAGE_FILE || './audit-package.zip',
      platformKeyFile: env.PRAESIDIA_PLATFORM_KEY_FILE || '',
      platformKeyFingerprint: env.PRAESIDIA_PLATFORM_KEY_FINGERPRINT || '',
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
    log('graph: mapping skipped (403). The API key lacks the ai-systems:write scope; add it to the key (README.md)');
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

/**
 * The evidence window be wrote into the package's verification.txt (the package job
 * response carries none): `{ to, requestedTo, clampReason }`, or null. Walks the STORED
 * local headers be's ZipStreamWriter writes.
 */
export function readPackageWindow(zip) {
  const buf = Buffer.from(zip);
  for (let at = 0; at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50;) {
    const size = buf.readUInt32LE(at + 18);
    const nameEnd = at + 30 + buf.readUInt16LE(at + 26);
    const dataAt = nameEnd + buf.readUInt16LE(at + 28);
    if (buf.toString('utf8', at + 30, nameEnd) === 'verification.txt') {
      const text = buf.toString('utf8', dataAt, dataAt + size);
      const field = (label) => text.match(new RegExp(`^${label}: (.+)$`, 'm'))?.[1].trim();
      const to = field('Evidence range')?.split(' .. ')[1];
      return to ? { to, requestedTo: field('Requested range end'), clampReason: field('Range end clamp') } : null;
    }
    if (size === 0xffffffff) return null; // ZIP64 entry: not walked
    at = dataAt + size;
  }
  return null;
}

/** Only a known clamp reason whose rooted end is after the refund counts as covered. */
function reportCoverage(window, refundedAt, log) {
  const at = new Date(refundedAt).toISOString();
  const known = KNOWN_CLAMPS.includes(window?.clampReason);
  if (known && Date.parse(window.to) > refundedAt) {
    log(`refund covered: the package's evidence ends at ${window.to} (clamp ${window.clampReason}), after the refund at ${at}`);
    return;
  }
  const hourEnd = new Date(Math.floor(refundedAt / HOUR_MS) * HOUR_MS + HOUR_MS).toISOString();
  const seen = !window ? 'range could not be read from its verification.txt'
    : `ends at ${window.to} (clamp ${window.clampReason}${known ? '' : `: unknown clamp reason ${window.clampReason}`})`;
  log(`refund not yet covered: the package's evidence ${seen}; the refund was at ${at}. ` +
    `Its rows are covered once the hour ending ${hourEnd} is Merkle-rooted (hourly, just after that hour closes). ` +
    'Request a new audit package after then, or pass --wait-rooted next time');
}

/** --wait-rooted: probe the refund's hour as a bundle until be's rooted end reaches it. */
async function waitRooted(audit, refundedAt, log, sleep) {
  const end = Math.floor(refundedAt / HOUR_MS) * HOUR_MS + HOUR_MS;
  const range = { from: new Date(end - HOUR_MS).toISOString(), to: new Date(end).toISOString(), includeUnrooted: false };
  log(`--wait-rooted: waiting for the hour ending ${range.to} to be Merkle-rooted (at most ${WAIT_ROOTED_MS / 60_000} min)`);
  for (let i = 0; i <= WAIT_ROOTED_MS / ROOT_POLL_MS; i++) {
    if (i > 0) await sleep(ROOT_POLL_MS);
    const { effectiveTo } = await audit.downloadBundle(range);
    if (!effectiveTo) return log('--wait-rooted: this server does not report the rooted window; not waiting');
    if (Date.parse(effectiveTo) >= end) return log(`--wait-rooted: rooted through ${effectiveTo}`);
  }
  log(`--wait-rooted: not rooted after ${WAIT_ROOTED_MS / 60_000} min; requesting the package anyway`);
}

export async function run({
  env = process.env,
  argv = process.argv.slice(2),
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
  const refundedAt = Date.now(); // after reportOutcome: the refund's decision + outcome rows exist

  // Step 6: evidence.
  const audit = new sdk.PraesidiaAudit(praesidia);
  log(`receipt: ${JSON.stringify(await audit.getDecisionReceipt(decision.decisionId), null, 2)}`);
  if (argv.includes('--wait-rooted')) await waitRooted(audit, refundedAt, log, sleep);
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
  const zip = await audit.downloadPackage(job.id);
  await writeFile(c.packageFile, zip);
  log(`audit package: ${c.packageFile}`);
  reportCoverage(readPackageWindow(zip), refundedAt, log);
  // The verifier embeds no platform key yet (VERIFIER-RELEASE.md section 6); without one a real package fails `signature`.
  log(`verify offline: npx @praesidia/audit-verifier ${c.packageFile} --platform-key ${c.platformKeyFile || '<platform-key.pem>'} ` +
    `--platform-key-fingerprint ${c.platformKeyFingerprint || '<sha256hex>'} --summary`);
  if (!c.platformKeyFile || !c.platformKeyFingerprint) {
    log('platform key: get the Praesidia platform public key (PEM) and its SHA-256 fingerprint from Praesidia over a channel ' +
      'independent of this package (none is published yet), then set PRAESIDIA_PLATFORM_KEY_FILE and PRAESIDIA_PLATFORM_KEY_FINGERPRINT');
  }
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
