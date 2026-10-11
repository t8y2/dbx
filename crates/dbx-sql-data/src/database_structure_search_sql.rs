use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStructureSearchSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_profile: Option<String>,
    pub database: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub term: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStructureSearchSql {
    pub sql: String,
}

pub fn supports_database_structure_search(database_type: Option<DatabaseType>, driver_profile: Option<&str>) -> bool {
    build_database_structure_search_sql(DatabaseStructureSearchSqlOptions {
        database_type,
        driver_profile: driver_profile.map(str::to_string),
        database: "db".to_string(),
        schema: None,
        term: "x".to_string(),
        limit: Some(1),
    })
    .is_some()
}

pub fn build_database_structure_search_sql(
    options: DatabaseStructureSearchSqlOptions,
) -> Option<DatabaseStructureSearchSql> {
    let term = clean_term(&options.term);
    if term.is_empty() {
        return None;
    }
    let limit = clamp_limit(options.limit);
    let pattern = like_pattern(&term);
    let pattern_literal = sql_string_literal(&pattern);

    let database_type = options.database_type?;
    let sql = match database_type {
        DatabaseType::Mysql
        | DatabaseType::Doris
        | DatabaseType::StarRocks
        | DatabaseType::ManticoreSearch
        | DatabaseType::Goldendb => {
            mysql_family_structure_search_sql(&options.database, options.schema.as_deref(), &pattern_literal, limit)
        }
        DatabaseType::Postgres
        | DatabaseType::Kingbase
        | DatabaseType::Highgo
        | DatabaseType::Uxdb
        | DatabaseType::Vastbase
        | DatabaseType::OpenGauss
        | DatabaseType::Gaussdb
        | DatabaseType::Kwdb
        | DatabaseType::Yashandb
        | DatabaseType::Oscar => {
            postgres_family_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit)
        }
        DatabaseType::Redshift => {
            postgres_family_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit)
        }
        DatabaseType::Sqlite | DatabaseType::Turso | DatabaseType::CloudflareD1 | DatabaseType::Rqlite => {
            sqlite_family_structure_search_sql(&pattern_literal, limit)
        }
        DatabaseType::ClickHouse => clickhouse_structure_search_sql(&options.database, &pattern_literal, limit),
        DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng => {
            oracle_family_structure_search_sql(
                database_type,
                options.schema.as_deref(),
                &options.database,
                &pattern_literal,
                limit,
            )
        }
        DatabaseType::SqlServer => sqlserver_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Tdengine => tdengine_structure_search_sql(&options.database, &pattern_literal, limit),
        DatabaseType::Db2 => db2_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Hive | DatabaseType::Spark | DatabaseType::Impala | DatabaseType::Kyuubi => {
            hive_family_structure_search_sql(&options.database, options.schema.as_deref(), &pattern_literal, limit)
        }
        DatabaseType::Snowflake => snowflake_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Gbase => gbase_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Firebird => firebird_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Informix => informix_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Cassandra => cassandra_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Iris => iris_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::SapHana => saphana_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Teradata => teradata_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Vertica => vertica_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Exasol => exasol_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Databend => databend_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Questdb => questdb_structure_search_sql(&pattern_literal, limit),
        DatabaseType::PrestoSql | DatabaseType::Trino => {
            presto_family_structure_search_sql(&options.database, options.schema.as_deref(), &pattern_literal, limit)
        }
        DatabaseType::Jdbc if driver_profile_is_mysql(options.driver_profile.as_deref()) => {
            mysql_family_structure_search_sql(&options.database, options.schema.as_deref(), &pattern_literal, limit)
        }
        DatabaseType::Jdbc if driver_profile_is_postgres(options.driver_profile.as_deref()) => {
            postgres_family_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit)
        }
        DatabaseType::Jdbc if driver_profile_is_oracle(options.driver_profile.as_deref()) => {
            oracle_family_structure_search_sql(
                DatabaseType::Oracle,
                options.schema.as_deref(),
                &options.database,
                &pattern_literal,
                limit,
            )
        }
        _ => return None,
    };

    Some(DatabaseStructureSearchSql { sql })
}

fn driver_profile_is_mysql(profile: Option<&str>) -> bool {
    let profile = profile.map(str::trim).unwrap_or("").to_ascii_lowercase();
    profile.contains("mysql")
        || profile.contains("mariadb")
        || profile.contains("doris")
        || profile.contains("selectdb")
        || profile.contains("starrocks")
        || profile.contains("gbase8a")
}

