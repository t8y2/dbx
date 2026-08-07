# Database Documentation Part 1: Snapshot and DBML Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `SchemaSnapshot` — the normalized model every documentation output serializes from — plus a DBML serializer and a working `dbx dbml <connection>` CLI verb.

**Architecture:** A new `crates/dbx-core/src/docs/` module. `snapshot.rs` defines a serde model composing the existing `crate::types::{TableInfo, ColumnInfo, IndexInfo, ForeignKeyInfo}` rather than redeclaring them. `relations.rs` ports the cardinality-inference half of `apps/desktop/src/lib/diagram/erDiagram.ts` to Rust. `collector.rs` fans out over the existing `schema::providers` functions with a bounded semaphore. `dbml.rs` is a pure function `SchemaSnapshot -> String`. The CLI reaches the database through a single new `DbxBackend::collect_docs_snapshot` method so `WebBackend` makes one HTTP call rather than 3×N.

**Tech Stack:** Rust (dbx-core, dbx-web, dbx-mcp, dbx-cli), tokio, serde. No new dependencies.

**Branch:** create `feature/docs-snapshot-dbml` from current HEAD.

**Spec:** `docs/superpowers/specs/2026-08-02-database-documentation-dbml-design.md`.

**Scope note:** This is part 1 of 3, covering Build Order steps 1–2 from the spec. Table groups and notes are *serialized* here but not *authored* — `SchemaSnapshot.groups` and all note fields stay empty until Part 2 adds the annotation store. The serializer is tested against hand-built snapshots that do contain groups and notes, so Part 2 wires in a proven serializer. The docs viewer, HTML export and `dbx docs` are Part 3.

## Global Constraints

- **No new dependencies.** Everything here uses the existing crate graph.
- **Reuse, never redeclare** `crate::types::{TableInfo, ColumnInfo, IndexInfo, ForeignKeyInfo}`.
- `SchemaSnapshot.format_version` is `1` for every snapshot this plan produces.
- Group colour is stored as `hue: u16` in `0..=359`, never a hex string. Hex appears only in DBML output.
- Every DBML-inexpressible construct produces a `SnapshotWarning::DbmlOmitted`; none are silently dropped.
- Conventional Commits (`feat(docs): …`), matching repo history.
- Run `cargo fmt` before each commit; the repo has `rustfmt.toml` and `clippy.toml`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `crates/dbx-core/src/docs/mod.rs` | Module wiring + public API (`collect_snapshot`, `to_dbml`) |
| `crates/dbx-core/src/docs/snapshot.rs` | `SchemaSnapshot` and all its member types |
| `crates/dbx-core/src/docs/relations.rs` | FK → `Relationship` with cardinality inference |
| `crates/dbx-core/src/docs/collector.rs` | Bounded metadata fan-out, progress, cancellation |
| `crates/dbx-core/src/docs/dbml.rs` | `SchemaSnapshot` → DBML text |
| `crates/dbx-core/src/docs/color.rs` | OKLCH hue → sRGB hex for DBML `[color: …]` |
| `crates/dbx-web/src/routes/docs.rs` | `POST /api/docs/snapshot` |
| `crates/dbx-mcp/src/backend.rs` | `DbxBackend::collect_docs_snapshot` + both impls |
| `crates/dbx-cli/src/main.rs` | `dbx dbml` verb, `--out` flag, usage text |

---

## Task 0: Branch setup

- [ ] **Step 1: Create the branch**

```bash
cd /Users/possebon/workspaces/dbx
git checkout -b feature/docs-snapshot-dbml
```

- [ ] **Step 2: Confirm a clean baseline**

Run: `cargo check -p dbx-core`
Expected: finishes with no errors. If it fails, stop — the baseline is broken and nothing below is diagnosable.

---

## Task 1: Snapshot model

**Files:**
- Create: `crates/dbx-core/src/docs/mod.rs`
- Create: `crates/dbx-core/src/docs/snapshot.rs`
- Modify: `crates/dbx-core/src/lib.rs` (add `pub mod docs;`)

**Interfaces:**
- Consumes: `crate::types::{ColumnInfo, ForeignKeyInfo, IndexInfo}`
- Produces: `SchemaSnapshot`, `ProjectMeta`, `DocTable`, `TableGroup`, `Relationship`, `FieldRef`, `ColumnNote`, `DocEnum`, `TableKind`, `NoteSource`, `Cardinality`, `SnapshotWarning`

- [ ] **Step 1: Write the failing test**

