use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::sql_dialect::{is_schema_aware, qualified_table_name, quote_table_identifier};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DatabaseObjectType {
    Table,
    View,
    MaterializedView,
    Procedure,
    Function,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TableChildObjectType {
    Column,
    Index,
    ForeignKey,
    Trigger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameObjectSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub object_type: DatabaseObjectType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub old_name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabaseSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<DatabaseCreationTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseCreationTarget {
    Database,
    Schema,
    Catalog,
    Namespace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "duckdb-bundled")]
pub struct DuckDbAttachDatabaseSqlOptions {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropObjectSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub object_type: DatabaseObjectType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableAdminSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cascade: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropTableChildObjectSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub object_type: TableChildObjectType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseNameSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNameSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePropertyEditSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_profile: Option<String>,
    pub target: DatabasePropertyTarget,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabasePropertyTarget {
    Database,
    Schema,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateTableStructureSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub source_name: String,
    pub target_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyTableDataSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub source_name: String,
    pub target_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<String>>,
    #[serde(default)]
    pub postgres_overriding_system_value: bool,
    #[serde(default)]
    pub sqlserver_identity_insert: bool,
}

const MYSQL_COMPATIBLE_PROFILES: &[&str] =
    &["mysql", "mariadb", "tidb", "oceanbase", "doris", "starrocks", "custom_mysql"];

pub fn supports_create_database_charset(database_type: Option<DatabaseType>, driver_profile: Option<&str>) -> bool {
    let normalized_profile = driver_profile.map(str::to_ascii_lowercase);
    matches!(
        database_type,
        Some(DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::Goldendb)
    ) || normalized_profile.as_deref().is_some_and(|profile| MYSQL_COMPATIBLE_PROFILES.contains(&profile))
}

pub fn build_create_database_sql(options: CreateDatabaseSqlOptions) -> Result<String, String> {
    match options.target.unwrap_or(DatabaseCreationTarget::Database) {
        DatabaseCreationTarget::Database => build_create_database_statement(&options),
        // Schema creation is exposed through the same frontend dialog contract when the tree target is a database node.
        DatabaseCreationTarget::Schema => {
            build_create_schema_sql(SchemaNameSqlOptions { database_type: options.database_type, name: options.name })
        }
        DatabaseCreationTarget::Catalog => Err("Creating catalogs is not supported yet.".to_string()),
        DatabaseCreationTarget::Namespace => Err("Creating namespaces is not supported yet.".to_string()),
    }
}

fn build_create_database_statement(options: &CreateDatabaseSqlOptions) -> Result<String, String> {
    if !supports_create_database_target(options.database_type) {
        return Err(format!("Creating databases is not supported for {}.", database_label(options.database_type)));
    }
    let name = quote_table_identifier(options.database_type, &options.name);
    let charset = clean_sql_option(options.charset.as_deref());
    let collation = clean_sql_option(options.collation.as_deref());
    if !supports_create_database_charset(options.database_type, options.driver_profile.as_deref()) || charset.is_empty()
    {
        return Ok(format!("CREATE DATABASE {name};"));
    }
    let collate_clause = if collation.is_empty() { String::new() } else { format!(" COLLATE {collation}") };
    Ok(format!("CREATE DATABASE {name} CHARACTER SET {charset}{collate_clause};"))
}

pub fn supports_create_database_target(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(
            DatabaseType::Mysql
                | DatabaseType::Doris
                | DatabaseType::StarRocks
                | DatabaseType::Goldendb
                | DatabaseType::ClickHouse
                | DatabaseType::SqlServer
                | DatabaseType::InfluxDb
                | DatabaseType::Databend
                | DatabaseType::Snowflake
                | DatabaseType::Tdengine
                | DatabaseType::Postgres
                | DatabaseType::Redshift
                | DatabaseType::Gaussdb
                | DatabaseType::Kwdb
                | DatabaseType::OpenGauss
                | DatabaseType::Vastbase
                | DatabaseType::Highgo
                | DatabaseType::Kingbase
                | DatabaseType::Yashandb
        )
    )
}

pub fn supports_create_schema_target(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(
            DatabaseType::Postgres
                | DatabaseType::Redshift
                | DatabaseType::SqlServer
                | DatabaseType::Db2
                | DatabaseType::Gaussdb
                | DatabaseType::Kwdb
                | DatabaseType::Kingbase
                | DatabaseType::Highgo
                | DatabaseType::Vastbase
                | DatabaseType::Yashandb
                | DatabaseType::Dameng
                | DatabaseType::Databricks
                | DatabaseType::SapHana
                | DatabaseType::Teradata
                | DatabaseType::Vertica
                | DatabaseType::Exasol
                | DatabaseType::OpenGauss
                | DatabaseType::Gbase
                | DatabaseType::Trino
                | DatabaseType::PrestoSql
                | DatabaseType::H2
                | DatabaseType::Informix
                | DatabaseType::Xugu
                | DatabaseType::Oscar
                | DatabaseType::Iris
                | DatabaseType::Snowflake
        )
    )
}

pub fn supports_database_property_charset(database_type: Option<DatabaseType>, driver_profile: Option<&str>) -> bool {
    supports_create_database_charset(database_type, driver_profile)
        && matches!(database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb))
}

pub fn supports_database_property_comment(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(
            DatabaseType::Postgres
                | DatabaseType::Gaussdb
                | DatabaseType::Kwdb
                | DatabaseType::Kingbase
                | DatabaseType::Highgo
                | DatabaseType::Vastbase
                | DatabaseType::OpenGauss
                | DatabaseType::Yashandb
        )
    )
}

#[cfg(feature = "duckdb-bundled")]
pub fn build_duckdb_attach_database_sql(options: DuckDbAttachDatabaseSqlOptions) -> String {
    format!(
        "ATTACH {} AS {};",
        quote_sql_string(&options.path),
        quote_table_identifier(Some(DatabaseType::DuckDb), &options.name)
    )
}

pub fn build_create_user_sql(username: &str, password: &str, tablespace: &str) -> String {
    format!(
        "CREATE USER {} IDENTIFIED BY {} DEFAULT TABLESPACE {};",
        quote_table_identifier(Some(DatabaseType::Dameng), username),
        quote_sql_string(password),
        quote_table_identifier(Some(DatabaseType::Dameng), tablespace)
    )
}