fn driver_profile_is_postgres(profile: Option<&str>) -> bool {
    let profile = profile.map(str::trim).unwrap_or("").to_ascii_lowercase();
    profile.contains("postgres") || profile.contains("kingbase") || profile.contains("opengauss")
}

fn driver_profile_is_oracle(profile: Option<&str>) -> bool {
    let profile = profile.map(str::trim).unwrap_or("").to_ascii_lowercase();
    profile.contains("oracle") || profile.contains("dameng") || profile.contains("dm")
}

fn mysql_family_structure_search_sql(
    database: &str,
    schema: Option<&str>,
    pattern_literal: &str,
    limit: usize,
) -> String {
    let schema_filter = if let Some(schema) = schema.filter(|value| !value.trim().is_empty()) {
        format!(" AND TABLE_SCHEMA = {}", sql_string_literal(schema))
    } else {
        format!(" AND TABLE_SCHEMA = {}", sql_string_literal(database))
    };
    let comment_match = format!(" OR LOWER(COLUMN_COMMENT) LIKE LOWER({}) ESCAPE '~'", pattern_literal);
    format!(
        "SELECT TABLE_SCHEMA AS object_schema, TABLE_NAME AS object_name, COLUMN_NAME AS column_name, \
         COLUMN_COMMENT AS column_comment \
         FROM information_schema.COLUMNS \
         WHERE (LOWER(COLUMN_NAME) LIKE LOWER({}) ESCAPE '~'{}) \
         {schema_filter} \
         AND TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') \
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION \
         LIMIT {limit}",
        pattern_literal, comment_match,
    )
}

fn postgres_family_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let schema_filter = if let Some(schema) = schema.filter(|value| !value.trim().is_empty()) {
        format!(" AND n.nspname = {}", sql_string_literal(schema))
    } else {
        " AND n.nspname NOT IN ('pg_catalog', 'information_schema')".to_string()
    };
    format!(
        "SELECT n.nspname AS object_schema, c.relname AS object_name, a.attname AS column_name, \
         d.description AS column_comment \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum \
         WHERE a.attnum > 0 AND NOT a.attisdropped \
         AND c.relkind IN ('r', 'v', 'm', 'f', 'p') \
         {schema_filter} \
         AND (LOWER(a.attname::text) LIKE LOWER({pattern}) ESCAPE '~' \
              OR LOWER(COALESCE(d.description, '')) LIKE LOWER({pattern}) ESCAPE '~') \
         ORDER BY n.nspname, c.relname, a.attnum \
         LIMIT {limit}",
        schema_filter = schema_filter,
        pattern = pattern_literal,
        limit = limit,
    )
}

fn sqlite_family_structure_search_sql(pattern_literal: &str, limit: usize) -> String {
    format!(
        "SELECT '' AS object_schema, m.name AS object_name, p.name AS column_name, NULL AS column_comment \
         FROM sqlite_schema AS m, pragma_table_info(m.name) AS p \
         WHERE m.type IN ('table', 'view') \
         AND m.name NOT LIKE 'sqlite_%' \
         AND LOWER(p.name) LIKE LOWER({pattern}) ESCAPE '~' \
         ORDER BY m.name, p.cid \
         LIMIT {limit}",
        pattern = pattern_literal,
        limit = limit,
    )
}

fn clickhouse_structure_search_sql(database: &str, pattern_literal: &str, limit: usize) -> String {
    format!(
        "SELECT database AS object_schema, table AS object_name, name AS column_name, comment AS column_comment \
         FROM system.columns \
         WHERE database = {db} \
         AND (lower(name) LIKE lower({pattern}) OR lower(comment) LIKE lower({pattern})) \
         ORDER BY database, table, position \
         LIMIT {limit}",
        db = sql_string_literal(database),
        pattern = pattern_literal,
        limit = limit,
    )
}

