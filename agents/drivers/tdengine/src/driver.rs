use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use chrono_tz::Tz;
use futures::future::poll_fn;
use serde_json::Value;
use taos::{AsyncFetchable, AsyncQueryable, AsyncTBuilder, RawBlock, ResultSet, Taos, TaosBuilder};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::config::build_dsn;
use crate::model::{
    AgentConnectionInfo, ColumnInfo, CompletionAssistantCandidate, CompletionAssistantRequest,
    CompletionAssistantResponse, ConnectParams, DatabaseConnectionInfo, DatabaseInfo, MetadataListConstraints,
    ObjectInfo, ObjectSource, QueryOptions, QueryPageResult, QueryResult, TableInfo, DEFAULT_MAX_ROWS,
    TDENGINE_DATA_TYPES,
};
use crate::value::borrowed_value_to_json;

const TABLE_CACHE_TTL: Duration = Duration::from_secs(10);
const QUERY_SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

pub struct TdengineDriver {
    connection: Option<Taos>,
    params: ConnectParams,
    server_version: Option<String>,
    current_database: String,
    query_sessions: HashMap<String, QueryCursor>,
    table_cache: Option<TableCache>,
}

struct TableCache {
    database: String,
    loaded_at: Instant,
    tables: Vec<TableInfo>,
}

struct QueryCursor {
    result_set: ResultSet,
    timezone: Option<Tz>,
    columns: Vec<String>,
    column_types: Vec<String>,
    affected_rows: i64,
    max_rows: usize,
    rows_read: usize,
    pending_block: Option<RawBlock>,
    pending_row_index: usize,
    pending_row: Option<Vec<Value>>,
    last_accessed_at: Instant,
}

impl TdengineDriver {
    pub fn new() -> Self {
        Self {
            connection: None,
            params: ConnectParams::default(),
            server_version: None,
            current_database: String::new(),
            query_sessions: HashMap::new(),
            table_cache: None,
        }
    }

    pub async fn connect(&mut self, params: ConnectParams) -> Result<()> {
        self.disconnect().await;
        let dsn = build_dsn(&params)?;
        let builder =
            TaosBuilder::from_dsn(&dsn.value).with_context(|| "failed to configure TDengine WebSocket connector")?;
        let connect_timeout = connect_timeout(&params);
        let connection = timeout(connect_timeout, builder.build())
            .await
            .map_err(|_| anyhow!("TDengine connection timed out after {} seconds", connect_timeout.as_secs()))??;
        let token = CancellationToken::new();
        let server_version = query_scalar_string(&connection, "SELECT server_version()", &token, 5).await.ok();
        self.current_database = dsn.database;
        self.server_version = server_version;
        self.params = params;
        self.connection = Some(connection);
        Ok(())
    }

    pub async fn test_connection(params: ConnectParams) -> Result<DatabaseConnectionInfo> {
        let mut driver = Self::new();
        driver.connect(params).await?;
        let token = CancellationToken::new();
        driver.validate_connection(&token).await?;
        driver.connection_info()?.database_info.ok_or_else(|| anyhow!("TDengine connection metadata is unavailable"))
    }

    pub async fn disconnect(&mut self) {
        self.query_sessions.clear();
        self.table_cache = None;
        self.server_version = None;
        self.current_database.clear();
        self.connection = None;
    }

    pub async fn validate_connection(&self, token: &CancellationToken) -> Result<()> {
        query_scalar_string(self.require_connection()?, "SELECT server_version()", token, 3).await?;
        Ok(())
    }

    pub fn connection_info(&self) -> Result<AgentConnectionInfo> {
        self.require_connection()?;
        Ok(AgentConnectionInfo {
            identifier_quote: "`".into(),
            compatibility_mode: None,
            database_info: Some(DatabaseConnectionInfo {
                product_name: Some("TDengine".into()),
                product_version: self.server_version.clone(),
                current_database: non_empty(&self.current_database),
                driver_name: Some("taos-connector-rust".into()),
                driver_version: Some("0.12.4-git-f49c3718".into()),
                unquoted_identifier_case: Some("lower"),
                quoted_identifier_case: Some("lower"),
            }),
        })
    }

    pub async fn list_databases(&self, token: &CancellationToken) -> Result<Vec<DatabaseInfo>> {
        let rows = self.query_rows("SHOW DATABASES", token, 0).await?;
        Ok(rows
            .into_iter()
            .filter_map(|row| row.first().and_then(json_text).map(str::to_string))
            .filter(|name| !is_system_database(name))
            .map(|name| DatabaseInfo { name })
            .collect())
    }