pub fn build_drop_object_sql(options: DropObjectSqlOptions) -> String {
    let signature = if matches!(options.database_type, Some(DatabaseType::Postgres))
        && matches!(options.object_type, DatabaseObjectType::Function | DatabaseObjectType::Procedure)
    {
        options.signature.as_deref().map(|value| format!("({value})")).unwrap_or_default()
    } else {
        String::new()
    };
    format!(
        "DROP {} {}{};",
        object_type_keyword(options.object_type),
        qualified_name(options.database_type, options.schema.as_deref(), &options.name),
        signature
    )
}

pub fn build_drop_table_sql(options: TableAdminSqlOptions) -> String {
    let table = qualified_name(options.database_type, options.schema.as_deref(), &options.table_name);
    if matches!(options.database_type, Some(DatabaseType::Iotdb)) {
        return format!("DELETE TIMESERIES {};", iotdb_timeseries_pattern(&table));
    } else if matches!(options.database_type, Some(DatabaseType::InfluxDb)) {
        return format!("DROP MEASUREMENT {};", table);
    }
    // CASCADE is valid for PostgreSQL-family dialects; keep default RESTRICT behavior elsewhere.
    let cascade = if options.cascade.unwrap_or(false) && supports_drop_table_cascade(options.database_type) {
        " CASCADE"
    } else {
        ""
    };
    format!("DROP TABLE {table}{cascade};")
}

fn supports_drop_table_cascade(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(
            DatabaseType::Postgres
                | DatabaseType::Redshift
                | DatabaseType::Gaussdb
                | DatabaseType::Kwdb
                | DatabaseType::Kingbase
                | DatabaseType::Highgo
                | DatabaseType::Vastbase
                | DatabaseType::OpenGauss
        )
    )
}

pub fn build_drop_table_child_object_sql(options: DropTableChildObjectSqlOptions) -> Result<String, String> {
    let database_type = options.database_type;
    let table = qualified_name(database_type, options.schema.as_deref(), &options.table_name);
    let name = quote_rename_identifier(database_type, &options.name);
    match options.object_type {
        TableChildObjectType::Column => Ok(format!("ALTER TABLE {table} DROP COLUMN {name};")),
        TableChildObjectType::Index => {
            if matches!(database_type, Some(DatabaseType::ClickHouse | DatabaseType::Redshift)) {
                return Err(format!("Dropping indexes is not supported for {}.", database_label(database_type)));
            }
            if matches!(database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb | DatabaseType::SqlServer)) {
                return Ok(format!("DROP INDEX {name} ON {table};"));
            }
            if matches!(
                database_type,
                Some(
                    DatabaseType::Postgres
                        | DatabaseType::Gaussdb
                        | DatabaseType::Kwdb
                        | DatabaseType::OpenGauss
                        | DatabaseType::Questdb
                        | DatabaseType::Highgo
                        | DatabaseType::Vastbase
                        | DatabaseType::Kingbase
                        | DatabaseType::Oracle
                        | DatabaseType::Dameng
                        | DatabaseType::OceanbaseOracle
                        | DatabaseType::Iris
                )
            ) && options.schema.as_deref().is_some_and(|schema| !schema.is_empty())
            {
                let schema = quote_rename_identifier(database_type, options.schema.as_deref().unwrap());
                return Ok(format!("DROP INDEX {schema}.{name};"));
            }
            Ok(format!("DROP INDEX {name};"))
        }
        TableChildObjectType::ForeignKey => {
            if matches!(database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb)) {
                Ok(format!("ALTER TABLE {table} DROP FOREIGN KEY {name};"))
            } else {
                Ok(format!("ALTER TABLE {table} DROP CONSTRAINT {name};"))
            }
        }
        TableChildObjectType::Trigger => {
            if matches!(
                database_type,
                Some(
                    DatabaseType::Postgres
                        | DatabaseType::Gaussdb
                        | DatabaseType::Kwdb
                        | DatabaseType::OpenGauss
                        | DatabaseType::Questdb
                        | DatabaseType::Highgo
                        | DatabaseType::Vastbase
                        | DatabaseType::Kingbase
                )
            ) {
                Ok(format!("DROP TRIGGER {name} ON {table};"))
            } else if matches!(database_type, Some(DatabaseType::SqlServer)) {
                Ok(format!("DROP TRIGGER {name};"))
            } else if database_type.is_some_and(is_schema_aware)
                && options.schema.as_deref().is_some_and(|schema| !schema.is_empty())
                && !matches!(database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb))
            {
                let schema = quote_rename_identifier(database_type, options.schema.as_deref().unwrap());
                Ok(format!("DROP TRIGGER {schema}.{name};"))
            } else {
                Ok(format!("DROP TRIGGER {name};"))
            }
        }
    }
}

pub fn build_empty_table_sql(options: TableAdminSqlOptions) -> String {
    let table = qualified_name(options.database_type, options.schema.as_deref(), &options.table_name);
    match options.database_type {
        Some(DatabaseType::ClickHouse) => format!("ALTER TABLE {table} DELETE WHERE 1 = 1;"),
        Some(DatabaseType::Bigquery) => format!("DELETE FROM {table} WHERE TRUE;"),
        Some(DatabaseType::Cassandra | DatabaseType::Hive | DatabaseType::Kylin | DatabaseType::Questdb) => {
            format!("TRUNCATE TABLE {table};")
        }
        Some(DatabaseType::Iotdb) => format!("DELETE FROM {};", iotdb_timeseries_pattern(&table)),
        _ => format!("DELETE FROM {table};"),
    }
}

pub fn build_truncate_table_sql(options: TableAdminSqlOptions) -> String {
    let table = qualified_name(options.database_type, options.schema.as_deref(), &options.table_name);
    if matches!(options.database_type, Some(DatabaseType::Iotdb)) {
        format!("DELETE FROM {};", iotdb_timeseries_pattern(&table))
    } else if matches!(options.database_type, Some(DatabaseType::Sqlite | DatabaseType::DuckDb)) {
        format!("DELETE FROM {table};")
    } else {
        // TRUNCATE CASCADE is PostgreSQL-family syntax; other dialects keep their existing default.
        let cascade = if options.cascade.unwrap_or(false) && supports_truncate_table_cascade(options.database_type) {
            " CASCADE"
        } else {
            ""
        };
        format!("TRUNCATE TABLE {table}{cascade};")
    }
}

