use super::*;
use crate::models::connection::DatabaseType;

#[test]
fn transfer_identifier_policy_preserves_legacy_output() {
    assert_eq!(quote_transfer_identifier("user`events", &DatabaseType::Hive), "`user``events`");
    assert_eq!(quote_transfer_identifier("user`events", &DatabaseType::ClickHouse), "`user``events`");
    assert_eq!(quote_transfer_identifier("user`events", &DatabaseType::Doris), "`user``events`");
    assert_eq!(quote_transfer_identifier("user]events", &DatabaseType::SqlServer), "[user]]events]");
    assert_eq!(quote_transfer_identifier("user\"events", &DatabaseType::Postgres), "\"user\"\"events\"");
    assert_eq!(qualified_transfer_table("events", "warehouse", &DatabaseType::Hive), "`warehouse`.`events`");
    assert_eq!(qualified_transfer_table("events", "warehouse", &DatabaseType::Mysql), "`events`");
}

#[test]
fn quotes_identifiers_by_database_type() {
    assert_eq!(quote_table_identifier(Some(DatabaseType::Mysql), "user`name"), "`user``name`");
    assert_eq!(quote_table_identifier(Some(DatabaseType::ClickHouse), "user`name"), "`user``name`");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Doris), "user`name"), "`user``name`");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Goldendb), "user`name"), "`user``name`");
    assert_eq!(quote_table_identifier(Some(DatabaseType::StarRocks), "user`name"), "`user``name`");
    assert_eq!(quote_table_identifier(Some(DatabaseType::SqlServer), "user]name"), "[user]]name]");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Postgres), "user\"name"), "\"user\"\"name\"");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Kingbase), "cqbq_ls"), "\"cqbq_ls\"");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Kingbase), "actionlogs"), "\"actionlogs\"");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Kingbase), "order"), "\"order\"");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Kingbase), "MixedCase"), "\"MixedCase\"");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Kingbase), "order detail"), "\"order detail\"");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Informix), "users_1"), "users_1");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Jdbc), "users_1"), "users_1");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Jdbc), "user name"), "user name");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Iotdb), "root.test.device2"), "root.test.device2");
}

#[test]
fn qualifies_schema_only_for_schema_aware_databases() {
    assert_eq!(qualified_table_name(Some(DatabaseType::Postgres), Some("public"), "users"), "\"public\".\"users\"");
    assert_eq!(qualified_table_name(Some(DatabaseType::Kwdb), Some("public"), "users"), "\"public\".\"users\"");
    assert_eq!(
        qualified_table_name(Some(DatabaseType::Kingbase), Some("cqbq_ls"), "actionlogs"),
        "\"cqbq_ls\".\"actionlogs\""
    );
    assert_eq!(qualified_table_name(Some(DatabaseType::Mysql), Some("public"), "users"), "`public`.`users`");
    assert_eq!(qualified_table_name(Some(DatabaseType::Goldendb), Some("public"), "users"), "`public`.`users`");
    assert_eq!(qualified_table_name(Some(DatabaseType::StarRocks), Some("warehouse"), "users"), "`warehouse`.`users`");
    assert_eq!(qualified_table_name(Some(DatabaseType::Doris), Some("warehouse"), "users"), "`warehouse`.`users`");
    assert_eq!(qualified_table_name(Some(DatabaseType::Databend), Some("dbx_test"), "users"), "`dbx_test`.`users`");
    assert_eq!(
        qualified_table_name(Some(DatabaseType::Xugu), Some("DBX_TEST"), "PRODUCTS"),
        "\"DBX_TEST\".\"PRODUCTS\""
    );
    assert_eq!(qualified_table_name(Some(DatabaseType::Oscar), Some("SYSDBA"), "EMPLOYEE"), "\"SYSDBA\".\"EMPLOYEE\"");
    assert_eq!(qualified_table_name(Some(DatabaseType::Sqlite), Some("analytics"), "users"), "\"analytics\".\"users\"");
    assert_eq!(qualified_table_name(Some(DatabaseType::Jdbc), Some("cbsdw_dwd"), "dwd_test_df"), "dwd_test_df");
    assert_eq!(qualified_table_name(Some(DatabaseType::Iotdb), Some("root.test"), "device2"), "root.test.device2");
    assert_eq!(
        qualified_table_name(Some(DatabaseType::Iotdb), Some("root.test"), "root.test.device2"),
        "root.test.device2"
    );
    assert_eq!(
        qualified_table_name(
            Some(DatabaseType::SqlServer),
            Some("__dbx_sqlserver_linked__:ERP%5D01|Finance%20DB|dbo"),
            "Orders]2026"
        ),
        "[ERP]]01].[Finance DB].[dbo].[Orders]]2026]"
    );
}

