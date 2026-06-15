use crate::connection::{MysqlMode, PoolKind};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};

pub(in crate::schema) async fn list_databases(
    pool: &PoolKind,
    config: Option<&ConnectionConfig>,
) -> Result<Vec<db::DatabaseInfo>, String> {
    match pool {
        PoolKind::Mysql(p, _) if config.is_some_and(is_doris_family_config) => db::mysql::list_databases_show(p)
            .await
            .map(|databases| filter_mysql_system_databases_for_config(databases, config)),
        PoolKind::Mysql(p, mode) if *mode == MysqlMode::OceanBaseOracle => db::ob_oracle::list_databases(p).await,
        PoolKind::Mysql(p, _) => db::mysql::list_databases(p).await,
        PoolKind::Postgres(p) => db::postgres::list_databases(p).await,
        PoolKind::Sqlite(p) => db::sqlite::list_databases(p).await,
        PoolKind::Rqlite(client) => db::rqlite_driver::list_databases(client).await,
        PoolKind::Turso(client) => db::turso_driver::list_databases(client).await,
        _ => Ok(vec![]),
    }
}

pub(in crate::schema) async fn list_schemas(pool: &PoolKind) -> Result<Vec<String>, String> {
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_schemas(p).await,
        _ => Ok(vec![]),
    }
}

pub(in crate::schema) async fn list_tables(
    pool: &PoolKind,
    config: Option<&ConnectionConfig>,
    database: &str,
    schema: &str,
) -> Result<Vec<db::TableInfo>, String> {
    match pool {
        PoolKind::Mysql(p, _) if config.is_some_and(is_doris_family_config) => {
            db::mysql::list_tables_show(p, database).await
        }
        PoolKind::Mysql(p, mode) if *mode == MysqlMode::OceanBaseOracle => {
            let s = if schema.is_empty() { database } else { schema };
            db::ob_oracle::list_tables(p, s).await
        }
        PoolKind::Mysql(p, _) => {
            let db = if schema.is_empty() { database } else { schema };
            db::mysql::list_tables(p, db).await
        }
        PoolKind::Postgres(p) if config.is_some_and(is_questdb_config) => {
            db::questdb::list_tables(p, schema).await
        }
        PoolKind::Postgres(p) => db::postgres::list_tables(p, schema).await,
        PoolKind::Sqlite(p) => db::sqlite::list_tables(p, schema).await,
        PoolKind::Rqlite(client) => db::rqlite_driver::list_tables(client, schema).await,
        PoolKind::Turso(client) => db::turso_driver::list_tables(client, schema).await,
        PoolKind::MongoDb(client) => db::mongo_driver::list_collections(client, database)
            .await
            .map(|names| collection_names_to_tables(names, "COLLECTION")),
        PoolKind::Elasticsearch(client) => {
            db::elasticsearch_driver::list_indices(client).await.map(|names| collection_names_to_tables(names, "INDEX"))
        }
        _ => Ok(vec![]),
    }
}

pub(in crate::schema) async fn list_objects(
    pool: &PoolKind,
    config: Option<&ConnectionConfig>,
    database: &str,
    schema: &str,
) -> Result<Option<Vec<db::ObjectInfo>>, String> {
    match pool {
        PoolKind::Mysql(p, mode) if *mode == MysqlMode::OceanBaseOracle => {
            db::ob_oracle::list_objects(p, schema).await.map(Some)
        }
        PoolKind::Mysql(p, _) if config.is_some_and(is_manticoresearch_config) => {
            db::manticoresearch::list_objects(p, database).await.map(Some)
        }
        PoolKind::Mysql(p, _) if config.is_some_and(is_doris_family_config) => {
            db::mysql::list_table_objects_show(p, database).await.map(Some)
        }
        PoolKind::Mysql(p, _) => db::mysql::list_objects(p, database).await.map(Some),
        PoolKind::Postgres(p) if config.is_some_and(is_questdb_config) => {
            db::questdb::list_objects(p, schema).await.map(Some)
        }
        PoolKind::Postgres(p) => db::postgres::list_objects(p, schema).await.map(Some),
        _ => Ok(None),
    }
}

pub(in crate::schema) async fn list_completion_objects(
    pool: &PoolKind,
    config: Option<&ConnectionConfig>,
    database: &str,
    schema: &str,
) -> Result<Option<Vec<db::ObjectInfo>>, String> {
    match pool {
        PoolKind::Mysql(p, mode) if *mode != MysqlMode::OceanBaseOracle => {
            db::mysql::list_completion_objects(p, database).await.map(Some)
        }
        PoolKind::Mysql(p, mode) if *mode == MysqlMode::OceanBaseOracle => {
            db::ob_oracle::list_objects(p, schema).await.map(Some)
        }
        PoolKind::Postgres(p) if config.is_some_and(is_questdb_config) => {
            db::questdb::list_objects(p, schema).await.map(Some)
        }
        PoolKind::Postgres(p) => db::postgres::list_objects(p, schema).await.map(Some),
        _ => Ok(None),
    }
}