    pub fn list_schemas(&self) -> Vec<String> {
        Vec::new()
    }

    pub fn list_data_types(&self) -> Vec<String> {
        TDENGINE_DATA_TYPES.iter().map(|value| (*value).to_string()).collect()
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
        if constraints.limit > 0 && constraints.filter.trim().is_empty() {
            return self.list_tables_page(&database, constraints.offset, constraints.limit, token).await;
        }
        let tables = self.all_tables(&database, token).await?;
        Ok(filter_tables(tables, &constraints))
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
        let rows = self.query_rows(&format!("DESCRIBE {}", qualified_name(database, table)), token, 0).await?;
        Ok(parse_describe_columns(rows))
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
        let mut source = self.get_create_sql(database, name, object_type, token).await?;
        if source.is_empty() {
            let columns = self.get_columns(database, name, token).await?;
            source = build_fallback_table_ddl(database, name, &columns);
        }
        Ok(ObjectSource {
            name: name.to_string(),
            object_type: object_type.to_string(),
            schema: database.to_string(),
            source,
            editable: true,
        })
    }

    pub async fn get_table_ddl(&self, database: &str, table: &str, token: &CancellationToken) -> Result<String> {
        let stable = self.get_create_sql(database, table, "STABLE", token).await?;
        if !stable.is_empty() {
            return Ok(stable);
        }
        let table_source = self.get_create_sql(database, table, "TABLE", token).await?;
        if !table_source.is_empty() {
            return Ok(table_source);
        }
        let columns = self.get_columns(database, table, token).await?;
        Ok(build_fallback_table_ddl(database, table, &columns))
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
                for table in self.all_tables(&database, token).await? {
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
        self.prepare_database(&options, token).await?;
        let max_rows = normalized_max_rows(options.max_rows);
        let mut cursor = self.start_cursor(&options.sql, max_rows, token, options.timeout_secs).await?;
        let mut page = read_cursor_page(&mut cursor, max_rows, token, options.timeout_secs).await?;
        let (_, truncated) = cursor.prepare_next_page(token, options.timeout_secs).await?;
        page.truncated = truncated;
        if may_change_metadata(&options.sql) {
            self.table_cache = None;
        }
        Ok(QueryResult {
            columns: page.columns,
            column_types: page.column_types,
            rows: page.rows,
            affected_rows: page.affected_rows,
            execution_time_ms: start.elapsed().as_millis() as i64,
            truncated: page.truncated,
        })
    }

    pub async fn execute_query_page(
        &mut self,
        options: QueryOptions,
        token: &CancellationToken,
    ) -> Result<QueryPageResult> {
        let start = Instant::now();
        self.expire_query_sessions();
        self.prepare_database(&options, token).await?;
        let max_rows = normalized_max_rows(options.max_rows);
        let page_size = normalized_page_size(options.page_size, options.fetch_size, max_rows);
        let mut cursor = self.start_cursor(&options.sql, max_rows, token, options.timeout_secs).await?;
        let mut page = read_cursor_page(&mut cursor, page_size, token, options.timeout_secs).await?;
        let (has_more, truncated) = cursor.prepare_next_page(token, options.timeout_secs).await?;
        page.truncated = truncated;
        if has_more {
            let session_id = format!("tdengine-{}", Uuid::new_v4());
            page.session_id = Some(session_id.clone());
            page.has_more = true;
            self.query_sessions.insert(session_id, cursor);
        }
        page.execution_time_ms = start.elapsed().as_millis() as i64;
        if may_change_metadata(&options.sql) {
            self.table_cache = None;
        }
        Ok(page)
    }

    pub async fn fetch_query_page(
        &mut self,
        session_id: &str,
        page_size: usize,
        timeout_secs: u64,
        token: &CancellationToken,
    ) -> Result<QueryPageResult> {
        self.expire_query_sessions();
        let Some(mut cursor) = self.query_sessions.remove(session_id) else {
            bail!("TDengine query session not found: {session_id}");
        };
        cursor.last_accessed_at = Instant::now();
        let page_size = normalized_page_size(page_size, 0, cursor.remaining_limit().max(1));
        let mut page = read_cursor_page(&mut cursor, page_size, token, timeout_secs).await?;
        let (has_more, truncated) = cursor.prepare_next_page(token, timeout_secs).await?;
        page.truncated = truncated;
        if has_more {
            page.session_id = Some(session_id.to_string());
            page.has_more = true;
            self.query_sessions.insert(session_id.to_string(), cursor);
        }
        Ok(page)
    }

    pub fn close_query_session(&mut self, session_id: &str) -> bool {
        self.query_sessions.remove(session_id).is_some()
    }

    fn expire_query_sessions(&mut self) {
        self.query_sessions.retain(|_, cursor| cursor.last_accessed_at.elapsed() <= QUERY_SESSION_IDLE_TIMEOUT);
    }

    pub async fn execute_statements(
        &mut self,
        statements: Vec<String>,
        database: &str,
        timeout_secs: u64,
        token: &CancellationToken,
    ) -> Result<QueryResult> {
        let start = Instant::now();
        if !database.trim().is_empty() {
            self.use_database(database, token, timeout_secs).await?;
        }
        let mut affected_rows = 0i64;
        for statement in &statements {
            let sql = trim_sql(statement);
            if sql.is_empty() {
                continue;
            }
            let result_set = cancellable(token, timeout_secs, self.require_connection()?.query(sql)).await?;
            affected_rows += i64::from(result_set.affected_rows());
        }
        if statements.iter().any(|statement| may_change_metadata(statement)) {
            self.table_cache = None;
        }
        Ok(QueryResult {
            columns: Vec::new(),
            column_types: Vec::new(),
            rows: Vec::new(),
            affected_rows,
            execution_time_ms: start.elapsed().as_millis() as i64,
            truncated: false,
        })
    }

    pub async fn get_explain_info(&self, sql: &str, token: &CancellationToken, timeout_secs: u64) -> Result<String> {
        let sql = trim_sql(sql);
        if sql.is_empty() {
            bail!("SQL is required");
        }
        let rows = self.query_rows(&format!("EXPLAIN {sql}"), token, timeout_secs).await?;
        Ok(rows
            .into_iter()
            .map(|row| row.iter().map(display_json_value).collect::<Vec<_>>().join("\t"))
            .collect::<Vec<_>>()
            .join("\n"))
    }

    async fn prepare_database(&mut self, options: &QueryOptions, token: &CancellationToken) -> Result<()> {
        let database = if options.schema.trim().is_empty() { options.database.trim() } else { options.schema.trim() };
        if database.is_empty() || database == self.current_database {
            return Ok(());
        }
        self.use_database(database, token, options.timeout_secs).await
    }

    async fn use_database(&mut self, database: &str, token: &CancellationToken, timeout_secs: u64) -> Result<()> {
        let database = validate_database_name(database)?;
        let sql = format!("USE {database}");
        cancellable(token, timeout_secs, self.require_connection()?.exec(sql)).await?;
        self.current_database = database.to_string();
        Ok(())
    }

    async fn start_cursor(
        &self,
        sql: &str,
        max_rows: usize,
        token: &CancellationToken,
        timeout_secs: u64,
    ) -> Result<QueryCursor> {
        let sql = trim_sql(sql);
        if sql.is_empty() {
            bail!("SQL is required");
        }
        let result_set = cancellable(token, timeout_secs, self.require_connection()?.query(sql)).await?;
        let timezone = result_set.timezone();
        let columns = result_set.fields().iter().map(|field| field.name().to_string()).collect();
        let column_types = result_set.fields().iter().map(|field| field.ty().name().to_string()).collect();
        let affected_rows = i64::from(result_set.affected_rows());
        Ok(QueryCursor {
            result_set,
            timezone,
            columns,
            column_types,
            affected_rows,
            max_rows,
            rows_read: 0,
            pending_block: None,
            pending_row_index: 0,
            pending_row: None,
            last_accessed_at: Instant::now(),
        })
    }

    async fn query_rows(&self, sql: &str, token: &CancellationToken, timeout_secs: u64) -> Result<Vec<Vec<Value>>> {
        let mut cursor = self.start_cursor(sql, usize::MAX, token, timeout_secs).await?;
        let mut rows = Vec::new();
        while let Some(row) = cursor.next_row(token, timeout_secs).await? {
            rows.push(row);
        }
        Ok(rows)
    }

    async fn all_tables(&mut self, database: &str, token: &CancellationToken) -> Result<Vec<TableInfo>> {
        if let Some(cache) = &self.table_cache {
            if cache.database == database && cache.loaded_at.elapsed() <= TABLE_CACHE_TTL {
                return Ok(cache.tables.clone());
            }
        }
        let mut tables = self
            .query_tables(&format!("SHOW {}STABLES", quote_qualified_prefix(database)), "STABLE", false, token)
            .await?;
        tables.extend(
            self.query_tables(&format!("SHOW {}TABLES", quote_qualified_prefix(database)), "TABLE", true, token)
                .await?,
        );
        self.enrich_table_parents(database, &mut tables, token).await?;
        let mut seen = HashSet::new();
        tables.retain(|table| seen.insert(format!("{}:{}", table.table_type, table.name)));
        sort_tables_for_hierarchy(&mut tables);
        self.table_cache =
            Some(TableCache { database: database.to_string(), loaded_at: Instant::now(), tables: tables.clone() });
        Ok(tables)
    }

    async fn list_tables_page(
        &self,
        database: &str,
        offset: usize,
        limit: usize,
        token: &CancellationToken,
    ) -> Result<Vec<TableInfo>> {
        let (mut stables, scanned) = self
            .query_tables_page(
                &format!("SHOW {}STABLES", quote_qualified_prefix(database)),
                "STABLE",
                false,
                offset,
                limit,
                token,
            )
            .await?;
        if stables.len() >= limit {
            return Ok(stables);
        }
        let table_offset = offset.saturating_sub(scanned);
        let (tables, _) = self
            .query_tables_page(
                &format!("SHOW {}TABLES", quote_qualified_prefix(database)),
                "TABLE",
                true,
                table_offset,
                limit - stables.len(),
                token,
            )
            .await?;
        stables.extend(tables);
        self.enrich_table_parents(database, &mut stables, token).await?;
        Ok(stables)
    }

    async fn enrich_table_parents(
        &self,
        database: &str,
        tables: &mut [TableInfo],
        token: &CancellationToken,
    ) -> Result<()> {
        if !tables.iter().any(|table| table.table_type == "TABLE" && table.parent_name.is_none()) {
            return Ok(());
        }
        let sql = format!(
            "SELECT table_name, stable_name FROM information_schema.ins_tables WHERE db_name = {}",
            quote_literal(database)
        );
        let rows = match self.query_rows(&sql, token, 0).await {
            Ok(rows) => rows,
            Err(error) if token.is_cancelled() => return Err(error),
            Err(_) => return Ok(()),
        };
        let parents = rows
            .into_iter()
            .filter_map(|row| {
                let table = row.first().and_then(json_text)?.to_ascii_lowercase();
                let parent = row.get(1).and_then(json_text)?.trim();
                (!parent.is_empty()).then(|| (table, parent.to_string()))
            })
            .collect::<HashMap<_, _>>();
        for table in tables {
            if table.table_type == "TABLE" && table.parent_name.is_none() {
                table.parent_name = parents.get(&table.name.to_ascii_lowercase()).cloned();
            }
        }
        Ok(())
    }

    async fn query_tables(
        &self,
        sql: &str,
        table_type: &str,
        includes_stable_name: bool,
        token: &CancellationToken,
    ) -> Result<Vec<TableInfo>> {
        let rows = self.query_rows(sql, token, 0).await?;
        Ok(rows.into_iter().filter_map(|row| table_from_show_row(row, table_type, includes_stable_name)).collect())
    }

    async fn query_tables_page(
        &self,
        sql: &str,
        table_type: &str,
        includes_stable_name: bool,
        offset: usize,
        limit: usize,
        token: &CancellationToken,
    ) -> Result<(Vec<TableInfo>, usize)> {
        let mut cursor = self.start_cursor(sql, offset.saturating_add(limit), token, 0).await?;
        let mut scanned = 0usize;
        let mut result = Vec::with_capacity(limit);
        while result.len() < limit {
            let Some(row) = cursor.next_row(token, 0).await? else {
                break;
            };
            scanned += 1;
            if scanned <= offset {
                continue;
            }
            if let Some(table) = table_from_show_row(row, table_type, includes_stable_name) {
                result.push(table);
            }
        }
        Ok((result, scanned))
    }

    async fn get_create_sql(
        &self,
        database: &str,
        name: &str,
        object_type: &str,
        token: &CancellationToken,
    ) -> Result<String> {
        let show_type = match object_type.trim().to_ascii_uppercase().as_str() {
            "STABLE" | "SUPER TABLE" | "SUPERTABLE" => "STABLE",
            "TABLE" | "BASE TABLE" | "CHILD TABLE" => "TABLE",
            _ => return Ok(String::new()),
        };
        let database = effective_database(database, &self.current_database)?;
        let rows = match self
            .query_rows(&format!("SHOW CREATE {show_type} {}", qualified_name(database, name)), token, 0)
            .await
        {
            Ok(rows) => rows,
            Err(error) if token.is_cancelled() => return Err(error),
            Err(_) => return Ok(String::new()),
        };
        let Some(row) = rows.first() else {
            return Ok(String::new());
        };
        for value in row.iter().skip(1) {
            if let Some(value) = json_text(value) {
                if value.to_ascii_uppercase().contains("CREATE") {
                    return Ok(value.to_string());
                }
            }
        }
        Ok(row.last().and_then(json_text).unwrap_or_default().to_string())
    }

    fn require_connection(&self) -> Result<&Taos> {
        self.connection.as_ref().ok_or_else(|| anyhow!("not connected"))
    }
}

impl QueryCursor {
    async fn next_row(&mut self, token: &CancellationToken, timeout_secs: u64) -> Result<Option<Vec<Value>>> {
        if self.rows_read >= self.max_rows {
            return Ok(None);
        }
        if let Some(row) = self.pending_row.take() {
            self.rows_read += 1;
            return Ok(Some(row));
        }
        let row = self.next_raw_row(token, timeout_secs).await?;
        if row.is_some() {
            self.rows_read += 1;
        }
        Ok(row)
    }

