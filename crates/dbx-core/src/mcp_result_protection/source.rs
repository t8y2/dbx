use serde::{Deserialize, Serialize};
use sqlparser::ast::{Expr, ObjectName, Query, Select, SetExpr, Statement, TableFactor, Visit, Visitor};
use std::ops::ControlFlow;

use super::{McpResultProtectionPolicy, ResultProtectionMode, ResultSource, SOURCE_UNRESOLVED};
use crate::{
    connection::{database_connection_config, sqlserver_uses_legacy_driver, AppState, MysqlMode, PoolKind},
    db,
    models::connection::{ConnectionConfig, DatabaseType},
    types::{ColumnInfo, TableInfo},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSourceMetadataRequest {
    pub connection_id: String,
    pub database: String,
    pub source: ResultSource,
}

#[derive(Serialize, Deserialize)]
pub struct ResultSourceMetadata {
    pub tables: Vec<TableInfo>,
    pub columns: Vec<ColumnInfo>,
}

pub(crate) fn query_has_unbound_database(sql: &str, db_type: DatabaseType, database: &str) -> bool {
    if sql.contains("/*!") || sql.to_ascii_uppercase().contains("/*M!") {
        return true;
    }
    let Ok(statements) = crate::sql_risk::parse_sql_for_result_protection(sql, db_type) else {
        return true;
    };
    let max_parts = match db_type {
        DatabaseType::Mysql | DatabaseType::Sqlite => 2,
        DatabaseType::Postgres | DatabaseType::SqlServer => 3,
        _ => return true,
    };
    statements.is_empty() || statements.visit(&mut DatabaseScopeVisitor { db_type, database, max_parts }).is_break()
}

struct DatabaseScopeVisitor<'a> {
    db_type: DatabaseType,
    database: &'a str,
    max_parts: usize,
}

