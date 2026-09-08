#!/usr/bin/env node

/**
 * CD-0006 / CD-0007 — contract-drift gate for BOTH published SDKs
 * (`@praesidia/sdk` on npm and `praesidia` on PyPI) against be-core's
 * routes/DTOs, as captured in a freshly exported `swagger.json`.
 *
 * ORIGIN: this is a COPY of `mcp/scripts/audit-api-contract.mjs` (CD-0001),
 * not a fresh implementation — same shape (extract call sites -> build an
 * operation index from the spec -> diff route existence + POST/PUT/PATCH
 * body-field shape -> exit 1 on any failure). `normalizePath`,
 * `buildOperationIndex`, `diffCallSites`, `extractObjectLiteral` /
 * `objectLiteralKeys` are reused near-verbatim from mcp's version (mcp-dev
 * deliberately parameterized them by `sourceRoot`/`specPath` for this reuse).
 *
 * WHY A COPY, NOT A DIRECT IMPORT: `sdk-dev` does not own `mcp` (POLICY.md
 * §4, one writer per repo) and `mcp/scripts/audit-api-contract.mjs` is not
 * published as an importable module (it's a repo-local CLI script, no
 * package boundary to import across two independent git repos without a
 * new shared package — out of scope for this ticket). CD-0006/CD-0007 both
 * say: reuse if it generalizes, else copy-and-generalize-with-attribution
 * and file a follow-up to consolidate. Filed as `CD-0011` (see backlog) —
 * a real third copy would be `sdk-python` re-deriving this AGAIN in Python;
 * that is avoided below by making the copy usable against `.py` sources
 * too (`--lang py`), so `sdk-python`'s CI runs the SAME script instance via
 * a sibling checkout of `sdk` (see `sdk-python/.github/workflows/
 * contract-drift.yml`) rather than a third divergent implementation.
 *
 * WHY THIS COPY IS NOT A DROP-IN REUSE (had to generalize, not just
 * parameterize the source dir): mcp's `src/api-client.ts` writes every
 * route as a single, fully-literal template string per call
 * (`this.get(\`/organizations/${orgId}/agents\`)`). This SDK's resource
 * classes (`sdk/src/*.ts`) precompute a route "base" once per instance
 * (`this.agentsBase = \`/organizations/${orgId}/agents\`;` in the
 * constructor) and then EITHER interpolate it inline (`` `${this.agentsBase}/
 * ${id}` ``) OR pass the bare `this.agentsBase` identifier straight through
 * as the call's first argument with no template literal at all
 * (`this.client.post(this.agentsBase, data)`), and one call site
 * (`guard.ts` `protectAction`) builds a `path` local by concatenating three
 * template-literal segments with `+` before calling. mcp's version has no
 * concept of any of this. The Python SDK (`sdk-python/praesidia/*.py`) is
 * the exact same shape one language over: `self._base = f"..."` instance
 * attributes, f-string interpolation, and Python's own (operator-less,
 * juxtaposition) string-literal concatenation across lines. Both are
 * handled below by a small per-instance/module symbol table (`this.xxx =`
 * / `self.xxx =` / `const/NAME =` assignments of a string literal) that
 * calls sites are resolved against before path normalization, plus a
 * generic-type-argument skip that is bracket-depth-aware (mcp's
 * `[^;]*?`-bounded regex breaks on this SDK's paginated `list()` methods,
 * whose inline response-envelope generics contain semicolons:
 * `this.client.get<Foo[] | { data?: Foo[]; agents?: Foo[] }>(...)`).
 *
 * Usage:
 *   node scripts/audit-api-contract.mjs [path-to-swagger.json] [--source <dir>] [--lang ts|py]
 *
 * `--lang` defaults to `ts`. `sdk-python`'s CI passes `--lang py --source
 * <sibling-checkout>/praesidia`.
 *
 * Spec path resolution: CLI positional arg > BE_SWAGGER_PATH env var >
 * `../ui/swagger.json` (this monorepo checkout's committed, gate-verified
 * spec — see `mcp/scripts/audit-api-contract.mjs`'s identical default and
 * rationale). CI overrides with a fresh be-core sibling-checkout export.
 *
 * Exit 0 = no drift. Exit 1 = drift found (every offending line printed).
 * Exit 2 = usage/spec error — fails closed rather than reporting a false
 * "no drift".
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

// ─── Path normalization ──────────────────────────────────────────────────────

/**
 * Normalize a route literal (from either a spec path key or a source path
 * expression, TS template-literal or Python f-string, ALREADY resolved
 * through the symbol table below) so the two can be compared structurally.
 *
 * Generalization vs mcp's version (documented per the header): a trailing
 * BARE-identifier interpolation with no path separator before it —
 * `${qs}` (TS, this SDK's `buildQueryString`/`buildPageQuery`/
 * `buildWindowQuery` helpers) — is always a query-string tail appended
 * without a literal `?`, never a route param (every real route param in
 * this codebase follows a literal `/`). This generalizes mcp's
 * single-cased `${query...}` strip. Python needs no equivalent: this SDK's
 * Python client passes query params via a separate `params=` kwarg, never
 * folded into the path string.
 */
