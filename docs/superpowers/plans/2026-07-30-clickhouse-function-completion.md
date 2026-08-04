# ClickHouse Function Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add broad, static ClickHouse function completion with canonical casing, overload-aware and parametric signature help, table functions, and valid aggregate-combinator variants.

**Architecture:** Keep ClickHouse definitions and deterministic combinator logic in `apps/desktop/src/lib/sql/clickhouse/`. Adapt that registry into the existing generic SQL completion provider without changing other database inventories. Extend signature help to return overloads and parameter groups, then render that richer result in the existing CodeMirror tooltip.

**Tech Stack:** TypeScript 6, Vue 3, CodeMirror 6, Vitest 4, pnpm 10.

---

## File Map

**Create**

- `apps/desktop/src/lib/sql/clickhouse/functionTypes.ts` — shared ClickHouse function, signature, category, status, and registry-query types.
- `apps/desktop/src/lib/sql/clickhouse/regularFunctions.ts` — scalar and window-function inventory plus category manifest.
- `apps/desktop/src/lib/sql/clickhouse/aggregateFunctions.ts` — ordinary and parametric aggregate inventory.
- `apps/desktop/src/lib/sql/clickhouse/tableFunctions.ts` — functions valid as table sources.
- `apps/desktop/src/lib/sql/clickhouse/aggregateCombinators.ts` — legal suffix transitions and signature transformations.
- `apps/desktop/src/lib/sql/clickhouse/functionRegistry.ts` — validation, canonical lookup, prefix search, and lazy combinator generation.
- `apps/desktop/src/lib/__tests__/sql/clickhouse/functionRegistry.spec.ts` — registry integrity and lookup coverage.
- `apps/desktop/src/lib/__tests__/sql/clickhouse/aggregateCombinators.spec.ts` — combinator ordering and signature transformations.
- `apps/desktop/src/lib/__tests__/sql/sqlCompletion.signature.spec.ts` — overload and parametric-call parsing.
- `apps/desktop/src/lib/editor/sqlSignatureTooltip.ts` — render overload-aware signature help without coupling registry logic to Vue.
- `apps/desktop/src/lib/__tests__/editor/sqlSignatureTooltip.spec.ts` — exercise the real tooltip DOM in happy-dom.

**Modify**

- `apps/desktop/src/lib/sql/sqlCompletion.ts` — ClickHouse registry adapter, table-function context, canonical apply text, and multi-signature resolver.
- `apps/desktop/src/lib/__tests__/sql/sqlCompletion.context.spec.ts` — ClickHouse completion, table-function, isolation, and regression cases.
- `apps/desktop/src/components/editor/QueryEditor.vue` — render all overloads and active parameters.

**Reference**

- `docs/superpowers/specs/2026-07-30-clickhouse-function-completion-design.md`
- `apps/desktop/src/lib/__tests__/editor/queryEditorSqlSignature.spec.ts` — existing dialect reconfiguration regression to keep running.
- <https://clickhouse.com/docs/reference/functions>
- <https://clickhouse.com/docs/reference/functions/aggregate-functions/combinators>

## Task 1: Introduce the ClickHouse Function Model and Validated Registry

**Files:**

- Create: `apps/desktop/src/lib/sql/clickhouse/functionTypes.ts`
- Create: `apps/desktop/src/lib/sql/clickhouse/functionRegistry.ts`
- Create: `apps/desktop/src/lib/__tests__/sql/clickhouse/functionRegistry.spec.ts`

- [ ] **Step 1: Write failing registry-validation tests**

Create `functionRegistry.spec.ts` with real definitions covering canonical lookup, overload preservation, duplicate detection, and invalid preferred indexes:

```ts
import { describe, expect, it } from "vitest";
import { createClickHouseFunctionRegistry } from "@/lib/sql/clickhouse/functionRegistry";
import type { ClickHouseFunctionDefinition } from "@/lib/sql/clickhouse/functionTypes";

const toStartOfDay: ClickHouseFunctionDefinition = {
  name: "toStartOfDay",
  kind: "regular",
  category: "date-time",
  signatures: [{ parameterGroups: [["value", "time_zone?"]], returnType: "DateTime" }],
  aliases: ["startOfDay"],
};

describe("ClickHouse function registry", () => {
  it("looks up canonical names case-insensitively and preserves overloads", () => {
    const registry = createClickHouseFunctionRegistry([toStartOfDay]);
    expect(registry.get("TOSTARTOFDAY")).toEqual(toStartOfDay);
    expect(registry.search("tostart", 20)).toEqual([toStartOfDay]);
    expect(registry.search("startof", 20)).toEqual([toStartOfDay]);
  });

  it("rejects duplicate canonical names case-insensitively", () => {
    expect(() => createClickHouseFunctionRegistry([toStartOfDay, { ...toStartOfDay, name: "TOSTARTOFDAY" }])).toThrow(/duplicate/i);
  });

  it("rejects an invalid preferred signature index", () => {
    expect(() => createClickHouseFunctionRegistry([{ ...toStartOfDay, preferredSignature: 2 }])).toThrow(/preferred signature/i);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the RED state**

Run:

```bash
pnpm exec vitest run apps/desktop/src/lib/__tests__/sql/clickhouse/functionRegistry.spec.ts
```

Expected: FAIL because `functionTypes.ts` and `functionRegistry.ts` do not exist.

- [ ] **Step 3: Add the function types**

Create `functionTypes.ts`:

```ts
export type ClickHouseFunctionKind = "regular" | "aggregate" | "window" | "table";
export type ClickHouseFunctionStatus = "stable" | "experimental" | "deprecated";

