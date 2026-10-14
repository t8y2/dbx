//! Read-only planning for the structure-only transfer SQL preview.
//!
//! A structure-only transfer used to start with no idea what it would run. This module
//! renders the statements the create pass is about to execute so the confirmation dialog can
//! show them first. It is strictly planning: target names, source metadata and the SQL are
//! read from the same helpers the execution pass uses (`ddl_plan::prepare_table_ddl`,
//! `plan_postgres_owned_sequences_for_transfer`, `generate_comment_ddl_with_column_quoting`,
//! `generate_postgres_index_ddl`, `generate_postgres_foreign_key_ddl`,
//! `generate_mysql_foreign_key_alter_statements`), and no statement is ever executed here.
//!
//! The result is a plan, not a frozen script: `start_transfer` re-reads source and target
//! metadata before it executes, and the existing execution-time fail-closed checks stay in
//! force. Callers must therefore never present the preview as "these exact statements will
//! run".
//!
//! Where the create pass normalizes before executing (splitting a reused PostgreSQL table
//! script, stripping inline foreign keys, dropping the post-table index/foreign-key statements
//! it re-applies from metadata), the preview runs the same normalization — a statement the
//! executor filters out must not be shown. Re-applied statements are shown once per step,
//! including the idempotent `COMMENT` the reused script may already contain.

use super::*;

/// Emitted when the request asks for no structure DDL at all (`createTable = false`).
const CREATE_TABLE_DISABLED_NOTE: &str =
    "-- This transfer has structure DDL disabled (createTable = false): no structure statements will run.";

/// Emitted when the transfer also moves non-table schema objects whose DDL this preview
/// deliberately does not expand (views, routines, triggers, standalone sequences, ...).
const UNEXPANDED_OBJECTS_NOTE: &str = "\
-- Additional schema objects selected by this request (or the legacy PostgreSQL default) are transferred.
-- Their generated DDL is not expanded in this preview.";

/// Emitted for PostgreSQL-compatible table transfers whose dependency closure is applied by
/// the execution pass but is intentionally not expanded in the table DDL preview.
const POSTGRES_TABLE_DEPENDENCIES_NOTE: &str = "\
-- PostgreSQL table dependencies (types, extensions, policies and sequence bindings) are transferred
-- for the selected tables during execution; their generated SQL is not expanded in this preview.";