fn oracle_family_structure_search_sql(
    database_type: DatabaseType,
    schema: Option<&str>,
    database: &str,
    pattern_literal: &str,
    limit: usize,
) -> String {
    let owner = schema.filter(|value| !value.trim().is_empty()).unwrap_or(database);
    let owner_literal = sql_string_literal(owner);
    let name_expr = if database_type == DatabaseType::Dameng { "LOWER(c.COLUMN_NAME)" } else { "LOWER(c.COLUMN_NAME)" };
    let bounded = format!(
        "SELECT * FROM ( \
         SELECT c.OWNER AS object_schema, c.TABLE_NAME AS object_name, c.COLUMN_NAME AS column_name, m.COMMENTS AS column_comment \
         FROM ALL_TAB_COLUMNS c \
         LEFT JOIN ALL_COL_COMMENTS m ON c.OWNER = m.OWNER AND c.TABLE_NAME = m.TABLE_NAME AND c.COLUMN_NAME = m.COLUMN_NAME \
         WHERE c.OWNER = {owner} \
         AND ({name_expr} LIKE LOWER({pattern}) ESCAPE '~' OR LOWER(COALESCE(m.COMMENTS, '')) LIKE LOWER({pattern}) ESCAPE '~') \
         ORDER BY c.TABLE_NAME, c.COLUMN_ID) WHERE ROWNUM <= {limit}",
        owner = owner_literal,
        name_expr = name_expr,
        pattern = pattern_literal,
        limit = limit,
    );
    bounded
}

fn sqlserver_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let schema_filter = if let Some(schema) = schema.filter(|value| !value.trim().is_empty()) {
        format!(" AND c.TABLE_SCHEMA = {}", sql_string_literal(schema))
    } else {
        " AND c.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')".to_string()
    };
    format!(
        "SELECT TOP {limit} c.TABLE_SCHEMA AS object_schema, c.TABLE_NAME AS object_name, c.COLUMN_NAME AS column_name, \
         CAST(ep.value AS NVARCHAR(4000)) AS column_comment \
         FROM INFORMATION_SCHEMA.COLUMNS c \
         LEFT JOIN sys.tables t ON t.name = c.TABLE_NAME AND SCHEMA_NAME(t.schema_id) = c.TABLE_SCHEMA \
         LEFT JOIN sys.columns sc ON sc.object_id = t.object_id AND sc.name = c.COLUMN_NAME \
         LEFT JOIN sys.extended_properties ep ON ep.major_id = sc.object_id AND ep.minor_id = sc.column_id AND ep.name = 'MS_Description' \
         WHERE (LOWER(c.COLUMN_NAME) LIKE LOWER({pattern}) ESCAPE '~' \
                OR LOWER(COALESCE(CAST(ep.value AS NVARCHAR(4000)), '')) LIKE LOWER({pattern}) ESCAPE '~') \
         {schema_filter} \
         ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION",
        limit = limit,
        pattern = pattern_literal,
        schema_filter = schema_filter,
    )
}

fn tdengine_structure_search_sql(database: &str, pattern_literal: &str, limit: usize) -> String {
    format!(
        "SELECT db_name AS object_schema, table_name AS object_name, col_name AS column_name, note AS column_comment \
         FROM information_schema.ins_columns \
         WHERE db_name = {db} \
         AND (LOWER(col_name) LIKE LOWER({pattern}) ESCAPE '~' OR LOWER(COALESCE(note, '')) LIKE LOWER({pattern}) ESCAPE '~') \
         LIMIT {limit}",
        db = sql_string_literal(database),
        pattern = pattern_literal,
        limit = limit,
    )
}

fn db2_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let schema_filter = if let Some(schema) = schema.filter(|value| !value.trim().is_empty()) {
        format!(" AND c.TABSCHEMA = {}", sql_string_literal(schema))
    } else {
        String::new()
    };
    format!(
        "SELECT c.TABSCHEMA AS object_schema, c.TABNAME AS object_name, c.COLNAME AS column_name, \
         COALESCE(r.REMARKS, '') AS column_comment \
         FROM SYSCAT.COLUMNS c \
         LEFT JOIN SYSCAT.COLUMNS r ON r.TABSCHEMA = c.TABSCHEMA AND r.TABNAME = c.TABNAME AND r.COLNAME = c.COLNAME \
         WHERE (LOWER(c.COLNAME) LIKE LOWER({pattern}) ESCAPE '~' OR LOWER(COALESCE(r.REMARKS, '')) LIKE LOWER({pattern}) ESCAPE '~') \
         {schema_filter} \
         FETCH FIRST {limit} ROWS ONLY",
        pattern = pattern_literal,
        schema_filter = schema_filter,
        limit = limit,
    )
}

