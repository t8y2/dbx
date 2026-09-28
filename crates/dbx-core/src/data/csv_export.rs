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
}

async fn connection_database_type(state: &AppState, connection_id: &str) -> Result<DatabaseType, String> {
    state
        .configs
        .read()
        .await
        .get(connection_id)
        .map(|config| config.db_type)
        .ok_or_else(|| format!("Connection config not found: {connection_id}"))
}

pub async fn export_table_data_csv_core(state: &AppState, options: TableCsvExportOptions) -> Result<u64, String> {
    let database_type = connection_database_type(state, &options.connection_id).await?;
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
            write_csv_value_row(writer, row, options.csv_quote_mode)?;
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
        let count =
            write_table_csv_pages(&mut Vec::new(), DatabaseType::Sqlite, &export_options(2), None, |sql, options| {
                sqls.push(sql);
                assert_eq!(options.max_rows, Some(2));
                assert!(options.page_size.is_none());
                assert!(options.result_session_id.is_none());
                assert!(options.client_session_id.is_none());
                std::future::ready(Ok(pages.next().unwrap()))
            })
            .await
            .unwrap();
        assert_eq!(count, 3);
        assert_eq!(sqls.len(), 2);
        assert!(sqls[0].contains("LIMIT 2"));
        assert!(sqls[1].contains("OFFSET 2"));
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
            },
        )
        .await
        .expect_err("SOQL cannot page an export with LIMIT/OFFSET");

        assert!(error.contains("QueryLocator"), "unexpected error: {error}");
        assert!(!csv_path.exists(), "a refused export must not leave a truncated CSV behind");
    }
}
