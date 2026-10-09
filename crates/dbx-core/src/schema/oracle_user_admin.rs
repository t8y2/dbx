use super::oracle_security_write::{
    fingerprint, identifier, known_version, literal, password, safe_error, text, SecuritySession,
};
use super::{agent_metadata_timeout, connection_config, lock_metadata_mutex_with_timeout};
use crate::connection::{AppState, PoolKind, METADATA_POOL_ACQUIRE_TIMEOUT};
use crate::models::connection::DatabaseType;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserChange {
    action: String,
    name: String,
    profile: Option<String>,
    default_tablespace: Option<String>,
    temporary_tablespace: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OracleUserRequest {
    operation: String,
    change: UserChange,
    revision: Option<String>,
    // Ephemeral request only. Never serialized, logged, or included in a preview revision.
    password: Option<String>,
}
struct UserStep {
    label: &'static str,
    sql: String,
    preview: String,
}

async fn snapshot(session: &mut SecuritySession<'_>, change: &UserChange) -> Result<Value, String> {
    identifier(&change.name)?;
    let name = literal(&change.name);
    let users = session.query(&format!("SELECT USERNAME, TO_CHAR(USER_ID) AS USER_ID, ACCOUNT_STATUS, PROFILE, DEFAULT_TABLESPACE, TEMPORARY_TABLESPACE, TO_CHAR(CREATED, 'YYYY-MM-DD HH24:MI:SS') AS CREATED, TO_CHAR(LOCK_DATE, 'YYYY-MM-DD HH24:MI:SS') AS LOCK_DATE, TO_CHAR(EXPIRY_DATE, 'YYYY-MM-DD HH24:MI:SS') AS EXPIRY_DATE FROM DBA_USERS WHERE USERNAME = {name}")).await?;
    if users.len() > 1 {
        return Err("User identity is ambiguous".into());
    }
    let user = users.first().cloned().unwrap_or(Value::Null);
    let locked = if user.is_null() {
        Value::Null
    } else if session.oceanbase {
        let rows = session
            .query(&format!("SELECT IS_LOCKED FROM SYS.ALL_VIRTUAL_USER_REAL_AGENT WHERE USER_NAME = {name}"))
            .await?;
        if rows.len() != 1 {
            Value::Null
        } else {
            match rows.first().map(|row| text(row, "IS_LOCKED")).as_deref() {
                Some("1") => json!(true),
                Some("0") => json!(false),
                _ => Value::Null,
            }
        }
    } else {
        let status = text(&user, "ACCOUNT_STATUS");
        if status.is_empty() {
            Value::Null
        } else {
            json!(status.contains("LOCKED"))
        }
    };
    let mut objects = Vec::new();
    let mut dependencies = Vec::new();
    if change.action == "drop" {
        objects = session.query(&format!("SELECT OBJECT_NAME, OBJECT_TYPE FROM DBA_OBJECTS WHERE OWNER = {name} ORDER BY OBJECT_NAME, OBJECT_TYPE")).await?;
        dependencies = session.query(&format!("SELECT OWNER, NAME, TYPE, REFERENCED_OWNER, REFERENCED_NAME, REFERENCED_TYPE FROM DBA_DEPENDENCIES WHERE OWNER = {name} OR REFERENCED_OWNER = {name} ORDER BY OWNER, NAME, TYPE, REFERENCED_OWNER, REFERENCED_NAME")).await?;
    }
    Ok(
        json!({"user":user,"locked":locked,"objects":objects,"dependencies":dependencies,"dropChecks":change.action == "drop"}),
    )
}

fn plan(change: &UserChange, before: &Value, oceanbase: bool, secret: Option<&str>) -> Result<Vec<UserStep>, String> {
    let name = identifier(&change.name)?;
    let exists = !before["user"].is_null();
    if (change.action == "create") == exists {
        return Err(if exists { "User already exists" } else { "User does not exist or is not visible" }.into());
    }
    if oceanbase && (change.default_tablespace.is_some() || change.temporary_tablespace.is_some()) {
        return Err("Tablespace changes are not supported by this OceanBase user editor".into());
    }
    let credential = || match secret {
        Some(value) => password(value),
        None => Ok("\"<password omitted>\"".into()),
    };
    let mut steps = Vec::new();
    let mut add = |label, sql: String, preview: String| steps.push(UserStep { label, sql, preview });
    match change.action.as_str() {
        "create" => {
            let mut attributes = String::new();
            for (keyword, value) in [
                ("PROFILE", &change.profile),
                ("DEFAULT TABLESPACE", &change.default_tablespace),
                ("TEMPORARY TABLESPACE", &change.temporary_tablespace),
            ] {
                if let Some(value) = value {
                    attributes.push_str(&format!(" {keyword} {}", identifier(value)?));
                }
            }
            add(
                "create",
                format!("CREATE USER {name} IDENTIFIED BY {}{attributes}", credential()?),
                format!("CREATE USER {name} IDENTIFIED BY \"<password omitted>\"{attributes}"),
            );
        }
        "password" => add(
            "password",
            format!("ALTER USER {name} IDENTIFIED BY {}", credential()?),
            format!("ALTER USER {name} IDENTIFIED BY \"<password omitted>\""),
        ),
        "lock" | "unlock" => {
            if before["locked"].is_null() {
                return Err("The actual account lock state is unavailable".into());
            }
            let sql = format!("ALTER USER {name} ACCOUNT {}", if change.action == "lock" { "LOCK" } else { "UNLOCK" });
            add("account-lock", sql.clone(), sql);
        }
        "alter" => {
            for (keyword, value, column) in [
                ("PROFILE", &change.profile, "PROFILE"),
                ("DEFAULT TABLESPACE", &change.default_tablespace, "DEFAULT_TABLESPACE"),
                ("TEMPORARY TABLESPACE", &change.temporary_tablespace, "TEMPORARY_TABLESPACE"),
            ] {
                if let Some(value) = value {
                    if text(&before["user"], column) != *value {
                        let sql = format!("ALTER USER {name} {keyword} {}", identifier(value)?);
                        add(column, sql.clone(), sql);
                    }
                }
            }
        }
        "drop" => {
            if before["dropChecks"] != true
                || !before["objects"].as_array().is_some_and(Vec::is_empty)
                || !before["dependencies"].as_array().is_some_and(Vec::is_empty)
            {
                return Err("User owns objects or has dependencies; CASCADE is not permitted".into());
            }
            let sql = format!("DROP USER {name}");
            add("drop", sql.clone(), sql);
        }
        _ => return Err("Unsupported user action".into()),
    }
    if steps.is_empty() {
        return Err("No user attributes changed".into());
    }
    Ok(steps)
}

fn verified(change: &UserChange, after: &Value) -> bool {
    if change.action == "drop" {
        return after["user"].is_null();
    }
    if after["user"].is_null() {
        return false;
    }
    match change.action.as_str() {
        "lock" => after["locked"] == true,
        "unlock" => after["locked"] == false,
        "create" | "alter" => [
            ("PROFILE", &change.profile),
            ("DEFAULT_TABLESPACE", &change.default_tablespace),
            ("TEMPORARY_TABLESPACE", &change.temporary_tablespace),
        ]
        .iter()
        .all(|(key, value)| value.as_ref().is_none_or(|value| text(&after["user"], key) == *value)),
        "password" => false, // Dictionary status cannot verify authentication with the new secret.
        _ => false,
    }
}

pub async fn oracle_user_admin_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    request: OracleUserRequest,
) -> Result<Value, String> {
    if !matches!(request.operation.as_str(), "read" | "preview" | "apply") {
        return Err("Unsupported user operation".into());
    }
    if request.operation != "apply" && request.password.is_some() {
        return Err("Passwords must not be sent with reads or previews".into());
    }
    let config = connection_config(state, connection_id).await.ok_or("Connection not found")?;
    let oceanbase = match config.db_type {
        DatabaseType::Oracle => false,
        DatabaseType::OceanbaseOracle => true,
        _ => return Err("Oracle-family connection required".into()),
    };
    if request.operation == "apply" && crate::query::connection_readonly_name(state, connection_id).await.is_some() {
        return Err("Connection is read-only".into());
    }
    let key = state
        .get_or_create_metadata_pool_for_session(connection_id, Some(database), None)
        .await
        .map_err(|error| safe_error(&error))?;
    let pool = state.pool_handle(&key).await;
    let Some(PoolKind::Agent(client)) = pool else {
        return Err("Oracle-family Agent required".into());
    };
    let mut client = tokio::time::timeout(METADATA_POOL_ACQUIRE_TIMEOUT, client.lock())
        .await
        .map_err(|_| crate::query::METADATA_POOL_BUSY_ERROR.to_string())?;
    let timeout = agent_metadata_timeout(Some(&config));
    let version = client
        .connection_info(timeout)
        .await
        .ok()
        .and_then(|info| info.database_info)
        .and_then(|info| info.product_version)
        .unwrap_or_default();
    let can_manage = known_version(&version, oceanbase);
    let mut session = SecuritySession { client: &mut client, database, timeout, oceanbase };
    let before = snapshot(&mut session, &request.change).await?;
    if request.operation == "read" {
        return Ok(json!({"snapshot":before,"version":version,"canManage":can_manage,"tablespaces":!oceanbase}));
    }
    if !can_manage {
        return Err("This server version is not enabled for user mutations".into());
    }
    let revision = fingerprint(&json!([request.change, before]));
    let needs_password = matches!(request.change.action.as_str(), "create" | "password");
    if request.operation == "apply" && needs_password && request.password.is_none() {
        return Err("A password is required for this action".into());
    }
    let steps = match plan(&request.change, &before, oceanbase, request.password.as_deref()) {
        Ok(steps) => steps,
        Err(reason) if request.operation == "preview" => return Ok(json!({"blocked":reason,"before":before})),
        Err(reason) => return Err(reason),
    };
    if request.operation == "preview" {
        return Ok(
            json!({"revision":revision,"before":before,"steps":steps.iter().map(|step|json!({"label":step.label,"sql":step.preview})).collect::<Vec<_>>(),"requiresPassword":needs_password}),
        );
    }
    if request.revision.as_deref() != Some(&revision) {
        return Err("User or dependencies changed; preview again".into());
    }
    let mut sent = Vec::new();
    let mut completed = Vec::new();
    let mut error = None;
    for step in steps {
        sent.push(step.label);
        match session.query(&step.sql).await {
            Ok(_) => completed.push(step.label),
            Err(cause) => {
                error = Some(cause);
                break;
            }
        }
    }
    let after = snapshot(&mut session, &request.change).await;
    let outcome = match &after {
        Err(_) => "unverified",
        Ok(_) if error.is_some() => {
            if completed.is_empty() {
                "failed"
            } else {
                "partial"
            }
        }
        Ok(value) if verified(&request.change, value) => "verified",
        Ok(value) if request.change.action == "password" && !value["user"].is_null() => "applied",
        _ => "unverified",
    };
    Ok(
        json!({"outcome":outcome,"sentSteps":sent,"completedSteps":completed,"before":before,"after":after.as_ref().ok(),"readbackError":after.as_ref().err(),"error":error,"authenticationVerified":false,"recoveryHint":"Read the account again before further changes. Sent DDL is not rolled back; password authentication and stored connection credentials require separate verification."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn change(action: &str) -> UserChange {
        UserChange {
            action: action.into(),
            name: "Mixed.\"User".into(),
            profile: None,
            default_tablespace: None,
            temporary_tablespace: None,
        }
    }
    #[test]
    fn preview_never_contains_a_password() {
        let steps = plan(&change("create"), &json!({"user":null}), false, Some("sensitive'中文")).unwrap();
        assert!(steps[0].sql.contains("sensitive'中文"));
        assert!(!steps[0].preview.contains("sensitive"));
        assert!(steps[0].preview.contains("\"Mixed.\"\"User\""));
    }
    #[test]
    fn drop_refuses_owned_objects_or_unknown_checks_and_never_adds_cascade() {
        assert!(plan(
            &change("drop"),
            &json!({"user":{},"dropChecks":true,"objects":[{}],"dependencies":[]}),
            false,
            None
        )
        .is_err());
        assert!(plan(&change("drop"), &json!({"user":{},"objects":[],"dependencies":[]}), false, None).is_err());
        let steps =
            plan(&change("drop"), &json!({"user":{},"dropChecks":true,"objects":[],"dependencies":[]}), false, None)
                .unwrap();
        assert!(!steps[0].sql.contains("CASCADE"));
    }
    #[test]
    fn oceanbase_does_not_inherit_oracle_tablespace_controls() {
        let mut change = change("alter");
        change.default_tablespace = Some("DATA".into());
        assert!(plan(&change, &json!({"user":{}}), true, None).is_err());
    }
    #[test]
    fn unknown_lock_or_password_authentication_cannot_be_verified() {
        assert!(plan(&change("lock"), &json!({"user":{},"locked":null}), false, None).is_err());
        assert!(!verified(&change("unlock"), &json!({"user":{},"locked":null})));
        assert!(!verified(&change("password"), &json!({"user":{},"locked":false})));
    }
}