fn hive_family_structure_search_sql(
    database: &str,
    schema: Option<&str>,
    pattern_literal: &str,
    limit: usize,
) -> String {
    let schema_name = schema.filter(|value| !value.trim().is_empty()).unwrap_or(database);
    format!(
        "SELECT table_schema AS object_schema, table_name AS object_name, column_name AS column_name, comment AS column_comment \
         FROM information_schema.columns \
         WHERE table_schema = {schema} \
         AND (LOWER(column_name) LIKE LOWER({pattern}) ESCAPE '~' OR LOWER(COALESCE(comment, '')) LIKE LOWER({pattern}) ESCAPE '~') \
         ORDER BY table_name, ordinal_position \
         LIMIT {limit}",
        schema = sql_string_literal(schema_name),
        pattern = pattern_literal,
        limit = limit,
    )
}

fn snowflake_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let schema_filter = if let Some(schema) = schema.filter(|value| !value.trim().is_empty()) {
        format!(" AND table_schema = {}", sql_string_literal(schema))
    } else {
        String::new()
    };
    format!(
        "SELECT table_schema AS object_schema, table_name AS object_name, column_name AS column_name, comment AS column_comment \
         FROM information_schema.columns \
         WHERE (LOWER(column_name) LIKE LOWER({pattern}) ESCAPE '~' OR LOWER(COALESCE(comment, '')) LIKE LOWER({pattern}) ESCAPE '~') \
         {schema_filter} \
         ORDER BY table_schema, table_name, ordinal_position \
         LIMIT {limit}",
        pattern = pattern_literal,
        schema_filter = schema_filter,
        limit = limit,
    )
}

fn gbase_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let database = schema.filter(|value| !value.trim().is_empty()).unwrap_or("gbase");
    mysql_family_structure_search_sql(database, schema, pattern_literal, limit)
}

fn firebird_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let _ = schema;
    format!(
        "SELECT TRIM(r.RDB$OWNER_NAME) AS object_schema, TRIM(r.RDB$RELATION_NAME) AS object_name, \
         TRIM(f.RDB$FIELD_NAME) AS column_name, CAST(NULL AS VARCHAR(4000)) AS column_comment \
         FROM RDB$RELATION_FIELDS f \
         JOIN RDB$RELATIONS r ON r.RDB$RELATION_NAME = f.RDB$RELATION_NAME \
         WHERE COALESCE(r.RDB$SYSTEM_FLAG, 0) = 0 \
         AND LOWER(TRIM(f.RDB$FIELD_NAME)) LIKE LOWER({pattern}) ESCAPE '~' \
         ORDER BY object_schema, object_name \
         ROWS {limit}",
        pattern = pattern_literal,
        limit = limit,
    )
}

fn informix_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let owner_filter = if let Some(schema) = schema.filter(|value| !value.trim().is_empty()) {
        format!(" AND c.owner = {}", sql_string_literal(schema))
    } else {
        String::new()
    };
    format!(
        "SELECT c.owner AS object_schema, c.tabname AS object_name, c.colname AS column_name, c.coltype AS column_comment \
         FROM syscolumns c \
         WHERE LOWER(c.colname) LIKE LOWER({pattern}) ESCAPE '~' \
         {owner_filter} \
         ORDER BY c.owner, c.tabname, c.colno \
         FIRST {limit}",
        pattern = pattern_literal,
        owner_filter = owner_filter,
        limit = limit,
    )
}

fn cassandra_structure_search_sql(keyspace: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let keyspace_filter = if let Some(keyspace) = keyspace.filter(|value| !value.trim().is_empty()) {
        format!(" AND keyspace_name = {}", sql_string_literal(keyspace))
    } else {
        String::new()
    };
    format!(
        "SELECT keyspace_name AS object_schema, table_name AS object_name, column_name AS column_name, \
         CAST(NULL AS TEXT) AS column_comment \
         FROM system_schema.columns \
         WHERE LOWER(column_name) LIKE LOWER({pattern}) ESCAPE '~' \
         {keyspace_filter} \
         LIMIT {limit} ALLOW FILTERING",
        pattern = pattern_literal,
        keyspace_filter = keyspace_filter,
        limit = limit,
    )
}

fn iris_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    sqlserver_structure_search_sql(schema, pattern_literal, limit)
}

fn saphana_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let schema_filter = if let Some(schema) = schema.filter(|value| !value.trim().is_empty()) {
        format!(" AND SCHEMA_NAME = {}", sql_string_literal(schema))
    } else {
        String::new()
    };
    format!(
        "SELECT SCHEMA_NAME AS object_schema, TABLE_NAME AS object_name, COLUMN_NAME AS column_name, COMMENTS AS column_comment \
         FROM SYS.TABLE_COLUMNS \
         WHERE (LOWER(COLUMN_NAME) LIKE LOWER({pattern}) ESCAPE '~' OR LOWER(COALESCE(COMMENTS, '')) LIKE LOWER({pattern}) ESCAPE '~') \
         {schema_filter} \
         ORDER BY SCHEMA_NAME, TABLE_NAME, POSITION \
         LIMIT {limit}",
        pattern = pattern_literal,
        schema_filter = schema_filter,
        limit = limit,
    )
}

