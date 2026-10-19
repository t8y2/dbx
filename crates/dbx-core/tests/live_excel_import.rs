//! Ignored live tests for Excel blank/default provenance, generated columns and SQL Server identity scopes.
//! Set DBX_LIVE_EXCEL_DB_TYPE/HOST/PORT/USER/PASSWORD/DATABASE to an isolated writable endpoint.
use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::table_import::{import_table_file_core, TableImportRequest, TableImportSummary};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;

fn number(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        .expect("integer result, represented as a JSON number or a precision-preserving string")
}

struct Fixture {
    state: AppState,
    config: ConnectionConfig,
    pool_key: String,
    schema: &'static str,
    _dir: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let kind = std::env::var("DBX_LIVE_EXCEL_DB_TYPE").expect("explicit isolated database type required");
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": "live-excel-import", "name": "live Excel import", "db_type": kind,
            "host": std::env::var("DBX_LIVE_EXCEL_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            "port": std::env::var("DBX_LIVE_EXCEL_PORT").unwrap().parse::<u16>().unwrap(),
            "username": std::env::var("DBX_LIVE_EXCEL_USER").unwrap(),
            "password": std::env::var("DBX_LIVE_EXCEL_PASSWORD").unwrap(),
            "database": std::env::var("DBX_LIVE_EXCEL_DATABASE").unwrap(),
            "url_params": match kind.as_str() { "sqlserver" => "encrypt=false&trustServerCertificate=true", "postgres" => "sslmode=disable", _ => "" },
            "connect_timeout_secs": 10, "query_timeout_secs": 30, "keepalive_interval_secs": 0
        })).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let storage = dbx_core::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
        let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            dir.path().join("plugins"),
            dir.path().join("agents"),
            "test",
        );
        state.configs.write().await.insert(config.id.clone(), config.clone());
        let pool_key = state.get_or_create_pool(&config.id, config.database.as_deref()).await.unwrap();
        let schema = match config.db_type {
            DatabaseType::Postgres => "public",
            DatabaseType::SqlServer => "dbo",
            DatabaseType::Mysql => "",
            _ => panic!("unsupported live test endpoint"),
        };
        Self { state, config, pool_key, schema, _dir: dir }
    }

    fn qualified(&self, table: &str) -> String {
        if self.schema.is_empty() {
            table.into()
        } else {
            format!("{}.{table}", self.schema)
        }
    }

    async fn sql(&self, sql: &str) -> dbx_core::db::QueryResult {
        execute_sql_statement(
            &self.state,
            &self.config.id,
            self.config.database.as_deref().unwrap(),
            sql,
            Some(self.schema),
            None,
        )
        .await
        .unwrap()
    }

    async fn import(
        &self,
        file: &Path,
        table: &str,
        columns: &[&str],
        truncate: bool,
        update: bool,
        empty_as_null: bool,
    ) -> Result<TableImportSummary, String> {
        let request: TableImportRequest = serde_json::from_value(json!({
            "importId": format!("live-excel-{}", uuid::Uuid::new_v4()),
            "connectionId": self.config.id, "database": self.config.database,
            "schema": self.schema, "table": table, "filePath": file.to_string_lossy(), "sourceFormat": "excel",
            "parseOptions": { "titleRow":1, "dataStartRow":2, "emptyStringAsNull":empty_as_null },
            "mappings": columns.iter().map(|name| json!({ "sourceColumn": name, "targetColumn": name })).collect::<Vec<_>>(),
            "mode": if truncate { "truncate" } else { "append" },
            "batchSize": 1, "createTable":false,
            "conflictPolicy": if update { "updateExisting" } else { "error" }
        })).unwrap();
        import_table_file_core(
            &self.state,
            &request,
            &self.config.db_type,
            &self.pool_key,
            |_| Box::pin(async { false }),
            |_| {},
        )
        .await
    }
}

