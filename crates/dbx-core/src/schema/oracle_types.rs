//! Oracle-family TYPE metadata. Every identity is an exact dictionary spelling.
use super::{agent_metadata_timeout, connection_config, retry_metadata_connection, sql_string};
use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::DatabaseType;
use crate::query::{agent_execute_query_params, QueryExecutionOptions};
pub use dbx_types::oracle_types::*;
use std::sync::Arc;
use std::time::Duration;

fn dictionary_type(object_type: &str) -> Result<&'static str, String> {
    match object_type {
        "TYPE" => Ok("TYPE"),
        "TYPE_BODY" => Ok("TYPE BODY"),
        _ => Err("Expected TYPE or TYPE_BODY".into()),
    }
}

pub async fn get_oracle_type_details_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    name: &str,
    object_type: &str,
) -> Result<OracleTypeDetails, String> {
    dictionary_type(object_type)?;
    if schema.is_empty() || name.is_empty() {
        return Err("An exact type owner and name are required".into());
    }
    retry_metadata_connection(state, connection_id, Some(database), || async {
        let config = connection_config(state, connection_id).await.ok_or("Connection not found")?;
        if !matches!(config.db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle) {
            return Err("Oracle type details are not supported for this connection".into());
        }
        let key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
        let pool = state.pool_handle(&key).await;
        let Some(PoolKind::Agent(client)) = pool else {
            return Err("Oracle type details require an Oracle-family Agent connection".into());
        };
        let timeout = agent_metadata_timeout(Some(&config));
        let identity = OracleTypeIdentity { schema: schema.into(), name: name.into(), object_type: object_type.into() };
        let objects = query(client.clone(), database, &format!(
            "SELECT OBJECT_TYPE, STATUS FROM ALL_OBJECTS WHERE OWNER = {} AND OBJECT_NAME = {} AND OBJECT_TYPE IN ('TYPE', 'TYPE BODY')",
            sql_string(schema), sql_string(name)
        ), timeout).await?;
        let (status, paired_object, pairing_state) = object_status(&identity, &objects)?;
        let dependencies = section(query(client.clone(), database, &dependencies_sql(&identity)?, timeout).await, |row| {
            Ok(OracleTypeDependency {
                schema: required(row, 0)?, name: required(row, 1)?, object_type: required(row, 2)?.replace(' ', "_"),
                referenced_schema: text(row, 3), referenced_name: required(row, 4)?, referenced_type: required(row, 5)?.replace(' ', "_"),
                referenced_link: text(row, 6), dependency_type: text(row, 7),
            })
        });
        let grants = section(query(client, database, &format!(
            "SELECT GRANTOR, GRANTEE, PRIVILEGE, GRANTABLE FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY GRANTEE, PRIVILEGE, GRANTOR",
            sql_string(schema), sql_string(name)
        ), timeout).await, |row| Ok(OracleTypeGrant {
            grantor: text(row, 0), grantee: required(row, 1)?, privilege: required(row, 2)?,
            grantable: match text(row, 3).as_deref() { Some("YES") => Some(true), Some("NO") => Some(false), _ => None },
        }));
        Ok(OracleTypeDetails { identity, status, paired_object, pairing_state, dependencies, grants })
    }).await
}

fn dependencies_sql(identity: &OracleTypeIdentity) -> Result<String, String> {
    Ok(format!(
        "SELECT OWNER, NAME, TYPE, REFERENCED_OWNER, REFERENCED_NAME, REFERENCED_TYPE, REFERENCED_LINK_NAME, DEPENDENCY_TYPE FROM ALL_DEPENDENCIES WHERE OWNER = {} AND NAME = {} AND TYPE = {} ORDER BY REFERENCED_OWNER, REFERENCED_NAME, REFERENCED_TYPE",
        sql_string(&identity.schema), sql_string(&identity.name), sql_string(dictionary_type(&identity.object_type)?)
    ))
}

