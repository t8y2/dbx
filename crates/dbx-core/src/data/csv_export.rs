use serde::{Deserialize, Serialize};
use std::fs::File;
use std::future::Future;
use std::io::{BufWriter, Write};

use crate::connection::AppState;
use crate::models::connection::DatabaseType;
use crate::query::{execute_sql_statement_with_options, QueryExecutionOptions};
use crate::sql_dialect::{build_table_data_select_sql, TableDataSelectSqlOptions};
use crate::types::QueryResult;

pub use dbx_formats::csv_export::*;

const TABLE_DATA_EXPORT_PAGE_SIZE: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCsvExportOptions {
    pub file_path: String,
    pub connection_id: String,
    pub database: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_size: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub csv_quote_mode: CsvQuoteMode,
    /// CSV 里 NULL 写成什么。默认 `\N`；空字符串表示关闭该字面量，
    /// 退回「NULL 写成空字段」的旧行为（此时 NULL 与空字符串无法区分）。
    #[serde(default = "default_csv_null_literal")]
    pub null_literal: String,
}

/// Export pages go through the same dialect code as the grid, so the statement has to match the
/// connected server too: Neo4j below 5 only accepts `id()` where 5+ uses `elementId()`. That needs
/// the recorded version next to the connection type.
async fn connection_server_version_and_type(
    state: &AppState,
    connection_id: &str,
) -> Result<(Option<String>, DatabaseType), String> {
    state
        .configs
        .read()
        .await
        .get(connection_id)
        .map(|config| {
            let server_version = config.database_info.as_ref().and_then(|info| info.product_version.clone());
            (server_version, config.db_type)
        })
        .ok_or_else(|| format!("Connection config not found: {connection_id}"))
}

pub async fn export_table_data_csv_core(state: &AppState, options: TableCsvExportOptions) -> Result<u64, String> {
    let (server_version, database_type) = connection_server_version_and_type(state, &options.connection_id).await?;
    // This loop pages with `LIMIT <page_size> OFFSET <n>` and stops at the first
    // short page. Neither half holds for SOQL: a `/query` response carries at most
    // 2000 rows and hands the rest back as a QueryLocator (`has_more` +
    // `session_id`), and OFFSET is capped at 2000, so the first page always looks
    // short and the export would stop there — a CSV silently missing the rest of
    // the object. Refuse instead of truncating; a Salesforce export has to follow
    // the QueryLocator (`fetch_more`) the way the grid's "load more" does.
    if database_type == DatabaseType::Salesforce {
        return Err("Exporting a Salesforce object to CSV is not supported yet: SOQL pages through a QueryLocator, not LIMIT/OFFSET. Run a SOQL query and export its result instead.".to_string());
    }
    let mut writer =
        BufWriter::new(File::create(&options.file_path).map_err(|err| format!("Failed to write CSV file: {err}"))?);
    writer.write_all("\u{FEFF}".as_bytes()).map_err(|err| err.to_string())?;
    let client_session_id =
        (database_type == DatabaseType::Cassandra).then(|| format!("table-export:{}", uuid::Uuid::new_v4()));
    let export_options = &options;
    let outcome = write_table_csv_pages(
        &mut writer,
        database_type,
        server_version.as_deref(),
        &options,
        client_session_id.as_deref(),
        |sql, query_options| async move {
            execute_sql_statement_with_options(
                state,
                &export_options.connection_id,
                &export_options.database,
                &sql,
                export_options.schema.as_deref(),
                None,
                query_options,
            )
            .await
        },
    )
    .await;
    if let Some(client_session_id) = client_session_id {
        let _ =
            state.close_client_session_pool(&options.connection_id, Some(&options.database), &client_session_id).await;
    }
    outcome
}