#[test]
fn maps_table_pagination_strategy_by_database_type() {
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Mysql)), TablePaginationStrategy::LimitOffset);
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Dameng)), TablePaginationStrategy::FetchFirst);
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Db2)), TablePaginationStrategy::Db2FetchFirst);
    assert_eq!(table_pagination_strategy(Some(DatabaseType::SqlServer)), TablePaginationStrategy::SqlServerTop);
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Iris)), TablePaginationStrategy::IrisTop);
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Informix)), TablePaginationStrategy::InformixFirst);
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Firebird)), TablePaginationStrategy::FirebirdRows);
    assert_eq!(table_pagination_strategy(Some(DatabaseType::OceanbaseOracle)), TablePaginationStrategy::Rownum);
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Questdb)), TablePaginationStrategy::QuestDbLimit);
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Oracle)), TablePaginationStrategy::Rownum);
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Oscar)), TablePaginationStrategy::Rownum);
    assert_eq!(
        pagination_strategy(Some(DatabaseType::Oracle), PaginationContext::BoundedRead),
        TablePaginationStrategy::FetchFirst
    );
    assert_eq!(
        pagination_strategy(Some(DatabaseType::Oscar), PaginationContext::BoundedRead),
        TablePaginationStrategy::Rownum
    );
    assert_eq!(
        pagination_strategy(Some(DatabaseType::Oscar), PaginationContext::UserQuery),
        TablePaginationStrategy::Unbounded
    );
    assert_eq!(
        pagination_strategy(Some(DatabaseType::Oracle), PaginationContext::UserQuery),
        TablePaginationStrategy::Unbounded
    );
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Jdbc)), TablePaginationStrategy::AgentMaxRows);
    assert_eq!(table_pagination_strategy(None), TablePaginationStrategy::LimitOffset);
}

