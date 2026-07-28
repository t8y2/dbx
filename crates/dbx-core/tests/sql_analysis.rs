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
fn extracts_in_subquery_in_a_child_scope() {
    let sql = "select u.id from users u where u.id in (select o.user_id from orders o)";
    let analysis = analyze_sql_references(sql, Some("sqlserver")).unwrap();

    let tables: Vec<_> = analysis.tables.iter().map(|table| (table.name.as_str(), table.scope_id)).collect();
    assert_eq!(tables, vec![("users", 0), ("orders", 1)]);

    let scopes: Vec<_> = analysis.scopes.iter().map(|scope| (scope.id, scope.parent_id)).collect();
    assert_eq!(scopes, vec![(0, None), (1, Some(0))]);
}

#[test]
fn sqlserver_single_cte_is_not_reported_as_a_physical_table() {
    let sql = "WITH SalesCte AS (SELECT * FROM dbo.sales) SELECT * FROM salescte";
    let analysis = analyze_sql_references(sql, Some("sqlserver")).unwrap();

    let tables: Vec<_> = analysis.tables.iter().map(|table| (table.schema.as_deref(), table.name.as_str())).collect();
    assert_eq!(tables, vec![(Some("dbo"), "sales")]);
}

#[test]
fn sqlserver_recursive_cte_can_reference_itself() {
    let sql = "WITH numbers AS (SELECT 1 AS value UNION ALL SELECT value + 1 FROM numbers WHERE value < 10) SELECT * FROM numbers";
    let analysis = analyze_sql_references(sql, Some("sqlserver")).unwrap();

    assert!(analysis.tables.is_empty());
}

#[test]
fn sqlserver_ctes_only_hide_names_after_they_are_declared() {
    let sql =
        "WITH first_cte AS (SELECT * FROM later_cte), later_cte AS (SELECT * FROM first_cte) SELECT * FROM later_cte";
    let analysis = analyze_sql_references(sql, Some("sqlserver")).unwrap();

    let tables: Vec<_> = analysis.tables.iter().map(|table| table.name.as_str()).collect();
    assert_eq!(tables, vec!["later_cte"]);
}

#[test]
fn sqlserver_qualified_table_is_not_hidden_by_same_named_cte() {
    let sql = "WITH employees AS (SELECT * FROM dbo.employees) SELECT * FROM employees";
    let analysis = analyze_sql_references(sql, Some("sqlserver")).unwrap();

    assert_eq!(analysis.tables.len(), 1);
    assert_eq!(analysis.tables[0].schema.as_deref(), Some("dbo"));
    assert_eq!(analysis.tables[0].name, "employees");
}

