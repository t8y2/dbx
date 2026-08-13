# Database Documentation Part 3a: Docs Viewer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the dbdocs-style documentation viewer as a standalone Vue app that renders a `SchemaSnapshot` and makes **zero backend calls** — the contract that later lets the same components run inside DBX and inside an exported HTML file.

**Architecture:** All decision-making logic lives in pure `.ts` modules under `apps/desktop/src/docs/` with thorough vitest coverage. The `.vue` files are thin templates verified by static SFC parsing, matching this repo's established `erDiagram.ts` (tested) / `SchemaDiagramDialog.vue` (untested) split. TypeScript interfaces mirror the Rust `SchemaSnapshot`; a committed fixture generated from **real Rust output** plus a conformance test turns model drift into a failing test rather than a silent bug.

**Tech Stack:** Vue 3 + TypeScript + Tailwind v4, vitest. No new dependencies.

**Branch:** continue on `feature/docs-snapshot-dbml` (Parts 1+2, 31 commits, unmerged). Worktree at `/Users/possebon/workspaces/dbx.feature-docs-snapshot-dbml`.

**Spec:** `docs/superpowers/specs/2026-08-02-database-documentation-dbml-design.md`, Section 6.

**Approved visual reference:** the mock at the group/table/diagram level — sidebar with `Group by: Schemas | Table Groups`, wiki index with inline markdown notes, table page with columns/indexes/bidirectional relationships, `⬤ LOCAL` shadow marker, warning banner.

## Global Constraints

- **NO new dependencies.** In particular **do NOT add `@vue/test-utils`** — this repo has never mounted a component in a test and deliberately has no such harness.
- **`cargo` is NOT on PATH.** Prefix Rust commands with
  `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`.
- **`apps/desktop/src/docs/` makes NO backend calls.** No `@/lib/backend/*`, no Tauri, no Pinia stores, no `fetch`. Snapshot in, DOM out. A test enforces this.
- **Logic in `.ts`, templates thin.** If a `.vue` file contains a non-trivial decision (filtering, sorting, formatting, colour maths), that decision belongs in a `.ts` module with a test.
- **Group colour is a hue integer.** Lightness/chroma are theme-controlled in CSS; never store or compute hex in the viewer.
- Run `pnpm lint` scoped to the touched directory, never repo-wide (root `pnpm lint` OOMs on this repo).
- Conventional Commits.
- **Report mismatches, do not work around them.** Twenty plan defects across Parts 1-2 were caught that way.

---

## Pre-resolved facts (verified — these override any assumption in the spec)

1. **The spec's testing plan does not work here.** Section 6 says "every docs component rendered against fixture snapshot JSON". This repo has **no component-mount harness**: `@vue/test-utils` is not a dependency and zero specs call `mount()`. `packages/app-tests/aiAssistantSendGuard.test.ts:13` documents this in a comment. The established pattern for verifying a `.vue` file is **static SFC parsing** via `readFileSync` + `vue/compiler-sfc`'s `parse`.

2. **No Rust→TypeScript codegen exists.** `apps/desktop/src/types/database.ts` is a hand-maintained 1167-line mirror. Part 3a therefore hand-writes TS interfaces for `SchemaSnapshot` — a genuine drift seam. Task 2's conformance test is the mitigation.

3. **vitest config** (`vitest.config.ts`): `@vitejs/plugin-vue` loaded; alias `@` → `apps/desktop/src`; `include` covers `apps/desktop/src/**/*.spec.ts`; `maxWorkers: 4`; `globalSetup: packages/test-globals.ts`. **No `environment:` is set**, so there is no DOM — another reason component mounting is out of scope.

4. **`node_modules` does not exist** in this worktree or the main checkout. `pnpm install` is Task 0.

5. **Rust field names arrive as camelCase.** `SchemaSnapshot` and friends use `#[serde(rename_all = "camelCase")]`, so the JSON has `formatVersion`, `noteSource`, `shadowedNote`, `columnNotes`, `groupId`, `estimatedRows`, `viewDefinition`.