#[test]
fn builds_select_sql_with_limit_syntax_for_database_type() {
    let columns = vec!["id".to_string(), "name".to_string()];
    let keys = vec!["id".to_string()];

    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public"),
            table_name: "users",
            columns: &columns,
            order_columns: &keys,
            limit: 100,
        }),
        "SELECT \"id\", \"name\" FROM \"public\".\"users\" ORDER BY \"id\" ASC LIMIT 100;"
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::SqlServer),
            schema: Some("dbo"),
            table_name: "users",
            columns: &columns,
            order_columns: &keys,
            limit: 100,
        }),
        "SELECT TOP (100) [id], [name] FROM [dbo].[users] ORDER BY [id] ASC"
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Db2),
            schema: Some("DB2INST1"),
            table_name: "USERS",
            columns: &columns,
            order_columns: &keys,
            limit: 100,
        }),
        "SELECT \"id\", \"name\" FROM \"DB2INST1\".\"USERS\" ORDER BY \"id\" ASC FETCH FIRST 100 ROWS ONLY"
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Firebird),
            schema: None,
            table_name: "USERS",
            columns: &columns,
            order_columns: &keys,
            limit: 100,
        }),
        "SELECT \"id\", \"name\" FROM \"USERS\" ORDER BY \"id\" ASC ROWS 100"
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Oracle),
            schema: Some("DBXTEST"),
            table_name: "USERS",
            columns: &columns,
            order_columns: &keys,
            limit: 100,
        }),
        "SELECT \"id\", \"name\" FROM (SELECT \"id\", \"name\" FROM \"DBXTEST\".\"USERS\" ORDER BY \"id\" ASC) WHERE ROWNUM <= 100"
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::OceanbaseOracle),
            schema: Some("DBXTEST"),
            table_name: "USERS",
            columns: &columns,
            order_columns: &keys,
            limit: 100,
        }),
        "SELECT \"id\", \"name\" FROM (SELECT \"id\", \"name\" FROM \"DBXTEST\".\"USERS\" ORDER BY \"id\" ASC) WHERE ROWNUM <= 100"
    );
    // JDBC connections skip SQL-level row limiting — the JDBC agent handles
    // it via Statement.setMaxRows() which is universally supported.
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Jdbc),
            schema: Some("cbsdw_dwd"),
            table_name: "dwd_test_df",
            columns: &[],
            order_columns: &[],
            limit: 100,
        }),
        "SELECT * FROM dwd_test_df;"
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Databend),
            schema: Some("dbx_test"),
            table_name: "jdbc_probe",
            columns: &[],
            order_columns: &[],
            limit: 500,
        }),
        "SELECT * FROM `dbx_test`.`jdbc_probe` LIMIT 500;"
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Xugu),
            schema: Some("DBX_TEST"),
            table_name: "PRODUCTS",
            columns: &[],
            order_columns: &[],
            limit: 100,
        }),
        "SELECT * FROM \"DBX_TEST\".\"PRODUCTS\" LIMIT 100;"
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Hive),
            schema: Some("test"),
            table_name: "dws_event_analyse",
            columns: &[],
            order_columns: &[],
            limit: 100,
        }),
        "SELECT * FROM `test`.`dws_event_analyse` LIMIT 100;"
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::StarRocks),
            schema: None,
            table_name: "sales_report",
            columns: &["customer_name".to_string()],
            order_columns: &[],
            limit: 100,
        }),
        "SELECT `customer_name` FROM `sales_report` LIMIT 100;"
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Iris),
            schema: Some("Ens"),
            table_name: "AlarmResponse",
            columns: &[],
            order_columns: &[],
            limit: 100,
        }),
        "SELECT TOP 100 * FROM \"Ens\".\"AlarmResponse\""
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Iotdb),
            schema: Some("root.test"),
            table_name: "device2",
            columns: &[],
            order_columns: &[],
            limit: 100,
        }),
        "SELECT * FROM root.test.device2 LIMIT 100;"
    );
}

