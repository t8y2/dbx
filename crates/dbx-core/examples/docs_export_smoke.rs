//! Builds a small two-table snapshot and writes the real
//! `to_standalone_html` output to `argv[1]`.
//!
//! Exists so `exportSmoke.spec.ts` can execute genuine export output in
//! happy-dom rather than a hand-built approximation of it.

use std::collections::BTreeMap;
use std::env;
use std::fs;

use dbx_core::docs::annotations::AnnotationFile;
use dbx_core::docs::{
    to_standalone_html, Cardinality, DocTable, FieldRef, ProjectMeta, Relationship, SchemaSnapshot, TableKind,
};
use dbx_core::types::ColumnInfo;

fn main() {
    let out_path = env::args().nth(1).expect("usage: docs_export_smoke <output-path>");

    let orders = DocTable {
        schema: Some("public".into()),
        name: "orders".into(),
        kind: TableKind::Table,
        columns: vec![
            ColumnInfo { name: "id".into(), data_type: "bigint".into(), is_primary_key: true, ..Default::default() },
            ColumnInfo { name: "customer_id".into(), data_type: "bigint".into(), ..Default::default() },
        ],
        indexes: vec![],
        foreign_keys: vec![],
        group_id: None,
        note: Some("Checkout rows.".into()),
        note_source: dbx_core::docs::NoteSource::Database,
        shadowed_note: None,
        column_notes: BTreeMap::new(),
        estimated_rows: Some(2_400_000),
        view_definition: None,
    };

    let customers = DocTable {
        schema: Some("public".into()),
        name: "customers".into(),
        kind: TableKind::Table,
        columns: vec![ColumnInfo {
            name: "id".into(),
            data_type: "bigint".into(),
            is_primary_key: true,
            ..Default::default()
        }],
        indexes: vec![],
        foreign_keys: vec![],
        group_id: None,
        note: None,
        note_source: dbx_core::docs::NoteSource::None,
        shadowed_note: None,
        column_notes: BTreeMap::new(),
        estimated_rows: Some(50_000),
        view_definition: None,
    };

    let snapshot = SchemaSnapshot {
        format_version: 1,
        project: ProjectMeta {
            name: "shop".into(),
            database_type: "postgres".into(),
            database: Some("shop".into()),
            schemas: vec!["public".into()],
            generated_at: "2026-08-06T00:00:00Z".into(),
            note: None,
        },
        tables: vec![orders, customers],
        relationships: vec![Relationship {
            id: "orders.customer_id->customers.id".into(),
            name: None,
            from: FieldRef { schema: Some("public".into()), table: "orders".into(), column: "customer_id".into() },
            to: FieldRef { schema: Some("public".into()), table: "customers".into(), column: "id".into() },
            cardinality: Cardinality::ManyToOne,
            on_update: None,
            on_delete: None,
        }],
        groups: vec![],
        enums: vec![],
        warnings: vec![],
    };

    let annotations = AnnotationFile { format_version: 1, project: None, groups: Vec::new(), tables: BTreeMap::new() };

    let html = to_standalone_html(&snapshot, &annotations, "en").expect("export");
    fs::write(&out_path, html).expect("write output file");
}
