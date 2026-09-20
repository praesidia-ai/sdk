import {
  assertPagination,
  encodePathSegment,
  PraesidiaClient,
} from './client.js';
import { PraesidiaConfigError } from './errors.js';
import {
  normalizePagedEnvelope,
  paginateAll,
  type PaginatedEnvelope,
} from './pagination.js';
import {
  AI_ASSET_DISCOVERY_STATUSES,
  AI_ASSET_SOURCES,
  AI_ASSET_TYPES,
  AI_SYSTEM_CRITICALITIES,
  AI_SYSTEM_ENVIRONMENTS,
  AI_SYSTEM_LIFECYCLE_STATUSES,
  ASSET_RELATIONSHIP_TYPES,
  type AdoptAiAssetInput,
  type AiAssetRecord,
  type AiSystemAssetRecord,
  type AiSystemRecord,
  type AssetRelationshipRecord,
  type AttachAiSystemAssetInput,
  type CreateAssetRelationshipInput,
  type GuardConfig,
  type ListAiAssetsQuery,
  type ListAiSystemsQuery,
  type ListAssetRelationshipsQuery,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.praesidia.ai';

/**
 * PraesidiaAiSystems — AI System / asset / relationship graph (SDK-0001,
 * parity with be's AISYS-0002; see `CONTRACT.md` in
 * `.claude/tickets/IDEA-2026-09-20-ai-system-graph/`).
 *
 * Usage (zero config — reads from env vars):
 *   const aiSystems = new PraesidiaAiSystems();
 *   const system = await aiSystems.create({ name: 'Support triage bot' });
 *   const asset = await aiSystems.adoptAsset({ entityType: 'agent', entityId, aiSystemId: system.id });
 *   await aiSystems.attachAsset(system.id as string, { assetId: asset.id as string, role: 'primary' });
 *
 * Config resolution order: constructor arg → environment variable → default.
 * There is no local/offline mode — every operation is a connected,
 * authenticated API call, so a missing apiKey/orgId throws
 * PraesidiaConfigError at construction time.
 *
 * Endpoint bases: /organizations/:orgId/ai-systems, /ai-assets,
 * /asset-relationships. Auth: Authorization: Bearer <apiKey>. Requires the
 * AI_SYSTEMS feature and the AI_SYSTEMS_ / AI_ASSETS_ permission families.
 *
 * Multi-hop graph traversal (be's AISYS-0003) is not yet landed on
 * `be/openapi.json` as of this SDK release — not covered here; add it once
 * the contract lands (see the item's Evidence for the exact deferral).
 */
export class PraesidiaAiSystems {
  private readonly client: PraesidiaClient;
  private readonly systemsBase: string;
  private readonly assetsBase: string;
  private readonly relationshipsBase: string;

  constructor(config: GuardConfig = {}) {
    const apiKey = config.apiKey ?? process.env['PRAESIDIA_API_KEY'];
    const orgId = config.orgId ?? process.env['PRAESIDIA_ORG_ID'];
    const baseUrl =
      config.baseUrl ?? process.env['PRAESIDIA_BASE_URL'] ?? DEFAULT_BASE_URL;

    if (!apiKey || !orgId) {
      throw new PraesidiaConfigError(
        'PraesidiaAiSystems requires PRAESIDIA_API_KEY and PRAESIDIA_ORG_ID',
      );
    }

    this.client = new PraesidiaClient(
      baseUrl,
      apiKey,
      config.requestTimeoutMs,
      config.retry,
    );
    const orgBase = `/organizations/${encodePathSegment(orgId, 'orgId')}`;
    this.systemsBase = `${orgBase}/ai-systems`;
    this.assetsBase = `${orgBase}/ai-assets`;
    this.relationshipsBase = `${orgBase}/asset-relationships`;
  }

  // ── AI Systems ───────────────────────────────────────────────────────────

  /**
   * List AI Systems for the organization. GET .../ai-systems (paginated).
   *
   * Returns only the requested page as a bare array (SCAN2-011 convention);
   * use {@link listPage} for the full envelope or {@link listAll} to
   * auto-paginate through every system.
   */
  async list(query: ListAiSystemsQuery = {}): Promise<AiSystemRecord[]> {
    return (await this.listPage(query)).data;
  }

  /** Like {@link list}, but returns be's full pagination envelope. */
  async listPage(
    query: ListAiSystemsQuery = {},
  ): Promise<PaginatedEnvelope<AiSystemRecord>> {
    assertPagination(query);
    assertEnum(query.lifecycleStatus, AI_SYSTEM_LIFECYCLE_STATUSES, 'lifecycleStatus');
    assertEnum(query.environment, AI_SYSTEM_ENVIRONMENTS, 'environment');
    assertEnum(query.criticality, AI_SYSTEM_CRITICALITIES, 'criticality');
    const qs = buildQueryString(query);
    const result = await this.client.get<AiSystemRecord[] | Record<string, unknown>>(
      `${this.systemsBase}${qs}`,
    );
    return normalizePagedEnvelope<AiSystemRecord>(result, 'aiSystems');
  }

  /** Auto-paginate through every AI System, across every page. */
  async *listAll(
    query: Omit<ListAiSystemsQuery, 'page'> = {},
  ): AsyncGenerator<AiSystemRecord, void, undefined> {
    yield* paginateAll((page) => this.listPage({ ...query, page }));
  }

  /** Fetch a single AI System by id. GET .../ai-systems/:id. */
  async get(aiSystemId: string): Promise<AiSystemRecord> {
    return this.client.get<AiSystemRecord>(
      `${this.systemsBase}/${encodePathSegment(aiSystemId, 'aiSystemId')}`,
    );
  }

  /** Create a new AI System. POST .../ai-systems. */
  async create(data: Record<string, unknown>): Promise<AiSystemRecord> {
    return this.client.post<AiSystemRecord>(this.systemsBase, data);
  }

  /** Partially update an AI System. PATCH .../ai-systems/:id. */
  async update(
    aiSystemId: string,
    data: Record<string, unknown>,
  ): Promise<AiSystemRecord> {
    return this.client.patch<AiSystemRecord>(
      `${this.systemsBase}/${encodePathSegment(aiSystemId, 'aiSystemId')}`,
      data,
    );
  }

  /** Archive an AI System. POST .../ai-systems/:id/archive. */
  async archive(aiSystemId: string): Promise<AiSystemRecord> {
    return this.client.post<AiSystemRecord>(
      `${this.systemsBase}/${encodePathSegment(aiSystemId, 'aiSystemId')}/archive`,
      {},
    );
  }

  /** Restore an archived AI System. POST .../ai-systems/:id/restore. */
  async restore(aiSystemId: string): Promise<AiSystemRecord> {
    return this.client.post<AiSystemRecord>(
      `${this.systemsBase}/${encodePathSegment(aiSystemId, 'aiSystemId')}/restore`,
      {},
    );
  }

  // ── AI Assets ────────────────────────────────────────────────────────────

  /**
   * List AI Assets for the organization. GET .../ai-assets (paginated).
   *
   * Returns only the requested page as a bare array (SCAN2-011 convention);
   * use {@link listAssetsPage} for the full envelope or {@link listAssetsAll}
   * to auto-paginate through every asset.
   */
  async listAssets(query: ListAiAssetsQuery = {}): Promise<AiAssetRecord[]> {
    return (await this.listAssetsPage(query)).data;
  }

  /** Like {@link listAssets}, but returns be's full pagination envelope. */
  async listAssetsPage(
    query: ListAiAssetsQuery = {},
  ): Promise<PaginatedEnvelope<AiAssetRecord>> {
    assertPagination(query);
    assertEnum(query.assetType, AI_ASSET_TYPES, 'assetType');
    assertEnum(query.source, AI_ASSET_SOURCES, 'source');
    assertEnum(query.discoveryStatus, AI_ASSET_DISCOVERY_STATUSES, 'discoveryStatus');
    assertEnum(query.environment, AI_SYSTEM_ENVIRONMENTS, 'environment');
    const qs = buildQueryString(query);
    const result = await this.client.get<AiAssetRecord[] | Record<string, unknown>>(
      `${this.assetsBase}${qs}`,
    );
    return normalizePagedEnvelope<AiAssetRecord>(result, 'aiAssets');
  }

  /** Auto-paginate through every AI Asset, across every page. */
  async *listAssetsAll(
    query: Omit<ListAiAssetsQuery, 'page'> = {},
  ): AsyncGenerator<AiAssetRecord, void, undefined> {
    yield* paginateAll((page) => this.listAssetsPage({ ...query, page }));
  }

  /**
   * Adopt an existing entity (agent, application, MCP server, ...) into the
   * AI Asset inventory. POST .../ai-assets/adopt. Idempotent: a repeat call
   * for the same `entityType`/`entityId` returns the same asset, no
   * duplicate.
   */
  async adoptAsset(data: AdoptAiAssetInput): Promise<AiAssetRecord> {
    return this.client.post<AiAssetRecord>(`${this.assetsBase}/adopt`, data);
  }

  // ── AI System ↔ Asset membership ────────────────────────────────────────

  /**
   * Attach an AI Asset to an AI System. POST .../ai-systems/:id/assets.
   */
  async attachAsset(
    aiSystemId: string,
    data: AttachAiSystemAssetInput,
  ): Promise<AiSystemAssetRecord> {
    return this.client.post<AiSystemAssetRecord>(
      `${this.systemsBase}/${encodePathSegment(aiSystemId, 'aiSystemId')}/assets`,
      data,
    );
  }

  /**
   * Detach an AI Asset from an AI System.
   * DELETE .../ai-systems/:id/assets/:assetId.
   */
  async detachAsset(aiSystemId: string, assetId: string): Promise<void> {
    return this.client.del(
      `${this.systemsBase}/${encodePathSegment(aiSystemId, 'aiSystemId')}` +
        `/assets/${encodePathSegment(assetId, 'assetId')}`,
    );
  }

  // ── Asset relationships (graph edges) ───────────────────────────────────

  /** Create a relationship (edge) between two AI Assets. POST .../asset-relationships. */
  async createRelationship(
    data: CreateAssetRelationshipInput,
  ): Promise<AssetRelationshipRecord> {
    return this.client.post<AssetRelationshipRecord>(this.relationshipsBase, data);
  }

  /**
   * List asset relationships for the organization.
   * GET .../asset-relationships (paginated).
   *
   * Returns only the requested page as a bare array (SCAN2-011 convention);
   * use {@link listRelationshipsPage} for the full envelope or
   * {@link listRelationshipsAll} to auto-paginate through every relationship.
   */
  async listRelationships(
    query: ListAssetRelationshipsQuery = {},
  ): Promise<AssetRelationshipRecord[]> {
    return (await this.listRelationshipsPage(query)).data;
  }

  /** Like {@link listRelationships}, but returns be's full pagination envelope. */
  async listRelationshipsPage(
    query: ListAssetRelationshipsQuery = {},
  ): Promise<PaginatedEnvelope<AssetRelationshipRecord>> {
    assertPagination(query);
    assertEnum(query.relationshipType, ASSET_RELATIONSHIP_TYPES, 'relationshipType');
    const qs = buildQueryString(query);
    const result = await this.client.get<
      AssetRelationshipRecord[] | Record<string, unknown>
    >(`${this.relationshipsBase}${qs}`);
    return normalizePagedEnvelope<AssetRelationshipRecord>(result, 'relationships');
  }

  /** Auto-paginate through every asset relationship, across every page. */
  async *listRelationshipsAll(
    query: Omit<ListAssetRelationshipsQuery, 'page'> = {},
  ): AsyncGenerator<AssetRelationshipRecord, void, undefined> {
    yield* paginateAll((page) => this.listRelationshipsPage({ ...query, page }));
  }

  /** Adopt a rotated credential in-process (zero-downtime swap). */
  refreshCredential(apiKey: string): void {
    this.client.setApiKey(apiKey);
  }
}

/** Throw PraesidiaConfigError if `value` is set but not one of `allowed`. */
function assertEnum<T extends string>(
  value: T | undefined,
  allowed: readonly T[],
  label: string,
): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new PraesidiaConfigError(`${label} must be one of ${allowed.join(', ')}`);
  }
}

/** Build a `?a=b&c=d` query string, omitting undefined values. */
function buildQueryString(query: object): string {
  const params: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined) continue;
    params.push([key, String(value)]);
  }
  if (params.length === 0) return '';
  return (
    '?' +
    params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  );
}
