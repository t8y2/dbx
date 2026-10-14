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
            oracle_family_structure_search_sql(options.schema.as_deref(), &options.database, &pattern_literal, limit)
        }
        DatabaseType::SqlServer => sqlserver_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        DatabaseType::Tdengine => tdengine_structure_search_sql(&options.database, &pattern_literal, limit),
        DatabaseType::Snowflake => snowflake_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit),
        // gbase8s is Informix-compatible (see the table_structure_sql dialects)
        // and has no information_schema; only MySQL-dialect Gbase 8a takes this path.
        DatabaseType::Gbase if !driver_profile_is_gbase8s(options.driver_profile.as_deref()) => {
            gbase_structure_search_sql(&options.database, options.schema.as_deref(), &pattern_literal, limit)
        }
        DatabaseType::Jdbc if driver_profile_is_mysql(options.driver_profile.as_deref()) => {
            mysql_family_structure_search_sql(&options.database, options.schema.as_deref(), &pattern_literal, limit)
        }
        DatabaseType::Jdbc if driver_profile_is_postgres(options.driver_profile.as_deref()) => {
            postgres_family_structure_search_sql(options.schema.as_deref(), &pattern_literal, limit)
        }
        DatabaseType::Jdbc if driver_profile_is_oracle(options.driver_profile.as_deref()) => {
            oracle_family_structure_search_sql(options.schema.as_deref(), &options.database, &pattern_literal, limit)
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

fn driver_profile_is_gbase8s(profile: Option<&str>) -> bool {
    profile.map(str::trim).is_some_and(|profile| profile.to_ascii_lowercase().contains("gbase8s"))
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
    let system_schemas = "TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')";
    // 结构搜索同时覆盖「字段名/字段注释」与「表自身注释」两类命中：
    // 字段命中来自 information_schema.COLUMNS，表注释命中单独走 information_schema.TABLES，
    // 两者用 UNION ALL 合并后统一排序与限量，表级命中行的 column_name 为 NULL。
    format!(
        "SELECT TABLE_SCHEMA AS object_schema, TABLE_NAME AS object_name, COLUMN_NAME AS column_name, \
         COLUMN_COMMENT AS column_comment, NULL AS table_comment \
         FROM information_schema.COLUMNS \
         WHERE (LOWER(COLUMN_NAME) LIKE LOWER({}) ESCAPE '~'{}) \
         {schema_filter} \
         AND {system_schemas} \
         UNION ALL \
         SELECT TABLE_SCHEMA AS object_schema, TABLE_NAME AS object_name, NULL AS column_name, \
         NULL AS column_comment, TABLE_COMMENT AS table_comment \
         FROM information_schema.TABLES \
         WHERE TABLE_TYPE = 'BASE TABLE' \
         AND LOWER(COALESCE(TABLE_COMMENT, '')) LIKE LOWER({}) ESCAPE '~' \
         {schema_filter} \
         AND {system_schemas} \
         ORDER BY object_schema, object_name, column_name \
         LIMIT {limit}",
        pattern_literal, comment_match, pattern_literal,
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
         d.description AS column_comment, NULL AS table_comment \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_description d ON d.objoid = c.oid AND d.objsubid = a.attnum \
         WHERE a.attnum > 0 AND NOT a.attisdropped \
         AND c.relkind IN ('r', 'v', 'm', 'f', 'p') \
         {schema_filter} \
         AND (LOWER(a.attname::text) LIKE LOWER({pattern}) ESCAPE '~' \
              OR LOWER(COALESCE(d.description, '')) LIKE LOWER({pattern}) ESCAPE '~') \
         UNION ALL \
         SELECT n.nspname AS object_schema, c.relname AS object_name, NULL AS column_name, \
         NULL AS column_comment, d.description AS table_comment \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN pg_catalog.pg_description d ON d.objoid = c.oid AND d.objsubid = 0 \
         WHERE c.relkind IN ('r', 'v', 'm', 'f', 'p') \
         {schema_filter} \
         AND LOWER(COALESCE(d.description, '')) LIKE LOWER({pattern}) ESCAPE '~' \
         ORDER BY object_schema, object_name, column_name \
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
    // ClickHouse 的 ORDER BY/LIMIT 只作用于最近的 SELECT，因此把 UNION 结果包一层子查询。
    // 这里用空串代替 NULL，避免 Nullable(Nothing) 参与 UNION 时的类型兼容问题。
    format!(
        "SELECT * FROM ( \
         SELECT database AS object_schema, table AS object_name, name AS column_name, \
         comment AS column_comment, '' AS table_comment \
         FROM system.columns \
         WHERE database = {db} \
         AND (lower(name) LIKE lower({pattern}) OR lower(comment) LIKE lower({pattern})) \
         UNION ALL \
         SELECT database AS object_schema, name AS object_name, '' AS column_name, \
         '' AS column_comment, comment AS table_comment \
         FROM system.tables \
         WHERE database = {db} \
         AND lower(COALESCE(comment, '')) LIKE lower({pattern}) \
         ) ORDER BY object_schema, object_name, column_name \
         LIMIT {limit}",
        db = sql_string_literal(database),
        pattern = pattern_literal,
        limit = limit,
    )
}

fn oracle_family_structure_search_sql(
    schema: Option<&str>,
    database: &str,
    pattern_literal: &str,
    limit: usize,
) -> String {
    let owner = schema.filter(|value| !value.trim().is_empty()).unwrap_or(database);
    let owner_literal = sql_string_literal(owner);
    let name_expr = "LOWER(c.COLUMN_NAME)";
    let bounded = format!(
        "SELECT * FROM ( \
         SELECT c.OWNER AS object_schema, c.TABLE_NAME AS object_name, c.COLUMN_NAME AS column_name, m.COMMENTS AS column_comment \
         , CAST(NULL AS VARCHAR2(4000)) AS table_comment \
         FROM ALL_TAB_COLUMNS c \
         LEFT JOIN ALL_COL_COMMENTS m ON c.OWNER = m.OWNER AND c.TABLE_NAME = m.TABLE_NAME AND c.COLUMN_NAME = m.COLUMN_NAME \
         WHERE c.OWNER = {owner} \
         AND ({name_expr} LIKE LOWER({pattern}) ESCAPE '~' OR LOWER(COALESCE(m.COMMENTS, '')) LIKE LOWER({pattern}) ESCAPE '~') \
         UNION ALL \
         SELECT t.OWNER AS object_schema, t.TABLE_NAME AS object_name, CAST(NULL AS VARCHAR2(128)) AS column_name \
         , CAST(NULL AS VARCHAR2(4000)) AS column_comment, t.COMMENTS AS table_comment \
         FROM ALL_TAB_COMMENTS t \
         WHERE t.OWNER = {owner} \
         AND LOWER(COALESCE(t.COMMENTS, '')) LIKE LOWER({pattern}) ESCAPE '~' \
         ORDER BY object_schema, object_name, column_name) WHERE ROWNUM <= {limit}",
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
    // SQL Server 的 TOP 不能作用在 UNION 的单个分支上，因此先合并再对结果集取 TOP。
    let sys_schema_filter = if let Some(schema) = schema.filter(|value| !value.trim().is_empty()) {
        format!(" AND s.name = {}", sql_string_literal(schema))
    } else {
        " AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA')".to_string()
    };
    format!(
        "SELECT TOP {limit} * FROM ( \
         SELECT c.TABLE_SCHEMA AS object_schema, c.TABLE_NAME AS object_name, c.COLUMN_NAME AS column_name, \
         CAST(ep.value AS NVARCHAR(4000)) AS column_comment, CAST(NULL AS NVARCHAR(4000)) AS table_comment \
         FROM INFORMATION_SCHEMA.COLUMNS c \
         LEFT JOIN sys.tables t ON t.name = c.TABLE_NAME AND SCHEMA_NAME(t.schema_id) = c.TABLE_SCHEMA \
         LEFT JOIN sys.columns sc ON sc.object_id = t.object_id AND sc.name = c.COLUMN_NAME \
         LEFT JOIN sys.extended_properties ep ON ep.major_id = sc.object_id AND ep.minor_id = sc.column_id AND ep.name = 'MS_Description' \
         WHERE (LOWER(c.COLUMN_NAME) LIKE LOWER({pattern}) ESCAPE '~' \
                OR LOWER(COALESCE(CAST(ep.value AS NVARCHAR(4000)), '')) LIKE LOWER({pattern}) ESCAPE '~') \
         {schema_filter} \
         UNION ALL \
         SELECT s.name AS object_schema, o.name AS object_name, CAST(NULL AS NVARCHAR(128)) AS column_name, \
         CAST(NULL AS NVARCHAR(4000)) AS column_comment, CAST(tep.value AS NVARCHAR(4000)) AS table_comment \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         JOIN sys.extended_properties tep ON tep.major_id = o.object_id AND tep.minor_id = 0 AND tep.name = 'MS_Description' \
         WHERE o.type IN ('U', 'V') \
         {sys_schema_filter} \
         AND LOWER(COALESCE(CAST(tep.value AS NVARCHAR(4000)), '')) LIKE LOWER({pattern}) ESCAPE '~' \
         ) AS r ORDER BY r.object_schema, r.object_name, r.column_name",
        limit = limit,
        pattern = pattern_literal,
        schema_filter = schema_filter,
        sys_schema_filter = sys_schema_filter,
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

fn snowflake_structure_search_sql(schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let schema_filter = if let Some(schema) = schema.filter(|value| !value.trim().is_empty()) {
        format!(" AND table_schema = {}", sql_string_literal(schema))
    } else {
        String::new()
    };
    format!(
        "SELECT table_schema AS object_schema, table_name AS object_name, column_name AS column_name, \
         comment AS column_comment, NULL AS table_comment \
         FROM information_schema.columns \
         WHERE (LOWER(column_name) LIKE LOWER({pattern}) ESCAPE '~' OR LOWER(COALESCE(comment, '')) LIKE LOWER({pattern}) ESCAPE '~') \
         {schema_filter} \
         UNION ALL \
         SELECT table_schema AS object_schema, table_name AS object_name, NULL AS column_name, \
         NULL AS column_comment, comment AS table_comment \
         FROM information_schema.tables \
         WHERE LOWER(COALESCE(comment, '')) LIKE LOWER({pattern}) ESCAPE '~' \
         {schema_filter} \
         ORDER BY object_schema, object_name, column_name \
         LIMIT {limit}",
        pattern = pattern_literal,
        schema_filter = schema_filter,
        limit = limit,
    )
}

fn gbase_structure_search_sql(database: &str, schema: Option<&str>, pattern_literal: &str, limit: usize) -> String {
    let database = if database.trim().is_empty() { "gbase" } else { database };
    mysql_family_structure_search_sql(database, schema, pattern_literal, limit)
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

    #[test]
    fn dropped_engines_return_none() {
        for database_type in [
            DatabaseType::Cassandra,
            DatabaseType::Informix,
            DatabaseType::Iris,
            DatabaseType::Hive,
            DatabaseType::Spark,
            DatabaseType::Impala,
            DatabaseType::Kyuubi,
            DatabaseType::Exasol,
            DatabaseType::Vertica,
            DatabaseType::Db2,
            DatabaseType::Firebird,
            DatabaseType::SapHana,
            DatabaseType::Teradata,
            DatabaseType::Databend,
            DatabaseType::Questdb,
            DatabaseType::PrestoSql,
            DatabaseType::Trino,
        ] {
            assert_eq!(
                build_database_structure_search_sql(DatabaseStructureSearchSqlOptions {
                    database_type: Some(database_type),
                    driver_profile: None,
                    database: "app".to_string(),
                    schema: None,
                    term: "col".to_string(),
                    limit: Some(10),
                }),
                None,
                "expected no SQL for {:?}",
                database_type
            );
            assert!(
                !supports_database_structure_search(Some(database_type), None),
                "supports should be false for {:?}",
                database_type
            );
        }
    }

    #[test]
    fn gbase_search_uses_the_connected_database_and_drops_gbase8s() {
        let query = build_database_structure_search_sql(DatabaseStructureSearchSqlOptions {
            database_type: Some(DatabaseType::Gbase),
            driver_profile: None,
            database: "app".to_string(),
            schema: None,
            term: "email".to_string(),
            limit: Some(10),
        })
        .unwrap();
        assert!(
            query.sql.contains("TABLE_SCHEMA = 'app'"),
            "gbase must filter by the connected database, not a fixed literal"
        );
        assert!(!query.sql.contains("'gbase'"));

        assert_eq!(
            build_database_structure_search_sql(DatabaseStructureSearchSqlOptions {
                database_type: Some(DatabaseType::Gbase),
                driver_profile: Some("gbase8s".to_string()),
                database: "app".to_string(),
                schema: None,
                term: "email".to_string(),
                limit: Some(10),
            }),
            None,
            "gbase8s is Informix-compatible and must fall back to data search"
        );
    }

    #[test]
    fn structure_search_includes_table_comment_branch() {
        // 表注释命中要与字段命中一起返回：MySQL 家族额外走 information_schema.TABLES 分支。
        let query = build_database_structure_search_sql(DatabaseStructureSearchSqlOptions {
            database_type: Some(DatabaseType::Mysql),
            driver_profile: None,
            database: "app".to_string(),
            schema: None,
            term: "order".to_string(),
            limit: Some(80),
        })
        .unwrap();
        assert!(query.sql.contains("UNION ALL"));
        assert!(query.sql.contains("information_schema.TABLES"));
        assert!(query.sql.contains("TABLE_COMMENT AS table_comment"));
        assert!(query.sql.contains("LIMIT 80"));
        // MySQL 家族的视图在 information_schema.TABLES 里的 TABLE_COMMENT 是字面量 'VIEW'，
        // 必须按 BASE TABLE 过滤，否则搜索包含 "view" 子串的词会把所有视图误报为表级命中。
        assert!(query.sql.contains("TABLE_TYPE = 'BASE TABLE'"));
    }

    #[test]
    fn sqlserver_structure_search_hoists_top_outside_union() {
        // SQL Server 的 TOP 不能作用在 UNION 的单个分支上，必须提到并集外层。
        let query = build_database_structure_search_sql(DatabaseStructureSearchSqlOptions {
            database_type: Some(DatabaseType::SqlServer),
            driver_profile: None,
            database: "app".to_string(),
            schema: None,
            term: "name".to_string(),
            limit: Some(30),
        })
        .unwrap();
        assert!(query.sql.starts_with("SELECT TOP 30 * FROM ("));
        assert!(query.sql.contains("sys.extended_properties"));
        assert!(query.sql.contains("minor_id = 0"));
    }

    #[test]
    fn structure_search_table_comment_sources_per_dialect() {
        // 关系型方言需各自提供表注释来源，缺失时不会打断字段搜索。
        let cases = [
            (DatabaseType::Postgres, "pg_description"),
            (DatabaseType::Oracle, "ALL_TAB_COMMENTS"),
            (DatabaseType::Snowflake, "information_schema.tables"),
            (DatabaseType::ClickHouse, "system.tables"),
        ];
        for (database_type, expected) in cases {
            let query = build_database_structure_search_sql(DatabaseStructureSearchSqlOptions {
                database_type: Some(database_type),
                driver_profile: None,
                database: "app".to_string(),
                schema: None,
                term: "user".to_string(),
                limit: Some(10),
            })
            .unwrap_or_else(|| panic!("expected structure search SQL for {:?}", database_type));
            assert!(
                query.sql.contains(expected),
                "expected {:?} structure search SQL to reference {}",
                database_type,
                expected
            );
        }
    }
}
