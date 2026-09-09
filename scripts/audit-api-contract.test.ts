import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizePath,
  buildOperationIndex,
  extractCallSites,
  diffCallSites,
} from "./audit-api-contract.mjs";

// CD-0006/CD-0007 — proves the (generalized, copied-from-mcp/CD-0001) scanner
// actually detects drift for BOTH the TS SDK's and the Python SDK's real
// call-site shapes, not just mcp's simpler fully-literal-template-string
// shape. Every case mirrors a failure mode this gate exists to catch.

describe("normalizePath", () => {
  it("collapses template-literal params and OpenAPI-style params to the same token", () => {
    expect(normalizePath("/organizations/${this.orgPathSegment}/agents")).toBe(
      "/organizations/{param}/agents"
    );
    expect(normalizePath("/organizations/{orgId}/agents")).toBe("/organizations/{param}/agents");
  });

  it("strips a trailing query-string interpolation not preceded by a path separator", () => {
    expect(normalizePath("/organizations/{param}/agents${qs}")).toBe(
      "/organizations/{param}/agents"
    );
    expect(
      normalizePath(
        "/organizations/{param}/analytics/events${buildEventsQuery(query)}"
      )
    ).toBe("/organizations/{param}/analytics/events");
    // A real trailing route param (preceded by `/`) is NOT stripped, only collapsed.
    expect(normalizePath("/agents/${agentId}")).toBe("/agents/{param}");
  });

  it("collapses Python-style bare `{...}` f-string interpolations the same as `${...}`", () => {
    expect(normalizePath("/organizations/{self._http.org_id}/agents")).toBe(
      "/organizations/{param}/agents"
    );
  });
});

describe("buildOperationIndex", () => {
  it("indexes route existence and request-body schema properties", () => {
    const spec = {
      paths: {
        "/organizations/{orgId}/agents": { get: {} },
        "/organizations/{orgId}/guardrails/validate": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ValidateContentDto" },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ValidateContentDto: {
            type: "object",
            properties: { content: {}, agentId: {}, scope: {} },
            required: ["content"],
          },
        },
      },
    };
    const index = buildOperationIndex(spec);
    expect(index.get("get /organizations/{param}/agents")).toBeDefined();
    const validate = index.get("post /organizations/{param}/guardrails/validate");
    expect(validate?.properties).toEqual(new Set(["content", "agentId", "scope"]));
  });
});

describe("TS scanner end-to-end (fixture source tree)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(source: string): string {
    dir = mkdtempSync(join(tmpdir(), "sdk-contract-test-"));
    writeFileSync(join(dir, "agents.ts"), source);
    return dir;
  }

  // Mirrors sdk/src/agents.ts's real shape: a `this.agentsBase` instance
  // field built once, then referenced BOTH inline in a template literal
  // AND as a bare identifier passed straight through as the call's first
  // argument (`this.client.post(this.agentsBase, data)`) — the exact shape
  // mcp's api-client.ts never has, and the reason this is a generalized
  // copy rather than a drop-in reuse.
  const FIXTURE_CLIENT = `
export class FixtureAgents {
  constructor(orgId: string) {
    this.agentsBase = \`/organizations/\${orgId}/agents\`;
  }
  async list(): Promise<
    AgentRecord[] | { data?: AgentRecord[]; agents?: AgentRecord[] }
  > {
    return this.client.get<
      AgentRecord[] | { data?: AgentRecord[]; agents?: AgentRecord[] }
    >(\`\${this.agentsBase}\`);
  }
  async create(data) {
    return this.client.post<AgentRecord>(this.agentsBase, data);
  }
  async get(agentId: string) {
    return this.client.get<AgentRecord>(\`\${this.agentsBase}/\${agentId}\`);
  }
}
`;

  const REAL_SPEC = {
    paths: {
      "/organizations/{orgId}/agents": { get: {}, post: {} },
      "/organizations/{orgId}/agents/{agentId}": { get: {} },
    },
  };

  it("passes clean when the fixture matches the fixture spec — including the bare-identifier-base and multi-line-semicolon-generic shapes", () => {
    const sourceRoot = writeFixture(FIXTURE_CLIENT);
    const callSites = extractCallSites(sourceRoot, "ts");
    expect(callSites.length).toBe(3);
    const failures = diffCallSites(callSites, buildOperationIndex(REAL_SPEC), sourceRoot);
    expect(failures).toEqual([]);
  });

  it("FAILS when the spec's route has been renamed (proves the gate can fail)", () => {
    const sourceRoot = writeFixture(FIXTURE_CLIENT);
    const renamedSpec = JSON.parse(JSON.stringify(REAL_SPEC));
    renamedSpec.paths["/organizations/{orgId}/agent-records"] =
      renamedSpec.paths["/organizations/{orgId}/agents"];
    delete renamedSpec.paths["/organizations/{orgId}/agents"];

    const callSites = extractCallSites(sourceRoot, "ts");
    const failures = diffCallSites(callSites, buildOperationIndex(renamedSpec), sourceRoot);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.includes("no matching route"))).toBe(true);
  });
});

