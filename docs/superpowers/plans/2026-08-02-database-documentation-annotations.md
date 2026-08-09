# Database Documentation Part 2: Annotation Store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users author table notes, column notes, project notes and table groups in a git-committable file, and have `dbx dbml --notes <path>` merge them into the generated DBML.

**Architecture:** A new `crates/dbx-core/src/docs/annotations.rs` owns the notes file: load, validate, and merge into the `SchemaSnapshot` that Part 1's collector produces. Keys are `schema.table` / `schema.table.column`, case-folded per engine by a small `docs/keys.rs`. Merge precedence is `local ?? database_comment`, recorded in the `note_source` and `shadowed_note` fields Part 1 already defined but never populated. Notes whose target no longer exists are reported as `SnapshotWarning::OrphanedNotes`, never dropped.

**Tech Stack:** Rust (dbx-core, dbx-cli), serde, serde_json. No new dependencies.

**Branch:** continue on `feature/docs-snapshot-dbml` (Part 1's branch, 19 commits, unmerged) — Part 2 builds directly on its types. Worktree already exists at `/Users/possebon/workspaces/dbx.feature-docs-snapshot-dbml`.

**Spec:** `docs/superpowers/specs/2026-08-02-database-documentation-dbml-design.md`, Section 4.

## Global Constraints

- **NO new dependencies.** `serde`, `serde_json`, `chrono`, `futures` are already present in dbx-core.
- **`cargo` is NOT on PATH.** Every cargo command must be prefixed with
  `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`.
  A bare `cargo` fails instantly with "Failed to spawn process: No such file or directory (os error 2)" — that is not a hang.
- **A notes file that is ABSENT is fine; a notes file that is MALFORMED is a hard error.** User prose is at stake; proceeding silently would render apparently-complete docs while discarding writing.
- **Never silently drop a note.** A note whose target no longer exists becomes a warning, not a deletion.
- `format_version` in the notes file is `1`.
- Group colour is `hue: u16` in `0..=359`. Never a hex string.
- Run `cargo fmt` before every commit. Conventional Commits.
- **Report mismatches, do not work around them.** If a signature differs from this plan, stop and report the actual compiler error. Part 1 had thirteen plan defects; every one was caught this way.

---

## Pre-resolved facts (verified against the source — these override any assumption in the spec)

1. **`schema/normalization.rs` is NOT where key folding goes.** Every function in it is `pub(super)` and it does table-list *filtering* (YashanDB recyclebin, object-type filters, column dedup) — not identifier case folding, and not reachable from `docs::`. Part 2 creates its own `crates/dbx-core/src/docs/keys.rs`.

2. **`schema_diff::detect_renames` cannot be used for orphan suggestions.** Signature is
   `pub fn detect_renames(removed: &[String], added: &[String], source_details: &[TableSchemaDetail], target_details: &[TableSchemaDetail], threshold: f64) -> Vec<RenameCandidate>` (`schema_diff.rs:817`).
   It needs `TableSchemaDetail` for BOTH sides. The notes file stores prose only — it never retained the old schema — so there is nothing to diff against. **Rename suggestions are deferred** until snapshot history exists (spec Section 12). Part 2 detects and reports orphans; it does not suggest re-maps.

3. **Per-connection persistence.** `DesktopSettings.saved_sql_sync_dir` is a GLOBAL setting, not per-connection — it is not the precedent the spec implies. `ConnectionConfig` already carries per-connection preferences (`note`, `color`, `init_script`, `visible_schemas`) and is serde-persisted into the `connections` table. **Add `docs_notes_path: Option<String>` to `ConnectionConfig` with `#[serde(default)]`** — non-breaking, no migration, no new table.

4. **MySQL `lower_case_table_names`** is read in `transfer.rs:705-727` via `SHOW VARIABLES`, but that helper is private and costs a round-trip. Part 2 does NOT query it. MySQL keys fold to lowercase unconditionally (see Task 2 rationale).

5. **Part 1 fields this plan populates** (all exist, currently hardcoded `None`/`NoteSource::None` at `collector.rs:206-209`): `DocTable::note`, `note_source`, `shadowed_note`, `column_notes`, `group_id`, and `SchemaSnapshot::groups`. `column_notes` is already consumed by the serializer at `dbml.rs:126`; `groups` already render via `render_group` with an empty-member guard. **No Part 1 type changes are required.**

6. **Annotations are applied CLI-side, NOT inside the collector.** The notes file lives on the
   machine running `dbx`, and `WebBackend` talks to a remote DBX instance that cannot read it.
   Applying the merge after the snapshot returns keeps both transports identical — a property a
   Part 1 review specifically verified. Adding an `annotations` field to `CollectOptions` would
   therefore create a field written by nothing and read by nothing, which is exactly the
   "produced but never consumed" defect the Part 1 final review flagged. `collector.rs` is
   deliberately **not modified** by this plan.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `crates/dbx-core/src/docs/keys.rs` | Per-engine identifier folding; `AnnotationKey` construction and matching |
| `crates/dbx-core/src/docs/annotations.rs` | Notes-file model, load/save, merge into snapshot, orphan detection |
| `crates/dbx-core/src/models/connection.rs` | `docs_notes_path` field |
| `crates/dbx-cli/src/main.rs` | `--notes` flag, wiring into `run_dbml` |
| `crates/dbx-core/tests/live_postgres_docs_annotations.rs` | Live verification with a real notes file |

---

## Task 0: Confirm the starting point

- [ ] **Step 1: Verify the branch and a green baseline**

```bash
cd /Users/possebon/workspaces/dbx.feature-docs-snapshot-dbml
git branch --show-current    # must print: feature/docs-snapshot-dbml
git status --short           # must be empty
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
cargo test -p dbx-core docs::
```

Expected: `feature/docs-snapshot-dbml`, clean tree, 60 tests passing. If any differs, stop and report — Part 2 builds on Part 1 and a dirty starting point makes every later failure ambiguous.

---

## Task 1: Notes-file model

**Files:**
- Create: `crates/dbx-core/src/docs/annotations.rs`
- Modify: `crates/dbx-core/src/docs/mod.rs`

**Interfaces:**
- Produces: `AnnotationFile`, `ProjectAnnotation`, `TableAnnotation`, `ColumnAnnotation`, `GroupAnnotation`

- [ ] **Step 1: Write the failing test**

Create `crates/dbx-core/src/docs/annotations.rs` containing only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "formatVersion": 1,
      "project": { "name": "Ecommerce", "note": "# Overview" },
      "groups": [
        { "id": "order-management", "name": "Order Management", "hue": 28, "note": "Checkout to handoff." }
      ],
      "tables": {
        "core.orders": {
          "group": "order-management",
          "note": "One row per checkout.",
          "columns": { "status": { "note": "State machine." } }
        }
      }
    }"#;

    #[test]
    fn parses_a_complete_notes_file() {
        let parsed: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");

        assert_eq!(parsed.format_version, 1);
        assert_eq!(parsed.project.as_ref().unwrap().name.as_deref(), Some("Ecommerce"));
        assert_eq!(parsed.groups.len(), 1);
        assert_eq!(parsed.groups[0].hue, 28);
        assert_eq!(parsed.tables.len(), 1);

        let orders = parsed.tables.get("core.orders").expect("orders");
        assert_eq!(orders.group.as_deref(), Some("order-management"));
        assert_eq!(orders.note.as_deref(), Some("One row per checkout."));
        assert_eq!(orders.columns.get("status").unwrap().note, "State machine.");
    }

    #[test]
    fn a_minimal_file_needs_only_the_format_version() {
        let parsed: AnnotationFile = serde_json::from_str(r#"{"formatVersion": 1}"#).expect("parse");
        assert!(parsed.tables.is_empty());
        assert!(parsed.groups.is_empty());
        assert!(parsed.project.is_none());
    }

    #[test]
    fn round_trips_through_json() {
        let parsed: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");
        let written = serde_json::to_string(&parsed).expect("serialize");
        let reparsed: AnnotationFile = serde_json::from_str(&written).expect("reparse");
        assert_eq!(reparsed.tables.len(), 1);
        assert_eq!(reparsed.groups[0].name, "Order Management");
    }

    #[test]
    fn rejects_a_file_with_an_unknown_top_level_field() {
        // Typos in a hand-edited file must not be silently ignored — a
        // misspelled "tabels" key would otherwise discard every note in it.
        let result: Result<AnnotationFile, _> =
            serde_json::from_str(r#"{"formatVersion": 1, "tabels": {}}"#);
        assert!(result.is_err(), "unknown fields must be rejected");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add to `crates/dbx-core/src/docs/mod.rs`, keeping alphabetical order (it currently lists `color`, `collector`, `dbml`, `relations`, `snapshot`):

```rust
pub mod annotations;
```

Run: `cargo test -p dbx-core docs::annotations`
Expected: FAIL — `cannot find type AnnotationFile`.

- [ ] **Step 3: Write the types**

At the top of `crates/dbx-core/src/docs/annotations.rs`:

```rust
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The on-disk notes file. This IS the store — not a cache of anything.
/// It is meant to be committed to a repository and reviewed in pull
/// requests, so it must stay small, readable, and stable in key order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationFile {
    pub format_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectAnnotation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<GroupAnnotation>,
    /// Keyed by `schema.table` (or bare `table` on schema-less engines).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tables: BTreeMap<String, TableAnnotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAnnotation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Markdown. Becomes the documentation landing page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupAnnotation {
    /// Stable slug, referenced by `TableAnnotation::group`.
    pub id: String,
    pub name: String,
    /// 0..=359. Lightness and chroma are theme-controlled, so any hue is
    /// legible on both light and dark grounds by construction.
    pub hue: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TableAnnotation {
    /// References `GroupAnnotation::id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Keyed by bare column name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub columns: BTreeMap<String, ColumnAnnotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColumnAnnotation {
    pub note: String,
}
```

`BTreeMap` rather than `HashMap` is deliberate: it serializes in sorted key order, so a committed notes file produces a stable diff instead of a reshuffled one on every save.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p dbx-core docs::annotations`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/
git commit -m "feat(docs): add annotation file model"
```

---

## Task 2: Per-engine key folding

**Files:**
- Create: `crates/dbx-core/src/docs/keys.rs`
- Modify: `crates/dbx-core/src/docs/mod.rs`

**Interfaces:**
- Consumes: `crate::models::connection::DatabaseType`
- Produces: `pub fn fold_identifier(db_type: DatabaseType, value: &str) -> String`, `pub fn table_key(db_type: DatabaseType, schema: Option<&str>, table: &str) -> String`, `pub fn column_key(db_type: DatabaseType, schema: Option<&str>, table: &str, column: &str) -> String`

**Why this module exists:** the spec said folding belongs in `schema/normalization.rs`. It does not — everything there is `pub(super)` and it filters table lists rather than folding identifiers.

**MySQL rationale:** MySQL's real behaviour depends on the server's `lower_case_table_names` variable. `transfer.rs:705` reads it via `SHOW VARIABLES`, but that helper is private and costs a round-trip per collection. Folding MySQL keys to lowercase unconditionally is correct for the common configurations (1 and 2) and, on the rare `0`, only risks matching a note to a table differing solely by case — which is a matching *hit*, never a wrong note on an unrelated table. The cost is bounded and the round-trip is not.

- [ ] **Step 1: Write the failing test**

Create `crates/dbx-core/src/docs/keys.rs` with only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::DatabaseType;

    #[test]
    fn postgres_folds_to_lowercase() {
        assert_eq!(fold_identifier(DatabaseType::Postgres, "Orders"), "orders");
        assert_eq!(fold_identifier(DatabaseType::Postgres, "ORDERS"), "orders");
    }

    #[test]
    fn mysql_folds_to_lowercase() {
        assert_eq!(fold_identifier(DatabaseType::MySQL, "Orders"), "orders");
    }

    #[test]
    fn table_keys_are_qualified_when_a_schema_is_present() {
        assert_eq!(table_key(DatabaseType::Postgres, Some("Core"), "Orders"), "core.orders");
        assert_eq!(table_key(DatabaseType::Postgres, None, "Orders"), "orders");
        assert_eq!(table_key(DatabaseType::Postgres, Some(""), "Orders"), "orders");
    }

    #[test]
    fn column_keys_extend_the_table_key() {
        assert_eq!(
            column_key(DatabaseType::Postgres, Some("core"), "orders", "Status"),
            "core.orders.status"
        );
    }

    #[test]
    fn folding_is_idempotent() {
        let once = table_key(DatabaseType::Postgres, Some("Core"), "Orders");
        let twice = table_key(DatabaseType::Postgres, Some(&once), "x");
        assert!(twice.starts_with("core.orders"), "got {twice}");
        assert_eq!(fold_identifier(DatabaseType::Postgres, &once), once);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Add `pub mod keys;` to `crates/dbx-core/src/docs/mod.rs` (alphabetically, after `dbml`).

Run: `cargo test -p dbx-core docs::keys`
Expected: FAIL — `cannot find function fold_identifier`.

**Note:** the exact `DatabaseType` variant spellings above (`Postgres`, `MySQL`) may differ. Check `crates/dbx-core/src/models/connection.rs` and use the real ones; report which you used.

- [ ] **Step 3: Write the implementation**

```rust
use crate::models::connection::DatabaseType;

/// Fold an identifier to its canonical case for note matching.
///
/// PostgreSQL folds unquoted identifiers to lower case, Oracle to upper.
/// MySQL depends on the server's `lower_case_table_names`; we fold to lower
/// unconditionally rather than pay a `SHOW VARIABLES` round-trip per
/// collection — on the rare case-sensitive configuration the only risk is
/// matching a note to a table differing solely by case, never attaching a
/// note to an unrelated table.
pub fn fold_identifier(db_type: DatabaseType, value: &str) -> String {
    match db_type {
        DatabaseType::Oracle => value.to_uppercase(),
        _ => value.to_lowercase(),
    }
}

/// `schema.table`, or bare `table` when there is no schema.
pub fn table_key(db_type: DatabaseType, schema: Option<&str>, table: &str) -> String {
    match schema.filter(|value| !value.is_empty()) {
        Some(schema) => {
            format!("{}.{}", fold_identifier(db_type, schema), fold_identifier(db_type, table))
        }
        None => fold_identifier(db_type, table),
    }
}

/// `schema.table.column`, or `table.column` when there is no schema.
pub fn column_key(db_type: DatabaseType, schema: Option<&str>, table: &str, column: &str) -> String {
    format!("{}.{}", table_key(db_type, schema, table), fold_identifier(db_type, column))
}
```

Add `pub use keys::{column_key, fold_identifier, table_key};` to `docs/mod.rs`.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p dbx-core docs::keys`
Expected: PASS, 5 tests. Adjust the `DatabaseType::Oracle` arm if that variant is spelled differently.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/
git commit -m "feat(docs): add per-engine annotation key folding"
```

---

## Task 3: Load the notes file

**Files:**
- Modify: `crates/dbx-core/src/docs/annotations.rs`

**Interfaces:**
- Produces: `pub fn load_annotations(path: &std::path::Path) -> Result<Option<AnnotationFile>, String>`

**The rule this task encodes:** absent is fine, malformed is fatal.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `annotations.rs`:

```rust
    use std::io::Write;

    fn temp_notes(contents: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("dbx-notes-test-{}.json", contents.len()));
        let mut file = std::fs::File::create(&path).expect("create");
        file.write_all(contents.as_bytes()).expect("write");
        path
    }

    #[test]
    fn an_absent_file_is_not_an_error() {
        let missing = std::path::Path::new("/nonexistent/dbx-notes-does-not-exist.json");
        assert!(matches!(load_annotations(missing), Ok(None)));
    }

    #[test]
    fn a_valid_file_loads() {
        let path = temp_notes(SAMPLE);
        let loaded = load_annotations(&path).expect("load").expect("some");
        assert_eq!(loaded.tables.len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_malformed_file_is_a_hard_error_naming_the_path() {
        let path = temp_notes("{ this is not json");
        let error = load_annotations(&path).expect_err("must fail");
        assert!(error.contains(&path.display().to_string()), "error must name the file: {error}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_unsupported_format_version_is_rejected() {
        let path = temp_notes(r#"{"formatVersion": 99}"#);
        let error = load_annotations(&path).expect_err("must fail");
        assert!(error.contains("99"), "error must name the version: {error}");
        let _ = std::fs::remove_file(&path);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core docs::annotations`
Expected: FAIL — `cannot find function load_annotations`.

- [ ] **Step 3: Write the implementation**

```rust
use std::path::Path;

/// The only format version this build understands.
pub const ANNOTATION_FORMAT_VERSION: u32 = 1;

/// Load the notes file.
///
/// An ABSENT file returns `Ok(None)` — that is the normal first-run and
/// first-CI-run state. A MALFORMED file is a hard error: someone's prose is
/// in there, and rendering apparently-complete documentation while silently
/// discarding it is worse than failing.
pub fn load_annotations(path: &Path) -> Result<Option<AnnotationFile>, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to read notes file {}: {error}", path.display())),
    };

    let parsed: AnnotationFile = serde_json::from_str(&contents)
        .map_err(|error| format!("Failed to parse notes file {}: {error}", path.display()))?;

    if parsed.format_version != ANNOTATION_FORMAT_VERSION {
        return Err(format!(
            "Notes file {} has formatVersion {}, but this build understands {}.",
            path.display(),
            parsed.format_version,
            ANNOTATION_FORMAT_VERSION
        ));
    }

    Ok(Some(parsed))
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p dbx-core docs::annotations`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/
git commit -m "feat(docs): load and validate the notes file"
```

---

## Task 4: Merge annotations into the snapshot

**Files:**
- Modify: `crates/dbx-core/src/docs/annotations.rs`

**Interfaces:**
- Consumes: `AnnotationFile` (Task 1), `table_key`/`column_key` (Task 2), `SchemaSnapshot`/`DocTable`/`ColumnNote`/`NoteSource`/`TableGroup`/`SnapshotWarning` (Part 1)
- Produces: `pub fn apply_annotations(snapshot: &mut SchemaSnapshot, annotations: &AnnotationFile, db_type: DatabaseType)`

**Merge precedence:** `local_annotation ?? database_comment`. When a local note shadows a database comment, the comment is preserved in `shadowed_note` so the UI can show what is being overridden — otherwise a DBA later writing a better `COMMENT ON` would have their improvement silently hidden.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module:

```rust
    use crate::docs::{DocTable, NoteSource, ProjectMeta, SchemaSnapshot, TableKind};
    use crate::models::connection::DatabaseType;

    fn snapshot_with(tables: Vec<DocTable>) -> SchemaSnapshot {
        SchemaSnapshot {
            format_version: 1,
            project: ProjectMeta {
                name: "conn".to_string(),
                database_type: "postgres".to_string(),
                database: None,
                schemas: vec!["core".to_string()],
                generated_at: String::new(),
                note: None,
            },
            tables,
            relationships: vec![],
            groups: vec![],
            enums: vec![],
            warnings: vec![],
        }
    }

    fn table_named(schema: &str, name: &str, comment: Option<&str>) -> DocTable {
        DocTable {
            schema: Some(schema.to_string()),
            name: name.to_string(),
            kind: TableKind::Table,
            columns: vec![],
            indexes: vec![],
            foreign_keys: vec![],
            group_id: None,
            note: comment.map(ToOwned::to_owned),
            note_source: if comment.is_some() { NoteSource::Database } else { NoteSource::None },
            shadowed_note: None,
            column_notes: BTreeMap::new(),
            estimated_rows: None,
            view_definition: None,
        }
    }

    #[test]
    fn a_local_note_shadows_the_database_comment_and_preserves_it() {
        let mut snapshot = snapshot_with(vec![table_named("core", "orders", Some("Old DB comment."))]);
        let annotations: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");

        apply_annotations(&mut snapshot, &annotations, DatabaseType::Postgres);

        let table = &snapshot.tables[0];
        assert_eq!(table.note.as_deref(), Some("One row per checkout."));
        assert_eq!(table.note_source, NoteSource::Local);
        assert_eq!(table.shadowed_note.as_deref(), Some("Old DB comment."));
    }

    #[test]
    fn a_database_comment_survives_when_there_is_no_local_note() {
        let mut snapshot = snapshot_with(vec![table_named("core", "users", Some("From the database."))]);
        let annotations: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");

        apply_annotations(&mut snapshot, &annotations, DatabaseType::Postgres);

        let table = &snapshot.tables[0];
        assert_eq!(table.note.as_deref(), Some("From the database."));
        assert_eq!(table.note_source, NoteSource::Database);
        assert_eq!(table.shadowed_note, None);
    }

    #[test]
    fn keys_match_case_insensitively_on_postgres() {
        // The notes file says "core.orders"; the live schema reports "Core"/"Orders".
        let mut snapshot = snapshot_with(vec![table_named("Core", "Orders", None)]);
        let annotations: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");

        apply_annotations(&mut snapshot, &annotations, DatabaseType::Postgres);

        assert_eq!(snapshot.tables[0].note.as_deref(), Some("One row per checkout."));
    }

    #[test]
    fn column_notes_are_applied_and_marked_local() {
        let mut table = table_named("core", "orders", None);
        table.columns.push(crate::types::ColumnInfo {
            name: "status".to_string(),
            data_type: "text".to_string(),
            ..Default::default()
        });
        let mut snapshot = snapshot_with(vec![table]);
        let annotations: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");

        apply_annotations(&mut snapshot, &annotations, DatabaseType::Postgres);

        let note = snapshot.tables[0].column_notes.get("status").expect("column note");
        assert_eq!(note.note, "State machine.");
        assert_eq!(note.source, NoteSource::Local);
    }

    #[test]
    fn the_project_note_and_name_are_applied() {
        let mut snapshot = snapshot_with(vec![]);
        let annotations: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");

        apply_annotations(&mut snapshot, &annotations, DatabaseType::Postgres);

        assert_eq!(snapshot.project.name, "Ecommerce");
        assert_eq!(snapshot.project.note.as_deref(), Some("# Overview"));
    }

    #[test]
    fn groups_are_copied_and_membership_is_assigned() {
        let mut snapshot = snapshot_with(vec![table_named("core", "orders", None)]);
        let annotations: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");

        apply_annotations(&mut snapshot, &annotations, DatabaseType::Postgres);

        assert_eq!(snapshot.groups.len(), 1);
        assert_eq!(snapshot.groups[0].id, "order-management");
        assert_eq!(snapshot.groups[0].hue, 28);
        assert_eq!(snapshot.tables[0].group_id.as_deref(), Some("order-management"));
    }

    #[test]
    fn a_table_referencing_an_undefined_group_is_left_ungrouped() {
        let mut snapshot = snapshot_with(vec![table_named("core", "orders", None)]);
        let mut annotations: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");
        annotations.groups.clear();

        apply_annotations(&mut snapshot, &annotations, DatabaseType::Postgres);

        assert_eq!(snapshot.tables[0].group_id, None, "a dangling group reference must not be assigned");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core docs::annotations`
Expected: FAIL — `cannot find function apply_annotations`.

- [ ] **Step 3: Write the implementation**

```rust
use crate::docs::{ColumnNote, NoteSource, SchemaSnapshot, TableGroup};
use crate::docs::keys::{column_key, table_key};
use crate::models::connection::DatabaseType;

/// Merge a notes file into a collected snapshot.
///
/// Precedence is `local ?? database_comment`. When a local note shadows a
/// database comment the comment is kept in `shadowed_note`, so a later
/// `COMMENT ON` improvement stays visible rather than being silently hidden.
pub fn apply_annotations(
    snapshot: &mut SchemaSnapshot,
    annotations: &AnnotationFile,
    db_type: DatabaseType,
) {
    if let Some(project) = annotations.project.as_ref() {
        if let Some(name) = project.name.as_deref().filter(|value| !value.trim().is_empty()) {
            snapshot.project.name = name.to_string();
        }
        if project.note.is_some() {
            snapshot.project.note = project.note.clone();
        }
    }

    let known_groups: std::collections::HashSet<&str> =
        annotations.groups.iter().map(|group| group.id.as_str()).collect();

    snapshot.groups = annotations
        .groups
        .iter()
        .map(|group| TableGroup {
            id: group.id.clone(),
            name: group.name.clone(),
            hue: group.hue,
            note: group.note.clone(),
        })
        .collect();

    for table in &mut snapshot.tables {
        let key = table_key(db_type, table.schema.as_deref(), &table.name);
        let Some(annotation) = annotations.tables.get(&key) else { continue };

        if let Some(note) = annotation.note.as_deref().filter(|value| !value.trim().is_empty()) {
            // Preserve whatever the database said before overwriting it.
            if matches!(table.note_source, NoteSource::Database) {
                table.shadowed_note = table.note.clone();
            }
            table.note = Some(note.to_string());
            table.note_source = NoteSource::Local;
        }

        // A group reference that names no defined group is dropped rather
        // than assigned — a dangling id would render an empty group header.
        table.group_id = annotation
            .group
            .as_deref()
            .filter(|id| known_groups.contains(id))
            .map(ToOwned::to_owned);

        for column in &table.columns {
            let column_fold = crate::docs::keys::fold_identifier(db_type, &column.name);
            let annotated = annotation
                .columns
                .iter()
                .find(|(name, _)| crate::docs::keys::fold_identifier(db_type, name) == column_fold);

            let Some((_, column_annotation)) = annotated else { continue };
            if column_annotation.note.trim().is_empty() {
                continue;
            }

            table.column_notes.insert(
                column.name.clone(),
                ColumnNote {
                    note: column_annotation.note.clone(),
                    source: NoteSource::Local,
                    shadowed: column.comment.clone().filter(|value| !value.trim().is_empty()),
                },
            );
        }
    }

    // `column_key` is used by orphan detection in Task 5; referenced here so
    // the import is meaningful in both tasks.
    let _ = column_key;
}
```

**Note for the implementer:** the trailing `let _ = column_key;` is a placeholder to keep the import valid before Task 5 uses it. If the compiler is satisfied without importing `column_key` in this task, omit both the import and that line and add the import in Task 5 instead. Report which you did.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p dbx-core docs::annotations`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/
git commit -m "feat(docs): merge annotations into the schema snapshot"
```

---

## Task 5: Orphan detection

**Files:**
- Modify: `crates/dbx-core/src/docs/annotations.rs`

**Interfaces:**
- Produces: `pub fn detect_orphans(snapshot: &SchemaSnapshot, annotations: &AnnotationFile, db_type: DatabaseType) -> Vec<String>`; `apply_annotations` pushes `SnapshotWarning::OrphanedNotes { count }`

**Why no re-map suggestion:** `schema_diff::detect_renames` needs `TableSchemaDetail` for both the old and new schema. The notes file stores prose only — it never retained the old schema — so there is nothing to diff. Suggestions become possible once snapshot history exists (spec Section 12). Part 2 detects and reports; it never deletes.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module:

```rust
    use crate::docs::SnapshotWarning;

    #[test]
    fn a_note_for_a_missing_table_is_reported_as_orphaned() {
        // The notes file describes core.orders; the schema no longer has it.
        let mut snapshot = snapshot_with(vec![table_named("core", "customers", None)]);
        let annotations: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");

        let orphans = detect_orphans(&snapshot, &annotations, DatabaseType::Postgres);
        assert_eq!(orphans, vec!["core.orders".to_string()]);

        apply_annotations(&mut snapshot, &annotations, DatabaseType::Postgres);
        let orphan_warnings: Vec<&SnapshotWarning> = snapshot
            .warnings
            .iter()
            .filter(|warning| matches!(warning, SnapshotWarning::OrphanedNotes { .. }))
            .collect();
        assert_eq!(orphan_warnings.len(), 1);
        match orphan_warnings[0] {
            SnapshotWarning::OrphanedNotes { count } => assert_eq!(*count, 1),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn a_note_for_a_missing_column_is_reported_as_orphaned() {
        // The table exists but no longer has the annotated column.
        let mut table = table_named("core", "orders", None);
        table.columns.push(crate::types::ColumnInfo {
            name: "id".to_string(),
            data_type: "integer".to_string(),
            ..Default::default()
        });
        let snapshot = snapshot_with(vec![table]);
        let annotations: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");

        let orphans = detect_orphans(&snapshot, &annotations, DatabaseType::Postgres);
        assert_eq!(orphans, vec!["core.orders.status".to_string()]);
    }

    #[test]
    fn nothing_is_orphaned_when_everything_matches() {
        let mut table = table_named("core", "orders", None);
        table.columns.push(crate::types::ColumnInfo {
            name: "status".to_string(),
            data_type: "text".to_string(),
            ..Default::default()
        });
        let mut snapshot = snapshot_with(vec![table]);
        let annotations: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");

        assert!(detect_orphans(&snapshot, &annotations, DatabaseType::Postgres).is_empty());

        apply_annotations(&mut snapshot, &annotations, DatabaseType::Postgres);
        assert!(
            !snapshot.warnings.iter().any(|w| matches!(w, SnapshotWarning::OrphanedNotes { .. })),
            "no orphan warning when everything matches"
        );
    }

    #[test]
    fn orphan_detection_never_removes_anything_from_the_file() {
        let snapshot = snapshot_with(vec![]);
        let annotations: AnnotationFile = serde_json::from_str(SAMPLE).expect("parse");
        let before = annotations.tables.len();

        let _ = detect_orphans(&snapshot, &annotations, DatabaseType::Postgres);

        assert_eq!(annotations.tables.len(), before, "detection must not mutate the file");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core docs::annotations`
Expected: FAIL — `cannot find function detect_orphans`.

- [ ] **Step 3: Write the implementation**

```rust
/// Annotation keys whose target no longer exists in the collected schema.
///
/// Returns fully-qualified keys, sorted, so the caller can list them for a
/// human to re-map. This function NEVER mutates the notes file — user prose
/// is only ever removed by an explicit human action.
///
/// Suggestions for where a renamed target went are deliberately absent:
/// producing them requires the OLD schema to diff against, and the notes
/// file stores prose only. That becomes possible once snapshot history
/// exists (see the spec's deferred versioning seam).
pub fn detect_orphans(
    snapshot: &SchemaSnapshot,
    annotations: &AnnotationFile,
    db_type: DatabaseType,
) -> Vec<String> {
    use std::collections::HashSet;

    let live_tables: HashSet<String> = snapshot
        .tables
        .iter()
        .map(|table| table_key(db_type, table.schema.as_deref(), &table.name))
        .collect();

    let live_columns: HashSet<String> = snapshot
        .tables
        .iter()
        .flat_map(|table| {
            table.columns.iter().map(move |column| {
                column_key(db_type, table.schema.as_deref(), &table.name, &column.name)
            })
        })
        .collect();

    let mut orphans = Vec::new();

    for (key, annotation) in &annotations.tables {
        let folded_table = fold_key(db_type, key);
        if !live_tables.contains(&folded_table) {
            orphans.push(folded_table);
            continue;
        }
        for column in annotation.columns.keys() {
            let folded_column =
                format!("{folded_table}.{}", crate::docs::keys::fold_identifier(db_type, column));
            if !live_columns.contains(&folded_column) {
                orphans.push(folded_column);
            }
        }
    }

    orphans.sort();
    orphans
}

/// Fold an already-dotted key (e.g. `Core.Orders`) segment by segment.
fn fold_key(db_type: DatabaseType, key: &str) -> String {
    key.split('.')
        .map(|segment| crate::docs::keys::fold_identifier(db_type, segment))
        .collect::<Vec<_>>()
        .join(".")
}
```

Then, at the END of `apply_annotations` (replacing the `let _ = column_key;` placeholder from Task 4):

```rust
    let orphans = detect_orphans(snapshot, annotations, db_type);
    if !orphans.is_empty() {
        snapshot.warnings.push(SnapshotWarning::OrphanedNotes { count: orphans.len() });
    }
```

Add `SnapshotWarning` to the `use crate::docs::{...}` line.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p dbx-core docs::annotations`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-core/src/docs/
git commit -m "feat(docs): detect orphaned annotations without deleting them"
```

---

## Task 6: `--notes` CLI flag

**Files:**
- Modify: `crates/dbx-cli/src/main.rs`

**Interfaces:**
- Consumes: `load_annotations` (Task 3), `apply_annotations` (Task 4)

**Note:** `DocsSnapshotOptions` in `dbx_mcp::backend` carries options across the backend boundary. It does NOT need an `annotations` field — the CLI loads the file locally and, for `LocalBackend`, the annotations reach the collector directly. For `WebBackend` the notes file lives on the CLI's machine, not the server's, so annotations must be applied CLI-side after the snapshot returns. Implement it that way: load the file in `run_dbml`, and apply it to the returned snapshot with `apply_annotations` before calling `to_dbml`. This keeps both transports identical, which a Part 1 review specifically verified.

- [ ] **Step 1: Write the failing test**

Append to `main.rs`'s test module:

```rust
    #[test]
    fn parses_the_notes_flag() {
        let flags = parse_flags(&args(&["dbml", "local", "--notes", "docs/dbx-docs.json"])).expect("parse");
        assert_eq!(flags.args, args(&["dbml", "local"]));
        assert_eq!(flags.notes.as_deref(), Some(std::path::Path::new("docs/dbx-docs.json")));
    }

    #[test]
    fn notes_requires_a_value() {
        let error = parse_flags(&args(&["dbml", "local", "--notes"])).expect_err("should fail");
        assert_eq!(error.code, "INVALID_OPTION");
    }

    #[test]
    fn notes_appears_in_the_usage_text() {
        assert!(usage().contains("--notes"), "got: {}", usage());
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-cli`
Expected: FAIL — `no field named notes on Flags`.

- [ ] **Step 3: Write the implementation**

- Add `notes: Option<PathBuf>` to `Flags` (NO `pub` — the struct and all its fields are private) and initialise it to `None` in `parse_flags`.
- Add the parse arm beside `--out`:
  ```rust
  "--notes" => flags.notes = Some(PathBuf::from(option_value(argv, &mut index, "--notes")?)),
  ```
- In `run_dbml`, after obtaining the snapshot and before `to_dbml`:
  ```rust
  let mut snapshot = snapshot;
  if let Some(path) = flags.notes.as_ref() {
      if let Some(annotations) = dbx_core::docs::annotations::load_annotations(path)
          .map_err(|error| CliError::new("NOTES_INVALID", error))?
      {
          dbx_core::docs::annotations::apply_annotations(
              &mut snapshot,
              &annotations,
              connection.db_type,
          );
      }
  }
  ```
  A malformed notes file must abort with a non-zero exit — it must NOT fall through to producing documentation without the prose.
- Extend the `dbx dbml` line inside the single `usage()` `&'static str` literal so it reads:
  ```
    dbx dbml <connection> [--out path] [--notes path] [--schema name] [--database name] [--tables a,b]
  ```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p dbx-cli`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add crates/dbx-cli/src/main.rs
git commit -m "feat(docs): add --notes to dbx dbml"
```

---

## Task 7: `docs_notes_path` on ConnectionConfig

**Files:**
- Modify: `crates/dbx-core/src/models/connection.rs`

**Interfaces:**
- Produces: `ConnectionConfig.docs_notes_path: Option<String>`

**Why here rather than a new table:** `ConnectionConfig` already carries per-connection preferences (`note`, `color`, `init_script`, `visible_schemas`) and is serde-persisted into the `connections` table. `DesktopSettings.saved_sql_sync_dir` is a GLOBAL setting and is not the right precedent despite what the spec implies. `#[serde(default)]` makes this non-breaking for existing stored connections — no migration.

This field is not consumed by anything in Part 2 (the CLI takes an explicit `--notes` path). It exists so Part 3's desktop dialog has somewhere to remember the path per connection.

- [ ] **Step 1: Write the failing test**

Append to `connection.rs`'s test module (or create one following the file's conventions):

```rust
    #[test]
    fn docs_notes_path_defaults_to_none_for_existing_stored_connections() {
        // A connection persisted before this field existed must still load.
        let json = r#"{
            "id": "c1", "name": "local", "note": "", "db_type": "Postgres",
            "host": "127.0.0.1", "port": 5432, "username": "postgres",
            "password": "", "attached_databases": [], "agent_java_options": [],
            "connect_timeout_secs": 10, "transport_layers": []
        }"#;
        let parsed: ConnectionConfig = serde_json::from_str(json).expect("parse");
        assert_eq!(parsed.docs_notes_path, None);
    }
```

The exact JSON must satisfy every non-`default` field on `ConnectionConfig`. Run the test, read the serde error, and add whatever fields it names — do NOT add `#[serde(default)]` to other fields to make it pass.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p dbx-core docs_notes_path`
Expected: FAIL — `no field docs_notes_path`.

- [ ] **Step 3: Write the implementation**

Add to `ConnectionConfig`, beside `init_script` / `color`:

```rust
    /// Path to this connection's documentation notes file. Set by the
    /// desktop app; the CLI takes an explicit `--notes` path instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docs_notes_path: Option<String>,
```

Then fix every `ConnectionConfig { .. }` literal the compiler flags. There are many (including `crates/dbx-core/tests/live_postgres_query_result_export.rs:12`); add `docs_notes_path: None` to each. Let the compiler enumerate them; report the count.

- [ ] **Step 4: Run the tests**

```bash
cargo test -p dbx-core
cargo check --workspace --all-targets
```
Expected: pass and clean.

- [ ] **Step 5: Commit**

```bash
cargo fmt
git add -A
git commit -m "feat(docs): remember a notes file path per connection"
```

---

## Task 8: Live verification

**Files:**
- Create: `crates/dbx-core/tests/live_postgres_docs_annotations.rs`

Follow the gating convention of `crates/dbx-core/tests/live_postgres_docs_snapshot.rs` exactly: `#[tokio::test]` + `#[ignore = "requires DBX_LIVE_POSTGRES_..."]`, env vars with defaults, and the `live_postgres_config(...)` builder. Do NOT invent a skip-helper — `#[ignore]` is what keeps the test from silently passing with no database.

- [ ] **Step 1: Write the live test**

The test must: write a temporary notes file annotating a table that genuinely exists in `keycloak` plus one that does not; collect a snapshot with those annotations; then assert
- the real table's note is present with `note_source == NoteSource::Local`,
- an `OrphanedNotes` warning is present with `count >= 1`,
- the generated DBML contains the note text,
- and the temp file is removed on both success and failure paths.

Print the generated DBML with `println!` so `--nocapture` shows it.

- [ ] **Step 2: Run it against the live database**

```bash
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
DBX_LIVE_POSTGRES_HOST=127.0.0.1 DBX_LIVE_POSTGRES_PORT=5432 \
DBX_LIVE_POSTGRES_USER=postgres DBX_LIVE_POSTGRES_PASSWORD=postgres \
DBX_LIVE_POSTGRES_DATABASE=keycloak \
cargo test -p dbx-core --test live_postgres_docs_annotations -- --ignored --nocapture
```

Paste the ACTUAL generated DBML into the report — specifically a `Table` block showing the merged note and the `Note:` line inside it.

- [ ] **Step 3: Full sweep**

```bash
cargo test --workspace
cargo clippy -p dbx-core -- -D warnings
```

Report clippy honestly. `crates/dbx-core/src/table_structure_sql/triggers.rs:58` fails on `map_or` — that is PRE-EXISTING on main, verified byte-identical, and is NOT yours to fix. Confirm it is the only remaining lint.

- [ ] **Step 4: Commit**

```bash
cargo fmt
git add crates/dbx-core/tests/
git commit -m "test(docs): verify annotations against a live database"
```

---

## Done criteria

- `dbx dbml <connection> --notes docs/dbx-docs.json` merges notes and groups into the emitted DBML.
- An absent notes file is fine; a malformed one aborts with a non-zero exit naming the file.
- A note whose target no longer exists produces an `OrphanedNotes` warning on stderr and is never deleted.
- A local note shadowing a database comment preserves the comment in `shadowed_note`.
- Table groups become `TableGroup` blocks with `[color: #rrggbb]` derived from each group's hue.
- `cargo test --workspace` passes; clippy clean except the pre-existing `triggers.rs` lint.

## Deferred to Part 3

- The docs viewer, in-app editing dialog, group colour picker, and HTML export.
- Rename suggestions for orphaned notes (needs snapshot history — spec Section 12).
- Writing the notes file from DBX (Part 2 only reads it; the file is hand-edited or repo-managed).

---

## Appendix: Corrections found during execution

Defects in this plan's own text, found while executing it. Grouped by failure mode rather than by
task, because the modes repeat and the tasks do not. Every one originated in the plan; none was an
implementer error. The companion plan for the viewer carries its own appendix in the same form.

### Mode A — compiles, passes its own test, and is silently wrong forever

The most dangerous defect found anywhere in this feature, and the only one that would have shipped
undetected.

- **Task 7, `docs_notes_path`.** The plan added the field to `ConnectionConfig` and to its own
  test, which passed. But `ConnectionConfig` is not what deserialization reads — a mirror struct,
  `ConnectionConfigData`, carries the serde attributes, and a `From` impl copies fields across.
  Adding the field in one place compiles cleanly, satisfies a round-trip test written against the
  same struct, and then reads `None` forever after every load, because nothing ever populates it.
  Caught by pre-resolution, not by review: the field had to be added in **three** places, and only
  reading the deserialization path revealed the third.

**The lesson:** when a struct has a serde mirror, "it compiles and the test passes" is evidence
about the wrong object. Follow the value from the file on disk to the field being read.

### Mode B — an assertion too weak to detect the failure it names

Same failure mode as Mode 1 in the viewer plan's appendix, and the most common across both.

- **Task 1, `round_trips_through_json`.** Asserted only `tables.len()` and a single group name. A
  serializer that silently dropped every note, hue, and column annotation would pass it. Fixed by
  asserting the full round-tripped structure.
- **Task 5.** Each headline test individually survived a mutant; only the *pair* caught it.
  Accepted rather than fixed, but recorded, because a later edit that deletes one test would
  silently remove the coverage the other depends on.

### Mode C — plan text written from memory instead of from the code

Four instances, all caught before dispatch by reading the actual source. None would have survived
compilation, so the cost was implementer time rather than correctness — but that cost is real.

- `DatabaseType::Mysql`, which the plan spelled `MySQL`.
- A borrow hazard in a code block the plan supplied verbatim (Task 4).
- `let mut snapshot = snapshot;` in the `run_dbml` shape, which was a guess at the real signature.
- `capabilities_for` is `pub(super)`, not `pub`, and `AppState`'s module path was wrong.

**The lesson:** every identifier a plan names is a claim about the codebase. Checking them costs
minutes; a dispatch that fails on one costs an implementer round-trip.

### Mode D — matching logic that attaches data to the wrong object

- **Task 2, identifier folding.** The original key-matching rule could fold two genuinely distinct
  identifiers to the same key, so a note written for one table would attach to another. The doc
  comment's stated MySQL rationale also described behaviour the code did not implement. Fixed by
  making `fold_identifier` engine-specific (Oracle uppercases, ClickHouse and MongoDB preserve,
  everything else lowercases) and correcting the comment to match.

A related seam was investigated and cleared: Oracle folding is used **only** for matching, never
for output — the serializer emits the collector's reported name verbatim, so folding cannot corrupt
what is written.

### Mode E — a test helper that is itself flaky

- **Task 3.** The plan's own test helper had a race that would produce intermittent failures.
  Caught before dispatch. A flaky test in a new suite is worse than no test: it trains the reader
  to re-run rather than to read.

### A controller hypothesis that was wrong

Recorded because being wrong in this direction is cheap and worth doing more often. I suspected a
second `apply_annotations` call would overwrite `shadowed_note` with the first local note and lose
the database comment. Tracing it showed the guard simply does not fire on the second call, so
`shadowed_note` keeps its first-call value. No defect existed. The check cost one read.