export type ClickHouseFunctionCategory =
  | "aggregate"
  | "array"
  | "bitmap"
  | "comparison"
  | "conversion"
  | "date-time"
  | "dictionary"
  | "encoding"
  | "geo"
  | "hash"
  | "ip"
  | "json"
  | "map"
  | "math"
  | "nullable"
  | "random"
  | "string"
  | "table"
  | "tuple"
  | "url"
  | "window"
  | "other";

export interface ClickHouseFunctionSignature {
  parameterGroups: string[][];
  returnType?: string;
}

export interface ClickHouseFunctionDefinition {
  name: string;
  kind: ClickHouseFunctionKind;
  category: ClickHouseFunctionCategory;
  signatures: ClickHouseFunctionSignature[];
  description?: string;
  preferredSignature?: number;
  status?: ClickHouseFunctionStatus;
  aliases?: string[];
  combinators?: boolean;
  generated?: boolean;
}

export interface ClickHouseFunctionRegistry {
  get(name: string): ClickHouseFunctionDefinition | undefined;
  search(prefix: string, limit: number, kind?: ClickHouseFunctionKind): ClickHouseFunctionDefinition[];
  all(): readonly ClickHouseFunctionDefinition[];
}
```

- [ ] **Step 4: Implement strict construction and deterministic prefix search**

Create `functionRegistry.ts` with a private lowercase index. Validate non-empty names, non-empty signatures, non-empty parameter groups, preferred indexes, canonical collisions, and alias collisions:

```ts
import type { ClickHouseFunctionDefinition, ClickHouseFunctionKind, ClickHouseFunctionRegistry } from "./functionTypes";

function definitionKeys(definition: ClickHouseFunctionDefinition): string[] {
  return [definition.name, ...(definition.aliases ?? [])].map((name) => name.toLowerCase());
}

function validateDefinition(definition: ClickHouseFunctionDefinition): void {
  if (!definition.name.trim()) throw new Error("ClickHouse function name must not be empty");
  if (definition.signatures.length === 0) throw new Error(`ClickHouse function ${definition.name} must define a signature`);
  if (definition.signatures.some((signature) => signature.parameterGroups.length === 0)) {
    throw new Error(`ClickHouse function ${definition.name} must define a parameter group`);
  }
  const preferred = definition.preferredSignature ?? 0;
  if (preferred < 0 || preferred >= definition.signatures.length) {
    throw new Error(`ClickHouse function ${definition.name} has an invalid preferred signature`);
  }
}

export function createClickHouseFunctionRegistry(definitions: readonly ClickHouseFunctionDefinition[]): ClickHouseFunctionRegistry {
  const byKey = new Map<string, ClickHouseFunctionDefinition>();
  for (const definition of definitions) {
    validateDefinition(definition);
    for (const key of definitionKeys(definition)) {
      if (byKey.has(key)) throw new Error(`Duplicate ClickHouse function or alias: ${key}`);
      byKey.set(key, definition);
    }
  }
  const ordered = [...definitions].sort((left, right) => left.name.localeCompare(right.name));
  return {
    get: (name) => byKey.get(name.toLowerCase()),
    search: (prefix, limit, kind?: ClickHouseFunctionKind) => {
      const normalized = prefix.toLowerCase();
      return ordered.filter((definition) => (!kind || definition.kind === kind) && definitionKeys(definition).some((key) => key.startsWith(normalized))).slice(0, limit);
    },
    all: () => ordered,
  };
}
```

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run the same Vitest command. Expected: 3 tests PASS.

- [ ] **Step 6: Commit the registry foundation**

```bash
git add apps/desktop/src/lib/sql/clickhouse/functionTypes.ts apps/desktop/src/lib/sql/clickhouse/functionRegistry.ts apps/desktop/src/lib/__tests__/sql/clickhouse/functionRegistry.spec.ts
git commit -m "feat(sql): add ClickHouse function registry"
```

## Task 2: Add the Regular, Window, and Table Function Inventories

**Files:**

- Create: `apps/desktop/src/lib/sql/clickhouse/regularFunctions.ts`
- Create: `apps/desktop/src/lib/sql/clickhouse/tableFunctions.ts`
- Modify: `apps/desktop/src/lib/sql/clickhouse/functionRegistry.ts`
- Modify: `apps/desktop/src/lib/__tests__/sql/clickhouse/functionRegistry.spec.ts`

- [ ] **Step 1: Add failing inventory-integrity and representative-coverage tests**

Extend `functionRegistry.spec.ts`:

```ts
import { CLICKHOUSE_FUNCTION_CATEGORY_MANIFEST, CLICKHOUSE_REGULAR_FUNCTIONS } from "@/lib/sql/clickhouse/regularFunctions";
import { CLICKHOUSE_TABLE_FUNCTIONS } from "@/lib/sql/clickhouse/tableFunctions";
import { CLICKHOUSE_FUNCTION_REGISTRY } from "@/lib/sql/clickhouse/functionRegistry";