fn supports_truncate_table_cascade(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(
            DatabaseType::Postgres
                | DatabaseType::Gaussdb
                | DatabaseType::Kwdb
                | DatabaseType::Kingbase
                | DatabaseType::Highgo
                | DatabaseType::Vastbase
                | DatabaseType::OpenGauss
        )
    )
}

pub fn build_drop_database_sql(options: DatabaseNameSqlOptions) -> String {
    format!("DROP DATABASE {};", quote_table_identifier(options.database_type, &options.name))
}

pub fn build_update_database_properties_sql(options: DatabasePropertyEditSqlOptions) -> Result<String, String> {
    match options.target {
        DatabasePropertyTarget::Database => {
            if options.comment.is_some() {
                return build_database_comment_sql(options.database_type, &options.name, options.comment.as_deref());
            }
            build_database_charset_sql(&options)
        }
        DatabasePropertyTarget::Schema => {
            build_schema_comment_sql(options.database_type, &options.name, options.comment.as_deref())
        }
    }
}

fn build_database_charset_sql(options: &DatabasePropertyEditSqlOptions) -> Result<String, String> {
    if !supports_database_property_charset(options.database_type, options.driver_profile.as_deref()) {
        return Err(format!(
            "Editing database charset/collation is not supported for {}.",
            database_label(options.database_type)
        ));
    }
    let charset = clean_sql_option(options.charset.as_deref());
    let collation = clean_sql_option(options.collation.as_deref());
    if charset.is_empty() && collation.is_empty() {
        return Err("At least one charset or collation value is required.".to_string());
    }
    let mut sql = format!("ALTER DATABASE {}", quote_table_identifier(options.database_type, &options.name));
    if !charset.is_empty() {
        sql.push_str(&format!(" DEFAULT CHARACTER SET {charset}"));
    }
    if !collation.is_empty() {
        sql.push_str(&format!(" DEFAULT COLLATE {collation}"));
    }
    sql.push(';');
    Ok(sql)
}

fn build_database_comment_sql(
    database_type: Option<DatabaseType>,
    name: &str,
    comment: Option<&str>,
) -> Result<String, String> {
    if !supports_database_property_comment(database_type) {
        return Err(format!("Editing database comments is not supported for {}.", database_label(database_type)));
    }
    Ok(format!("COMMENT ON DATABASE {} IS {};", quote_table_identifier(database_type, name), comment_literal(comment)))
}

fn build_schema_comment_sql(
    database_type: Option<DatabaseType>,
    name: &str,
    comment: Option<&str>,
) -> Result<String, String> {
    if !supports_database_property_comment(database_type) {
        return Err(format!("Editing schema comments is not supported for {}.", database_label(database_type)));
    }
    Ok(format!("COMMENT ON SCHEMA {} IS {};", quote_table_identifier(database_type, name), comment_literal(comment)))
}

pub fn build_create_schema_sql(options: SchemaNameSqlOptions) -> Result<String, String> {
    if !supports_create_schema_target(options.database_type) {
        return Err(format!("Creating schemas is not supported for {}.", database_label(options.database_type)));
    }
    Ok(format!("CREATE SCHEMA {};", quote_table_identifier(options.database_type, &options.name)))
}

pub fn build_drop_schema_sql(options: SchemaNameSqlOptions) -> String {
    let schema = quote_table_identifier(options.database_type, &options.name);
    if matches!(options.database_type, Some(DatabaseType::Postgres | DatabaseType::Gaussdb | DatabaseType::Kwdb)) {
        format!("DROP SCHEMA {schema} CASCADE;")
    } else {
        format!("DROP SCHEMA {schema};")
    }
}

pub fn build_duplicate_table_structure_sql(options: DuplicateTableStructureSqlOptions) -> String {
    let source = qualified_name(options.database_type, options.schema.as_deref(), &options.source_name);
    let target = qualified_name(options.database_type, options.schema.as_deref(), &options.target_name);
    if options.database_type == Some(DatabaseType::Mysql) {
        return format!("CREATE TABLE {target} LIKE {source};");
    }
    if options.database_type == Some(DatabaseType::Questdb) {
        return format!("CREATE TABLE {target} (LIKE {source});");
    }
    if options.database_type.is_some_and(is_postgres_like_structure_copy) {
        return format!("CREATE TABLE {target} (LIKE {source} INCLUDING ALL);");
    }
    if options.database_type == Some(DatabaseType::SqlServer) {
        return format!("SELECT TOP 0 * INTO {target} FROM {source};");
    }
    if options.database_type.is_some_and(uses_false_predicate_duplicate_structure) {
        return format!("CREATE TABLE {target} AS SELECT * FROM {source} WHERE 1=0");
    }
    format!("CREATE TABLE {target} AS SELECT * FROM {source} WHERE 0;")
}

pub fn build_copy_table_data_sql(options: CopyTableDataSqlOptions) -> String {
    let source = qualified_name(options.database_type, options.schema.as_deref(), &options.source_name);
    let target = qualified_name(options.database_type, options.schema.as_deref(), &options.target_name);
    let Some(columns) = options.columns.filter(|columns| !columns.is_empty()) else {
        return format!("INSERT INTO {target} SELECT * FROM {source};");
    };
    let column_list = columns
        .iter()
        .map(|column| quote_table_identifier(options.database_type, column))
        .collect::<Vec<_>>()
        .join(", ");
    let postgres_override = if options.postgres_overriding_system_value
        && matches!(options.database_type, Some(DatabaseType::Postgres | DatabaseType::Gaussdb | DatabaseType::Kwdb))
    {
        " OVERRIDING SYSTEM VALUE"
    } else {
        ""
    };
    let insert_sql =
        format!("INSERT INTO {target} ({column_list}){postgres_override} SELECT {column_list} FROM {source};");
    if options.sqlserver_identity_insert && options.database_type == Some(DatabaseType::SqlServer) {
        return format!("SET IDENTITY_INSERT {target} ON;\n{insert_sql}\nSET IDENTITY_INSERT {target} OFF;");
    }
    insert_sql
}

