use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TablePaginationStrategy {
    LimitOffset,
    FetchFirst,
    Db2FetchFirst,
    SqlServerTop,
    IrisTop,
    InformixFirst,
    FirebirdRows,
    Rownum,
    QuestDbLimit,
    Unbounded,
    AgentMaxRows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaginationContext {
    TablePreview,
    BoundedRead,
    UserQuery,
}

pub fn is_schema_aware(database_type: DatabaseType) -> bool {
    matches!(
        database_type,
        DatabaseType::Postgres
            | DatabaseType::SqlServer
            | DatabaseType::Oracle
            | DatabaseType::Redshift
            | DatabaseType::Dameng
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::Kingbase
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
            | DatabaseType::Yashandb
            | DatabaseType::Oscar
            | DatabaseType::Databricks
            | DatabaseType::SapHana
            | DatabaseType::Teradata
            | DatabaseType::Vertica
            | DatabaseType::Exasol
            | DatabaseType::OpenGauss
            | DatabaseType::OceanbaseOracle
            | DatabaseType::Gbase
            | DatabaseType::Databend
            | DatabaseType::Jdbc
            | DatabaseType::H2
            | DatabaseType::Snowflake
            | DatabaseType::Trino
            | DatabaseType::PrestoSql
            | DatabaseType::Hive
            | DatabaseType::Spark
            | DatabaseType::Db2
            | DatabaseType::Tdengine
            | DatabaseType::Xugu
            | DatabaseType::Sqlite
            | DatabaseType::DuckDb
            | DatabaseType::Iris
    )
}

pub fn uses_fetch_first(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Oracle | DatabaseType::Dameng | DatabaseType::Db2)
}

pub fn uses_oracle_row_id(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::Oracle | DatabaseType::OceanbaseOracle))
}

/// Oracle 系方言不支持 `INSERT ... VALUES (...), (...)` 多行语法，
/// 复制为 INSERT 与导出 INSERT 都需按行生成单条语句。
pub fn uses_single_row_insert_statements(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
}

pub fn pagination_strategy(database_type: Option<DatabaseType>, context: PaginationContext) -> TablePaginationStrategy {
    match database_type {
        Some(DatabaseType::Jdbc) => TablePaginationStrategy::AgentMaxRows,
        Some(DatabaseType::Oracle) if matches!(context, PaginationContext::TablePreview) => {
            TablePaginationStrategy::Rownum
        }
        Some(DatabaseType::Oracle) if matches!(context, PaginationContext::BoundedRead) => {
            TablePaginationStrategy::FetchFirst
        }
        Some(DatabaseType::Oracle) => TablePaginationStrategy::Unbounded,
        Some(DatabaseType::Oscar)
            if matches!(context, PaginationContext::TablePreview | PaginationContext::BoundedRead) =>
        {
            TablePaginationStrategy::Rownum
        }
        Some(DatabaseType::Oscar) => TablePaginationStrategy::Unbounded,
        Some(DatabaseType::Dameng) => TablePaginationStrategy::FetchFirst,
        Some(DatabaseType::Db2) => TablePaginationStrategy::Db2FetchFirst,
        Some(DatabaseType::SqlServer) => TablePaginationStrategy::SqlServerTop,
        Some(DatabaseType::Iris) => TablePaginationStrategy::IrisTop,
        Some(DatabaseType::Informix) => TablePaginationStrategy::InformixFirst,
        Some(DatabaseType::Firebird) => TablePaginationStrategy::FirebirdRows,
        Some(DatabaseType::OceanbaseOracle) => TablePaginationStrategy::Rownum,
        Some(DatabaseType::Questdb) => TablePaginationStrategy::QuestDbLimit,
        _ => TablePaginationStrategy::LimitOffset,
    }
}

pub fn table_pagination_strategy(database_type: Option<DatabaseType>) -> TablePaginationStrategy {
    pagination_strategy(database_type, PaginationContext::TablePreview)
}

pub(super) fn is_simple_informix_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
}

pub fn firebird_rows_clause(limit: usize, offset: usize) -> String {
    if offset > 0 {
        let start = offset + 1;
        let end = offset + limit;
        format!("ROWS {start} TO {end}")
    } else {
        format!("ROWS {limit}")
    }
}