export function normalizePath(value) {
  return (
    value
      .replace(/^\$\{apiUrl\}/, "")
      .replace(/\$\{query\b[\s\S]*$/, "")
      .replace(/(?<!\/)\$\{\w+\}$/, "")
      .split("?")[0]
      .replace(/\$\{[^}]+\}/g, "{param}")
      .replace(/\{[^}]+\}/g, "{param}")
      .replace(/\/+$/g, "") || "/"
  );
}

// ─── Spec loading (identical to mcp's version — be-core-agnostic) ───────────

function resolveSchema(spec, schema) {
  if (schema && typeof schema === "object" && typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").pop();
    return spec.components?.schemas?.[name] ?? null;
  }
  return schema ?? null;
}

export function buildOperationIndex(spec) {
  const index = new Map();
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const normalized = normalizePath(path);
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      const key = `${method} ${normalized}`;
      const schema = resolveSchema(
        spec,
        operation?.requestBody?.content?.["application/json"]?.schema
      );
      index.set(key, {
        properties: new Set(Object.keys(schema?.properties ?? {})),
        required: new Set(Array.isArray(schema?.required) ? schema.required : []),
        hasBodySchema: !!schema,
      });
    }
  }
  return index;
}

// ─── Source file discovery ───────────────────────────────────────────────────

function sourceFiles(directory, extensions) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__" || entry.name === "node_modules") return [];
      return sourceFiles(path, extensions);
    }
    return extensions.includes(extname(entry.name)) &&
      !entry.name.includes(".test.") &&
      !entry.name.includes(".spec.") &&
      !/^test_/.test(entry.name)
      ? [path]
      : [];
  });
}

// ─── Object/dict literal helpers (shared) ────────────────────────────────────