Create `crates/dbx-core/src/docs/snapshot.rs` with only this test module at the bottom (types come in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SchemaSnapshot {
        SchemaSnapshot {
            format_version: 1,
            project: ProjectMeta {
                name: "Ecommerce".to_string(),
                database_type: "PostgreSQL".to_string(),
                database: Some("shop".to_string()),
                schemas: vec!["public".to_string()],
                generated_at: "2026-08-02T12:00:00Z".to_string(),
                note: None,
            },
            tables: vec![DocTable {
                schema: Some("public".to_string()),
                name: "orders".to_string(),
                kind: TableKind::Table,
                columns: vec![],
                indexes: vec![],
                foreign_keys: vec![],
                group_id: None,
                note: Some("Checkout rows.".to_string()),
                note_source: NoteSource::Database,
                shadowed_note: None,
                column_notes: BTreeMap::new(),
                estimated_rows: Some(2_400_000),
                view_definition: None,
            }],
            relationships: vec![],
            groups: vec![],
            enums: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn snapshot_round_trips_through_json() {
        let original = sample();
        let json = serde_json::to_string(&original).expect("serialize");
        let parsed: SchemaSnapshot = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(parsed.format_version, 1);
        assert_eq!(parsed.project.name, "Ecommerce");
        assert_eq!(parsed.tables.len(), 1);
        assert_eq!(parsed.tables[0].name, "orders");
        assert_eq!(parsed.tables[0].note.as_deref(), Some("Checkout rows."));
        assert_eq!(parsed.tables[0].estimated_rows, Some(2_400_000));
    }

    #[test]
    fn snapshot_json_uses_camel_case_keys() {
        let json = serde_json::to_string(&sample()).expect("serialize");
        assert!(json.contains("\"formatVersion\""), "got: {json}");
        assert!(json.contains("\"generatedAt\""), "got: {json}");
        assert!(json.contains("\"noteSource\""), "got: {json}");
    }

    #[test]
    fn table_kind_serializes_as_screaming_snake_case() {
        let json = serde_json::to_string(&TableKind::MaterializedView).expect("serialize");
        assert_eq!(json, "\"MATERIALIZED_VIEW\"");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

First wire the module so the file compiles at all. Add to `crates/dbx-core/src/lib.rs` alongside the other `pub mod` lines:

```rust
pub mod docs;
```

Create `crates/dbx-core/src/docs/mod.rs`:

```rust
pub mod snapshot;

pub use snapshot::*;
```

Run: `cargo test -p dbx-core docs::snapshot`
Expected: FAIL — `cannot find struct SchemaSnapshot in this scope` and similar for every type.

- [ ] **Step 3: Write the types**

At the top of `crates/dbx-core/src/docs/snapshot.rs`, above the test module:

```rust
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::types::{ColumnInfo, ForeignKeyInfo, IndexInfo};

/// The normalized description of a relational schema. Every documentation
/// output (DBML, HTML, future changelog records) is a serializer over this.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSnapshot {
    /// Guards viewer/data skew. Always 1 for now; bump only on a breaking
    /// change to this model.
    pub format_version: u32,
    pub project: ProjectMeta,
    pub tables: Vec<DocTable>,
    pub relationships: Vec<Relationship>,
    #[serde(default)]
    pub groups: Vec<TableGroup>,
    #[serde(default)]
    pub enums: Vec<DocEnum>,
    #[serde(default)]
    pub warnings: Vec<SnapshotWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub name: String,
    pub database_type: String,
    pub database: Option<String>,
    pub schemas: Vec<String>,
    /// RFC3339.
    pub generated_at: String,
    /// Markdown. Rendered as the documentation landing page.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTable {
    pub schema: Option<String>,
    pub name: String,
    pub kind: TableKind,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    /// References `TableGroup::id`. Populated in Part 2.
    pub group_id: Option<String>,
    /// Merged note: local annotation, else database comment.
    pub note: Option<String>,
    pub note_source: NoteSource,
    /// The database comment a local note is overriding, if any. Shown on
    /// hover so a later `COMMENT ON` improvement is never invisible.
    pub shadowed_note: Option<String>,
    #[serde(default)]
    pub column_notes: BTreeMap<String, ColumnNote>,
    pub estimated_rows: Option<i64>,
    pub view_definition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableGroup {
    /// Stable slug. Survives a display-name change.
    pub id: String,
    pub name: String,
    /// 0..=359. Lightness and chroma are theme-controlled in CSS, so any
    /// hue is legible on both grounds by construction.
    pub hue: u16,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnNote {
    pub note: String,
    pub source: NoteSource,
    pub shadowed: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocEnum {
    pub schema: Option<String>,
    pub name: String,
    pub values: Vec<String>,
    pub note: Option<String>,
    /// True when synthesized from a MySQL inline `ENUM(...)` column rather
    /// than read from a named database type.
    #[serde(default)]
    pub synthesized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub id: String,
    pub name: Option<String>,
    pub from: FieldRef,
    pub to: FieldRef,
    pub cardinality: Cardinality,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldRef {
    pub schema: Option<String>,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TableKind {
    Table,
    View,
    MaterializedView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NoteSource {
    /// Read from a database COMMENT.
    Database,
    /// Authored in DBX, stored in the notes file.
    Local,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Cardinality {
    OneToOne,
    ManyToOne,
}

/// Why a snapshot is less complete than it looks. Rendered as a dismissible
/// banner rather than left for the reader to discover.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SnapshotWarning {
    TableSkipped { table: String, reason: String },
    NoForeignKeyMetadata { engine: String },
    CommentsUnsupported { engine: String },
    OrphanedNotes { count: usize },
    DbmlOmitted { table: String, item: String, reason: String },
}

impl DocTable {
    /// `schema.name` when a schema is present, otherwise bare `name`.
    pub fn qualified_name(&self) -> String {
        match &self.schema {
            Some(schema) if !schema.is_empty() => format!("{schema}.{}", self.name),
            _ => self.name.clone(),
        }
    }
}

impl FieldRef {
    pub fn qualified_table(&self) -> String {
        match &self.schema {
            Some(schema) if !schema.is_empty() => format!("{schema}.{}", self.table),
            _ => self.table.clone(),
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p dbx-core docs::snapshot`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/lib.rs crates/dbx-core/src/docs/
git commit -m "feat(docs): add SchemaSnapshot model"
```

---

## Task 2: Relationship inference

**Files:**
- Create: `crates/dbx-core/src/docs/relations.rs`
- Modify: `crates/dbx-core/src/docs/mod.rs`

**Interfaces:**
- Consumes: `DocTable`, `Relationship`, `FieldRef`, `Cardinality` from Task 1
- Produces: `pub fn build_relationships(tables: &[DocTable]) -> Vec<Relationship>`

This ports the data half of `apps/desktop/src/lib/diagram/erDiagram.ts`. The rule, from `foreignKeySourceCardinality`: a foreign key is `OneToOne` **only** when the source columns contain a unique key (unique index or primary key); otherwise `ManyToOne`.

- [ ] **Step 1: Write the failing test**

Create `crates/dbx-core/src/docs/relations.rs` with only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::docs::{NoteSource, TableKind};
    use crate::types::{ColumnInfo, ForeignKeyInfo, IndexInfo};
    use std::collections::BTreeMap;

    fn column(name: &str, primary: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: "integer".to_string(),
            is_nullable: false,
            is_primary_key: primary,
            ..ColumnInfo::default()
        }
    }

    fn fk(name: &str, column: &str, ref_table: &str, ref_column: &str) -> ForeignKeyInfo {
        ForeignKeyInfo {
            name: name.to_string(),
            column: column.to_string(),
            ref_schema: Some("public".to_string()),
            ref_table: ref_table.to_string(),
            ref_column: ref_column.to_string(),
            on_update: None,
            on_delete: Some("CASCADE".to_string()),
        }
    }

    fn unique_index(name: &str, columns: &[&str]) -> IndexInfo {
        IndexInfo {
            name: name.to_string(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            is_unique: true,
            is_primary: false,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
        }
    }

    fn table(name: &str, columns: Vec<ColumnInfo>, indexes: Vec<IndexInfo>, fks: Vec<ForeignKeyInfo>) -> DocTable {
        DocTable {
            schema: Some("public".to_string()),
            name: name.to_string(),
            kind: TableKind::Table,
            columns,
            indexes,
            foreign_keys: fks,
            group_id: None,
            note: None,
            note_source: NoteSource::None,
            shadowed_note: None,
            column_notes: BTreeMap::new(),
            estimated_rows: None,
            view_definition: None,
        }
    }

    #[test]
    fn plain_foreign_key_is_many_to_one() {
        let tables = vec![
            table("orders", vec![column("id", true), column("user_id", false)], vec![],
                  vec![fk("fk_orders_user", "user_id", "users", "id")]),
            table("users", vec![column("id", true)], vec![], vec![]),
        ];

        let rels = build_relationships(&tables);

        assert_eq!(rels.len(), 1);
        assert_eq!(rels[0].cardinality, Cardinality::ManyToOne);
        assert_eq!(rels[0].from.table, "orders");
        assert_eq!(rels[0].from.column, "user_id");
        assert_eq!(rels[0].to.table, "users");
        assert_eq!(rels[0].to.column, "id");
        assert_eq!(rels[0].on_delete.as_deref(), Some("CASCADE"));
    }

    #[test]
    fn foreign_key_on_a_unique_column_is_one_to_one() {
        let tables = vec![
            table("shipments",
                  vec![column("id", true), column("order_id", false)],
                  vec![unique_index("uq_shipments_order", &["order_id"])],
                  vec![fk("fk_shipments_order", "order_id", "orders", "id")]),
            table("orders", vec![column("id", true)], vec![], vec![]),
        ];

        let rels = build_relationships(&tables);

        assert_eq!(rels.len(), 1);
        assert_eq!(rels[0].cardinality, Cardinality::OneToOne);
    }

    #[test]
    fn foreign_key_on_a_primary_key_column_is_one_to_one() {
        let tables = vec![
            table("user_profiles", vec![column("user_id", true)], vec![],
                  vec![fk("fk_profile_user", "user_id", "users", "id")]),
            table("users", vec![column("id", true)], vec![], vec![]),
        ];

        assert_eq!(build_relationships(&tables)[0].cardinality, Cardinality::OneToOne);
    }

    #[test]
    fn multi_column_unique_index_does_not_make_a_single_column_unique() {
        // uq(a, b) does NOT make `a` alone unique, so the FK stays many-to-one.
        let tables = vec![
            table("order_items",
                  vec![column("order_id", false), column("product_id", false)],
                  vec![unique_index("uq_items", &["order_id", "product_id"])],
                  vec![fk("fk_items_order", "order_id", "orders", "id")]),
            table("orders", vec![column("id", true)], vec![], vec![]),
        ];

        assert_eq!(build_relationships(&tables)[0].cardinality, Cardinality::ManyToOne);
    }

    #[test]
    fn self_referencing_foreign_key_is_supported() {
        let tables = vec![table("categories",
            vec![column("id", true), column("parent_id", false)], vec![],
            vec![fk("fk_cat_parent", "parent_id", "categories", "id")])];

        let rels = build_relationships(&tables);

        assert_eq!(rels.len(), 1);
        assert_eq!(rels[0].from.table, "categories");
        assert_eq!(rels[0].to.table, "categories");
    }

    #[test]
    fn foreign_key_to_an_absent_table_is_dropped() {
        // The target may live outside the selected schema. A dangling edge
        // would render as a relationship to nothing.
        let tables = vec![table("orders", vec![column("user_id", false)], vec![],
            vec![fk("fk_orders_user", "user_id", "users", "id")])];

        assert!(build_relationships(&tables).is_empty());
    }

    #[test]
    fn relationship_ids_are_stable_and_unique() {
        let tables = vec![
            table("orders",
                  vec![column("user_id", false), column("merchant_id", false)], vec![],
                  vec![fk("fk_a", "user_id", "users", "id"),
                       fk("fk_b", "merchant_id", "users", "id")]),
            table("users", vec![column("id", true)], vec![], vec![]),
        ];

        let rels = build_relationships(&tables);
        assert_eq!(rels.len(), 2);
        assert_ne!(rels[0].id, rels[1].id);
        assert_eq!(build_relationships(&tables)[0].id, rels[0].id);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add to `crates/dbx-core/src/docs/mod.rs`:

```rust
pub mod relations;
pub mod snapshot;

pub use relations::build_relationships;
pub use snapshot::*;
```

Run: `cargo test -p dbx-core docs::relations`
Expected: FAIL — `cannot find function build_relationships`.

- [ ] **Step 3: Write the implementation**

At the top of `crates/dbx-core/src/docs/relations.rs`:

```rust
use std::collections::HashSet;

use crate::docs::{Cardinality, DocTable, FieldRef, Relationship};
use crate::types::ForeignKeyInfo;

/// True when `column` alone is guaranteed unique on `table` — either it is a
/// single-column primary key, or a single-column unique index covers it.
///
/// A composite unique index over (a, b) does NOT make `a` unique, which is
/// why the column count is checked.
fn column_is_unique(table: &DocTable, column: &str) -> bool {
    let primary_columns: Vec<&str> =
        table.columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.as_str()).collect();

    if primary_columns.len() == 1 && primary_columns[0] == column {
        return true;
    }

    table
        .indexes
        .iter()
        .any(|index| (index.is_unique || index.is_primary) && index.columns.len() == 1 && index.columns[0] == column)
}

fn cardinality_for(table: &DocTable, foreign_key: &ForeignKeyInfo) -> Cardinality {
    if column_is_unique(table, &foreign_key.column) {
        Cardinality::OneToOne
    } else {
        Cardinality::ManyToOne
    }
}

fn relationship_id(source: &DocTable, foreign_key: &ForeignKeyInfo) -> String {
    [
        source.qualified_name().as_str(),
        if foreign_key.name.is_empty() { "foreign_key" } else { foreign_key.name.as_str() },
        foreign_key.column.as_str(),
        foreign_key.ref_table.as_str(),
        foreign_key.ref_column.as_str(),
    ]
    .join(":")
}

/// Resolve a foreign key's target against the tables actually present.
///
/// Resolution order mirrors SQL's own: an explicit `ref_schema` wins; an
/// unqualified reference resolves inside the source table's own schema;
/// only then do we consider a bare-name match elsewhere — and an ambiguous
/// one is dropped rather than guessed at, because a wrong edge is worse
/// than a missing one.
///
/// A naive first-match-by-name fallback is NOT safe here: a snapshot can
/// hold `tenant_a.users` and `tenant_b.users` at once (the collector
/// flattens every selected schema into one Vec), so it would silently bind
/// foreign keys to the wrong table.
fn find_target<'a>(
    tables: &'a [DocTable],
    source: &DocTable,
    foreign_key: &ForeignKeyInfo,
) -> Option<&'a DocTable> {
    if let Some(ref_schema) = foreign_key.ref_schema.as_deref().filter(|s| !s.is_empty()) {
        if let Some(found) = tables
            .iter()
            .find(|t| t.name == foreign_key.ref_table && t.schema.as_deref() == Some(ref_schema))
        {
            return Some(found);
        }
    }

    if let Some(found) =
        tables.iter().find(|t| t.name == foreign_key.ref_table && t.schema == source.schema)
    {
        return Some(found);
    }

    let mut matches = tables.iter().filter(|t| t.name == foreign_key.ref_table);
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(first)
}

/// Build the relationship set for a snapshot.
///
/// Foreign keys pointing at tables outside the collected set are dropped —
/// the target may live in a schema the user did not select, and a dangling
/// edge renders as a relationship to nothing.
pub fn build_relationships(tables: &[DocTable]) -> Vec<Relationship> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut relationships = Vec::new();

    for source in tables {
        for foreign_key in &source.foreign_keys {
            let Some(target) = find_target(tables, source, foreign_key) else { continue };

            if !source.columns.iter().any(|c| c.name == foreign_key.column) {
                continue;
            }

            let id = relationship_id(source, foreign_key);
            if !seen.insert(id.clone()) {
                continue;
            }

            relationships.push(Relationship {
                id,
                name: (!foreign_key.name.is_empty()).then(|| foreign_key.name.clone()),
                from: FieldRef {
                    schema: source.schema.clone(),
                    table: source.name.clone(),
                    column: foreign_key.column.clone(),
                },
                to: FieldRef {
                    schema: target.schema.clone(),
                    table: target.name.clone(),
                    column: foreign_key.ref_column.clone(),
                },
                cardinality: cardinality_for(source, foreign_key),
                on_update: foreign_key.on_update.clone(),
                on_delete: foreign_key.on_delete.clone(),
            });
        }
    }

    relationships
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p dbx-core docs::relations`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/
git commit -m "feat(docs): infer relationship cardinality from foreign keys"
```

---

## Task 3: OKLCH hue to sRGB hex

**Files:**
- Create: `crates/dbx-core/src/docs/color.rs`
- Modify: `crates/dbx-core/src/docs/mod.rs`

**Interfaces:**
- Produces: `pub fn hue_to_hex(hue: u16) -> String`

DBML's `TableGroup [color: #rrggbb]` needs hex, but groups store a hue. Convert at the theme-neutral lightness `L = 0.55`, `C = 0.15` — the light-theme `--group-c` from the spec — so an exported DBML file opened in dbdocs looks like DBX's light theme.

- [ ] **Step 1: Write the failing test**

Create `crates/dbx-core/src/docs/color.rs` with only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_a_six_digit_lowercase_hex_string() {
        let hex = hue_to_hex(28);
        assert_eq!(hex.len(), 7, "got {hex}");
        assert!(hex.starts_with('#'), "got {hex}");
        assert!(hex[1..].chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "got {hex}");
    }

    #[test]
    fn hue_28_is_a_warm_orange_red() {
        // Sanity check against the group palette: red channel dominates.
        let hex = hue_to_hex(28);
        let r = u8::from_str_radix(&hex[1..3], 16).unwrap();
        let g = u8::from_str_radix(&hex[3..5], 16).unwrap();
        let b = u8::from_str_radix(&hex[5..7], 16).unwrap();
        assert!(r > g && g > b, "expected r > g > b, got {hex}");
    }

    #[test]
    fn hue_148_is_green_dominant() {
        let hex = hue_to_hex(148);
        let r = u8::from_str_radix(&hex[1..3], 16).unwrap();
        let g = u8::from_str_radix(&hex[3..5], 16).unwrap();
        assert!(g > r, "expected green to dominate, got {hex}");
    }

    #[test]
    fn every_hue_is_in_range_and_never_panics() {
        for hue in 0..=359u16 {
            let hex = hue_to_hex(hue);
            assert_eq!(hex.len(), 7, "hue {hue} produced {hex}");
        }
    }

    #[test]
    fn hue_wraps_past_360() {
        assert_eq!(hue_to_hex(0), hue_to_hex(360));
        assert_eq!(hue_to_hex(28), hue_to_hex(388));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod color;` and `pub use color::hue_to_hex;` to `crates/dbx-core/src/docs/mod.rs`.

Run: `cargo test -p dbx-core docs::color`
Expected: FAIL — `cannot find function hue_to_hex`.

- [ ] **Step 3: Write the implementation**

At the top of `crates/dbx-core/src/docs/color.rs`:

```rust
/// Lightness and chroma of the light-theme `--group-c` token. Only hue
/// varies per group, which is what guarantees legible contrast.
const GROUP_LIGHTNESS: f64 = 0.55;
const GROUP_CHROMA: f64 = 0.15;

fn linear_to_srgb(channel: f64) -> f64 {
    if channel <= 0.003_130_8 {
        12.92 * channel
    } else {
        1.055 * channel.powf(1.0 / 2.4) - 0.055
    }
}

fn to_byte(channel: f64) -> u8 {
    (linear_to_srgb(channel).clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Convert a group hue to the sRGB hex DBML expects.
///
/// OKLCH -> OKLab -> LMS -> linear sRGB -> gamma-encoded sRGB.
/// Coefficients are Björn Ottosson's published OKLab matrices.
pub fn hue_to_hex(hue: u16) -> String {
    let radians = f64::from(hue % 360) * std::f64::consts::PI / 180.0;
    let a = GROUP_CHROMA * radians.cos();
    let b = GROUP_CHROMA * radians.sin();

    let l_ = GROUP_LIGHTNESS + 0.396_337_777_4 * a + 0.215_803_757_3 * b;
    let m_ = GROUP_LIGHTNESS - 0.105_561_345_8 * a - 0.063_854_172_8 * b;
    let s_ = GROUP_LIGHTNESS - 0.089_484_177_5 * a - 1.291_485_548_0 * b;

    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;

    let red = 4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s;
    let green = -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s;
    let blue = -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701_0 * s;

    format!("#{:02x}{:02x}{:02x}", to_byte(red), to_byte(green), to_byte(blue))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p dbx-core docs::color`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/
git commit -m "feat(docs): convert group hue to sRGB hex for DBML"
```

---

## Task 4: DBML lexical primitives

**Files:**
- Create: `crates/dbx-core/src/docs/dbml.rs`
- Modify: `crates/dbx-core/src/docs/mod.rs`

**Interfaces:**
- Produces (crate-internal): `fn quote_identifier(&str) -> String`, `fn render_note(&str) -> String`, `fn render_default(&ColumnInfo) -> Option<String>`, `fn render_type(&ColumnInfo) -> String`

- [ ] **Step 1: Write the failing test**

Create `crates/dbx-core/src/docs/dbml.rs` with only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ColumnInfo;

    fn col(name: &str, data_type: &str) -> ColumnInfo {
        ColumnInfo { name: name.to_string(), data_type: data_type.to_string(), ..ColumnInfo::default() }
    }

    #[test]
    fn plain_identifiers_are_not_quoted() {
        assert_eq!(quote_identifier("orders"), "orders");
        assert_eq!(quote_identifier("order_items"), "order_items");
        assert_eq!(quote_identifier("_private"), "_private");
        assert_eq!(quote_identifier("t2"), "t2");
    }

    #[test]
    fn irregular_identifiers_are_quoted() {
        assert_eq!(quote_identifier("order items"), "\"order items\"");
        assert_eq!(quote_identifier("2fast"), "\"2fast\"");
        assert_eq!(quote_identifier("user-profile"), "\"user-profile\"");
        assert_eq!(quote_identifier(""), "\"\"");
    }

    #[test]
    fn embedded_double_quotes_are_escaped() {
        assert_eq!(quote_identifier("we\"ird"), "\"we\\\"ird\"");
    }

    #[test]
    fn notes_always_use_triple_quotes_so_apostrophes_are_safe() {
        assert_eq!(render_note("Bob's orders"), "'''Bob's orders'''");
    }

    #[test]
    fn notes_escape_a_literal_triple_quote() {
        assert_eq!(render_note("a ''' b"), "'''a \\''' b'''");
    }

    #[test]
    fn multiline_notes_are_preserved() {
        assert_eq!(render_note("line one\nline two"), "'''line one\nline two'''");
    }

    #[test]
    fn expression_defaults_use_backticks_and_literals_use_quotes() {
        let mut expression = col("created_at", "timestamptz");
        expression.column_default = Some("now()".to_string());
        assert_eq!(render_default(&expression).as_deref(), Some("default: `now()`"));

        let mut sequence = col("id", "integer");
        sequence.column_default = Some("nextval('orders_id_seq'::regclass)".to_string());
        assert_eq!(render_default(&sequence).as_deref(), Some("default: `nextval('orders_id_seq'::regclass)`"));

        let mut literal = col("status", "text");
        literal.column_default = Some("'pending'".to_string());
        assert_eq!(render_default(&literal).as_deref(), Some("default: 'pending'"));

        let mut number = col("qty", "integer");
        number.column_default = Some("0".to_string());
        assert_eq!(render_default(&number).as_deref(), Some("default: 0"));

        let mut boolean = col("active", "boolean");
        boolean.column_default = Some("true".to_string());
        assert_eq!(render_default(&boolean).as_deref(), Some("default: true"));

        assert_eq!(render_default(&col("plain", "text")), None);
    }

    #[test]
    fn types_pass_through_verbatim_when_already_parameterised() {
        assert_eq!(render_type(&col("total", "numeric(10,2)")), "numeric(10,2)");
        assert_eq!(render_type(&col("meta", "jsonb")), "jsonb");
        assert_eq!(render_type(&col("at", "timestamp with time zone")), "timestamp with time zone");
    }

    #[test]
    fn bare_types_are_reconstructed_from_precision_metadata() {
        let mut varchar = col("email", "character varying");
        varchar.character_maximum_length = Some(255);
        assert_eq!(render_type(&varchar), "character varying(255)");

        let mut decimal = col("total", "numeric");
        decimal.numeric_precision = Some(10);
        decimal.numeric_scale = Some(2);
        assert_eq!(render_type(&decimal), "numeric(10,2)");

        let mut integer = col("count", "numeric");
        integer.numeric_precision = Some(8);
        integer.numeric_scale = Some(0);
        assert_eq!(render_type(&integer), "numeric(8)");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod dbml;` to `crates/dbx-core/src/docs/mod.rs`.

Run: `cargo test -p dbx-core docs::dbml`
Expected: FAIL — `cannot find function quote_identifier`.

- [ ] **Step 3: Write the implementation**

At the top of `crates/dbx-core/src/docs/dbml.rs`:

```rust
use crate::types::ColumnInfo;

/// DBML accepts bare identifiers matching `[A-Za-z_][A-Za-z0-9_]*`;
/// everything else needs double quotes.
pub(crate) fn quote_identifier(value: &str) -> String {
    let plain = !value.is_empty()
        && value.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');

    if plain {
        value.to_string()
    } else {
        format!("\"{}\"", value.replace('"', "\\\""))
    }
}

/// Notes always use triple quotes so an apostrophe in prose can never break
/// the file.
///
/// Two things need escaping. A literal `'''` inside the prose, obviously —
/// and also a SINGLE trailing quote, which is subtler: the note `he said '`
/// would otherwise render as `'''he said ''''`, four quotes in a row, and a
/// parser scanning for the closing `'''` would close early and strand the
/// fourth. DBML honours `\'` inside triple quotes.
pub(crate) fn render_note(value: &str) -> String {
    let escaped = value.replace("'''", "\\'''");
    let escaped = match escaped.strip_suffix('\'') {
        Some(head) => format!("{head}\\'"),
        None => escaped,
    };
    format!("'''{escaped}'''")
}

fn looks_like_expression(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2 {
        return false;
    }
    if trimmed.parse::<f64>().is_ok() {
        return false;
    }
    if matches!(trimmed.to_ascii_lowercase().as_str(), "true" | "false" | "null") {
        return false;
    }
    true
}

/// `default: …` for a column, or None when it has no default.
/// Expressions go in backticks, literals stay as written.
pub(crate) fn render_default(column: &ColumnInfo) -> Option<String> {
    let value = column.column_default.as_deref()?.trim();
    if value.is_empty() {
        return None;
    }

    if looks_like_expression(value) {
        Some(format!("default: `{value}`"))
    } else {
        Some(format!("default: {value}"))
    }
}

/// DBML does not validate type names, so native types pass through intact.
/// Precision is reconstructed only when the engine reported a bare type.
pub(crate) fn render_type(column: &ColumnInfo) -> String {
    let base = column.data_type.trim();
    if base.contains('(') {
        return base.to_string();
    }

    if let Some(length) = column.character_maximum_length.filter(|value| *value > 0) {
        return format!("{base}({length})");
    }

    if let Some(precision) = column.numeric_precision.filter(|value| *value > 0) {
        return match column.numeric_scale {
            Some(scale) if scale > 0 => format!("{base}({precision},{scale})"),
            _ => format!("{base}({precision})"),
        };
    }

    base.to_string()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p dbx-core docs::dbml`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/
git commit -m "feat(docs): add DBML lexical primitives"
```

---

## Task 5: DBML table blocks

**Files:**
- Modify: `crates/dbx-core/src/docs/dbml.rs`

**Interfaces:**
- Consumes: Task 4 primitives, `DocTable`/`ColumnNote` from Task 1
- Produces (crate-internal): `fn render_table(table: &DocTable, qualify: bool, warnings: &mut Vec<SnapshotWarning>) -> String`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `crates/dbx-core/src/docs/dbml.rs`:

```rust
    use crate::docs::{ColumnNote, DocTable, NoteSource, SnapshotWarning, TableKind};
    use crate::types::IndexInfo;
    use std::collections::BTreeMap;

    fn doc_table(name: &str, columns: Vec<ColumnInfo>, indexes: Vec<IndexInfo>) -> DocTable {
        DocTable {
            schema: Some("public".to_string()),
            name: name.to_string(),
            kind: TableKind::Table,
            columns,
            indexes,
            foreign_keys: vec![],
            group_id: None,
            note: None,
            note_source: NoteSource::None,
            shadowed_note: None,
            column_notes: BTreeMap::new(),
            estimated_rows: None,
            view_definition: None,
        }
    }

    #[test]
    fn renders_a_table_with_columns_and_settings() {
        let mut id = col("id", "integer");
        id.is_primary_key = true;
        id.extra = Some("auto_increment".to_string());

        let mut user_id = col("user_id", "integer");
        user_id.is_nullable = false;

        // ColumnInfo::default() gives is_nullable=false (i.e. NOT NULL), so a
        // genuinely nullable column has to say so explicitly.
        let mut nullable = col("shipped_at", "timestamptz");
        nullable.is_nullable = true;

        let mut table = doc_table("orders", vec![id, user_id, nullable], vec![]);
        table.note = Some("Checkout rows.".to_string());
        table.column_notes.insert(
            "user_id".to_string(),
            ColumnNote { note: "Owning customer".to_string(), source: NoteSource::Local, shadowed: None },
        );

        let mut warnings = Vec::new();
        let out = render_table(&table, false, &mut warnings);

        assert!(out.starts_with("Table orders {\n"), "got:\n{out}");
        assert!(out.contains("id integer [pk, increment]"), "got:\n{out}");
        assert!(out.contains("user_id integer [not null, note: '''Owning customer''']"), "got:\n{out}");
        assert!(out.contains("shipped_at timestamptz\n"), "got:\n{out}");
        assert!(out.contains("Note: '''Checkout rows.'''"), "got:\n{out}");
        assert!(out.ends_with("}\n"), "got:\n{out}");
    }

    #[test]
    fn qualifies_the_table_name_when_requested() {
        let table = doc_table("orders", vec![col("id", "integer")], vec![]);
        let mut warnings = Vec::new();
        assert!(render_table(&table, true, &mut warnings).starts_with("Table public.orders {"));
    }

    #[test]
    fn renders_an_indexes_block() {
        let index = IndexInfo {
            name: "idx_orders_user_placed".to_string(),
            columns: vec!["user_id".to_string(), "placed_at".to_string()],
            is_unique: false,
            is_primary: false,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
        };
        let table = doc_table("orders", vec![col("user_id", "integer")], vec![index]);

        let mut warnings = Vec::new();
        let out = render_table(&table, false, &mut warnings);

        assert!(out.contains("Indexes {"), "got:\n{out}");
        assert!(out.contains("(user_id, placed_at) [name: 'idx_orders_user_placed']"), "got:\n{out}");
        assert!(warnings.is_empty());
    }

    #[test]
    fn a_unique_index_carries_the_unique_setting() {
        let index = IndexInfo {
            name: "uq_orders_ref".to_string(),
            columns: vec!["reference".to_string()],
            is_unique: true,
            is_primary: false,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
        };
        let table = doc_table("orders", vec![col("reference", "text")], vec![index]);
        let mut warnings = Vec::new();
        let out = render_table(&table, false, &mut warnings);
        assert!(out.contains("(reference) [name: 'uq_orders_ref', unique]"), "got:\n{out}");
    }

    #[test]
    fn the_primary_key_index_is_skipped_because_columns_already_carry_pk() {
        let index = IndexInfo {
            name: "orders_pkey".to_string(),
            columns: vec!["id".to_string()],
            is_unique: true,
            is_primary: true,
            filter: None,
            index_type: None,
            included_columns: None,
            comment: None,
        };
        let mut id = col("id", "integer");
        id.is_primary_key = true;
        let table = doc_table("orders", vec![id], vec![index]);

        let mut warnings = Vec::new();
        let out = render_table(&table, false, &mut warnings);
        assert!(!out.contains("orders_pkey"), "got:\n{out}");
    }

    #[test]
    fn a_filtered_index_is_omitted_and_warned_about() {
        let index = IndexInfo {
            name: "idx_orders_open".to_string(),
            columns: vec!["status".to_string()],
            is_unique: false,
            is_primary: false,
            filter: Some("status <> 'cancelled'".to_string()),
            index_type: None,
            included_columns: None,
            comment: None,
        };
        let table = doc_table("orders", vec![col("status", "text")], vec![index]);

        let mut warnings = Vec::new();
        let out = render_table(&table, false, &mut warnings);

        assert!(!out.contains("idx_orders_open"), "filtered index must not be emitted, got:\n{out}");
        assert_eq!(warnings.len(), 1);
        match &warnings[0] {
            SnapshotWarning::DbmlOmitted { table, item, reason } => {
                assert_eq!(table, "public.orders");
                assert_eq!(item, "idx_orders_open");
                assert!(reason.contains("filter"), "got {reason}");
            }
            other => panic!("unexpected warning: {other:?}"),
        }
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core docs::dbml`
Expected: FAIL — `cannot find function render_table`.

- [ ] **Step 3: Write the implementation**

Add to `crates/dbx-core/src/docs/dbml.rs` (extend the existing `use` lines at the top):

```rust
use crate::docs::{DocTable, SnapshotWarning};
use crate::types::IndexInfo;

fn column_settings(column: &ColumnInfo, table: &DocTable) -> Vec<String> {
    let mut settings = Vec::new();

    if column.is_primary_key {
        settings.push("pk".to_string());
    }

    let extra = column.extra.as_deref().unwrap_or("").to_ascii_lowercase();
    if extra.contains("auto_increment") || extra.contains("identity") {
        settings.push("increment".to_string());
    }

    if !column.is_nullable && !column.is_primary_key {
        settings.push("not null".to_string());
    }

    if let Some(default) = render_default(column) {
        settings.push(default);
    }

    if let Some(note) = table.column_notes.get(&column.name) {
        settings.push(format!("note: {}", render_note(&note.note)));
    } else if let Some(comment) = column.comment.as_deref().filter(|value| !value.trim().is_empty()) {
        settings.push(format!("note: {}", render_note(comment)));
    }

    settings
}

fn render_index(index: &IndexInfo) -> String {
    let columns =
        index.columns.iter().map(|c| quote_identifier(c)).collect::<Vec<_>>().join(", ");

    let mut settings = vec![format!("name: '{}'", index.name.replace('\'', "\\'"))];
    if index.is_unique {
        settings.push("unique".to_string());
    }

    format!("    ({columns}) [{}]\n", settings.join(", "))
}

/// Render one `Table` block.
///
/// The primary-key index is skipped because columns already carry `pk`.
/// Indexes DBML cannot express are skipped and recorded in `warnings`
/// rather than dropped silently.
pub(crate) fn render_table(table: &DocTable, qualify: bool, warnings: &mut Vec<SnapshotWarning>) -> String {
    let name = if qualify {
        match table.schema.as_deref().filter(|s| !s.is_empty()) {
            Some(schema) => format!("{}.{}", quote_identifier(schema), quote_identifier(&table.name)),
            None => quote_identifier(&table.name),
        }
    } else {
        quote_identifier(&table.name)
    };

    let mut out = format!("Table {name} {{\n");

    for column in &table.columns {
        let settings = column_settings(column, table);
        let rendered_settings =
            if settings.is_empty() { String::new() } else { format!(" [{}]", settings.join(", ")) };
        out.push_str(&format!(
            "  {} {}{}\n",
            quote_identifier(&column.name),
            render_type(column),
            rendered_settings
        ));
    }

    let emittable: Vec<&IndexInfo> = table
        .indexes
        .iter()
        .filter(|index| {
            if index.is_primary {
                return false;
            }
            if index.filter.as_deref().is_some_and(|f| !f.trim().is_empty()) {
                warnings.push(SnapshotWarning::DbmlOmitted {
                    table: table.qualified_name(),
                    item: index.name.clone(),
                    reason: "partial index filter has no DBML equivalent".to_string(),
                });
                return false;
            }
            if index.included_columns.as_ref().is_some_and(|columns| !columns.is_empty()) {
                warnings.push(SnapshotWarning::DbmlOmitted {
                    table: table.qualified_name(),
                    item: index.name.clone(),
                    reason: "included columns have no DBML equivalent".to_string(),
                });
                return false;
            }
            !index.columns.is_empty()
        })
        .collect();

    if !emittable.is_empty() {
        out.push_str("\n  Indexes {\n");
        for index in emittable {
            out.push_str(&render_index(index));
        }
        out.push_str("  }\n");
    }

    if let Some(note) = table.note.as_deref().filter(|value| !value.trim().is_empty()) {
        out.push_str(&format!("\n  Note: {}\n", render_note(note)));
    }

    out.push_str("}\n");
    out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p dbx-core docs::dbml`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/
git commit -m "feat(docs): render DBML table blocks"
```

---

## Task 6: DBML refs, enums and table groups

**Files:**
- Modify: `crates/dbx-core/src/docs/dbml.rs`

**Interfaces:**
- Produces (crate-internal): `fn render_ref(&Relationship, bool) -> String`, `fn render_enum(&DocEnum, bool) -> String`, `fn render_group(&TableGroup, &[&DocTable], bool) -> String`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `crates/dbx-core/src/docs/dbml.rs`:

```rust
    use crate::docs::{Cardinality, DocEnum, FieldRef, Relationship, TableGroup};

    fn relationship(cardinality: Cardinality) -> Relationship {
        Relationship {
            id: "r1".to_string(),
            name: Some("fk_orders_user".to_string()),
            from: FieldRef {
                schema: Some("public".to_string()),
                table: "orders".to_string(),
                column: "user_id".to_string(),
            },
            to: FieldRef {
                schema: Some("public".to_string()),
                table: "users".to_string(),
                column: "id".to_string(),
            },
            cardinality,
            on_update: None,
            on_delete: Some("CASCADE".to_string()),
        }
    }

    #[test]
    fn many_to_one_uses_the_gt_operator() {
        let out = render_ref(&relationship(Cardinality::ManyToOne), false);
        assert_eq!(out, "Ref fk_orders_user: orders.user_id > users.id [delete: cascade]\n");
    }

    #[test]
    fn one_to_one_uses_the_dash_operator() {
        let out = render_ref(&relationship(Cardinality::OneToOne), false);
        assert!(out.contains("orders.user_id - users.id"), "got {out}");
    }

    #[test]
    fn refs_qualify_both_sides_together() {
        let out = render_ref(&relationship(Cardinality::ManyToOne), true);
        assert!(out.contains("public.orders.user_id > public.users.id"), "got {out}");
    }

    #[test]
    fn referential_actions_are_lowercased_and_both_emitted() {
        let mut rel = relationship(Cardinality::ManyToOne);
        rel.on_update = Some("NO ACTION".to_string());
        rel.on_delete = Some("RESTRICT".to_string());
        let out = render_ref(&rel, false);
        assert!(out.contains("[update: no action, delete: restrict]"), "got {out}");
    }

    #[test]
    fn an_unnamed_ref_omits_the_name() {
        let mut rel = relationship(Cardinality::ManyToOne);
        rel.name = None;
        assert!(render_ref(&rel, false).starts_with("Ref: orders.user_id"), "got {}", render_ref(&rel, false));
    }

    #[test]
    fn renders_an_enum_block() {
        let value = DocEnum {
            schema: Some("public".to_string()),
            name: "order_status".to_string(),
            values: vec!["pending".to_string(), "shipped".to_string()],
            note: None,
            synthesized: false,
        };
        let out = render_enum(&value, false);
        assert_eq!(out, "Enum order_status {\n  pending\n  shipped\n}\n");
    }

    #[test]
    fn renders_a_table_group_with_colour_and_note() {
        let group = TableGroup {
            id: "order-management".to_string(),
            name: "Order Management".to_string(),
            hue: 28,
            note: Some("Checkout to carrier handoff.".to_string()),
        };
        let orders = doc_table("orders", vec![], vec![]);
        let items = doc_table("order_items", vec![], vec![]);

        let out = render_group(&group, &[&orders, &items], false);

        assert!(out.starts_with("TableGroup \"Order Management\" [color: #"), "got:\n{out}");
        assert!(out.contains("\n  orders\n"), "got:\n{out}");
        assert!(out.contains("\n  order_items\n"), "got:\n{out}");
        assert!(out.contains("Note: '''Checkout to carrier handoff.'''"), "got:\n{out}");
    }

    #[test]
    fn an_empty_group_renders_nothing() {
        let group = TableGroup {
            id: "empty".to_string(),
            name: "Empty".to_string(),
            hue: 0,
            note: None,
        };
        assert_eq!(render_group(&group, &[], false), "");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core docs::dbml`
Expected: FAIL — `cannot find function render_ref`.

- [ ] **Step 3: Write the implementation**

Add to `crates/dbx-core/src/docs/dbml.rs`. Extend the top `use crate::docs::{…}` line so it reads:

```rust
use crate::docs::{Cardinality, DocEnum, DocTable, FieldRef, Relationship, SnapshotWarning, TableGroup};
use crate::docs::color::hue_to_hex;
```

```rust
fn qualified_field(field: &FieldRef, qualify: bool) -> String {
    let table = if qualify {
        match field.schema.as_deref().filter(|s| !s.is_empty()) {
            Some(schema) => format!("{}.{}", quote_identifier(schema), quote_identifier(&field.table)),
            None => quote_identifier(&field.table),
        }
    } else {
        quote_identifier(&field.table)
    };
    format!("{table}.{}", quote_identifier(&field.column))
}

/// One `Ref` line. `>` is many-to-one, `-` is one-to-one.
pub(crate) fn render_ref(relationship: &Relationship, qualify: bool) -> String {
    let operator = match relationship.cardinality {
        Cardinality::ManyToOne => ">",
        Cardinality::OneToOne => "-",
    };

    let mut actions = Vec::new();
    if let Some(update) = relationship.on_update.as_deref().filter(|v| !v.trim().is_empty()) {
        actions.push(format!("update: {}", update.to_lowercase()));
    }
    if let Some(delete) = relationship.on_delete.as_deref().filter(|v| !v.trim().is_empty()) {
        actions.push(format!("delete: {}", delete.to_lowercase()));
    }
    let settings = if actions.is_empty() { String::new() } else { format!(" [{}]", actions.join(", ")) };

    let label = match relationship.name.as_deref().filter(|v| !v.trim().is_empty()) {
        Some(name) => format!("Ref {}", quote_identifier(name)),
        None => "Ref".to_string(),
    };

    format!(
        "{label}: {} {operator} {}{settings}\n",
        qualified_field(&relationship.from, qualify),
        qualified_field(&relationship.to, qualify)
    )
}

pub(crate) fn render_enum(value: &DocEnum, qualify: bool) -> String {
    let name = if qualify {
        match value.schema.as_deref().filter(|s| !s.is_empty()) {
            Some(schema) => format!("{}.{}", quote_identifier(schema), quote_identifier(&value.name)),
            None => quote_identifier(&value.name),
        }
    } else {
        quote_identifier(&value.name)
    };

    let mut out = format!("Enum {name} {{\n");
    for variant in &value.values {
        out.push_str(&format!("  {}\n", quote_identifier(variant)));
    }
    if let Some(note) = value.note.as_deref().filter(|v| !v.trim().is_empty()) {
        out.push_str(&format!("\n  Note: {}\n", render_note(note)));
    }
    out.push_str("}\n");
    out
}

/// A `TableGroup` block. Returns an empty string when the group has no
/// members, since DBML rejects an empty group body.
pub(crate) fn render_group(group: &TableGroup, members: &[&DocTable], qualify: bool) -> String {
    if members.is_empty() {
        return String::new();
    }

    let mut out =
        format!("TableGroup {} [color: {}] {{\n", quote_identifier(&group.name), hue_to_hex(group.hue));

    for member in members {
        let name = if qualify {
            match member.schema.as_deref().filter(|s| !s.is_empty()) {
                Some(schema) => format!("{}.{}", quote_identifier(schema), quote_identifier(&member.name)),
                None => quote_identifier(&member.name),
            }
        } else {
            quote_identifier(&member.name)
        };
        out.push_str(&format!("  {name}\n"));
    }

    if let Some(note) = group.note.as_deref().filter(|v| !v.trim().is_empty()) {
        out.push_str(&format!("\n  Note: {}\n", render_note(note)));
    }

    out.push_str("}\n");
    out
}
```

Note: `quote_identifier("Order Management")` yields `"Order Management"` with quotes, which is what the test asserts.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p dbx-core docs::dbml`
Expected: PASS, 23 tests.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/
git commit -m "feat(docs): render DBML refs, enums and table groups"
```

---

## Task 7: Full DBML document assembly

**Files:**
- Modify: `crates/dbx-core/src/docs/dbml.rs`
- Modify: `crates/dbx-core/src/docs/mod.rs`

**Interfaces:**
- Produces: `pub fn to_dbml(snapshot: &SchemaSnapshot) -> DbmlOutput` where `pub struct DbmlOutput { pub text: String, pub warnings: Vec<SnapshotWarning> }`

Schema qualification is decided here: bare names for a single-schema snapshot (it reads better), fully qualified when more than one schema is present.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `crates/dbx-core/src/docs/dbml.rs`:

```rust
    use crate::docs::{ProjectMeta, SchemaSnapshot};

    fn snapshot(tables: Vec<DocTable>, schemas: Vec<&str>) -> SchemaSnapshot {
        SchemaSnapshot {
            format_version: 1,
            project: ProjectMeta {
                name: "Ecommerce".to_string(),
                database_type: "PostgreSQL".to_string(),
                database: Some("shop".to_string()),
                schemas: schemas.into_iter().map(str::to_string).collect(),
                generated_at: "2026-08-02T12:00:00Z".to_string(),
                note: Some("Storefront database.".to_string()),
            },
            tables,
            relationships: vec![],
            groups: vec![],
            enums: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn emits_a_project_block_first() {
        let out = to_dbml(&snapshot(vec![], vec!["public"]));
        assert!(out.text.starts_with("Project Ecommerce {\n"), "got:\n{}", out.text);
        assert!(out.text.contains("database_type: 'PostgreSQL'"), "got:\n{}", out.text);
        assert!(out.text.contains("Note: '''Storefront database.'''"), "got:\n{}", out.text);
    }

    #[test]
    fn a_single_schema_snapshot_uses_bare_table_names() {
        let out = to_dbml(&snapshot(vec![doc_table("orders", vec![col("id", "integer")], vec![])], vec!["public"]));
        assert!(out.text.contains("Table orders {"), "got:\n{}", out.text);
        assert!(!out.text.contains("Table public.orders"), "got:\n{}", out.text);
    }

    #[test]
    fn a_multi_schema_snapshot_qualifies_every_table() {
        let mut analytics = doc_table("daily_sales", vec![col("id", "integer")], vec![]);
        analytics.schema = Some("analytics".to_string());

        let out = to_dbml(&snapshot(
            vec![doc_table("orders", vec![col("id", "integer")], vec![]), analytics],
            vec!["public", "analytics"],
        ));

        assert!(out.text.contains("Table public.orders {"), "got:\n{}", out.text);
        assert!(out.text.contains("Table analytics.daily_sales {"), "got:\n{}", out.text);
    }

    #[test]
    fn sections_appear_in_order_project_enums_groups_tables_refs() {
        let mut snap = snapshot(vec![doc_table("orders", vec![col("id", "integer")], vec![])], vec!["public"]);
        snap.enums.push(DocEnum {
            schema: Some("public".to_string()),
            name: "order_status".to_string(),
            values: vec!["pending".to_string()],
            note: None,
            synthesized: false,
        });
        snap.groups.push(TableGroup {
            id: "order-management".to_string(),
            name: "Order Management".to_string(),
            hue: 28,
            note: None,
        });
        snap.tables[0].group_id = Some("order-management".to_string());
        snap.relationships.push(relationship(Cardinality::ManyToOne));

        let text = to_dbml(&snap).text;
        let project = text.find("Project ").expect("project");
        let enum_at = text.find("Enum ").expect("enum");
        let group = text.find("TableGroup ").expect("group");
        let table = text.find("Table orders").expect("table");
        let reference = text.find("Ref ").expect("ref");

        assert!(project < enum_at, "project before enums:\n{text}");
        assert!(enum_at < group, "enums before groups:\n{text}");
        assert!(group < table, "groups before tables:\n{text}");
        assert!(table < reference, "tables before refs:\n{text}");
    }

    #[test]
    fn warnings_from_table_rendering_reach_the_output() {
        let index = IndexInfo {
            name: "idx_partial".to_string(),
            columns: vec!["status".to_string()],
            is_unique: false,
            is_primary: false,
            filter: Some("status <> 'x'".to_string()),
            index_type: None,
            included_columns: None,
            comment: None,
        };
        let out = to_dbml(&snapshot(vec![doc_table("orders", vec![col("status", "text")], vec![index])], vec!["public"]));
        assert_eq!(out.warnings.len(), 1);
    }

    #[test]
    fn a_group_referencing_a_missing_table_is_skipped() {
        let mut snap = snapshot(vec![doc_table("orders", vec![col("id", "integer")], vec![])], vec!["public"]);
        snap.groups.push(TableGroup {
            id: "ghost".to_string(),
            name: "Ghost".to_string(),
            hue: 200,
            note: None,
        });
        assert!(!to_dbml(&snap).text.contains("Ghost"), "got:\n{}", to_dbml(&snap).text);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core docs::dbml`
Expected: FAIL — `cannot find function to_dbml`.

- [ ] **Step 3: Write the implementation**

Add to `crates/dbx-core/src/docs/dbml.rs` (extend the `use crate::docs::{…}` line with `SchemaSnapshot`):

```rust
/// DBML text plus every construct that could not be represented in it.
#[derive(Debug, Clone)]
pub struct DbmlOutput {
    pub text: String,
    pub warnings: Vec<SnapshotWarning>,
}

fn render_project(snapshot: &SchemaSnapshot) -> String {
    let mut out = format!("Project {} {{\n", quote_identifier(&snapshot.project.name));
    out.push_str(&format!(
        "  database_type: '{}'\n",
        snapshot.project.database_type.replace('\'', "\\'")
    ));
    if let Some(note) = snapshot.project.note.as_deref().filter(|v| !v.trim().is_empty()) {
        out.push_str(&format!("  Note: {}\n", render_note(note)));
    }
    out.push_str("}\n");
    out
}

/// Serialize a snapshot to DBML.
///
/// DBML is an interchange format, not a backup: check constraints, partial
/// indexes, included columns, collations and generated columns have no
/// representation. Each omission is reported in `warnings` so the HTML
/// documentation — which *is* the complete record — can mark it.
pub fn to_dbml(snapshot: &SchemaSnapshot) -> DbmlOutput {
    let qualify = snapshot.project.schemas.len() > 1;
    let mut warnings = Vec::new();
    let mut sections: Vec<String> = vec![render_project(snapshot)];

    for value in &snapshot.enums {
        sections.push(render_enum(value, qualify));
    }

    for group in &snapshot.groups {
        let members: Vec<&DocTable> = snapshot
            .tables
            .iter()
            .filter(|table| table.group_id.as_deref() == Some(group.id.as_str()))
            .collect();
        let rendered = render_group(group, &members, qualify);
        if !rendered.is_empty() {
            sections.push(rendered);
        }
    }

    for table in &snapshot.tables {
        sections.push(render_table(table, qualify, &mut warnings));
    }

    if !snapshot.relationships.is_empty() {
        let refs: String =
            snapshot.relationships.iter().map(|rel| render_ref(rel, qualify)).collect();
        sections.push(refs);
    }

    DbmlOutput { text: sections.join("\n"), warnings }
}
```

Add to `crates/dbx-core/src/docs/mod.rs`:

```rust
pub use dbml::{to_dbml, DbmlOutput};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p dbx-core docs::dbml`
Expected: PASS, 29 tests.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/
git commit -m "feat(docs): assemble complete DBML documents"
```

---

## Task 8: Snapshot collector

**Files:**
- Create: `crates/dbx-core/src/docs/collector.rs`
- Modify: `crates/dbx-core/src/docs/mod.rs`

**Interfaces:**
- Produces:
  - `pub struct CollectOptions { pub database: String, pub schemas: Vec<String>, pub tables: Vec<String>, pub project_name: String }`
  - `pub struct CollectProgress { pub completed: usize, pub total: usize, pub current: String }`
  - `pub async fn collect_snapshot(state: &AppState, connection: &ConnectionConfig, options: &CollectOptions, progress: &(dyn Fn(CollectProgress) + Send + Sync), cancel: &AtomicBool) -> Result<SchemaSnapshot, String>`

**Verified metadata API** (`crates/dbx-core/src/schema.rs` — note this is a 357 KB module file paired with the `schema/` directory, and `db::*` re-exports `crate::types::*`, so `db::ColumnInfo` and `crate::types::ColumnInfo` are the same type):

```rust
schema::list_schemas_core(state, connection_id, database)                          -> Vec<String>
schema::list_tables_core(state, connection_id, database, schema,
                         filter, limit, offset, object_types, table_name_filter)   -> Vec<db::TableInfo>
schema::get_columns_core(state, connection_id, database, schema, table)            -> Vec<db::ColumnInfo>
schema::list_indexes_core(state, connection_id, database, schema, table)           -> Vec<db::IndexInfo>
schema::list_foreign_keys_core(state, connection_id, database, schema, table)      -> Vec<db::ForeignKeyInfo>
```

These take `&AppState` and a connection id — **not** a pool. They also wrap `retry_metadata_connection` internally, so the collector inherits reconnect-on-drop for free and must not add its own retry layer.

Fan-out is bounded at 8 concurrent table fetches. This is the naive-but-correct version by design: it works for every relational engine on day one because it reuses providers already proven against all of them. Per-engine bulk `information_schema` sweeps come later, only where a benchmark justifies them.

- [ ] **Step 1: Write the failing test**

Create `crates/dbx-core/src/docs/collector.rs` with only this test module. These tests cover the pure helpers; end-to-end collection is covered by the live test in Task 12.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_kind_maps_from_the_engine_reported_type() {
        assert_eq!(table_kind_from("TABLE"), TableKind::Table);
        assert_eq!(table_kind_from("BASE TABLE"), TableKind::Table);
        assert_eq!(table_kind_from("VIEW"), TableKind::View);
        assert_eq!(table_kind_from("MATERIALIZED VIEW"), TableKind::MaterializedView);
        assert_eq!(table_kind_from("materialized_view"), TableKind::MaterializedView);
        assert_eq!(table_kind_from("something else"), TableKind::Table);
    }

    #[test]
    fn table_filter_is_empty_means_include_everything() {
        let options = CollectOptions {
            database: "shop".to_string(),
            schemas: vec!["public".to_string()],
            tables: vec![],
            project_name: "Ecommerce".to_string(),
        };
        assert!(options.includes_table("public", "orders"));
        assert!(options.includes_table("public", "anything"));
    }

    #[test]
    fn table_filter_matches_bare_and_qualified_names() {
        let options = CollectOptions {
            database: "shop".to_string(),
            schemas: vec!["public".to_string()],
            tables: vec!["orders".to_string(), "analytics.daily_sales".to_string()],
            project_name: "Ecommerce".to_string(),
        };
        assert!(options.includes_table("public", "orders"));
        assert!(options.includes_table("analytics", "daily_sales"));
        assert!(!options.includes_table("public", "users"));
        assert!(!options.includes_table("public", "daily_sales"));
    }

    #[test]
    fn synthesises_a_named_enum_from_an_inline_enum_column() {
        let mut column = crate::types::ColumnInfo {
            name: "status".to_string(),
            data_type: "enum".to_string(),
            ..Default::default()
        };
        column.enum_values = Some(vec!["pending".to_string(), "shipped".to_string()]);

        let synthesized = synthesize_enum(Some("public"), "orders", &column).expect("enum");

        assert_eq!(synthesized.name, "orders_status");
        assert_eq!(synthesized.values, vec!["pending", "shipped"]);
        assert!(synthesized.synthesized);
    }

    #[test]
    fn a_column_without_enum_values_synthesises_nothing() {
        let column = crate::types::ColumnInfo {
            name: "status".to_string(),
            data_type: "text".to_string(),
            ..Default::default()
        };
        assert!(synthesize_enum(Some("public"), "orders", &column).is_none());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod collector;` and `pub use collector::{collect_snapshot, CollectOptions, CollectProgress};` to `crates/dbx-core/src/docs/mod.rs`.

Run: `cargo test -p dbx-core docs::collector`
Expected: FAIL — `cannot find function table_kind_from`.

- [ ] **Step 3: Write the implementation**

At the top of `crates/dbx-core/src/docs/collector.rs`:

```rust
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use tokio::sync::Semaphore;

use crate::docs::{
    build_relationships, DocEnum, DocTable, NoteSource, ProjectMeta, SchemaSnapshot, SnapshotWarning, TableKind,
};
use crate::models::connection::ConnectionConfig;
use crate::schema;
use crate::state::AppState; // confirm the real path with: grep -rn "pub struct AppState" crates/dbx-core/src
use crate::table_structure_sql::dialect::capabilities_for;
use crate::types::ColumnInfo;

/// Concurrent per-table metadata fetches. Bounded so documenting a large
/// schema cannot starve the connection pool the UI is also using.
const MAX_CONCURRENT_TABLES: usize = 8;

#[derive(Debug, Clone)]
pub struct CollectOptions {
    pub database: String,
    pub schemas: Vec<String>,
    /// Empty means every table. Entries may be bare (`orders`) or
    /// qualified (`analytics.daily_sales`).
    pub tables: Vec<String>,
    pub project_name: String,
}

impl CollectOptions {
    pub fn includes_table(&self, schema: &str, table: &str) -> bool {
        if self.tables.is_empty() {
            return true;
        }
        let qualified = format!("{schema}.{table}");
        self.tables.iter().any(|wanted| wanted == table || wanted == &qualified)
    }
}

#[derive(Debug, Clone)]
pub struct CollectProgress {
    pub completed: usize,
    pub total: usize,
    pub current: String,
}

fn table_kind_from(table_type: &str) -> TableKind {
    let normalized = table_type.trim().to_ascii_uppercase().replace('_', " ");
    match normalized.as_str() {
        "VIEW" => TableKind::View,
        "MATERIALIZED VIEW" => TableKind::MaterializedView,
        _ => TableKind::Table,
    }
}

/// MySQL reports `ENUM('a','b')` inline rather than as a named type.
/// DBML needs a named enum, so synthesize one per table+column.
fn synthesize_enum(schema: Option<&str>, table: &str, column: &ColumnInfo) -> Option<DocEnum> {
    let values = column.enum_values.as_ref().filter(|values| !values.is_empty())?;
    Some(DocEnum {
        schema: schema.map(ToOwned::to_owned),
        name: format!("{table}_{}", column.name),
        values: values.clone(),
        note: None,
        synthesized: true,
    })
}

fn cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

/// Collect a documentation snapshot.
///
/// A per-table failure is recorded as a `TableSkipped` warning and does not
/// abort the run — a permissions gap on one table must not kill a
/// 400-table documentation build.
pub async fn collect_snapshot(
    state: &AppState,
    connection: &ConnectionConfig,
    options: &CollectOptions,
    progress: &(dyn Fn(CollectProgress) + Send + Sync),
    cancel: &AtomicBool,
) -> Result<SchemaSnapshot, String> {
    let mut warnings: Vec<SnapshotWarning> = Vec::new();
    let engine = format!("{:?}", connection.db_type);
    let connection_id = connection.id.as_str();

    if !capabilities_for(connection.db_type).comment {
        warnings.push(SnapshotWarning::CommentsUnsupported { engine: engine.clone() });
    }

    let schemas = if options.schemas.is_empty() {
        schema::list_schemas_core(state, connection_id, &options.database).await.unwrap_or_default()
    } else {
        options.schemas.clone()
    };
    let effective_schemas = if schemas.is_empty() { vec![String::new()] } else { schemas };

    // Enumerate every table first so progress has a real total.
    let mut targets: Vec<(String, crate::types::TableInfo)> = Vec::new();
    for schema_name in &effective_schemas {
        match schema::list_tables_core(state, connection_id, &options.database, schema_name, None, None, None, None, None)
            .await
        {
            Ok(tables) => {
                for info in tables {
                    if options.includes_table(schema_name, &info.name) {
                        targets.push((schema_name.clone(), info));
                    }
                }
            }
            Err(error) => warnings.push(SnapshotWarning::TableSkipped {
                table: format!("{schema_name}.*"),
                reason: error,
            }),
        }
    }

    let total = targets.len();
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_TABLES));

    let collected: Vec<Result<DocTable, SnapshotWarning>> = stream::iter(targets.into_iter().enumerate())
        .map(|(index, (schema_name, info))| {
            let semaphore = Arc::clone(&semaphore);
            let database = options.database.clone();
            async move {
                let _permit = semaphore.acquire().await.map_err(|_| SnapshotWarning::TableSkipped {
                    table: info.name.clone(),
                    reason: "collection cancelled".to_string(),
                })?;

                if cancelled(cancel) {
                    return Err(SnapshotWarning::TableSkipped {
                        table: info.name.clone(),
                        reason: "cancelled".to_string(),
                    });
                }

                progress(CollectProgress {
                    completed: index,
                    total,
                    current: format!("{schema_name}.{}", info.name),
                });

                let columns = schema::get_columns_core(state, connection_id, &database, &schema_name, &info.name)
                    .await
                    .map_err(|error| SnapshotWarning::TableSkipped {
                        table: format!("{schema_name}.{}", info.name),
                        reason: error,
                    })?;

                // Indexes and foreign keys degrade to empty rather than failing
                // the table: ClickHouse and friends have no FK metadata at all.
                let indexes = schema::list_indexes_core(state, connection_id, &database, &schema_name, &info.name)
                    .await
                    .unwrap_or_default();
                let foreign_keys =
                    schema::list_foreign_keys_core(state, connection_id, &database, &schema_name, &info.name)
                        .await
                        .unwrap_or_default();

                Ok(DocTable {
                    schema: (!schema_name.is_empty()).then(|| schema_name.clone()),
                    name: info.name.clone(),
                    kind: table_kind_from(&info.table_type),
                    columns,
                    indexes,
                    foreign_keys,
                    group_id: None,
                    note: info.comment.clone().filter(|value| !value.trim().is_empty()),
                    note_source: if info.comment.as_deref().is_some_and(|v| !v.trim().is_empty()) {
                        NoteSource::Database
                    } else {
                        NoteSource::None
                    },
                    shadowed_note: None,
                    column_notes: BTreeMap::new(),
                    estimated_rows: None,
                    view_definition: None,
                })
            }
        })
        .buffer_unordered(MAX_CONCURRENT_TABLES)
        .collect()
        .await;

    let mut tables = Vec::new();
    for outcome in collected {
        match outcome {
            Ok(table) => tables.push(table),
            Err(warning) => warnings.push(warning),
        }
    }

    tables.sort_by(|a, b| a.qualified_name().cmp(&b.qualified_name()));

    let mut enums: Vec<DocEnum> = Vec::new();
    for table in &tables {
        for column in &table.columns {
            if let Some(value) = synthesize_enum(table.schema.as_deref(), &table.name, column) {
                enums.push(value);
            }
        }
    }

    let relationships = build_relationships(&tables);
    if relationships.is_empty() && tables.iter().any(|t| !t.columns.is_empty()) {
        warnings.push(SnapshotWarning::NoForeignKeyMetadata { engine: engine.clone() });
    }

    progress(CollectProgress { completed: total, total, current: String::new() });

    Ok(SchemaSnapshot {
        format_version: 1,
        project: ProjectMeta {
            name: options.project_name.clone(),
            database_type: engine,
            database: (!options.database.is_empty()).then(|| options.database.clone()),
            schemas: effective_schemas.into_iter().filter(|s| !s.is_empty()).collect(),
            generated_at: chrono::Utc::now().to_rfc3339(),
            note: None,
        },
        tables,
        relationships,
        groups: Vec::new(),
        enums,
        warnings,
    })
}
```

**Two things to verify before writing this file** (both are one command each, and both change the code above if they come back differently):

1. `grep -rn "pub struct AppState" crates/dbx-core/src` — use the real module path in the `use` line.
2. `grep -nE "^futures|^chrono|futures =|chrono =" crates/dbx-core/Cargo.toml` — the code above uses `futures::stream::buffer_unordered` and `chrono::Utc`. **If either is absent, do not add it** (Global Constraints forbid new dependencies). Substitute:
   - no `futures` → drive the fan-out with `tokio::task::JoinSet`, capping in-flight tasks at `MAX_CONCURRENT_TABLES` by draining with `join_next()` before spawning past the cap;
   - no `chrono` → build the RFC3339 timestamp from `std::time::SystemTime::now().duration_since(UNIX_EPOCH)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p dbx-core docs::collector`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify the whole crate still builds**

Run: `cargo check -p dbx-core`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/ crates/dbx-core/src/schema/
git commit -m "feat(docs): collect schema snapshots with bounded fan-out"
```

---

## Task 9: Web route for snapshot collection

**Files:**
- Create: `crates/dbx-web/src/routes/docs.rs`
- Modify: `crates/dbx-web/src/routes/mod.rs` (register the module and route)

**Interfaces:**
- Consumes: `collect_snapshot`, `CollectOptions` from Task 8
- Produces: `POST /api/docs/snapshot` accepting `{ connectionId, database, schemas, tables, projectName }` and returning a `SchemaSnapshot` as JSON

This exists so `WebBackend` (Task 10) makes **one** HTTP call instead of 3×N.

- [ ] **Step 1: Read the neighbouring route to match its shape**

Run: `sed -n '1,60p' crates/dbx-web/src/routes/database_export.rs`

Copy its handler signature, state extractor, error mapping and JSON response conventions exactly. Do not invent a different shape.

- [ ] **Step 2: Write the route**

Create `crates/dbx-web/src/routes/docs.rs` following that shape. The handler must:

1. Deserialize a `DocsSnapshotRequest { connection_id, database, schemas, tables, project_name }` with `#[serde(rename_all = "camelCase")]`.
2. Resolve the `ConnectionConfig` for `connection_id` the same way the neighbouring routes do. The collector takes `&AppState` directly — `state.app`, exactly as `crates/dbx-web/src/routes/schema.rs:41` passes it to `dbx_core::schema::list_databases_core`. **No pool resolution is needed**; the `*_core` functions handle pooling and retry internally.
3. Call:

```rust
let options = dbx_core::docs::CollectOptions {
    database: request.database.clone(),
    schemas: request.schemas.clone(),
    tables: request.tables.clone(),
    project_name: request.project_name.clone().unwrap_or_else(|| connection.name.clone()),
};

let snapshot = dbx_core::docs::collect_snapshot(
    &state.app,
    &connection,
    &options,
    &|_progress| {},
    &std::sync::atomic::AtomicBool::new(false),
)
.await
.map_err(AppError::from)?;
```

4. Return `Json(snapshot)`, matching how `routes/schema.rs` returns its results.

- [ ] **Step 3: Register the route**

Add `pub mod docs;` to `crates/dbx-web/src/routes/mod.rs` and wire `POST /api/docs/snapshot` into the router beside the other `/api/...` routes, matching how `database_export` is registered.

- [ ] **Step 4: Verify it compiles**

Run: `cargo check -p dbx-web`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-web/src/routes/
git commit -m "feat(docs): add snapshot collection route"
```

---

## Task 10: Backend trait method

**Files:**
- Modify: `crates/dbx-mcp/src/backend.rs`

**Interfaces:**
- Produces: `async fn collect_docs_snapshot(&self, connection: &ConnectionConfig, database: &str, options: DocsSnapshotOptions) -> Result<SchemaSnapshot, String>` on `DbxBackend`, with implementations for `LocalBackend` and `WebBackend`

`DbxBackend` currently exposes `list_tables` and `get_columns` but no schemas, indexes or foreign keys. Adding those three separately would make `WebBackend` issue 3×N HTTP requests. One snapshot method keeps it to a single round-trip.

- [ ] **Step 1: Write the failing test**

Append to the existing `#[cfg(test)] mod tests` in `crates/dbx-mcp/src/backend.rs` (or create one following the file's existing conventions):

```rust
    struct StubBackend;

    #[async_trait]
    impl DbxBackend for StubBackend {
        async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
            Err("unused".to_string())
        }
        async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
            Ok(vec![])
        }
        async fn execute_agent_tool(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            _tool_name: &str,
            _arguments: Value,
            _permissions: AgentSqlPermissions,
        ) -> ToolResult {
            unimplemented!("not exercised by this test")
        }
        async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
            Ok(config)
        }
        async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
            Ok(false)
        }
    }

    #[tokio::test]
    async fn collect_docs_snapshot_defaults_to_unsupported() {
        let backend = StubBackend;
        let connection = new_connection_config(
            "c1".to_string(),
            "local".to_string(),
            DatabaseType::Postgres,
            "127.0.0.1".to_string(),
        );

        let result = backend
            .collect_docs_snapshot(&connection, "shop", DocsSnapshotOptions::default())
            .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not supported"));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-mcp collect_docs_snapshot`
Expected: FAIL — `no method named collect_docs_snapshot`.

- [ ] **Step 3: Add the trait method with a default**

Inside `pub trait DbxBackend`, following the pattern of the other optional methods:

```rust
    async fn collect_docs_snapshot(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        options: DocsSnapshotOptions,
    ) -> Result<dbx_core::docs::SchemaSnapshot, String> {
        let _ = (connection, database, options);
        Err("Documentation snapshots are not supported by this backend.".to_string())
    }
```

Above the trait, add the options type:

```rust
/// Wire-level options for a documentation snapshot. Mirrors
/// `dbx_core::docs::CollectOptions` minus the fields the backend fills in.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsSnapshotOptions {
    #[serde(default)]
    pub schemas: Vec<String>,
    #[serde(default)]
    pub tables: Vec<String>,
    #[serde(default)]
    pub project_name: Option<String>,
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p dbx-mcp collect_docs_snapshot`
Expected: PASS.

- [ ] **Step 5: Implement for LocalBackend**

In `impl DbxBackend for LocalBackend`, resolve the pool the same way its `get_columns` does, then:

```rust
    async fn collect_docs_snapshot(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        options: DocsSnapshotOptions,
    ) -> Result<dbx_core::docs::SchemaSnapshot, String> {
        let collect_options = dbx_core::docs::CollectOptions {
            database: database.to_string(),
            schemas: options.schemas,
            tables: options.tables,
            project_name: options.project_name.unwrap_or_else(|| connection.name.clone()),
        };
        dbx_core::docs::collect_snapshot(
            &self.state,
            connection,
            &collect_options,
            &|_progress| {},
            &std::sync::atomic::AtomicBool::new(false),
        )
        .await
    }
```

- [ ] **Step 6: Implement for WebBackend**

In `impl DbxBackend for WebBackend`, POST once to the Task 9 route, following how its other methods build authenticated requests:

```rust
    async fn collect_docs_snapshot(
        &self,
        connection: &ConnectionConfig,
        database: &str,
        options: DocsSnapshotOptions,
    ) -> Result<dbx_core::docs::SchemaSnapshot, String> {
        let body = serde_json::json!({
            "connectionId": connection.id,
            "database": database,
            "schemas": options.schemas,
            "tables": options.tables,
            "projectName": options.project_name.clone().unwrap_or_else(|| connection.name.clone()),
        });
        // Use this impl's existing authenticated-POST helper against
        // "/api/docs/snapshot" and deserialize the response into SchemaSnapshot.
        self.post_json("/api/docs/snapshot", body).await
    }
```

Replace `self.post_json` with whatever helper the impl actually uses — check the neighbouring methods first.

- [ ] **Step 7: Verify everything builds**

Run: `cargo check -p dbx-mcp && cargo test -p dbx-mcp`
Expected: no errors, tests pass.

- [ ] **Step 8: Commit**

```bash
cargo fmt
git add crates/dbx-mcp/src/backend.rs
git commit -m "feat(docs): add collect_docs_snapshot to DbxBackend"
```

---

## Task 11: `dbx dbml` CLI verb

**Files:**
- Modify: `crates/dbx-cli/src/main.rs`

**Interfaces:**
- Consumes: `DbxBackend::collect_docs_snapshot` (Task 10), `dbx_core::docs::to_dbml` (Task 7)
- Produces: `dbx dbml <connection> [--out path] [--schema s] [--database d] [--tables a,b]`

`--out` is a new flag. `--notes` is deliberately **not** added here — it needs the annotation store from Part 2.

- [ ] **Step 1: Write the failing test**

Append to the existing `#[cfg(test)] mod tests` in `crates/dbx-cli/src/main.rs`, matching the style of the existing `parse_flags` tests around line 934:

```rust
    #[test]
    fn parses_the_out_flag() {
        let flags = parse_flags(&args(&["dbml", "local", "--out", "schema.dbml"])).expect("parse");
        assert_eq!(flags.args, args(&["dbml", "local"]));
        assert_eq!(flags.out.as_deref(), Some(std::path::Path::new("schema.dbml")));
    }

    #[test]
    fn out_requires_a_value() {
        let error = parse_flags(&args(&["dbml", "local", "--out"])).expect_err("should fail");
        assert_eq!(error.code, "INVALID_OPTION");
    }

    #[test]
    fn dbml_appears_in_the_usage_text() {
        assert!(usage().contains("dbx dbml <connection>"), "got: {}", usage());
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-cli`
Expected: FAIL — `no field named out on Flags`.

- [ ] **Step 3: Add the flag**

Add `pub out: Option<PathBuf>` to the `Flags` struct, initialise it to `None` in `parse_flags`, and add the match arm beside `--file`:

```rust
            "--out" => flags.out = Some(PathBuf::from(option_value(argv, &mut index, "--out")?)),
```

- [ ] **Step 4: Add the verb dispatch**

In `run_with_backend`, beside the existing `schema` / `query` / `context` checks:

```rust
    if args.first().is_some_and(|arg| arg == "dbml") {
        return run_dbml(backend, &flags).await;
    }
```

And the handler, modelled on `run_context`:

```rust
async fn run_dbml(backend: &dyn DbxBackend, flags: &Flags) -> Result<String, (CliError, bool)> {
    let name = flags.args.get(1).ok_or_else(|| {
        (CliError::new("MISSING_ARGUMENT", "Usage: dbx dbml <connection> [--out path]"), false)
    })?;

    let connection = find_connection(backend, name).await.map_err(|error| (error, false))?;
    let database = selected_database(&connection, flags.database.as_deref());

    let options = DocsSnapshotOptions {
        schemas: flags.schema.clone().into_iter().collect(),
        tables: flags.tables.clone(),
        project_name: Some(connection.name.clone()),
    };

    let snapshot = backend
        .collect_docs_snapshot(&connection, &database, options)
        .await
        .map_err(|error| (CliError::new("DOCS_SNAPSHOT_FAILED", error), false))?;

    let output = dbx_core::docs::to_dbml(&snapshot);

    for warning in &output.warnings {
        eprintln!("warning: {warning:?}");
    }

    match flags.out.as_ref() {
        Some(path) => {
            std::fs::write(path, &output.text).map_err(|error| {
                (CliError::new("WRITE_FAILED", format!("Failed to write {}: {error}", path.display())), false)
            })?;
            Ok(format!("Wrote {} bytes to {}", output.text.len(), path.display()))
        }
        None => Ok(output.text),
    }
}
```

- [ ] **Step 5: Update the usage text**

In the `usage()` function, add this line to the existing string, after the `dbx context` line:

```
  dbx dbml <connection> [--out path] [--schema name] [--database name] [--tables a,b]
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p dbx-cli`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cargo fmt
git add crates/dbx-cli/src/main.rs
git commit -m "feat(docs): add dbx dbml command"
```

---

## Task 12: Live end-to-end verification

**Files:**
- Create: `crates/dbx-core/tests/live_postgres_docs_snapshot.rs`

**Interfaces:**
- Consumes: everything above

Follow the exact gating convention of `crates/dbx-core/tests/live_postgres_query_result_export.rs` — read it first and copy how it skips when no live database is configured.

- [ ] **Step 1: Read the existing live test's harness**

Run: `sed -n '1,50p' crates/dbx-core/tests/live_postgres_query_result_export.rs`

Copy its env-var gating and connection setup verbatim.

- [ ] **Step 2: Write the live test**

```rust
// Gating and connection setup copied from live_postgres_query_result_export.rs.

#[tokio::test]
async fn collects_a_snapshot_and_serializes_valid_dbml() {
    let Some((state, config)) = live_postgres().await else {
        eprintln!("skipping: no live PostgreSQL configured");
        return;
    };

    let options = dbx_core::docs::CollectOptions {
        database: config.database.clone().unwrap_or_default(),
        schemas: vec!["public".to_string()],
        tables: vec![],
        project_name: "live-test".to_string(),
    };

    let snapshot = dbx_core::docs::collect_snapshot(
        &state,
        &config,
        &options,
        &|_progress| {},
        &std::sync::atomic::AtomicBool::new(false),
    )
    .await
    .expect("collect");

    assert_eq!(snapshot.format_version, 1);
    assert!(!snapshot.tables.is_empty(), "expected at least one table");

    let dbml = dbx_core::docs::to_dbml(&snapshot);
    assert!(dbml.text.starts_with("Project "), "got:\n{}", dbml.text);

    for table in &snapshot.tables {
        assert!(
            dbml.text.contains(&format!("Table {}", table.name))
                || dbml.text.contains(&format!("Table {}.{}", table.schema.clone().unwrap_or_default(), table.name)),
            "table {} missing from DBML",
            table.name
        );
    }

    // Braces must balance, or the DBML is unparseable.
    let opens = dbml.text.matches('{').count();
    let closes = dbml.text.matches('}').count();
    assert_eq!(opens, closes, "unbalanced braces in:\n{}", dbml.text);
}
```

- [ ] **Step 3: Run it**

Run: `cargo test -p dbx-core --test live_postgres_docs_snapshot -- --nocapture`
Expected: PASS, or a clean skip message when no live database is configured.

- [ ] **Step 4: Manual smoke test**

With a real connection configured in DBX:

```bash
cargo run -p dbx-cli -- dbml <your-connection> --schema public
```

Expected: DBML on stdout beginning with `Project`. Paste it into <https://dbdiagram.io> and confirm it renders without a parse error. **This is the acceptance gate for the whole plan** — a DBML file that dbdiagram rejects is a failure regardless of what the unit tests say.

- [ ] **Step 5: Full sweep**

Run: `cargo test -p dbx-core && cargo test -p dbx-cli && cargo test -p dbx-mcp && cargo clippy -p dbx-core -- -D warnings`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cargo fmt
git add crates/dbx-core/tests/
git commit -m "test(docs): add live snapshot and DBML verification"
```

---

## Done criteria

- `dbx dbml <connection>` prints DBML that dbdiagram.io parses.
- `dbx dbml <connection> --out schema.dbml` writes the file and reports the byte count.
- Every DBML-inexpressible construct appears on stderr as a warning; none vanish.
- `cargo test -p dbx-core` passes with no live database configured.
- `SchemaSnapshot` serializes to camelCase JSON, ready for Part 2 (annotations) and Part 3 (viewer + HTML export).

---

## Appendix: Corrections found during execution

This plan was written by reading the codebase rather than compiling against it, and thirteen of its
assumptions turned out to be wrong. All were caught and fixed before merge. The sections above have
been amended where a fix was small and local; this appendix records every correction so that nobody
re-derives a wrong fact from the surrounding prose.

The pattern is consistent and worth internalising for future plans: **symbol names are easy to
verify with grep; visibility, arity, module paths, and required call-ordering are not** — and those
are exactly what breaks a build or, worse, compiles and fails at runtime.

### Contract errors (wrong signature, path, or visibility)

| # | Plan said | Reality |
| --- | --- | --- |
| 1 | `use crate::state::AppState` | `crate::connection::AppState` (`connection.rs:200`) |
| 2 | `capabilities_for(db_type).comment` callable from `docs::` | `capabilities_for` **and** `TableStructureCapabilities` are `pub(super)`; it takes `Option<DatabaseType>`. Fixed by adding narrow `pub(crate) fn supports_comments` / `supports_foreign_keys` accessors in `table_structure_sql.rs` |
| 3 | collector takes `&PoolKind` | `schema::*_core` take `&AppState` + connection id, and already wrap `retry_metadata_connection` |
| 4 | `WebBackend::post_json(...)` | No such helper. Real API is `request(Method, path, Option<Value>)` (`backend.rs:247`) |
| 5 | `new_connection_config(a, b, c, d)` | Takes 10 positional args (`backend.rs:1517`) |
| 6 | `run_dbml -> Result<String, (CliError, bool)>` | Siblings return `Result<String, CliError>`; the tuple wrap happens once in `run()` |
| 7 | `DocsSnapshotOptions` at crate root | Only at `dbx_mcp::backend::DocsSnapshotOptions` |
| 8 | `pub out: Option<PathBuf>` on `Flags` | `Flags` is private with private fields — no `pub` |

### Runtime-only errors (compiled and passed tests; would fail only against a live system)

| # | Plan said | Reality |
| --- | --- | --- |
| 9 | Register route as `/api/docs/snapshot` | Router does `.nest("/api", api)` (`main.rs:777`), so routes register bare: `/docs/snapshot`. The literal path would have served `/api/api/docs/snapshot` |
| 10 | `WebBackend` posts directly | Must call `self.ensure_connected(connection).await?` first (`backend.rs:283`) or the remote instance returns connection-not-found |
| 11 | Live test uses a `live_postgres() -> Option<..>` helper with skip-by-return | Repo convention is `#[ignore = "requires DBX_LIVE_POSTGRES_..."]`. The plan's version would have **run and silently passed** with no database configured |

### Logic errors (correct-looking code producing wrong output)

| # | Defect | Fix |
| --- | --- | --- |
| 12 | `find_target` fell back to first-match-by-name, so an FK could bind to a same-named table in another schema | Resolution order is now explicit `ref_schema` → source table's own schema → unique bare name; ambiguous matches are dropped rather than guessed (`relations.rs`) |
| 13 | `render_note` escaped only a literal `'''`, so a note ending in an apostrophe emitted four consecutive quotes and broke parsing | Also escapes a trailing `'` as `\'` (`dbml.rs`) |

### Defects found by review, not present in the plan text

- **`NoForeignKeyMetadata` false positives.** The emptiness heuristic reported healthy PostgreSQL as
  lacking FK support via three paths (schema genuinely has no FKs; `--tables` subset drops dangling
  edges; a swallowed `list_foreign_keys_core` error). Now gated purely on engine capability, and a
  real FK query failure surfaces as `TableSkipped`.
- **Orphan enums.** `synthesize_enum` emitted an `Enum` block that `render_type` never referenced —
  the named-enum feature silently did not land. `render_type` now routes through the same
  `qualified()` helper `render_enum` uses, so the two cannot drift.
- **Dropped `snapshot.warnings`.** `to_dbml` built its warning list from scratch, discarding
  collector-side omissions. Now seeded from `snapshot.warnings`.

### Test-quality lessons

Two regression tests written during the fix rounds were themselves invalid — one too narrow (pinned
a single-schema literal, blind to the multi-schema case), one too loose (`contains` matched a bare
name as a substring of the qualified one, so it passed against the very bug it guarded).

**A regression test is not known to work until it has been observed failing against the bug.**
Deliberately break the fix, watch the test fail, restore, confirm it passes. It costs about ninety
seconds and it is the only way to distinguish a guard from a decoration.