impl Visitor for DatabaseScopeVisitor<'_> {
    type Break = ();

    // Relation hooks do not cover all object names (SHOW CREATE, TABLE,
    // SELECT INTO, routines). Only accept query forms checked below.
    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<()> {
        if matches!(statement, Statement::Query(_)) {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<()> {
        if query.with.is_none()
            && query.pipe_operators.is_empty()
            && matches!(query.body.as_ref(), SetExpr::Select(_) | SetExpr::Query(_))
        {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }

    fn pre_visit_select(&mut self, select: &Select) -> ControlFlow<()> {
        if select.into.is_none() {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }

    fn pre_visit_table_factor(&mut self, table: &TableFactor) -> ControlFlow<()> {
        if matches!(table, TableFactor::Table { args: None, json_path: None, .. }) {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }

    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<()> {
        if matches!(expr, Expr::Function(_)) {
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_relation(&mut self, name: &ObjectName) -> ControlFlow<()> {
        if name.0.is_empty() || name.0.len() > self.max_parts || name.0.iter().any(|part| part.as_ident().is_none()) {
            return ControlFlow::Break(());
        }
        if name.0.len() == self.max_parts
            && name.0[0].as_ident().is_none_or(|ident| {
                ident.value != self.database
                    && !(self.db_type == DatabaseType::Sqlite && ident.value.eq_ignore_ascii_case(self.database))
            })
        {
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    }
}

pub fn resolve_result_database(
    policy: &McpResultProtectionPolicy,
    connection: &ConnectionConfig,
    database: &str,
) -> Result<String, String> {
    let database_scoped = policy.has_database_overrides(&connection.id);
    let settings = policy.effective(&connection.id, database);
    if !database_scoped && !(settings.enabled && settings.mode == ResultProtectionMode::Strict) {
        return Ok(database.to_string());
    }
    let database = if connection.db_type == DatabaseType::Sqlite {
        if !database.is_empty() && !database.eq_ignore_ascii_case("main") {
            return Err(SOURCE_UNRESOLVED.to_string());
        }
        "main"
    } else if database.is_empty() {
        connection.effective_database().unwrap_or_default()
    } else {
        database
    };
    if database.is_empty()
        || connection.init_script.as_ref().is_some_and(|sql| !sql.trim().is_empty())
        || policy.overrides.iter().any(|scope| {
            scope.connection_id == connection.id
                && scope.database.as_ref().is_some_and(|name| name != database && name.eq_ignore_ascii_case(database))
        })
    {
        return Err(SOURCE_UNRESOLVED.to_string());
    }
    if database_scoped
        && connection.db_type == DatabaseType::Sqlite
        && connection
            .default_schema
            .as_deref()
            .is_some_and(|schema| !schema.is_empty() && !schema.eq_ignore_ascii_case("main"))
    {
        return Err(SOURCE_UNRESOLVED.to_string());
    }
    if !native_database_is_bound(connection, database) {
        return Err(SOURCE_UNRESOLVED.to_string());
    }
    Ok(database.to_string())
}

fn native_database_is_bound(connection: &ConnectionConfig, database: &str) -> bool {
    let config = database_connection_config(connection, Some(database));
    // A request label is not necessarily the driver's selected database. Check
    // the native options before choosing even a disabled database override.
    match connection.db_type {
        DatabaseType::Sqlite => true,
        DatabaseType::Mysql if !connection.needs_bare_mysql() => {
            db::mysql::database_name_for_result_protection(&config.connection_url()).as_deref() == Some(database)
        }
        DatabaseType::Postgres => {
            db::postgres::database_name_for_result_protection(&config.connection_url()).as_deref() == Some(database)
        }
        DatabaseType::SqlServer => !sqlserver_uses_legacy_driver(connection),
        _ => false,
    }
}

pub async fn result_source_metadata(
    state: &AppState,
    request: &ResultSourceMetadataRequest,
) -> Result<ResultSourceMetadata, String> {
    let result = native_metadata(state, request).await;
    result.map_err(|_| SOURCE_UNRESOLVED.to_string())
}

async fn native_metadata(
    state: &AppState,
    request: &ResultSourceMetadataRequest,
) -> Result<ResultSourceMetadata, String> {
    let config = state.configs.read().await.get(&request.connection_id).cloned().ok_or(SOURCE_UNRESOLVED)?;
    if request.source.schema.is_empty()
        || config.init_script.as_ref().is_some_and(|sql| !sql.trim().is_empty())
        || !native_database_is_bound(&config, &request.database)
    {
        return Err(SOURCE_UNRESOLVED.to_string());
    }
    let key = state.get_or_create_pool(&request.connection_id, Some(&request.database)).await?;
    let pool = state.pool_handle(&key).await.ok_or(SOURCE_UNRESOLVED)?;
    let schema = &request.source.schema;
    let table = &request.source.table;
    // General metadata APIs may silently fall back to providers that omit
    // generated-column flags. Strict protection only uses verified native paths.
    let (tables, columns) = match pool {
        PoolKind::Sqlite(pool) if config.db_type == DatabaseType::Sqlite => {
            (db::sqlite::list_tables(&pool, schema).await?, db::sqlite::get_columns(&pool, schema, table).await?)
        }
        PoolKind::Mysql(pool, MysqlMode::Normal) if config.db_type == DatabaseType::Mysql => {
            if schema != &request.database
                || !db::mysql::list_databases(&pool).await?.iter().any(|db| &db.name == schema)
            {
                return Err(SOURCE_UNRESOLVED.to_string());
            }
            (db::mysql::list_tables(&pool, schema).await?, db::mysql::get_columns(&pool, schema, table).await?)
        }
        PoolKind::Postgres(pool) if config.db_type == DatabaseType::Postgres => (
            db::postgres::list_tables(&pool, schema).await?,
            db::postgres::get_columns_for_result_protection(&pool, schema, table).await?,
        ),
        PoolKind::SqlServer(client) if config.db_type == DatabaseType::SqlServer => {
            let mut client = client.lock().await;
            // Desktop queries can change this shared client's database. Keep
            // the identity check and metadata reads under the same lock.
            let current = client
                .query("SELECT DB_NAME()", &[])
                .await
                .map_err(|e| e.to_string())?
                .into_row()
                .await
                .map_err(|e| e.to_string())?;
            if current.as_ref().and_then(|row| row.get::<&str, _>(0)) != Some(request.database.as_str())
                || !db::sqlserver::list_schemas(&mut client).await?.contains(schema)
            {
                return Err(SOURCE_UNRESOLVED.to_string());
            }
            (
                db::sqlserver::list_tables(&mut client, schema, None, None, None).await?,
                db::sqlserver::get_columns(&mut client, schema, table).await?,
            )
        }
        _ => return Err(SOURCE_UNRESOLVED.to_string()),
    };
    Ok(ResultSourceMetadata { tables, columns })
}
