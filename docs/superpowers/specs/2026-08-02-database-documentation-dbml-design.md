# Database Documentation and DBML Export Design

Date: 2026-08-02

## Summary

DBX can inspect a schema but cannot document it. There is no way to produce a browsable, shareable description of a database, and no occurrence of DBML anywhere in the repository.

This change adds a **documentation subsystem** built around one idea: `SchemaSnapshot` is the product, and every output is a serializer over it. `crates/dbx-core/src/docs/` collects a normalized snapshot of a relational schema, merges it with user-authored notes and table groups, and serializes it to two artifacts — a `.dbml` interchange file and a self-contained HTML documentation site in the style of [dbdocs.io](https://dbdocs.io/Holistics/Ecommerce).

The documentation UI is a **standalone Vue application that makes no backend calls**. The same component tree renders inside DBX as a dialog and inside an exported single-file HTML page. Generation is available headless through `dbx docs` and `dbx dbml`, so documentation can be regenerated in CI and schema drift can fail a build.

Schema versioning (a Changelog tab and per-table "Last Updated") is explicitly deferred, but the snapshot is version-stamped and storable from day one so that adding it later is additive rather than a refactor.

## Goals

- Collect a normalized `SchemaSnapshot` for any relational engine DBX already supports, reusing the existing `schema::providers` metadata layer.
- Serialize the snapshot to valid DBML, including `TableGroup` blocks, `Enum` blocks, and `Ref` cardinality.
- Render dbdocs-style documentation: project overview, per-group table index with inline markdown notes, per-table pages with columns/indexes/bidirectional relationships, an ER diagram with group containers, and client-side search.
- Let users author table notes, column notes, project notes, and **table groups** in DBX, persisted in a human-readable, git-committable file.
- Export a self-contained HTML file that works over `file://` with no network access.
- Provide `dbx docs` and `dbx dbml` CLI verbs producing byte-identical output to the desktop app.
- Degrade visibly, never silently, when an engine cannot supply metadata.

## Non-goals

- **Schema versioning / Changelog / "Last Updated"** — deferred. Live databases mostly cannot report a DDL timestamp (PostgreSQL has none; MySQL's `information_schema.tables.update_time` is NULL for most InnoDB tables), so this is a derivative of stored snapshot history, not of metadata. Section 12 defines the seam.
- **DBML import / parsing.** The serializer is one-way. A `.dbml` file is an output, never a source of truth.
- **Non-relational engines** (MongoDB, Redis, Elasticsearch, InfluxDB, HBase). DBML has no vocabulary for them and schema inference from documents is a separate feature.
- **Non-table objects** — triggers, procedures, functions, sequences, packages, grants, partitions. `ObjectInfo` exists for these but none map to DBML and dbdocs does not document them. `format_version` makes adding them additive.
- **Write-back to the database.** DBX never issues `COMMENT ON` as a side effect of documentation.
- **Publishing/hosting.** DBX writes a file; distributing it is the user's business.

## Existing Design to Reuse

- `crates/dbx-core/src/types.rs:57-141` — `TableInfo`, `ColumnInfo`, `IndexInfo`, `ForeignKeyInfo`. These are serde mirrors of the TS interfaces in `apps/desktop/src/types/database.ts` and are **composed directly** into the snapshot rather than re-declared.
- `crates/dbx-core/src/schema/providers/native.rs` — `list_databases`, `list_schemas`, `list_tables`, `get_columns`, `list_foreign_keys`, `list_indexes`, already dispatching across every supported engine.
- `crates/dbx-core/src/schema/normalization.rs` — identifier normalization; the home for per-engine case folding of annotation keys.
- `crates/dbx-core/src/table_structure_sql/dialect.rs` — `capabilities_for(database_type).comment`, the authority on whether an engine supports comments at all.
- `crates/dbx-core/src/schema_diff.rs:772` — `RenameCandidate { source_name, target_name, score, column_jaccard, type_similarity }` plus `jaccard_similarity` and `column_type_similarity`. Reused to *suggest* re-mapping orphaned notes after a rename.
- `crates/dbx-core/src/database_export.rs` — the established progress-callback and cancellation shape.
- `apps/desktop/src/lib/diagram/erDiagram.ts` — `layoutDiagramTables` and `diagramZoom.ts`. This module imports **only types**, so the standalone docs bundle can import it without pulling in DBX runtime code. `buildDiagramRelationships` / `foreignKeySourceCardinality` are the reference implementation for the Rust port in Section 3.
- `apps/desktop/src/lib/export/diagramSvgExport.ts` — existing SVG serialization for diagram export.
- `apps/desktop/src/styles/globals.css:1310+` — the DBX token palette (strictly achromatic, `oklch(… 0 0)`), from which the docs theme subset is derived.
- `marked@18` and `shiki@4` are already dependencies. **No new dependency is required by this design.**

## Design

### 1. Snapshot model (`crates/dbx-core/src/docs/snapshot.rs`)

```rust
use crate::types::{ColumnInfo, ForeignKeyInfo, IndexInfo};

#[derive(Serialize, Deserialize)]
pub struct SchemaSnapshot {
    pub format_version: u32,          // 1
    pub project: ProjectMeta,
    pub tables: Vec<DocTable>,
    pub relationships: Vec<Relationship>,
    pub groups: Vec<TableGroup>,
    pub enums: Vec<DocEnum>,
    pub warnings: Vec<SnapshotWarning>,
}

pub struct ProjectMeta {
    pub name: String,
    pub database_type: String,
    pub database: Option<String>,
    pub schemas: Vec<String>,
    pub generated_at: String,         // RFC3339
    pub note: Option<String>,         // markdown, the landing page
}

pub struct DocTable {
    pub schema: Option<String>,
    pub name: String,
    pub kind: TableKind,              // Table | View | MaterializedView
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub group_id: Option<String>,
    pub note: Option<String>,
    pub note_source: NoteSource,      // Database | Local | None
    pub shadowed_note: Option<String>, // db comment a local note overrides
    pub column_notes: BTreeMap<String, ColumnNote>,
    pub estimated_rows: Option<i64>,
    pub view_definition: Option<String>,
}

pub struct TableGroup {
    pub id: String,                   // slug, stable across renames
    pub name: String,
    pub hue: u16,                     // 0-359 — see Section 4
    pub note: Option<String>,
}

pub struct Relationship {
    pub id: String,
    pub name: Option<String>,
    pub from: FieldRef,
    pub to: FieldRef,
    pub cardinality: Cardinality,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

pub struct FieldRef { pub schema: Option<String>, pub table: String, pub column: String }
pub struct ColumnNote { pub note: String, pub source: NoteSource, pub shadowed: Option<String> }
pub struct DocEnum { pub schema: Option<String>, pub name: String,
                     pub values: Vec<String>, pub note: Option<String>,
                     pub synthesized: bool }   // true for MySQL inline ENUM(...)

pub enum TableKind   { Table, View, MaterializedView }
pub enum NoteSource  { Database, Local, None }
pub enum Cardinality { OneToOne, ManyToOne }

pub enum SnapshotWarning {
    TableSkipped { table: String, reason: String },
    NoForeignKeyMetadata { engine: String },
    CommentsUnsupported { engine: String },
    OrphanedNotes { count: usize },
    DbmlOmitted { table: String, item: String, reason: String },
}
```

Four decisions are embedded here:

- **`format_version`** guards viewer/data skew. The exported HTML pins a snapshot beside a viewer built from the same commit, but an in-app viewer may load a snapshot produced by an older DBX. One integer prevents a class of blank-render bugs and makes future additions additive.
- **`note_source` and `shadowed_note`** exist so the UI can show *where* prose came from. When a local note shadows a database comment, both are available; the original is shown on hover. Without this, a DBA later writing a better `COMMENT ON` would have their improvement silently hidden forever.
- **`warnings`** is the honest-degradation channel (Section 10).
- **Enums are first-class** because DBML has native `enum` blocks. `ColumnInfo.enum_values` is already populated for MySQL inline `ENUM(...)`; PostgreSQL named enums are collected from `pg_type`/`pg_enum`. MySQL inline enums are synthesized into a named enum per `table_column`. This is the one place the snapshot normalizes rather than passes through.

### 2. Collection (`crates/dbx-core/src/docs/collector.rs`)

v1 fetches through the **existing** provider functions, fanned out with a bounded semaphore (8 concurrent). No new per-engine SQL.

This is deliberately the naive-but-correct version: it works for every supported relational engine on day one because it reuses code already proven against all of them. A 400-table schema costs roughly 1200 queries — bounded, cancellable, and measurable.

The optimization path is targeted rather than speculative: PostgreSQL and MySQL can collect all columns, FKs and indexes for a schema in three `information_schema` sweeps instead of 3×N. That belongs in a `collector::bulk` specialization behind the same interface, added only where a benchmark under `scripts/bench/` shows it matters.

Progress is reported through an `impl Fn(DocsProgress)` callback and cancellation via a checked `AtomicBool`, matching `database_export.rs`.

### 3. Relationship inference (`crates/dbx-core/src/docs/relations.rs`)

A port of the data half of `erDiagram.ts`. The split is deliberate:

- **Data logic moves to Rust** — given foreign keys and unique indexes, is an edge 1:1 or N:1? This is the `foreignKeySourceCardinality` check: a relationship is `OneToOne` only when the source columns contain a unique key, otherwise `ManyToOne`.
- **Layout stays in the renderer** — `layoutDiagramTables` is a view concern and remains in TypeScript, imported by the docs bundle.

This keeps the port to roughly 100 lines rather than a rewrite of the diagram feature. `SchemaDiagramDialog.vue` is **not modified** by this change; once `relations.rs` is proven it becomes the obvious candidate to consume the same inference, removing the duplicate.

### 4. Annotations and table groups (`crates/dbx-core/src/docs/annotations.rs`)

**The notes file is the store** — not a cache, not an export. `dbx.db` persists exactly one thing per connection: the path to this file.

```jsonc
// default: <app-data>/docs-notes/<connection-id>.json
// overridable per connection to e.g. ./docs/dbx-docs.json inside a repository
{
  "format_version": 1,
  "project": { "name": "Ecommerce", "note": "# Overview\n\nMarkdown." },
  "groups": [
    { "id": "order-management", "name": "Order Management", "hue": 28,
      "note": "Everything from checkout to carrier handoff." }
  ],
  "tables": {
    "core.orders": {
      "group": "order-management",
      "note": "One row per completed checkout.",
      "columns": { "status": { "note": "State machine; only moves forward." } }
    }
  }
}
```

This shape is required by the CI goal. If notes lived only in `dbx.db`, `dbx docs` in CI would render documentation with every note missing — polished pages, empty of the prose that justifies them. As a file, notes are also reviewable in pull requests, which is arguably better than `COMMENT ON` (invisible to code review). `DesktopSettings.saved_sql_sync_dir` is the existing precedent for a user-chosen path.

**Table groups** are cross-schema domain groupings, authored by the user, stored here alongside notes, and serialized to DBML `TableGroup` blocks. A table belongs to at most one group; unassigned tables render under `(no group)`. Grouping is documentation, not configuration — it never affects what is collected.

**Group colour is stored as a hue integer (0–359), not a hex string.** Lightness and chroma are fixed per theme in CSS and only the hue varies per group:

```css
.group { --h: 28; }
/* light */ --group-c: oklch(0.55 0.15 var(--h)); --group-tint: oklch(0.965 0.022 var(--h));
/* dark  */ --group-c: oklch(0.76 0.13 var(--h)); --group-tint: oklch(0.27  0.038 var(--h));
```

Storing a hex colour the dbdocs way would force either an unreadable dark mode (pastels tuned for a white page turn to mud on `rgb(19 20 22)`) or two colours per group that the user must choose twice. One hue guarantees legible contrast on both grounds by construction, and converts to hex on DBML export.

**Group editor UI.** Groups are created and edited in a dialog reached from the group header on the wiki index, the group badge on a table page, and the diagram group popover. Fields: name, note (markdown), colour, and member tables.

The colour control is **12 curated swatches plus a full 0–359 hue slider** — every hue is reachable, but lightness and chroma remain theme-controlled, so no selection can produce an illegible group. The dialog renders a **two-ground preview**, showing the group chrome on a forced-light and a forced-dark tile simultaneously, because the user may be editing in one theme while a colleague reads the exported HTML in the other.

A native hex/RGB picker is deliberately not offered. It would let a user choose a colour that disappears against one of the two grounds, and the only remedies are to render something different from what the picker showed, or to ship an unreadable group. Hue-plus-fixed-lightness makes the illegible state unrepresentable rather than merely discouraged.

On save, the group is written to the notes file. Since colour is one integer, a group's full definition is a four-field object and diffs cleanly in review.

**Keys and renames.** Keys are `schema.table` and `schema.table.column`, case-folded per engine (PostgreSQL lower, Oracle upper, MySQL per `lower_case_table_names`) in `schema/normalization.rs`.

When a table or column is renamed its note orphans. **User prose is never silently deleted.** Orphans remain in the file, the collector emits `SnapshotWarning::OrphanedNotes { count }`, and the dialog shows an "Unmatched notes" panel. For each orphan, `schema_diff::RenameCandidate` is used to **suggest** the most likely new owner along with its confidence score; the user confirms, re-maps manually, or deletes. Suggestion plus confirmation, never automatic re-attachment — a wrong auto-guess would attach misleading documentation to the wrong column, which is worse than an honest orphan.

**Merge precedence** is `local_annotation ?? database_comment`, recorded in `note_source`. On engines where `capabilities_for(db_type).comment == false` (SQLite, ClickHouse) the annotation layer is the only prose channel, and the UI states this once rather than offering an inert "read from database" affordance.

### 5. DBML serialization (`crates/dbx-core/src/docs/dbml.rs`)

A hand-written serializer, roughly 250 lines. The `@dbml/core` npm package is unusable from Rust and the grammar is small enough not to warrant a dependency.

```dbml
Project ecommerce {
  database_type: 'PostgreSQL'
  Note: '''Generated by DBX on 2026-08-02'''
}

Enum order_status { pending  shipped  cancelled }

TableGroup order_management [color: #c2410c] {
  core.orders
  core.order_items
  Note: '''Everything from checkout to carrier handoff.'''
}

Table core.orders {
  id          integer      [pk, increment]
  user_id     integer      [not null, note: 'Owning customer']
  status      order_status [not null, default: 'pending']
  placed_at   timestamptz  [default: `now()`]

  Indexes {
    (user_id, placed_at) [name: 'idx_orders_user_placed']
  }

  Note: '''One row per completed checkout.'''
}

Ref fk_orders_user: core.orders.user_id > core.users.id [delete: restrict]
```

Rules:

- **Types pass through verbatim.** DBML does not validate type names, so `timestamptz`, `jsonb` and `numeric(10,2)` survive. Where `data_type` arrives bare, precision is reconstructed from `character_maximum_length` / `numeric_precision` / `numeric_scale`.
- **Cardinality comes from `relations.rs`**: `>` for many-to-one, `-` for one-to-one.
- **Schema qualification is conditional** — bare names for a single-schema snapshot (it reads better), fully qualified for multi-schema, since DBML has no `search_path`.
- **Escaping** — identifiers quoted when not `[A-Za-z_][A-Za-z0-9_]*`; notes always in `'''triple quotes'''` so apostrophes cannot break the file; expression defaults in backticks, literals in single quotes.
- **Group colour** is converted from hue to hex at the theme-neutral lightness.

**DBML is lossy and this is documented in the output.** It cannot express check constraints, partial or filtered indexes (`IndexInfo.filter`), included columns, collations, or generated columns. Composite foreign keys are emitted in the grouped `(a, b) > (c, d)` form, whose support across dbdocs/dbdiagram is uneven. Every omission produces a `SnapshotWarning`, and the HTML documentation renders the omitted item with a "not in DBML" marker.

The asymmetry is intentional: **DBML is the interchange format; the HTML documentation is the complete record.** Treating DBML as a source of truth would silently drop constraints.

### 6. Docs viewer (`apps/desktop/src/docs/`)

```
main.ts              — standalone entry; reads window.__DBX_DOCS__, mounts
DocsApp.vue          — root; hash routing
components/
  DocsShell.vue      — sidebar + main
  DocsSidebar.vue    — Group by: Schemas | Table Groups switch, trees, enums
  DocsSearch.vue     — ⌘K palette, client-side fuzzy over tables/columns/groups
  WikiIndex.vue      — stats, project note, per-group table index
  TablePage.vue      — orchestrates the sections below
  ColumnTable.vue    — columns grid; inline note editing when !readonly
  IndexList.vue  RelationshipList.vue  GroupHeader.vue  EnumPage.vue
  GroupEditorDialog.vue — name/note/hue/members; rendered only when !readonly
  ErdView.vue        — pan/zoom SVG with group containers; reuses layoutDiagramTables()
  NoteMarkdown.vue   — marked → sanitized HTML
  WarningBanner.vue  — renders snapshot.warnings
__tests__/           — fixture snapshots in, rendered output asserted
```

**The contract: this directory makes no backend calls.** No `api.*`, no Tauri, no Pinia stores. Snapshot in, DOM out. This is what allows the same code to run inside an HTML file on a machine that has never installed DBX, and what makes the entire documentation UI testable without a database.

Editing is expressed as a `readonly` prop — `true` in exported HTML, `false` in-app. Components emit `@update:note`, `@update:group` and `@update:table-group`; `DatabaseDocsDialog.vue` performs the writes. `GroupEditorDialog.vue` is not rendered at all when `readonly`, so the exported HTML never ships an editor that cannot save.

Six further decisions:

- **Hash routing** (`#/table/core.orders`), not the History API, which breaks over `file://`. Also makes every table deep-linkable.
- **Raw HTML is stripped from markdown.** `marked` removed `sanitize` in v5 and DOMPurify is not in the tree. Notes come partly from `COMMENT ON` values living in the database, which is not always under the document author's control, and the output is a file people forward to colleagues. `marked` is configured to escape raw HTML: markdown formatting works, `<script>` and `<img onerror>` do not.
- **The information architecture follows dbdocs**: the Wiki tab is a scrolling per-group index whose Table Notes column renders **full markdown inline** (headings, prose, code blocks), with table detail pages behind it — not a bare list of links.
- **Theme tokens are a curated subset**, not `globals.css` (2362 lines). The viewer has its own Tailwind v4 entry scanning only `src/docs/**` plus roughly 25 hand-picked tokens matching DBX's variable names, so it inherits live tokens in-app and ships its own values (with `prefers-color-scheme` and a manual toggle) when exported.
- **No Shiki in the exported bundle.** View definitions render in a plain `<pre>`. Shiki's grammars would dominate the artifact weight for a feature nobody generates documentation to obtain.
- **i18n uses a `docs` namespace only** — roughly 40 keys, imported directly, never `i18n/locales/en.ts` wholesale, or the standalone bundle inherits the whole application translation table. All 8 locales ship, selected from `navigator.language`, with a switcher.

### 7. Static HTML export (`crates/dbx-core/src/docs/html.rs`)

Output is `HTML shell + inlined CSS + inlined viewer bundle + window.__DBX_DOCS__ = {snapshot}`.

The viewer bundle is produced by `pnpm build:docs-viewer` into `crates/dbx-core/src/docs/assets/docs-viewer.js`, and **that artifact is committed to git**. `cargo build` never invokes Vite; it only `include_str!`s what is present.

This is the one piece of build coupling in the design, accepted deliberately:

- Rust-only contributors can still `cargo build` without a Node toolchain.
- The artifact is reviewable in diffs.
- A CI job rebuilds the bundle and fails if the committed copy is stale.

The cost is a generated file in the tree that must be regenerated when the viewer changes. The CI check is what makes that safe.

**Budget: under 400 KB uncompressed** for a self-contained page documenting a 50-table schema, asserted by test (Section 11). If the real figure lands materially above this, the correct response is to question the Vue-in-a-file approach, not to ship something sluggish.

### 8. Desktop integration (`apps/desktop/src/components/docs/DatabaseDocsDialog.vue`)

The dialog owns all I/O: connection/database/schema selection, invoking the collector, progress and cancellation, note and group writes, the orphan re-map panel, and the two export actions. It mounts `<DocsApp :snapshot :readonly="false">`.

Entry point follows `SchemaDiagramDialog.vue` — a dialog reached from the connection context menu and the toolbar, not a new tab kind.

### 9. CLI (`crates/dbx-cli/src/main.rs`)

```
dbx docs <connection> --out <dir-or-file> [--schema s] [--database d]
                      [--notes path] [--tables a,b] [--open]
dbx dbml <connection> [--out path] [--schema s] [--database d] [--notes path]
```

`dbx docs` writes a self-contained `index.html`. `dbx dbml` writes to `--out` or stdout so it pipes.

The existing `--format table|json|csv` flag is **not** extended with `html|dbml`. That flag means "how do I tabulate result rows"; overloading it would invite `dbx query --format dbml`. Two verbs, one output each, matching the existing `dbx schema list` / `dbx schema describe` style.

Target CI shape:

```yaml
- run: dbx dbml prod --notes docs/dbx-docs.json --out docs/schema.dbml
- run: git diff --exit-code docs/schema.dbml   # migration drift fails the build
```

### 10. Error handling

| Situation | Behavior | Rationale |
| --- | --- | --- |
| Notes file absent | Proceed with empty notes | First CI run, or a user who has not annotated yet. Not an error. |
| Notes file malformed | **Hard fail**, non-zero exit | User prose is at stake. Proceeding would render apparently-complete docs while discarding writing. |
| One table's metadata fails | `SnapshotWarning::TableSkipped`, continue | A permission gap on one table must not kill a 400-table build. |
| Engine lacks FK metadata | Warning banner; ERD with no edges | ClickHouse, Doris, StarRocks. Honest degradation over a blank page. |
| Engine lacks comment support | Stated once in the UI | SQLite, ClickHouse — via `capabilities_for()`. |
| Orphaned notes after rename | Warning + re-map panel with suggestions | Section 4. |
| DBML-inexpressible construct | Warning + "not in DBML" marker in HTML | Section 5. |
| Connection failure | Existing error path | Already solved. |
| Stale committed viewer bundle | CI job fails | Guards the Section 7 build coupling. |

The through-line: **fail loudly when user-authored content is at risk; degrade visibly when the database simply cannot answer.**

### 11. Testing

**Rust**

- DBML snapshot tests following `crates/dbx-core/src/sql_dialect/snapshots/`.
- `relations.rs`: FK with unique source → `OneToOne`; without → `ManyToOne`; composite FK grouping; self-referencing FK.
- `annotations.rs`: merge precedence; per-engine key folding; orphan detection; `RenameCandidate` suggestion ranking; group assignment and hue round-trip through DBML hex.
- Live-engine tests as `crates/dbx-core/tests/live_postgres_docs_snapshot.rs`, matching the existing `live_postgres_query_result_export.rs` convention.

**Frontend** (`packages/app-tests/`, following `erDiagram.test.ts` and `diagramSvgExport.test.ts`)

- Every docs component rendered against **fixture snapshot JSON** — no database, no Tauri. This is the payoff of the Section 6 contract.
- `NoteMarkdown` tested explicitly against `<script>`, `<img onerror=…>` and `javascript:` hrefs.
- **Self-containment test**: generate HTML from a fixture and assert zero `http://` / `https://` in any `src`, `href` or `@import`. This catches a stray CDN font before it breaks someone's offline documentation.
- **Artifact size assertion** against the 400 KB budget, so bloat fails a test rather than accumulating.
- Group colour contrast: assert computed `--group-c` meets the contrast floor against both grounds **across all 360 hues**, not only the 12 curated swatches — the slider makes every hue reachable, so the guarantee must hold for every one of them.
- `GroupEditorDialog` is absent from the rendered tree when `readonly` is true.

### 12. Deferred: the versioning seam

The Changelog tab and per-table "Last Updated" are out of scope, but the design must not preclude them. Three constraints carry forward:

1. `SchemaSnapshot` is `Serialize + Deserialize` and carries `format_version` and `generated_at`, so it is already storable as a version record.
2. `crates/dbx-core/src/schema_diff.rs` (8728 lines) already computes `TableDiff` / `ColumnDiff` / `ForeignKeyDiff` between two schemas. A future Changelog is a storage and UI problem, not an algorithm problem.
3. The docs viewer's tab strip reserves the Changelog slot.

No storage, retention policy, or snapshot history is built in this change.

## Build Order

Each step is independently verifiable; steps 1–2 have standalone value if work stops there.

1. `SchemaSnapshot` + `collector.rs` + `relations.rs` — pure data, fully testable, no UI.
2. `dbml.rs` + `dbx dbml` — first shippable user value, small surface.
3. `annotations.rs` — notes, groups, merge, orphan handling.
4. Docs viewer against fixture snapshots — UI with no backend at all.
5. `DatabaseDocsDialog.vue` — wire into DBX.
6. `html.rs` + committed bundle + `dbx docs` — the build coupling last, once the UI has settled.

## Versioning and Documentation

- Version bump `0.5.73 → 0.6.0` (feature, pre-1.0) in `package.json`.
- Changelog entry through the existing CDN JSON flow (`crates/dbx-core/src/changelog.rs`), not a root `CHANGELOG.md` — this repository does not use one.
- A feature page in the `docs/` Next.js site.
- A `docs` i18n namespace across all 8 locales (`en`, `es`, `it`, `ja`, `ko`, `pt-BR`, `zh-CN`, `zh-TW`).

## Validated Mock

The UI was prototyped and approved before this spec was written. The throwaway mock covered: the wiki index with inline markdown notes, a table page with the shadowed-note marker, table groups across sidebar/index/diagram/search, the `Group by` switch, group containers in the ERD, the DBML-lossiness banner, and both themes. It is not part of the implementation.