async fn query(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    sql: &str,
    timeout: Option<Duration>,
) -> Result<db::QueryResult, String> {
    // No current-schema mutation is needed: every dictionary predicate includes OWNER.
    let params = agent_execute_query_params(
        sql,
        Some(database),
        None,
        QueryExecutionOptions { max_rows: Some(i32::MAX as usize), ..Default::default() },
    );
    let result = client.lock().await.execute_query_with_timeout(params, timeout).await?;
    require_complete(&result)?;
    Ok(result)
}

fn require_complete(result: &db::QueryResult) -> Result<(), String> {
    if result.truncated || result.has_more {
        return Err("Oracle metadata was truncated; complete metadata is unavailable".into());
    }
    Ok(())
}

fn text(row: &[serde_json::Value], index: usize) -> Option<String> {
    row.get(index).and_then(|value| value.as_str()).map(str::to_string)
}

fn required(row: &[serde_json::Value], index: usize) -> Result<String, String> {
    text(row, index).ok_or_else(|| "Oracle dictionary returned incomplete metadata".into())
}

fn object_status(
    identity: &OracleTypeIdentity,
    result: &db::QueryResult,
) -> Result<(Option<String>, Option<OracleTypeIdentity>, OracleMetadataReadState), String> {
    require_complete(result)?;
    let kind = dictionary_type(&identity.object_type)?;
    let selected = result
        .rows
        .iter()
        .find(|row| text(row, 0).as_deref() == Some(kind))
        .ok_or("Type is missing or is not visible to the current account")?;
    let pair_kind = if kind == "TYPE" { "TYPE BODY" } else { "TYPE" };
    let paired_object =
        result.rows.iter().any(|row| text(row, 0).as_deref() == Some(pair_kind)).then(|| OracleTypeIdentity {
            schema: identity.schema.clone(),
            name: identity.name.clone(),
            object_type: pair_kind.replace(' ', "_"),
        });
    let pairing_state =
        if paired_object.is_some() { OracleMetadataReadState::Available } else { OracleMetadataReadState::Empty };
    Ok((text(selected, 1), paired_object, pairing_state))
}

fn section<T>(
    result: Result<db::QueryResult, String>,
    map: impl Fn(&[serde_json::Value]) -> Result<T, String>,
) -> OracleMetadataSection<T> {
    match result.and_then(|result| {
        require_complete(&result)?;
        result.rows.iter().map(|row| map(row)).collect::<Result<Vec<_>, _>>()
    }) {
        Ok(rows) => OracleMetadataSection {
            state: if rows.is_empty() { OracleMetadataReadState::Empty } else { OracleMetadataReadState::Available },
            rows,
            message: None,
        },
        Err(message) => {
            OracleMetadataSection { state: error_state(&message), rows: Vec::new(), message: Some(message) }
        }
    }
}

fn error_state(message: &str) -> OracleMetadataReadState {
    let upper = message.to_uppercase();
    if upper.contains("ORA-01031") || upper.contains("INSUFFICIENT PRIVILEGE") || upper.contains("ACCESS DENIED") {
        OracleMetadataReadState::Denied
    } else if upper.contains("ORA-00942") {
        // Oracle deliberately cannot distinguish a hidden view from a missing one.
        OracleMetadataReadState::Unknown
    } else if upper.contains("ORA-00904") || upper.contains("NOT SUPPORTED") {
        OracleMetadataReadState::Unsupported
    } else {
        OracleMetadataReadState::Error
    }
}

