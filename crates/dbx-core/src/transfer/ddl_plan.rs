//! Prepare target CREATE TABLE and deferred foreign keys without executing DDL.
//!
//! The transfer pass and the ownership preview share this planning helper so both always
//! agree on the DDL that will run and the names it will use. Nothing here executes DDL:
//! execution stays with `execute_transfer_create_table_ddl_on_pool` and the caller.

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct PreparedTableDdl {
    pub ddl: String,
    pub reused_source_ddl: bool,
    pub deferred_fk_alters: Vec<String>,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn prepare_table_ddl(
    state: &AppState,
    request: &TransferRequest,
    table: &str,
    target_table: &str,
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
    source_pool_key: &str,
    columns: &[db::ColumnInfo],
    table_comment: Option<&str>,
    known_foreign_keys: &HashMap<String, Vec<db::ForeignKeyInfo>>,
) -> Result<PreparedTableDdl, String> {
    let rebuild = request.drop_target_before_create;

    let foreign_keys = if let Some(foreign_keys) = known_foreign_keys.get(table) {
        foreign_keys.clone()
    } else if rebuild {
        // Strict for rebuilds: silently dropping foreign keys the inspection failed on
        // would produce a rebuilt table that enforces fewer constraints than the source.
        crate::schema::list_foreign_keys_core(
            state,
            &request.source_connection_id,
            &request.source_database,
            &request.source_schema,
            table,
        )
        .await
        .map_err(|e| format!("Failed to inspect source foreign keys for table '{table}' before rebuilding: {e}"))?
    } else if supports_deferred_mysql_foreign_keys(target_db_type) {
        // Ordinary MySQL-family targets keep the legacy best-effort behavior: fall back
        // to the generated DDL without foreign keys when the inspection fails. Other
        // targets never use the foreign keys, so no query is issued at all.
        match crate::schema::list_foreign_keys_core(
            state,
            &request.source_connection_id,
            &request.source_database,
            &request.source_schema,
            table,
        )
        .await
        {
            Ok(foreign_keys) => foreign_keys,
            Err(e) => {
                log::warn!("[transfer] failed to inspect source foreign keys for {table}: {e}");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    let (source_driver_profile, target_driver_profile) = {
        let configs = state.configs.read().await;
        (
            configs.get(&request.source_connection_id).and_then(|config| config.driver_profile.clone()),
            configs.get(&request.target_connection_id).and_then(|config| config.driver_profile.clone()),
        )
    };
    let can_reuse = can_reuse_source_table_ddl(
        source_db_type,
        target_db_type,
        source_driver_profile.as_deref(),
        target_driver_profile.as_deref(),
        target_table == table,
    ) && (request.quote_target_column_names
        || !matches!(target_db_type, DatabaseType::Gaussdb | DatabaseType::OpenGauss));

    // A rebuild recreates the source structure exactly. When the structure comes from
    // the source DDL (the `can_reuse` path) the column list is only used for data
    // mapping, so an empty list is fine — the DDL is read directly from the source. Only
    // when the DDL must be *generated* from the column list does incomplete metadata
    // become fatal, because there would be nothing to build the CREATE TABLE from.
    if rebuild && !can_reuse {
        let incomplete = columns.is_empty()
            || columns.iter().any(|column| column.name.trim().is_empty() || column.data_type.trim().is_empty());
        if incomplete {
            return Err(format!(
                "Cannot rebuild table '{target_table}': the source returned incomplete column metadata, and the \
                 target cannot reuse the source DDL."
            ));
        }
    }

    let mut reused_source_ddl = false;
    let ddl = if can_reuse {
        let (source_ddl, source_ddl_was_read) = if let Some(catalog) =
            resolve_external_transfer_catalog(request.source_catalog.as_deref(), source_db_type)
        {
            // Doris/StarRocks external catalog: read DDL directly via
            // SHOW CREATE TABLE catalog.database.table using the existing source
            // pool (bare MySQL — addresses any catalog).
            let pool = {
                let pool =
                    state.pool_handle(source_pool_key).await.ok_or_else(|| "Source pool not found".to_string())?;
                let PoolKind::Mysql(p, _) = &pool else {
                    return Err("Source pool must be MySQL-family for catalog DDL".to_string());
                };
                p.clone()
            };
            match db::doris::get_catalog_table_ddl(&pool, catalog, &request.source_database, table).await {
                Ok(ddl) => (ddl, true),
                Err(err) => {
                    log::warn!("[transfer] catalog DDL read failed for {table} in catalog '{catalog}': {err}; falling back to generated DDL");
                    (
                        generate_create_table_ddl_with_column_quoting(
                            columns,
                            target_table,
                            &request.source_schema,
                            &request.target_schema,
                            target_db_type,
                            source_db_type,
                            table_comment,
                            request.target_catalog.as_deref(),
                            request.quote_target_column_names,
                        ),
                        false,
                    )
                }
            }
        } else {
            match crate::schema::get_table_ddl_core(
                state,
                &request.source_connection_id,
                &request.source_database,
                &request.source_schema,
                table,
                None,
            )
            .await
            {
                Ok(ddl) => (ddl, true),
                Err(e) if rebuild => {
                    // A rebuild cannot fall back to generated DDL when the source DDL
                    // it promised to reproduce cannot be read.
                    return Err(format!("Failed to read source DDL for table '{table}' before rebuilding: {e}"));
                }
                Err(_) => (
                    generate_create_table_ddl_with_column_quoting(
                        columns,
                        target_table,
                        &request.source_schema,
                        &request.target_schema,
                        target_db_type,
                        source_db_type,
                        table_comment,
                        request.target_catalog.as_deref(),
                        request.quote_target_column_names,
                    ),
                    false,
                ),
            }
        };
        if contains_oceanbase_mysql_table_options(&source_ddl)
            && !db::oceanbase_mysql::is_profile(target_db_type, target_driver_profile.as_deref())
        {
            generate_create_table_ddl_with_column_quoting(
                columns,
                target_table,
                &request.source_schema,
                &request.target_schema,
                target_db_type,
                source_db_type,
                table_comment,
                request.target_catalog.as_deref(),
                request.quote_target_column_names,
            )
        } else {
            reused_source_ddl = source_ddl_was_read;
            rewrite_transfer_source_table_ddl(
                &source_ddl,
                &request.source_schema,
                &request.target_schema,
                source_db_type,
                target_db_type,
            )
        }
    } else {
        generate_create_table_ddl_with_column_quoting(
            columns,
            target_table,
            &request.source_schema,
            &request.target_schema,
            target_db_type,
            source_db_type,
            table_comment,
            request.target_catalog.as_deref(),
            request.quote_target_column_names,
        )
    };

    // MySQL-family targets: defer the foreign keys to ALTER statements so the table
    // creation order never has to satisfy foreign key dependencies (a foreign key cycle
    // has no valid CREATE TABLE order at all). The rebuild path above guarantees the
    // metadata behind `foreign_keys` is trustworthy before anything is stripped.
    let mut ddl = ddl;
    let mut deferred_fk_alters = Vec::new();
    if supports_deferred_mysql_foreign_keys(target_db_type) && !foreign_keys.is_empty() {
        ddl = strip_inline_foreign_key_constraint_lines(&ddl);
        deferred_fk_alters =
            generate_mysql_foreign_key_alter_statements(&foreign_keys, request, target_table, target_db_type);
    }

    Ok(PreparedTableDdl { ddl, reused_source_ddl, deferred_fk_alters })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn state_fixture() -> (Arc<AppState>, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::storage::Storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new_with_plugin_dir(storage, directory.path().join("plugins")));
        (state, directory)
    }

    fn request(rebuild: bool) -> TransferRequest {
        serde_json::from_value(json!({
            "transferId": "ddl-plan-test",
            "sourceConnectionId": "source", "sourceDatabase": "main", "sourceSchema": "main",
            "targetConnectionId": "target", "targetDatabase": "main", "targetSchema": "main",
            "tables": ["child", "Parent"], "createTable": true, "content": "structureAndData",
            "mode": "append", "batchSize": 10, "dropTargetBeforeCreate": rebuild,
            "dropTargetConfirmed": true
        }))
        .unwrap()
    }

    fn columns() -> Vec<db::ColumnInfo> {
        vec![
            db::ColumnInfo {
                name: "id".into(),
                data_type: "INTEGER".into(),
                is_primary_key: true,
                ..Default::default()
            },
            db::ColumnInfo { name: "parent_id".into(), data_type: "INTEGER".into(), ..Default::default() },
        ]
    }

    #[tokio::test]
    async fn prepared_sqlite_ddl_preserves_source_foreign_keys_without_mutating_source() {
        let (state, directory) = state_fixture().await;
        let path = directory.path().join("source.db");
        let pool = crate::db::sqlite::connect_path_create_if_missing(path.to_str().unwrap()).await.unwrap();
        pool.with_connection(|connection| {
            connection
                .execute_batch(
                    "PRAGMA foreign_keys = ON;
                     CREATE TABLE Parent (id INTEGER PRIMARY KEY);
                     CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES Parent(id) ON DELETE CASCADE);
                     INSERT INTO Parent VALUES (7);
                     INSERT INTO child VALUES (11, 7);",
                )
                .map_err(|error| error.to_string())
        })
        .unwrap();
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": "source", "name": "source", "db_type": "sqlite", "host": path.to_str().unwrap(),
            "port": 0, "username": "", "password": "", "database": null,
            "one_time": false, "save_password": false, "read_only": false
        }))
        .unwrap();
        state.configs.write().await.insert("source".into(), config);
        let source_pool_key = ensure_transfer_pool(&state, "source", "main", None).await.unwrap();
        let columns = crate::db::sqlite::get_columns(&pool, "main", "child").await.unwrap();
        let prepared = prepare_table_ddl(
            &state,
            &request(true),
            "child",
            "child",
            &DatabaseType::Sqlite,
            &DatabaseType::Sqlite,
            &source_pool_key,
            &columns,
            None,
            &HashMap::new(),
        )
        .await
        .unwrap();
        let source_rows = crate::db::sqlite::execute_query(&pool, "SELECT id, parent_id FROM child").await.unwrap();
        assert_eq!(source_rows.rows, vec![vec![json!(11), json!(7)]]);

        let target =
            crate::db::sqlite::connect_path_create_if_missing(directory.path().join("target.db").to_str().unwrap())
                .await
                .unwrap();
        target
            .with_connection(|connection| {
                connection
                    .execute_batch("PRAGMA foreign_keys = ON; CREATE TABLE Parent (id INTEGER PRIMARY KEY);")
                    .map_err(|error| error.to_string())?;
                connection.execute_batch(&prepared.ddl).map_err(|error| error.to_string())
            })
            .unwrap();
        let foreign_keys = crate::db::sqlite::list_foreign_keys(&target, "main", "child").await.unwrap();
        assert_eq!(foreign_keys.len(), 1, "source FK must survive the prepared CREATE TABLE: {}", prepared.ddl);
        assert_eq!(foreign_keys[0].ref_table, "Parent");
        assert!(crate::db::sqlite::execute_query(&target, "INSERT INTO child VALUES (1, 999)").await.is_err());
        assert!(prepared.reused_source_ddl);
    }

    #[tokio::test]
    async fn rebuild_rejects_failed_foreign_key_inspection() {
        let (state, _directory) = state_fixture().await;
        let error = prepare_table_ddl(
            &state,
            &request(true),
            "child",
            "child",
            &DatabaseType::Sqlite,
            &DatabaseType::Mysql,
            "missing-source-pool",
            &columns(),
            None,
            &HashMap::new(),
        )
        .await
        .expect_err("a rebuild cannot discard foreign keys when source metadata is unavailable");
        assert!(error.contains("child"), "{error}");
        assert!(error.to_ascii_lowercase().contains("foreign key"), "{error}");
    }

    #[tokio::test]
    async fn ordinary_foreign_key_metadata_failure_preserves_generated_fallback() {
        let (state, _directory) = state_fixture().await;
        let prepared = prepare_table_ddl(
            &state,
            &request(false),
            "child",
            "child",
            &DatabaseType::Sqlite,
            &DatabaseType::Mysql,
            "missing-source-pool",
            &columns(),
            None,
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert!(!prepared.reused_source_ddl);
        assert!(prepared.ddl.contains("CREATE TABLE"));
    }

    #[tokio::test]
    async fn deferred_foreign_key_uses_actual_target_and_case_converted_parent() {
        let (state, _directory) = state_fixture().await;
        let mut request = request(true);
        request.target_table_name_case = TransferTableNameCase::Lower;
        let known = HashMap::from([(
            "child".into(),
            vec![db::ForeignKeyInfo {
                name: "fk_child_parent".into(),
                column: "parent_id".into(),
                ref_schema: Some("main".into()),
                ref_table: "Parent".into(),
                ref_column: "id".into(),
                on_delete: Some("CASCADE".into()),
                on_update: Some("RESTRICT".into()),
            }],
        )]);
        let prepared = prepare_table_ddl(
            &state,
            &request,
            "child",
            "resolved_child",
            &DatabaseType::Sqlite,
            &DatabaseType::Mysql,
            "missing-source-pool",
            &columns(),
            None,
            &known,
        )
        .await
        .unwrap();
        assert_eq!(prepared.deferred_fk_alters, vec![
            "ALTER TABLE `resolved_child` ADD CONSTRAINT `fk_child_parent` FOREIGN KEY (`parent_id`) REFERENCES `parent` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT"
        ]);
        assert!(prepared.ddl.contains("`resolved_child`"), "{}", prepared.ddl);
    }

    #[tokio::test]
    async fn rebuild_requires_complete_column_metadata() {
        let (state, _directory) = state_fixture().await;
        let incomplete = vec![db::ColumnInfo { name: "id".into(), ..Default::default() }];
        for columns in [&[][..], incomplete.as_slice()] {
            let result = prepare_table_ddl(
                &state,
                &request(true),
                "child",
                "child",
                &DatabaseType::Sqlite,
                &DatabaseType::Mysql,
                "missing-source-pool",
                columns,
                None,
                &HashMap::from([("child".into(), Vec::new())]),
            )
            .await;
            assert!(result.is_err(), "incomplete source metadata must fail before any target DDL: {result:?}");
        }
    }
}
