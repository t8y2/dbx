//! Opt-in CREATE FOREIGN TABLE regression against a disposable PostgreSQL database.
use dbx_sql_schema::table_structure_sql::{
    build_create_table_sql_with_dialect_options, CreateTableDialectOptions, TableStructureSqlOptions,
};
use serde_json::json;
use std::process::Command;

#[test]
#[ignore = "requires DBX_TEST_POSTGRES_FOREIGN_TABLE_URL and psql; creates postgres_fdw objects"]
fn creates_and_queries_postgres_foreign_table_with_comments() {
    let url = std::env::var("DBX_TEST_POSTGRES_FOREIGN_TABLE_URL").expect("explicit disposable database URL");
    let psql = std::env::var_os("DBX_TEST_PSQL").unwrap_or_else(|| "psql".into());
    let run = |sql: &str| {
        let output = Command::new(&psql)
            .args(["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "--dbname", &url, "-c", sql])
            .output()
            .expect("run psql");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    };
    let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let schema = format!("dbx_foreign_{id}");
    let server = format!("foreign server {id}");
    let db = run("SELECT current_database()");
    let port = run("SHOW port");
    let user = run("SELECT current_user");
    run(&format!(
        "CREATE EXTENSION IF NOT EXISTS postgres_fdw; CREATE SCHEMA \"{schema}\"; \
         CREATE TABLE \"{schema}\".source_table (id integer, label text); \
         INSERT INTO \"{schema}\".source_table VALUES (7, 'remote value'); \
         CREATE SERVER \"{server}\" FOREIGN DATA WRAPPER postgres_fdw \
         OPTIONS (host '127.0.0.1', port '{port}', dbname '{}'); \
         CREATE USER MAPPING FOR CURRENT_USER SERVER \"{server}\" OPTIONS (user '{}');",
        db.replace('\'', "''"),
        user.replace('\'', "''"),
    ));
    let result = std::panic::catch_unwind(|| {
        let options: TableStructureSqlOptions = serde_json::from_value(json!({
            "databaseType": "postgres", "schema": schema, "tableName": "foreign\"table",
            "tableComment": "foreign's comment",
            "columns": [
                {"id":"id", "name":"id", "dataType":"integer", "isNullable":false, "defaultValue":"7", "comment":"id's comment", "isPrimaryKey":false, "markedForDrop":false},
                {"id":"label", "name":"label", "dataType":"text", "isNullable":true, "defaultValue":"", "comment":"", "isPrimaryKey":false, "markedForDrop":false}
            ]
        })).unwrap();
        let settings: CreateTableDialectOptions = serde_json::from_value(json!({
            "postgresForeignTable": {"server": server, "options":[{"name":"schema_name", "value":schema}, {"name":"table_name", "value":"source_table"}]}
        })).unwrap();
        let generated = build_create_table_sql_with_dialect_options(options, Some("18"), settings);
        assert!(generated.warnings.is_empty(), "{:?}", generated.warnings);
        run(&generated.statements.join("\n"));
        assert_eq!(run(&format!("SELECT id, label FROM \"{schema}\".\"foreign\"\"table\"")), "7|remote value");
        let metadata = run(&format!(
            "SELECT c.relkind, obj_description(c.oid), col_description(c.oid, 1) \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = '{schema}' AND c.relname = 'foreign\"table'"
        ));
        assert_eq!(metadata, "f|foreign's comment|id's comment");
    });
    run(&format!("DROP SCHEMA \"{schema}\" CASCADE; DROP SERVER \"{server}\" CASCADE;"));
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
