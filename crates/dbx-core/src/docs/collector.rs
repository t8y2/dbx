use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use futures::stream::{self, StreamExt};

use crate::connection::AppState;
use crate::docs::dbml::{enum_type_name, is_inline_enum_spelling};
use crate::docs::{
    build_relationships, DocEnum, DocTable, NoteSource, ProjectMeta, Relationship, SchemaSnapshot, SnapshotWarning,
    TableKind,
};
use crate::models::connection::ConnectionConfig;
use crate::schema;
use crate::table_structure_sql::{database_type_label, supports_comments, supports_foreign_keys};
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

/// MySQL reports `ENUM('a','b')` inline rather than as a named type, so DBML
/// needs a synthesized `{table}_{column}` name for it. PostgreSQL, by
/// contrast, reports a named enum type's own identifier in `data_type` — its
/// native name is used instead, so the user's real type identity survives
/// and a type shared by several columns is recognized as the same enum
/// (see `build_enums`, which deduplicates by name).
fn synthesize_enum(schema: Option<&str>, table: &str, column: &ColumnInfo) -> Option<DocEnum> {
    let values = column.enum_values.as_ref().filter(|values| !values.is_empty())?;
    Some(DocEnum {
        schema: schema.map(ToOwned::to_owned),
        name: enum_type_name(column, table),
        values: values.clone(),
        note: None,
        synthesized: is_inline_enum_spelling(&column.data_type),
    })
}

/// Collect every enum referenced by `tables`, deduplicated by (schema,
/// name). A named type (e.g. a PostgreSQL enum) is typically shared by
/// several columns — without deduplication each column would emit its own
/// copy of the same block, which is invalid DBML.
fn build_enums(tables: &[DocTable]) -> Vec<DocEnum> {
    let mut enums = Vec::new();
    let mut seen: HashSet<(Option<String>, String)> = HashSet::new();
    for table in tables {
        for column in &table.columns {
            let Some(value) = synthesize_enum(table.schema.as_deref(), &table.name, column) else { continue };
            if seen.insert((value.schema.clone(), value.name.clone())) {
                enums.push(value);
            }
        }
    }
    enums
}

fn cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

/// Whether any table or column in the collected snapshot carries a
/// non-empty comment. Used to corroborate `supports_comments` — a DDL-only
/// capability flag — against what introspection actually returned.
fn any_comment_collected(tables: &[DocTable]) -> bool {
    tables.iter().any(|table| {
        table.note.as_deref().is_some_and(|note| !note.trim().is_empty())
            || table
                .columns
                .iter()
                .any(|column| column.comment.as_deref().is_some_and(|comment| !comment.trim().is_empty()))
    })
}

/// True when the `CommentsUnsupported` warning belongs in the snapshot: the
/// engine's DDL capability flag says it can't do comments, and collection
/// found none to contradict it.
fn should_warn_comments_unsupported(supports_comments: bool, tables: &[DocTable]) -> bool {
    !supports_comments && !any_comment_collected(tables)
}

