use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;

/// 「在数据库中查找」的批量列信息查询：每个 schema 一条目录 SQL，
/// 一次取回该 schema 全部普通表的列名/类型/主键标记，替代逐表 getColumns 往返。
/// 行形状统一为 table_name / column_name / data_type / is_primary_key，
/// 主键来源以 LEFT JOIN 挂接——权限不足时主键标记缺失但列信息仍可用。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSearchColumnsSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub database: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSearchColumnsSql {
    pub sql: String,
}

pub fn build_database_search_columns_sql(options: DatabaseSearchColumnsSqlOptions) -> Option<DatabaseSearchColumnsSql> {
    let database_type = options.database_type?;
    let sql = match database_type {
        DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng => {
            oracle_family_columns_sql(options.schema.as_deref(), &options.database)
        }
        DatabaseType::Mysql
        | DatabaseType::Doris
        | DatabaseType::StarRocks
        | DatabaseType::ManticoreSearch
        | DatabaseType::Goldendb => mysql_family_columns_sql(options.schema.as_deref(), &options.database),
        DatabaseType::Postgres
        | DatabaseType::Kingbase
        | DatabaseType::Highgo
        | DatabaseType::Uxdb
        | DatabaseType::Gbase8c
        | DatabaseType::Vastbase
        | DatabaseType::OpenGauss
        | DatabaseType::Gaussdb
        | DatabaseType::Kwdb
        | DatabaseType::Yashandb
        | DatabaseType::Oscar
        | DatabaseType::Redshift => postgres_family_columns_sql(options.schema.as_deref()),
        DatabaseType::SqlServer => sqlserver_columns_sql(options.schema.as_deref()),
        // 其余方言（含 SQLite 本地家族）不支持批量取列，调用方逐表回退 getColumns。
        _ => return None,
    };
    Some(DatabaseSearchColumnsSql { sql })
}

fn schema_or_database<'a>(schema: Option<&'a str>, database: &'a str) -> &'a str {
    schema.filter(|value| !value.trim().is_empty()).unwrap_or(database)
}

// Oracle 家族用带引号的小写别名，否则无引号别名会被统一大写。
fn oracle_family_columns_sql(schema: Option<&str>, database: &str) -> String {
    let owner = sql_string_literal(schema_or_database(schema, database));
    format!(
        "SELECT c.TABLE_NAME AS \"table_name\", c.COLUMN_NAME AS \"column_name\", c.DATA_TYPE AS \"data_type\" \
         , CASE WHEN pc.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS \"is_primary_key\" \
         FROM ALL_TAB_COLUMNS c \
         LEFT JOIN ( \
         SELECT cc.OWNER, cc.TABLE_NAME, cc.COLUMN_NAME \
         FROM ALL_CONSTRAINTS cn \
         JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = cn.OWNER AND cc.TABLE_NAME = cn.TABLE_NAME AND cc.CONSTRAINT_NAME = cn.CONSTRAINT_NAME \
         WHERE cn.CONSTRAINT_TYPE = 'P' ) pc \
         ON pc.OWNER = c.OWNER AND pc.TABLE_NAME = c.TABLE_NAME AND pc.COLUMN_NAME = c.COLUMN_NAME \
         WHERE c.OWNER = {owner} \
         ORDER BY c.TABLE_NAME, c.COLUMN_ID"
    )
}

fn mysql_family_columns_sql(schema: Option<&str>, database: &str) -> String {
    let table_schema = sql_string_literal(schema_or_database(schema, database));
    format!(
        "SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type \
         , CASE WHEN k.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS is_primary_key \
         FROM information_schema.COLUMNS c \
         LEFT JOIN information_schema.KEY_COLUMN_USAGE k \
         ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME \
         AND k.CONSTRAINT_NAME = 'PRIMARY' \
         WHERE c.TABLE_SCHEMA = {table_schema} \
         ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"
    )
}

// PG 家族走 pg_catalog（与结构搜索同路线）：对 PG 系分支（Kingbase/OpenGauss 等）兼容性
// 优于 information_schema；data_type 取 t.typname 裸类型名，与逐表 getColumns 返回的类型
// 字符串在文本/数值列子串匹配上等价（varchar/character varying 均命中 "char"）。
fn postgres_family_columns_sql(schema: Option<&str>) -> String {
    let schema_filter = match schema.filter(|value| !value.trim().is_empty()) {
        Some(schema) => format!("n.nspname = {}", sql_string_literal(schema)),
        None => "n.nspname NOT IN ('pg_catalog', 'information_schema')".to_string(),
    };
    format!(
        "SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS data_type \
         , (pk.attnum IS NOT NULL) AS is_primary_key \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_catalog.pg_type t ON t.oid = a.atttypid \
         LEFT JOIN ( \
         SELECT i.indrelid AS relid, a2.attnum AS attnum \
         FROM pg_catalog.pg_index i \
         JOIN pg_catalog.pg_attribute a2 ON a2.attrelid = i.indrelid AND a2.attnum = ANY(i.indkey) \
         WHERE i.indisprimary ) pk ON pk.relid = c.oid AND pk.attnum = a.attnum \
         WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p') \
         AND {schema_filter} \
         ORDER BY c.relname, a.attnum"
    )
}

