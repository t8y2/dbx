use std::collections::{HashMap, HashSet};
use std::time::Instant;

use anyhow::{anyhow, bail, Result};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::config::build_endpoint;
use crate::http::CnosHttpClient;
use crate::model::{
    AgentConnectionInfo, ColumnInfo, CompletionAssistantCandidate, CompletionAssistantRequest,
    CompletionAssistantResponse, ConnectParams, DatabaseConnectionInfo, DatabaseInfo, MetadataListConstraints,
    ObjectInfo, ObjectSource, QueryOptions, QueryPageResult, QueryResult, TableInfo, CNOSDB_DATA_TYPES,
    DEFAULT_MAX_ROWS,
};

pub struct CnosdbDriver {
    client: Option<CnosHttpClient>,
    params: ConnectParams,
    current_database: String,
    query_sessions: HashMap<String, QueryCursor>,
}

struct QueryCursor {
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Vec<Value>>,
    offset: usize,
    max_rows: usize,
    affected_rows: i64,
}

pub fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

impl CnosdbDriver {
    pub fn new() -> Self {
        Self {
            client: None,
            params: ConnectParams::default(),
            current_database: String::new(),
            query_sessions: HashMap::new(),
        }
    }

    pub async fn connect(&mut self, params: ConnectParams) -> Result<()> {
        ensure_crypto_provider();
        self.disconnect().await;
        let endpoint = build_endpoint(&params)?;
        let client = CnosHttpClient::new(endpoint.clone())?;
        let token = CancellationToken::new();
        client
            .execute_sql("SHOW DATABASES", Some(&endpoint.database), 10, &token)
            .await
            .map_err(|error| anyhow!("failed to connect to CnosDB: {error:#}"))?;
        self.current_database = endpoint.database.clone();
        self.params = params;
        self.client = Some(client);
        Ok(())
    }

    pub async fn test_connection(params: ConnectParams) -> Result<DatabaseConnectionInfo> {
        let mut driver = Self::new();
        driver.connect(params).await?;
        let token = CancellationToken::new();
        driver.validate_connection(&token).await?;
        driver
            .connection_info()?
            .database_info
            .ok_or_else(|| anyhow!("CnosDB connection metadata is unavailable"))
    }

    pub async fn disconnect(&mut self) {
        self.query_sessions.clear();
        self.current_database.clear();
        self.client = None;
    }

    pub async fn validate_connection(&self, token: &CancellationToken) -> Result<()> {
        self.require_client()?
            .execute_sql("SHOW DATABASES", None, 5, token)
            .await?;
        Ok(())
    }

    pub fn connection_info(&self) -> Result<AgentConnectionInfo> {
        self.require_client()?;
        Ok(AgentConnectionInfo {
            identifier_quote: "\"".into(),
            compatibility_mode: None,
            database_info: Some(DatabaseConnectionInfo {
                product_name: Some("CnosDB".into()),
                product_version: None,
                current_database: non_empty(&self.current_database),
                driver_name: Some("dbx-cnosdb-http".into()),
                driver_version: Some(env!("CARGO_PKG_VERSION").into()),
                unquoted_identifier_case: Some("lower"),
                quoted_identifier_case: Some("sensitive"),
            }),
        })
    }

    pub async fn list_databases(&self, token: &CancellationToken) -> Result<Vec<DatabaseInfo>> {
        let result = self.require_client()?.execute_sql("SHOW DATABASES", None, 0, token).await?;
        let name_idx = preferred_column_index(
            &result.columns,
            &["database_name", "name", "database", "db_name"],
        );
        Ok(result
            .rows
            .into_iter()
            .filter_map(|row| {
                let value = name_idx.and_then(|index| row.get(index)).or_else(|| row.first())?;
                json_cell_text(value)
            })
            .filter(|name| !is_system_database(name))
            .map(|name| DatabaseInfo { name })
            .collect())
    }

    pub fn list_schemas(&self) -> Vec<String> {
        Vec::new()
    }

    pub fn list_data_types(&self) -> Vec<String> {
        CNOSDB_DATA_TYPES.iter().map(|value| (*value).to_string()).collect()
    }

