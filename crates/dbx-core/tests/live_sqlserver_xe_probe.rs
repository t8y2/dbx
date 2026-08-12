use dbx_core::db::sqlserver;
use std::time::Duration;

async fn run_batch(client: &mut sqlserver::SqlServerClient, sql: &str) -> Result<(), String> {
    client
        .simple_query(sql)
        .await
        .map_err(|error| error.to_string())?
        .into_results()
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_extended_events_probe_captures_rpc_and_batch_events() {
    let host = std::env::var("DBX_TEST_SQLSERVER_HOST").expect("DBX_TEST_SQLSERVER_HOST");
    let port = std::env::var("DBX_TEST_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_TEST_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_TEST_SQLSERVER_PASSWORD").expect("DBX_TEST_SQLSERVER_PASSWORD");
    let database = std::env::var("DBX_TEST_SQLSERVER_DATABASE").unwrap_or_else(|_| "master".to_string());
    let session_name = format!("DBX_TRACE_TEST_{}", std::process::id());
    let procedure_name = format!("DBX_TRACE_TEST_PROC_{}", std::process::id());

    let mut control = sqlserver::connect_with_port_explicit(
        &host,
        port,
        true,
        &user,
        &password,
        Some(&database),
        Duration::from_secs(15),
    )
    .await
    .expect("connect control session");

    let probe = sqlserver::execute_query(
        &mut control,
        "SELECT CAST(SERVERPROPERTY(N'ProductVersion') AS nvarchar(128)) AS product_version, \
                CAST(SERVERPROPERTY(N'ProductLevel') AS nvarchar(128)) AS product_level, \
                DB_ID() AS database_id, \
                HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY EVENT SESSION') AS can_alter_event_session, \
                HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE') AS can_view_server_state",
    )
    .await
    .expect("query server capabilities");
    eprintln!("capabilities={:?}", probe.rows);
    let database_id = probe.rows[0][2].as_i64().expect("database id");

    let drop_sql = format!(
        "IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name = N'{session_name}') \
         DROP EVENT SESSION [{session_name}] ON SERVER;"
    );
    run_batch(&mut control, &drop_sql).await.expect("drop stale test session");
    run_batch(
        &mut control,
        &format!(
            "IF OBJECT_ID(N'dbo.{procedure_name}', N'P') IS NOT NULL DROP PROCEDURE dbo.[{procedure_name}]; \
             EXEC(N'CREATE PROCEDURE dbo.[{procedure_name}] @value int AS SELECT @value AS traced_value;');"
        ),
    )
    .await
    .expect("create trace procedure");

    let create_sql = format!(
        "CREATE EVENT SESSION [{session_name}] ON SERVER \
         ADD EVENT sqlserver.rpc_completed( \
           ACTION(sqlserver.client_app_name, sqlserver.client_hostname, sqlserver.database_id, \
                  sqlserver.database_name, sqlserver.server_principal_name, sqlserver.session_id, sqlserver.sql_text) \
           WHERE ([sqlserver].[database_id]=({database_id}) AND NOT [sqlserver].[like_i_sql_unicode_string]([sqlserver].[sql_text],N'%DBX_INTERNAL_TRACE%'))), \
         ADD EVENT sqlserver.sql_batch_completed( \
           ACTION(sqlserver.client_app_name, sqlserver.client_hostname, sqlserver.database_id, \
                  sqlserver.database_name, sqlserver.server_principal_name, sqlserver.session_id, sqlserver.sql_text) \
           WHERE ([sqlserver].[database_id]=({database_id}) AND NOT [sqlserver].[like_i_sql_unicode_string]([sqlserver].[sql_text],N'%DBX_INTERNAL_TRACE%'))), \
         ADD EVENT sqlserver.sp_statement_completed( \
           ACTION(sqlserver.client_app_name, sqlserver.client_hostname, sqlserver.database_id, \
                  sqlserver.database_name, sqlserver.server_principal_name, sqlserver.session_id, sqlserver.sql_text) \
           WHERE ([sqlserver].[database_id]=({database_id}) AND NOT [sqlserver].[like_i_sql_unicode_string]([sqlserver].[sql_text],N'%DBX_INTERNAL_TRACE%'))) \
         ADD TARGET package0.ring_buffer(SET max_events_limit=(500), max_memory=(2048)) \
         WITH (MAX_MEMORY=4096 KB, EVENT_RETENTION_MODE=ALLOW_SINGLE_EVENT_LOSS, \
               MAX_DISPATCH_LATENCY=1 SECONDS, TRACK_CAUSALITY=OFF, STARTUP_STATE=OFF); \
         ALTER EVENT SESSION [{session_name}] ON SERVER STATE = START;"
    );

    let result = async {
        run_batch(&mut control, &create_sql).await?;
        let mut workload = sqlserver::connect_with_port_explicit(
            &host,
            port,
            true,
            &user,
            &password,
            Some(&database),
            Duration::from_secs(15),
        )
        .await?;
        run_batch(&mut workload, "SELECT 1701 AS dbx_trace_probe; WAITFOR DELAY '00:00:00.050';").await?;
        sqlserver::test_connection(&mut workload).await?;
        workload
            .query(&format!("EXEC dbo.[{procedure_name}] @value = @P1"), &[&1701_i32])
            .await
            .map_err(|error| error.to_string())?
            .into_results()
            .await
            .map_err(|error| error.to_string())?;
        tokio::time::sleep(Duration::from_secs(2)).await;

        let read_sql = format!(
             "/* DBX_INTERNAL_TRACE */ ;WITH target AS ( \
               SELECT CAST(t.target_data AS xml) AS target_data \
               FROM sys.dm_xe_session_targets t \
               JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address \
               WHERE s.name = N'{session_name}' AND t.target_name = N'ring_buffer' \
             ) \
             SELECT event_node.value('(@name)[1]', 'nvarchar(128)') AS event_name, \
                    event_node.value('(@timestamp)[1]', 'datetime2(7)') AS event_time_utc, \
                    event_node.value('(action[@name=\"database_name\"]/value/text())[1]', 'nvarchar(128)') AS database_name, \
                    event_node.value('(action[@name=\"session_id\"]/value/text())[1]', 'int') AS session_id, \
                    COALESCE( \
                      NULLIF(event_node.value('(data[@name=\"statement\"]/value/text())[1]', 'nvarchar(max)'), N''), \
                      NULLIF(event_node.value('(data[@name=\"batch_text\"]/value/text())[1]', 'nvarchar(max)'), N''), \
                      event_node.value('(action[@name=\"sql_text\"]/value/text())[1]', 'nvarchar(max)') \
                    ) AS sql_text, \
                    event_node.value('(data[@name=\"duration\"]/value/text())[1]', 'bigint') AS duration, \
                    event_node.value('(data[@name=\"cpu_time\"]/value/text())[1]', 'bigint') AS cpu_time, \
                    event_node.value('(data[@name=\"logical_reads\"]/value/text())[1]', 'bigint') AS logical_reads, \
                    event_node.value('(data[@name=\"writes\"]/value/text())[1]', 'bigint') AS writes, \
                    event_node.value('(data[@name=\"result\"]/text/text())[1]', 'nvarchar(256)') AS result_text \
             FROM target CROSS APPLY target_data.nodes('/RingBufferTarget/event') AS events(event_node) \
             ORDER BY event_time_utc"
        );
        let events = sqlserver::execute_query(&mut control, &read_sql).await?;
        eprintln!("columns={:?}", events.columns);
        eprintln!("events={:?}", events.rows);
        if !events.rows.iter().any(|row| row.get(4).and_then(|value| value.as_str()).is_some_and(|sql| sql.contains("dbx_trace_probe"))) {
            return Err("probe SQL was not captured".to_string());
        }
        if !events.rows.iter().any(|row| {
            row.first().and_then(|value| value.as_str()) == Some("rpc_completed")
                && row.get(4).and_then(|value| value.as_str()).is_some_and(|sql| sql.contains(&procedure_name))
        }) {
            return Err("parameterized procedure RPC was not captured".to_string());
        }
        if !events.rows.iter().any(|row| row.first().and_then(|value| value.as_str()) == Some("sp_statement_completed")) {
            return Err("stored procedure statement was not captured".to_string());
        }
        if events.rows.iter().any(|row| {
            row.get(4)
                .and_then(|value| value.as_str())
                .is_some_and(|sql| sql.contains("DBX_INTERNAL_TRACE"))
        }) {
            return Err("DBX internal health check was captured".to_string());
        }
        Ok::<(), String>(())
    }
    .await;

    let _ = run_batch(&mut control, &format!("IF EXISTS (SELECT 1 FROM sys.dm_xe_sessions WHERE name = N'{session_name}') ALTER EVENT SESSION [{session_name}] ON SERVER STATE = STOP; {drop_sql}")).await;
    let _ = run_batch(
        &mut control,
        &format!("IF OBJECT_ID(N'dbo.{procedure_name}', N'P') IS NOT NULL DROP PROCEDURE dbo.[{procedure_name}];"),
    )
    .await;
    result.expect("capture Extended Events workload");
}