async fn write_table_csv_pages<Execute, QueryFuture>(
    writer: &mut impl Write,
    database_type: DatabaseType,
    server_version: Option<&str>,
    options: &TableCsvExportOptions,
    client_session_id: Option<&str>,
    mut execute_page: Execute,
) -> Result<u64, String>
where
    Execute: FnMut(String, QueryExecutionOptions) -> QueryFuture,
    QueryFuture: Future<Output = Result<QueryResult, String>>,
{
    let use_cursor = database_type == DatabaseType::Cassandra;
    let requested_page_size = options.page_size.unwrap_or(TABLE_DATA_EXPORT_PAGE_SIZE).max(1);
    let page_size = if use_cursor { requested_page_size.min(TABLE_DATA_EXPORT_PAGE_SIZE) } else { requested_page_size };
    let mut session_id = None;

    let mut offset = 0usize;
    let mut rows_exported = 0u64;
    let mut wrote_header = false;

    loop {
        let sql = build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(database_type),
            server_version: server_version.map(str::to_owned),
            schema: options.schema.clone(),
            table_name: options.table_name.clone(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: options.columns.clone(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(page_size),
            offset: Some(offset),
            where_input: None,
            include_row_id: false,
            ..Default::default()
        });
        let result = execute_page(
            sql,
            QueryExecutionOptions {
                max_rows: Some(if use_cursor { i32::MAX as usize } else { page_size }),
                fetch_size: use_cursor.then_some(page_size),
                page_size: use_cursor.then_some(page_size),
                result_session_id: session_id.take(),
                client_session_id: client_session_id.map(str::to_string),
                timeout_secs: options.timeout_secs,
                ..Default::default()
            },
        )
        .await?;
        let fetched = result.rows.len();
        let complete = if use_cursor {
            session_id = result.session_id.clone().filter(|session| !session.trim().is_empty());
            if result.truncated {
                return Err("Incomplete cursor result during table export".to_string());
            }
            if result.has_more && session_id.is_none() {
                return Err("Result session ended before table export completed".to_string());
            }
            !result.has_more
        } else {
            fetched < page_size
        };

        if !wrote_header {
            write_csv_text_row(writer, result.columns, options.csv_quote_mode)?;
            wrote_header = true;
        }

        for row in result.rows {
            writer.write_all(b"\n").map_err(|err| err.to_string())?;
            write_csv_value_row_with_options(
                writer,
                row,
                options.csv_quote_mode,
                csv_null_literal(&options.null_literal),
            )?;
        }

        rows_exported += fetched as u64;
        if complete {
            break;
        }
        offset += fetched;
    }

    if rows_exported == 0 {
        writer.write_all(b"\n").map_err(|err| err.to_string())?;
    }
    writer.flush().map_err(|err| err.to_string())?;
    Ok(rows_exported)
}

#[cfg(test)]
mod tests {
    use super::{export_table_data_csv_core, write_table_csv_pages, CsvQuoteMode, TableCsvExportOptions};
    use crate::connection::AppState;
    use crate::models::connection::{ConnectionConfig, DatabaseType};
    use crate::types::QueryResult;

    fn export_options(page_size: usize) -> TableCsvExportOptions {
        TableCsvExportOptions {
            file_path: String::new(),
            connection_id: "csv-test".to_string(),
            database: "app".to_string(),
            schema: None,
            table_name: "events".to_string(),
            columns: vec!["id".to_string()],
            page_size: Some(page_size),
            timeout_secs: Some(30),
            csv_quote_mode: CsvQuoteMode::default(),
            null_literal: String::new(),
        }
    }