pub(super) async fn source(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    name: &str,
    object_type: &db::ObjectSourceKind,
    timeout: Option<Duration>,
) -> Result<db::ObjectSource, String> {
    let kind = match object_type {
        db::ObjectSourceKind::Type => "TYPE",
        db::ObjectSourceKind::TypeBody => "TYPE BODY",
        _ => return Err("Expected a type source request".into()),
    };
    if schema.is_empty() || name.is_empty() {
        return Err("An exact type owner and name are required".into());
    }
    let sql = format!(
        "SELECT TEXT FROM ALL_SOURCE WHERE OWNER = {} AND NAME = {} AND TYPE = {} ORDER BY LINE",
        sql_string(schema),
        sql_string(name),
        sql_string(kind)
    );
    let dictionary = query(client.clone(), database, &sql, timeout).await.and_then(|result| source_lines(&result));
    let source = match dictionary {
        Ok(source) if !source.trim().is_empty() => source,
        dictionary => {
            let sql = format!(
                "SELECT DBMS_METADATA.GET_DDL({}, {}, {}) FROM DUAL",
                sql_string(&kind.replace(' ', "_")),
                sql_string(name),
                sql_string(schema)
            );
            query(client, database, &sql, timeout).await.and_then(|result| source_lines(&result)).map_err(|error| {
                match dictionary {
                    Err(first) => format!("Type source is unavailable: {first}; GET_DDL: {error}"),
                    _ => format!("Type source is unavailable: {error}"),
                }
            })?
        }
    };
    let source = complete_type_source(source)?;
    Ok(db::ObjectSource {
        name: name.into(),
        object_type: object_type.clone(),
        schema: Some(schema.into()),
        source,
        editable: Some(false),
        routine_parameters: None,
    })
}

fn source_lines(result: &db::QueryResult) -> Result<String, String> {
    require_complete(result)?;
    result.rows.iter().map(|row| required(row, 0)).collect::<Result<Vec<_>, _>>().map(|lines| lines.concat())
}

fn complete_type_source(source: String) -> Result<String, String> {
    if source.trim().is_empty() {
        return Err("Complete type source is missing or is not visible to the current account".into());
    }
    if source.trim_start().to_uppercase().starts_with("CREATE ") {
        Ok(source)
    } else {
        Ok(format!("CREATE OR REPLACE {source}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn result(rows: serde_json::Value) -> db::QueryResult {
        serde_json::from_value(json!({"columns": [], "rows": rows, "affected_rows": 0, "execution_time_ms": 0, "truncated": false, "has_more": false})).unwrap()
    }

    #[test]
    fn pairs_only_the_requested_identity_and_preserves_unknown_status() {
        let identity =
            OracleTypeIdentity { schema: "Mixed.Owner".into(), name: "T\"name".into(), object_type: "TYPE".into() };
        let (status, pair, state) =
            object_status(&identity, &result(json!([["TYPE", null], ["TYPE BODY", "INVALID"]]))).unwrap();
        assert_eq!(status, None);
        assert_eq!(pair.unwrap(), OracleTypeIdentity { object_type: "TYPE_BODY".into(), ..identity });
        assert_eq!(state, OracleMetadataReadState::Available);
    }

    #[test]
    fn metadata_failures_are_not_empty_results() {
        for (message, expected) in [
            ("ORA-01031", OracleMetadataReadState::Denied),
            ("ORA-00942", OracleMetadataReadState::Unknown),
            ("ORA-00904", OracleMetadataReadState::Unsupported),
            ("connection closed", OracleMetadataReadState::Error),
        ] {
            let value: OracleMetadataSection<String> = section(Err(message.into()), |row| required(row, 0));
            assert_eq!(value.state, expected);
        }
        let value = section(Ok(result(json!([]))), |row| required(row, 0));
        assert_eq!(value.state, OracleMetadataReadState::Empty);
    }

    #[test]
    fn complete_source_keeps_all_lines_and_rejects_missing_or_truncated_source() {
        let lines = result(json!([["TYPE \"T\" AS OBJECT (\n"], ["  MEMBER FUNCTION f RETURN VARCHAR2\n"], [");\n"]]));
        assert_eq!(
            complete_type_source(source_lines(&lines).unwrap()).unwrap(),
            "CREATE OR REPLACE TYPE \"T\" AS OBJECT (\n  MEMBER FUNCTION f RETURN VARCHAR2\n);\n"
        );
        assert!(complete_type_source(String::new()).is_err());
        let mut truncated = lines;
        truncated.truncated = true;
        assert!(source_lines(&truncated).is_err());
    }
}