    async fn prepare_next_page(&mut self, token: &CancellationToken, timeout_secs: u64) -> Result<(bool, bool)> {
        if self.rows_read >= self.max_rows {
            return Ok((false, self.next_raw_row(token, timeout_secs).await?.is_some()));
        }
        if self.pending_row.is_some() {
            return Ok((true, false));
        }
        self.pending_row = self.next_raw_row(token, timeout_secs).await?;
        Ok((self.pending_row.is_some(), false))
    }

    fn remaining_limit(&self) -> usize {
        self.max_rows.saturating_sub(self.rows_read)
    }

    async fn next_raw_row(&mut self, token: &CancellationToken, timeout_secs: u64) -> Result<Option<Vec<Value>>> {
        loop {
            if let Some(block) = &self.pending_block {
                if self.pending_row_index < block.nrows() {
                    let timezone = preferred_timezone(self.timezone, block.timezone());
                    let row_index = self.pending_row_index;
                    self.pending_row_index += 1;
                    let row = (0..block.ncols())
                        .map(|column| {
                            block
                                .get_ref(row_index, column)
                                .map(|value| borrowed_value_to_json(value, timezone))
                                .unwrap_or(Value::Null)
                        })
                        .collect();
                    return Ok(Some(row));
                }
            }
            self.pending_block = None;
            self.pending_row_index = 0;
            let block =
                cancellable(token, timeout_secs, poll_fn(|context| self.result_set.fetch_raw_block(context))).await?;
            match block {
                Some(block) if block.nrows() > 0 => self.pending_block = Some(block),
                Some(_) => continue,
                None => return Ok(None),
            }
        }
    }
}

async fn read_cursor_page(
    cursor: &mut QueryCursor,
    page_size: usize,
    token: &CancellationToken,
    timeout_secs: u64,
) -> Result<QueryPageResult> {
    let mut rows = Vec::with_capacity(page_size);
    while rows.len() < page_size {
        let Some(row) = cursor.next_row(token, timeout_secs).await? else {
            break;
        };
        rows.push(row);
    }
    Ok(QueryPageResult {
        columns: cursor.columns.clone(),
        column_types: cursor.column_types.clone(),
        rows,
        affected_rows: cursor.affected_rows,
        execution_time_ms: 0,
        truncated: false,
        session_id: None,
        has_more: false,
    })
}

async fn query_scalar_string(
    connection: &Taos,
    sql: &str,
    token: &CancellationToken,
    timeout_secs: u64,
) -> Result<String> {
    let mut result = cancellable(token, timeout_secs, connection.query(sql)).await?;
    let timezone = result.timezone();
    loop {
        let block = cancellable(token, timeout_secs, poll_fn(|context| result.fetch_raw_block(context))).await?;
        let Some(block) = block else {
            bail!("TDengine query returned no rows");
        };
        if block.nrows() == 0 || block.ncols() == 0 {
            continue;
        }
        let value = block.get_ref(0, 0).ok_or_else(|| anyhow!("TDengine query returned an empty value"))?;
        return match borrowed_value_to_json(value, preferred_timezone(timezone, block.timezone())) {
            Value::String(value) => Ok(value),
            value => Ok(value.to_string()),
        };
    }
}

fn preferred_timezone(query_timezone: Option<Tz>, block_timezone: Option<Tz>) -> Option<Tz> {
    query_timezone.or(block_timezone)
}

async fn cancellable<T, F>(token: &CancellationToken, timeout_secs: u64, future: F) -> Result<T>
where
    F: Future<Output = taos::RawResult<T>>,
{
    tokio::pin!(future);
    let operation = async {
        if timeout_secs == 0 {
            future.await.map_err(anyhow::Error::from)
        } else {
            timeout(Duration::from_secs(timeout_secs), future)
                .await
                .map_err(|_| anyhow!("TDengine operation timed out after {timeout_secs} seconds"))?
                .map_err(anyhow::Error::from)
        }
    };
    tokio::select! {
        _ = token.cancelled() => bail!("TDengine operation was cancelled"),
        result = operation => result,
    }
}

fn effective_database<'a>(requested: &'a str, current: &'a str) -> Result<&'a str> {
    let requested = requested.trim();
    if !requested.is_empty() {
        return validate_database_name(requested);
    }
    let current = current.trim();
    if current.is_empty() {
        bail!("TDengine database is required");
    }
    validate_database_name(current)
}

fn validate_database_name(value: &str) -> Result<&str> {
    let value = value.trim();
    let mut chars = value.chars();
    let valid_start = chars.next().is_some_and(|char| char == '_' || char.is_ascii_alphabetic());
    if !valid_start || !chars.all(|char| char == '_' || char.is_ascii_alphanumeric()) {
        bail!("invalid TDengine database name: {value}");
    }
    Ok(value)
}

fn table_from_show_row(row: Vec<Value>, table_type: &str, includes_stable_name: bool) -> Option<TableInfo> {
    let name = row.first().and_then(json_text)?.to_string();
    let parent_name = includes_stable_name
        .then(|| row.get(3).and_then(json_text).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string))
        .flatten();
    Some(TableInfo { name, table_type: table_type.to_string(), comment: None, parent_schema: None, parent_name })
}