it("keeps the checked-in category manifest and inventory counts aligned", () => {
  for (const entry of CLICKHOUSE_FUNCTION_CATEGORY_MANIFEST) {
    expect(CLICKHOUSE_REGULAR_FUNCTIONS.filter((definition) => definition.category === entry.category)).toHaveLength(entry.minimumCount);
  }
});

it.each([
  ["arrayMap", "array"],
  ["toStartOfDay", "date-time"],
  ["JSONExtractString", "json"],
  ["cityHash64", "hash"],
  ["URLHierarchy", "url"],
  ["lagInFrame", "window"],
] as const)("contains %s with canonical casing and category %s", (name, category) => {
  expect(CLICKHOUSE_FUNCTION_REGISTRY.get(name)).toMatchObject({ name, category });
});

it.each(["numbers", "file", "url", "s3", "remote", "postgresql", "mysql"] as const)("contains the %s table function", (name) => {
  expect(CLICKHOUSE_TABLE_FUNCTIONS.some((definition) => definition.name === name && definition.kind === "table")).toBe(true);
});
```

- [ ] **Step 2: Run the registry test and verify the missing-inventory failure**

Expected: FAIL because the inventory modules and exported default registry do not exist.

- [ ] **Step 3: Add regular-function helpers and the first documented categories**

In `regularFunctions.ts`, use a small typed helper so data remains compact:

```ts
import type { ClickHouseFunctionCategory, ClickHouseFunctionDefinition, ClickHouseFunctionSignature } from "./functionTypes";

const regular = (
  name: string,
  category: ClickHouseFunctionCategory,
  signatures: ClickHouseFunctionSignature[],
  options: Partial<ClickHouseFunctionDefinition> = {},
): ClickHouseFunctionDefinition => ({ name, kind: "regular", category, signatures, ...options });

export const CLICKHOUSE_REGULAR_FUNCTIONS: ClickHouseFunctionDefinition[] = [
  regular("arrayMap", "array", [{ parameterGroups: [["lambda", "array", "...arrays"]], returnType: "Array" }]),
  regular("toStartOfDay", "date-time", [
    { parameterGroups: [["value"]], returnType: "DateTime" },
    { parameterGroups: [["value", "time_zone"]], returnType: "DateTime" },
  ]),
  regular("JSONExtractString", "json", [{ parameterGroups: [["json", "path", "...paths"]], returnType: "String" }]),
  regular("cityHash64", "hash", [{ parameterGroups: [["argument", "...arguments"]], returnType: "UInt64" }]),
  regular("URLHierarchy", "url", [{ parameterGroups: [["url"]], returnType: "Array(String)" }]),
  { name: "lagInFrame", kind: "window", category: "window", signatures: [{ parameterGroups: [["value", "offset?", "default?"]] }] },
];
```

Continue in category-sized edits using the official 2026-07-30 documentation snapshot. Each definition must include every documented overload needed to distinguish arity or parameter groups. Cover the manifest categories declared in `functionTypes.ts`; omit a category from the manifest only when ClickHouse has no public function page for it.

- [ ] **Step 4: Add a checked-in manifest after each category batch**

Append a manifest whose counts exactly equal the checked-in arrays:

```ts
export const CLICKHOUSE_FUNCTION_CATEGORY_MANIFEST = [
  { category: "array", minimumCount: CLICKHOUSE_REGULAR_FUNCTIONS.filter((item) => item.category === "array").length },
  { category: "date-time", minimumCount: CLICKHOUSE_REGULAR_FUNCTIONS.filter((item) => item.category === "date-time").length },
  { category: "json", minimumCount: CLICKHOUSE_REGULAR_FUNCTIONS.filter((item) => item.category === "json").length },
  { category: "hash", minimumCount: CLICKHOUSE_REGULAR_FUNCTIONS.filter((item) => item.category === "hash").length },
  { category: "url", minimumCount: CLICKHOUSE_REGULAR_FUNCTIONS.filter((item) => item.category === "url").length },
  { category: "window", minimumCount: CLICKHOUSE_REGULAR_FUNCTIONS.filter((item) => item.category === "window").length },
] as const;
```

Expand this literal as each documented category is added. Do not derive the manifest at runtime; checked-in numeric literals are the reviewable deletion guard. Replace the `.length` expressions above with those final numeric literals before making the test green.

- [ ] **Step 5: Add table-function definitions**

Create `tableFunctions.ts`:

```ts
import type { ClickHouseFunctionDefinition } from "./functionTypes";