#[test]
fn builds_table_data_where_and_schema_queries() {
    assert_eq!(
        build_count_table_sql(Some(DatabaseType::Kingbase), Some("cqbq_ls"), "actionlogs"),
        "SELECT COUNT(*) AS row_count FROM \"cqbq_ls\".\"actionlogs\""
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Mysql),
            schema: None,
            table_name: "users".to_string(),
            table_type: None,
            primary_keys: vec!["id".to_string()],
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: Some("where status = 'active'".to_string()),
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM `users` WHERE (status = 'active') LIMIT 100;"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Goldendb),
            schema: None,
            table_name: "sys_dic".to_string(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM `sys_dic` LIMIT 100;"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            table_name: "orders".to_string(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(50),
            offset: Some(100),
            where_input: Some("WHERE amount > 10".to_string()),
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM \"public\".\"orders\" WHERE (amount > 10) LIMIT 50 OFFSET 100;"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Kingbase),
            identifier_quote: Some("`".to_string()),
            schema: Some("nacos-v3".to_string()),
            table_name: "actionlogs".to_string(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM `nacos-v3`.`actionlogs` LIMIT 100;"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Kingbase),
            identifier_quote: Some("\"".to_string()),
            schema: Some("App Schema".to_string()),
            table_name: "ANALYZE".to_string(),
            limit: Some(100),
            ..Default::default()
        }),
        "SELECT * FROM \"App Schema\".\"ANALYZE\" LIMIT 100;"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Xugu),
            schema: Some("DBX_TEST".to_string()),
            table_name: "PRODUCTS".to_string(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM \"DBX_TEST\".\"PRODUCTS\" LIMIT 100;"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::StarRocks),
            schema: None,
            table_name: "sales_report".to_string(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: vec!["customer_name".to_string(), "amount".to_string()],
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: Some("`customer_name` = 'Acme'".to_string()),
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM `sales_report` WHERE (`customer_name` = 'Acme') LIMIT 100;"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Db2),
            schema: Some("DB2INST1".to_string()),
            table_name: "ORDERS".to_string(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(50),
            offset: None,
            where_input: Some("WHERE amount > 10".to_string()),
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM \"DB2INST1\".\"ORDERS\" WHERE (amount > 10) FETCH FIRST 50 ROWS ONLY"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Firebird),
            schema: None,
            table_name: "ORDERS".to_string(),
            table_type: None,
            primary_keys: vec!["ID".to_string()],
            columns: vec!["ID".to_string(), "AMOUNT".to_string()],
            fallback_order_columns: Vec::new(),
            order_by: Some("\"ID\" ASC".to_string()),
            limit: Some(50),
            offset: Some(100),
            where_input: Some("WHERE amount > 10".to_string()),
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM \"ORDERS\" WHERE (amount > 10) ORDER BY \"ID\" ASC ROWS 101 TO 150"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Oracle),
            schema: Some("DBXTEST".to_string()),
            table_name: "ORDERS".to_string(),
            table_type: None,
            primary_keys: vec!["ID".to_string()],
            columns: vec!["ID".to_string(), "AMOUNT".to_string()],
            fallback_order_columns: Vec::new(),
            order_by: Some("\"ID\" ASC".to_string()),
            limit: Some(50),
            offset: Some(100),
            where_input: Some("WHERE amount > 10".to_string()),
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT \"ID\", \"AMOUNT\" FROM (SELECT dbx_inner.*, ROWNUM AS \"__dbx_row_num\" FROM (SELECT \"ID\", \"AMOUNT\" FROM \"DBXTEST\".\"ORDERS\" WHERE (amount > 10) ORDER BY \"ID\" ASC) dbx_inner WHERE ROWNUM <= 150) WHERE \"__dbx_row_num\" > 100"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::OceanbaseOracle),
            schema: Some("DBXTEST".to_string()),
            table_name: "ORDERS".to_string(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM (SELECT * FROM \"DBXTEST\".\"ORDERS\") WHERE ROWNUM <= 100"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::OceanbaseOracle),
            schema: Some("DBXTEST".to_string()),
            table_name: "ORDERS".to_string(),
            table_type: None,
            primary_keys: vec!["ID".to_string()],
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(50),
            offset: None,
            where_input: Some("WHERE amount > 10".to_string()),
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM (SELECT * FROM \"DBXTEST\".\"ORDERS\" WHERE (amount > 10)) WHERE ROWNUM <= 50"
    );
    assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::Db2),
                schema: Some("DB2INST1".to_string()),
                table_name: "ORDERS".to_string(),
                table_type: None,
                primary_keys: vec!["ID".to_string()],
                columns: vec!["ID".to_string(), "AMOUNT".to_string()],
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(50),
                offset: Some(100),
                where_input: Some("WHERE amount > 10".to_string()),
                include_row_id: false,
                ..Default::default()
            }),
            "SELECT \"ID\", \"AMOUNT\" FROM (SELECT dbx_t.\"ID\", dbx_t.\"AMOUNT\", ROW_NUMBER() OVER () AS \"__dbx_row_num\" FROM \"DB2INST1\".\"ORDERS\" dbx_t WHERE (amount > 10)) dbx_page WHERE \"__dbx_row_num\" > 100 AND \"__dbx_row_num\" <= 150 ORDER BY \"__dbx_row_num\""
        );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Iris),
            schema: Some("Ens".to_string()),
            table_name: "AlarmResponse".to_string(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT TOP 100 * FROM \"Ens\".\"AlarmResponse\""
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Iotdb),
            schema: Some("root.test".to_string()),
            table_name: "device2".to_string(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM root.test.device2 LIMIT 100;"
    );
}

#[test]
fn builds_informix_table_data_with_skip_first_pagination() {
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Informix),
            schema: Some("ignored".to_string()),
            table_name: "users".to_string(),
            table_type: None,
            primary_keys: vec!["id".to_string()],
            columns: vec!["id".to_string(), "name".to_string()],
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(50),
            offset: Some(100),
            where_input: Some("WHERE active = 1".to_string()),
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT SKIP 100 FIRST 50 * FROM users WHERE (active = 1)"
    );

    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Informix),
            schema: None,
            table_name: "systables",
            columns: &["tabname".to_string()],
            order_columns: &[],
            limit: 1,
        }),
        "SELECT FIRST 1 tabname FROM systables"
    );
}