fn sqlserver_columns_sql(schema: Option<&str>) -> String {
    let schema_filter = match schema.filter(|value| !value.trim().is_empty()) {
        Some(schema) => format!("c.TABLE_SCHEMA = {}", sql_string_literal(schema)),
        None => "c.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')".to_string(),
    };
    format!(
        "SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type \
         , CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS is_primary_key \
         FROM INFORMATION_SCHEMA.COLUMNS c \
         LEFT JOIN ( \
         SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME \
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
         ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME \
         AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA \
         WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' ) pk \
         ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME \
         WHERE {schema_filter} \
         ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"
    )
}

fn sql_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oracle_family_uses_all_tab_columns_with_pk_join() {
        let query = build_database_search_columns_sql(DatabaseSearchColumnsSqlOptions {
            database_type: Some(DatabaseType::Dameng),
            database: "dlweb".to_string(),
            schema: Some("DLWEB".to_string()),
        })
        .unwrap();

        assert!(query.sql.contains("FROM ALL_TAB_COLUMNS c"));
        assert!(query.sql.contains("ALL_CONSTRAINTS cn"));
        assert!(query.sql.contains("cn.CONSTRAINT_TYPE = 'P'"));
        assert!(query.sql.contains("LEFT JOIN"));
        assert!(query.sql.contains("WHERE c.OWNER = 'DLWEB'"));
        // 带引号的小写别名保证 Oracle 驱动返回小写列头
        assert!(query.sql.contains("AS \"table_name\""));
        assert!(query.sql.contains("AS \"is_primary_key\""));
        assert!(query.sql.contains("ORDER BY c.TABLE_NAME, c.COLUMN_ID"));
    }

    #[test]
    fn oracle_family_falls_back_to_database_when_schema_missing() {
        let query = build_database_search_columns_sql(DatabaseSearchColumnsSqlOptions {
            database_type: Some(DatabaseType::Oracle),
            database: "APP".to_string(),
            schema: None,
        })
        .unwrap();
        assert!(query.sql.contains("WHERE c.OWNER = 'APP'"));
    }

    #[test]
    fn mysql_family_uses_information_schema_with_primary_key_usage() {
        let query = build_database_search_columns_sql(DatabaseSearchColumnsSqlOptions {
            database_type: Some(DatabaseType::Mysql),
            database: "shop".to_string(),
            schema: None,
        })
        .unwrap();

        assert!(query.sql.contains("FROM information_schema.COLUMNS c"));
        assert!(query.sql.contains("information_schema.KEY_COLUMN_USAGE k"));
        assert!(query.sql.contains("k.CONSTRAINT_NAME = 'PRIMARY'"));
        assert!(query.sql.contains("WHERE c.TABLE_SCHEMA = 'shop'"));
        // 复合主键：join 按列名对齐，多行主键列各自命中
        assert!(query.sql.contains("k.COLUMN_NAME = c.COLUMN_NAME"));
        assert!(query.sql.contains("ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"));
    }

    #[test]
    fn postgres_family_uses_pg_catalog_and_excludes_system_schemas_by_default() {
        let with_schema = build_database_search_columns_sql(DatabaseSearchColumnsSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            database: "app".to_string(),
            schema: Some("public".to_string()),
        })
        .unwrap();
        assert!(with_schema.sql.contains("pg_catalog.pg_attribute a"));
        assert!(with_schema.sql.contains("i.indisprimary"));
        assert!(with_schema.sql.contains("n.nspname = 'public'"));
        assert!(with_schema.sql.contains("c.relkind IN ('r', 'p')"));

        let without_schema = build_database_search_columns_sql(DatabaseSearchColumnsSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            database: "app".to_string(),
            schema: None,
        })
        .unwrap();
        assert!(without_schema.sql.contains("n.nspname NOT IN ('pg_catalog', 'information_schema')"));
    }

    #[test]
    fn sqlserver_excludes_system_schemas_when_schema_missing() {
        let query = build_database_search_columns_sql(DatabaseSearchColumnsSqlOptions {
            database_type: Some(DatabaseType::SqlServer),
            database: "master".to_string(),
            schema: None,
        })
        .unwrap();
        assert!(query.sql.contains("INFORMATION_SCHEMA.COLUMNS c"));
        assert!(query.sql.contains("tc.CONSTRAINT_TYPE = 'PRIMARY KEY'"));
        assert!(query.sql.contains("c.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')"));

        let with_schema = build_database_search_columns_sql(DatabaseSearchColumnsSqlOptions {
            database_type: Some(DatabaseType::SqlServer),
            database: "master".to_string(),
            schema: Some("dbo".to_string()),
        })
        .unwrap();
        assert!(with_schema.sql.contains("c.TABLE_SCHEMA = 'dbo'"));
    }

    #[test]
    fn unsupported_dialects_return_none() {
        let options = DatabaseSearchColumnsSqlOptions {
            database_type: Some(DatabaseType::Sqlite),
            database: "local".to_string(),
            schema: None,
        };
        assert_eq!(build_database_search_columns_sql(options), None);
    }
}