6. **`SnapshotWarning` is the exception.** It uses `#[serde(rename_all = "camelCase", tag = "kind")]`, so its discriminant is `{ "kind": "tableSkipped", ... }` — **camelCase**, unlike `TableKind`/`NoteSource`/`Cardinality` which are SCREAMING_SNAKE (`"MATERIALIZED_VIEW"`, `"LOCAL"`, `"MANY_TO_ONE"`). Getting this wrong silently breaks warning rendering.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/desktop/src/docs/types.ts` | TS interfaces mirroring the Rust `SchemaSnapshot` |
| `apps/desktop/src/docs/fixtures/keycloak.snapshot.json` | Real snapshot from a live database, committed |
| `apps/desktop/src/docs/docsIndex.ts` | Sidebar/index model: schema grouping, table-group grouping, `(no group)` bucket |
| `apps/desktop/src/docs/docsSearch.ts` | Client-side search over tables, columns, groups, enums |
| `apps/desktop/src/docs/docsWarnings.ts` | `SnapshotWarning` → human-readable banner text |
| `apps/desktop/src/docs/groupColor.ts` | Hue → CSS custom properties (never hex) |
| `apps/desktop/src/docs/DocsApp.vue` + `components/*.vue` | Thin templates |
| `apps/desktop/src/docs/__tests__/*.spec.ts` | vitest coverage for every `.ts` module + SFC guards |

---

## Task 0: Environment setup

- [ ] **Step 1: Install dependencies**

There is no `node_modules` in this worktree. From the worktree root:

```bash
cd /Users/possebon/workspaces/dbx.feature-docs-snapshot-dbml
pnpm install
```

This takes several minutes and downloads 1-3GB. **Disk is at ~45Gi free — if you hit ENOSPC, STOP and report it; do not delete anything.**

- [ ] **Step 2: Confirm the baseline**

```bash
pnpm vitest run apps/desktop/src/lib/__tests__ --reporter=dot
git branch --show-current   # must be feature/docs-snapshot-dbml
git status --short          # must be empty apart from node_modules being ignored
```

Expected: tests pass, branch correct. If `pnpm install` fails or tests fail before you have changed anything, STOP and report — Part 3a builds on Parts 1-2 and a broken baseline makes every later failure ambiguous.

---

## Task 1: Snapshot types

**Files:**
- Create: `apps/desktop/src/docs/types.ts`
- Test: `apps/desktop/src/docs/__tests__/types.spec.ts`

**Interfaces:**
- Produces: `SchemaSnapshot`, `ProjectMeta`, `DocTable`, `TableGroup`, `Relationship`, `FieldRef`, `ColumnNote`, `DocEnum`, `TableKind`, `NoteSource`, `Cardinality`, `SnapshotWarning`

**Casing is load-bearing.** Struct fields are camelCase; `TableKind`/`NoteSource`/`Cardinality` are SCREAMING_SNAKE strings; `SnapshotWarning` is internally tagged with a **camelCase** `kind`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { SchemaSnapshot, SnapshotWarning } from "../types";

describe("snapshot types", () => {
  it("accepts a minimal snapshot shaped like the Rust output", () => {
    const snapshot: SchemaSnapshot = {
      formatVersion: 1,
      project: {
        name: "Ecommerce",
        databaseType: "postgres",
        database: "shop",
        schemas: ["public"],
        generatedAt: "2026-08-03T00:00:00Z",
        note: null,
      },
      tables: [
        {
          schema: "public",
          name: "orders",
          kind: "TABLE",
          columns: [],
          indexes: [],
          foreignKeys: [],
          groupId: null,
          note: "Checkout rows.",
          noteSource: "DATABASE",
          shadowedNote: null,
          columnNotes: {},
          estimatedRows: null,
          viewDefinition: null,
        },
      ],
      relationships: [],
      groups: [],
      enums: [],
      warnings: [],
    };

    expect(snapshot.tables[0].noteSource).toBe("DATABASE");
    expect(snapshot.tables[0].kind).toBe("TABLE");
  });

  it("discriminates warnings on a camelCase kind", () => {
    // Rust: #[serde(rename_all = "camelCase", tag = "kind")] — so the
    // discriminant is camelCase even though sibling enums are SCREAMING_SNAKE.
    const warning: SnapshotWarning = {
      kind: "tableSkipped",
      table: "public.secret",
      reason: "permission denied",
    };
    expect(warning.kind).toBe("tableSkipped");

    const orphans: SnapshotWarning = { kind: "orphanedNotes", count: 3 };
    if (orphans.kind === "orphanedNotes") {
      expect(orphans.count).toBe(3);
    } else {
      throw new Error("discriminated union must narrow on kind");
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/types.spec.ts
```
Expected: FAIL — cannot resolve `../types`.

- [ ] **Step 3: Write the types**

Create `apps/desktop/src/docs/types.ts`:

```ts
// Mirrors crates/dbx-core/src/docs/snapshot.rs. There is no Rust->TS codegen
// in this repo, so this file is maintained by hand — see
// __tests__/fixtureConformance.spec.ts, which validates it against a snapshot
// generated by the real Rust code and fails if the two drift apart.

export type TableKind = "TABLE" | "VIEW" | "MATERIALIZED_VIEW";
export type NoteSource = "DATABASE" | "LOCAL" | "NONE";
export type Cardinality = "ONE_TO_ONE" | "MANY_TO_ONE";

export interface ColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  is_primary_key: boolean;
  extra: string | null;
  comment?: string | null;
  numeric_precision?: number | null;
  numeric_scale?: number | null;
  character_maximum_length?: number | null;
  enum_values?: string[] | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  is_unique: boolean;
  is_primary: boolean;
  filter?: string | null;
  index_type?: string | null;
  included_columns?: string[] | null;
  comment?: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  column: string;
  ref_schema?: string | null;
  ref_table: string;
  ref_column: string;
  on_update?: string | null;
  on_delete?: string | null;
}

export interface ProjectMeta {
  name: string;
  databaseType: string;
  database: string | null;
  schemas: string[];
  generatedAt: string;
  note: string | null;
}

export interface ColumnNote {
  note: string;
  source: NoteSource;
  shadowed: string | null;
}

export interface DocTable {
  schema: string | null;
  name: string;
  kind: TableKind;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  groupId: string | null;
  note: string | null;
  noteSource: NoteSource;
  shadowedNote: string | null;
  columnNotes: Record<string, ColumnNote>;
  estimatedRows: number | null;
  viewDefinition: string | null;
}

export interface TableGroup {
  id: string;
  name: string;
  /** 0-359. Lightness and chroma are theme-controlled in CSS. */
  hue: number;
  note: string | null;
}

export interface FieldRef {
  schema: string | null;
  table: string;
  column: string;
}

export interface Relationship {
  id: string;
  name: string | null;
  from: FieldRef;
  to: FieldRef;
  cardinality: Cardinality;
  onUpdate: string | null;
  onDelete: string | null;
}

export interface DocEnum {
  schema: string | null;
  name: string;
  values: string[];
  note: string | null;
  synthesized: boolean;
}

/**
 * Internally tagged on a camelCase `kind`. Note this differs from
 * TableKind/NoteSource/Cardinality, which are SCREAMING_SNAKE — the Rust enum
 * carries both `tag = "kind"` and `rename_all = "camelCase"`.
 */
export type SnapshotWarning =
  | { kind: "tableSkipped"; table: string; reason: string }
  | { kind: "noForeignKeyMetadata"; engine: string }
  | { kind: "commentsUnsupported"; engine: string }
  | { kind: "orphanedNotes"; count: number }
  | { kind: "dbmlOmitted"; table: string; item: string; reason: string };

export interface SchemaSnapshot {
  formatVersion: number;
  project: ProjectMeta;
  tables: DocTable[];
  relationships: Relationship[];
  groups: TableGroup[];
  enums: DocEnum[];
  warnings: SnapshotWarning[];
}
```

Note `ColumnInfo`/`IndexInfo`/`ForeignKeyInfo` keep **snake_case** field names: those Rust structs come from `crate::types` and do NOT carry `rename_all`. Task 2's conformance test will confirm this against real output — if it disagrees, fix this file, not the test.

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/types.spec.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec oxlint --vue-plugin apps/desktop/src/docs
git add apps/desktop/src/docs/
git commit -m "feat(docs): add snapshot types for the docs viewer"
```

---

## Task 2: Real fixture + drift guard

**Files:**
- Create: `apps/desktop/src/docs/fixtures/keycloak.snapshot.json` (generated, committed)
- Create: `apps/desktop/src/docs/__tests__/fixtureConformance.spec.ts`
- Create: `crates/dbx-core/tests/dump_docs_fixture.rs`

**This is the task that closes the drift seam.** The fixture must come from the real Rust serializer, not be hand-written — a hand-written fixture would encode the same assumptions as `types.ts` and prove nothing.

**A live PostgreSQL is available:** `127.0.0.1:5432`, `postgres`/`postgres`, database `keycloak` (90 tables).

- [ ] **Step 1: Write the Rust dumper**

Create `crates/dbx-core/tests/dump_docs_fixture.rs`, copying the gating and setup from `crates/dbx-core/tests/live_postgres_docs_annotations.rs` (`#[tokio::test]`, `#[ignore = "..."]`, env vars with defaults, the `live_postgres_config(...)` builder). It must collect a snapshot of schema `public` from `keycloak`, apply a small in-memory `AnnotationFile` so that notes, a group and an orphan all appear, then write `serde_json::to_string_pretty(&snapshot)` to the path given by `DBX_FIXTURE_OUT`, defaulting to `apps/desktop/src/docs/fixtures/keycloak.snapshot.json` relative to the repo root.

Include annotations covering every field the viewer must render: a table note, a column note, a group with a hue, and an annotation for a nonexistent table so an `orphanedNotes` warning is present.