    pub async fn list_tables(
        &mut self,
        database: &str,
        constraints: MetadataListConstraints,
        token: &CancellationToken,
    ) -> Result<Vec<TableInfo>> {
        if !table_type_allowed(&constraints.object_types, "TABLE") {
            return Ok(Vec::new());
        }
        let database = effective_database(database, &self.current_database)?.to_string();
        let result = self
            .require_client()?
            .execute_sql("SHOW TABLES", Some(&database), 0, token)
            .await?;
        let name_idx = preferred_column_index(
            &result.columns,
            &["table_name", "name", "table", "tables"],
        );
        let mut tables = result
            .rows
            .into_iter()
            .filter_map(|row| {
                let value = name_idx.and_then(|index| row.get(index)).or_else(|| row.first())?;
                json_cell_text(value)
            })
            .map(|name| TableInfo {
                name,
                table_type: "TABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            })
            .collect::<Vec<_>>();
        tables.sort_by(|left, right| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()));
        Ok(filter_tables(&tables, &constraints))
    }

    pub async fn list_objects(
        &mut self,
        database: &str,
        constraints: MetadataListConstraints,
        token: &CancellationToken,
    ) -> Result<Vec<ObjectInfo>> {
        let database = effective_database(database, &self.current_database)?.to_string();
        let tables = self.list_tables(&database, constraints, token).await?;
        Ok(tables
            .into_iter()
            .map(|table| ObjectInfo {
                name: table.name,
                object_type: table.table_type,
                schema: database.clone(),
                comment: table.comment,
            })
            .collect())
    }

    pub async fn get_columns(&self, database: &str, table: &str, token: &CancellationToken) -> Result<Vec<ColumnInfo>> {
        let database = effective_database(database, &self.current_database)?;
        let sql = format!("DESCRIBE TABLE {}", quote_ident(table));
        let result = self.require_client()?.execute_sql(&sql, Some(database), 0, token).await?;
        Ok(parse_describe_columns(result))
    }

    pub async fn get_table_comment(&self, _database: &str, _table: &str) -> Result<Option<String>> {
        Ok(None)
    }

    pub async fn get_object_source(
        &self,
        database: &str,
        name: &str,
        object_type: &str,
        token: &CancellationToken,
    ) -> Result<ObjectSource> {
        let database = effective_database(database, &self.current_database)?;
        let columns = self.get_columns(database, name, token).await?;
        Ok(ObjectSource {
            name: name.to_string(),
            object_type: object_type.to_string(),
            schema: database.to_string(),
            source: build_fallback_table_ddl(database, name, &columns),
            editable: true,
        })
    }

    pub async fn get_table_ddl(&self, database: &str, table: &str, token: &CancellationToken) -> Result<String> {
        let database = effective_database(database, &self.current_database)?;
        let columns = self.get_columns(database, table, token).await?;
        Ok(build_fallback_table_ddl(database, table, &columns))
    }

    pub async fn get_explain_info(&self, sql: &str, token: &CancellationToken, timeout_secs: u64) -> Result<String> {
        let result = self
            .require_client()?
            .execute_sql(&format!("EXPLAIN {sql}"), None, timeout_secs, token)
            .await?;
        Ok(result
            .rows
            .into_iter()
            .map(|row| {
                row.iter()
                    .map(|cell| match cell {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join("\t")
            })
            .collect::<Vec<_>>()
            .join("\n"))
    }

    pub async fn completion_assistant_search(
        &mut self,
        request: CompletionAssistantRequest,
        token: &CancellationToken,
    ) -> Result<CompletionAssistantResponse> {
        let allowed = request.object_kinds.iter().map(|kind| kind.to_ascii_lowercase()).collect::<HashSet<_>>();
        let include_databases = allowed.contains("database") || allowed.contains("schema");
        let include_tables = allowed.is_empty() || allowed.contains("table") || allowed.contains("view");
        let include_columns = allowed.contains("column");
        let max_results = if request.max_results == 0 { 100 } else { request.max_results.min(1000) };
        let mut candidates = Vec::new();
        let requested_database = if !request.parent_schema.trim().is_empty() {
            request.parent_schema.trim()
        } else if !request.schema.trim().is_empty() {
            request.schema.trim()
        } else {
            request.database.trim()
        };
        let databases = if request.global_search || (include_databases && requested_database.is_empty()) {
            self.list_databases(token).await?.into_iter().map(|database| database.name).collect()
        } else {
            vec![effective_database(requested_database, &self.current_database)?.to_string()]
        };

        if include_databases {
            for database in &databases {
                if completion_matches(database, &request) {
                    candidates.push(CompletionAssistantCandidate {
                        name: database.clone(),
                        kind: "schema".into(),
                        database: Some(database.clone()),
                        schema: Some(database.clone()),
                        parent_schema: None,
                        parent_name: None,
                        comment: None,
                        data_type: None,
                    });
                    if candidates.len() >= max_results {
                        return Ok(CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
                    }
                }
            }
        }

        for database in databases {
            if include_columns && !request.parent_name.trim().is_empty() {
                for column in self.get_columns(&database, request.parent_name.trim(), token).await? {
                    if completion_matches(&column.name, &request) {
                        candidates.push(CompletionAssistantCandidate {
                            name: column.name,
                            kind: "column".into(),
                            database: Some(database.clone()),
                            schema: Some(database.clone()),
                            parent_schema: Some(database.clone()),
                            parent_name: Some(request.parent_name.trim().to_string()),
                            comment: column.comment,
                            data_type: Some(column.data_type),
                        });
                    }
                    if candidates.len() >= max_results {
                        return Ok(CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
                    }
                }
                continue;
            }
            if include_tables {
                let tables = self
                    .list_tables(&database, MetadataListConstraints::default(), token)
                    .await?;
                for table in tables {
                    if completion_matches(&table.name, &request) {
                        candidates.push(CompletionAssistantCandidate {
                            name: table.name,
                            kind: "table".into(),
                            database: Some(database.clone()),
                            schema: Some(database.clone()),
                            parent_schema: None,
                            parent_name: table.parent_name,
                            comment: table.comment,
                            data_type: None,
                        });
                    }
                    if candidates.len() >= max_results {
                        return Ok(CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
                    }
                }
            }
        }
        Ok(CompletionAssistantResponse { candidates, incomplete: false, fallback_used: false })
    }

    pub async fn execute_query(&mut self, options: QueryOptions, token: &CancellationToken) -> Result<QueryResult> {
        let start = Instant::now();
        let database = self.prepare_database(&options)?;
        let max_rows = normalized_max_rows(options.max_rows);
        let mut result = self
            .require_client()?
            .execute_sql(&options.sql, Some(&database), options.timeout_secs, token)
            .await?;
        let truncated = result.rows.len() > max_rows;
        if truncated {
            result.rows.truncate(max_rows);
            result.truncated = true;
        }
        result.execution_time_ms = start.elapsed().as_millis() as i64;
        if looks_like_dml(&options.sql) {
            result.affected_rows = result.affected_rows.max(0);
        }
        ensure_insert_wrote_rows(&options.sql, &result)?;
        Ok(result)
    }

    pub async fn execute_query_page(
        &mut self,
        options: QueryOptions,
        token: &CancellationToken,
    ) -> Result<QueryPageResult> {
        let start = Instant::now();
        let database = self.prepare_database(&options)?;
        let max_rows = normalized_max_rows(options.max_rows);
        let page_size = normalized_page_size(options.page_size, options.fetch_size, max_rows);
        let result = self
            .require_client()?
            .execute_sql(&options.sql, Some(&database), options.timeout_secs, token)
            .await?;
        let mut cursor = QueryCursor {
            columns: result.columns,
            column_types: result.column_types,
            rows: result.rows,
            offset: 0,
            max_rows,
            affected_rows: result.affected_rows,
        };
        if cursor.rows.len() > max_rows {
            cursor.rows.truncate(max_rows);
        }
        let page = read_cursor_page(&mut cursor, page_size);
        let mut page = page;
        page.execution_time_ms = start.elapsed().as_millis() as i64;
        if page.has_more {
            let session_id = format!("cnosdb-{}", Uuid::new_v4());
            page.session_id = Some(session_id.clone());
            self.query_sessions.insert(session_id, cursor);
        }
        Ok(page)
    }

    pub async fn fetch_query_page(
        &mut self,
        session_id: &str,
        page_size: usize,
        _timeout_secs: u64,
        _token: &CancellationToken,
    ) -> Result<QueryPageResult> {
        let cursor = self
            .query_sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("query session not found: {session_id}"))?;
        let page_size = normalized_page_size(page_size, 0, cursor.max_rows);
        let mut page = read_cursor_page(cursor, page_size);
        if !page.has_more {
            self.query_sessions.remove(session_id);
            page.session_id = None;
        } else {
            page.session_id = Some(session_id.to_string());
        }
        Ok(page)
    }

    pub fn close_query_session(&mut self, session_id: &str) -> Result<()> {
        self.query_sessions.remove(session_id);
        Ok(())
    }

    pub async fn execute_statements(
        &mut self,
        statements: Vec<String>,
        database: &str,
        timeout_secs: u64,
        token: &CancellationToken,
    ) -> Result<QueryResult> {
        let start = Instant::now();
        let database = effective_database(database, &self.current_database)?.to_string();
        let mut last = QueryResult::default();
        for statement in statements {
            let sql = statement.trim();
            if sql.is_empty() {
                continue;
            }
            last = self
                .require_client()?
                .execute_sql(sql, Some(&database), timeout_secs, token)
                .await?;
            if looks_like_dml(sql) {
                last.affected_rows = last.affected_rows.max(0);
            }
            ensure_insert_wrote_rows(sql, &last)?;
            if let Some(created) = created_database_name(sql) {
                self.current_database = created.clone();
                self.require_client_mut()?.set_database(&created);
            }
        }
        last.execution_time_ms = start.elapsed().as_millis() as i64;
        Ok(last)
    }

    fn prepare_database(&mut self, options: &QueryOptions) -> Result<String> {
        // Prefer database over schema: CnosDB scopes SQL with ?db=, not schemas.
        let database = if !options.database.trim().is_empty() {
            options.database.trim()
        } else if !options.schema.trim().is_empty() {
            options.schema.trim()
        } else {
            self.current_database.as_str()
        };
        let database = effective_database(database, &self.current_database)?.to_string();
        self.current_database = database.clone();
        self.require_client_mut()?.set_database(&database);
        Ok(database)
    }

    fn require_client(&self) -> Result<&CnosHttpClient> {
        self.client.as_ref().ok_or_else(|| anyhow!("CnosDB session is not connected"))
    }

    fn require_client_mut(&mut self) -> Result<&mut CnosHttpClient> {
        self.client.as_mut().ok_or_else(|| anyhow!("CnosDB session is not connected"))
    }

}

fn read_cursor_page(cursor: &mut QueryCursor, page_size: usize) -> QueryPageResult {
    let end = (cursor.offset + page_size).min(cursor.rows.len());
    let rows = cursor.rows[cursor.offset..end].to_vec();
    cursor.offset = end;
    let has_more = cursor.offset < cursor.rows.len();
    QueryPageResult {
        columns: cursor.columns.clone(),
        column_types: cursor.column_types.clone(),
        rows,
        affected_rows: cursor.affected_rows,
        execution_time_ms: 0,
        truncated: cursor.rows.len() >= cursor.max_rows && !has_more,
        session_id: None,
        has_more,
    }
}

fn parse_describe_columns(result: QueryResult) -> Vec<ColumnInfo> {
    let lower_columns = result
        .columns
        .iter()
        .map(|column| column.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let name_idx = column_index(&lower_columns, &["column_name", "name", "field"]);
    let type_idx = column_index(&lower_columns, &["data_type", "type", "column_type"]);
    let kind_idx = column_index(&lower_columns, &["column_type", "field_type", "kind"]);
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = name_idx.and_then(|index| row.get(index)).and_then(json_cell_text)?;
            let data_type = type_idx
                .and_then(|index| row.get(index))
                .and_then(json_cell_text)
                .unwrap_or_else(|| "STRING".to_string());
            let kind = kind_idx
                .and_then(|index| row.get(index))
                .and_then(json_cell_text)
                .unwrap_or_default()
                .to_ascii_uppercase();
            let is_identity = kind == "TIME" || kind == "TAG" || data_type.eq_ignore_ascii_case("TIMESTAMP");
            Some(ColumnInfo {
                name,
                data_type,
                is_nullable: kind != "TIME" && kind != "TAG",
                column_default: None,
                is_primary_key: is_identity,
                extra: if kind.is_empty() { None } else { Some(kind) },
                comment: None,
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
            })
        })
        .collect()
}

fn column_index(columns: &[String], candidates: &[&str]) -> Option<usize> {
    preferred_column_index(columns, candidates)
}

fn preferred_column_index(columns: &[String], candidates: &[&str]) -> Option<usize> {
    candidates.iter().find_map(|candidate| {
        columns
            .iter()
            .position(|column| column.eq_ignore_ascii_case(candidate))
    })
}

fn build_fallback_table_ddl(database: &str, table: &str, columns: &[ColumnInfo]) -> String {
    let mut fields = Vec::new();
    let mut tags = Vec::new();
    for column in columns {
        let kind = column.extra.as_deref().unwrap_or("");
        if kind.eq_ignore_ascii_case("TIME") {
            continue;
        }
        if kind.eq_ignore_ascii_case("TAG") {
            tags.push(quote_ident(&column.name));
            continue;
        }
        fields.push(format!("{} {}", quote_ident(&column.name), column.data_type));
    }
    let mut ddl = format!("CREATE TABLE {}.{} (\n  {}", quote_ident(database), quote_ident(table), fields.join(",\n  "));
    if !tags.is_empty() {
        if !fields.is_empty() {
            ddl.push(',');
        }
        ddl.push_str(&format!("\n  TAGS({})", tags.join(", ")));
    }
    ddl.push_str("\n);");
    ddl
}

fn filter_tables(tables: &[TableInfo], constraints: &MetadataListConstraints) -> Vec<TableInfo> {
    let filter = constraints.filter.trim().to_ascii_lowercase();
    let mut filtered = tables
        .iter()
        .filter(|table| filter.is_empty() || table.name.to_ascii_lowercase().contains(&filter))
        .cloned()
        .collect::<Vec<_>>();
    let offset = constraints.offset.min(filtered.len());
    filtered = filtered.split_off(offset);
    if constraints.limit > 0 && filtered.len() > constraints.limit {
        filtered.truncate(constraints.limit);
    }
    filtered
}

fn table_type_allowed(object_types: &[String], table_type: &str) -> bool {
    object_types.is_empty()
        || object_types.iter().any(|value| value.eq_ignore_ascii_case(table_type) || value.eq_ignore_ascii_case("all"))
}

fn completion_matches(name: &str, request: &CompletionAssistantRequest) -> bool {
    let mask = request.mask.trim();
    if mask.is_empty() {
        return true;
    }
    if request.case_sensitive {
        completion_match_mode(name, mask, &request.match_mode)
    } else {
        completion_match_mode(
            &name.to_ascii_lowercase(),
            &mask.to_ascii_lowercase(),
            &request.match_mode,
        )
    }
}

fn completion_match_mode(candidate: &str, mask: &str, mode: &str) -> bool {
    match mode.trim().to_ascii_lowercase().as_str() {
        "prefix" => candidate.starts_with(mask),
        "exact" => candidate == mask,
        "subsequence" | "fuzzy" => fuzzy_subsequence_matches(candidate, mask),
        _ => candidate.contains(mask) || fuzzy_subsequence_matches(candidate, mask),
    }
}

fn fuzzy_subsequence_matches(candidate: &str, expected: &str) -> bool {
    let mut candidate = candidate.chars();
    expected
        .chars()
        .all(|expected| candidate.by_ref().any(|value| value == expected))
}

fn effective_database<'a>(database: &'a str, fallback: &'a str) -> Result<&'a str> {
    let database = database.trim();
    if !database.is_empty() {
        return Ok(database);
    }
    let fallback = fallback.trim();
    if fallback.is_empty() {
        bail!("database is required");
    }
    Ok(fallback)
}

fn quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn json_cell_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn is_system_database(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "cluster_schema" | "usage_schema" | "information_schema")
}

fn normalized_max_rows(max_rows: usize) -> usize {
    if max_rows == 0 {
        DEFAULT_MAX_ROWS
    } else {
        max_rows
    }
}

fn normalized_page_size(page_size: usize, fetch_size: usize, max_rows: usize) -> usize {
    let size = if page_size > 0 {
        page_size
    } else if fetch_size > 0 {
        fetch_size
    } else {
        100
    };
    size.min(max_rows).max(1)
}

fn looks_like_dml(sql: &str) -> bool {
    let trimmed = sql.trim_start();
    ["insert", "update", "delete", "create", "drop", "alter", "grant", "revoke"]
        .iter()
        .any(|prefix| trimmed.len() >= prefix.len() && trimmed[..prefix.len()].eq_ignore_ascii_case(prefix))
}

fn looks_like_insert(sql: &str) -> bool {
    let trimmed = sql.trim_start();
    trimmed.len() >= 6 && trimmed[..6].eq_ignore_ascii_case("insert")
}

/// Data-tools UI counts planned rows whenever the statement has no `execution_error`.
/// CnosDB can still answer HTTP 200 with an empty body or `[{"rows":0}]` for a no-op
/// INSERT, so refuse that here instead of changing shared insert accounting.
fn ensure_insert_wrote_rows(sql: &str, result: &QueryResult) -> Result<()> {
    if looks_like_insert(sql) && result.affected_rows <= 0 {
        bail!("CnosDB INSERT affected 0 rows");
    }
    Ok(())
}

fn created_database_name(sql: &str) -> Option<String> {
    let trimmed = sql.trim().trim_end_matches(';');
    let lower = trimmed.to_ascii_lowercase();
    let rest = lower.strip_prefix("create database")?;
    let rest = rest.trim_start();
    let rest = rest.strip_prefix("if not exists").unwrap_or(rest).trim_start();
    let original = &trimmed[trimmed.len() - rest.len()..];
    let name = original.split_whitespace().next()?.trim_matches('"');
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::parse_sql_response;
    use serde_json::json;

    #[test]
    fn describe_marks_time_and_tag_as_identity() {
        let result = QueryResult {
            columns: vec!["column_name".into(), "data_type".into(), "column_type".into()],
            column_types: vec!["STRING".into(), "STRING".into(), "STRING".into()],
            rows: vec![
                vec![json!("time"), json!("TIMESTAMP"), json!("TIME")],
                vec![json!("station"), json!("STRING"), json!("TAG")],
                vec![json!("temperature"), json!("DOUBLE"), json!("FIELD")],
            ],
            ..Default::default()
        };
        let columns = parse_describe_columns(result);
        assert!(columns[0].is_primary_key);
        assert!(columns[1].is_primary_key);
        assert!(!columns[2].is_primary_key);
        assert_eq!(columns[1].extra.as_deref(), Some("TAG"));
    }

    #[test]
    fn parses_object_rows_via_http_helper() {
        let result = parse_sql_response(r#"[{"name":"air"}]"#).unwrap();
        assert_eq!(result.rows[0][0], json!("air"));
    }

    #[test]
    fn rejects_insert_with_zero_affected_rows() {
        let empty = parse_sql_response("").unwrap();
        assert!(ensure_insert_wrote_rows("INSERT INTO t (a) VALUES (1);", &empty).is_err());

        let zero = parse_sql_response(r#"[{"rows":0}]"#).unwrap();
        assert!(ensure_insert_wrote_rows("insert into t (a) values (1);", &zero).is_err());

        let wrote = parse_sql_response(r#"[{"rows":2}]"#).unwrap();
        assert!(ensure_insert_wrote_rows("INSERT INTO t (a) VALUES (1), (2);", &wrote).is_ok());
        assert!(ensure_insert_wrote_rows("CREATE TABLE t (a STRING);", &empty).is_ok());
    }
}
