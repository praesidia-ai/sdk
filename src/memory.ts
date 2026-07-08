import { PraesidiaClient } from './client.js';
import { PraesidiaConfigError } from './errors.js';
import type {
  CreateMemoryInput,
  EraseMemoryInput,
  EraseMemoryResult,
  GuardConfig,
  ListMemoriesQuery,
  MemoryRecord,
  SearchMemoryInput,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

/**
 * PraesidiaMemory — the agent-memory & knowledge-store client (H2-06e).
 *
 * Wraps the org-scoped memory API. Writes are PII-redacted + poisoning-scanned
 * and encrypted per-org on the backend; reads are decrypted for authorized org
 * readers and surface provenance + guardrail metadata per hit.
 *
 * Usage (zero config — reads from env vars):
 *   const memory = new PraesidiaMemory();
 *   const m = await memory.create({ content: 'The customer prefers email.' });
 *   const hits = await memory.search({ query: 'contact preference', topK: 5 });
 *
 * Config resolution order: constructor arg → environment variable → default.
 * Like PraesidiaCompliance there is no local/offline mode — every operation is a
 * connected, authenticated API call, so a missing apiKey/orgId throws
 * PraesidiaConfigError at construction time.
 *
 * Endpoint base: /organizations/:orgId/memories
 * Auth: Authorization: Bearer <apiKey>. Requires the AGENT_MEMORY feature and
 * the MEMORY_CREATE / MEMORY_VIEW / MEMORY_ERASE / MEMORY_DELETE permissions.
 *
 * AUDIT-SDK-04 — genuinely API-key-reachable: the memory controller's route
 * guard was opened to API keys (be-core commit 0bff5a0a), so a personal `pk_`
 * Bearer key whose owner holds the MEMORY_* permission in the org authenticates
 * here (scoped by OrgMembershipGuard + PermissionsGuard) like a dashboard JWT.
 */
export class PraesidiaMemory {
  private readonly orgId: string;
  private readonly baseUrl: string;
  private readonly client: PraesidiaClient;
  private readonly memoriesBase: string;

  constructor(config: GuardConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    this.baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;

    if (!apiKey || !orgId) {
      throw new PraesidiaConfigError(
        'PraesidiaMemory requires PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID',
      );
    }

    this.orgId = orgId;
    this.client = new PraesidiaClient(this.baseUrl, apiKey);
    this.memoriesBase = `/organizations/${this.orgId}/memories`;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Write a memory. The content is PII-redacted + poisoning-scanned and
   * encrypted per-org before persistence. POST .../memories (MEMORY_CREATE).
   *
   * Pass `subjectId` to bind the memory to a data subject so a later
   * {@link erase} can GDPR Art-17 crypto-shred exactly that subject.
   */
  async create(input: CreateMemoryInput): Promise<MemoryRecord> {
    return this.client.post<MemoryRecord>(this.memoriesBase, input);
  }

  /**
   * List memories (org-scoped, paginated, decrypted). GET .../memories
   * (MEMORY_VIEW). Returns the raw list envelope the backend produces.
   */
  async list(
    query: ListMemoriesQuery = {},
  ): Promise<{ data: MemoryRecord[]; total?: number; page?: number }> {
    const qs = buildQueryString(query);
    return this.client.get<{
      data: MemoryRecord[];
      total?: number;
      page?: number;
    }>(`${this.memoriesBase}${qs}`);
  }

  /**
   * Relevance search over memories (provenance surfaced per hit).
   * POST .../memories/search (MEMORY_VIEW).
   */
  async search(input: SearchMemoryInput): Promise<MemoryRecord[]> {
    return this.client.post<MemoryRecord[]>(
      `${this.memoriesBase}/search`,
      input,
    );
  }

  /**
   * GDPR Art-17 crypto-shred a data subject's memories (DEK destroy +
   * certificate). POST .../memories/erase (MEMORY_ERASE).
   */
  async erase(input: EraseMemoryInput): Promise<EraseMemoryResult> {
    return this.client.post<EraseMemoryResult>(
      `${this.memoriesBase}/erase`,
      input,
    );
  }

  /**
   * Fetch a single memory (org-scoped, decrypted).
   * GET .../memories/:id (MEMORY_VIEW).
   */
  async get(id: string): Promise<MemoryRecord> {
    return this.client.get<MemoryRecord>(
      `${this.memoriesBase}/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Soft-delete a single memory (org-scoped). DELETE .../memories/:id
   * (MEMORY_DELETE). Resolves once the backend answers 204 No Content.
   */
  async delete(id: string): Promise<void> {
    return this.client.del(`${this.memoriesBase}/${encodeURIComponent(id)}`);
  }

  /**
   * Adopt a rotated credential in-process (zero-downtime swap). The new key is
   * held only in memory and never logged.
   */
  refreshCredential(apiKey: string): void {
    this.client.setApiKey(apiKey);
  }
}

/** Build a `?a=b&c=d` query string from a list query (omitting empty values). */
function buildQueryString(query: ListMemoriesQuery): string {
  const params: Array<[string, string]> = [];
  if (query.page !== undefined) params.push(['page', String(query.page)]);
  if (query.limit !== undefined) params.push(['limit', String(query.limit)]);
  if (query.memoryKey) params.push(['memoryKey', query.memoryKey]);
  if (query.sourceType) params.push(['sourceType', query.sourceType]);
  if (query.tag) params.push(['tag', query.tag]);
  if (params.length === 0) return '';
  const encoded = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `?${encoded}`;
}