export const CLICKHOUSE_TABLE_FUNCTIONS: ClickHouseFunctionDefinition[] = [
  {
    name: "numbers",
    kind: "table",
    category: "table",
    signatures: [
      { parameterGroups: [["count"]] },
      { parameterGroups: [["offset", "count"]] },
      { parameterGroups: [["offset", "count", "step"]] },
    ],
  },
  { name: "file", kind: "table", category: "table", signatures: [{ parameterGroups: [["path", "format?", "structure?", "compression?"]] }] },
  { name: "url", kind: "table", category: "table", signatures: [{ parameterGroups: [["url", "format", "structure?", "headers?"]] }] },
  { name: "s3", kind: "table", category: "table", signatures: [{ parameterGroups: [["url", "format?", "structure?", "compression?"]] }] },
  { name: "remote", kind: "table", category: "table", signatures: [{ parameterGroups: [["addresses", "database", "table", "user?", "password?"]] }] },
  { name: "postgresql", kind: "table", category: "table", signatures: [{ parameterGroups: [["address", "database", "table", "user", "password", "schema?"]] }] },
  { name: "mysql", kind: "table", category: "table", signatures: [{ parameterGroups: [["address", "database", "table", "user", "password"]] }] },
];
```

Add all other documented public table functions from the same snapshot, retaining lowercase canonical names where ClickHouse documents them that way.

- [ ] **Step 6: Export the complete direct-function registry**

In `functionRegistry.ts`:

```ts
import { CLICKHOUSE_REGULAR_FUNCTIONS } from "./regularFunctions";
import { CLICKHOUSE_TABLE_FUNCTIONS } from "./tableFunctions";

export const CLICKHOUSE_FUNCTION_REGISTRY = createClickHouseFunctionRegistry([
  ...CLICKHOUSE_REGULAR_FUNCTIONS,
  ...CLICKHOUSE_TABLE_FUNCTIONS,
]);
```

- [ ] **Step 7: Run formatting and the focused registry tests after every category batch**

```bash
pnpm exec oxfmt apps/desktop/src/lib/sql/clickhouse/regularFunctions.ts apps/desktop/src/lib/sql/clickhouse/tableFunctions.ts
pnpm exec vitest run apps/desktop/src/lib/__tests__/sql/clickhouse/functionRegistry.spec.ts
```

Expected: all registry tests PASS and manifest counts remain literal, non-zero floors.

- [ ] **Step 8: Commit the regular and table inventories**

```bash
git add apps/desktop/src/lib/sql/clickhouse/regularFunctions.ts apps/desktop/src/lib/sql/clickhouse/tableFunctions.ts apps/desktop/src/lib/sql/clickhouse/functionRegistry.ts apps/desktop/src/lib/__tests__/sql/clickhouse/functionRegistry.spec.ts
git commit -m "feat(sql): add ClickHouse regular function inventory"
```

## Task 3: Add Aggregate Functions and Lazy Combinators

**Files:**

- Create: `apps/desktop/src/lib/sql/clickhouse/aggregateFunctions.ts`
- Create: `apps/desktop/src/lib/sql/clickhouse/aggregateCombinators.ts`
- Create: `apps/desktop/src/lib/__tests__/sql/clickhouse/aggregateCombinators.spec.ts`
- Modify: `apps/desktop/src/lib/sql/clickhouse/functionRegistry.ts`
- Modify: `apps/desktop/src/lib/__tests__/sql/clickhouse/functionRegistry.spec.ts`

- [ ] **Step 1: Write failing aggregate and combinator tests**

Create `aggregateCombinators.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateAggregateCombinatorCandidates } from "@/lib/sql/clickhouse/aggregateCombinators";
import { CLICKHOUSE_FUNCTION_REGISTRY } from "@/lib/sql/clickhouse/functionRegistry";

describe("ClickHouse aggregate combinators", () => {
  it("generates If with an appended condition argument", () => {
    const sumIf = generateAggregateCombinatorCandidates("sumIf", 20).find((item) => item.name === "sumIf");
    expect(sumIf?.signatures[0].parameterGroups).toEqual([["value", "condition"]]);
  });

  it("allows Array before If and rejects the reverse order", () => {
    expect(generateAggregateCombinatorCandidates("uniqArrayIf", 20).some((item) => item.name === "uniqArrayIf")).toBe(true);
    expect(generateAggregateCombinatorCandidates("uniqIfArray", 20).some((item) => item.name === "uniqIfArray")).toBe(false);
  });

  it("preserves parametric aggregate groups for State", () => {
    const state = generateAggregateCombinatorCandidates("quantilesTDigestState", 20).find((item) => item.name === "quantilesTDigestState");
    expect(state?.signatures[0].parameterGroups).toEqual([["level", "...levels"], ["expression"]]);
  });

  it("bounds generated results", () => {
    expect(generateAggregateCombinatorCandidates("", 7)).toHaveLength(7);
  });
});

it("contains ordinary and parametric aggregate definitions", () => {
  expect(CLICKHOUSE_FUNCTION_REGISTRY.get("uniqExact")).toMatchObject({ kind: "aggregate" });
  expect(CLICKHOUSE_FUNCTION_REGISTRY.get("quantilesTDigest")?.signatures[0].parameterGroups).toEqual([["level", "...levels"], ["expression"]]);
});
```

- [ ] **Step 2: Run both ClickHouse test files and confirm RED**

```bash
pnpm exec vitest run apps/desktop/src/lib/__tests__/sql/clickhouse/functionRegistry.spec.ts apps/desktop/src/lib/__tests__/sql/clickhouse/aggregateCombinators.spec.ts
```

Expected: FAIL because aggregate modules and generated candidates do not exist.

- [ ] **Step 3: Add the aggregate inventory**

Create `aggregateFunctions.ts` with a compact helper and explicit parameter groups:

```ts
import type { ClickHouseFunctionDefinition, ClickHouseFunctionSignature } from "./functionTypes";