fn parse_describe_columns(rows: Vec<Vec<Value>>) -> Vec<ColumnInfo> {
    rows.into_iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let name = row.first().and_then(json_text)?.to_string();
            let data_type = row.get(1).and_then(json_text).unwrap_or_default().to_string();
            let note = row.get(3).and_then(json_text).map(str::to_string);
            let is_tag = note.as_deref().is_some_and(|note| note.to_ascii_uppercase().contains("TAG"));
            let is_primary_key = !is_tag
                && (index == 0
                    || note.as_deref().is_some_and(|note| note.to_ascii_uppercase().contains("COMPOSITE KEY")));
            Some(ColumnInfo {
                name,
                data_type: data_type.clone(),
                is_nullable: !is_primary_key,
                column_default: None,
                is_primary_key,
                extra: note,
                comment: is_tag.then(|| "TAG".to_string()),
                numeric_precision: type_numbers(&data_type, "decimal").map(|(precision, _)| precision),
                numeric_scale: type_numbers(&data_type, "decimal").and_then(|(_, scale)| scale),
                character_maximum_length: character_length(&data_type),
            })
        })
        .collect()
}

fn type_numbers(data_type: &str, expected: &str) -> Option<(u32, Option<u32>)> {
    let lower = data_type.trim().to_ascii_lowercase();
    if !(lower.starts_with(expected) || (expected == "decimal" && lower.starts_with("numeric"))) {
        return None;
    }
    let values = lower.strip_prefix(expected).or_else(|| lower.strip_prefix("numeric"))?.trim();
    let inner = values.strip_prefix('(')?.strip_suffix(')')?;
    let mut values = inner.split(',').map(str::trim);
    let precision = values.next()?.parse().ok()?;
    let scale = values.next().and_then(|value| value.parse().ok());
    Some((precision, scale))
}