fn teradata_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let database_filter = if let Some(schema) = schema.filter(|value| !value.trim().is_empty()) {
        format!(" AND DatabaseName = {}", sql_string_literal(schema))
    } else {
        String::new()
    };
    format!(
        "SELECT DatabaseName AS object_schema, TableName AS object_name, ColumnName AS column_name, ColumnTitle AS column_comment \
         FROM DBC.ColumnsV \
         WHERE (LOWER(ColumnName) LIKE LOWER({pattern}) ESCAPE '~' OR LOWER(COALESCE(ColumnTitle, '')) LIKE LOWER({pattern}) ESCAPE '~') \
         {database_filter} \
         QUALIFY ROW_NUMBER() OVER (ORDER BY DatabaseName, TableName, ColumnId) <= {limit}",
        pattern = pattern_literal,
        database_filter = database_filter,
        limit = limit,
    )
}

fn vertica_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    postgres_family_structure_search_sql(schema, pattern_literal, limit)
}

fn exasol_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    snowflake_structure_search_sql(schema, pattern_literal, limit)
}

fn databend_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    snowflake_structure_search_sql(schema, pattern_literal, limit)
}

fn questdb_structure_search_sql(pattern_literal: &str, limit: usize) -> String {
    format!(
        "SELECT table_schema AS object_schema, table_name AS object_name, column_name AS column_name, \
         CAST(NULL AS VARCHAR) AS column_comment \
         FROM information_schema.columns \
         WHERE LOWER(column_name) LIKE LOWER({pattern}) ESCAPE '~' \
         ORDER BY table_name, ordinal_position \
         LIMIT {limit}",
        pattern = pattern_literal,
        limit = limit,
    )
}

fn presto_family_structure_search_sql(
    database: &str,
    schema: Option<&str>,
    pattern_literal: &str,
    limit: usize,
) -> String {
    hive_family_structure_search_sql(database, schema, pattern_literal, limit)
}

fn clean_term(term: &str) -> String {
    term.trim().to_string()
}

fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(200).clamp(1, 5000)
}

fn sql_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn like_pattern(term: &str) -> String {
    let mut pattern = String::from("%");
    for ch in clean_term(term).to_ascii_lowercase().chars() {
        if matches!(ch, '~' | '%' | '_') {
            pattern.push('~');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_structure_search_uses_information_schema() {
        let query = build_database_structure_search_sql(DatabaseStructureSearchSqlOptions {
            database_type: Some(DatabaseType::Mysql),
            driver_profile: None,
            database: "app".to_string(),
            schema: None,
            term: "email".to_string(),
            limit: Some(50),
        })
        .unwrap();
        assert!(query.sql.contains("information_schema.COLUMNS"));
        assert!(query.sql.contains("COLUMN_NAME"));
        assert!(query.sql.contains("COLUMN_COMMENT"));
        assert!(query.sql.contains("LIMIT 50"));
    }

    #[test]
    fn dameng_structure_search_uses_oracle_catalog() {
        let query = build_database_structure_search_sql(DatabaseStructureSearchSqlOptions {
            database_type: Some(DatabaseType::Dameng),
            driver_profile: None,
            database: "SYSDBA".to_string(),
            schema: Some("APP".to_string()),
            term: "user".to_string(),
            limit: Some(20),
        })
        .unwrap();
        assert!(query.sql.contains("ALL_TAB_COLUMNS"));
        assert!(query.sql.contains("ALL_COL_COMMENTS"));
        assert!(query.sql.contains("ROWNUM <= 20"));
    }

    #[test]
    fn unsupported_engine_returns_none() {
        assert_eq!(
            build_database_structure_search_sql(DatabaseStructureSearchSqlOptions {
                database_type: Some(DatabaseType::Redis),
                driver_profile: None,
                database: "0".to_string(),
                schema: None,
                term: "key".to_string(),
                limit: None,
            }),
            None
        );
    }

    #[test]
    fn supports_flag_matches_builder() {
        assert!(supports_database_structure_search(Some(DatabaseType::Mysql), None));
        assert!(!supports_database_structure_search(Some(DatabaseType::Redis), None));
    }
}