const aggregate = (
  name: string,
  signatures: ClickHouseFunctionSignature[],
  options: Partial<ClickHouseFunctionDefinition> = {},
): ClickHouseFunctionDefinition => ({
  name,
  kind: "aggregate",
  category: "aggregate",
  signatures,
  combinators: true,
  ...options,
});

export const CLICKHOUSE_AGGREGATE_FUNCTIONS: ClickHouseFunctionDefinition[] = [
  aggregate("count", [{ parameterGroups: [[]] }, { parameterGroups: [["expression"]] }]),
  aggregate("sum", [{ parameterGroups: [["value"]] }]),
  aggregate("uniq", [{ parameterGroups: [["expression", "...expressions"]] }]),
  aggregate("uniqExact", [{ parameterGroups: [["expression", "...expressions"]] }]),
  aggregate("quantilesTDigest", [{ parameterGroups: [["level", "...levels"], ["expression"]] }]),
];
```

Add every documented ordinary and parametric aggregate from the snapshot. Mark aggregates that reject generic combinators with `combinators: false`; do not invent signatures for undocumented combinations.

- [ ] **Step 4: Implement ordered combinator rules**

In `aggregateCombinators.ts`, model suffix transitions rather than arbitrary permutations:

```ts
import { CLICKHOUSE_AGGREGATE_FUNCTIONS } from "./aggregateFunctions";
import type { ClickHouseFunctionDefinition, ClickHouseFunctionSignature } from "./functionTypes";

type CombinatorName = "Array" | "Map" | "ForEach" | "Distinct" | "If" | "OrDefault" | "OrNull" | "Resample" | "SimpleState" | "State" | "Merge" | "MergeState";

const ORDER: readonly CombinatorName[] = ["Array", "Map", "ForEach", "Distinct", "If", "OrDefault", "OrNull", "Resample", "SimpleState", "State", "Merge", "MergeState"];

function applyIf(signature: ClickHouseFunctionSignature): ClickHouseFunctionSignature {
  const groups = signature.parameterGroups.map((group) => [...group]);
  const target = groups.length - 1;
  groups[target] = [...groups[target], "condition"];
  return { ...signature, parameterGroups: groups };
}
```

Add one transformer per documented combinator. Enforce `Array` before `If`, make terminal state/merge combinators stop further suffix expansion where required, and reject cycles. `generateAggregateCombinatorCandidates(prefix, limit)` must traverse only prefixes that can still match the typed text and stop at `limit`.

- [ ] **Step 5: Merge direct aggregates and lazy generated results**

Add direct aggregate definitions to `CLICKHOUSE_FUNCTION_REGISTRY`. Export:

```ts
export function searchClickHouseFunctions(prefix: string, limit: number, kind?: ClickHouseFunctionKind): ClickHouseFunctionDefinition[] {
  const direct = CLICKHOUSE_FUNCTION_REGISTRY.search(prefix, limit, kind);
  if (kind && kind !== "aggregate") return direct;
  const generated = generateAggregateCombinatorCandidates(prefix, Math.max(0, limit - direct.length));
  return [...direct, ...generated].slice(0, limit);
}
```

- [ ] **Step 6: Run tests and confirm GREEN**

Run the two focused files. Expected: all registry and combinator tests PASS.

- [ ] **Step 7: Commit aggregate support**

```bash
git add apps/desktop/src/lib/sql/clickhouse/aggregateFunctions.ts apps/desktop/src/lib/sql/clickhouse/aggregateCombinators.ts apps/desktop/src/lib/sql/clickhouse/functionRegistry.ts apps/desktop/src/lib/__tests__/sql/clickhouse/functionRegistry.spec.ts apps/desktop/src/lib/__tests__/sql/clickhouse/aggregateCombinators.spec.ts
git commit -m "feat(sql): add ClickHouse aggregate combinators"
```

## Task 4: Integrate ClickHouse Functions into SQL Completion

**Files:**

- Modify: `apps/desktop/src/lib/sql/sqlCompletion.ts`
- Modify: `apps/desktop/src/lib/__tests__/sql/sqlCompletion.context.spec.ts`

- [ ] **Step 1: Add failing completion tests**

Extend `sqlCompletion.context.spec.ts`:

```ts
it("suggests ClickHouse functions with canonical casing and preferred placeholders", () => {
  const sql = "SELECT tostart";
  const items = buildSqlCompletionItems(sql, sql.length, { databaseType: "clickhouse", tables: [], columnsByTable: new Map() });
  expect(items.find((item) => item.label === "toStartOfDay")).toMatchObject({ type: "function", apply: "toStartOfDay(${value})" });
});