/// Plan the structure DDL a structure-only transfer is about to run.
///
/// Everything inside is read-only: metadata reads plus SQL rendering. The only statements
/// handed to `execute_on_pool` are catalog queries (`SELECT`), never DDL.
pub(super) async fn build_structure_preview(
    state: &Arc<AppState>,
    request: &TransferRequest,
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
    source_pool_key: &str,
    target_pool_key: &str,
) -> Result<TransferStructurePreview, String> {
    if !request.create_table {
        return Ok(TransferStructurePreview {
            sql: CREATE_TABLE_DISABLED_NOTE.to_string(),
            tables: Vec::new(),
            operations: Vec::new(),
        });
    }

    let pg_compat_transfer = is_postgres_compat_transfer(source_db_type, target_db_type);
    let index_if_not_exists = pg_compat_transfer && target_supports_if_not_exists_ddl(state, target_pool_key).await;
    // Two execution paths create the target schema before any table does: the inline ensure in
    // `create_transfer_target_table` (PostgreSQL-dialect target from another family) and
    // `transfer_postgres_schema_dependencies` (PostgreSQL→PostgreSQL). Plan the same statement
    // for either, deciding it with a read-only existence check instead of executing anything.
    let create_schema_sql = if is_postgres_transfer_dialect(target_db_type)
        && !request.target_schema.trim().is_empty()
        && !postgres_schema_exists(state, target_pool_key, &request.target_schema).await?
    {
        Some(format!("CREATE SCHEMA {}", quote_identifier(&request.target_schema, target_db_type)))
    } else {
        None
    };

    // Same order and same foreign key metadata the create pass uses.
    let (tables, known_foreign_keys) = sorted_source_tables_with_foreign_keys(state, request).await;

    let mut sections: Vec<String> = Vec::new();
    let mut operations = Vec::new();
    let mut deferred_fk_operations = Vec::new();
    if let Some(create_schema_sql) = &create_schema_sql {
        operations.push(TransferStructureOperation::schema(&request.target_schema));
        sections.push(format!(
            "-- Ensure the target schema exists\n{}",
            statement_block(std::slice::from_ref(create_schema_sql))
        ));
    }

    let mut planned_tables: Vec<TransferStructurePreviewTable> = Vec::with_capacity(tables.len());
    let mut table_sections: Vec<String> = Vec::new();
    let mut deferred_fk_alters: Vec<String> = Vec::new();

    for table in &tables {
        let ResolvedTransferTargetTable { name: target_table, preexisting } = resolve_transfer_target_table_name(
            state,
            request,
            table,
            target_pool_key,
            target_db_type,
            request.source_catalog.as_deref(),
            request.target_catalog.as_deref(),
        )
        .await;
        // A rebuild renames every preexisting target aside before the create pass runs, so
        // those tables are created fresh — the same reset the create pass performs.
        if preexisting && !request.drop_target_before_create {
            operations.push(TransferStructureOperation::table(
                TransferStructureOperationKind::SkipExistingTable,
                table,
                &target_table,
            ));
            let note = format!(
                "-- {table} -> {target_table}: the target table already exists, so this transfer plans no structure \
                 DDL for it"
            );
            planned_tables.push(TransferStructurePreviewTable {
                source_table: table.clone(),
                target_table,
                preexisting: true,
                sql: note.clone(),
            });
            table_sections.push(note);
            continue;
        }

        let planned = plan_table_structure(
            state,
            request,
            table,
            &target_table,
            preexisting && request.drop_target_before_create,
            source_db_type,
            target_db_type,
            source_pool_key,
            target_pool_key,
            &known_foreign_keys,
            pg_compat_transfer,
            index_if_not_exists,
        )
        .await?;
        deferred_fk_alters.extend(planned.deferred_fk_alters);
        operations.extend(planned.operations);
        deferred_fk_operations.extend(planned.deferred_fk_operations);

        let section = format!("-- {} -> {}\n{}", table, target_table, statement_block(&planned.statements));
        planned_tables.push(TransferStructurePreviewTable {
            source_table: table.clone(),
            target_table,
            preexisting: false,
            sql: section.clone(),
        });
        table_sections.push(section);
    }

    sections.extend(table_sections);
    if pg_compat_transfer && !request.tables.is_empty() {
        sections.push(POSTGRES_TABLE_DEPENDENCIES_NOTE.to_string());
    }
    if !deferred_fk_alters.is_empty() {
        // MySQL-family targets defer foreign keys so creation order never has to satisfy
        // them; the create pass flushes these after every table exists.
        sections.push(format!(
            "-- Foreign keys added after every table exists, so creation order never has to satisfy them\n{}",
            statement_block(&deferred_fk_alters)
        ));
    }
    operations.extend(deferred_fk_operations);
    sections.extend(unexpanded_schema_object_notes(source_db_type, target_db_type, request));

    Ok(TransferStructurePreview { sql: sections.join("\n\n"), tables: planned_tables, operations })
}

struct PlannedTableStructure {
    statements: Vec<String>,
    operations: Vec<TransferStructureOperation>,
    deferred_fk_alters: Vec<String>,
    deferred_fk_operations: Vec<TransferStructureOperation>,
}

fn sequence_operation(
    kind: TransferStructureOperationKind,
    sequence: &PostgresOwnedSequence,
    target_table: &str,
) -> TransferStructureOperation {
    TransferStructureOperation::object(kind, &sequence.name, &sequence.owner_table, target_table)
}

fn postgres_index_operations(
    indexes: &[db::IndexInfo],
    source_table: &str,
    target_table: &str,
) -> Vec<TransferStructureOperation> {
    indexes
        .iter()
        .filter(|index| !index.is_primary && !index.name.trim().is_empty() && !index.columns.is_empty())
        .map(|index| {
            TransferStructureOperation::object(
                TransferStructureOperationKind::CreateIndex,
                &index.name,
                source_table,
                target_table,
            )
        })
        .collect()
}

fn foreign_key_operations(names: &[String], source_table: &str, target_table: &str) -> Vec<TransferStructureOperation> {
    names
        .iter()
        .map(|name| {
            TransferStructureOperation::object(
                TransferStructureOperationKind::AddForeignKey,
                name,
                source_table,
                target_table,
            )
        })
        .collect()
}