// SCAN2-012/CT-08 — `sdk/src/protected-http.ts:33,42` pass a same-file
// helper CALL (`this.bindInstallation(request)`), not an object literal, as
// the POST body argument. `extractBraceLiteral` sees the identifier `this`,
// not `{`, so `bodyKeys` was `null` and `diffCallSites`'s
// `if (site.bodyKeys && operation.hasBodySchema)` silently skipped field
// checking entirely — the gate printed "passed" having verified NOTHING
// about this call site's body.
describe("TS scanner resolves same-file body-wrapper helpers (SCAN2-012)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(source: string): string {
    dir = mkdtempSync(join(tmpdir(), "sdk-contract-wrapper-test-"));
    writeFileSync(join(dir, "protected-http.ts"), source);
    return dir;
  }

  // Mirrors protected-http.ts's real shape: `bindInstallation` spreads an
  // opaque parameter (`...request`, unresolvable) AND adds one literal key
  // (`checkpoint`) plus — the deliberate mismatch for this repro — a second
  // literal key (`debugFlag`) the DTO does not declare.
  const FIXTURE_WITH_UNDECLARED_FIELD = `
export class FixtureProtectedHttp {
  constructor(orgId) {
    this.base = \`/organizations/\${orgId}/protected-http\`;
  }
  prepare(request) {
    return this.client.post(\`\${this.base}/prepare\`, this.bindInstallation(request));
  }
  private bindInstallation(request) {
    return { ...request, checkpoint: { ...request.checkpoint, installationId: this.runtimeInstallationId }, debugFlag: true };
  }
}
`;

  const SPEC = {
    paths: {
      "/organizations/{orgId}/protected-http/prepare": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PrepareProtectedHttpDto" },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        PrepareProtectedHttpDto: {
          type: "object",
          properties: { checkpoint: {} },
        },
      },
    },
  };

  it("resolves the wrapper call to its return literal and catches an undeclared field the DTO doesn't have", () => {
    const sourceRoot = writeFixture(FIXTURE_WITH_UNDECLARED_FIELD);
    const callSites = extractCallSites(sourceRoot, "ts");
    const postSite = callSites.find((s) => s.method === "post");
    expect(postSite?.bodyKeys).toEqual(["checkpoint", "debugFlag"]);
    const failures = diffCallSites(callSites, buildOperationIndex(SPEC), sourceRoot);
    expect(failures.some((f) => f.includes('sends body field "debugFlag"'))).toBe(true);
  });

  it("fails loudly (does not silently pass) when the body argument cannot be resolved to any literal at all", () => {
    const source = `
export class FixtureUnresolvable {
  constructor(orgId) {
    this.base = \`/organizations/\${orgId}/protected-http\`;
  }
  prepare(request) {
    return this.client.post(\`\${this.base}/prepare\`, this.externallyImportedHelper(request));
  }
}
`;
    const sourceRoot = writeFixture(source);
    const callSites = extractCallSites(sourceRoot, "ts");
    const postSite = callSites.find((s) => s.method === "post");
    expect(postSite?.bodyKeys).toBe("UNRESOLVED");
    const failures = diffCallSites(callSites, buildOperationIndex(SPEC), sourceRoot);
    expect(failures.some((f) => f.includes("could not be statically resolved"))).toBe(true);
  });
});

describe("Python scanner end-to-end (fixture source tree)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(source: string): string {
    dir = mkdtempSync(join(tmpdir(), "sdk-py-contract-test-"));
    writeFileSync(join(dir, "connections.py"), source);
    return dir;
  }

  // Mirrors sdk-python/praesidia/connections.py's real shape: `self._base`
  // f-string attribute, inline f-string interpolation, AND an explicit
  // `json={"status": status}` keyword-arg dict-literal body (the one real
  // payload-shape-checkable POST/PATCH shape in the Python SDK).
  const FIXTURE_CLIENT = `
class FixtureConnections:
    def __init__(self, http):
        self._http = http
        self._base = f"/organizations/{http.org_id}/connections"

    def update_status(self, connection_id, status):
        return self._http.patch(
            f"{self._base}/{path_segment(connection_id, 'connection_id')}/status",
            json={"status": status, "reason": "x"},
        )

    def get(self, connection_id):
        return self._http.get(
            f"{self._base}/{path_segment(connection_id, 'connection_id')}"
        )
`;

  const REAL_SPEC = {
    paths: {
      "/organizations/{orgId}/connections/{id}/status": {
        patch: {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdateConnectionStatusDto" },
              },
            },
          },
        },
      },
      "/organizations/{orgId}/connections/{id}": { get: {} },
    },
    components: {
      schemas: {
        UpdateConnectionStatusDto: {
          type: "object",
          properties: { status: {} },
          required: ["status"],
        },
      },
    },
  };

  it("passes clean when routes match; f-string base substitution + `json=` dict-literal extraction both work", () => {
    const sourceRoot = writeFixture(FIXTURE_CLIENT);
    const callSites = extractCallSites(sourceRoot, "py");
    expect(callSites.length).toBe(2);
    const patchSite = callSites.find((s) => s.method === "patch");
    expect(patchSite?.bodyKeys).toEqual(["status", "reason"]);
  });

  it("FAILS when the client sends a body field the spec's DTO does not declare (proves the gate can fail)", () => {
    const sourceRoot = writeFixture(FIXTURE_CLIENT);
    const callSites = extractCallSites(sourceRoot, "py");
    const failures = diffCallSites(callSites, buildOperationIndex(REAL_SPEC), sourceRoot);
    expect(failures.length).toBe(1);
    expect(failures[0]).toMatch(/sends body field "reason"/);
  });

  it("FAILS when the spec's route has been renamed", () => {
    const sourceRoot = writeFixture(FIXTURE_CLIENT);
    const renamedSpec = JSON.parse(JSON.stringify(REAL_SPEC));
    renamedSpec.paths["/organizations/{orgId}/connections/{id}"] = undefined;
    delete renamedSpec.paths["/organizations/{orgId}/connections/{id}"];

    const callSites = extractCallSites(sourceRoot, "py");
    const failures = diffCallSites(callSites, buildOperationIndex(renamedSpec), sourceRoot);
    expect(failures.some((f) => f.includes("no matching route"))).toBe(true);
  });
});