- [ ] **Step 2: Generate the fixture**

```bash
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
DBX_LIVE_POSTGRES_HOST=127.0.0.1 DBX_LIVE_POSTGRES_PORT=5432 \
DBX_LIVE_POSTGRES_USER=postgres DBX_LIVE_POSTGRES_PASSWORD=postgres \
DBX_LIVE_POSTGRES_DATABASE=keycloak \
cargo test -p dbx-core --test dump_docs_fixture -- --ignored --nocapture
```

Then confirm the file exists and contains real data:

```bash
head -30 apps/desktop/src/docs/fixtures/keycloak.snapshot.json
grep -c '"name"' apps/desktop/src/docs/fixtures/keycloak.snapshot.json
```

**Report the file size.** If it exceeds ~500KB, trim to the first 12 tables inside the dumper (keeping the annotated table, the group and the orphan warning) rather than committing a huge fixture.

- [ ] **Step 3: Write the conformance test**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SchemaSnapshot } from "../types";

const fixturePath = path.resolve(__dirname, "../fixtures/keycloak.snapshot.json");

function loadFixture(): SchemaSnapshot {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as SchemaSnapshot;
}

describe("fixture conformance", () => {
  // This fixture is generated by the REAL Rust serializer. Its job is to fail
  // when the Rust model changes shape, so the hand-maintained types.ts cannot
  // drift silently.

  it("has the shape types.ts declares", () => {
    const snapshot = loadFixture();
    expect(snapshot.formatVersion).toBe(1);
    expect(Array.isArray(snapshot.tables)).toBe(true);
    expect(snapshot.tables.length).toBeGreaterThan(0);
    expect(typeof snapshot.project.databaseType).toBe("string");
    expect(Array.isArray(snapshot.project.schemas)).toBe(true);
  });

  it("uses camelCase for snapshot-owned fields", () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
    expect(raw).toHaveProperty("formatVersion");
    expect(raw).not.toHaveProperty("format_version");

    const table = (raw.tables as Record<string, unknown>[])[0];
    expect(table).toHaveProperty("noteSource");
    expect(table).toHaveProperty("columnNotes");
    expect(table).toHaveProperty("foreignKeys");
    expect(table).not.toHaveProperty("note_source");
  });

  it("keeps snake_case on columns, which come from crate::types", () => {
    const snapshot = loadFixture();
    const withColumns = snapshot.tables.find((table) => table.columns.length > 0);
    expect(withColumns, "fixture must contain at least one table with columns").toBeDefined();
    const column = withColumns!.columns[0] as unknown as Record<string, unknown>;
    expect(column).toHaveProperty("data_type");
    expect(column).toHaveProperty("is_nullable");
    expect(column).not.toHaveProperty("dataType");
  });

  it("carries an annotated note, a group and an orphan warning", () => {
    const snapshot = loadFixture();

    const annotated = snapshot.tables.find((table) => table.noteSource === "LOCAL");
    expect(annotated, "fixture must include a LOCAL-sourced note").toBeDefined();
    expect(annotated!.note).toBeTruthy();

    expect(snapshot.groups.length).toBeGreaterThan(0);
    expect(typeof snapshot.groups[0].hue).toBe("number");

    const orphan = snapshot.warnings.find((warning) => warning.kind === "orphanedNotes");
    expect(orphan, "fixture must include an orphanedNotes warning").toBeDefined();
  });

  it("every warning discriminant is one types.ts knows", () => {
    const known = new Set([
      "tableSkipped",
      "noForeignKeyMetadata",
      "commentsUnsupported",
      "orphanedNotes",
      "dbmlOmitted",
    ]);
    for (const warning of loadFixture().warnings) {
      expect(known.has(warning.kind), `unknown warning kind: ${warning.kind}`).toBe(true);
    }
  });
});
```

- [ ] **Step 4: Run it**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/fixtureConformance.spec.ts
```
Expected: PASS, 5 tests.

**If any assertion fails, the fixture is telling you `types.ts` is wrong — fix `types.ts`, not the test.** Report exactly which field disagreed; that is a real Rust/TS mismatch and I want to know about it.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/docs/ crates/dbx-core/tests/dump_docs_fixture.rs
git commit -m "feat(docs): add a real-output fixture and drift conformance test"
```

---

## Task 3: Index model (grouping)

**Files:**
- Create: `apps/desktop/src/docs/docsIndex.ts`
- Test: `apps/desktop/src/docs/__tests__/docsIndex.spec.ts`

**Interfaces:**
- Produces: `groupBySchema(snapshot): IndexSection[]`, `groupByTableGroup(snapshot): IndexSection[]`, `interface IndexSection { key: string; label: string; hue: number | null; note: string | null; tables: DocTable[] }`

This is the `Group by: Schemas | Table Groups` switch from the approved mock, including the `(no group)` bucket.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { groupBySchema, groupByTableGroup } from "../docsIndex";
import type { DocTable, SchemaSnapshot, TableGroup } from "../types";

function table(schema: string | null, name: string, groupId: string | null = null): DocTable {
  return {
    schema, name, kind: "TABLE", columns: [], indexes: [], foreignKeys: [],
    groupId, note: null, noteSource: "NONE", shadowedNote: null,
    columnNotes: {}, estimatedRows: null, viewDefinition: null,
  };
}

function snapshot(tables: DocTable[], groups: TableGroup[] = []): SchemaSnapshot {
  return {
    formatVersion: 1,
    project: { name: "p", databaseType: "postgres", database: null, schemas: [], generatedAt: "", note: null },
    tables, relationships: [], groups, enums: [], warnings: [],
  };
}

describe("groupBySchema", () => {
  it("groups tables under their schema, sorted by schema then name", () => {
    const sections = groupBySchema(snapshot([
      table("public", "orders"),
      table("analytics", "daily_sales"),
      table("public", "customers"),
    ]));

    expect(sections.map((section) => section.key)).toEqual(["analytics", "public"]);
    expect(sections[1].tables.map((t) => t.name)).toEqual(["customers", "orders"]);
  });

  it("puts schema-less tables in a single bare section", () => {
    const sections = groupBySchema(snapshot([table(null, "orders")]));
    expect(sections).toHaveLength(1);
    expect(sections[0].tables[0].name).toBe("orders");
  });
});

describe("groupByTableGroup", () => {
  const groups: TableGroup[] = [
    { id: "order-mgmt", name: "Order Management", hue: 28, note: "Checkout." },
    { id: "product-mgmt", name: "Product Management", hue: 148, note: null },
  ];

  it("groups tables by their group, preserving the snapshot's group order", () => {
    const sections = groupByTableGroup(snapshot([
      table("product", "products", "product-mgmt"),
      table("core", "orders", "order-mgmt"),
    ], groups));

    expect(sections.map((section) => section.key)).toEqual(["order-mgmt", "product-mgmt"]);
    expect(sections[0].label).toBe("Order Management");
    expect(sections[0].hue).toBe(28);
    expect(sections[0].note).toBe("Checkout.");
  });

  it("collects ungrouped tables into a trailing (no group) section", () => {
    const sections = groupByTableGroup(snapshot([
      table("core", "orders", "order-mgmt"),
      table("core", "users", null),
    ], groups));

    const last = sections[sections.length - 1];
    expect(last.key).toBe("");
    expect(last.hue).toBeNull();
    expect(last.tables.map((t) => t.name)).toEqual(["users"]);
  });

  it("omits a group that has no members", () => {
    // render_group in the serializer skips empty groups; the viewer must not
    // show an empty header where the DBML shows nothing.
    const sections = groupByTableGroup(snapshot([table("core", "orders", "order-mgmt")], groups));
    expect(sections.map((section) => section.key)).not.toContain("product-mgmt");
  });

  it("treats a table whose groupId names no group as ungrouped", () => {
    const sections = groupByTableGroup(snapshot([table("core", "orders", "ghost")], groups));
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe("");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/docsIndex.spec.ts
```
Expected: FAIL — cannot resolve `../docsIndex`.