fn comment_operations(
    columns: &[db::ColumnInfo],
    source_table: &str,
    target_table: &str,
    target_db_type: &DatabaseType,
    table_comment: Option<&str>,
) -> Vec<TransferStructureOperation> {
    let table_comments_supported = supports_comment_on_transfer_ddl(target_db_type);
    let column_comments_supported = table_comments_supported || matches!(target_db_type, DatabaseType::ClickHouse);
    let mut operations = Vec::new();

    if table_comments_supported && table_comment.is_some_and(|comment| !comment.trim().is_empty()) {
        operations.push(TransferStructureOperation::table(
            TransferStructureOperationKind::AddComment,
            source_table,
            target_table,
        ));
    }
    if column_comments_supported {
        operations.extend(columns.iter().filter_map(|column| {
            column.comment.as_deref().filter(|comment| !comment.trim().is_empty()).map(|_| {
                TransferStructureOperation::object(
                    TransferStructureOperationKind::AddComment,
                    &column.name,
                    source_table,
                    target_table,
                )
            })
        }));
    }

    operations
}

/// Render the statements the create pass runs for one table, in execution order.
#[allow(clippy::too_many_arguments)]
async fn plan_table_structure(
    state: &Arc<AppState>,
    request: &TransferRequest,
    table: &str,
    target_table: &str,
    rebuild_existing_target: bool,
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
    source_pool_key: &str,
    target_pool_key: &str,
    known_foreign_keys: &HashMap<String, Vec<db::ForeignKeyInfo>>,
    pg_compat_transfer: bool,
    index_if_not_exists: bool,
) -> Result<PlannedTableStructure, String> {
    let preserves_target_table_name = target_table == table;
    let columns = source_transfer_columns(state, request, table, source_pool_key).await?;
    let table_comment = source_table_comment(state, request, table, source_db_type).await;

    // Planned here, created by the execution pass.
    let owned_sequences = plan_postgres_owned_sequences_for_transfer(
        state,
        request,
        table,
        source_pool_key,
        target_pool_key,
        pg_compat_transfer,
        preserves_target_table_name,
        false,
    )
    .await?;
    // Shared with `create_transfer_target_table`: the same helper renders the DDL that runs.
    let prepared = ddl_plan::prepare_table_ddl(
        state,
        request,
        table,
        target_table,
        source_db_type,
        target_db_type,
        source_pool_key,
        &columns,
        table_comment.as_deref(),
        known_foreign_keys,
    )
    .await?;
    let ddl = if pg_compat_transfer && !owned_sequences.owned_sequences.is_empty() {
        rewrite_postgres_serial_columns_for_transfer(
            &prepared.ddl,
            &owned_sequences.owned_sequences,
            &request.target_schema,
        )
    } else {
        prepared.ddl
    };

    let mut statements = Vec::new();
    let mut operations = Vec::new();
    for (sequence, statement) in owned_sequences.create_sequences.iter().zip(&owned_sequences.create_statements) {
        statements.push(statement.clone());
        operations.push(sequence_operation(TransferStructureOperationKind::CreateSequence, sequence, target_table));
    }
    let table_kind = if rebuild_existing_target {
        TransferStructureOperationKind::RebuildTable
    } else {
        TransferStructureOperationKind::CreateTable
    };
    operations.push(TransferStructureOperation::table(table_kind, table, target_table));

    // Normalize the DDL exactly like the executor does before running it: the reused
    // PostgreSQL script spans several statements, has its inline foreign keys stripped, and
    // drops the post-table index/foreign-key statements that are re-applied from structured
    // metadata below. A statement the create pass filters out must never appear here.
    statements.extend(transfer_ddl_statements(&ddl, target_db_type));

    let comment_statements = generate_comment_ddl_with_column_quoting(
        &columns,
        target_table,
        &request.target_schema,
        target_db_type,
        table_comment.as_deref(),
        request.quote_target_column_names,
    );
    operations.extend(comment_operations(&columns, table, target_table, target_db_type, table_comment.as_deref()));
    statements.extend(comment_statements);

    for sequence in &owned_sequences.owned_sequences {
        statements.push(postgres_owned_sequence_bind_sql(request, sequence));
        operations.push(sequence_operation(TransferStructureOperationKind::BindSequence, sequence, target_table));
    }

    let mut deferred_fk_operations = Vec::new();
    if supports_deferred_mysql_foreign_keys(target_db_type) {
        deferred_fk_operations = foreign_key_operations(&prepared.deferred_fk_names, table, target_table);
    }

    if pg_compat_transfer && preserves_target_table_name {
        // PostgreSQL-compatible targets restore indexes and foreign keys from structured
        // source metadata once the table exists. The operation records use the same metadata
        // consumed by the DDL generators; SQL is never parsed to infer them.
        let indexes = get_postgres_indexes_for_transfer(
            state,
            source_pool_key,
            &request.source_database,
            &request.source_schema,
            table,
        )
        .await?;
        statements.extend(generate_postgres_index_ddl(
            &indexes,
            target_table,
            &request.target_schema,
            index_if_not_exists,
        ));
        operations.extend(postgres_index_operations(&indexes, table, target_table));

        let foreign_keys = get_postgres_foreign_keys_for_transfer(
            state,
            source_pool_key,
            &request.source_database,
            &request.source_schema,
            table,
        )
        .await?;
        statements.extend(generate_postgres_foreign_key_ddl(
            &foreign_keys,
            target_table,
            &request.source_schema,
            &request.target_schema,
        ));
        let foreign_key_names = group_foreign_keys_by_constraint_name(&foreign_keys)
            .into_iter()
            .map(|(name, _)| name.to_string())
            .collect::<Vec<_>>();
        operations.extend(foreign_key_operations(&foreign_key_names, table, target_table));
    }

    Ok(PlannedTableStructure {
        statements,
        operations,
        deferred_fk_alters: prepared.deferred_fk_alters,
        deferred_fk_operations,
    })
}