fn character_length(data_type: &str) -> Option<u32> {
    let lower = data_type.trim().to_ascii_lowercase();
    ["binary", "nchar", "varchar", "varbinary", "geometry", "blob", "mediumblob"]
        .iter()
        .find_map(|prefix| type_numbers(&lower, prefix).map(|(length, _)| length))
}

fn filter_tables(tables: Vec<TableInfo>, constraints: &MetadataListConstraints) -> Vec<TableInfo> {
    let filter = constraints.filter.trim().to_ascii_lowercase();
    let mut skipped = 0usize;
    let limit = if constraints.limit == 0 { usize::MAX } else { constraints.limit };
    tables
        .into_iter()
        .filter(|table| table_type_allowed(&constraints.object_types, &table.table_type))
        .filter(|table| {
            text_matches(&table.name, &filter)
                || table.comment.as_deref().is_some_and(|comment| text_matches(comment, &filter))
        })
        .filter(|_| {
            let include = skipped >= constraints.offset;
            skipped += 1;
            include
        })
        .take(limit)
        .collect()
}

fn table_type_allowed(object_types: &[String], table_type: &str) -> bool {
    object_types.is_empty()
        || object_types
            .iter()
            .map(|value| normalize_object_type(value))
            .any(|value| value == normalize_object_type(table_type))
}

