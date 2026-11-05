//! Live coverage for Gauss-family routine source identity (#13858).
//!
//! Uses the desktop object-list and source entry points against a real GaussDB
//! or openGauss endpoint. GaussDB A compatibility mode reproduces the empty
//! signature regression: the formatter returns non-NULL empty text, while the
//! SQL literal `''` is NULL and cannot match it with equality.
//!
//! Requires an account allowed to create/drop schemas. Export
//! DBX_LIVE_OPENGAUSS_HOST, DBX_LIVE_OPENGAUSS_PORT, DBX_LIVE_OPENGAUSS_USER,
//! DBX_LIVE_OPENGAUSS_PASSWORD and DBX_LIVE_OPENGAUSS_DATABASE, then run:
//!
//! ```text
//! RUST_MIN_STACK=33554432 cargo test -p dbx-core --no-default-features \
//!   --features sqlite-bundled --test live_opengauss_routine_source \
//!   -- --ignored --nocapture
//! ```
//!
//! Each test creates a unique schema and drops it after verification, including
//! when setup or a source assertion returns an error. Credentials stay in memory.

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::schema::{get_object_source_core, list_objects_core};
use dbx_core::types::ObjectSourceKind;
use serde_json::json;

fn required_env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} must be set for live Gauss-family tests"))
}

fn live_config(id: &str, database: &str, db_type: DatabaseType) -> Result<ConnectionConfig, String> {
    let port = required_env("DBX_LIVE_OPENGAUSS_PORT")?
        .parse::<u16>()
        .map_err(|_| "DBX_LIVE_OPENGAUSS_PORT must be a u16".to_string())?;
    serde_json::from_value(json!({
        "id": id,
        "name": id,
        "db_type": db_type,
        "host": required_env("DBX_LIVE_OPENGAUSS_HOST")?,
        "port": port,
        "username": required_env("DBX_LIVE_OPENGAUSS_USER")?,
        "password": required_env("DBX_LIVE_OPENGAUSS_PASSWORD")?,
        "database": database,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0,
        "ssl": false
    }))
    .map_err(|error| format!("deserialize live Gauss-family connection config: {error}"))
}