/// Read and de-duplicate the source columns the create pass uses, failing the same way the
/// pass does when the source returns nothing.
async fn source_transfer_columns(
    state: &AppState,
    request: &TransferRequest,
    table: &str,
    source_pool_key: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    let raw = get_columns_for_transfer(
        state,
        source_pool_key,
        &request.source_connection_id,
        &request.source_database,
        &request.source_schema,
        table,
        request.source_catalog.as_deref(),
    )
    .await?;
    let mut seen = HashSet::new();
    let columns = raw.into_iter().filter(|column| seen.insert(column.name.clone())).collect::<Vec<_>>();
    if columns.is_empty() {
        return Err(format!("No columns found for table {table}"));
    }
    Ok(columns)
}

/// Source table comment, via the same fallback chain the create pass uses. A metadata read
/// failure only drops the comment, exactly like execution.
async fn source_table_comment(
    state: &Arc<AppState>,
    request: &TransferRequest,
    table: &str,
    source_db_type: &DatabaseType,
) -> Option<String> {
    if *source_db_type == DatabaseType::Postgres {
        get_transfer_table_comment_isolated(
            state.clone(),
            request.source_connection_id.clone(),
            request.source_database.clone(),
            request.source_schema.clone(),
            table.to_string(),
        )
        .await
        .unwrap_or_default()
    } else {
        list_transfer_tables_isolated(
            state.clone(),
            request.source_connection_id.clone(),
            request.source_database.clone(),
            request.source_schema.clone(),
            request.source_catalog.clone(),
            *source_db_type,
            table.to_string(),
            1,
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .next()
        .and_then(|info| info.comment)
    }
}

/// Table creation order plus the foreign key metadata behind the deferred MySQL alters, using
/// the same helper (and the same external-catalog skip) the transfer pass uses.
async fn sorted_source_tables_with_foreign_keys(
    state: &Arc<AppState>,
    request: &TransferRequest,
) -> (Vec<String>, HashMap<String, Vec<db::ForeignKeyInfo>>) {
    if request.tables.len() <= 1 {
        return (request.tables.clone(), HashMap::new());
    }
    let skip_fk_sort = {
        let configs = state.configs.read().await;
        configs
            .get(&request.source_connection_id)
            .and_then(|config| resolve_external_transfer_catalog_for_config(request.source_catalog.as_deref(), config))
            .is_some()
    };
    if skip_fk_sort {
        return (request.tables.clone(), HashMap::new());
    }
    sort_tables_by_fk_dependency_with_foreign_keys(
        state,
        &request.source_connection_id,
        &request.source_database,
        &request.source_schema,
        &request.tables,
        true,
    )
    .await
    .unwrap_or_else(|error| {
        log::warn!("[transfer] structure preview could not sort tables by FK dependency: {error}");
        (request.tables.clone(), HashMap::new())
    })
}

async fn postgres_schema_exists(state: &AppState, target_pool_key: &str, target_schema: &str) -> Result<bool, String> {
    let result = execute_on_pool(state, target_pool_key, &postgres_schema_exists_sql(target_schema)).await?;
    Ok(query_result_has_rows(&result))
}

/// The statement block the preview never expands: selected non-table schema objects.
fn unexpanded_schema_object_notes(
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
    request: &TransferRequest,
) -> Vec<String> {
    if !should_transfer_schema_objects(source_db_type, target_db_type, request) {
        return Vec::new();
    }
    let selections = match request.object_selection_mode() {
        TransferObjectSelectionMode::LegacyUnspecified => return vec![UNEXPANDED_OBJECTS_NOTE.to_string()],
        TransferObjectSelectionMode::Explicit(selections) => selections,
    };
    let mut notes = vec![UNEXPANDED_OBJECTS_NOTE.to_string()];
    for selection in selections {
        if selection.object_type == TransferObjectKind::Table || selection.names.is_empty() {
            continue;
        }
        notes.push(format!("-- {}: {}", preview_object_kind_label(&selection.object_type), selection.names.join(", ")));
    }
    notes
}

fn preview_object_kind_label(kind: &TransferObjectKind) -> &'static str {
    match kind {
        TransferObjectKind::Table => "Tables",
        TransferObjectKind::View => "Views",
        TransferObjectKind::MaterializedView => "Materialized views",
        TransferObjectKind::Procedure => "Procedures",
        TransferObjectKind::Function => "Functions",
        TransferObjectKind::Trigger => "Triggers",
        TransferObjectKind::Sequence => "Sequences",
        TransferObjectKind::Event => "Events",
    }
}