pub fn supports_object_rename(database_type: Option<DatabaseType>, object_type: DatabaseObjectType) -> bool {
    let Some(database_type) = database_type else {
        return false;
    };
    if database_type == DatabaseType::SqlServer {
        return true;
    }
    if matches!(object_type, DatabaseObjectType::Procedure | DatabaseObjectType::Function) {
        return false;
    }
    if database_type == DatabaseType::Sqlite {
        return object_type == DatabaseObjectType::Table;
    }
    if matches!(database_type, DatabaseType::Mysql | DatabaseType::Goldendb) {
        return matches!(object_type, DatabaseObjectType::Table | DatabaseObjectType::View);
    }
    if is_postgres_like_rename(database_type) || is_oracle_like_rename(database_type) {
        return matches!(
            object_type,
            DatabaseObjectType::Table | DatabaseObjectType::View | DatabaseObjectType::MaterializedView
        );
    }
    false
}

pub fn build_rename_object_sql(options: RenameObjectSqlOptions) -> Result<String, String> {
    let database_type = options.database_type;
    if !supports_object_rename(database_type, options.object_type) {
        return Err(format!(
            "Renaming {} is not supported for {}.",
            object_type_keyword(options.object_type),
            database_label(database_type)
        ));
    }

    if database_type == Some(DatabaseType::SqlServer) {
        return Ok(format!(
            "EXEC sp_rename {}, {}, N'OBJECT';",
            sqlserver_string(&sqlserver_object_name(options.schema.as_deref(), &options.old_name)),
            sqlserver_string(&options.new_name)
        ));
    }

    if matches!(database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb)) {
        return Ok(format!(
            "RENAME TABLE {} TO {};",
            qualified_name(database_type, options.schema.as_deref(), &options.old_name),
            qualified_name(database_type, options.schema.as_deref(), &options.new_name)
        ));
    }

    if database_type == Some(DatabaseType::Sqlite) {
        return Ok(format!(
            "ALTER TABLE {} RENAME TO {};",
            qualified_name(database_type, options.schema.as_deref(), &options.old_name),
            quote_rename_identifier(database_type, &options.new_name)
        ));
    }

    if database_type
        .is_some_and(|database_type| is_postgres_like_rename(database_type) || is_oracle_like_rename(database_type))
    {
        return Ok(format!(
            "ALTER {} {} RENAME TO {};",
            object_type_keyword(options.object_type),
            qualified_name(database_type, options.schema.as_deref(), &options.old_name),
            quote_rename_identifier(database_type, &options.new_name)
        ));
    }

    Err(format!(
        "Renaming {} is not supported for {}.",
        object_type_keyword(options.object_type),
        database_label(database_type)
    ))
}

fn is_postgres_like_rename(database_type: DatabaseType) -> bool {
    matches!(
        database_type,
        DatabaseType::Postgres
            | DatabaseType::Redshift
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::Kingbase
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
    )
}

fn is_oracle_like_rename(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Oracle | DatabaseType::Dameng)
}

fn is_postgres_like_structure_copy(database_type: DatabaseType) -> bool {
    matches!(
        database_type,
        DatabaseType::Postgres
            | DatabaseType::Redshift
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::OpenGauss
            | DatabaseType::Questdb
    )
}

fn uses_false_predicate_duplicate_structure(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Oracle | DatabaseType::Dameng | DatabaseType::Iris)
}

fn sqlserver_string(value: &str) -> String {
    format!("N'{}'", value.replace('\'', "''"))
}

fn quote_rename_identifier(database_type: Option<DatabaseType>, name: &str) -> String {
    if matches!(database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb)) {
        format!("`{}`", name.replace('`', "``"))
    } else {
        quote_table_identifier(database_type, name)
    }
}

fn qualified_name(database_type: Option<DatabaseType>, schema: Option<&str>, name: &str) -> String {
    if matches!(database_type, Some(DatabaseType::Iotdb)) {
        return qualified_table_name(database_type, schema, name);
    }
    if database_type.is_some_and(is_schema_aware) && schema.is_some_and(|schema| !schema.is_empty()) {
        format!(
            "{}.{}",
            quote_rename_identifier(database_type, schema.unwrap()),
            quote_rename_identifier(database_type, name)
        )
    } else {
        quote_rename_identifier(database_type, name)
    }
}

fn iotdb_timeseries_pattern(path: &str) -> String {
    let path = path.trim().trim_end_matches(';');
    if path.ends_with(".*") || path.ends_with(".**") {
        path.to_string()
    } else {
        format!("{path}.*")
    }
}

fn sqlserver_object_name(schema: Option<&str>, name: &str) -> String {
    schema
        .filter(|schema| !schema.is_empty())
        .map(|schema| format!("{schema}.{name}"))
        .unwrap_or_else(|| name.to_string())
}

fn object_type_keyword(object_type: DatabaseObjectType) -> &'static str {
    match object_type {
        DatabaseObjectType::Table => "TABLE",
        DatabaseObjectType::View => "VIEW",
        DatabaseObjectType::MaterializedView => "MATERIALIZED VIEW",
        DatabaseObjectType::Procedure => "PROCEDURE",
        DatabaseObjectType::Function => "FUNCTION",
    }
}

fn clean_sql_option(value: Option<&str>) -> String {
    value.unwrap_or("").trim().replace([';', ' ', '\n', '\r', '\t'], "")
}

fn quote_sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn comment_literal(value: Option<&str>) -> String {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => quote_sql_string(value),
        None => "NULL".to_string(),
    }
}