fn normalize_object_type(value: &str) -> String {
    let upper = value.trim().to_ascii_uppercase().replace(' ', "_");
    if upper == "STABLE" || upper == "BASE_TABLE" || upper.contains("TABLE") {
        "TABLE".into()
    } else if upper.contains("VIEW") {
        "VIEW".into()
    } else {
        upper
    }
}

fn text_matches(candidate: &str, filter: &str) -> bool {
    if filter.is_empty() {
        return true;
    }
    let candidate = candidate.to_ascii_lowercase();
    candidate.contains(filter) || (filter.chars().count() >= 2 && fuzzy_subsequence_matches(&candidate, filter))
}

fn fuzzy_subsequence_matches(candidate: &str, expected: &str) -> bool {
    let mut candidate = candidate.chars();
    expected.chars().all(|expected| candidate.by_ref().any(|value| value == expected))
}

fn completion_matches(candidate: &str, request: &CompletionAssistantRequest) -> bool {
    let mask = request.mask.trim();
    if mask.is_empty() {
        return true;
    }
    if request.case_sensitive {
        completion_match_mode(candidate, mask, &request.match_mode)
    } else {
        completion_match_mode(&candidate.to_ascii_lowercase(), &mask.to_ascii_lowercase(), &request.match_mode)
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

fn sort_tables_for_hierarchy(tables: &mut [TableInfo]) {
    tables.sort_by(|left, right| {
        let left_group = left.parent_name.as_deref().unwrap_or(&left.name).to_ascii_lowercase();
        let right_group = right.parent_name.as_deref().unwrap_or(&right.name).to_ascii_lowercase();
        left_group
            .cmp(&right_group)
            .then_with(|| left.parent_name.is_some().cmp(&right.parent_name.is_some()))
            .then_with(|| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()))
    });
}

fn build_fallback_table_ddl(database: &str, table: &str, columns: &[ColumnInfo]) -> String {
    let definitions = columns
        .iter()
        .filter(|column| column.comment.as_deref() != Some("TAG"))
        .map(|column| format!("  {} {}", quote_identifier(&column.name), column.data_type))
        .collect::<Vec<_>>()
        .join(",\n");
    format!("CREATE TABLE {} (\n{}\n);", qualified_name(database, table), definitions)
}

fn quote_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn quote_qualified_prefix(database: &str) -> String {
    if database.trim().is_empty() {
        String::new()
    } else {
        format!("{}.", database.trim())
    }
}

fn qualified_name(database: &str, name: &str) -> String {
    if database.trim().is_empty() {
        quote_identifier(name)
    } else {
        format!("{}.{}", database.trim(), quote_identifier(name))
    }
}

fn json_text(value: &Value) -> Option<&str> {
    match value {
        Value::String(value) => Some(value),
        _ => None,
    }
}

fn display_json_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        value => value.to_string(),
    }
}