pub(in crate::schema) async fn get_columns(
    pool: &PoolKind,
    config: Option<&ConnectionConfig>,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    match pool {
        PoolKind::Mysql(p, _) if config.is_some_and(is_manticoresearch_config) => {
            let metadata_database = mysql_show_metadata_database_for_config(config, database);
            db::manticoresearch::get_columns(p, metadata_database, table).await
        }
        PoolKind::Mysql(p, _) if config.is_some_and(is_doris_family_config) => {
            let metadata_database = mysql_show_metadata_database_for_config(config, database);
            db::mysql::get_columns_show(p, metadata_database, table).await
        }
        PoolKind::Mysql(p, mode) if *mode == MysqlMode::OceanBaseOracle => {
            db::ob_oracle::get_columns(p, database, table).await
        }
        PoolKind::Mysql(p, _) => db::mysql::get_columns(p, database, table).await,
        PoolKind::Postgres(p) if config.is_some_and(is_questdb_config) => {
            db::questdb::get_columns(p, schema, table).await
        }
        PoolKind::Postgres(p) => db::postgres::get_columns(p, schema, table).await,
        PoolKind::Sqlite(p) => db::sqlite::get_columns(p, schema, table).await,
        PoolKind::Rqlite(client) => db::rqlite_driver::get_columns(client, schema, table).await,
        PoolKind::Turso(client) => db::turso_driver::get_columns(client, schema, table).await,
        PoolKind::Elasticsearch(client) => db::elasticsearch_driver::get_columns(client, table).await,
        _ => Ok(vec![]),
    }
}

