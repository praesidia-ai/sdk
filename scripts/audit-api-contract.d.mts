export type ContractLanguage = "ts" | "py";

export interface ApiCallSite {
  file: string;
  line: number;
  method: string;
  rawPath: string;
  bodyKeys: string[] | null;
}

export interface ApiOperationContract {
  properties: Set<string>;
  required: Set<string>;
  hasBodySchema: boolean;
}

export function normalizePath(value: string): string;

export function buildOperationIndex(
  spec: unknown,
): Map<string, ApiOperationContract>;

export function extractCallSites(
  sourceRoot: string,
  lang?: ContractLanguage,
): ApiCallSite[];

export function diffCallSites(
  callSites: ApiCallSite[],
  operationIndex: Map<string, ApiOperationContract>,
  repoRoot: string,
): string[];