#[test]
fn explicit_table_data_order_is_preserved() {
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            table_name: "country_gdp".to_string(),
            table_type: None,
            primary_keys: vec!["year".to_string()],
            columns: vec!["iso3".to_string(), "year".to_string(), "gdp_pc".to_string()],
            fallback_order_columns: Vec::new(),
            order_by: Some("\"iso3\" ASC".to_string()),
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT * FROM \"public\".\"country_gdp\" ORDER BY \"iso3\" ASC LIMIT 100;"
    );
}

#[test]
fn builds_iris_table_data_sql_with_literal_top_and_quoted_object() {
    let sql = build_table_data_select_sql(TableDataSelectSqlOptions {
        database_type: Some(DatabaseType::Iris),
        schema: Some("Ens".to_string()),
        table_name: "AlarmResponse".to_string(),
        table_type: None,
        primary_keys: vec!["ID".to_string()],
        columns: vec!["ID".to_string(), "Status".to_string()],
        fallback_order_columns: Vec::new(),
        order_by: Some("\"Status\" DESC".to_string()),
        limit: Some(25),
        offset: None,
        where_input: Some("WHERE \"Status\" = 'Open'".to_string()),
        include_row_id: false,
        ..Default::default()
    });

    assert_eq!(
        sql,
        "SELECT TOP 25 * FROM \"Ens\".\"AlarmResponse\" WHERE (\"Status\" = 'Open') ORDER BY \"Status\" DESC"
    );
    assert!(!sql.contains("?"));
    assert!(!sql.contains(":%qpar"));
    assert!(!sql.contains(" LIMIT "));
}

#[test]
fn builds_table_data_special_column_queries() {
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Tdengine),
            schema: Some("test_db".to_string()),
            table_name: "meters".to_string(),
            table_type: Some("STABLE".to_string()),
            primary_keys: Vec::new(),
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT tbname, * FROM `test_db`.`meters` LIMIT 100;"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Tdengine),
            schema: Some("test_db".to_string()),
            table_name: "meters".to_string(),
            table_type: Some("STABLE".to_string()),
            primary_keys: vec!["ts".to_string()],
            columns: vec![
                "ts".to_string(),
                "current".to_string(),
                "voltage".to_string(),
                "location".to_string(),
                "groupid".to_string(),
            ],
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT tbname, `ts` AS `ts`, `current` AS `current`, `voltage` AS `voltage`, `location` AS `location`, `groupid` AS `groupid` FROM `test_db`.`meters` LIMIT 100;"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Tdengine),
            schema: Some("test_db".to_string()),
            table_name: "d1001".to_string(),
            table_type: Some("TABLE".to_string()),
            primary_keys: vec!["ts".to_string()],
            columns: vec!["ts".to_string(), "current".to_string()],
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT `ts` AS `ts`, `current` AS `current` FROM `test_db`.`d1001` LIMIT 100;"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Tdengine),
            schema: Some("test_db".to_string()),
            table_name: "d1001".to_string(),
            table_type: Some("TABLE".to_string()),
            primary_keys: vec!["ts".to_string()],
            columns: vec!["tbname".to_string(), "ts".to_string(), "current".to_string()],
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT `ts` AS `ts`, `current` AS `current` FROM `test_db`.`d1001` LIMIT 100;"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Hive),
            schema: None,
            table_name: "departments".to_string(),
            table_type: None,
            primary_keys: Vec::new(),
            columns: vec!["id".to_string(), "name".to_string()],
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT `id` AS `id`, `name` AS `name` FROM `departments` LIMIT 100;"
    );
}

#[test]
fn builds_sqlserver_table_data_pages() {
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::SqlServer),
            schema: Some("dbo".to_string()),
            table_name: "accounts".to_string(),
            table_type: None,
            primary_keys: vec!["id".to_string()],
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(25),
            offset: None,
            where_input: Some("where id = 1".to_string()),
            include_row_id: false,
            ..Default::default()
        }),
        "SELECT TOP (25) * FROM [dbo].[accounts] WHERE (id = 1)"
    );
    assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                schema: Some("sales".to_string()),
                table_name: "orders".to_string(),
                table_type: None,
                primary_keys: vec!["order_id".to_string()],
                columns: vec!["order_id".to_string(), "customer".to_string()],
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(50),
                offset: Some(100),
                where_input: None,
                include_row_id: false,
                ..Default::default()
            }),
            "WITH [dbx_page] AS (SELECT [order_id], [customer], ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS [__dbx_row_num] FROM [sales].[orders]) SELECT [order_id], [customer] FROM [dbx_page] WHERE [__dbx_row_num] > 100 AND [__dbx_row_num] <= 150 ORDER BY [__dbx_row_num]"
        );
}