#[test]
fn nested_queries_inherit_and_shadow_cte_names() {
    let sql = "WITH source AS (SELECT * FROM dbo.outer_source) SELECT * FROM source WHERE EXISTS (WITH source AS (SELECT * FROM dbo.inner_source) SELECT * FROM source) AND EXISTS (SELECT * FROM source)";
    let analysis = analyze_sql_references(sql, Some("sqlserver")).unwrap();

    let tables: Vec<_> =
        analysis.tables.iter().map(|table| (table.schema.as_deref(), table.name.as_str(), table.scope_id)).collect();
    assert_eq!(tables, vec![(Some("dbo"), "outer_source", 1), (Some("dbo"), "inner_source", 3)]);

    let scopes: Vec<_> = analysis.scopes.iter().map(|scope| (scope.id, scope.parent_id)).collect();
    assert_eq!(scopes, vec![(0, None), (1, Some(0)), (2, Some(0)), (3, Some(2)), (4, Some(0))]);
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
fn sqlserver_date_functions_do_not_treat_legal_dateparts_as_columns() {
    let dateadd_and_datediff = [
        "year",
        "yy",
        "yyyy",
        "quarter",
        "qq",
        "q",
        "month",
        "mm",
        "m",
        "dayofyear",
        "dy",
        "y",
        "day",
        "dd",
        "d",
        "week",
        "wk",
        "ww",
        "weekday",
        "dw",
        "w",
        "hour",
        "hh",
        "minute",
        "mi",
        "n",
        "second",
        "ss",
        "s",
        "millisecond",
        "ms",
        "microsecond",
        "mcs",
        "nanosecond",
        "ns",
    ];
    let datediff_big = [
        "year",
        "yy",
        "yyyy",
        "quarter",
        "qq",
        "q",
        "month",
        "mm",
        "m",
        "dayofyear",
        "dy",
        "y",
        "day",
        "dd",
        "d",
        "week",
        "wk",
        "ww",
        "weekday",
        "dw",
        "w",
        "hour",
        "hh",
        "minute",
        "mi",
        "n",
        "second",
        "ss",
        "s",
        "millisecond",
        "ms",
        "microsecond",
        "mcs",
        "nanosecond",
        "ns",
    ];
    let datepart = [
        "year",
        "yy",
        "yyyy",
        "quarter",
        "qq",
        "q",
        "month",
        "mm",
        "m",
        "dayofyear",
        "dy",
        "y",
        "day",
        "dd",
        "d",
        "week",
        "wk",
        "ww",
        "weekday",
        "dw",
        "w",
        "hour",
        "hh",
        "minute",
        "mi",
        "n",
        "second",
        "ss",
        "s",
        "millisecond",
        "ms",
        "microsecond",
        "mcs",
        "nanosecond",
        "ns",
        "tzoffset",
        "tz",
        "iso_week",
        "isowk",
        "isoww",
    ];
    let datename = [
        "year",
        "yy",
        "yyyy",
        "quarter",
        "qq",
        "q",
        "month",
        "mm",
        "m",
        "dayofyear",
        "dy",
        "y",
        "day",
        "dd",
        "d",
        "week",
        "wk",
        "ww",
        "weekday",
        "dw",
        "w",
        "hour",
        "hh",
        "minute",
        "mi",
        "n",
        "second",
        "ss",
        "s",
        "millisecond",
        "ms",
        "microsecond",
        "mcs",
        "nanosecond",
        "ns",
        "tzoffset",
        "tz",
        "iso_week",
        "isowk",
        "isoww",
    ];

    for (function, dateparts) in [
        ("DATEADD", dateadd_and_datediff.as_slice()),
        ("DATEDIFF", dateadd_and_datediff.as_slice()),
        ("DATEDIFF_BIG", datediff_big.as_slice()),
        ("DATEPART", datepart.as_slice()),
        ("DATENAME", datename.as_slice()),
    ] {
        for (index, datepart) in dateparts.iter().enumerate() {
            let datepart = if index % 2 == 0 { datepart.to_ascii_uppercase() } else { datepart.to_string() };
            let sql = match function {
                "DATEADD" => format!("SELECT DATEADD({datepart}, amount, occurred_at) FROM events"),
                "DATEDIFF" | "DATEDIFF_BIG" => {
                    format!("SELECT {function}({datepart}, started_at, ended_at) FROM events")
                }
                "DATEPART" | "DATENAME" => format!("SELECT {function}({datepart}, occurred_at) FROM events"),
                _ => unreachable!(),
            };
            let analysis = analyze_sql_references(&sql, Some("sqlserver"))
                .unwrap_or_else(|error| panic!("{function}({datepart}, ...) should analyze: {error}"));
            let columns: Vec<_> = analysis.columns.iter().map(|column| column.name.as_str()).collect();
            let expected = match function {
                "DATEADD" => vec!["amount", "occurred_at"],
                "DATEDIFF" | "DATEDIFF_BIG" => vec!["started_at", "ended_at"],
                "DATEPART" | "DATENAME" => vec!["occurred_at"],
                _ => unreachable!(),
            };
            assert_eq!(columns, expected, "{function} must ignore the legal {datepart} datepart only");
        }
    }
}

#[test]
fn sqlserver_datepart_suppression_is_limited_to_unqualified_builtins() {
    let sql = "SELECT dAtEaDd(SeCoNd, amount, occurred_at), dbo.DATEADD(SECOND, amount, occurred_at), custom_fn(MONTH, occurred_at), DATEADD(datepart_column, amount, occurred_at), SECOND FROM events";
    let analysis = analyze_sql_references(sql, Some("sqlserver")).unwrap();

    let columns: Vec<_> = analysis.columns.iter().map(|column| column.name.as_str()).collect();
    assert_eq!(
        columns,
        vec![
            "amount",
            "occurred_at",
            "SECOND",
            "amount",
            "occurred_at",
            "MONTH",
            "occurred_at",
            "datepart_column",
            "amount",
            "occurred_at",
            "SECOND",
        ]
    );
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