    fn page(ids: &[usize], session_id: Option<&str>, has_more: bool) -> QueryResult {
        serde_json::from_value(serde_json::json!({
            "columns": ["id"],
            "rows": ids.iter().map(|id| vec![*id]).collect::<Vec<_>>(),
            "affected_rows": 0,
            "execution_time_ms": 1,
            "session_id": session_id,
            "has_more": has_more
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn cassandra_csv_export_follows_cursor_beyond_default_page_size() {
        let first_ids: Vec<usize> = (1..=10_000).collect();
        let mut pages = vec![page(&first_ids, Some("cursor-1"), true), page(&[10_001], None, false)].into_iter();
        let mut requests = Vec::new();
        let mut output = Vec::new();
        let count = write_table_csv_pages(
            &mut output,
            DatabaseType::Cassandra,
            None,
            &export_options(usize::MAX),
            Some("export-test"),
            |sql, options| {
                requests.push((sql, options));
                std::future::ready(Ok(pages.next().expect("must not restart the first page")))
            },
        )
        .await
        .unwrap();
        assert_eq!(count, 10_001);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].1.result_session_id, None);
        assert_eq!(requests[1].1.result_session_id.as_deref(), Some("cursor-1"));
        for (sql, options) in requests {
            assert!(!sql.contains("OFFSET"));
            assert!(!sql.contains("LIMIT"));
            assert_eq!(options.max_rows, Some(i32::MAX as usize));
            assert_eq!(options.page_size, Some(10_000));
            assert_eq!(options.fetch_size, Some(10_000));
            assert_eq!(options.client_session_id.as_deref(), Some("export-test"));
            assert_eq!(options.timeout_secs, Some(30));
        }
        let csv = String::from_utf8(output).unwrap();
        assert_eq!(csv.lines().count(), 10_002);
        assert_eq!(csv.lines().skip(1).collect::<std::collections::HashSet<_>>().len(), 10_001);
    }

    #[tokio::test]
    async fn cassandra_csv_export_handles_short_empty_and_exact_cursor_pages() {
        for pages in [
            vec![page(&[], None, false)],
            vec![page(&[1, 2], None, false)],
            vec![page(&[1], Some("cursor-1"), true), page(&[], Some("cursor-1"), true), page(&[2, 3], None, false)],
        ] {
            let expected_rows: usize = pages.iter().map(|page| page.rows.len()).sum();
            let expected_calls = pages.len();
            let mut pages = pages.into_iter();
            let mut calls = 0;
            let count = write_table_csv_pages(
                &mut Vec::new(),
                DatabaseType::Cassandra,
                None,
                &export_options(2),
                Some("export-test"),
                |_, _| {
                    calls += 1;
                    std::future::ready(Ok(pages.next().expect("unexpected extra request")))
                },
            )
            .await
            .unwrap();
            assert_eq!(count, expected_rows as u64);
            assert_eq!(calls, expected_calls);
        }
    }

    #[tokio::test]
    async fn cassandra_csv_export_rejects_incomplete_cursor_pages() {
        let mut truncated = page(&[1], None, false);
        truncated.truncated = true;
        for malformed in [page(&[1], None, true), page(&[1], Some("   "), true), truncated] {
            let mut calls = 0;
            let error = write_table_csv_pages(
                &mut Vec::new(),
                DatabaseType::Cassandra,
                None,
                &export_options(2),
                Some("export-test"),
                |_, _| {
                    calls += 1;
                    std::future::ready(Ok(malformed.clone()))
                },
            )
            .await
            .expect_err("incomplete CSV must not be reported as successful");
            assert!(error.contains("export"));
            assert_eq!(calls, 1);
        }
    }

    #[tokio::test]
    async fn cassandra_csv_export_propagates_continuation_failure() {
        let mut calls = 0;
        let error = write_table_csv_pages(
            &mut Vec::new(),
            DatabaseType::Cassandra,
            None,
            &export_options(2),
            Some("export-test"),
            |_, options| {
                calls += 1;
                std::future::ready(if calls == 1 {
                    Ok(page(&[1], Some("cursor-lost"), true))
                } else {
                    assert_eq!(options.result_session_id.as_deref(), Some("cursor-lost"));
                    Err("cursor lost".to_string())
                })
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "cursor lost");
        assert_eq!(calls, 2);
    }

    #[tokio::test]
    async fn non_cassandra_csv_export_preserves_limit_offset_paging() {
        let mut pages = vec![page(&[1, 2], None, false), page(&[3], None, false)].into_iter();
        let mut sqls = Vec::new();
        let count = write_table_csv_pages(
            &mut Vec::new(),
            DatabaseType::Sqlite,
            None,
            &export_options(2),
            None,
            |sql, options| {
                sqls.push(sql);
                assert_eq!(options.max_rows, Some(2));
                assert!(options.page_size.is_none());
                assert!(options.result_session_id.is_none());
                assert!(options.client_session_id.is_none());
                std::future::ready(Ok(pages.next().unwrap()))
            },
        )
        .await
        .unwrap();
        assert_eq!(count, 3);
        assert_eq!(sqls.len(), 2);
        assert!(sqls[0].contains("LIMIT 2"));
        assert!(sqls[1].contains("OFFSET 2"));
    }

    #[tokio::test]
    async fn csv_export_uses_the_identifier_function_the_neo4j_server_understands() {
        for (server_version, identifier) in [("Neo4j/4.4.44", "id(n)"), ("Neo4j/5.26.0", "elementId(n)")] {
            let mut pages = vec![page(&[1], None, false)].into_iter();
            let mut sqls = Vec::new();
            let options = export_options(2);
            write_table_csv_pages(
                &mut Vec::new(),
                DatabaseType::Neo4j,
                Some(server_version),
                &options,
                None,
                |sql, _| {
                    sqls.push(sql);
                    std::future::ready(Ok(pages.next().expect("unexpected extra export page")))
                },
            )
            .await
            .unwrap();
            assert_eq!(sqls.len(), 1);
            assert!(sqls[0].contains(identifier), "{server_version} export SQL was {}", sqls[0]);
        }
    }

    fn salesforce_config(id: &str) -> ConnectionConfig {
        let mut config = serde_json::from_value::<ConnectionConfig>(serde_json::json!({
            "id": id,
            "name": "SFDC QA",
            "db_type": "postgres",
            "host": "example.my.salesforce.com",
            "port": 443,
            "username": "user@example.com",
            "password": "",
            "database": ""
        }))
        .unwrap();
        config.db_type = DatabaseType::Salesforce;
        config
    }

    /// 表数据导出必须把 NULL 写成字面量、空字符串写成 `""`，否则导入端拿不到引号信息，
    /// 两者都会变成 NULL（正是「NOT NULL DEFAULT '' 的列导入报错」的成因）。
    #[tokio::test]
    async fn streamed_table_export_writes_null_literal_and_keeps_empty_strings() {
        fn result_with_a_null_and_an_empty_string() -> QueryResult {
            serde_json::from_value(serde_json::json!({
                "columns": ["name", "note"],
                "rows": [["a", null], ["b", ""]],
                "affected_rows": 0,
                "execution_time_ms": 1,
                "session_id": null,
                "has_more": false
            }))
            .unwrap()
        }

        let mut options = export_options(10);
        options.null_literal = dbx_formats::csv_export::DEFAULT_CSV_NULL_LITERAL.to_string();
        let mut pages = vec![result_with_a_null_and_an_empty_string()].into_iter();
        let mut output = Vec::new();
        write_table_csv_pages(&mut output, DatabaseType::Postgres, &options, None, |_, _| {
            std::future::ready(Ok(pages.next().expect("single page")))
        })
        .await
        .unwrap();
        assert_eq!(String::from_utf8(output).unwrap(), "\"name\",\"note\"\n\"a\",\\N\n\"b\",\"\"");

        // 关闭字面量（旧行为）：NULL 与空串都写空字段，二者在文件里已无法区分
        options.null_literal = String::new();
        let mut pages = vec![result_with_a_null_and_an_empty_string()].into_iter();
        let mut output = Vec::new();
        write_table_csv_pages(&mut output, DatabaseType::Postgres, &options, None, |_, _| {
            std::future::ready(Ok(pages.next().expect("single page")))
        })
        .await
        .unwrap();
        assert_eq!(String::from_utf8(output).unwrap(), "\"name\",\"note\"\n\"a\",\n\"b\",\"\"");
    }

    /// 用户反馈：`NOT NULL DEFAULT ''` 的列导出成 CSV、再导入到另一个环境的同名表时报
    /// 「不允许为 null」。用真实 SQLite 库走一遍「导出 → 导入」，确认空字符串仍是空字符串、
    /// NULL 仍是 NULL（而不是双双塌成 NULL）。
    #[tokio::test]
    async fn exported_csv_round_trips_empty_strings_and_nulls_through_a_real_import() {
        use crate::data::table_import::{
            import_table_file_core, TableImportColumnMapping, TableImportMode, TableImportParseOptions,
            TableImportRequest, TableImportSourceFormat,
        };
        use std::io::Write;

        const DDL: &str = "CREATE TABLE contacts (id INTEGER, name TEXT NOT NULL DEFAULT '', note TEXT)";

        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source.db");
        let sqlite = crate::db::sqlite::connect_path_create_if_missing(source_path.to_str().unwrap()).await.unwrap();
        crate::db::sqlite::execute_query(&sqlite, DDL).await.unwrap();
        crate::db::sqlite::execute_query(
            &sqlite,
            "INSERT INTO contacts (id, name, note) VALUES (1, '', NULL), (2, 'Ada', 'x')",
        )
        .await
        .unwrap();

        let mut options = export_options(100);
        options.table_name = "contacts".to_string();
        options.columns = vec!["id".to_string(), "name".to_string(), "note".to_string()];
        options.null_literal = dbx_formats::csv_export::DEFAULT_CSV_NULL_LITERAL.to_string();

        let mut exported_bytes = "\u{FEFF}".as_bytes().to_vec();
        let exported = write_table_csv_pages(&mut exported_bytes, DatabaseType::Sqlite, &options, None, |sql, _| {
            let sqlite = sqlite.clone();
            async move { crate::db::sqlite::execute_query(&sqlite, &sql).await.map_err(|error| error.to_string()) }
        })
        .await
        .unwrap();
        assert_eq!(exported, 2);
        // 导出的 NULL 与空串必须已经可区分：空串 `""`、NULL 裸写 `\N`
        assert_eq!(
            String::from_utf8(exported_bytes.clone()).unwrap(),
            "\u{FEFF}\"id\",\"name\",\"note\"\n\"1\",\"\",\\N\n\"2\",\"Ada\",\"x\""
        );

        let csv_path = directory.path().join("contacts.csv");
        let mut csv_file = std::fs::File::create(&csv_path).unwrap();
        csv_file.write_all(&exported_bytes).unwrap();
        csv_file.flush().unwrap();
        drop(csv_file);

        // 目标环境：同名 DDL，`name` 同样是 NOT NULL DEFAULT ''
        let target_path = directory.path().join("target.db");
        let target = crate::db::sqlite::connect_path_create_if_missing(target_path.to_str().unwrap()).await.unwrap();
        crate::db::sqlite::execute_query(&target, DDL).await.unwrap();

        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let connection_id = "csv-round-trip";
        let pool_key = format!("{connection_id}:session:import");
        state
            .update_connection_pools(|connections| {
                connections.insert(pool_key.clone(), crate::connection::PoolKind::Sqlite(target.clone()));
            })
            .await;
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": connection_id,
            "name": "CSV round-trip",
            "db_type": "sqlite",
            "host": "",
            "port": 0,
            "username": "",
            "password": "",
            "database": target_path.to_string_lossy()
        }))
        .unwrap();
        state.configs.write().await.insert(connection_id.to_string(), config);

        let request = TableImportRequest {
            import_id: "csv-round-trip".to_string(),
            connection_id: connection_id.to_string(),
            database: String::new(),
            schema: String::new(),
            table: "contacts".to_string(),
            file_path: csv_path.to_string_lossy().into_owned(),
            source_ref: None,
            source_format: Some(TableImportSourceFormat::Csv),
            parse_options: TableImportParseOptions::default(),
            mappings: ["id", "name", "note"]
                .into_iter()
                .map(|column| TableImportColumnMapping {
                    source_column: column.to_string(),
                    target_column: column.to_string(),
                    target_data_type: None,
                })
                .collect(),
            mode: TableImportMode::Append,
            create_table: false,
            batch_size: 2,
            date_time_format: None,
            prepared_source: None,
            retain_source: false,
            conflict_policy: None,
            skip_duplicate_rows: false,
        };
        let summary = import_table_file_core(
            &state,
            &request,
            &DatabaseType::Sqlite,
            &pool_key,
            |_| Box::pin(async { false }),
            |_| {},
        )
        .await
        .expect("NOT NULL DEFAULT '' 的列必须能原样导入空字符串");

        assert_eq!(summary.rows_imported, 2);
        assert_eq!(
            crate::db::sqlite::execute_query(&target, "SELECT id, name, note FROM contacts ORDER BY id")
                .await
                .unwrap()
                .rows,
            vec![
                vec![serde_json::json!(1), serde_json::json!(""), serde_json::Value::Null],
                vec![serde_json::json!(2), serde_json::json!("Ada"), serde_json::json!("x")],
            ]
        );

        // 反向验证：把 NULL 字面量关掉、恢复「空字段即 NULL」的旧配置再导一次同一个文件，
        // 必须重现用户报的「不允许为 null」，否则这条用例并没有真正覆盖该缺陷。
        let legacy_request = TableImportRequest {
            import_id: "csv-round-trip-legacy".to_string(),
            parse_options: TableImportParseOptions {
                null_literal: Some(String::new()),
                ..TableImportParseOptions::default()
            },
            ..request
        };
        let error = import_table_file_core(
            &state,
            &legacy_request,
            &DatabaseType::Sqlite,
            &pool_key,
            |_| Box::pin(async { false }),
            |_| {},
        )
        .await
        .expect_err("旧配置会把空字符串写成 NULL，必须触发 NOT NULL 约束错误");
        assert!(error.to_lowercase().contains("not null"), "unexpected error: {error}");
    }

    /// The refusal has to land before `File::create`, otherwise the user is left
    /// holding a header-only CSV that looks like an object with no records.
    #[tokio::test]
    async fn salesforce_table_csv_export_is_refused_before_a_file_is_created() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
        let state = AppState::new(storage);
        let config = salesforce_config("sfdc-csv");
        state.configs.write().await.insert(config.id.clone(), config);

        let csv_path = directory.path().join("Account.csv");
        let error = export_table_data_csv_core(
            &state,
            TableCsvExportOptions {
                file_path: csv_path.to_string_lossy().into_owned(),
                connection_id: "sfdc-csv".to_string(),
                database: String::new(),
                schema: None,
                table_name: "Account".to_string(),
                columns: vec!["Id".to_string(), "Name".to_string()],
                page_size: None,
                timeout_secs: None,
                csv_quote_mode: CsvQuoteMode::default(),
                null_literal: String::new(),
            },
        )
        .await
        .expect_err("SOQL cannot page an export with LIMIT/OFFSET");

        assert!(error.contains("QueryLocator"), "unexpected error: {error}");
        assert!(!csv_path.exists(), "a refused export must not leave a truncated CSV behind");
    }
}
