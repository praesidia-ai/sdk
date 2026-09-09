/** Public read contracts from the protected-actions API; reads do not verify evidence. */
export const PROTECTED_ACTION_CLOSURES = [
  'DENIED', 'EXPIRED', 'CANCELLED_BEFORE_DISPATCH', 'TARGET_REJECTED',
  'SUCCEEDED', 'FAILED_NO_EFFECT', 'PARTIAL', 'REVERSED',
  'DUPLICATE_SUPPRESSED', 'OUTCOME_UNKNOWN', 'EVIDENCE_INCOMPLETE',
] as const;
export type ProtectedActionClosure = typeof PROTECTED_ACTION_CLOSURES[number];
export type EvidenceGrade = 'A' | 'B' | 'C' | 'D';

export interface ListProtectedActionsQuery {
  agentId?: string;
  taskId?: string;
  chainId?: string;
  state?: string;
  closure?: ProtectedActionClosure;
  /** Inclusive firstObservedAt lower bound. */
  from?: string;
  /** Exclusive firstObservedAt upper bound. */
  to?: string;
  page?: number;
  limit?: number;
}

export interface ProtectedActionSummary {
  actionId: string;
  organizationId: string;
  actionClass: string;
  protocol: string;
  agentId: string | null;
  taskId: string | null;
  chainId: string | null;
  targetIdentity: string | null;
  state: string;
  closure: ProtectedActionClosure | null;
  /** Server-declared projection, not an independently verified grade. */
  evidenceGrade: EvidenceGrade | null;
  eventCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  dispatchedAt: string | null;
  closedAt: string | null;
}

export interface ProtectedActionDetail extends ProtectedActionSummary {
  permitId: string | null;
  requestCommitment: string | null;
  completenessStatus: 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';
  verificationStatus: 'UNVERIFIED' | 'VALID' | 'INVALID' | 'INCOMPLETE';
  reconciliationDeadlineAt: string | null;
}

export interface ProtectedActionList {
  data: ProtectedActionSummary[];
  total: number;
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

export interface ProtectedActionEvent {
  id: string;
  actionId: string;
  /** Decimal bigint string: never coerce to a JavaScript number. */
  actionSeq: string;
  eventType: string;
  schemaVersion: string;
  issuerType: string;
  issuerId: string;
  trustDomain: string;
  observedAt: string;
  receivedAt: string;
  dispatched: boolean;
  payload: Record<string, unknown> | null;
  payloadCommitment: string | null;
  eventCommitment: string;
  prevEventCommitment: string;
  signature: string;
  signatureAlgorithm: string;
  keyVersion: number;
  signedAt: string;
  producerVersion: string;
}

export interface CaptureScopeEntry {
  edgeId: string;
  actionClass: string;
  protocol: string;
  description: string;
  supportStatus: 'SUPPORTED' | 'PARTIAL' | 'UNSUPPORTED';
  maxEvidenceGrade: EvidenceGrade | null;
  gapNotes: string | null;
  implementedBy: string | null;
  registryVersion: string;
}

export interface ProtectedActionCoverage {
  organizationId: string;
  closureCounts: Record<string, number>;
  openPhaseCounts: Record<string, number>;
  totalClosed: number;
  totalOpen: number;
}