it("does not leak ClickHouse-only functions to MySQL", () => {
  const sql = "SELECT tostart";
  const items = buildSqlCompletionItems(sql, sql.length, { databaseType: "mysql", tables: [], columnsByTable: new Map() });
  expect(items.some((item) => item.label === "toStartOfDay")).toBe(false);
});

it("suggests only ClickHouse table functions alongside tables after FROM", () => {
  const sql = "SELECT * FROM num";
  const items = buildSqlCompletionItems(sql, sql.length, {
    databaseType: "clickhouse",
    tables: [{ name: "number_events", type: "table" }],
    columnsByTable: new Map(),
  });
  expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "numbers", type: "function" }), expect.objectContaining({ label: "number_events", type: "table" })]));
  expect(items.some((item) => item.label === "toStartOfDay")).toBe(false);
});
```

Add a cursor-before-existing-parenthesis case:

```ts
it("does not insert a duplicate opening parenthesis before an existing call", () => {
  const sql = "SELECT toStart()";
  const cursor = "SELECT toStart".length;
  const items = buildSqlCompletionItems(sql, cursor, { databaseType: "clickhouse", tables: [], columnsByTable: new Map() });
  expect(items.find((item) => item.label === "toStartOfDay")?.apply).toBe("toStartOfDay");
});
```

- [ ] **Step 2: Run the context test and confirm RED**

```bash
pnpm exec vitest run apps/desktop/src/lib/__tests__/sql/sqlCompletion.context.spec.ts
```

Expected: ClickHouse-specific labels are absent.

- [ ] **Step 3: Add cursor lookahead to completion context**

Add `openingParenAfterCursor: boolean` to `SqlCompletionContext`, populated by `/^\s*\(/.test(sql.slice(cursor))`. Preserve it in semantic-context merging.

- [ ] **Step 4: Adapt registry definitions to completion items**

Import `searchClickHouseFunctions`. Add helpers:

```ts
function formatFunctionSignatureApply(definition: ClickHouseFunctionDefinition, omitOpeningParen: boolean): string {
  if (omitOpeningParen) return definition.name;
  const signature = definition.signatures[definition.preferredSignature ?? 0];
  return (
    definition.name +
    signature.parameterGroups
      .map((group) => `(${group.filter((parameter) => !parameter.endsWith("?")).map((parameter) => `\${${parameter}}`).join(", ")})`)
      .join("")
  );
}

function clickHouseFunctionDetail(definition: ClickHouseFunctionDefinition): string {
  const status = definition.status && definition.status !== "stable" ? ` · ${definition.status}` : "";
  const overloads = definition.signatures.length > 1 ? ` · ${definition.signatures.length} overloads` : "";
  return `ClickHouse · ${definition.category}${overloads}${status}`;
}
```

In `buildFunctionSnippetItems`, use the ClickHouse registry when `databaseType === "clickhouse"`; retain the existing map path for all other database types. Set `info` to `definition.description` when present. Apply a negative boost to experimental/deprecated definitions and a smaller negative boost to generated variants.

- [ ] **Step 5: Add table-function completion only in table contexts**

Inside the `context.suggestTables` branch, append `kind === "table"` results for ClickHouse. Do not relax `exclusiveTableSuggestions` for scalar or aggregate functions.

- [ ] **Step 6: Run ClickHouse and existing database completion tests**

```bash
pnpm exec vitest run apps/desktop/src/lib/__tests__/sql/sqlCompletion.context.spec.ts apps/desktop/src/lib/__tests__/sql/sqlCompletion.snippet.spec.ts
```

Expected: ClickHouse tests PASS; existing MySQL and snippet tests remain PASS.

- [ ] **Step 7: Commit completion integration**

```bash
git add apps/desktop/src/lib/sql/sqlCompletion.ts apps/desktop/src/lib/__tests__/sql/sqlCompletion.context.spec.ts
git commit -m "feat(sql): complete ClickHouse functions"
```

## Task 5: Add Overload-Aware and Parametric Signature Resolution

**Files:**

- Modify: `apps/desktop/src/lib/sql/sqlCompletion.ts`
- Create: `apps/desktop/src/lib/__tests__/sql/sqlCompletion.signature.spec.ts`

- [ ] **Step 1: Write failing ordinary and parametric signature tests**

Create `sqlCompletion.signature.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getSqlFunctionSignatureHelp } from "@/lib/sql/sqlCompletion";

