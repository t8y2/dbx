//! Opt-in SQL-generation round trips through the installed SAP HANA JDBC Agent.
//! Pass Agent connect parameters in DBX_TEST_SAPHANA_CONNECT_JSON, with credentials
//! supplied by the runner. DBX_TEST_SAPHANA_AGENT_JAR and DBX_TEST_SAPHANA_JAVA
//! select the Agent and its Java runtime. Creates and removes independent objects.
use dbx_sql_schema::table_structure_sql::{build_table_structure_change_sql, TableStructureSqlOptions};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Agent {
    child: Child,
    input: ChildStdin,
    responses: Receiver<Value>,
    next_id: u64,
}

impl Agent {
    fn start() -> Self {
        let jar = std::env::var("DBX_TEST_SAPHANA_AGENT_JAR").expect("DBX_TEST_SAPHANA_AGENT_JAR");
        let java = std::env::var("DBX_TEST_SAPHANA_JAVA").unwrap_or_else(|_| "java".into());
        let mut child = Command::new(java)
            .args(["-jar", &jar])
            .env_remove("DBX_TEST_SAPHANA_CONNECT_JSON")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start SAP HANA Agent");
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (sender, responses) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if sender.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        Self { child, input, responses, next_id: 0 }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let request = json!({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params});
        writeln!(self.input, "{request}").map_err(|_| format!("{method}: Agent input closed"))?;
        self.input.flush().map_err(|_| format!("{method}: Agent flush failed"))?;
        loop {
            let response = self
                .responses
                .recv_timeout(Duration::from_secs(45))
                .map_err(|_| format!("{method}: Agent response timed out or closed"))?;
            if response["id"] != self.next_id {
                continue;
            }
            if let Some(error) = response.get("error") {
                // Connection errors may contain credentials or endpoints. Report only SQL error codes.
                return Err(format!(
                    "{method}: vendorCode={}, sqlState={}",
                    error["data"]["vendorCode"], error["data"]["sqlState"]
                ));
            }
            return Ok(response["result"].clone());
        }
    }