pub(in crate::schema) async fn list_indexes(
    pool: &PoolKind,
    config: Option<&ConnectionConfig>,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::IndexInfo>, String> {
    match pool {
        PoolKind::Mysql(p, mode) if *mode == MysqlMode::OceanBaseOracle => {
            db::ob_oracle::list_indexes(p, schema, table).await
        }
        PoolKind::Mysql(p, _) => db::mysql::list_indexes(p, schema, table).await,
        PoolKind::Postgres(p) if config.is_some_and(is_questdb_config) => {
            db::questdb::list_indexes(p, schema, table).await
        }
        PoolKind::Postgres(p) => db::postgres::list_indexes(p, schema, table).await,
        PoolKind::Sqlite(p) => db::sqlite::list_indexes(p, schema, table).await,
        PoolKind::Rqlite(client) => db::rqlite_driver::list_indexes(client, schema, table).await,
        PoolKind::Turso(client) => db::turso_driver::list_indexes(client, schema, table).await,
        PoolKind::MongoDb(client) => db::mongo_driver::list_indexes(client, database, table).await,
        PoolKind::ClickHouse(client) => {
            db::clickhouse_driver::list_indexes(client, clickhouse_metadata_database(database, schema), table).await
        }
        _ => Ok(vec![]),
    }
}

pub(in crate::schema) async fn list_foreign_keys(
    pool: &PoolKind,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    match pool {
        PoolKind::Mysql(p, mode) if *mode == MysqlMode::OceanBaseOracle => {
            db::ob_oracle::list_foreign_keys(p, schema, table).await
        }
        PoolKind::Mysql(p, _) => db::mysql::list_foreign_keys(p, schema, table).await,
        PoolKind::Postgres(p) => db::postgres::list_foreign_keys(p, schema, table).await,
        PoolKind::Sqlite(p) => db::sqlite::list_foreign_keys(p, schema, table).await,
        PoolKind::Rqlite(client) => db::rqlite_driver::list_foreign_keys(client, schema, table).await,
        PoolKind::Turso(client) => db::turso_driver::list_foreign_keys(client, schema, table).await,
        _ => Ok(vec![]),
    }
}

pub(in crate::schema) async fn list_triggers(
    pool: &PoolKind,
    schema: &str,
    table: &str,
) -> Result<Vec<db::TriggerInfo>, String> {
    match pool {
        PoolKind::Mysql(p, mode) if *mode == MysqlMode::OceanBaseOracle => {
            db::ob_oracle::list_triggers(p, schema, table).await
        }
        PoolKind::Mysql(p, _) => db::mysql::list_triggers(p, schema, table).await,
        PoolKind::Postgres(p) => db::postgres::list_triggers(p, schema, table).await,
        PoolKind::Sqlite(p) => db::sqlite::list_triggers(p, schema, table).await,
        PoolKind::Rqlite(client) => db::rqlite_driver::list_triggers(client, schema, table).await,
        PoolKind::Turso(client) => db::turso_driver::list_triggers(client, schema, table).await,
        _ => Ok(vec![]),
    }
}

pub(in crate::schema) async fn table_ddl(
    pool: &PoolKind,
    config: Option<&ConnectionConfig>,
    schema: &str,
    table: &str,
) -> Result<String, String> {
    match pool {
        PoolKind::Mysql(p, _) => super::super::mysql_ddl(p, table).await,
        PoolKind::Postgres(p) if config.is_some_and(is_opengauss_family_config) => {
            match super::super::opengauss_table_ddl(p, schema, table).await {
                Ok(ddl) => Ok(ddl),
                Err(_) => super::super::pg_ddl(p, schema, table).await,
            }
        }
        PoolKind::Postgres(p) if config.is_some_and(is_questdb_config) => {
            match db::questdb::questdb_table_or_view_ddl(p, table).await {
                Ok(ddl) => Ok(ddl),
                Err(_) => super::super::pg_ddl(p, schema, table).await,
            }
        }
        PoolKind::Postgres(p) => super::super::pg_ddl(p, schema, table).await,
        PoolKind::Sqlite(p) => super::super::sqlite_ddl(p, table).await,
        PoolKind::Rqlite(client) => db::rqlite_driver::table_ddl(client, table).await,
        PoolKind::Turso(client) => db::turso_driver::table_ddl(client, table).await,
        _ => Err("DDL not supported for this database type".to_string()),
    }
}

pub(in crate::schema) async fn object_source(
    pool: &PoolKind,
    database: &str,
    schema: &str,
    name: &str,
    object_type: &db::ObjectSourceKind,
) -> Result<Option<String>, String> {
    match pool {
        PoolKind::Mysql(pool, _) => super::super::mysql_object_source(pool, name, object_type).await.map(Some),
        PoolKind::Postgres(pool) => {
            super::super::postgres_object_source(pool, schema, name, object_type).await.map(Some)
        }
        PoolKind::Sqlite(pool) => {
            let source = super::super::first_string_cell(
                db::sqlite::execute_query(pool, &super::super::sqlite_object_source_sql(name, object_type)).await?,
            )?;
            Ok(Some(source))
        }
        PoolKind::Rqlite(client) => {
            db::rqlite_driver::object_source(client, name, object_type).await.map(|source| Some(source.source))
        }
        PoolKind::Turso(client) => {
            db::turso_driver::object_source(client, name, object_type).await.map(|source| Some(source.source))
        }
        PoolKind::ClickHouse(client) if matches!(object_type, db::ObjectSourceKind::View) => {
            let result = db::clickhouse_driver::execute_query(
                client,
                database,
                &format!("SHOW CREATE TABLE {}", super::super::mysql_ident(name)),
            )
            .await?;
            super::super::first_string_cell(result).map(Some)
        }
        _ => Ok(None),
    }
}

fn collection_names_to_tables(names: Vec<String>, table_type: &str) -> Vec<db::TableInfo> {
    names
        .into_iter()
        .map(|name| db::TableInfo {
            name,
            table_type: table_type.to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        })
        .collect()
}

fn clickhouse_metadata_database<'a>(database: &'a str, schema: &'a str) -> &'a str {
    if database.is_empty() {
        schema
    } else {
        database
    }
}

fn is_opengauss_family_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::OpenGauss | DatabaseType::Gaussdb)
        || matches!(config.driver_profile.as_deref(), Some("opengauss" | "gaussdb"))
}

fn is_doris_family_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::ManticoreSearch)
        || matches!(config.driver_profile.as_deref(), Some("doris" | "selectdb" | "starrocks" | "manticoresearch"))
}

fn is_manticoresearch_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::ManticoreSearch)
        || matches!(config.driver_profile.as_deref(), Some("manticoresearch"))
}

fn mysql_show_metadata_database_for_config<'a>(
    config: Option<&ConnectionConfig>,
    database: &'a str,
) -> &'a str {
    if config.is_some_and(is_manticoresearch_config) {
        ""
    } else {
        database
    }
}

fn filter_mysql_system_databases_for_config(
    databases: Vec<db::DatabaseInfo>,
    config: Option<&ConnectionConfig>,
) -> Vec<db::DatabaseInfo> {
    if !config.is_some_and(is_manticoresearch_config) {
        return databases;
    }

    databases.into_iter().filter(|database| !is_mysql_system_database(&database.name)).collect()
}

fn is_mysql_system_database(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "information_schema" | "mysql" | "performance_schema" | "sys")
}

fn is_questdb_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::Questdb)
        || matches!(config.driver_profile.as_deref(), Some("questdb"))
}