fn database_label(database_type: Option<DatabaseType>) -> String {
    database_type
        .and_then(|database_type| serde_json::to_value(database_type).ok())
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "this database".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_mysql_create_database_sql_with_charset_and_collation() {
        assert_eq!(
            build_create_database_sql(CreateDatabaseSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                driver_profile: Some("mysql".to_string()),
                target: None,
                parent: None,
                name: "app db".to_string(),
                charset: Some("utf8mb4".to_string()),
                collation: Some("utf8mb4_unicode_ci".to_string()),
            })
            .unwrap(),
            "CREATE DATABASE `app db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
        );
    }

    #[test]
    fn builds_goldendb_create_database_sql_with_mysql_charset_options() {
        assert_eq!(
            build_create_database_sql(CreateDatabaseSqlOptions {
                database_type: Some(DatabaseType::Goldendb),
                driver_profile: Some("goldendb".to_string()),
                target: None,
                parent: None,
                name: "app_db".to_string(),
                charset: Some("utf8mb4".to_string()),
                collation: Some("utf8mb4_unicode_ci".to_string()),
            })
            .unwrap(),
            "CREATE DATABASE `app_db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
        );
    }

    #[test]
    fn omits_create_database_charset_for_non_mysql_types() {
        assert_eq!(
            build_create_database_sql(CreateDatabaseSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                driver_profile: None,
                target: None,
                parent: None,
                name: "analytics".to_string(),
                charset: Some("utf8mb4".to_string()),
                collation: Some("utf8mb4_unicode_ci".to_string()),
            })
            .unwrap(),
            "CREATE DATABASE \"analytics\";"
        );
    }

    #[test]
    fn builds_vastbase_create_database_sql_without_mysql_charset_options() {
        assert_eq!(
            build_create_database_sql(CreateDatabaseSqlOptions {
                database_type: Some(DatabaseType::Vastbase),
                driver_profile: Some("vastbase".to_string()),
                target: None,
                parent: None,
                name: "app_db".to_string(),
                charset: Some("utf8mb4".to_string()),
                collation: Some("utf8mb4_unicode_ci".to_string()),
            })
            .unwrap(),
            "CREATE DATABASE \"app_db\";"
        );
    }

    #[test]
    fn builds_additional_verified_create_database_targets() {
        assert_eq!(
            build_create_database_sql(CreateDatabaseSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                driver_profile: None,
                target: None,
                parent: None,
                name: "analytics db".to_string(),
                charset: None,
                collation: None,
            })
            .unwrap(),
            "CREATE DATABASE [analytics db];"
        );
        assert_eq!(
            build_create_database_sql(CreateDatabaseSqlOptions {
                database_type: Some(DatabaseType::Snowflake),
                driver_profile: None,
                target: None,
                parent: None,
                name: "analytics db".to_string(),
                charset: None,
                collation: None,
            })
            .unwrap(),
            "CREATE DATABASE \"analytics db\";"
        );
        assert_eq!(
            build_create_database_sql(CreateDatabaseSqlOptions {
                database_type: Some(DatabaseType::Databend),
                driver_profile: None,
                target: None,
                parent: None,
                name: "analytics db".to_string(),
                charset: None,
                collation: None,
            })
            .unwrap(),
            "CREATE DATABASE `analytics db`;"
        );
        assert_eq!(
            build_create_database_sql(CreateDatabaseSqlOptions {
                database_type: Some(DatabaseType::Tdengine),
                driver_profile: None,
                target: None,
                parent: None,
                name: "analytics db".to_string(),
                charset: None,
                collation: None,
            })
            .unwrap(),
            "CREATE DATABASE `analytics db`;"
        );
    }

    #[test]
    fn rejects_unsupported_create_database_targets() {
        assert!(build_create_database_sql(CreateDatabaseSqlOptions {
            database_type: Some(DatabaseType::Oracle),
            driver_profile: None,
            target: None,
            parent: None,
            name: "analytics".to_string(),
            charset: None,
            collation: None,
        })
        .unwrap_err()
        .contains("Creating databases is not supported"));
        assert!(build_create_database_sql(CreateDatabaseSqlOptions {
            database_type: Some(DatabaseType::Jdbc),
            driver_profile: None,
            target: None,
            parent: None,
            name: "analytics".to_string(),
            charset: None,
            collation: None,
        })
        .unwrap_err()
        .contains("Creating databases is not supported"));
    }

    #[test]
    fn builds_mysql_database_property_charset_sql() {
        assert_eq!(
            build_update_database_properties_sql(DatabasePropertyEditSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                driver_profile: Some("mysql".to_string()),
                target: DatabasePropertyTarget::Database,
                name: "app db".to_string(),
                charset: Some("utf8mb4".to_string()),
                collation: Some("utf8mb4_unicode_ci".to_string()),
                comment: None,
            })
            .unwrap(),
            "ALTER DATABASE `app db` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci;"
        );
        assert_eq!(
            build_update_database_properties_sql(DatabasePropertyEditSqlOptions {
                database_type: Some(DatabaseType::Goldendb),
                driver_profile: None,
                target: DatabasePropertyTarget::Database,
                name: "app".to_string(),
                charset: Some("utf8mb4".to_string()),
                collation: None,
                comment: None,
            })
            .unwrap(),
            "ALTER DATABASE `app` DEFAULT CHARACTER SET utf8mb4;"
        );
    }

    #[test]
    fn builds_postgres_style_database_and_schema_comment_sql() {
        assert_eq!(
            build_update_database_properties_sql(DatabasePropertyEditSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                driver_profile: None,
                target: DatabasePropertyTarget::Database,
                name: "app db".to_string(),
                charset: None,
                collation: None,
                comment: Some("owner's app".to_string()),
            })
            .unwrap(),
            "COMMENT ON DATABASE \"app db\" IS 'owner''s app';"
        );
        assert_eq!(
            build_update_database_properties_sql(DatabasePropertyEditSqlOptions {
                database_type: Some(DatabaseType::Kingbase),
                driver_profile: None,
                target: DatabasePropertyTarget::Schema,
                name: "public".to_string(),
                charset: None,
                collation: None,
                comment: Some("".to_string()),
            })
            .unwrap(),
            "COMMENT ON SCHEMA \"public\" IS NULL;"
        );
    }

    #[test]
    fn rejects_unsupported_database_property_sql() {
        assert!(build_update_database_properties_sql(DatabasePropertyEditSqlOptions {
            database_type: Some(DatabaseType::SqlServer),
            driver_profile: None,
            target: DatabasePropertyTarget::Database,
            name: "master".to_string(),
            charset: Some("utf8mb4".to_string()),
            collation: None,
            comment: None,
        })
        .unwrap_err()
        .contains("charset/collation is not supported"));
        assert!(build_update_database_properties_sql(DatabasePropertyEditSqlOptions {
            database_type: Some(DatabaseType::Mysql),
            driver_profile: None,
            target: DatabasePropertyTarget::Database,
            name: "app".to_string(),
            charset: None,
            collation: None,
            comment: Some("comment".to_string()),
        })
        .unwrap_err()
        .contains("database comments is not supported"));
        assert!(build_update_database_properties_sql(DatabasePropertyEditSqlOptions {
            database_type: Some(DatabaseType::DuckDb),
            driver_profile: None,
            target: DatabasePropertyTarget::Schema,
            name: "main".to_string(),
            charset: None,
            collation: None,
            comment: Some("comment".to_string()),
        })
        .unwrap_err()
        .contains("schema comments is not supported"));
    }

    #[test]
    fn recognizes_mysql_compatible_create_database_profiles() {
        assert!(supports_create_database_charset(Some(DatabaseType::Mysql), Some("oceanbase")));
        assert!(supports_create_database_charset(Some(DatabaseType::Mysql), Some("doris")));
        assert!(supports_create_database_charset(Some(DatabaseType::Goldendb), Some("goldendb")));
        assert!(!supports_create_database_charset(Some(DatabaseType::Postgres), None));
    }

    #[cfg(feature = "duckdb-bundled")]
    #[test]
    fn builds_duckdb_attach_sql() {
        assert_eq!(
            build_duckdb_attach_database_sql(DuckDbAttachDatabaseSqlOptions {
                path: "/Users/me/O'Reilly analytics.duckdb".to_string(),
                name: "report db".to_string(),
            }),
            "ATTACH '/Users/me/O''Reilly analytics.duckdb' AS \"report db\";"
        );
    }

    #[test]
    fn builds_dameng_create_user_sql_with_escaped_values() {
        assert_eq!(
            build_create_user_sql("app\"user", "pa'ss", "main\"space"),
            "CREATE USER \"app\"\"user\" IDENTIFIED BY 'pa''ss' DEFAULT TABLESPACE \"main\"\"space\";"
        );
    }

    #[test]
    fn builds_drop_and_clear_table_sql() {
        let options = TableAdminSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            table_name: "events".to_string(),
            cascade: None,
        };
        assert_eq!(build_drop_table_sql(options.clone()), "DROP TABLE \"public\".\"events\";");
        assert_eq!(
            build_drop_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                schema: Some("public".to_string()),
                table_name: "events".to_string(),
                cascade: Some(true),
            }),
            "DROP TABLE \"public\".\"events\" CASCADE;"
        );
        assert_eq!(
            build_drop_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                schema: None,
                table_name: "events".to_string(),
                cascade: Some(true),
            }),
            "DROP TABLE `events`;"
        );
        assert_eq!(build_empty_table_sql(options.clone()), "DELETE FROM \"public\".\"events\";");
        assert_eq!(build_truncate_table_sql(options.clone()), "TRUNCATE TABLE \"public\".\"events\";");
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                schema: Some("public".to_string()),
                table_name: "events".to_string(),
                cascade: Some(true),
            }),
            "TRUNCATE TABLE \"public\".\"events\" CASCADE;"
        );
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                schema: None,
                table_name: "events".to_string(),
                cascade: Some(true),
            }),
            "TRUNCATE TABLE `events`;"
        );
        assert_eq!(
            build_empty_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::ClickHouse),
                schema: None,
                table_name: "PresetSubjectInfo".to_string(),
                cascade: None,
            }),
            "ALTER TABLE `PresetSubjectInfo` DELETE WHERE 1 = 1;"
        );
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::ClickHouse),
                schema: None,
                table_name: "PresetSubjectInfo".to_string(),
                cascade: None,
            }),
            "TRUNCATE TABLE `PresetSubjectInfo`;"
        );
        assert_eq!(
            build_empty_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Bigquery),
                schema: None,
                table_name: "events".to_string(),
                cascade: None,
            }),
            "DELETE FROM `events` WHERE TRUE;"
        );
        assert_eq!(
            build_empty_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Cassandra),
                schema: None,
                table_name: "events".to_string(),
                cascade: None,
            }),
            "TRUNCATE TABLE \"events\";"
        );
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::DuckDb),
                schema: None,
                table_name: "events".to_string(),
                cascade: None,
            }),
            "DELETE FROM \"events\";"
        );
        assert_eq!(
            build_drop_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Iotdb),
                schema: Some("root.test".to_string()),
                table_name: "DCU_101".to_string(),
                cascade: None,
            }),
            "DELETE TIMESERIES root.test.DCU_101.*;"
        );
        assert_eq!(
            build_empty_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Iotdb),
                schema: Some("root.test".to_string()),
                table_name: "root.test.DCU_101".to_string(),
                cascade: None,
            }),
            "DELETE FROM root.test.DCU_101.*;"
        );
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Iotdb),
                schema: Some("root.test".to_string()),
                table_name: "DCU_101".to_string(),
                cascade: None,
            }),
            "DELETE FROM root.test.DCU_101.*;"
        );

        assert_eq!(
            build_empty_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Questdb),
                schema: None,
                table_name: "table_sample".to_string(),
                cascade: None,
            }),
            "TRUNCATE TABLE `table_sample`;"
        );
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Questdb),
                schema: None,
                table_name: "table_sample".to_string(),
                cascade: None,
            }),
            "TRUNCATE TABLE `table_sample`;"
        );
    }

    #[test]
    fn builds_drop_object_database_and_schema_sql() {
        assert_eq!(
            build_drop_object_sql(DropObjectSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                object_type: DatabaseObjectType::Procedure,
                schema: Some("dbo".to_string()),
                name: "refresh_cache".to_string(),
                signature: None,
            }),
            "DROP PROCEDURE [dbo].[refresh_cache];"
        );
        assert_eq!(
            build_drop_object_sql(DropObjectSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                object_type: DatabaseObjectType::Function,
                schema: Some("public".to_string()),
                name: "calc".to_string(),
                signature: Some("integer, integer".to_string()),
            }),
            "DROP FUNCTION \"public\".\"calc\"(integer, integer);"
        );
        assert_eq!(
            build_drop_database_sql(DatabaseNameSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                name: "app db".to_string(),
            }),
            "DROP DATABASE `app db`;"
        );
        assert_eq!(
            build_create_schema_sql(SchemaNameSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                name: "analytics".to_string(),
            })
            .unwrap(),
            "CREATE SCHEMA \"analytics\";"
        );
        assert_eq!(
            build_create_schema_sql(SchemaNameSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                name: "analytics".to_string(),
            })
            .unwrap(),
            "CREATE SCHEMA [analytics];"
        );
        assert_eq!(
            build_create_schema_sql(SchemaNameSqlOptions {
                database_type: Some(DatabaseType::Dameng),
                name: "analytics".to_string(),
            })
            .unwrap(),
            "CREATE SCHEMA \"analytics\";"
        );
        assert_eq!(
            build_create_schema_sql(SchemaNameSqlOptions {
                database_type: Some(DatabaseType::Db2),
                name: "analytics".to_string(),
            })
            .unwrap(),
            "CREATE SCHEMA \"analytics\";"
        );
        assert!(build_create_schema_sql(SchemaNameSqlOptions {
            database_type: Some(DatabaseType::DuckDb),
            name: "analytics".to_string(),
        })
        .unwrap_err()
        .contains("Creating schemas is not supported"));
        assert_eq!(
            build_drop_schema_sql(SchemaNameSqlOptions {
                database_type: Some(DatabaseType::Kwdb),
                name: "analytics".to_string(),
            }),
            "DROP SCHEMA \"analytics\" CASCADE;"
        );
    }

    #[test]
    fn builds_drop_table_child_object_sql() {
        assert_eq!(
            build_drop_table_child_object_sql(DropTableChildObjectSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                object_type: TableChildObjectType::Column,
                schema: Some("public".to_string()),
                table_name: "orders".to_string(),
                name: "status".to_string(),
            })
            .unwrap(),
            "ALTER TABLE \"public\".\"orders\" DROP COLUMN \"status\";"
        );
        assert_eq!(
            build_drop_table_child_object_sql(DropTableChildObjectSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                object_type: TableChildObjectType::Index,
                schema: None,
                table_name: "orders".to_string(),
                name: "idx_orders_status".to_string(),
            })
            .unwrap(),
            "DROP INDEX `idx_orders_status` ON `orders`;"
        );
        assert_eq!(
            build_drop_table_child_object_sql(DropTableChildObjectSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                object_type: TableChildObjectType::Index,
                schema: Some("public".to_string()),
                table_name: "orders".to_string(),
                name: "idx_orders_status".to_string(),
            })
            .unwrap(),
            "DROP INDEX \"public\".\"idx_orders_status\";"
        );
        assert_eq!(
            build_drop_table_child_object_sql(DropTableChildObjectSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                object_type: TableChildObjectType::ForeignKey,
                schema: None,
                table_name: "orders".to_string(),
                name: "fk_orders_user".to_string(),
            })
            .unwrap(),
            "ALTER TABLE `orders` DROP FOREIGN KEY `fk_orders_user`;"
        );
        assert_eq!(
            build_drop_table_child_object_sql(DropTableChildObjectSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                object_type: TableChildObjectType::ForeignKey,
                schema: Some("dbo".to_string()),
                table_name: "orders".to_string(),
                name: "fk_orders_user".to_string(),
            })
            .unwrap(),
            "ALTER TABLE [dbo].[orders] DROP CONSTRAINT [fk_orders_user];"
        );
        assert_eq!(
            build_drop_table_child_object_sql(DropTableChildObjectSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                object_type: TableChildObjectType::Trigger,
                schema: Some("public".to_string()),
                table_name: "orders".to_string(),
                name: "orders_audit".to_string(),
            })
            .unwrap(),
            "DROP TRIGGER \"orders_audit\" ON \"public\".\"orders\";"
        );

        assert_eq!(
            build_drop_table_child_object_sql(DropTableChildObjectSqlOptions {
                database_type: Some(DatabaseType::Questdb),
                object_type: TableChildObjectType::Column,
                schema: Some("public".to_string()),
                table_name: "orders".to_string(),
                name: "status".to_string(),
            })
            .unwrap(),
            "ALTER TABLE `orders` DROP COLUMN `status`;"
        );
    }

    #[test]
    fn builds_duplicate_table_structure_sql() {
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                schema: None,
                source_name: "users".to_string(),
                target_name: "users_copy".to_string(),
            }),
            "CREATE TABLE `users_copy` LIKE `users`;"
        );
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                schema: Some("public".to_string()),
                source_name: "users".to_string(),
                target_name: "users_copy".to_string(),
            }),
            "CREATE TABLE \"public\".\"users_copy\" (LIKE \"public\".\"users\" INCLUDING ALL);"
        );
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: Some(DatabaseType::Kwdb),
                schema: Some("public".to_string()),
                source_name: "users".to_string(),
                target_name: "users_copy".to_string(),
            }),
            "CREATE TABLE \"public\".\"users_copy\" (LIKE \"public\".\"users\" INCLUDING ALL);"
        );
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                schema: Some("dbo".to_string()),
                source_name: "users".to_string(),
                target_name: "users_copy".to_string(),
            }),
            "SELECT TOP 0 * INTO [dbo].[users_copy] FROM [dbo].[users];"
        );
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: Some(DatabaseType::Oracle),
                schema: Some("HR".to_string()),
                source_name: "USERS".to_string(),
                target_name: "USERS_COPY".to_string(),
            }),
            "CREATE TABLE \"HR\".\"USERS_COPY\" AS SELECT * FROM \"HR\".\"USERS\" WHERE 1=0"
        );
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: Some(DatabaseType::Iris),
                schema: Some("SQLUSER".to_string()),
                source_name: "tb_a".to_string(),
                target_name: "tb_a_copy".to_string(),
            }),
            "CREATE TABLE \"SQLUSER\".\"tb_a_copy\" AS SELECT * FROM \"SQLUSER\".\"tb_a\" WHERE 1=0"
        );
        assert_eq!(
            build_duplicate_table_structure_sql(DuplicateTableStructureSqlOptions {
                database_type: Some(DatabaseType::Questdb),
                schema: None,
                source_name: "users".to_string(),
                target_name: "users_copy".to_string(),
            }),
            "CREATE TABLE `users_copy` (LIKE `users`);"
        );
    }

    #[test]
    fn builds_copy_table_data_sql() {
        assert_eq!(
            build_copy_table_data_sql(CopyTableDataSqlOptions {
                database_type: Some(DatabaseType::Sqlite),
                schema: None,
                source_name: "users".to_string(),
                target_name: "users_copy".to_string(),
                columns: None,
                postgres_overriding_system_value: false,
                sqlserver_identity_insert: false,
            }),
            "INSERT INTO \"users_copy\" SELECT * FROM \"users\";"
        );
        assert_eq!(
            build_copy_table_data_sql(CopyTableDataSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                schema: None,
                source_name: "users".to_string(),
                target_name: "users_copy".to_string(),
                columns: Some(vec!["id".to_string(), "name".to_string()]),
                postgres_overriding_system_value: false,
                sqlserver_identity_insert: false,
            }),
            "INSERT INTO `users_copy` (`id`, `name`) SELECT `id`, `name` FROM `users`;"
        );
        assert_eq!(
            build_copy_table_data_sql(CopyTableDataSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                schema: Some("public".to_string()),
                source_name: "users".to_string(),
                target_name: "users_copy".to_string(),
                columns: Some(vec!["id".to_string(), "name".to_string()]),
                postgres_overriding_system_value: true,
                sqlserver_identity_insert: false,
            }),
            "INSERT INTO \"public\".\"users_copy\" (\"id\", \"name\") OVERRIDING SYSTEM VALUE SELECT \"id\", \"name\" FROM \"public\".\"users\";"
        );
        assert_eq!(
            build_copy_table_data_sql(CopyTableDataSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                schema: Some("dbo".to_string()),
                source_name: "users".to_string(),
                target_name: "users_copy".to_string(),
                columns: Some(vec!["id".to_string(), "name".to_string()]),
                postgres_overriding_system_value: false,
                sqlserver_identity_insert: true,
            }),
            "SET IDENTITY_INSERT [dbo].[users_copy] ON;\nINSERT INTO [dbo].[users_copy] ([id], [name]) SELECT [id], [name] FROM [dbo].[users];\nSET IDENTITY_INSERT [dbo].[users_copy] OFF;"
        );
    }

    #[test]
    fn builds_mysql_table_and_view_rename_sql() {
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                object_type: DatabaseObjectType::Table,
                schema: None,
                old_name: "users".to_string(),
                new_name: "app users".to_string(),
            })
            .unwrap(),
            "RENAME TABLE `users` TO `app users`;"
        );
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: Some(DatabaseType::Goldendb),
                object_type: DatabaseObjectType::View,
                schema: None,
                old_name: "active_users".to_string(),
                new_name: "enabled_users".to_string(),
            })
            .unwrap(),
            "RENAME TABLE `active_users` TO `enabled_users`;"
        );
    }

    #[test]
    fn builds_postgres_table_and_view_rename_sql() {
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                object_type: DatabaseObjectType::Table,
                schema: Some("public".to_string()),
                old_name: "orders".to_string(),
                new_name: "archived orders".to_string(),
            })
            .unwrap(),
            "ALTER TABLE \"public\".\"orders\" RENAME TO \"archived orders\";"
        );
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                object_type: DatabaseObjectType::View,
                schema: Some("public".to_string()),
                old_name: "active_users".to_string(),
                new_name: "enabled_users".to_string(),
            })
            .unwrap(),
            "ALTER VIEW \"public\".\"active_users\" RENAME TO \"enabled_users\";"
        );
    }

    #[test]
    fn builds_sqlserver_routine_rename_sql() {
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                object_type: DatabaseObjectType::Function,
                schema: Some("dbo".to_string()),
                old_name: "fn_total".to_string(),
                new_name: "fn_order_total".to_string(),
            })
            .unwrap(),
            "EXEC sp_rename N'dbo.fn_total', N'fn_order_total', N'OBJECT';"
        );
        assert!(supports_object_rename(Some(DatabaseType::SqlServer), DatabaseObjectType::Procedure));
    }

    #[test]
    fn builds_oracle_family_table_and_view_rename_sql() {
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: Some(DatabaseType::Oracle),
                object_type: DatabaseObjectType::Table,
                schema: Some("HR".to_string()),
                old_name: "EMPLOYEES".to_string(),
                new_name: "STAFF".to_string(),
            })
            .unwrap(),
            "ALTER TABLE \"HR\".\"EMPLOYEES\" RENAME TO \"STAFF\";"
        );
        assert_eq!(
            build_rename_object_sql(RenameObjectSqlOptions {
                database_type: Some(DatabaseType::Dameng),
                object_type: DatabaseObjectType::View,
                schema: Some("SYSDBA".to_string()),
                old_name: "ACTIVE_USERS".to_string(),
                new_name: "ENABLED_USERS".to_string(),
            })
            .unwrap(),
            "ALTER VIEW \"SYSDBA\".\"ACTIVE_USERS\" RENAME TO \"ENABLED_USERS\";"
        );
    }

    #[test]
    fn rejects_unsupported_direct_routine_renames() {
        assert!(!supports_object_rename(Some(DatabaseType::Oracle), DatabaseObjectType::Function));
        assert!(!supports_object_rename(Some(DatabaseType::Dameng), DatabaseObjectType::Procedure));
        assert!(build_rename_object_sql(RenameObjectSqlOptions {
            database_type: Some(DatabaseType::Dameng),
            object_type: DatabaseObjectType::Procedure,
            schema: Some("SYSDBA".to_string()),
            old_name: "REFRESH_CACHE".to_string(),
            new_name: "REFRESH_CACHE_V2".to_string(),
        })
        .unwrap_err()
        .contains("Renaming PROCEDURE is not supported"));
        assert!(build_rename_object_sql(RenameObjectSqlOptions {
            database_type: Some(DatabaseType::Mysql),
            object_type: DatabaseObjectType::Procedure,
            schema: None,
            old_name: "refresh_cache".to_string(),
            new_name: "refresh_cache_v2".to_string(),
        })
        .unwrap_err()
        .contains("Renaming PROCEDURE is not supported"));
    }
}