    fn execute(&mut self, sql: &str) -> Result<Value, String> {
        self.call("execute_query", json!({"sql": sql, "maxRows": 10, "timeoutSecs": 20}))
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Fixture {
    agent: Agent,
    schema: String,
    created: Vec<(&'static str, String)>,
}

impl Fixture {
    fn create(&mut self, kind: &'static str, name: &str, sql: &str) {
        self.agent.execute(sql).expect("create isolated HANA fixture");
        self.created.push((kind, name.into()));
    }

    fn cleanup(&mut self) {
        let mut failures = Vec::new();
        for (kind, name) in self.created.drain(..).rev() {
            let reference = format!("{}.{}", identifier(&self.schema), identifier(&name));
            if let Err(error) = self.agent.execute(&format!("DROP {kind} {reference}")) {
                failures.push(error);
            }
        }
        assert!(failures.is_empty(), "fixture cleanup failed: {failures:?}");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for (kind, name) in self.created.drain(..).rev() {
            let reference = format!("{}.{}", identifier(&self.schema), identifier(&name));
            if self.agent.execute(&format!("DROP {kind} {reference}")).is_err() {
                eprintln!("Failed to remove an isolated HANA fixture");
            }
        }
    }
}

fn identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn comment_options(schema: Option<&str>, name: &str, kind: &str, old: &str, new: &str) -> TableStructureSqlOptions {
    serde_json::from_value(json!({
        "databaseType": "saphana",
        "schema": schema,
        "tableName": name,
        "tableType": kind,
        "originalTableComment": old,
        "tableComment": new
    }))
    .unwrap()
}

#[test]
#[ignore = "requires DBX_TEST_SAPHANA_CONNECT_JSON and DBX_TEST_SAPHANA_AGENT_JAR; creates temporary table/view"]
fn generated_hana_view_comments_round_trip_over_jdbc() {
    let config = std::env::var("DBX_TEST_SAPHANA_CONNECT_JSON").expect("DBX_TEST_SAPHANA_CONNECT_JSON");
    let mut params: Value = serde_json::from_str(&config).expect("valid HANA connect parameters");
    for key in
        ["database", "username", "password", "url_params", "connection_string", "jdbc_driver_class", "driver_profile"]
    {
        if params[key].is_null() {
            params[key] = json!("");
        }
    }
    if params["jdbc_driver_paths"].is_null() {
        params["jdbc_driver_paths"] = json!([]);
    }
    params["port_explicit"] = json!(true);
    let mut agent = Agent::start();
    agent.call("connect", params).expect("connect to HANA");
    let info = agent.call("connection_info", json!({})).expect("HANA version");
    println!("HANA product version: {}", info["databaseInfo"]["productVersion"]);
    let current = agent.execute("SELECT CURRENT_SCHEMA FROM DUMMY").expect("current schema");
    let schema = current["rows"][0][0].as_str().expect("schema name").to_string();
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let view = format!("DBX_VC_{suffix}_V\"quoted");
    let table = format!("DBX_VC_{suffix}_T");
    let view_ref = format!("{}.{}", identifier(&schema), identifier(&view));
    let table_ref = format!("{}.{}", identifier(&schema), identifier(&table));
    let mut fixture = Fixture { agent, schema, created: Vec::new() };
    fixture.create("TABLE", &table, &format!("CREATE COLUMN TABLE {table_ref} (\"ID\" INTEGER)"));
    fixture.create("VIEW", &view, &format!("CREATE VIEW {view_ref} AS SELECT 1 AS \"ID\" FROM DUMMY"));

    let mut legacy = comment_options(Some(&fixture.schema), &view, "view", "", "legacy");
    legacy.table_type = None;
    let old_sql = build_table_structure_change_sql(legacy);
    assert_eq!(old_sql.statements.len(), 1);
    let error = fixture.agent.execute(&old_sql.statements[0]).expect_err("TABLE syntax must reject a view");
    assert!(error.contains("vendorCode=259"), "{error}");
    println!("Legacy COMMENT ON TABLE reproduced HANA error 259.");

    let mut previous = "";
    for new in ["员工目标", "owner's 中文描述", ""] {
        for qualified in [true, false] {
            let options = comment_options(qualified.then_some(fixture.schema.as_str()), &view, "view", previous, new);
            let plan = build_table_structure_change_sql(options.clone());
            assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
            assert_eq!(plan.statements.len(), 1);
            assert!(plan.statements[0].starts_with("COMMENT ON VIEW "));
            fixture.agent.execute(&plan.statements[0]).expect("execute generated view comment");
            let readback = fixture
                .agent
                .execute(&format!(
                    "SELECT COMMENTS FROM SYS.VIEWS WHERE SCHEMA_NAME={} AND VIEW_NAME={}",
                    literal(&fixture.schema),
                    literal(&view)
                ))
                .expect("read view comment from SYS.VIEWS");
            assert_eq!(readback["rows"].as_array().unwrap().len(), 1);
            let comment = &readback["rows"][0][0];
            if new.is_empty() {
                assert!(comment.is_null() || comment.as_str() == Some(""));
            } else {
                assert_eq!(comment.as_str(), Some(new));
            }
            let unchanged = build_table_structure_change_sql(TableStructureSqlOptions {
                original_table_comment: options.table_comment.clone(),
                ..options
            });
            assert!(unchanged.statements.is_empty());
        }
        previous = new;
    }
    println!("Generated VIEW comments round-tripped Chinese, apostrophes and clearing, with/without schema.");

    let table_plan =
        build_table_structure_change_sql(comment_options(Some(&fixture.schema), &table, "table", "", "普通表描述"));
    assert!(table_plan.warnings.is_empty());
    assert_eq!(table_plan.statements.len(), 1);
    assert!(table_plan.statements[0].starts_with("COMMENT ON TABLE "));
    fixture.agent.execute(&table_plan.statements[0]).expect("execute generated table comment");
    let table_comment = fixture
        .agent
        .execute(&format!(
            "SELECT COMMENTS FROM SYS.TABLES WHERE SCHEMA_NAME={} AND TABLE_NAME={}",
            literal(&fixture.schema),
            literal(&table)
        ))
        .expect("read table comment from SYS.TABLES");
    assert_eq!(table_comment["rows"][0][0], "普通表描述");
    println!("Ordinary TABLE comments still round-trip.");

    fixture.cleanup();
    let remaining = fixture
        .agent
        .execute(&format!(
            "SELECT COUNT(*) FROM SYS.OBJECTS WHERE SCHEMA_NAME={} AND OBJECT_NAME IN ({}, {})",
            literal(&fixture.schema),
            literal(&view),
            literal(&table)
        ))
        .expect("verify fixture cleanup");
    assert_eq!(remaining["rows"][0][0].as_i64(), Some(0));
    fixture.agent.call("disconnect", json!({})).expect("disconnect HANA");
    println!("Temporary view/table removed; SYS.OBJECTS reports zero leftovers.");
}