/// True when the `NoForeignKeyMetadata` warning belongs in the snapshot: the
/// engine's DDL capability flag says it can't do foreign keys, and
/// collection found no relationships to contradict it.
fn should_warn_no_foreign_key_metadata(supports_foreign_keys: bool, relationships: &[Relationship]) -> bool {
    !supports_foreign_keys && relationships.is_empty()
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
    let engine = database_type_label(connection.db_type);
    let connection_id = connection.id.as_str();

    let schemas = if options.schemas.is_empty() {
        match schema::list_schemas_core(state, connection_id, &options.database).await {
            Ok(schemas) => schemas,
            Err(error) => {
                // Distinguish "enumeration failed" from "no schemas exist" —
                // the latter is a legitimately empty document, the former is
                // a cryptic one if it silently proceeds against schema "".
                warnings.push(SnapshotWarning::TableSkipped {
                    table: "*".to_string(),
                    reason: format!("schema enumeration failed: {error}"),
                });
                Vec::new()
            }
        }
    } else {
        options.schemas.clone()
    };
    let effective_schemas = if schemas.is_empty() { vec![String::new()] } else { schemas };

    // Enumerate every table first so progress has a real total.
    let mut targets: Vec<(String, crate::types::TableInfo)> = Vec::new();
    for schema_name in &effective_schemas {
        match schema::list_tables_core(
            state,
            connection_id,
            &options.database,
            schema_name,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        {
            Ok(tables) => {
                for info in tables {
                    if options.includes_table(schema_name, &info.name) {
                        targets.push((schema_name.clone(), info));
                    }
                }
            }
            Err(error) => {
                warnings.push(SnapshotWarning::TableSkipped { table: format!("{schema_name}.*"), reason: error })
            }
        }
    }

    let total = targets.len();

    let collected: Vec<Result<(DocTable, Vec<SnapshotWarning>), SnapshotWarning>> =
        stream::iter(targets.into_iter().enumerate())
            .map(|(index, (schema_name, info))| {
                let database = options.database.clone();
                async move {
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

                    let mut table_warnings = Vec::new();

                    // Indexes feed `relations.rs`'s uniqueness check, so a
                    // failure here must not look identical to "this table
                    // genuinely has no indexes" — that would silently
                    // downgrade a OneToOne relationship to ManyToOne.
                    let indexes = match schema::list_indexes_core(
                        state,
                        connection_id,
                        &database,
                        &schema_name,
                        &info.name,
                    )
                    .await
                    {
                        Ok(indexes) => indexes,
                        Err(error) => {
                            table_warnings.push(SnapshotWarning::TableSkipped {
                                table: format!("{schema_name}.{}", info.name),
                                reason: format!("indexes unavailable: {error}"),
                            });
                            Vec::new()
                        }
                    };

                    // Foreign keys also degrade to empty rather than failing the
                    // table, but a real query failure must not look identical to
                    // "this table genuinely has no foreign keys" — it is reported
                    // as its own warning instead of being silently discarded.
                    let foreign_keys =
                        match schema::list_foreign_keys_core(state, connection_id, &database, &schema_name, &info.name)
                            .await
                        {
                            Ok(keys) => keys,
                            Err(error) => {
                                table_warnings.push(SnapshotWarning::TableSkipped {
                                    table: format!("{schema_name}.{}", info.name),
                                    reason: format!("foreign keys unavailable: {error}"),
                                });
                                Vec::new()
                            }
                        };

                    Ok((
                        DocTable {
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
                        },
                        table_warnings,
                    ))
                }
            })
            .buffer_unordered(MAX_CONCURRENT_TABLES)
            .collect()
            .await;

    let mut tables = Vec::new();
    for outcome in collected {
        match outcome {
            Ok((table, table_warnings)) => {
                tables.push(table);
                warnings.extend(table_warnings);
            }
            Err(warning) => warnings.push(warning),
        }
    }

    tables.sort_by_key(|table| table.qualified_name());

    let enums = build_enums(&tables);

    let relationships = build_relationships(&tables);

    // The capability flags gate DDL generation (COMMENT ON, foreign key
    // clauses), not introspection — IRIS is the proven divergence: it
    // reports comments on introspection despite the editor being unable to
    // ALTER them, so `supports_comments` alone would be a false positive. A
    // warning fires only when the flag says an engine can't AND collection
    // corroborates that nothing of the kind actually came back.
    if should_warn_comments_unsupported(supports_comments(connection.db_type), &tables) {
        warnings.push(SnapshotWarning::CommentsUnsupported { engine: engine.clone() });
    }
    if should_warn_no_foreign_key_metadata(supports_foreign_keys(connection.db_type), &relationships) {
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
    fn synthesises_a_named_enum_from_an_inline_mysql_enum_column() {
        let mut column = crate::types::ColumnInfo {
            name: "status".to_string(),
            data_type: "enum('pending','shipped')".to_string(),
            ..Default::default()
        };
        column.enum_values = Some(vec!["pending".to_string(), "shipped".to_string()]);

        let synthesized = synthesize_enum(Some("public"), "orders", &column).expect("enum");

        assert_eq!(synthesized.name, "orders_status");
        assert_eq!(synthesized.values, vec!["pending", "shipped"]);
        assert!(synthesized.synthesized);
    }

    #[test]
    fn a_postgres_named_enum_column_keeps_its_own_type_name() {
        // PostgreSQL reports the enum's own type name in `data_type`, not an
        // inline `ENUM(...)` spelling. The user's real type identity must
        // survive into the document instead of being replaced by a
        // synthesized `{table}_{column}` name.
        let mut column = crate::types::ColumnInfo {
            name: "status".to_string(),
            data_type: "ConversationStatus".to_string(),
            ..Default::default()
        };
        column.enum_values = Some(vec!["open".to_string(), "closed".to_string()]);

        let synthesized = synthesize_enum(Some("public"), "conversations", &column).expect("enum");

        assert_eq!(synthesized.name, "ConversationStatus");
        assert!(!synthesized.synthesized);
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

    fn enum_column(name: &str, data_type: &str, values: &[&str]) -> crate::types::ColumnInfo {
        crate::types::ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            enum_values: Some(values.iter().map(|v| v.to_string()).collect()),
            ..Default::default()
        }
    }

    fn table_with_columns(schema: &str, name: &str, columns: Vec<crate::types::ColumnInfo>) -> DocTable {
        DocTable {
            schema: Some(schema.to_string()),
            name: name.to_string(),
            kind: TableKind::Table,
            columns,
            indexes: vec![],
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
    fn a_named_enum_type_shared_by_two_columns_is_emitted_once() {
        let conversations = table_with_columns(
            "public",
            "conversations",
            vec![enum_column("status", "ConversationStatus", &["open", "closed"])],
        );
        let archived_conversations = table_with_columns(
            "public",
            "archived_conversations",
            vec![enum_column("status", "ConversationStatus", &["open", "closed"])],
        );

        let enums = build_enums(&[conversations, archived_conversations]);

        assert_eq!(enums.len(), 1, "two columns of the same named type must dedupe to one block: {enums:?}");
        assert_eq!(enums[0].name, "ConversationStatus");
        assert!(!enums[0].synthesized);
    }

    #[test]
    fn postgres_reports_foreign_key_ddl_capability_true() {
        assert!(supports_foreign_keys(crate::models::connection::DatabaseType::Postgres));
    }

    fn column_with_comment(comment: &str) -> crate::types::ColumnInfo {
        crate::types::ColumnInfo {
            name: "notes".to_string(),
            data_type: "text".to_string(),
            comment: Some(comment.to_string()),
            ..Default::default()
        }
    }

    fn sample_relationship() -> Relationship {
        Relationship {
            id: "orders.customer_id->customers.id".to_string(),
            name: None,
            from: crate::docs::FieldRef {
                schema: Some("public".to_string()),
                table: "orders".to_string(),
                column: "customer_id".to_string(),
            },
            to: crate::docs::FieldRef {
                schema: Some("public".to_string()),
                table: "customers".to_string(),
                column: "id".to_string(),
            },
            cardinality: crate::docs::Cardinality::ManyToOne,
            on_update: None,
            on_delete: None,
        }
    }

    #[test]
    fn comments_unsupported_warning_fires_when_flag_is_false_and_nothing_was_collected() {
        let tables = vec![table_with_columns("public", "orders", vec![])];
        assert!(should_warn_comments_unsupported(false, &tables));
    }

    #[test]
    fn comments_unsupported_warning_is_absent_when_a_table_comment_was_collected() {
        // Regression: IRIS reports `comment: false` on the DDL capability
        // flag (it supports %DESCRIPTION at CREATE time but DBX cannot ALTER
        // it), yet IRIS still returns real comments on introspection. The
        // warning must not contradict data actually present in the snapshot.
        let mut table = table_with_columns("public", "orders", vec![]);
        table.note = Some("Checkout rows.".to_string());
        assert!(!should_warn_comments_unsupported(false, &[table]));
    }

    #[test]
    fn comments_unsupported_warning_is_absent_when_a_column_comment_was_collected() {
        let tables = vec![table_with_columns("public", "orders", vec![column_with_comment("Internal notes.")])];
        assert!(!should_warn_comments_unsupported(false, &tables));
    }

    #[test]
    fn comments_unsupported_warning_does_not_fire_when_the_capability_flag_is_true() {
        let tables = vec![table_with_columns("public", "orders", vec![])];
        assert!(!should_warn_comments_unsupported(true, &tables));
    }

    #[test]
    fn no_foreign_key_warning_fires_when_flag_is_false_and_no_relationships_were_collected() {
        assert!(should_warn_no_foreign_key_metadata(false, &[]));
    }

    #[test]
    fn no_foreign_key_warning_is_absent_when_relationships_were_collected() {
        // Regression: ClickHouse/Doris genuinely report zero FK metadata, so
        // this must still fire for them — but an engine that DOES report
        // relationships must not be flagged just because its DDL capability
        // flag is false.
        let relationships = vec![sample_relationship()];
        assert!(!should_warn_no_foreign_key_metadata(false, &relationships));
    }

    #[test]
    fn no_foreign_key_warning_does_not_fire_when_the_capability_flag_is_true() {
        assert!(!should_warn_no_foreign_key_metadata(true, &[]));
    }
}