describe("ClickHouse signature help", () => {
  it("returns every overload and highlights the active ordinary parameter", () => {
    const sql = "SELECT toStartOfInterval(ts, ";
    const help = getSqlFunctionSignatureHelp(sql, sql.length, "clickhouse");
    expect(help?.name).toBe("toStartOfInterval");
    expect(help?.overloads.length).toBeGreaterThan(1);
    expect(help?.overloads[0].activeGroup).toBe(0);
    expect(help?.overloads[0].activeParameter).toBe(1);
  });

  it("resolves the second parameter group of a parametric aggregate", () => {
    const sql = "SELECT quantilesTDigest(0.5, 0.9)(value";
    const help = getSqlFunctionSignatureHelp(sql, sql.length, "clickhouse");
    expect(help?.name).toBe("quantilesTDigest");
    expect(help?.overloads[0]).toMatchObject({ activeGroup: 1, activeParameter: 0 });
    expect(help?.overloads[0].parameterGroups).toEqual([["level", "...levels"], ["expression"]]);
  });

  it("keeps MySQL signature help as one overload and one parameter group", () => {
    const sql = "SELECT DATE_ADD(created_at, ";
    const help = getSqlFunctionSignatureHelp(sql, sql.length, "mysql");
    expect(help?.overloads).toHaveLength(1);
    expect(help?.overloads[0].parameterGroups).toEqual([["date", "INTERVAL expr unit"]]);
  });
});
```

- [ ] **Step 2: Run the signature test and confirm RED**

```bash
pnpm exec vitest run apps/desktop/src/lib/__tests__/sql/sqlCompletion.signature.spec.ts
```

Expected: FAIL because the returned model has no `overloads`.

- [ ] **Step 3: Replace the public signature-help shape**

In `sqlCompletion.ts`:

```ts
export interface SqlFunctionSignatureHelpOverload {
  signature: string;
  parameterGroups: string[][];
  activeGroup: number;
  activeParameter: number;
}

export interface SqlFunctionSignatureHelp {
  name: string;
  overloads: SqlFunctionSignatureHelpOverload[];
  activeOverload: number;
}
```

- [ ] **Step 4: Resolve the owning call and active group**

Replace the flat `findActiveFunctionOpenParen` path with a helper returning:

```ts
interface ActiveFunctionCall {
  name: string;
  activeGroup: number;
  groupText: string;
}
```

For a normal unmatched `(`, read the identifier directly before it and return group `0`. If the identifier position contains `)`, find that balanced group's opening parenthesis, read the identifier before the first group, and return group `1`. Count commas with the existing quote- and nesting-aware `countTopLevelCommas`.

- [ ] **Step 5: Convert old database maps into one-overload definitions**

When the database is not ClickHouse, wrap the existing `string[]` as `parameterGroups: [parameters]`. For ClickHouse, find an exact case-insensitive match across `searchClickHouseFunctions(name, 50)`, so lazily generated combinator names and aliases resolve as well as direct registry entries. Format all parameter groups into each overload's `signature`, while using the function spelling from the SQL text as the tooltip name.

Rank overloads that can accept the observed parameter index first; keep source order as the stable tiebreaker. Set `activeOverload` to `0`.

- [ ] **Step 6: Run signature and context tests**

```bash
pnpm exec vitest run apps/desktop/src/lib/__tests__/sql/sqlCompletion.signature.spec.ts apps/desktop/src/lib/__tests__/sql/sqlCompletion.context.spec.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit signature resolution**

```bash
git add apps/desktop/src/lib/sql/sqlCompletion.ts apps/desktop/src/lib/__tests__/sql/sqlCompletion.signature.spec.ts
git commit -m "feat(sql): support ClickHouse function overloads"
```

## Task 6: Render Multiple Signatures in the Query Editor

**Files:**

- Create: `apps/desktop/src/lib/editor/sqlSignatureTooltip.ts`
- Create: `apps/desktop/src/lib/__tests__/editor/sqlSignatureTooltip.spec.ts`
- Modify: `apps/desktop/src/components/editor/QueryEditor.vue`

- [ ] **Step 1: Add a failing real-DOM tooltip test**

Create `sqlSignatureTooltip.spec.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createSqlSignatureTooltipDom } from "@/lib/editor/sqlSignatureTooltip";

describe("SQL signature tooltip", () => {
  it("renders every overload and highlights the active parameter in each one", () => {
    const dom = createSqlSignatureTooltipDom({
      name: "toStartOfInterval",
      activeOverload: 0,
      overloads: [
        {
          signature: "toStartOfInterval(value, interval)",
          parameterGroups: [["value", "interval"]],
          activeGroup: 0,
          activeParameter: 1,
        },
        {
          signature: "toStartOfInterval(value, interval, time_zone)",
          parameterGroups: [["value", "interval", "time_zone"]],
          activeGroup: 0,
          activeParameter: 1,
        },
      ],
    });

    expect(dom.textContent).toContain("1/2");
    expect(dom.textContent).toContain("2/2");
    expect(dom.textContent).toContain("time_zone");
    expect(dom.querySelectorAll("[data-active-parameter='true']")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the editor test and confirm RED**

```bash
pnpm exec vitest run apps/desktop/src/lib/__tests__/editor/sqlSignatureTooltip.spec.ts
```

Expected: FAIL because `sqlSignatureTooltip.ts` does not exist.

- [ ] **Step 3: Implement the overload-aware DOM renderer**

Create `sqlSignatureTooltip.ts`:

```ts
import type { SqlFunctionSignatureHelp } from "@/lib/sql/sqlCompletion";