/** Depth-aware extraction of a `{ ... }` literal starting at/after `fromIndex`. */
function extractBraceLiteral(source, fromIndex) {
  let i = fromIndex;
  while (i < source.length && /[\s,]/.test(source[i])) i++;
  if (source[i] !== "{") return null;
  let depth = 0;
  const start = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * SCAN2-012/CT-08 — sentinel for "this is a non-GET call site with a body
 * argument that is neither an object/dict literal nor a same-file helper
 * call whose return literal we could resolve". `diffCallSites` treats this
 * as a FAILURE, not a skip: narrowness (we can't resolve every expression
 * shape) is tolerable, silently reporting "no drift" on an unanalysed body
 * is not.
 */
const UNRESOLVED_BODY = "UNRESOLVED";

/** Find the index of the `}` matching the `{` at `openIndex` (brace-depth-aware). */
function findMatchingBrace(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * SCAN2-012/CT-08 — follow a same-file, single-argument helper call
 * (`this.bindInstallation(request)`) to its method body and resolve the
 * FIRST `return { ... }` object literal found inside it. A helper with only
 * a bare passthrough return (`return request;`, no literal) or that isn't
 * defined in this file returns `null` (caller falls back to
 * `UNRESOLVED_BODY`). Doesn't attempt to resolve what a spread
 * (`...request`) inside that literal contributes — same limitation
 * `objectLiteralKeysTs` already has for every other call site in this
 * codebase, not a new one introduced here.
 */
function resolveTsHelperReturnLiteral(source, methodName) {
  const defRe = new RegExp(`\\b${methodName}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^{]*)?\\{`);
  const defMatch = defRe.exec(source);
  if (!defMatch) return null;
  const bodyStart = defMatch.index + defMatch[0].length - 1;
  const bodyEnd = findMatchingBrace(source, bodyStart);
  if (bodyEnd === -1) return null;
  const body = source.slice(bodyStart, bodyEnd + 1);
  const returnRe = /\breturn\s*/g;
  let m;
  while ((m = returnRe.exec(body))) {
    const literal = extractBraceLiteral(body, m.index + m[0].length);
    if (literal) return literal;
    // "return <identifier>;" (build-then-return, e.g. guard.ts's
    // buildTaskBody) — follow to a same-body `const <identifier> = { ... }`.
    const idMatch = /^([A-Za-z_$][\w$]*)\s*;/.exec(body.slice(m.index + m[0].length));
    if (idMatch) {
      const constRe = new RegExp(`\\bconst\\s+${idMatch[1]}\\s*(?::[^=]*)?=\\s*`);
      const constMatch = constRe.exec(body);
      if (constMatch) {
        const constLiteral = extractBraceLiteral(body, constMatch.index + constMatch[0].length);
        if (constLiteral) return constLiteral;
      }
    }
  }
  return null;
}

/** Python equivalent of {@link resolveTsHelperReturnLiteral} (indentation-delimited blocks, not braces). */
function resolvePyHelperReturnLiteral(source, methodName) {
  const lines = source.split("\n");
  const defRe = new RegExp(`^(\\s*)def\\s+${methodName}\\s*\\(`);
  let defIdx = -1;
  let defIndent = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const m = defRe.exec(lines[idx]);
    if (m) {
      defIdx = idx;
      defIndent = m[1].length;
      break;
    }
  }
  if (defIdx === -1) return null;
  const bodyLines = [];
  for (let idx = defIdx + 1; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.trim() === "") {
      bodyLines.push(line);
      continue;
    }
    if (line.match(/^\s*/)[0].length <= defIndent) break;
    bodyLines.push(line);
  }
  const body = bodyLines.join("\n");
  const returnRe = /\breturn\s*/g;
  let m;
  while ((m = returnRe.exec(body))) {
    const literal = extractBraceLiteral(body, m.index + m[0].length);
    if (literal) return literal;
  }
  return null;
}

/** Top-level keys of a JS/TS `{ a, b: c, d: e ?? {} }` object-literal text. */
function objectLiteralKeysTs(literal) {
  const inner = literal.slice(1, -1);
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of inner) {
    if (char === "{" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ")" || char === "]") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current);

  const keys = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith("...")) continue;
    const colon = trimmed.indexOf(":");
    const key = (colon === -1 ? trimmed : trimmed.slice(0, colon)).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.push(key);
  }
  return keys;
}

/**
 * Top-level keys of a Python `{"a": b, "c": d}` dict-literal text. Python
 * dict keys in this codebase are always quoted string literals (no
 * shorthand, no bare-identifier keys), so — unlike the TS variant — this is
 * a flat regex scan rather than full depth-aware parsing. Every real call
 * site (`connections.py:122`, `memory.py:161`) is a single-level flat dict;
 * a nested dict value would need a depth-aware rewrite, parked as a known
 * limitation rather than guessed at without a real example to test against.
 */
function objectLiteralKeysPy(literal) {
  const inner = literal.slice(1, -1);
  const keys = [];
  for (const m of inner.matchAll(/(?:^|,)\s*["']([^"']+)["']\s*:/g)) keys.push(m[1]);
  return keys;
}

/**
 * SCAN2-012/CT-08 — resolve a non-`get` call's body argument starting at
 * `fromIndex` (just past the path argument). Three outcomes:
 *  - no argument follows at all -> `null` (no body sent — a legitimate state)
 *  - an object literal (`{ ... }`) -> its keys
 *  - a same-file helper call (`this.methodName(...)`) whose return literal
 *    resolves -> that literal's keys (SCAN2-012 fix)
 *  - anything else (helper not found, no literal return, or a truly
 *    unresolvable expression) -> `UNRESOLVED_BODY` (fail loudly, not skip)
 */