async fn verify_sources(state: &AppState, connection_id: &str, database: &str, schema: &str) -> Result<(), String> {
    // Send each routine as one statement; the slash accepted by gsql is a
    // client-side delimiter, not part of the native driver's SQL statement.
    let fixtures = [
        format!(
            "CREATE PROCEDURE \"{schema}\".source_procedure(IN input_value integer) AS \
             BEGIN RAISE NOTICE 'dbx_procedure_marker: %', input_value; END;"
        ),
        format!(
            "CREATE FUNCTION \"{schema}\".source_default(input_value integer DEFAULT 7) RETURNS text \
             AS $$ BEGIN RETURN 'dbx_default_marker'; END; $$ LANGUAGE plpgsql"
        ),
        format!(
            "CREATE FUNCTION \"{schema}\".source_overloaded(input_value integer) RETURNS text \
             AS $$ BEGIN RETURN 'dbx_integer_marker'; END; $$ LANGUAGE plpgsql"
        ),
        format!(
            "CREATE FUNCTION \"{schema}\".source_overloaded(input_value text) RETURNS text \
             AS $$ BEGIN RETURN 'dbx_text_marker'; END; $$ LANGUAGE plpgsql"
        ),
        // Create the parameterized overloads first. Dropping the empty-signature
        // filter would otherwise happen to return the right routine by OID.
        format!(
            "CREATE FUNCTION \"{schema}\".source_overloaded() RETURNS text \
             AS $$ BEGIN RETURN 'dbx_noargs_function_marker'; END; $$ LANGUAGE plpgsql"
        ),
        format!(
            "CREATE PROCEDURE \"{schema}\".source_noargs_procedure() AS \
             BEGIN RAISE NOTICE 'dbx_noargs_procedure_marker'; END;"
        ),
        format!(
            "CREATE PROCEDURE \"{schema}\".source_out_only(OUT result text) AS \
             BEGIN result := 'dbx_out_only_marker'; END;"
        ),
    ];
    for sql in fixtures {
        execute_sql_statement(state, connection_id, database, &sql, Some(schema), None)
            .await
            .map_err(|error| format!("create routine fixture: {error}"))?;
    }

    let routine_types = ["PROCEDURE".to_string(), "FUNCTION".to_string()];
    let objects =
        list_objects_core(state, connection_id, database, schema, None, None, None, Some(&routine_types), None).await?;
    if objects.len() != 7 {
        return Err(format!("expected three procedures and four functions, got {objects:?}"));
    }

    let expected = [
        ("source_procedure", "integer", "PROCEDURE", "dbx_procedure_marker"),
        ("source_default", "integer", "FUNCTION", "dbx_default_marker"),
        ("source_overloaded", "integer", "FUNCTION", "dbx_integer_marker"),
        ("source_overloaded", "text", "FUNCTION", "dbx_text_marker"),
        ("source_overloaded", "", "FUNCTION", "dbx_noargs_function_marker"),
        ("source_noargs_procedure", "", "PROCEDURE", "dbx_noargs_procedure_marker"),
        ("source_out_only", "OUT result text", "PROCEDURE", "dbx_out_only_marker"),
    ];
    for (name, argument_type, object_type, marker) in expected {
        let matches: Vec<_> = objects
            .iter()
            .filter(|object| {
                object.name == name
                    && object.object_type == object_type
                    && object.signature.as_deref().is_some_and(|signature| {
                        if argument_type.is_empty() {
                            signature.is_empty()
                        } else {
                            signature.contains(argument_type)
                        }
                    })
            })
            .collect();
        if matches.len() != 1 {
            return Err(format!("expected one {object_type} {name}({argument_type}), got {matches:?}"));
        }
        let object = matches[0];
        let kind = if object_type == "PROCEDURE" { ObjectSourceKind::Procedure } else { ObjectSourceKind::Function };
        let source = get_object_source_core(
            state,
            connection_id,
            database,
            schema,
            name,
            kind,
            object.signature.as_deref(),
            None,
        )
        .await?;
        if !source.source.contains(marker) {
            return Err(format!(
                "source for {name}({argument_type}) did not contain its own body marker: {}",
                source.source
            ));
        }
        for (other_name, _, _, other_marker) in expected {
            if other_name == name && other_marker != marker && source.source.contains(other_marker) {
                return Err(format!("source for {name}({argument_type}) returned another overload"));
            }
        }
        if name == "source_default" && !source.source.to_ascii_uppercase().contains("DEFAULT 7") {
            return Err("default parameter was lost from the function source".to_string());
        }
        eprintln!("{connection_id}: loaded {object_type} {name}({})", object.signature.as_deref().unwrap_or_default());
    }

    // An unmatched signature must not lose its identity filter. In particular,
    // an OUT-only procedure has pronargs = 0 but a nonempty display signature;
    // using pronargs = 0 as the empty-signature filter would select it wrongly.
    for (name, kind, signature) in [
        ("source_overloaded", ObjectSourceKind::Function, "input_value boolean"),
        ("source_procedure", ObjectSourceKind::Procedure, "input_value boolean"),
        ("source_default", ObjectSourceKind::Function, ""),
        ("source_out_only", ObjectSourceKind::Procedure, ""),
    ] {
        match get_object_source_core(state, connection_id, database, schema, name, kind, Some(signature), None).await {
            Err(error) if error.to_ascii_lowercase().contains("object source not found") => {
                eprintln!("{connection_id}: nonexistent signature for {name} correctly returned not found");
            }
            Err(error) => return Err(format!("expected not found for {name}({signature}), got: {error}")),
            Ok(source) => {
                return Err(format!(
                    "nonexistent signature for {name}({signature}) returned another routine: {}",
                    source.source
                ));
            }
        }
    }
    Ok(())
}

async fn run_live_case(db_type: DatabaseType) -> Result<(), String> {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-routine-source-{db_type:?}-{suffix}");
    let schema = format!("dbx_routine_source_{suffix}");
    let database = required_env("DBX_LIVE_OPENGAUSS_DATABASE")?;
    let config = live_config(&connection_id, &database, db_type)?;
    let directory = tempfile::tempdir().map_err(|error| error.to_string())?;
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await?;
    let state = AppState::new_with_plugin_dir(storage, directory.path().join("plugins"));
    state.configs.write().await.insert(connection_id.clone(), config);
    state.get_or_create_pool(&connection_id, Some(&database)).await?;
    execute_sql_statement(&state, &connection_id, &database, &format!("CREATE SCHEMA \"{schema}\""), None, None)
        .await?;

    let verification = Box::pin(verify_sources(&state, &connection_id, &database, &schema)).await;
    let cleanup = execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &format!("DROP SCHEMA \"{schema}\" CASCADE"),
        None,
        None,
    )
    .await;
    match (verification, cleanup) {
        (Ok(()), Ok(_)) => Ok(()),
        (Err(error), Ok(_)) => Err(error),
        (result, Err(error)) => Err(format!("verification: {result:?}; failed to clean up {schema}: {error}")),
    }
}

#[tokio::test]
#[ignore = "requires a writable GaussDB/openGauss endpoint via DBX_LIVE_OPENGAUSS_* variables"]
async fn live_opengauss_routine_sources_preserve_identity() -> Result<(), String> {
    Box::pin(run_live_case(DatabaseType::OpenGauss)).await
}

#[tokio::test]
#[ignore = "requires a writable GaussDB/openGauss endpoint via DBX_LIVE_OPENGAUSS_* variables"]
async fn live_gaussdb_routine_sources_preserve_identity() -> Result<(), String> {
    Box::pin(run_live_case(DatabaseType::Gaussdb)).await
}