export function createSqlSignatureTooltipDom(signature: SqlFunctionSignatureHelp | null): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md";
  if (!signature) return dom;

  signature.overloads.forEach((overload, overloadIndex) => {
    const row = document.createElement("div");
    row.className = overloadIndex > 0 ? "mt-1 flex items-center gap-2 font-mono" : "flex items-center gap-2 font-mono";
    if (signature.overloads.length > 1) {
      const count = document.createElement("span");
      count.className = "text-[10px] text-muted-foreground";
      count.textContent = `${overloadIndex + 1}/${signature.overloads.length}`;
      row.appendChild(count);
    }

    const call = document.createElement("span");
    const name = document.createElement("span");
    name.className = "text-muted-foreground";
    name.textContent = signature.name;
    call.appendChild(name);

    overload.parameterGroups.forEach((group, groupIndex) => {
      const open = document.createElement("span");
      open.className = "text-muted-foreground";
      open.textContent = "(";
      call.appendChild(open);
      group.forEach((parameter, parameterIndex) => {
        if (parameterIndex > 0) call.append(", ");
        const node = document.createElement("span");
        const active = groupIndex === overload.activeGroup && parameterIndex === overload.activeParameter;
        node.className = active ? "font-semibold text-foreground" : "text-muted-foreground";
        if (active) node.dataset.activeParameter = "true";
        node.textContent = parameter;
        call.appendChild(node);
      });
      call.append(")");
    });

    row.appendChild(call);
    dom.appendChild(row);
  });
  return dom;
}
```

- [ ] **Step 4: Wire the renderer into QueryEditor**

Import `createSqlSignatureTooltipDom`, delete the local `createSignatureDom`, and change the signature extension to:

```ts
create: () => ({ dom: createSqlSignatureTooltipDom(signature) }),
```

- [ ] **Step 5: Run editor, signature, and context tests**

```bash
pnpm exec vitest run apps/desktop/src/lib/__tests__/editor/sqlSignatureTooltip.spec.ts apps/desktop/src/lib/__tests__/editor/queryEditorSqlSignature.spec.ts apps/desktop/src/lib/__tests__/sql/sqlCompletion.signature.spec.ts apps/desktop/src/lib/__tests__/sql/sqlCompletion.context.spec.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit tooltip rendering**

```bash
git add apps/desktop/src/lib/editor/sqlSignatureTooltip.ts apps/desktop/src/lib/__tests__/editor/sqlSignatureTooltip.spec.ts apps/desktop/src/components/editor/QueryEditor.vue
git commit -m "feat(editor): render SQL function overloads"
```

## Task 7: Audit Coverage and Run Full Verification

**Files:**

- Modify only if verification finds an issue: files from Tasks 1–6.

- [ ] **Step 1: Run registry integrity and review category floors**

```bash
pnpm exec vitest run apps/desktop/src/lib/__tests__/sql/clickhouse/functionRegistry.spec.ts apps/desktop/src/lib/__tests__/sql/clickhouse/aggregateCombinators.spec.ts
```

Expected: all tests PASS; every checked-in category floor equals its reviewed inventory count.

- [ ] **Step 2: Run the complete SQL completion test set**

```bash
pnpm exec vitest run apps/desktop/src/lib/__tests__/sql/sqlCompletion.context.spec.ts apps/desktop/src/lib/__tests__/sql/sqlCompletion.snippet.spec.ts apps/desktop/src/lib/__tests__/sql/sqlCompletion.signature.spec.ts apps/desktop/src/lib/__tests__/sql/semantic/completion.spec.ts apps/desktop/src/lib/__tests__/editor/sqlSignatureTooltip.spec.ts apps/desktop/src/lib/__tests__/editor/queryEditorSqlSignature.spec.ts
```

Expected: all tests PASS with zero failures.

- [ ] **Step 3: Run TypeScript checking**

```bash
pnpm typecheck
```

Expected: exit code 0 with no Vue or TypeScript errors.

- [ ] **Step 4: Run lint on every changed TypeScript and Vue file**

```bash
pnpm exec oxlint --vue-plugin \
  apps/desktop/src/lib/sql/clickhouse \
  apps/desktop/src/lib/sql/sqlCompletion.ts \
  apps/desktop/src/lib/editor/sqlSignatureTooltip.ts \
  apps/desktop/src/components/editor/QueryEditor.vue \
  apps/desktop/src/lib/__tests__/sql/clickhouse \
  apps/desktop/src/lib/__tests__/sql/sqlCompletion.context.spec.ts \
  apps/desktop/src/lib/__tests__/sql/sqlCompletion.signature.spec.ts \
  apps/desktop/src/lib/__tests__/editor/sqlSignatureTooltip.spec.ts \
  apps/desktop/src/lib/__tests__/editor/queryEditorSqlSignature.spec.ts
```

Expected: exit code 0 with no lint errors.

- [ ] **Step 5: Inspect the final diff against the approved design**

```bash
git diff --check
git status --short
git log --oneline -7
```

Confirm that:

- no backend or server metadata query was added;
- ClickHouse names retain canonical casing;
- regular, aggregate, window, and table functions are represented;
- overloads and multiple parameter groups are tested;
- invalid combinator order is rejected;
- non-ClickHouse regression tests pass;
- only the planned files changed.

- [ ] **Step 6: Commit any verification-only corrections**

If Step 1–5 required a correction, stage only the corrected planned files and commit:

```bash
git commit -m "fix(sql): complete ClickHouse function verification"
```

If no correction was required, do not create an empty commit.