fn statement_block(statements: &[String]) -> String {
    statements
        .iter()
        .map(|statement| ensure_sql_statement_terminated(statement))
        .filter(|statement| !statement.is_empty() && statement != ";")
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn structured_ddl_metadata_produces_operation_dtos() {
        let index = db::IndexInfo {
            name: "idx_orders_created_at".into(),
            columns: vec!["lower(\"email\")".into()],
            is_unique: false,
            is_primary: false,
            filter: None,
            index_type: Some("btree".into()),
            included_columns: None,
            comment: None,
            key_is_expression: vec![true],
            column_opclasses: vec![Some("text_pattern_ops".into())],
            key_options: vec![1],
            constraint_backed: false,
        };
        let index_sql = generate_postgres_index_ddl(std::slice::from_ref(&index), "orders", "public", true);
        let index_operations = postgres_index_operations(std::slice::from_ref(&index), "orders", "orders");
        assert_eq!(
            index_sql,
            vec![
                "CREATE INDEX IF NOT EXISTS \"idx_orders_created_at\" ON \"public\".\"orders\" USING btree (lower(\"email\") text_pattern_ops DESC NULLS LAST)"
            ]
        );
        assert_eq!(index_operations[0].kind, TransferStructureOperationKind::CreateIndex);
        assert_eq!(index_operations[0].object_name.as_deref(), Some("idx_orders_created_at"));

        let foreign_key = db::ForeignKeyInfo {
            name: "fk_orders_user".into(),
            column: "user_id".into(),
            ref_schema: Some("public".into()),
            ref_table: "users".into(),
            ref_column: "id".into(),
            on_update: None,
            on_delete: None,
        };
        let foreign_key_sql =
            generate_postgres_foreign_key_ddl(std::slice::from_ref(&foreign_key), "orders", "public", "reporting");
        let foreign_key_names = group_foreign_keys_by_constraint_name(std::slice::from_ref(&foreign_key))
            .into_iter()
            .map(|(name, _)| name.to_string())
            .collect::<Vec<_>>();
        let pg_foreign_key_operations = foreign_key_operations(&foreign_key_names, "orders", "orders");
        assert!(foreign_key_sql[0].contains("fk_orders_user"));
        assert_eq!(pg_foreign_key_operations[0].kind, TransferStructureOperationKind::AddForeignKey);
        assert_eq!(pg_foreign_key_operations[0].object_name.as_deref(), Some("fk_orders_user"));

        let request = structure_request(json!({
            "sourceDatabase": "app",
            "sourceSchema": "public",
            "targetDatabase": "warehouse",
            "targetSchema": "reporting"
        }));
        let mysql_foreign_key_sql = generate_mysql_foreign_key_alter_statements(
            std::slice::from_ref(&foreign_key),
            &request,
            "orders",
            &DatabaseType::Mysql,
        );
        let mysql_foreign_key_operations = foreign_key_operations(&foreign_key_names, "orders", "orders");
        assert!(mysql_foreign_key_sql[0].contains("ADD CONSTRAINT `fk_orders_user`"));
        assert_eq!(mysql_foreign_key_operations[0].kind, TransferStructureOperationKind::AddForeignKey);

        let sequence = PostgresOwnedSequence {
            name: "orders_id_seq".into(),
            owner_table: "orders".into(),
            owner_column: "id".into(),
        };
        let sequence_definition = PostgresTransferSequence {
            name: sequence.name.clone(),
            data_type: "bigint".into(),
            start_value: "1".into(),
            min_value: "1".into(),
            max_value: "9223372036854775807".into(),
            increment: "1".into(),
            cycle: false,
            cache_value: "1".into(),
            last_value: None,
            is_called: None,
        };
        let create_sequence_sql =
            generate_postgres_transfer_sequence_create_ddl(&sequence_definition, "reporting", false);
        let bind_sequence_sql = postgres_owned_sequence_bind_sql(&request, &sequence);
        let create_sequence_operation =
            sequence_operation(TransferStructureOperationKind::CreateSequence, &sequence, "orders");
        let bind_sequence_operation =
            sequence_operation(TransferStructureOperationKind::BindSequence, &sequence, "orders");
        assert!(create_sequence_sql.contains("CREATE SEQUENCE"));
        assert_eq!(create_sequence_operation.kind, TransferStructureOperationKind::CreateSequence);
        assert!(bind_sequence_sql.contains("OWNED BY"));
        assert_eq!(bind_sequence_operation.kind, TransferStructureOperationKind::BindSequence);
        assert_eq!(bind_sequence_operation.target_table.as_deref(), Some("orders"));

        let columns = vec![db::ColumnInfo {
            name: "id".into(),
            comment: Some("primary identifier".into()),
            ..Default::default()
        }];
        let comment_sql = generate_comment_ddl_with_column_quoting(
            &columns,
            "orders",
            "reporting",
            &DatabaseType::Postgres,
            Some("order records"),
            true,
        );
        let comment_operations =
            comment_operations(&columns, "orders", "orders", &DatabaseType::Postgres, Some("order records"));
        assert_eq!(comment_sql.len(), 2);
        assert_eq!(comment_operations.len(), 2);
        assert!(comment_operations
            .iter()
            .all(|operation| operation.kind == TransferStructureOperationKind::AddComment));
        assert_eq!(comment_operations[0].object_name, None);
        assert_eq!(comment_operations[1].object_name.as_deref(), Some("id"));

        let schema = serde_json::to_value(TransferStructureOperation::schema("reporting")).unwrap();
        assert_eq!(schema["kind"], "createSchema");
        assert_eq!(schema["objectName"], "reporting");
        assert!(schema.get("sourceTable").is_none());
    }

    #[test]
    fn unexpanded_object_notes_distinguish_legacy_and_explicit_empty_selections() {
        let legacy = structure_request(json!({}));
        let explicit_empty = structure_request(json!({ "objects": [] }));
        let explicit_view = structure_request(json!({
            "objects": [{ "objectType": "VIEW", "names": ["v_orders"] }]
        }));

        assert_eq!(
            unexpanded_schema_object_notes(&DatabaseType::Postgres, &DatabaseType::Postgres, &legacy),
            vec![UNEXPANDED_OBJECTS_NOTE.to_string()],
        );
        assert!(unexpanded_schema_object_notes(&DatabaseType::Postgres, &DatabaseType::Postgres, &explicit_empty)
            .is_empty());
        assert_eq!(
            unexpanded_schema_object_notes(&DatabaseType::Postgres, &DatabaseType::Postgres, &explicit_view),
            vec![UNEXPANDED_OBJECTS_NOTE.to_string(), "-- Views: v_orders".to_string()],
        );
    }

    async fn sqlite_fixture() -> (tempfile::TempDir, Arc<AppState>, String, String) {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_dir(storage, directory.path().join("plugins")));
        for id in ["source", "target"] {
            let path = directory.path().join(format!("{id}.db"));
            crate::db::sqlite::connect_path_create_if_missing(path.to_str().unwrap()).await.unwrap();
            let config: ConnectionConfig = serde_json::from_value(json!({
                "id": id, "name": id, "db_type": "sqlite", "host": path.to_str().unwrap(),
                "port": 0, "username": "", "password": "", "database": null,
                "one_time": false, "save_password": false, "read_only": false
            }))
            .unwrap();
            state.configs.write().await.insert(id.to_string(), config);
        }
        let source_pool = ensure_transfer_pool(&state, "source", "main", None).await.unwrap();
        let target_pool = ensure_transfer_pool(&state, "target", "main", None).await.unwrap();
        for table in ["orders", "users"] {
            execute_on_pool(&state, &source_pool, &format!("CREATE TABLE {table}(id INTEGER PRIMARY KEY, name TEXT)"))
                .await
                .unwrap();
        }
        (directory, state, source_pool, target_pool)
    }

    fn structure_request(overrides: serde_json::Value) -> TransferRequest {
        let mut value = json!({
            "transferId": uuid::Uuid::new_v4().to_string(),
            "sourceConnectionId": "source", "sourceDatabase": "main", "sourceSchema": "main",
            "targetConnectionId": "target", "targetDatabase": "main", "targetSchema": "main",
            "tables": ["orders", "users"], "createTable": true, "content": "structureOnly",
            "mode": "append", "batchSize": 10
        });
        let map = value.as_object_mut().unwrap();
        for (key, override_value) in overrides.as_object().unwrap() {
            map.insert(key.clone(), override_value.clone());
        }
        serde_json::from_value(value).unwrap()
    }

    async fn preview(
        state: &Arc<AppState>,
        request: &TransferRequest,
        source_pool: &str,
        target_pool: &str,
    ) -> Result<TransferOwnershipPreview, String> {
        preview_transfer_ownership(
            state,
            request,
            &DatabaseType::Sqlite,
            &DatabaseType::Sqlite,
            source_pool,
            target_pool,
        )
        .await
    }

    async fn target_table_names(state: &AppState, target_pool: &str) -> Vec<String> {
        let result = execute_read_on_pool(
            state,
            target_pool,
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .await
        .unwrap();
        result.rows.iter().filter_map(|row| json_string_cell(row, 0)).collect()
    }

    #[tokio::test]
    async fn structure_only_preview_plans_create_table_without_executing_ddl() {
        let (_directory, state, source_pool, target_pool) = sqlite_fixture().await;
        let request = structure_request(json!({}));

        let preview = preview(&state, &request, &source_pool, &target_pool).await.unwrap();
        let structure = preview.structure.expect("structure-only must expose its structure SQL plan");

        assert_eq!(structure.tables.len(), 2, "every selected table must be planned: {:?}", structure.tables);
        assert_eq!(
            structure
                .operations
                .iter()
                .filter(|operation| operation.kind == TransferStructureOperationKind::CreateTable)
                .count(),
            2,
            "new targets must have one logical create operation each: {:?}",
            structure.operations
        );
        for table in &structure.tables {
            assert!(!table.preexisting, "a fresh target has no preexisting tables: {table:?}");
            assert!(table.sql.contains("CREATE TABLE"), "{}", table.sql);
        }
        assert!(structure.sql.contains("orders"), "{}", structure.sql);
        assert!(structure.sql.contains("users"), "{}", structure.sql);

        // Planning must not run any of it: the target database stays empty.
        assert_eq!(target_table_names(&state, &target_pool).await, Vec::<String>::new());
    }

    #[tokio::test]
    async fn structure_only_preview_handles_preexisting_target_consistently() {
        let (_directory, state, source_pool, target_pool) = sqlite_fixture().await;
        execute_on_pool(&state, &target_pool, "CREATE TABLE orders(id INTEGER PRIMARY KEY, legacy TEXT)")
            .await
            .unwrap();
        execute_on_pool(&state, &target_pool, "INSERT INTO orders VALUES(7, 'original')").await.unwrap();
        let request = structure_request(json!({ "tables": ["orders"] }));

        let preview = preview(&state, &request, &source_pool, &target_pool).await.unwrap();
        let structure = preview.structure.expect("structure-only must expose its structure SQL plan");

        assert_eq!(structure.tables.len(), 1);
        assert!(structure.tables[0].preexisting, "an existing target must be reported as preexisting: {structure:?}");
        assert!(
            !structure.sql.contains("CREATE TABLE"),
            "execution skips create DDL for a preexisting target, so the preview must too: {}",
            structure.sql
        );
        assert!(structure.sql.contains("already exists"), "{}", structure.sql);
        assert_eq!(structure.operations.len(), 1);
        assert_eq!(structure.operations[0].kind, TransferStructureOperationKind::SkipExistingTable);
        assert_eq!(structure.operations[0].target_table.as_deref(), Some("orders"));

        // The preview must not have touched the preexisting table.
        let rows = execute_read_on_pool(&state, &target_pool, "SELECT legacy FROM orders WHERE id = 7").await.unwrap();
        assert_eq!(rows.rows[0][0], json!("original"));
    }

    #[tokio::test]
    async fn structure_only_preview_without_create_table_reports_no_structure_ddl() {
        let (_directory, state, source_pool, target_pool) = sqlite_fixture().await;
        let request = structure_request(json!({ "createTable": false }));

        let preview = preview(&state, &request, &source_pool, &target_pool).await.unwrap();
        let structure = preview
            .structure
            .expect("structure-only always answers with a structure preview so clients can fail closed");

        assert!(!structure.sql.contains("CREATE TABLE"), "{}", structure.sql);
        assert!(structure.sql.contains("createTable = false"), "{}", structure.sql);
    }

    #[tokio::test]
    async fn data_only_has_no_structure_preview() {
        let (_directory, state, source_pool, target_pool) = sqlite_fixture().await;
        let request = structure_request(json!({ "content": "dataOnly", "createTable": false }));

        let preview = preview(&state, &request, &source_pool, &target_pool).await.unwrap();

        assert!(preview.structure.is_none(), "data-only runs no structure DDL: {preview:?}");
        assert!(preview.rebuild.is_none());
    }

    #[tokio::test]
    async fn structure_and_data_keeps_existing_preview_behavior() {
        let (_directory, state, source_pool, target_pool) = sqlite_fixture().await;
        execute_on_pool(&state, &target_pool, "CREATE TABLE orders(id INTEGER PRIMARY KEY, legacy TEXT)")
            .await
            .unwrap();
        let request = structure_request(json!({ "content": "structureAndData", "tables": ["orders"] }));

        let preview = preview(&state, &request, &source_pool, &target_pool).await.unwrap();

        assert!(
            preview.structure.is_none(),
            "structure-and-data keeps its current behavior in this phase: {preview:?}"
        );
        assert!(preview.rebuild.is_none());
        assert!(preview.missing_owners.is_empty());
    }

    #[tokio::test]
    async fn rebuild_preview_still_contains_existing_rename_and_cleanup_sql() {
        let (_directory, state, source_pool, target_pool) = sqlite_fixture().await;
        for table in ["orders", "users"] {
            execute_on_pool(
                &state,
                &target_pool,
                &format!("CREATE TABLE {table}(id INTEGER PRIMARY KEY, legacy TEXT)"),
            )
            .await
            .unwrap();
        }
        let request = structure_request(json!({ "dropTargetBeforeCreate": true, "dropTargetConfirmed": true }));

        let preview = preview(&state, &request, &source_pool, &target_pool).await.unwrap();
        let rebuild = preview.rebuild.expect("a rebuild transfer must expose its SQL plan");

        assert!(rebuild.sql.contains("-- 1. Backup existing target tables"), "{}", rebuild.sql);
        assert!(rebuild.sql.contains("-- 2. Recreate the"), "{}", rebuild.sql);
        assert!(rebuild.sql.contains("-- 3. Drop backups after success"), "{}", rebuild.sql);
        assert!(rebuild.backup_sql.as_deref().unwrap_or_default().contains("RENAME"), "{rebuild:?}");
        assert!(rebuild.cleanup_sql.as_deref().unwrap_or_default().contains("DROP TABLE"), "{rebuild:?}");

        // The structure plan is rendered without repeating the rename/cleanup operations.
        let structure = preview.structure.expect("structure-only must expose its structure SQL plan");
        assert!(structure.sql.contains("CREATE TABLE"), "{}", structure.sql);
        assert_eq!(
            structure
                .operations
                .iter()
                .filter(|operation| operation.kind == TransferStructureOperationKind::RebuildTable)
                .count(),
            2,
            "each rebuilt target is represented once: {:?}",
            structure.operations
        );
        assert!(
            structure.operations.iter().all(|operation| operation.kind != TransferStructureOperationKind::CreateTable),
            "a rebuild must not also be listed as a normal create: {:?}",
            structure.operations
        );
        assert!(!structure.sql.contains("RENAME"), "{}", structure.sql);
        assert!(!structure.sql.contains("DROP TABLE"), "{}", structure.sql);
        for table in &structure.tables {
            assert!(!table.preexisting, "a rebuild renames the old target aside, so it is created fresh: {table:?}");
        }

        // Still pure planning: nothing was renamed, nothing was dropped.
        assert_eq!(target_table_names(&state, &target_pool).await, vec!["orders".to_string(), "users".to_string()]);
    }
}