- [ ] **Step 3: Implement**

```ts
import type { DocTable, SchemaSnapshot } from "./types";

export interface IndexSection {
  /** Schema name, group id, or "" for the ungrouped bucket. */
  key: string;
  label: string;
  /** Group hue, or null for schema sections and the ungrouped bucket. */
  hue: number | null;
  note: string | null;
  tables: DocTable[];
}

function byName(a: DocTable, b: DocTable): number {
  return a.name.localeCompare(b.name);
}

export function groupBySchema(snapshot: SchemaSnapshot): IndexSection[] {
  const sections = new Map<string, DocTable[]>();
  for (const table of snapshot.tables) {
    const key = table.schema ?? "";
    const bucket = sections.get(key);
    if (bucket) {
      bucket.push(table);
    } else {
      sections.set(key, [table]);
    }
  }

  return [...sections.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, tables]) => ({
      key,
      label: key,
      hue: null,
      note: null,
      tables: [...tables].sort(byName),
    }));
}

export function groupByTableGroup(snapshot: SchemaSnapshot): IndexSection[] {
  const known = new Map(snapshot.groups.map((group) => [group.id, group]));
  const sections: IndexSection[] = [];

  // Snapshot order is the notes file's order — the user's own arrangement.
  for (const group of snapshot.groups) {
    const tables = snapshot.tables.filter((table) => table.groupId === group.id).sort(byName);
    // An empty group renders nothing, matching render_group in the serializer.
    if (tables.length === 0) {
      continue;
    }
    sections.push({
      key: group.id,
      label: group.name,
      hue: group.hue,
      note: group.note,
      tables,
    });
  }

  // A groupId naming no known group is treated as ungrouped rather than
  // creating a phantom section.
  const ungrouped = snapshot.tables
    .filter((table) => table.groupId === null || !known.has(table.groupId))
    .sort(byName);

  if (ungrouped.length > 0) {
    sections.push({ key: "", label: "(no group)", hue: null, note: null, tables: ungrouped });
  }

  return sections;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/docsIndex.spec.ts
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec oxlint --vue-plugin apps/desktop/src/docs
git add apps/desktop/src/docs/
git commit -m "feat(docs): add index grouping for the docs viewer"
```

---

## Task 4: Warning presentation

**Files:**
- Create: `apps/desktop/src/docs/docsWarnings.ts`
- Test: `apps/desktop/src/docs/__tests__/docsWarnings.spec.ts`

**Interfaces:**
- Produces: `describeWarning(warning: SnapshotWarning): WarningNotice`, `interface WarningNotice { severity: "info" | "warning"; title: string; detail: string }`

**Why this matters:** the feature's stated principle is "degrade visibly, never silently". These strings are how degradation becomes visible. A warning rendered as `[object Object]` — which is what happens if the camelCase discriminant is mismatched — defeats the whole mechanism.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { describeWarning } from "../docsWarnings";
import type { SnapshotWarning } from "../types";

