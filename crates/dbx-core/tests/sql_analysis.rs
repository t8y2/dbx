use dbx_core::sql_analysis::analyze_sql_references;

#[test]
fn extracts_tables_aliases_and_qualified_columns() {
    let analysis = analyze_sql_references("select u.missing from users u where u.id = 1", Some("postgres")).unwrap();

    assert_eq!(analysis.tables.len(), 1);
    assert_eq!(analysis.tables[0].name, "users");
    assert_eq!(analysis.tables[0].alias.as_deref(), Some("u"));

    let columns: Vec<_> =
        analysis.columns.iter().map(|column| (column.qualifier.as_deref(), column.name.as_str())).collect();
    assert_eq!(columns, vec![(Some("u"), "missing"), (Some("u"), "id")]);
}

#[test]
fn extracts_nested_query_scopes_for_correlated_subqueries() {
    let sql = "select aa.house_id from mds_base_house aa where exists (select 1 from mds_base_owner where HOUSE_ID = aa.HOUSE_ID)";
    let analysis = analyze_sql_references(sql, Some("mysql")).unwrap();

    let tables: Vec<_> =
        analysis.tables.iter().map(|table| (table.name.as_str(), table.alias.as_deref(), table.scope_id)).collect();
    assert_eq!(tables, vec![("mds_base_house", Some("aa"), 0), ("mds_base_owner", None, 1)]);

    let scopes: Vec<_> = analysis.scopes.iter().map(|scope| (scope.id, scope.parent_id)).collect();
    assert_eq!(scopes, vec![(0, None), (1, Some(0))]);

    let columns: Vec<_> = analysis
        .columns
        .iter()
        .map(|column| (column.qualifier.as_deref(), column.name.as_str(), column.scope_id))
        .collect();
    assert_eq!(columns, vec![(Some("aa"), "house_id", 0), (None, "HOUSE_ID", 1), (Some("aa"), "HOUSE_ID", 1)]);
}

#[test]
fn extracts_unqualified_columns_from_single_table_select() {
    let analysis = analyze_sql_references("select missing, id from users", Some("postgres")).unwrap();

    let columns: Vec<_> =
        analysis.columns.iter().map(|column| (column.qualifier.as_deref(), column.name.as_str())).collect();
    assert_eq!(columns, vec![(None, "missing"), (None, "id")]);
}

#[test]
fn extracts_mysql_quoted_table_references() {
    let analysis = analyze_sql_references("SELECT * FROM `t_19991` LIMIT 100", Some("mysql")).unwrap();

    assert_eq!(analysis.tables.len(), 1);
    assert_eq!(analysis.tables[0].name, "t_19991");
    assert_eq!(analysis.tables[0].schema, None);
    assert_eq!(analysis.tables[0].span.start_line, 1);
    assert_eq!(analysis.tables[0].span.start_column, 15);
    assert_eq!(analysis.tables[0].span.end_line, 1);
    assert_eq!(analysis.tables[0].span.end_column, 24);
}

#[test]
fn extracts_mysql_qualified_backtick_table_references() {
    let analysis = analyze_sql_references("SELECT * FROM `core`.`products` LIMIT 100;", Some("mysql")).unwrap();

    assert_eq!(analysis.tables.len(), 1);
    assert_eq!(analysis.tables[0].schema.as_deref(), Some("core"));
    assert_eq!(analysis.tables[0].name, "products");
}

#[test]
fn extracts_mysql_single_quoted_table_references() {
    let analysis = analyze_sql_references("SELECT * FROM 't_10001' LIMIT 100", Some("mysql")).unwrap();

    assert_eq!(analysis.tables.len(), 1);
    assert_eq!(analysis.tables[0].name, "t_10001");
    assert_eq!(analysis.tables[0].schema, None);
}

#[test]
fn postgres_default_privileges_statements_do_not_raise_syntax_errors() {
    let sql = "\
ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLES TO app_user;";

    let analysis = analyze_sql_references(sql, Some("postgres"))
        .unwrap_or_else(|error| panic!("PostgreSQL ALTER DEFAULT PRIVILEGES should analyze: {error}"));

    assert!(analysis.tables.is_empty());
    assert!(analysis.columns.is_empty());
}

#[test]
fn extracts_unqualified_order_by_columns_for_sqlserver_queries() {
    let analysis =
        analyze_sql_references("SELECT * FROM Evt_GCM_Qop_Info ORDER BY PDReceiveDatePartInfo DESC", Some("sqlserver"))
            .unwrap();

    assert_eq!(analysis.tables.len(), 1);
    assert_eq!(analysis.tables[0].name, "Evt_GCM_Qop_Info");

    let columns: Vec<_> =
        analysis.columns.iter().map(|column| (column.qualifier.as_deref(), column.name.as_str())).collect();
    assert_eq!(columns, vec![(None, "PDReceiveDatePartInfo")]);
}

#[test]
fn sqlserver_create_proc_and_procedure_are_equivalent() {
    for sql in ["CREATE PROC test\nAS\n", "CREATE PROCEDURE test\nAS\n", "CREATE PROC test AS SELECT 1;"] {
        let analysis = analyze_sql_references(sql, Some("sqlserver"))
            .unwrap_or_else(|error| panic!("SQL Server procedure declaration should analyze: {error}"));
        assert!(analysis.tables.is_empty());
        assert!(analysis.columns.is_empty());
    }
}

#[test]
fn sqlserver_create_or_alter_proc_is_supported() {
    analyze_sql_references("CREATE OR ALTER PROC test AS SELECT 1;", Some("sqlserver"))
        .unwrap_or_else(|error| panic!("SQL Server CREATE OR ALTER PROC should analyze: {error}"));
}

#[test]
fn create_proc_remains_invalid_outside_sqlserver() {
    let error = analyze_sql_references("CREATE PROC test AS SELECT 1", Some("postgres"))
        .expect_err("PostgreSQL must not inherit SQL Server's PROC synonym");

    assert!(error.contains("an object type after CREATE"));
}

#[test]
fn sqlserver_proc_identifiers_remain_identifiers_outside_create() {
    let analysis = analyze_sql_references("SELECT proc FROM jobs", Some("sqlserver")).unwrap();

    assert_eq!(analysis.tables[0].name, "jobs");
    assert_eq!(analysis.columns[0].name, "proc");
}

#[test]
fn duckdb_parser_gap_queries_do_not_raise_syntax_errors() {
    for sql in ["FROM users;", "SUMMARIZE users;", "SUMMARISE users;"] {
        let analysis = analyze_sql_references(sql, Some("duckdb")).expect("duckdb parser gap query should analyze");
        assert!(analysis.tables.is_empty());
        assert!(analysis.columns.is_empty());
    }
}

#[test]
fn clickhouse_strictness_first_left_joins_do_not_raise_syntax_errors() {
    for strictness in ["ANY", "ALL", "SEMI", "ANTI"] {
        let sql = format!("SELECT a.id FROM events a {strictness} LEFT JOIN wallets b ON a.wallet_id = b.id");
        let analysis = analyze_sql_references(&sql, Some("clickhouse"))
            .unwrap_or_else(|error| panic!("ClickHouse {strictness} LEFT JOIN should analyze: {error}"));

        let tables: Vec<_> =
            analysis.tables.iter().map(|table| (table.name.as_str(), table.alias.as_deref())).collect();
        assert_eq!(tables, vec![("events", Some("a")), ("wallets", Some("b"))]);
    }
}
