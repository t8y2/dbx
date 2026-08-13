use dbx_core::db::sqlserver;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn base36(mut value: u128) -> String {
    const DIGITS: &[u8; 36] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut encoded = Vec::new();
    loop {
        encoded.push(DIGITS[(value % 36) as usize]);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    encoded.reverse();
    String::from_utf8(encoded).expect("base36 session expiry")
}

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
    let expires_at = SystemTime::now().duration_since(UNIX_EPOCH).expect("system time").as_millis() + 5 * 60_000;
    let session_name = format!("DBX_TRACE_{}_TEST{}", base36(expires_at), std::process::id());
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
        &format!(
            "SELECT \
                CAST(SERVERPROPERTY(N'ProductVersion') AS nvarchar(128)) AS product_version, \
                CONVERT(int, SERVERPROPERTY(N'EngineEdition')) AS engine_edition, \
                DB_ID(N'{}') AS database_id, \
                CONVERT(int, HAS_PERMS_BY_NAME(NULL, NULL, N'ALTER ANY EVENT SESSION')) AS can_alter_event_session, \
                CONVERT(int, HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE')) AS can_view_server_state, \
                CONVERT(int, CASE WHEN EXISTS (SELECT 1 FROM sys.fn_builtin_permissions(DEFAULT) WHERE permission_name = N'VIEW SERVER PERFORMANCE STATE') \
                    THEN HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER PERFORMANCE STATE') ELSE 1 END) AS can_view_server_performance_state, \
                CONVERT(int, CASE WHEN EXISTS (SELECT 1 FROM sys.dm_xe_objects object JOIN sys.dm_xe_packages package ON package.guid = object.package_guid \
                    WHERE package.name = N'sqlserver' AND object.object_type = N'event' AND object.name = N'rpc_completed') THEN 1 ELSE 0 END) AS has_rpc_completed_event, \
                CONVERT(int, CASE WHEN EXISTS (SELECT 1 FROM sys.dm_xe_objects object JOIN sys.dm_xe_packages package ON package.guid = object.package_guid \
                    WHERE package.name = N'sqlserver' AND object.object_type = N'event' AND object.name = N'sql_batch_completed') THEN 1 ELSE 0 END) AS has_sql_batch_completed_event, \
                CONVERT(int, CASE WHEN EXISTS (SELECT 1 FROM sys.dm_xe_objects object JOIN sys.dm_xe_packages package ON package.guid = object.package_guid \
                    WHERE package.name = N'sqlserver' AND object.object_type = N'event' AND object.name = N'sp_statement_completed') THEN 1 ELSE 0 END) AS has_sp_statement_completed_event, \
                CONVERT(int, CASE WHEN EXISTS (SELECT 1 FROM sys.dm_xe_objects object JOIN sys.dm_xe_packages package ON package.guid = object.package_guid \
                    WHERE package.name = N'package0' AND object.object_type = N'target' AND object.name = N'ring_buffer') THEN 1 ELSE 0 END) AS has_ring_buffer_target, \
                CONVERT(int, CASE WHEN EXISTS (SELECT 1 FROM sys.dm_xe_objects object JOIN sys.dm_xe_packages package ON package.guid = object.package_guid \
                    WHERE package.name = N'sqlserver' AND object.object_type = N'pred_source' AND object.name = N'database_id') THEN 1 ELSE 0 END) AS has_database_id_predicate, \
                CONVERT(int, CASE WHEN EXISTS (SELECT 1 FROM sys.dm_xe_objects object JOIN sys.dm_xe_packages package ON package.guid = object.package_guid \
                    WHERE package.name = N'sqlserver' AND object.object_type = N'pred_compare' AND object.name = N'like_i_sql_unicode_string') THEN 1 ELSE 0 END) AS has_like_predicate, \
                STUFF((SELECT N',' + object.name FROM sys.dm_xe_objects object JOIN sys.dm_xe_packages package ON package.guid = object.package_guid \
                    WHERE package.name = N'sqlserver' AND object.object_type = N'action' AND object.name IN \
                    (N'client_app_name', N'client_hostname', N'database_id', N'database_name', N'server_principal_name', N'session_id', N'sql_text') \
                    ORDER BY object.name FOR XML PATH(N''), TYPE).value(N'.', N'nvarchar(max)'), 1, 1, N'') AS available_actions",
            database.replace('\'', "''")
        ),
    )
    .await
    .expect("query server capabilities");
    eprintln!("capabilities={:?}", probe.rows);
    let capability_row = &probe.rows[0];
    let database_id = capability_row[2].as_i64().expect("database id");
    for (column, value) in probe.columns[3..12].iter().zip(&capability_row[3..12]) {
        assert_eq!(value.as_i64(), Some(1), "missing XE capability in {column}");
    }
    let actions = capability_row[12].as_str().expect("available XE actions");
    for action in [
        "client_app_name",
        "client_hostname",
        "database_id",
        "database_name",
        "server_principal_name",
        "session_id",
        "sql_text",
    ] {
        assert!(actions.split(',').any(|available| available == action), "missing XE action {action}");
    }

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
         ADD TARGET package0.ring_buffer(SET max_events_limit=(256), max_memory=(4096)) \
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
             ), event_rows AS ( \
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
             ), bounded_events AS ( \
               SELECT TOP (256) * FROM event_rows ORDER BY event_time_utc DESC \
             ) \
             SELECT * FROM bounded_events ORDER BY event_time_utc"
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