describe("describeWarning", () => {
  it("explains a skipped table as a warning naming the table and reason", () => {
    const notice = describeWarning({ kind: "tableSkipped", table: "public.secret", reason: "permission denied" });
    expect(notice.severity).toBe("warning");
    expect(notice.detail).toContain("public.secret");
    expect(notice.detail).toContain("permission denied");
  });

  it("explains missing foreign-key metadata as an engine limitation, not a fault", () => {
    const notice = describeWarning({ kind: "noForeignKeyMetadata", engine: "ClickHouse" });
    expect(notice.detail).toContain("ClickHouse");
    // The diagram will have no edges — the user must learn why.
    expect(notice.detail.toLowerCase()).toContain("relationship");
  });

  it("explains unsupported comments", () => {
    const notice = describeWarning({ kind: "commentsUnsupported", engine: "SQLite" });
    expect(notice.detail).toContain("SQLite");
  });

  it("reports orphaned notes with the count", () => {
    const notice = describeWarning({ kind: "orphanedNotes", count: 3 });
    expect(notice.detail).toContain("3");
  });

  it("explains a DBML omission naming the item", () => {
    const notice = describeWarning({
      kind: "dbmlOmitted",
      table: "public.orders",
      item: "idx_orders_open",
      reason: "partial index filter has no DBML equivalent",
    });
    expect(notice.severity).toBe("info");
    expect(notice.detail).toContain("idx_orders_open");
  });

  it("never returns an empty or placeholder string for any known kind", () => {
    const samples: SnapshotWarning[] = [
      { kind: "tableSkipped", table: "t", reason: "r" },
      { kind: "noForeignKeyMetadata", engine: "e" },
      { kind: "commentsUnsupported", engine: "e" },
      { kind: "orphanedNotes", count: 1 },
      { kind: "dbmlOmitted", table: "t", item: "i", reason: "r" },
    ];
    for (const sample of samples) {
      const notice = describeWarning(sample);
      expect(notice.title.length, `empty title for ${sample.kind}`).toBeGreaterThan(0);
      expect(notice.detail.length, `empty detail for ${sample.kind}`).toBeGreaterThan(0);
      expect(notice.detail).not.toContain("[object Object]");
      expect(notice.detail).not.toContain("undefined");
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/docsWarnings.spec.ts
```
Expected: FAIL — cannot resolve `../docsWarnings`.

- [ ] **Step 3: Implement**

```ts
import type { SnapshotWarning } from "./types";

export interface WarningNotice {
  severity: "info" | "warning";
  title: string;
  detail: string;
}

/**
 * Turn a snapshot warning into something a reader can act on.
 *
 * This is where "degrade visibly, never silently" becomes literal: if a table
 * could not be read, or an engine cannot report relationships, the reader has
 * to learn that from the page rather than infer it from an absence.
 */
export function describeWarning(warning: SnapshotWarning): WarningNotice {
  switch (warning.kind) {
    case "tableSkipped":
      return {
        severity: "warning",
        title: "A table could not be documented",
        detail: `${warning.table} was skipped: ${warning.reason}. It is missing from this documentation.`,
      };
    case "noForeignKeyMetadata":
      return {
        severity: "info",
        title: "No relationships available",
        detail: `${warning.engine} does not report foreign key metadata, so no relationship edges could be derived. The diagram is complete for this engine.`,
      };
    case "commentsUnsupported":
      return {
        severity: "info",
        title: "Database comments unavailable",
        detail: `${warning.engine} does not support table or column comments, so every description here comes from this project's own notes.`,
      };
    case "orphanedNotes":
      return {
        severity: "warning",
        title: "Some notes no longer match anything",
        detail: `${warning.count} note(s) refer to a table or column that no longer exists. Nothing was deleted — re-map or remove them in the notes file.`,
      };
    case "dbmlOmitted":
      return {
        severity: "info",
        title: "Not representable in DBML",
        detail: `${warning.item} on ${warning.table} is documented here but omitted from the exported DBML: ${warning.reason}.`,
      };
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/docsWarnings.spec.ts
```
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec oxlint --vue-plugin apps/desktop/src/docs
git add apps/desktop/src/docs/
git commit -m "feat(docs): describe snapshot warnings for the viewer"
```

---

## Task 5: Search

**Files:**
- Create: `apps/desktop/src/docs/docsSearch.ts`
- Test: `apps/desktop/src/docs/__tests__/docsSearch.spec.ts`

**Interfaces:**
- Produces: `searchDocs(snapshot, query): SearchHit[]`, `interface SearchHit { kind: "table" | "column" | "group" | "enum"; label: string; context: string; tableKey: string | null }`

This is the ⌘K palette from the approved mock.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { searchDocs } from "../docsSearch";
import type { DocTable, SchemaSnapshot } from "../types";

function column(name: string) {
  return {
    name, data_type: "text", is_nullable: true, column_default: null,
    is_primary_key: false, extra: null,
  };
}

function table(schema: string, name: string, columns: string[] = []): DocTable {
  return {
    schema, name, kind: "TABLE", columns: columns.map(column), indexes: [], foreignKeys: [],
    groupId: null, note: null, noteSource: "NONE", shadowedNote: null,
    columnNotes: {}, estimatedRows: null, viewDefinition: null,
  };
}

const snapshot: SchemaSnapshot = {
  formatVersion: 1,
  project: { name: "p", databaseType: "postgres", database: null, schemas: [], generatedAt: "", note: null },
  tables: [table("public", "orders", ["status", "total"]), table("public", "customers", ["status"])],
  relationships: [],
  groups: [{ id: "g1", name: "Order Management", hue: 28, note: null }],
  enums: [{ schema: "public", name: "order_status", values: ["pending"], note: null, synthesized: false }],
  warnings: [],
};

describe("searchDocs", () => {
  it("returns nothing for an empty query", () => {
    expect(searchDocs(snapshot, "")).toEqual([]);
    expect(searchDocs(snapshot, "   ")).toEqual([]);
  });

  it("matches table names case-insensitively", () => {
    const hits = searchDocs(snapshot, "ORD");
    expect(hits.some((hit) => hit.kind === "table" && hit.label === "orders")).toBe(true);
  });

  it("matches columns and reports which table they belong to", () => {
    const hits = searchDocs(snapshot, "total");
    const hit = hits.find((candidate) => candidate.kind === "column");
    expect(hit).toBeDefined();
    expect(hit!.label).toBe("total");
    expect(hit!.context).toContain("orders");
  });

  it("returns one hit per table for a column name shared by several tables", () => {
    const hits = searchDocs(snapshot, "status").filter((hit) => hit.kind === "column");
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.context).sort()).toEqual(["public.customers", "public.orders"]);
  });

  it("matches groups and enums", () => {
    expect(searchDocs(snapshot, "Order Man").some((hit) => hit.kind === "group")).toBe(true);
    expect(searchDocs(snapshot, "order_status").some((hit) => hit.kind === "enum")).toBe(true);
  });

  it("ranks table matches above column matches for the same term", () => {
    // Someone typing "orders" almost always wants the table.
    const hits = searchDocs(snapshot, "orders");
    expect(hits[0].kind).toBe("table");
  });

  it("carries a tableKey so a hit can navigate", () => {
    const hit = searchDocs(snapshot, "total").find((candidate) => candidate.kind === "column");
    expect(hit!.tableKey).toBe("public.orders");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/docsSearch.spec.ts
```
Expected: FAIL — cannot resolve `../docsSearch`.

- [ ] **Step 3: Implement**

```ts
import type { SchemaSnapshot } from "./types";

export interface SearchHit {
  kind: "table" | "column" | "group" | "enum";
  label: string;
  /** Where the hit lives — a qualified table name, or a count for groups. */
  context: string;
  /** Qualified table name for navigation, or null for groups and enums. */
  tableKey: string | null;
}

function qualified(schema: string | null, name: string): string {
  return schema ? `${schema}.${name}` : name;
}

/**
 * Case-insensitive substring search over the whole snapshot.
 *
 * Tables rank first: someone typing a table's name almost always wants the
 * table, not a column that happens to share the word.
 */
export function searchDocs(snapshot: SchemaSnapshot, query: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }

  const tables: SearchHit[] = [];
  const columns: SearchHit[] = [];

  for (const table of snapshot.tables) {
    const key = qualified(table.schema, table.name);
    if (table.name.toLowerCase().includes(needle)) {
      tables.push({ kind: "table", label: table.name, context: key, tableKey: key });
    }
    for (const column of table.columns) {
      if (column.name.toLowerCase().includes(needle)) {
        columns.push({ kind: "column", label: column.name, context: key, tableKey: key });
      }
    }
  }

  const groups: SearchHit[] = snapshot.groups
    .filter((group) => group.name.toLowerCase().includes(needle))
    .map((group) => ({
      kind: "group",
      label: group.name,
      context: `${snapshot.tables.filter((table) => table.groupId === group.id).length} tables`,
      tableKey: null,
    }));

  const enums: SearchHit[] = snapshot.enums
    .filter((value) => value.name.toLowerCase().includes(needle))
    .map((value) => ({
      kind: "enum",
      label: value.name,
      context: `${value.values.length} values`,
      tableKey: null,
    }));

  return [...tables, ...columns, ...groups, ...enums];
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/docsSearch.spec.ts
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec oxlint --vue-plugin apps/desktop/src/docs
git add apps/desktop/src/docs/
git commit -m "feat(docs): add client-side search for the docs viewer"
```

---

## Task 6: Group colour

**Files:**
- Create: `apps/desktop/src/docs/groupColor.ts`
- Test: `apps/desktop/src/docs/__tests__/groupColor.spec.ts`

**Interfaces:**
- Produces: `groupStyle(hue: number | null): Record<string, string>`

**The design rule:** a group stores ONE number, a hue. Lightness and chroma are fixed per theme in CSS, so every hue is legible on both light and dark grounds by construction. The viewer must never compute hex — that would defeat the whole scheme and reintroduce the dark-mode mud problem the mock solved.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { groupStyle } from "../groupColor";

describe("groupStyle", () => {
  it("exposes the hue as a CSS custom property", () => {
    expect(groupStyle(28)).toEqual({ "--h": "28" });
  });

  it("returns no custom property for an ungrouped section", () => {
    expect(groupStyle(null)).toEqual({});
  });

  it("wraps hues into 0-359 rather than emitting an out-of-range value", () => {
    expect(groupStyle(360)).toEqual({ "--h": "0" });
    expect(groupStyle(388)).toEqual({ "--h": "28" });
    expect(groupStyle(-1)).toEqual({ "--h": "359" });
  });

  it("never emits a colour value", () => {
    // Lightness and chroma belong to the theme. If this function ever returns
    // a hex or oklch string, the dark-mode contrast guarantee is gone.
    const style = groupStyle(200);
    const serialized = JSON.stringify(style);
    expect(serialized).not.toContain("#");
    expect(serialized).not.toContain("oklch");
    expect(serialized).not.toContain("rgb");
  });

  it("coerces a non-integer hue to an integer", () => {
    expect(groupStyle(28.7)).toEqual({ "--h": "28" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/groupColor.spec.ts
```
Expected: FAIL — cannot resolve `../groupColor`.

- [ ] **Step 3: Implement**

```ts
/**
 * Inline style exposing a table group's hue to CSS.
 *
 * A group stores ONE number. Lightness and chroma are fixed per theme in the
 * stylesheet — `--group-c: oklch(0.55 0.15 var(--h))` in light,
 * `oklch(0.76 0.13 var(--h))` in dark — so every hue is legible on both
 * grounds by construction. Computing a colour here would throw that away.
 */
export function groupStyle(hue: number | null): Record<string, string> {
  if (hue === null) {
    return {};
  }
  const wrapped = ((Math.trunc(hue) % 360) + 360) % 360;
  return { "--h": String(wrapped) };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/groupColor.spec.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec oxlint --vue-plugin apps/desktop/src/docs
git add apps/desktop/src/docs/
git commit -m "feat(docs): expose group hue as a CSS custom property"
```

---

## Task 7: Note markdown rendering

> **This brief was corrected by the controller after empirically probing `marked@18.0.4`.**
> The original plan text contained three defects: an assertion that fails against a correct
> implementation, a suggested approach that double-escapes HTML entities, and a URL filter
> with several live bypasses. Everything below has been run against the installed `marked`
> and its exact output verified. Use it verbatim.

**Files:**
- Create: `apps/desktop/src/docs/renderNote.ts`
- Test: `apps/desktop/src/docs/__tests__/renderNote.spec.ts`

**Interfaces:**
- Produces: `renderNote(markdown: string | null): string`

**Notes are markdown.** `marked@18.0.4` is already a dependency — do NOT add one, and do NOT
add a sanitiser (no DOMPurify).

**This is the security-relevant task in Part 3a.** Note text comes from two places, and one of
them — `COMMENT ON` values — lives in the *database*, which is not always under the document
author's control. In Part 3b the same renderer runs inside a standalone HTML file people forward
to colleagues. So raw HTML must be escaped, not rendered, and unsafe URL schemes must be dropped.

**Verified facts about `marked@18` you must not re-derive:**
- It escapes nothing by default. `<script>alert(1)</script>` passes straight through.
- It does **not** block `javascript:`, `vbscript:`, or `data:` URLs in links or images.
- Pre-escaping the source string before parsing is **wrong** — it double-escapes entities, so
  `a &amp; b` renders as the literal text `a &amp; b` instead of `a & b`.
- In the `link` renderer, the `text` property is the **raw markdown source**, not parsed HTML.
  Returning it directly is an XSS hole and also breaks `**bold**` inside link text. You must use
  `this.parser.parseInline(tokens)` instead.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { renderNote } from "../renderNote";

describe("renderNote", () => {
  it("renders ordinary markdown", () => {
    expect(renderNote("One row per **checkout**.")).toContain("<strong>checkout</strong>");
  });

  it("renders inline code and fenced blocks", () => {
    expect(renderNote("see `order_status`")).toContain("<code>order_status</code>");
    expect(renderNote("```sql\nSELECT 1;\n```")).toContain("<pre>");
  });

  it("returns an empty string for null or blank input", () => {
    expect(renderNote(null)).toBe("");
    expect(renderNote("   ")).toBe("");
  });

  it("escapes a script tag rather than rendering it", () => {
    const html = renderNote("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an img onerror payload", () => {
    // NB: asserting !contains("onerror=") would FAIL against a correct
    // implementation — the escaped text legitimately still contains that
    // substring. What matters is that no <img> ELEMENT is produced.
    const html = renderNote('<img src=x onerror="alert(1)">');
    expect(html.toLowerCase()).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes raw HTML even when it looks harmless", () => {
    // Blanket rule: no author-supplied HTML is rendered, ever. A rule with
    // exceptions is a rule someone will find a way around.
    const html = renderNote("<b>bold</b>");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("does not preserve HTML entities twice", () => {
    // Guards the pre-escaping approach, which turns "a &amp; b" into
    // "a &amp;amp; b" and renders the entity visibly to the reader.
    expect(renderNote("a &amp; b")).toContain("a &amp; b");
    expect(renderNote("a &amp; b")).not.toContain("&amp;amp;");
  });

  it.each([
    ["javascript:alert(1)", "javascript"],
    ["JaVaScRiPt:alert(1)", "javascript"],
    ["&#106;avascript:alert(1)", "avascript"],
    ["vbscript:alert(1)", "vbscript"],
    ["data:text/html;base64,PHNjcmlwdD4=", "data:"],
  ])("drops the unsafe link scheme %s", (href, forbidden) => {
    const html = renderNote(`[click](${href})`).toLowerCase();
    expect(html).not.toContain(forbidden);
    expect(html).toContain("click"); // the text survives; only the href is dropped
  });

  it("drops an unsafe image scheme", () => {
    const html = renderNote("![img](javascript:alert(1))").toLowerCase();
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("<img");
  });

  it.each(["https://example.com", "http://example.com", "mailto:a@b.com", "#anchor", "./rel.html"])(
    "keeps the safe link target %s",
    (href) => {
      expect(renderNote(`[ok](${href})`)).toContain(`href="${href}"`);
    },
  );

  it("parses markdown inside link text instead of emitting it raw", () => {
    // marked hands the renderer the RAW source text. Emitting it directly
    // both breaks formatting and injects unescaped HTML.
    expect(renderNote("[**keep**](https://example.com)")).toContain("<strong>keep</strong>");
    const dropped = renderNote('[<img src=x onerror="alert(1)">](javascript:alert(1))');
    expect(dropped.toLowerCase()).not.toContain("<img");
    expect(dropped).toContain("&lt;img");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/renderNote.spec.ts
```
Expected: FAIL — cannot resolve `../renderNote`.

- [ ] **Step 3: Implement**

This exact implementation was run against `marked@18.0.4` and every assertion above verified.

```ts
import { Marked } from "marked";

/** Escape the five characters that can break out of text or an attribute value. */
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * URL allowlist. Blocklists lose: `javascript:` alone misses `JaVaScRiPt:`,
 * the entity-encoded `&#106;avascript:`, `vbscript:` and `data:text/html`.
 * Permitting only what we understand is both shorter and complete.
 */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

function safeUrl(raw: unknown): string | null {
  const url = String(raw ?? "").trim();
  if (url === "") {
    return null;
  }
  if (url.startsWith("#") || url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
    return url;
  }
  return SAFE_SCHEME.test(url) ? url : null;
}

const renderer = new Marked({
  renderer: {
    // Raw HTML in the source is shown as text, never rendered.
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      // `tokens`, not `text` — `text` is the raw markdown source, so returning
      // it would emit author HTML unescaped and swallow inline formatting.
      const inner = this.parser.parseInline(tokens);
      const safe = safeUrl(href);
      if (safe === null) {
        return inner;
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${titleAttr}>${inner}</a>`;
    },
    image({ href, title, text }) {
      const safe = safeUrl(href);
      if (safe === null) {
        return escapeHtml(text);
      }
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text)}"${titleAttr}>`;
    },
  },
});

/** Render a note's markdown to HTML with all author-supplied HTML escaped. */
export function renderNote(markdown: string | null): string {
  if (markdown === null || markdown.trim() === "") {
    return "";
  }
  return renderer.parse(markdown) as string;
}
```

If `vue-tsc` objects to the renderer callback signatures, fix the types rather than the
behaviour, and report what you changed. Do NOT loosen the escaping to satisfy the compiler.

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/renderNote.spec.ts
```

- [ ] **Step 5: Verify the guards are real — three deliberate breaks**

One at a time, restoring between each. Report each failure message.

1. Delete the `html` renderer override entirely → the script-tag, img and `<b>` tests must fail.
2. Change `safeUrl` to `return url;` unconditionally → the unsafe-scheme cases must fail.
3. In `link`, replace `this.parser.parseInline(tokens)` with the token's `text` property →
   the "parses markdown inside link text" test must fail.

If any deliberate break does NOT produce a failure, stop and tell me — that means the test is
not actually pinning the guard, which is the exact defect this step exists to catch.

- [ ] **Step 6: Commit**

```bash
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json
pnpm exec oxlint --vue-plugin apps/desktop/src/docs
git add apps/desktop/src/docs/
git commit -m "feat(docs): render note markdown with raw HTML escaped"
```

Confirm `git status` is clean after your restores, so no deliberate break leaks into the commit.

---

## Task 8: Components

**Files:**
- Create: `apps/desktop/src/docs/DocsApp.vue`
- Create: `apps/desktop/src/docs/components/DocsSidebar.vue`, `WikiIndex.vue`, `TablePage.vue`, `ColumnTable.vue`, `RelationshipList.vue`, `WarningBanner.vue`, `DocsSearch.vue`
- Test: `apps/desktop/src/docs/__tests__/componentContract.spec.ts`

Templates only. Every decision they display comes from Tasks 3-7. The visual reference is the approved mock: sidebar with the Group-by switch, wiki index with inline notes, table page with columns / indexes / bidirectional relationships, the `⬤ LOCAL` shadow marker, and the warning banner.

**Because this repo has no component-mount harness, verification is static SFC parsing** — copy the technique from `packages/app-tests/aiAssistantSendGuard.test.ts` (`readFileSync` + `parse` from `vue/compiler-sfc`).

- [ ] **Step 1: Write the contract test**

```ts
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "vue/compiler-sfc";

const docsRoot = path.resolve(__dirname, "..");

function vueFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "__tests__" && entry.name !== "fixtures") {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".vue")) {
        found.push(full);
      }
    }
  };
  walk(docsRoot);
  return found;
}

function scriptOf(file: string): string {
  const { descriptor } = parse(readFileSync(file, "utf8"), { filename: file });
  return `${descriptor.script?.content ?? ""}\n${descriptor.scriptSetup?.content ?? ""}`;
}

describe("docs viewer component contract", () => {
  it("finds the expected components", () => {
    const names = vueFiles().map((file) => path.basename(file)).sort();
    expect(names).toContain("DocsApp.vue");
    expect(names).toContain("DocsSidebar.vue");
    expect(names).toContain("WikiIndex.vue");
    expect(names).toContain("TablePage.vue");
    expect(names).toContain("WarningBanner.vue");
  });

  it("makes no backend calls", () => {
    // The whole point of this directory: snapshot in, DOM out. If a component
    // ever reaches for the backend, the same code cannot run inside an
    // exported HTML file on a machine that has never installed DBX.
    const forbidden = [
      "@/lib/backend",
      "@tauri-apps",
      "invoke(",
      "useConnectionStore",
      "useQueryStore",
      "useSettingsStore",
      "fetch(",
      "axios",
    ];
    for (const file of vueFiles()) {
      const script = scriptOf(file);
      for (const needle of forbidden) {
        expect(script.includes(needle), `${path.basename(file)} must not reference ${needle}`).toBe(false);
      }
    }
  });

  it("keeps colour decisions out of templates", () => {
    // Hue -> CSS belongs in groupColor.ts so the theme keeps control of
    // lightness and chroma.
    for (const file of vueFiles()) {
      const source = readFileSync(file, "utf8");
      expect(source.includes("oklch("), `${path.basename(file)} must not compute colour`).toBe(false);
    }
  });

  it("uses <script setup lang=\"ts\">", () => {
    for (const file of vueFiles()) {
      const { descriptor } = parse(readFileSync(file, "utf8"), { filename: file });
      expect(descriptor.scriptSetup, `${path.basename(file)} must use <script setup>`).toBeTruthy();
      expect(descriptor.scriptSetup?.lang, `${path.basename(file)} must be TypeScript`).toBe("ts");
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/componentContract.spec.ts
```
Expected: FAIL — no `.vue` files exist yet.

- [ ] **Step 3: Build the components**

Write the seven components as thin templates. Rules:

- `DocsApp.vue` takes a single prop `snapshot: SchemaSnapshot` and a `readonly = true` prop, holds the current view (`index` | `table`) and the group-by mode, and renders the others. No editing affordances in Part 3a — `readonly` exists so Part 3b can flip it.
- `DocsSidebar.vue` renders the `Group by: Schemas | Table Groups` segmented control and the section list, using `groupBySchema` / `groupByTableGroup` from Task 3 and `groupStyle` from Task 6.
- `WikiIndex.vue` renders each section header (name, count, note) and its table list.
- `TablePage.vue` renders the table's note with a `⬤ LOCAL` marker when `noteSource === "LOCAL"`, the shadowed database comment in a `title` attribute when `shadowedNote` is present, then `ColumnTable`, indexes, and `RelationshipList`.
- `ColumnTable.vue` renders name / type / settings / note, reading notes from `columnNotes` by the column's real name.
- `RelationshipList.vue` renders outgoing and incoming relationships in two lists, derived from `snapshot.relationships` filtered on the current table.
- `WarningBanner.vue` renders `describeWarning` output from Task 4.
- `DocsSearch.vue` renders the ⌘K palette using `searchDocs` from Task 5.

Style with Tailwind classes and DBX's existing token names (`bg-background`, `text-foreground`, `border-border`, `text-muted-foreground`). Group colours come only from `var(--group-c)` / `var(--group-tint)` driven by the `--h` custom property.

- [ ] **Step 4: Run the contract test**

```bash
pnpm vitest run apps/desktop/src/docs/__tests__/componentContract.spec.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Run everything and lint**

```bash
pnpm vitest run apps/desktop/src/docs
pnpm exec oxlint --vue-plugin apps/desktop/src/docs
pnpm exec vue-tsc --noEmit --project apps/desktop/tsconfig.json
```
All must pass. `vue-tsc` is the only thing that type-checks the templates, so it is doing the work a mount test would otherwise do — report any error rather than suppressing it.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/docs/
git commit -m "feat(docs): add docs viewer components"
```

---

## Done criteria

- `apps/desktop/src/docs/` contains a viewer that renders a `SchemaSnapshot` with zero backend calls, enforced by a test.
- Every decision (grouping, search, warning text, group colour) lives in a tested `.ts` module.
- A fixture generated from real Rust output guards the hand-maintained TS types against drift.
- `pnpm vitest run apps/desktop/src/docs` passes; `vue-tsc` and `oxlint` are clean.

## Deferred to Part 3b

- Mounting the viewer inside DBX (`DatabaseDocsDialog.vue`) and the editing affordances behind `readonly=false`.
- The standalone Vite bundle, the committed `docs-viewer.js` artifact, and the self-contained HTML export — including inlining the real Geist font, which IS in the repo at `apps/desktop/public/fonts/geist-latin-wght-normal.woff2`.
- The `dbx docs` CLI verb.
- Hash routing (`#/table/public.orders`). Part 3a keeps the current view in `DocsApp` state; hash routing belongs with the standalone entry point, since its whole purpose is surviving a `file://` load.
- The `EnumPage` view listing enum values.
- The ER diagram view (reuses `layoutDiagramTables` from `lib/diagram/erDiagram.ts`, which imports only types and is therefore safe for the standalone bundle).
- i18n: Part 3a hardcodes English strings in `docsWarnings.ts`; Part 3b extracts them into a `docs` namespace across all 8 locales.

---

## Appendix: Corrections found during execution

Defects in this plan's own text, found while executing it. Recorded by failure mode rather than
by task, because the modes repeat and the tasks do not. Every one originated in the plan; none
was an implementer error.

### Mode 1 — a test whose fixture cannot distinguish the property from its negation

The most common failure by a wide margin, and the hardest to see on a green run. The assertion
names a real property; the data supplied cannot tell that property apart from its opposite.

- **Task 5, ranking.** `expect(hits[0].kind).toBe("table")` for query `"orders"`. No column in
  the fixture contained that substring, so exactly one hit came back and the assertion held
  trivially. Reversing the concatenation order produced byte-identical output. Fixed by adding an
  `orders_count` column to a second table so the query yields both kinds, and by asserting
  `indexOf(first table) < indexOf(first column)` instead of inspecting element zero.
- **Task 5, case-insensitivity.** Every identifier in the fixture was already lowercase, so a
  mutant lowercasing only the needle and not each candidate passed all seven tests. Fixed by
  adding a mixed-case `Invoices` table and `Amount` column.

**The lesson:** write the assertion, then ask what fixture would make it fail. If no such fixture
exists, the test is decorative. Watching the test fail once is the only cheap proof.

### Mode 2 — an assertion that fails against a *correct* implementation

- **Task 7.** `expect(html).not.toContain("onerror=")` for the input `<img src=x onerror="…">`.
  Correctly escaped output is `&lt;img src=x onerror=&quot;alert(1)&quot;&gt;`, which legitimately
  contains that substring as inert text. The test would have driven an implementer to strip
  attributes from text content — wrong, and a plausible route to breaking the escaping entirely.
  Fixed by asserting no `<img` *element* is produced and that `&lt;img` is present.

**The lesson:** an assertion about a security property must target the dangerous *structure*, not
a scary-looking *string*. Escaped text is supposed to still read like the attack.

### Mode 3 — offering two approaches as equivalent when one is broken

- **Task 7.** Step 3 presented "escape the source before parsing" and "override the renderer's
  html hook" as interchangeable. Pre-escaping double-escapes entities: `a &amp; b` renders as the
  literal text `a &amp; b`. Fixed by mandating the renderer hook and stating why.

**The lesson:** when a plan says "either approach works", it usually means neither was tested.

### Mode 4 — a blocklist where an allowlist was needed

- **Task 7.** The instruction was to drop any `href` starting with `javascript:` after trimming and
  lowercasing. Probing `marked@18.0.4` showed it blocks nothing and emits verbatim hrefs for
  `JaVaScRiPt:`, the entity-encoded `&#106;avascript:` (which the browser decodes and fires),
  `vbscript:`, and `data:text/html;base64,…`. The instruction also covered only `href`, never
  `<img src>`. Replaced with an allowlist of `https?:`, `mailto:`, and relative/anchor forms —
  shorter than the blocklist and complete without enumerating a single bypass.

**The lesson:** enumerating what is forbidden requires knowing every attack; enumerating what is
permitted requires knowing only the feature.

### Mode 5 — assuming a library parameter contains what its name suggests

- **Task 7.** Found while verifying the *replacement* for Mode 4, not in the original text. In
  `marked@18` the `link` renderer's `text` property is the **raw markdown source**, not the parsed
  inner HTML. Returning it emits author HTML unescaped — `[<img src=x onerror=…>](javascript:…)`
  renders a live element even though the URL was correctly dropped — and it also swallows inline
  formatting, so `[**keep**](…)` loses its emphasis. Fixed with `this.parser.parseInline(tokens)`.

**The lesson:** the first ten payloads all put the attack in the URL, because that is where the
danger was assumed to be. The hole was in the field nobody was thinking about. Passing security
tests confirm the threat model they were written from; they do not probe it.

### Mode 6 — a verification step that verifies nothing

- **Task 1.** The drift check instructed renaming `types.ts` to confirm the conformance test would
  catch schema drift. Renaming the type file breaks the *import*, which fails for reasons having
  nothing to do with drift. Caught by the implementer, who proposed mutating the fixture instead —
  the only change that actually exercises the check. Fixed in the executed task.
