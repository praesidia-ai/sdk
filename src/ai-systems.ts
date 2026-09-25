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
  AI_ASSET_CLIENT_SOURCES,
  AI_ASSET_DISCOVERY_STATUSES,
  AI_ASSET_SOURCES,
  AI_ASSET_TYPES,
  AI_SYSTEM_ASSET_ROLES,
  AI_SYSTEM_CRITICALITIES,
  AI_SYSTEM_ENVIRONMENTS,
  AI_SYSTEM_LIFECYCLE_STATUSES,
  ASSET_GRAPH_DIRECTIONS,
  ASSET_RELATIONSHIP_TYPES,
  type AdoptAiAssetInput,
  type AiAssetDesiredStateResult,
  type AiAssetRecord,
  type AiSystemAssetRecord,
  type AiSystemDesiredStateResult,
  type AiSystemLifecycleStatus,
  type AiSystemRecord,
  type AiSystemSummaryResponse,
  type AssetGraphTraversalResponse,
  type AssetRelationshipDesiredStateResult,
  type AssetRelationshipRecord,
  type AttachAiSystemAssetInput,
  type ChangeAiSystemAssetRoleInput,
  type CreateAiAssetInput,
  type CreateAssetRelationshipInput,
  type GuardConfig,
  type ListAiAssetsQuery,
  type ListAiSystemsQuery,
  type ListAssetRelationshipsQuery,
  type TraverseAssetGraphQuery,
  type UpdateAiAssetInput,
  type UpdateAiSystemOwnersInput,
  type UpdateAssetRelationshipInput,
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
 * Multi-hop graph traversal ({@link traverse}, be's AISYS-0003) and the
 * cross-domain summary ({@link getSummary}, be's AISYS-0004) are covered
 * as of SDK-0005. The declarative `by-external-id` desired-state methods
 * ({@link putSystemByExternalId} and its asset/relationship siblings, be's
 * BE-0579) are covered as of SDK-0302 (PRAE-228/229) — the shape IaC
 * tooling (Terraform provider, k8s operator) needs.
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

  /**
   * Thin cross-domain aggregation summary for an AI System (be's AISYS-0004).
   * GET .../ai-systems/:id/summary. A section reports `available: false`
   * with a `reason` when the backing service cannot filter by this AI
   * System's linked asset entity ids at all (e.g. `cost`, pending
   * AISYS-0025) — distinct from a genuine all-zero `counts`.
   */
  async getSummary(aiSystemId: string): Promise<AiSystemSummaryResponse> {
    return this.client.get<AiSystemSummaryResponse>(
      `${this.systemsBase}/${encodePathSegment(aiSystemId, 'aiSystemId')}/summary`,
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

  /**
   * Update one or more of the four owner pairs on an AI System.
   * PATCH .../ai-systems/:id/owners. `null` clears a pair.
   */
  async updateOwners(
    aiSystemId: string,
    data: UpdateAiSystemOwnersInput,
  ): Promise<AiSystemRecord> {
    return this.client.patch<AiSystemRecord>(
      `${this.systemsBase}/${encodePathSegment(aiSystemId, 'aiSystemId')}/owners`,
      data,
    );
  }

  /**
   * Transition an AI System's lifecycle status. PATCH .../ai-systems/:id/lifecycle.
   * Throws on an illegal transition (be 400s with the from/to pair).
   */
  async transitionLifecycle(
    aiSystemId: string,
    lifecycleStatus: AiSystemLifecycleStatus,
  ): Promise<AiSystemRecord> {
    assertEnum(lifecycleStatus, AI_SYSTEM_LIFECYCLE_STATUSES, 'lifecycleStatus');
    return this.client.patch<AiSystemRecord>(
      `${this.systemsBase}/${encodePathSegment(aiSystemId, 'aiSystemId')}/lifecycle`,
      { lifecycleStatus },
    );
  }

  /** Soft-delete an AI System. DELETE .../ai-systems/:id. */
  async delete(aiSystemId: string): Promise<void> {
    return this.client.del(
      `${this.systemsBase}/${encodePathSegment(aiSystemId, 'aiSystemId')}`,
    );
  }

  /**
   * Declaratively create-or-update an AI System keyed by an externally-owned
   * `externalId` (be's BE-0579 desired-state API, SDK-0302/PRAE-228/229) —
   * the shape IaC tooling (Terraform provider, k8s operator) needs instead
   * of a lookup-then-create/update round trip. PUT
   * .../ai-systems/by-external-id/:externalId. Idempotent: the same `data`
   * sent twice returns `changed: false` the second time with an unchanged
   * `updatedAt` — check it before assuming a write happened.
   */
  async putSystemByExternalId(
    externalId: string,
    data: Record<string, unknown>,
  ): Promise<AiSystemDesiredStateResult> {
    return this.client.put<AiSystemDesiredStateResult>(
      `${this.systemsBase}/by-external-id/${encodePathSegment(externalId, 'externalId')}`,
      data,
    );
  }

  /**
   * Archive the AI System matching `externalId` (never a hard delete, same
   * as {@link archive}). DELETE .../ai-systems/by-external-id/:externalId.
   * Another tenant's `externalId` 404s rather than leaking existence.
   */
  async deleteSystemByExternalId(
    externalId: string,
  ): Promise<AiSystemDesiredStateResult> {
    return this.client.delReturning<AiSystemDesiredStateResult>(
      `${this.systemsBase}/by-external-id/${encodePathSegment(externalId, 'externalId')}`,
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

  /**
   * Create a metadata-only AI Asset (no backing runtime entity — e.g.
   * `VENDOR`, `CREDENTIAL`). POST .../ai-assets. Use {@link adoptAsset} for
   * an asset backed by a real agent/application/MCP server/model/workflow/
   * eval-dataset row.
   */
  async createAsset(data: CreateAiAssetInput): Promise<AiAssetRecord> {
    assertEnum(data.assetType, AI_ASSET_TYPES, 'assetType');
    assertEnum(data.source, AI_ASSET_CLIENT_SOURCES, 'source');
    assertEnum(data.discoveryStatus, AI_ASSET_DISCOVERY_STATUSES, 'discoveryStatus');
    return this.client.post<AiAssetRecord>(this.assetsBase, data);
  }

  /** Fetch a single AI Asset by id. GET .../ai-assets/:id. */
  async getAsset(assetId: string): Promise<AiAssetRecord> {
    return this.client.get<AiAssetRecord>(
      `${this.assetsBase}/${encodePathSegment(assetId, 'assetId')}`,
    );
  }

  /**
   * Partially update an AI Asset's descriptive fields. PATCH .../ai-assets/:id.
   * `assetType`/`source`/`discoveryStatus` are immutable/behaviour-owned and
   * not accepted here (matching be's `UpdateAiAssetDto`).
   */
  async updateAsset(
    assetId: string,
    data: UpdateAiAssetInput,
  ): Promise<AiAssetRecord> {
    return this.client.patch<AiAssetRecord>(
      `${this.assetsBase}/${encodePathSegment(assetId, 'assetId')}`,
      data,
    );
  }

  /** Archive an AI Asset. POST .../ai-assets/:id/archive. */
  async archiveAsset(assetId: string): Promise<AiAssetRecord> {
    return this.client.post<AiAssetRecord>(
      `${this.assetsBase}/${encodePathSegment(assetId, 'assetId')}/archive`,
      {},
    );
  }

  /** Restore an archived AI Asset. POST .../ai-assets/:id/restore. */
  async restoreAsset(assetId: string): Promise<AiAssetRecord> {
    return this.client.post<AiAssetRecord>(
      `${this.assetsBase}/${encodePathSegment(assetId, 'assetId')}/restore`,
      {},
    );
  }

  /**
   * Declaratively create-or-update an AI Asset keyed by an externally-owned
   * `externalId` (be's BE-0579, SDK-0302/PRAE-228/229). PUT
   * .../ai-assets/by-external-id/:externalId. Idempotent — see
   * {@link putSystemByExternalId}.
   */
  async putAssetByExternalId(
    externalId: string,
    data: CreateAiAssetInput,
  ): Promise<AiAssetDesiredStateResult> {
    assertEnum(data.assetType, AI_ASSET_TYPES, 'assetType');
    assertEnum(data.source, AI_ASSET_CLIENT_SOURCES, 'source');
    assertEnum(data.discoveryStatus, AI_ASSET_DISCOVERY_STATUSES, 'discoveryStatus');
    return this.client.put<AiAssetDesiredStateResult>(
      `${this.assetsBase}/by-external-id/${encodePathSegment(externalId, 'externalId')}`,
      data,
    );
  }

  /**
   * Archive the AI Asset matching `externalId` (never a hard delete).
   * DELETE .../ai-assets/by-external-id/:externalId.
   */
  async deleteAssetByExternalId(
    externalId: string,
  ): Promise<AiAssetDesiredStateResult> {
    return this.client.delReturning<AiAssetDesiredStateResult>(
      `${this.assetsBase}/by-external-id/${encodePathSegment(externalId, 'externalId')}`,
    );
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
   * Change the role of an AI Asset already attached to an AI System.
   * PATCH .../ai-systems/:id/assets/:assetId/role.
   */
  async changeAssetRole(
    aiSystemId: string,
    assetId: string,
    data: ChangeAiSystemAssetRoleInput,
  ): Promise<AiSystemAssetRecord> {
    assertEnum(data.role, AI_SYSTEM_ASSET_ROLES, 'role');
    return this.client.patch<AiSystemAssetRecord>(
      `${this.systemsBase}/${encodePathSegment(aiSystemId, 'aiSystemId')}` +
        `/assets/${encodePathSegment(assetId, 'assetId')}/role`,
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

  /** Fetch a single asset relationship by id. GET .../asset-relationships/:id. */
  async getRelationship(relationshipId: string): Promise<AssetRelationshipRecord> {
    return this.client.get<AssetRelationshipRecord>(
      `${this.relationshipsBase}/${encodePathSegment(relationshipId, 'relationshipId')}`,
    );
  }

  /**
   * Partially update a relationship (e.g. `relationshipType`, `confidence`).
   * PATCH .../asset-relationships/:id. Endpoints (`sourceAssetId`/
   * `targetAssetId`) are immutable and not accepted here; be bumps `version`
   * and appends an `asset_relationship_history` row.
   */
  async updateRelationship(
    relationshipId: string,
    data: UpdateAssetRelationshipInput,
  ): Promise<AssetRelationshipRecord> {
    assertEnum(data.relationshipType, ASSET_RELATIONSHIP_TYPES, 'relationshipType');
    return this.client.patch<AssetRelationshipRecord>(
      `${this.relationshipsBase}/${encodePathSegment(relationshipId, 'relationshipId')}`,
      data,
    );
  }

  /** Archive a relationship. POST .../asset-relationships/:id/archive. */
  async archiveRelationship(relationshipId: string): Promise<AssetRelationshipRecord> {
    return this.client.post<AssetRelationshipRecord>(
      `${this.relationshipsBase}/${encodePathSegment(relationshipId, 'relationshipId')}/archive`,
      {},
    );
  }

  /** Restore an archived relationship. POST .../asset-relationships/:id/restore. */
  async restoreRelationship(relationshipId: string): Promise<AssetRelationshipRecord> {
    return this.client.post<AssetRelationshipRecord>(
      `${this.relationshipsBase}/${encodePathSegment(relationshipId, 'relationshipId')}/restore`,
      {},
    );
  }

  /**
   * Multi-hop graph traversal from an anchor asset (be's AISYS-0003).
   * GET .../asset-relationships/graph/traverse. Returns the anchor's
   * shortest-hop reachability TREE (one inbound edge per non-anchor node),
   * not the full induced subgraph of every edge between reached nodes.
   * `maxDepth` above `AI_SYSTEM_GRAPH_MAX_DEPTH` is clamped, not rejected
   * (see the response's `stats.depthClamped`); an oversized result 413s
   * (`AI_SYSTEM_GRAPH_MAX_NODES`) rather than truncating.
   */
  async traverse(
    query: TraverseAssetGraphQuery,
  ): Promise<AssetGraphTraversalResponse> {
    assertEnum(query.direction, ASSET_GRAPH_DIRECTIONS, 'direction');
    assertEnumArray(query.assetTypes, AI_ASSET_TYPES, 'assetTypes');
    assertEnumArray(query.relationshipTypes, ASSET_RELATIONSHIP_TYPES, 'relationshipTypes');
    const qs = buildQueryString(query);
    return this.client.get<AssetGraphTraversalResponse>(
      `${this.relationshipsBase}/graph/traverse${qs}`,
    );
  }

  /**
   * Declaratively create-or-update a relationship (edge) keyed by an
   * externally-owned `externalId` (be's BE-0579, SDK-0302/PRAE-228/229). PUT
   * .../asset-relationships/by-external-id/:externalId. Idempotent — see
   * {@link putSystemByExternalId}.
   */
  async putRelationshipByExternalId(
    externalId: string,
    data: CreateAssetRelationshipInput,
  ): Promise<AssetRelationshipDesiredStateResult> {
    assertEnum(data.relationshipType, ASSET_RELATIONSHIP_TYPES, 'relationshipType');
    return this.client.put<AssetRelationshipDesiredStateResult>(
      `${this.relationshipsBase}/by-external-id/${encodePathSegment(externalId, 'externalId')}`,
      data,
    );
  }

  /**
   * Archive the relationship matching `externalId` (never a hard delete).
   * DELETE .../asset-relationships/by-external-id/:externalId.
   */
  async deleteRelationshipByExternalId(
    externalId: string,
  ): Promise<AssetRelationshipDesiredStateResult> {
    return this.client.delReturning<AssetRelationshipDesiredStateResult>(
      `${this.relationshipsBase}/by-external-id/${encodePathSegment(externalId, 'externalId')}`,
    );
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

/** Like {@link assertEnum}, but checks every element of an optional array. */
function assertEnumArray<T extends string>(
  values: readonly T[] | undefined,
  allowed: readonly T[],
  label: string,
): void {
  if (values === undefined) return;
  for (const value of values) assertEnum(value, allowed, label);
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
