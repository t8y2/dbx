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

/// Human-readable warning text for headless callers.
///
/// The viewer translates these through its own `docs.warnings` namespace; the
/// CLI has no i18n runtime, so the English prose lives here. Without it the
/// only thing to print is the derived `Debug` form, which exposes the struct
/// shape and reads like a panic rather than like advice.
impl std::fmt::Display for SnapshotWarning {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TableSkipped { table, reason } => {
                write!(formatter, "{table} was skipped: {reason}. It is missing from this documentation.")
            }
            Self::NoForeignKeyMetadata { engine } => {
                write!(
                    formatter,
                    "{engine} does not report foreign key metadata, so no relationships could be derived."
                )
            }
            Self::CommentsUnsupported { engine } => write!(
                formatter,
                "{engine} does not support table or column comments, so every description comes from your own notes."
            ),
            Self::OrphanedNotes { count } => write!(
                formatter,
                "{count} note(s) refer to a table or column that no longer exists. Nothing was deleted."
            ),
            Self::DbmlOmitted { table, item, reason } => {
                write!(formatter, "{item} on {table} is documented but omitted from the DBML: {reason}.")
            }
        }
    }
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

    #[test]
    fn every_warning_renders_as_prose() {
        // `dbx dbml` prints these to stderr. The derived Debug form leaks the
        // struct shape (`DbmlOmitted { table: "public.t", .. }`), which reads
        // as a crash report rather than as advice, so Display is what the CLI
        // must use. The wording tracks the viewer's own warning strings.
        let cases = [
            (
                SnapshotWarning::TableSkipped { table: "public.orders".into(), reason: "permission denied".into() },
                "public.orders was skipped: permission denied. It is missing from this documentation.",
            ),
            (
                SnapshotWarning::NoForeignKeyMetadata { engine: "ClickHouse".into() },
                "ClickHouse does not report foreign key metadata, so no relationships could be derived.",
            ),
            (
                SnapshotWarning::CommentsUnsupported { engine: "SQLite".into() },
                "SQLite does not support table or column comments, so every description comes from your own notes.",
            ),
            (
                SnapshotWarning::OrphanedNotes { count: 3 },
                "3 note(s) refer to a table or column that no longer exists. Nothing was deleted.",
            ),
            (
                SnapshotWarning::DbmlOmitted {
                    table: "public.orders".into(),
                    item: "idx_partial".into(),
                    reason: "partial index filter has no DBML equivalent".into(),
                },
                "idx_partial on public.orders is documented but omitted from the DBML: partial index filter has no DBML equivalent.",
            ),
        ];

        for (warning, expected) in cases {
            assert_eq!(warning.to_string(), expected);
        }
    }

    #[test]
    fn a_warning_never_renders_as_its_debug_form() {
        // The regression this guards: reverting the CLI to `{warning:?}` is a
        // one-character edit that still compiles and still prints something.
        let warning = SnapshotWarning::OrphanedNotes { count: 1 };
        assert!(!warning.to_string().contains('{'), "got: {warning}");
        assert_ne!(warning.to_string(), format!("{warning:?}"));
    }
}
