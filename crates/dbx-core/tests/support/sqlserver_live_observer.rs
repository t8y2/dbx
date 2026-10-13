//! Independent observers for the opt-in SQL Server live suite.
//! SQL Server 2000 uses an independent JDBC observer, including for native TDS workloads.
use dbx_core::db::{
    agent_driver::{AgentDriverClient, AgentLaunchSpec},
    sqlserver as native, QueryResult,
};
use std::time::Duration;

pub fn sql_server_2000() -> bool {
    std::env::var("DBX_TEST_SQLSERVER_COMPAT_2000").as_deref() == Ok("1")
}

pub enum SqlServerClient {
    Native(Box<native::SqlServerClient>),
    Agent(Box<AgentDriverClient>),
}

pub async fn connect_with_port_explicit(
    host: &str,
    port: u16,
    port_explicit: bool,
    user: &str,
    password: &str,
    database: Option<&str>,
    timeout: Duration,
) -> Result<SqlServerClient, String> {
    if !sql_server_2000() {
        return native::connect_with_port_explicit(host, port, port_explicit, user, password, database, timeout)
            .await
            .map(|client| SqlServerClient::Native(Box::new(client)));
    }
    let mut client = AgentDriverClient::spawn(AgentLaunchSpec::java_jar(
        std::env::var("DBX_TEST_SQLSERVER_JAVA").expect("Java 21 executable"),
        std::env::var("DBX_TEST_SQLSERVER_AGENT_JAR").expect("built SQL Server legacy Agent"),
    ))
    .await?;
    client
        .connect(serde_json::json!({
            "host":host, "port":port, "port_explicit":port_explicit, "username":user,
            "password":password, "database":database,
            "jdbc_driver_class":std::env::var("DBX_TEST_SQLSERVER_JDBC_CLASS").ok(),
            "connection_string":std::env::var("DBX_TEST_SQLSERVER_JDBC_URL").ok(),
            "ssl":false,
        }))
        .await?;
    Ok(SqlServerClient::Agent(Box::new(client)))
}

pub async fn execute_simple_batch_with_max_rows(
    client: &mut SqlServerClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<Vec<QueryResult>, String> {
    match client {
        SqlServerClient::Native(client) => native::execute_simple_batch_with_max_rows(client, sql, max_rows).await,
        SqlServerClient::Agent(client) => client
            .execute_query_with_timeout(
                serde_json::json!({"sql":sql,"maxRows":max_rows}),
                Some(Duration::from_secs(40)),
            )
            .await
            .map(|result: QueryResult| vec![result]),
    }
}

pub async fn execute_query(client: &mut SqlServerClient, sql: &str) -> Result<QueryResult, String> {
    match client {
        SqlServerClient::Native(client) => native::execute_query(client, sql).await,
        SqlServerClient::Agent(_) => execute_simple_batch_with_max_rows(client, sql, None)
            .await?
            .into_iter()
            .find(|result| !result.columns.is_empty())
            .ok_or_else(|| "Observer query returned no result set".to_owned()),
    }
}

pub fn wait_query(spid: i64) -> String {
    if sql_server_2000() {
        format!("SELECT COUNT(*) FROM master.dbo.sysprocesses WHERE spid={spid} AND LTRIM(RTRIM(cmd))='WAITFOR'")
    } else {
        format!("SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id={spid} AND wait_type='WAITFOR'")
    }
}

pub fn active_query(spid: i64) -> String {
    if sql_server_2000() {
        format!("SELECT COUNT(*) FROM master.dbo.sysprocesses WHERE spid={spid}")
    } else {
        format!("SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id={spid}")
    }
}

pub async fn log_old_session(client: &mut SqlServerClient, spid: i64, phase: &str) -> Option<String> {
    if !sql_server_2000() {
        return None;
    }
    let sql = format!("SELECT spid, status, cmd, open_tran, login_time, hostname, program_name FROM master.dbo.sysprocesses WHERE spid={spid}");
    let result = execute_query(client, &sql).await.expect("old session diagnostic");
    println!("SQL2000 session {spid} {phase}: {:?}", result.rows);
    result.rows.first().and_then(|row| row.get(4)).and_then(serde_json::Value::as_str).map(str::to_owned)
}

/// Server cleanup is asynchronous. Poll fresh evidence rather than assert a
/// stale snapshot taken before logging; login_time prevents SPID reuse from
/// making a newly opened, unrelated session look like a leaked transaction.
pub async fn wait_for_session_release(client: &mut SqlServerClient, spid: i64, identity: Option<&str>) {
    let sql = if sql_server_2000() {
        let identity = identity.expect("actual SQL2000 login_time must be recorded").replace(char::from(39), "''");
        format!("SELECT COUNT(*) FROM master.dbo.sysprocesses WHERE spid={spid} AND login_time=CONVERT(datetime, '{identity}', 121)")
    } else {
        active_query(spid)
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let active = execute_query(client, &sql).await.unwrap();
            if active.rows[0][0] == serde_json::json!(0) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("the original server task/transaction was not released");
}