#[test]
fn builds_oracle_and_neo4j_table_data_queries() {
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Oracle),
            schema: Some("DBXTEST".to_string()),
            table_name: "DBX_LOAD_TABLE_006".to_string(),
            table_type: None,
            primary_keys: vec![DBX_ROWID_COLUMN.to_string()],
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: true,
            ..Default::default()
        }),
        "SELECT * FROM (SELECT ROWIDTOCHAR(t.ROWID) AS \"__DBX_ROWID\", t.* FROM \"DBXTEST\".\"DBX_LOAD_TABLE_006\" t) WHERE ROWNUM <= 100"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Oracle),
            schema: Some("DBXTEST".to_string()),
            table_name: "DBX_LOAD_TABLE_006".to_string(),
            table_type: None,
            primary_keys: vec![DBX_ROWID_COLUMN.to_string()],
            columns: vec!["ID".to_string(), "NAME".to_string()],
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: true,
            ..Default::default()
        }),
        "SELECT \"__DBX_ROWID\", \"ID\", \"NAME\" FROM (SELECT ROWIDTOCHAR(t.ROWID) AS \"__DBX_ROWID\", t.* FROM \"DBXTEST\".\"DBX_LOAD_TABLE_006\" t) WHERE ROWNUM <= 100"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::OceanbaseOracle),
            schema: Some("APP".to_string()),
            table_name: "DATA_REPORT_SUB_TASK".to_string(),
            table_type: Some("TABLE".to_string()),
            primary_keys: vec![DBX_ROWID_COLUMN.to_string()],
            columns: vec!["ID".to_string(), "SMC_RESPONSE".to_string()],
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: true,
            ..Default::default()
        }),
        "SELECT \"__DBX_ROWID\", \"ID\", \"SMC_RESPONSE\" FROM (SELECT ROWIDTOCHAR(t.ROWID) AS \"__DBX_ROWID\", t.* FROM \"APP\".\"DATA_REPORT_SUB_TASK\" t) WHERE ROWNUM <= 100"
    );
    assert_eq!(
        build_table_data_select_sql(TableDataSelectSqlOptions {
            database_type: Some(DatabaseType::Oracle),
            schema: Some("DBXTEST".to_string()),
            table_name: "DBX_JOIN_VIEW".to_string(),
            table_type: Some("VIEW".to_string()),
            primary_keys: vec![DBX_ROWID_COLUMN.to_string()],
            columns: vec!["ID".to_string(), "NAME".to_string()],
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(100),
            offset: None,
            where_input: None,
            include_row_id: true,
            ..Default::default()
        }),
        "SELECT \"ID\", \"NAME\" FROM (SELECT \"ID\", \"NAME\" FROM \"DBXTEST\".\"DBX_JOIN_VIEW\") WHERE ROWNUM <= 100"
    );
    assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::Neo4j),
                schema: None,
                table_name: "Employee".to_string(),
                table_type: None,
                primary_keys: vec!["id".to_string()],
                columns: vec!["id".to_string(), "first name".to_string(), "role".to_string()],
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(100),
                offset: None,
                where_input: None,
                include_row_id: false,
                ..Default::default()
            }),
            "MATCH (n:`Employee`) RETURN elementId(n) AS `__DBX_ELEMENT_ID`, n.`id` AS `id`, n.`first name` AS `first name`, n.`role` AS `role` LIMIT 100;"
        );
}

#[test]
fn normalizes_where_input_with_multibyte_identifier_prefix() {
    assert_eq!(normalize_where_input(Some("`客户名称` = '示例客户'")), "`客户名称` = '示例客户'");
    assert_eq!(normalize_where_input(Some("WHERE `客户名称` = '示例客户';")), "`客户名称` = '示例客户'");
}