fn non_empty(value: &str) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.trim().to_string())
}

fn is_system_database(value: &str) -> bool {
    value.eq_ignore_ascii_case("information_schema") || value.eq_ignore_ascii_case("performance_schema")
}

fn may_change_metadata(sql: &str) -> bool {
    let normalized = sql.trim().to_ascii_lowercase();
    ["create ", "drop ", "alter ", "rename ", "truncate "].iter().any(|prefix| normalized.starts_with(prefix))
}

fn trim_sql(sql: &str) -> &str {
    sql.trim().trim_end_matches(';').trim_end()
}

fn normalized_max_rows(max_rows: usize) -> usize {
    if max_rows == 0 {
        DEFAULT_MAX_ROWS
    } else {
        max_rows
    }
}

fn normalized_page_size(page_size: usize, fetch_size: usize, max_rows: usize) -> usize {
    let page_size = if page_size > 0 {
        page_size
    } else if fetch_size > 0 {
        fetch_size
    } else {
        500
    };
    page_size.min(max_rows.max(1))
}

fn connect_timeout(params: &ConnectParams) -> Duration {
    if params.connect_timeout_secs == 0 {
        DEFAULT_CONNECT_TIMEOUT
    } else {
        Duration::from_secs(params.connect_timeout_secs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn filters_names_with_substrings_and_subsequences() {
        assert!(text_matches("sensor_metrics", "metrics"));
        assert!(text_matches("sensor_metrics", "snm"));
        assert!(!text_matches("sensor_metrics", "xyz"));
    }

    #[test]
    fn prefers_query_timezone_and_falls_back_to_block_timezone() {
        assert_eq!(preferred_timezone(Some(chrono_tz::UTC), Some(chrono_tz::Asia::Shanghai)), Some(chrono_tz::UTC));
        assert_eq!(preferred_timezone(None, Some(chrono_tz::Asia::Shanghai)), Some(chrono_tz::Asia::Shanghai));
        assert_eq!(preferred_timezone(None, None), None);
    }

    #[test]
    fn sorts_stables_before_their_children() {
        let mut tables = vec![
            TableInfo {
                name: "d2".into(),
                table_type: "TABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: Some("meters".into()),
            },
            TableInfo {
                name: "meters".into(),
                table_type: "STABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            TableInfo {
                name: "d1".into(),
                table_type: "TABLE".into(),
                comment: None,
                parent_schema: None,
                parent_name: Some("meters".into()),
            },
        ];
        sort_tables_for_hierarchy(&mut tables);
        assert_eq!(tables.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["meters", "d1", "d2"]);
    }

    #[test]
    fn parses_tdengine_describe_metadata() {
        let columns = parse_describe_columns(vec![
            vec![json!("ts"), json!("TIMESTAMP"), json!(8), json!("")],
            vec![json!("device"), json!("VARCHAR(64)"), json!(64), json!("COMPOSITE KEY")],
            vec![json!("location"), json!("NCHAR(32)"), json!(32), json!("TAG")],
            vec![json!("reading"), json!("DECIMAL(20, 4)"), json!(16), Value::Null],
        ]);
        assert!(columns[0].is_primary_key);
        assert!(columns[1].is_primary_key);
        assert_eq!(columns[2].comment.as_deref(), Some("TAG"));
        assert_eq!(columns[2].character_maximum_length, Some(32));
        assert_eq!(columns[3].numeric_precision, Some(20));
        assert_eq!(columns[3].numeric_scale, Some(4));
    }

    #[test]
    fn converts_legacy_show_rows_to_hierarchy() {
        let table =
            table_from_show_row(vec![json!("d1001"), json!("x"), json!("x"), json!("meters")], "TABLE", true).unwrap();
        assert_eq!(table.parent_name.as_deref(), Some("meters"));
    }

    #[test]
    fn validates_database_names_before_using_unquoted_show_syntax() {
        assert_eq!(validate_database_name("Power_1").unwrap(), "Power_1");
        assert!(validate_database_name("power-data").is_err());
        assert!(validate_database_name("power; DROP DATABASE other").is_err());
        assert_eq!(quote_qualified_prefix("Power_1"), "Power_1.");
        assert_eq!(qualified_name("Power_1", "meters"), "Power_1.`meters`");
    }

    #[tokio::test]
    async fn cancellable_stops_pending_connector_operations() {
        let token = CancellationToken::new();
        token.cancel();
        let error = cancellable(&token, 0, std::future::pending::<taos::RawResult<()>>()).await.unwrap_err();
        assert!(error.to_string().contains("cancelled"));
    }
}