fn workbook(path: &Path, rows: &[(i64, Option<&str>)]) {
    let mut data = String::from("<row r=\"1\">");
    for (index, name) in ["id", "value", "note", "amount", "created", "derived"].iter().enumerate() {
        let column = char::from(b'A' + index as u8);
        data.push_str(&format!("<c r=\"{column}1\" t=\"inlineStr\"><is><t>{name}</t></is></c>"));
    }
    data.push_str("</row>");
    for (index, (id, value)) in rows.iter().enumerate() {
        let number = index + 2;
        data.push_str(&format!("<row r=\"{number}\"><c r=\"A{number}\"><v>{id}</v></c>"));
        if let Some(value) = value {
            let escaped = value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
            data.push_str(&format!("<c r=\"B{number}\" t=\"inlineStr\"><is><t>{escaped}</t></is></c>"));
        }
        data.push_str("</row>");
    }
    let sheet = format!("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><dimension ref=\"A1:F{}\"/><sheetData>{data}</sheetData></worksheet>", rows.len()+1);
    let entries = [
        (
            "[Content_Types].xml",
            r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        ),
        (
            "xl/workbook.xml",
            r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#,
        ),
        ("xl/worksheets/sheet1.xml", &sheet),
    ];
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    for (name, contents) in entries {
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(contents.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_EXCEL_* pointing at an isolated writable MySQL/PostgreSQL/SQL Server"]
async fn live_excel_defaults_generated_columns_and_preflight() {
    let fixture = Fixture::new().await;
    let table = format!("dbx_excel_{}", uuid::Uuid::new_v4().simple());
    let qualified = fixture.qualified(&table);
    let generated = match fixture.config.db_type {
        DatabaseType::Postgres => "derived INT GENERATED ALWAYS AS (length(value)) STORED NOT NULL",
        DatabaseType::Mysql => "derived INT GENERATED ALWAYS AS (CHAR_LENGTH(value)) STORED",
        DatabaseType::SqlServer => "derived AS LEN(value) PERSISTED",
        _ => unreachable!(),
    };
    let timestamp = if fixture.config.db_type == DatabaseType::SqlServer { "DATETIME2" } else { "TIMESTAMP" };
    fixture.sql(&format!("CREATE TABLE {qualified}(id INT PRIMARY KEY,value VARCHAR(80) NOT NULL DEFAULT 'default',note VARCHAR(80) NULL DEFAULT 'fallback',amount INT NOT NULL DEFAULT 17,created {timestamp} NOT NULL DEFAULT CURRENT_TIMESTAMP,{generated})")).await;
    let file = fixture._dir.path().join("defaults.xlsx");
    workbook(&file, &[(7, Some("")), (8, None)]);
    let columns = ["id", "value", "note", "amount", "created", "derived"];
    let summary = fixture.import(&file, &table, &columns, false, false, false).await.unwrap();
    assert_eq!(summary.rows_imported, 2);
    let rows = fixture.sql(&format!("SELECT id,value,note,amount,derived FROM {qualified} ORDER BY id")).await.rows;
    assert_eq!(rows.len(), 2);
    for (row, id, value, derived) in [(&rows[0], 7, "", 0), (&rows[1], 8, "default", 7)] {
        assert_eq!(number(&row[0]), id);
        assert_eq!(row[1], json!(value));
        assert!(row[2].is_null());
        assert_eq!(number(&row[3]), 17);
        assert_eq!(number(&row[4]), derived);
    }
    assert_eq!(
        number(&fixture.sql(&format!("SELECT COUNT(*) FROM {qualified} WHERE created IS NOT NULL")).await.rows[0][0]),
        2
    );
    let error = fixture.import(&file, &table, &columns, true, false, true).await.unwrap_err();
    assert!(error.contains("explicit NULL"), "{error}");
    assert_eq!(number(&fixture.sql(&format!("SELECT COUNT(*) FROM {qualified}")).await.rows[0][0]), 2);
    if fixture.config.db_type != DatabaseType::SqlServer {
        fixture.sql(&format!("UPDATE {qualified} SET value='old' WHERE id=8")).await;
        fixture.import(&file, &table, &columns, false, true, false).await.unwrap();
        let result = fixture.sql(&format!("SELECT value,derived FROM {qualified} WHERE id=8")).await;
        assert_eq!(result.rows[0][0], json!("default"));
        assert_eq!(number(&result.rows[0][1]), 7);
    }
    let required = format!("{table}_required");
    let required_qualified = fixture.qualified(&required);
    fixture.sql(&format!("CREATE TABLE {required_qualified}(id INT PRIMARY KEY,value VARCHAR(80) NOT NULL)")).await;
    fixture.sql(&format!("INSERT INTO {required_qualified}(id,value) VALUES(999,'keep')")).await;
    let error = fixture.import(&file, &required, &["id", "value"], true, false, false).await.unwrap_err();
    assert!(error.contains("Excel row 3") && error.contains("without a default"), "{error}");
    let preserved = fixture.sql(&format!("SELECT id,value FROM {required_qualified}")).await.rows;
    assert_eq!(preserved.len(), 1);
    assert_eq!(number(&preserved[0][0]), 999);
    assert_eq!(preserved[0][1], json!("keep"));
    fixture.sql(&format!("DROP TABLE {required_qualified}")).await;
    fixture.sql(&format!("DROP TABLE {qualified}")).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_EXCEL_* pointing at an isolated writable SQL Server"]
async fn live_excel_sqlserver_identity_and_failed_scope_cleanup() {
    let fixture = Fixture::new().await;
    assert_eq!(fixture.config.db_type, DatabaseType::SqlServer);
    let table = format!("dbx_identity_{}", uuid::Uuid::new_v4().simple());
    let qualified = fixture.qualified(&table);
    fixture
        .sql(&format!(
            "CREATE TABLE {qualified}(id INT IDENTITY(1,1) PRIMARY KEY,value VARCHAR(80) NOT NULL DEFAULT 'default')"
        ))
        .await;
    let file = fixture._dir.path().join("identity.xlsx");
    workbook(&file, &[(7, Some("provided")), (8, None)]);
    fixture.import(&file, &table, &["id", "value"], false, false, false).await.unwrap();
    let rows = fixture.sql(&format!("SELECT id,value FROM {qualified} ORDER BY id")).await.rows;
    assert_eq!(rows.len(), 2);
    assert_eq!(number(&rows[0][0]), 7);
    assert_eq!(rows[0][1], json!("provided"));
    assert_eq!(number(&rows[1][0]), 8);
    assert_eq!(rows[1][1], json!("default"));
    let session_before_error = fixture.sql("SELECT @@SPID").await.rows;
    workbook(&file, &[(7, None)]);
    assert!(fixture.import(&file, &table, &["id", "value"], false, false, false).await.is_err());
    assert_eq!(
        fixture.sql("SELECT @@SPID").await.rows,
        session_before_error,
        "failed import must clean up the same session"
    );
    fixture.sql(&format!("INSERT INTO {qualified}(value) VALUES('after-error')")).await;
    workbook(&file, &[(41, Some("bulk")), (42, Some("bulk"))]);
    fixture.import(&file, &table, &["id", "value"], false, false, false).await.unwrap();
    assert_eq!(
        number(&fixture.sql(&format!("SELECT COUNT(*) FROM {qualified} WHERE id IN(41,42)")).await.rows[0][0]),
        2
    );
    fixture.sql(&format!("INSERT INTO {qualified}(value) VALUES('after-bulk')")).await;
    fixture.sql(&format!("DROP TABLE {qualified}")).await;
}