function resolveTsBodyKeys(source, fromIndex) {
  let i = fromIndex;
  while (i < source.length && /[\s,]/.test(source[i])) i++;
  if (source[i] === ")") return null; // no body argument at all
  if (source[i] === "{") {
    const literal = extractBraceLiteral(source, i);
    return literal ? objectLiteralKeysTs(literal) : UNRESOLVED_BODY;
  }
  const callMatch = /^this\.(\w+)\s*\(/.exec(source.slice(i));
  if (callMatch) {
    // A same-file helper CALL is something the SDK author controls and can
    // be checked — resolve it, and fail loudly (not skip) if it turns out
    // not to resolve. A BARE identifier (falls through below, e.g. a
    // `data: Record<string, unknown>` parameter passed straight through)
    // is deliberately opaque caller-supplied data with no fixed shape to
    // check against — that is intentional passthrough, not this ticket's
    // defect, and stays a skip (`null`) exactly as before.
    const literal = resolveTsHelperReturnLiteral(source, callMatch[1]);
    return literal ? objectLiteralKeysTs(literal) : UNRESOLVED_BODY;
  }
  return null;
}

/** Python equivalent of {@link resolveTsBodyKeys}, for a `json=<expr>` keyword argument's `<expr>`. */
function resolvePyBodyKeys(argsText, fromIndex, source) {
  let i = fromIndex;
  while (/\s/.test(argsText[i])) i++;
  if (argsText[i] === "{") {
    const literal = extractBraceLiteral(argsText, i);
    return literal ? objectLiteralKeysPy(literal) : UNRESOLVED_BODY;
  }
  const callMatch = /^self\.(\w+)\s*\(/.exec(argsText.slice(i));
  if (callMatch) {
    // Same distinction as resolveTsBodyKeys: a same-file helper CALL
    // (`self.bind_installation(request)`) is checkable and fails loudly if
    // it doesn't resolve; a bare identifier (`json=data`, deliberately
    // opaque caller-supplied data) stays a skip, matching prior behaviour.
    const literal = resolvePyHelperReturnLiteral(source, callMatch[1]);
    return literal ? objectLiteralKeysPy(literal) : UNRESOLVED_BODY;
  }
  return null;
}

// ─── TS extraction ────────────────────────────────────────────────────────────

const TS_METHOD_ALIASES = { del: "delete", getBytes: "get", getAllPages: "get", publicGet: "get" };
const TS_METHOD_PATTERN =
  /\bthis\.(?:client\.)?(get|post|put|patch|delete|del|getBytes|getAllPages|publicGet)\b/g;

/**
 * `this.xBase = \`...\`;` / `const NAME = \`...\`( + \`...\`)*;` /
 * `const NAME = '...';` — every string-literal-valued assignment in the
 * file, blind-captured (only used when a call site actually references the
 * name; harmless if it never is). Used both for per-instance route bases
 * and for the one local multi-segment `path` built via `+` concatenation
 * (`guard.ts` `protectAction`).
 */
function buildTsSymbolTable(source) {
  const symbols = new Map();

  const fieldRe = /\bthis\.(\w+)\s*=\s*`/g;
  for (const m of source.matchAll(fieldRe)) {
    const start = m.index + m[0].length - 1;
    const { text } = collectTemplateConcatenation(source, start);
    symbols.set(`this.${m[1]}`, text);
  }

  const constTemplateRe = /\bconst\s+(\w+)\s*=\s*`/g;
  for (const m of source.matchAll(constTemplateRe)) {
    const start = m.index + m[0].length - 1;
    const { text } = collectTemplateConcatenation(source, start);
    symbols.set(m[1], text);
  }

  const constStringRe = /\bconst\s+(\w+)\s*=\s*(['"])((?:(?!\2)[^\\]|\\.)*)\2\s*;/g;
  for (const m of source.matchAll(constStringRe)) {
    symbols.set(m[1], m[3]);
  }

  return symbols;
}

/** One or more `` `...` `` segments joined by `+`, starting at a backtick. */
function collectTemplateConcatenation(source, fromIndex) {
  let i = fromIndex;
  let text = "";
  for (;;) {
    if (source[i] !== "`") break;
    const end = source.indexOf("`", i + 1);
    if (end === -1) break;
    text += source.slice(i + 1, end);
    i = end + 1;
    let j = i;
    while (/\s/.test(source[j])) j++;
    if (source[j] === "+") {
      let k = j + 1;
      while (/\s/.test(source[k])) k++;
      if (source[k] === "`") {
        i = k;
        continue;
      }
    }
    break;
  }
  return { text, end: i };
}

/** Replace `${this.xxx}` / `${xxx}` references with a known symbol's resolved text (one pass — no base references another in this codebase). */
function substituteTsBases(raw, symbols) {
  return raw.replace(/\$\{(this\.\w+|\w+)\}/g, (whole, name) =>
    symbols.has(name) ? symbols.get(name) : whole
  );
}

function extractCallSitesTs(sourceRoot) {
  const sites = [];
  for (const file of sourceFiles(sourceRoot, [".ts", ".tsx"])) {
    if (!statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    const symbols = buildTsSymbolTable(source);

    for (const match of source.matchAll(TS_METHOD_PATTERN)) {
      let i = match.index + match[0].length;
      while (/\s/.test(source[i])) i++;
      // Bracket-depth-aware generic-argument skip (NOT mcp's `[^;]*?`-bounded
      // regex, which breaks on this SDK's semicolon-bearing inline response
      // generics — see file header).
      if (source[i] === "<") {
        let depth = 0;
        for (; i < source.length; i++) {
          if (source[i] === "<") depth++;
          else if (source[i] === ">") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          }
        }
        while (/\s/.test(source[i])) i++;
      }
      if (source[i] !== "(") continue;
      i++;
      while (/\s/.test(source[i])) i++;

      const rawMethod = match[1];
      const method = TS_METHOD_ALIASES[rawMethod] ?? rawMethod;

      let rawText;
      let argEnd;
      if (source[i] === "`") {
        const { text, end } = collectTemplateConcatenation(source, i);
        rawText = text;
        argEnd = end;
      } else {
        const idMatch = /^(this\.\w+|[A-Za-z_$][\w$]*)/.exec(source.slice(i));
        if (!idMatch || !symbols.has(idMatch[1])) continue; // unresolvable expression — cannot verify statically, skip rather than guess
        rawText = symbols.get(idMatch[1]);
        argEnd = i + idMatch[1].length;
      }

      rawText = substituteTsBases(rawText, symbols);
      if (!rawText.startsWith("/") && !rawText.startsWith("${apiUrl}")) continue;

      const line = source.slice(0, match.index).split("\n").length;
      sites.push({
        file,
        line,
        method,
        rawPath: rawText,
        bodyKeys: method === "get" ? null : resolveTsBodyKeys(source, argEnd),
      });
    }
  }
  return sites;
}

// ─── Python extraction ────────────────────────────────────────────────────────

const PY_METHOD_ALIASES = { stream_get: "get" };
const PY_METHOD_PATTERN = /\bself\._http\.(get|post|put|patch|delete|stream_get)\s*\(/g;

/** Read one Python string literal (optionally f-prefixed) starting at `i`. Returns { text: RAW including quotes/prefix, end } or null. */
function readPyString(source, i) {
  const start = i;
  if (source[i] === "f" || source[i] === "F") i++;
  const quote = source[i];
  if (quote !== '"' && quote !== "'") return null;
  i++;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return { text: source.slice(start, i + 1), end: i + 1 };
    i++;
  }
  return null;
}

/** Adjacent (juxtaposed, operator-less) Python string-literal concatenation. */
function collectFStringConcatenation(source, fromIndex) {
  let i = fromIndex;
  let text = "";
  let sawAny = false;
  for (;;) {
    while (/\s/.test(source[i])) i++;
    const isF = source[i] === "f" || source[i] === "F";
    const quoteAt = isF ? i + 1 : i;
    if (source[quoteAt] !== '"' && source[quoteAt] !== "'") break;
    const result = readPyString(source, i);
    if (!result) break;
    text += result.text.slice(isF ? 2 : 1, -1);
    i = result.end;
    sawAny = true;
  }
  return sawAny ? { text, end: i } : null;
}

/**
 * `self.xxx = f"..."` (optionally parenthesized across lines) /
 * `NAME = "..."` (module-level constants) / `NAME = (f"..." f"...")`
 * (local multi-segment paths, e.g. `agents.py`'s `protect_action`'s
 * `path`). Blind-captured per file, same rationale as the TS symbol table.
 */
function buildPySymbolTable(source) {
  const symbols = new Map();

  const assignRe = /\b(?:self\.(\w+)|([A-Za-z_]\w*))\s*=\s*/g;
  for (const m of source.matchAll(assignRe)) {
    let i = m.index + m[0].length;
    while (/\s/.test(source[i])) i++;
    let openedParen = false;
    if (source[i] === "(") {
      openedParen = true;
      i++;
      while (/\s/.test(source[i])) i++;
    }
    const result = collectFStringConcatenation(source, i);
    if (!result) continue;
    void openedParen; // trailing ')' not validated — best-effort, matches this codebase's shapes
    const name = m[1] ? `self.${m[1]}` : m[2];
    symbols.set(name, result.text);
  }
  return symbols;
}

/** Replace `{self.xxx}` / `{xxx}` interpolations with a known symbol's resolved text. */
function substitutePyBases(raw, symbols) {
  return raw.replace(/\{(self\.\w+|\w+)\}/g, (whole, name) =>
    symbols.has(name) ? symbols.get(name) : whole
  );
}

/** Find the balanced closing paren for a call opened at `openIndex` (points just past `(`), treating Python string literals as opaque. */
function findMatchingParen(source, openIndex) {
  let depth = 1;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ((ch === "f" || ch === "F") && (source[i + 1] === '"' || source[i + 1] === "'"))) {
      const result = readPyString(source, ch === "f" || ch === "F" ? i : i);
      if (result) {
        i = result.end;
        continue;
      }
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function extractCallSitesPy(sourceRoot) {
  const sites = [];
  for (const file of sourceFiles(sourceRoot, [".py"])) {
    if (!statSync(file).isFile()) continue;
    const source = readFileSync(file, "utf8");
    const symbols = buildPySymbolTable(source);

    for (const match of source.matchAll(PY_METHOD_PATTERN)) {
      let i = match.index + match[0].length; // just past the call's '('
      const argsEnd = findMatchingParen(source, i);
      const argsText = argsEnd === -1 ? source.slice(i) : source.slice(i, argsEnd);

      while (/\s/.test(source[i])) i++;
      const rawMethod = match[1];
      const method = PY_METHOD_ALIASES[rawMethod] ?? rawMethod;

      let rawText;
      const fstr = collectFStringConcatenation(source, i);
      if (fstr) {
        rawText = fstr.text;
      } else {
        const idMatch = /^(self\.\w+|[A-Za-z_]\w*)/.exec(source.slice(i));
        if (!idMatch || !symbols.has(idMatch[1])) continue;
        rawText = symbols.get(idMatch[1]);
      }

      rawText = substitutePyBases(rawText, symbols);
      if (!rawText.startsWith("/")) continue;

      let bodyKeys = null;
      if (method !== "get") {
        const jsonKw = /\bjson\s*=\s*/.exec(argsText);
        // No `json=` keyword arg at all is a legitimate "no body sent" state
        // (matches GET's `null`); `json=<expr>` present but unresolvable is
        // SCAN2-012/CT-08's fail-loudly case (resolveTsBodyKeys's sibling).
        if (jsonKw) {
          bodyKeys = resolvePyBodyKeys(argsText, jsonKw.index + jsonKw[0].length, source);
        }
      }

      const line = source.slice(0, match.index).split("\n").length;
      sites.push({ file, line, method, rawPath: rawText, bodyKeys });
    }
  }
  return sites;
}

// ─── Extraction dispatch ──────────────────────────────────────────────────────

export function extractCallSites(sourceRoot, lang = "ts") {
  return lang === "py" ? extractCallSitesPy(sourceRoot) : extractCallSitesTs(sourceRoot);
}

// ─── Diff (language-agnostic, identical to mcp's version) ───────────────────

export function diffCallSites(callSites, operationIndex, repoRoot) {
  const failures = [];
  for (const site of callSites) {
    const normalized = normalizePath(site.rawPath);
    const key = `${site.method} ${normalized}`;
    const operation = operationIndex.get(key);
    const location = `${relative(repoRoot, site.file)}:${site.line}`;

    if (!operation) {
      failures.push(`${location} ${key} — no matching route in swagger.json`);
      continue;
    }
    // SCAN2-012/CT-08 — a non-GET call whose body argument could not be
    // statically resolved to ANY literal (not even via a same-file helper)
    // must fail loudly, not silently pass as if it had no body to check.
    // Narrowness (some expression shapes are genuinely out of reach for a
    // regex-based scanner) is tolerable; reporting "no drift" while having
    // verified nothing is not.
    if (site.bodyKeys === UNRESOLVED_BODY) {
      failures.push(
        `${location} ${key} — body argument could not be statically resolved to an object ` +
          `literal (directly or via a same-file helper's return) — this call site was NOT ` +
          `verified against the DTO; resolve manually or teach the extractor its shape`
      );
      continue;
    }
    if (site.bodyKeys && operation.hasBodySchema) {
      for (const sentKey of site.bodyKeys) {
        if (!operation.properties.has(sentKey)) {
          failures.push(
            `${location} ${key} sends body field "${sentKey}" — not declared on the be-core ` +
              `request DTO for this route (be's forbidNonWhitelisted ValidationPipe will 400 ` +
              `the ENTIRE request)`
          );
        }
      }
    }
  }
  return failures;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let specPath;
  let sourceDir;
  let lang = "ts";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source") sourceDir = argv[++i];
    else if (argv[i] === "--lang") lang = argv[++i];
    else if (!specPath) specPath = argv[i];
  }
  return { specPath, sourceDir, lang };
}

function main() {
  const scriptDir = fileURLToPath(new URL(".", import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const { specPath: cliSpecPath, sourceDir, lang } = parseArgs(process.argv.slice(2));

  // A user-supplied spec path or BE_SWAGGER_PATH is resolved relative to the
  // CURRENT working directory (standard CLI convention — required for the
  // cross-repo invocation `node sdk/scripts/audit-api-contract.mjs
  // swagger.generated.json --source sdk-python/praesidia --lang py` run from
  // a sibling-checkout workspace root, where repoRoot (sdk/) is NOT cwd).
  // Only the hardcoded local-dev DEFAULT is repoRoot-relative, matching this
  // script's own package layout.
  const specPath =
    cliSpecPath !== undefined
      ? resolve(process.cwd(), cliSpecPath)
      : process.env.BE_SWAGGER_PATH
        ? resolve(process.cwd(), process.env.BE_SWAGGER_PATH)
        : resolve(repoRoot, "../ui/swagger.json");
  const sourceRoot = resolve(sourceDir ? process.cwd() : repoRoot, sourceDir ?? "src");

  if (!existsSync(specPath)) {
    console.error(
      `::error::no swagger.json at ${specPath} — pass a path ` +
        `(node scripts/audit-api-contract.mjs <path>), set BE_SWAGGER_PATH, or export one from a ` +
        `be-core checkout (npm run export:openapi). Failing closed rather than skipping the check.`
    );
    process.exit(2);
  }

  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (error) {
    console.error(`::error::failed to parse ${specPath} as JSON: ${error.message}`);
    process.exit(2);
  }
  if (!spec.paths || typeof spec.paths !== "object" || Object.keys(spec.paths).length === 0) {
    console.error(`::error::${specPath} has no "paths" — refusing to pass an empty spec.`);
    process.exit(2);
  }

  const operationIndex = buildOperationIndex(spec);
  const callSites = extractCallSites(sourceRoot, lang);
  const displayRoot = sourceDir || cliSpecPath !== undefined ? process.cwd() : repoRoot;
  const failures = diffCallSites(callSites, operationIndex, displayRoot);
  // SCAN2-012/CT-08 — surface this count explicitly, not just folded into a
  // failure line: it's the "how many call sites could this scanner not
  // actually see" number the gate previously hid inside a false "passed".
  const unresolvedCount = callSites.filter((s) => s.bodyKeys === UNRESOLVED_BODY).length;

  const label = lang === "py" ? "sdk-python" : "sdk";
  if (failures.length > 0) {
    console.error(`${label} <-> be-core API contract drift detected:`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      `\nUpdate ${lang === "py" ? "praesidia/*.py" : "src/*.ts"} to match be-core's routes/DTOs ` +
        "(or, if be-core genuinely dropped/renamed something this SDK needs, that is a be-core-side " +
        "regression — file it there)."
    );
    if (unresolvedCount > 0) {
      console.error(
        `\n${unresolvedCount} call site(s) above could not be statically resolved to a body ` +
          "literal at all — the extractor needs to learn that shape."
      );
    }
    process.exit(1);
  }

  console.log(
    `${label} API contract audit passed — ${callSites.length} call sites checked against ` +
      `${Object.keys(spec.paths).length} spec paths, no drift (${unresolvedCount} unresolved).`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
