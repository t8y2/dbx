use super::oracle_security_write::{
    effective_system_privilege, fingerprint, identifier, known_version, literal, password, safe_error, text,
    SecuritySession,
};
use super::{agent_metadata_timeout, connection_config, lock_metadata_mutex_with_timeout};
use crate::connection::{AppState, PoolKind, METADATA_POOL_ACQUIRE_TIMEOUT};
use crate::models::connection::DatabaseType;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleChange {
    action: String,
    principal: String,
    kind: Option<String>,
    privilege: Option<String>,
    role: Option<String>,
    owner: Option<String>,
    object_name: Option<String>,
    column: Option<String>,
    grantor: Option<String>,
    authentication: Option<String>,
    #[serde(default)]
    option: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OracleRoleRequest {
    operation: String,
    change: RoleChange,
    revision: Option<String>,
    password: Option<String>,
}
struct RoleStep {
    sql: String,
    preview: String,
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn closure(principal: &str, graph: &[Value], include_public: bool) -> Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::from([principal.to_string()]);
    if include_public {
        names.insert("PUBLIC".into());
    }
    loop {
        let additions: Vec<String> = graph
            .iter()
            .filter(|row| names.contains(&text(row, "GRANTEE")))
            .map(|row| text(row, "GRANTED_ROLE"))
            .filter(|role| !role.is_empty() && !names.contains(role))
            .collect();
        if additions.is_empty() {
            return Ok(names);
        }
        names.extend(additions);
        if names.len() > 1000 {
            return Err("Role inheritance exceeds the complete traversal limit".into());
        }
    }
}
async fn snapshot(session: &mut SecuritySession<'_>, change: &RoleChange) -> Result<Value, String> {
    identifier(&change.principal)?;
    let roles = session.query("SELECT ROLE, PASSWORD_REQUIRED FROM DBA_ROLES ORDER BY ROLE").await?;
    let graph = session.query("SELECT GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE FROM DBA_ROLE_PRIVS ORDER BY GRANTEE, GRANTED_ROLE").await?;
    let names = closure(&change.principal, &graph, true)?;
    let scope = names.iter().map(|name| literal(name)).collect::<Vec<_>>().join(", ");
    let users = session.query(&format!("SELECT USERNAME, TO_CHAR(USER_ID) AS USER_ID, TO_CHAR(CREATED, 'YYYY-MM-DD HH24:MI:SS') AS CREATED FROM DBA_USERS WHERE USERNAME = {}",literal(&change.principal))).await?;
    let principal_exists = change.principal == "PUBLIC"
        || !users.is_empty()
        || roles.iter().any(|row| text(row, "ROLE") == change.principal);
    let current = session.query("SELECT USER AS ACTOR FROM DUAL").await?;
    let actor = current
        .first()
        .map(|row| text(row, "ACTOR"))
        .filter(|value| !value.is_empty())
        .ok_or("Current user is unavailable")?;
    let system = session.query(&format!("SELECT GRANTEE, PRIVILEGE, ADMIN_OPTION FROM DBA_SYS_PRIVS WHERE GRANTEE IN ({scope}) ORDER BY GRANTEE, PRIVILEGE")).await?;
    let mut object = Value::Null;
    let mut columns = Vec::new();
    let mut dependencies = Vec::new();
    let object_filter = if change.kind.as_deref() == Some("object") {
        let owner = change.owner.as_deref().ok_or("Object owner required")?;
        let name = change.object_name.as_deref().ok_or("Object name required")?;
        identifier(owner)?;
        identifier(name)?;
        let objects = session.query(&format!("SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, TO_CHAR(OBJECT_ID) AS OBJECT_ID FROM DBA_OBJECTS WHERE OWNER = {} AND OBJECT_NAME = {} AND OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW','SEQUENCE','PROCEDURE','FUNCTION','PACKAGE','TYPE')",literal(owner),literal(name))).await?;
        if objects.len() > 1 {
            return Err("Object identity is ambiguous".into());
        }
        object = objects.first().cloned().unwrap_or(Value::Null);
        dependencies = session.query(&format!("SELECT OWNER, NAME, TYPE FROM DBA_DEPENDENCIES WHERE REFERENCED_OWNER = {} AND REFERENCED_NAME = {} ORDER BY OWNER, NAME, TYPE",literal(owner),literal(name))).await?;
        if let Some(column) = &change.column {
            columns = session
                .query(&format!(
                    "SELECT COLUMN_NAME FROM DBA_TAB_COLUMNS WHERE OWNER = {} AND TABLE_NAME = {} AND COLUMN_NAME = {}",
                    literal(owner),
                    literal(name),
                    literal(column)
                ))
                .await?;
        }
        format!("OWNER = {} AND TABLE_NAME = {}", literal(owner), literal(name))
    } else {
        format!("GRANTEE IN ({scope})")
    };
    let objects = session.query(&format!("SELECT GRANTEE, OWNER, TABLE_NAME, GRANTOR, PRIVILEGE, GRANTABLE FROM DBA_TAB_PRIVS WHERE {object_filter} ORDER BY OWNER, TABLE_NAME, GRANTEE, PRIVILEGE, GRANTOR")).await?;
    let column_grants = session.query(&format!("SELECT GRANTEE, OWNER, TABLE_NAME, COLUMN_NAME, GRANTOR, PRIVILEGE, GRANTABLE FROM DBA_COL_PRIVS WHERE {object_filter} ORDER BY OWNER, TABLE_NAME, COLUMN_NAME, GRANTEE, PRIVILEGE, GRANTOR")).await?;
    let program_roles = if !session.oceanbase && change.action == "dropRole" {
        session.query(&format!("SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, ROLE FROM DBA_CODE_ROLE_PRIVS WHERE ROLE = {} ORDER BY OWNER, OBJECT_NAME, OBJECT_TYPE",literal(&change.principal))).await?
    } else {
        Vec::new()
    };
    let grant_any = if change.action == "revoke"
        && change.kind.as_deref() == Some("object")
        && change.grantor.as_deref().is_some_and(|grantor| grantor != actor)
        && change.grantor == change.owner
    {
        let mut role_scope: BTreeSet<String> = roles.iter().map(|row| text(row, "ROLE")).collect();
        role_scope.extend([actor.clone(), "PUBLIC".into()]);
        effective_system_privilege(session, &actor, "GRANT ANY OBJECT PRIVILEGE", &role_scope).await
    } else {
        json!({"state":"notRequired","reason":"This operation does not delegate an object-owner grant revocation"})
    };
    Ok(
        json!({"actor":actor,"grantAnyObject":grant_any,"principalExists":principal_exists,"principalUsers":users,"roles":roles,"roleGrants":graph,"systemGrants":system,"objectGrants":objects,"columnGrants":column_grants,"object":object,"columns":columns,"scope":names,"dependencies":dependencies,"programRoles":program_roles}),
    )
}
fn privilege(change: &RoleChange) -> Result<String, String> {
    let value = change.privilege.as_deref().unwrap_or("").trim().to_ascii_uppercase();
    if value.is_empty()
        || value == "ALL"
        || value == "ALL PRIVILEGES"
        || value.split(' ').any(str::is_empty)
        || !value.chars().all(|c| c.is_ascii_uppercase() || c == ' ')
    {
        return Err(
            "Specify one explicit privilege using letters and spaces; ALL and SQL fragments are not supported".into()
        );
    }
    Ok(value)
}
fn relevant(change: &RoleChange, row: &Value) -> bool {
    match change.kind.as_deref() {
        Some("role") => text(row, "GRANTED_ROLE") == change.role.as_deref().unwrap_or(""),
        Some("system") => {
            text(row, "PRIVILEGE") == change.privilege.as_deref().unwrap_or("").trim().to_ascii_uppercase()
        }
        Some("object") => {
            text(row, "OWNER") == change.owner.as_deref().unwrap_or("")
                && text(row, "TABLE_NAME") == change.object_name.as_deref().unwrap_or("")
                && text(row, "PRIVILEGE") == change.privilege.as_deref().unwrap_or("").trim().to_ascii_uppercase()
                && change.column.as_ref().is_none_or(|column| text(row, "COLUMN_NAME") == *column)
        }
        _ => false,
    }
}
fn grants<'a>(change: &RoleChange, before: &'a Value) -> &'a [Value] {
    array(
        before,
        match change.kind.as_deref() {
            Some("role") => "roleGrants",
            Some("system") => "systemGrants",
            Some("object") if change.column.is_some() => "columnGrants",
            _ => "objectGrants",
        },
    )
}
fn direct<'a>(change: &RoleChange, before: &'a Value) -> Vec<&'a Value> {
    grants(change, before)
        .iter()
        .filter(|row| {
            text(row, "GRANTEE") == change.principal
                && relevant(change, row)
                && change.grantor.as_ref().is_none_or(|grantor| text(row, "GRANTOR") == *grantor)
        })
        .collect()
}
fn sources(change: &RoleChange, snapshot: &Value) -> Result<Vec<Value>, String> {
    let names = closure(&change.principal, array(snapshot, "roleGrants"), true)?;
    Ok(grants(change,snapshot).iter().filter(|row| names.contains(&text(row,"GRANTEE")) && relevant(change,row)).map(|row|json!({"source":if text(row,"GRANTEE") == change.principal {"direct"} else if text(row,"GRANTEE") == "PUBLIC" {"public"} else {"role"},"grant":row})).collect())
}
fn plan(change: &RoleChange, before: &Value, secret: Option<&str>) -> Result<RoleStep, String> {
    let principal = if change.principal == "PUBLIC" { "PUBLIC".into() } else { identifier(&change.principal)? };
    let existing_role = array(before, "roles").iter().find(|row| text(row, "ROLE") == change.principal);
    if matches!(change.action.as_str(), "createRole" | "alterRole" | "dropRole") {
        if change.action == "createRole" && before["principalExists"] == true {
            return Err("A user or role already has this name".into());
        }
        if change.action != "createRole" && existing_role.is_none() {
            return Err("The role does not exist".into());
        }
        if change.action == "dropRole" {
            let sql = format!("DROP ROLE {principal}");
            return Ok(RoleStep { preview: sql.clone(), sql });
        }
        let command = if change.action == "createRole" { "CREATE" } else { "ALTER" };
        return match change.authentication.as_deref() {
            Some("none") => {
                let sql = format!("{command} ROLE {principal} NOT IDENTIFIED");
                Ok(RoleStep { preview: sql.clone(), sql })
            }
            Some("password") => Ok(RoleStep {
                sql: format!(
                    "{command} ROLE {principal} IDENTIFIED BY {}",
                    secret.map(password).transpose()?.unwrap_or_else(|| "\"<password omitted>\"".into())
                ),
                preview: format!("{command} ROLE {principal} IDENTIFIED BY \"<password omitted>\""),
            }),
            _ => Err("Only local password or no-password role authentication is supported".into()),
        };
    }
    if !matches!(change.action.as_str(), "grant" | "revoke") || before["principalExists"] != true {
        return Err("Select an existing principal and a grant/revoke action".into());
    }
    let revoke = change.action == "revoke";
    let direct_rows = direct(change, before);
    if revoke && direct_rows.is_empty() {
        return Err(
            "No matching direct grant exists; inherited or PUBLIC privileges cannot be revoked from this principal"
                .into(),
        );
    }
    let option_key = if change.kind.as_deref() == Some("object") { "GRANTABLE" } else { "ADMIN_OPTION" };
    if !revoke && !change.option && direct_rows.iter().any(|row| text(row, option_key) == "YES") {
        return Err("Removing an authorization option requires an explicit revoke/regrant plan; it will not be changed implicitly".into());
    }
    let subject = match change.kind.as_deref() {
        Some("role") => {
            let role = change.role.as_deref().ok_or("Role name required")?;
            if !array(before, "roles").iter().any(|row| text(row, "ROLE") == role) {
                return Err("The granted role does not exist".into());
            }
            if !revoke && closure(role, array(before, "roleGrants"), false)?.contains(&change.principal) {
                return Err("The role grant would create a cycle".into());
            }
            identifier(role)?
        }
        Some("system") => privilege(change)?,
        Some("object") => {
            if before["object"].is_null() {
                return Err("The exact object is missing or is not supported".into());
            }
            let value = privilege(change)?;
            let kind = text(&before["object"], "OBJECT_TYPE");
            let allowed = match kind.as_str() {
                "TABLE" | "VIEW" | "MATERIALIZED VIEW" => matches!(
                    value.as_str(),
                    "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "REFERENCES" | "ALTER" | "INDEX"
                ),
                "SEQUENCE" => matches!(value.as_str(), "SELECT" | "ALTER"),
                "PROCEDURE" | "FUNCTION" | "PACKAGE" => value == "EXECUTE",
                "TYPE" => matches!(value.as_str(), "EXECUTE" | "DEBUG" | "UNDER"),
                _ => false,
            };
            if !allowed {
                return Err("This object/privilege combination is not supported by the editor".into());
            }
            if change.option && array(before, "roles").iter().any(|row| text(row, "ROLE") == change.principal) {
                return Err("WITH GRANT OPTION cannot be granted to a role".into());
            }
            if revoke {
                if change.column.is_some() {
                    return Err(
                        "Column-only revocation needs a separate full-privilege plan; it will not broaden this request"
                            .into(),
                    );
                }
                let grantor = change
                    .grantor
                    .as_deref()
                    .ok_or("Select the exact direct grantor before revoking an object privilege")?;
                if grantor != text(before, "actor") {
                    if Some(grantor) != change.owner.as_deref() {
                        return Err("The REVOKE cannot target the selected grantor; delegated revocation only targets the object-owner grant".into());
                    }
                    match before["grantAnyObject"]["state"].as_str() {
                        Some("present") => {}
                        Some("absent") => return Err("The current session does not have GRANT ANY OBJECT PRIVILEGE to revoke the object-owner grant".into()),
                        _ => return Err("Cannot confirm the current session's GRANT ANY OBJECT PRIVILEGE; inspect the permission evidence and prepare a fresh preview".into()),
                    }
                }
            }
            let column = if let Some(column) = &change.column {
                if !matches!(value.as_str(), "INSERT" | "UPDATE" | "REFERENCES") || array(before, "columns").len() != 1
                {
                    return Err("Column grants require an existing column and INSERT, UPDATE or REFERENCES".into());
                }
                format!(" ({})", identifier(column)?)
            } else {
                String::new()
            };
            format!(
                "{value}{column} ON {}.{}",
                identifier(change.owner.as_deref().unwrap_or(""))?,
                identifier(change.object_name.as_deref().unwrap_or(""))?
            )
        }
        _ => return Err("Unknown grant kind".into()),
    };
    let sql = if revoke {
        format!("REVOKE {subject} FROM {principal}")
    } else {
        format!(
            "GRANT {subject} TO {principal}{}",
            if !change.option {
                ""
            } else if change.kind.as_deref() == Some("object") {
                " WITH GRANT OPTION"
            } else {
                " WITH ADMIN OPTION"
            }
        )
    };
    Ok(RoleStep { preview: sql.clone(), sql })
}
fn verified(change: &RoleChange, after: &Value) -> bool {
    let role = array(after, "roles").iter().find(|row| text(row, "ROLE") == change.principal);
    match change.action.as_str() {
        "dropRole" => {
            role.is_none()
                && !array(after, "roleGrants").iter().any(|row| {
                    text(row, "GRANTEE") == change.principal || text(row, "GRANTED_ROLE") == change.principal
                })
        }
        "createRole" | "alterRole" => role.is_some_and(|row| {
            text(row, "PASSWORD_REQUIRED")
                == if change.authentication.as_deref() == Some("password") { "YES" } else { "NO" }
        }),
        "revoke" => direct(change, after).is_empty(),
        "grant" => direct(change, after).iter().any(|row| {
            !change.option
                || text(row, if change.kind.as_deref() == Some("object") { "GRANTABLE" } else { "ADMIN_OPTION" })
                    == "YES"
        }),
        _ => false,
    }
}

pub async fn oracle_role_admin_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    request: OracleRoleRequest,
) -> Result<Value, String> {
    if !matches!(request.operation.as_str(), "read" | "preview" | "apply") {
        return Err("Unknown role operation".into());
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
    let mut session = SecuritySession { client: &mut client, database, timeout, oceanbase };
    execute_role_request(&mut session, request, &version).await
}

async fn execute_role_request(
    session: &mut SecuritySession<'_>,
    request: OracleRoleRequest,
    version: &str,
) -> Result<Value, String> {
    let before = snapshot(session, &request.change).await?;
    if request.operation == "read" {
        return Ok(json!({"snapshot":before,"sources":sources(&request.change,&before)?}));
    }
    if !known_version(version, session.oceanbase) {
        return Err("This version is not enabled for role mutations".into());
    }
    let needs_password = matches!(request.change.action.as_str(), "createRole" | "alterRole")
        && request.change.authentication.as_deref() == Some("password");
    if request.operation == "apply" && needs_password && request.password.is_none() {
        return Err("Role password required".into());
    }
    let step = match plan(&request.change, &before, request.password.as_deref()) {
        Ok(step) => step,
        Err(reason) if request.operation == "preview" => {
            return Ok(json!({"blocked":reason,"before":before,"sources":sources(&request.change,&before)?}))
        }
        Err(reason) => return Err(reason),
    };
    let revision = fingerprint(&json!([request.change, before]));
    if request.operation == "preview" {
        return Ok(
            json!({"revision":revision,"before":before,"sources":sources(&request.change,&before)?,"steps":[{"label":request.change.action,"sql":step.preview}],"requiresPassword":needs_password,"impact":"Revoking object privileges may cascade through dependent grants. Role deletion removes memberships and role privileges. Other direct, role or PUBLIC paths may still provide access; current session role activation is not inferred."}),
        );
    }
    if request.revision.as_deref() != Some(&revision) {
        return Err("Grant state changed; prepare a fresh preview".into());
    }
    let execution = session.query(&step.sql).await;
    let after = snapshot(session, &request.change).await;
    let outcome = match &after {
        Err(_) => "unverified",
        Ok(_) if execution.is_err() => "failed",
        Ok(value) if verified(&request.change, value) => {
            if needs_password {
                "applied"
            } else {
                "verified"
            }
        }
        _ => "unverified",
    };
    Ok(
        json!({"outcome":outcome,"sentSteps":[request.change.action],"completedSteps":if execution.is_ok() {vec![request.change.action.clone()]} else {Vec::new()},"before":before,"after":after.as_ref().ok(),"remainingSources":after.as_ref().ok().and_then(|value|sources(&request.change,value).ok()),"error":execution.err(),"readbackError":after.as_ref().err(),"authenticationVerified":false,"recoveryHint":"Refresh before further changes. Sent DDL is not rolled back. Recreating a deleted role does not automatically restore its memberships or grants."}),
    )
}

#[cfg(test)]
mod agent_tests;

#[cfg(test)]
mod tests {
    use super::*;
    fn change(action: &str, kind: &str) -> RoleChange {
        RoleChange {
            action: action.into(),
            principal: "User.中文".into(),
            kind: Some(kind.into()),
            privilege: Some("SELECT".into()),
            role: Some("R".into()),
            owner: Some("Owner.X".into()),
            object_name: Some("T\"Q".into()),
            column: None,
            grantor: Some("Owner.X".into()),
            authentication: None,
            option: false,
        }
    }
    fn before() -> Value {
        json!({"actor":"Owner.X","principalExists":true,"roles":[],"roleGrants":[],"systemGrants":[],"objectGrants":[],"columnGrants":[],"object":{"OBJECT_TYPE":"TABLE"}})
    }
    #[test]
    fn quoted_object_grants_preserve_each_identity() {
        assert_eq!(
            plan(&change("grant", "object"), &before(), None).unwrap().sql,
            "GRANT SELECT ON \"Owner.X\".\"T\"\"Q\" TO \"User.中文\""
        );
    }
    #[test]
    fn inherited_grants_cannot_be_revoked_as_direct_grants() {
        let mut value = before();
        value["roleGrants"] = json!([{"GRANTEE":"User.中文","GRANTED_ROLE":"R"}]);
        value["systemGrants"] = json!([{"GRANTEE":"R","PRIVILEGE":"CREATE SESSION"}]);
        let mut request = change("revoke", "system");
        request.privilege = Some("CREATE SESSION".into());
        request.grantor = None;
        assert!(plan(&request, &value, None).is_err());
        assert_eq!(sources(&request, &value).unwrap()[0]["source"], "role");
    }
    #[test]
    fn privileges_cannot_inject_sql_or_expand_to_all() {
        for value in ["SELECT; DROP USER X", "ALL PRIVILEGES", "SELECT, UPDATE"] {
            let mut request = change("grant", "system");
            request.privilege = Some(value.into());
            assert!(plan(&request, &before(), None).is_err());
        }
    }
    #[test]
    fn column_revoke_does_not_broaden_to_full_object_revoke() {
        let mut request = change("revoke", "object");
        request.column = Some("C".into());
        request.privilege = Some("UPDATE".into());
        let mut value = before();
        value["columnGrants"] = json!([{"GRANTEE":"User.中文","OWNER":"Owner.X","TABLE_NAME":"T\"Q","COLUMN_NAME":"C","GRANTOR":"Owner.X","PRIVILEGE":"UPDATE"}]);
        assert!(plan(&request, &value, None).err().unwrap().contains("Column-only"));
    }
    #[test]
    fn cycles_terminate_and_remaining_public_paths_are_kept() {
        let graph = json!([{"GRANTEE":"U","GRANTED_ROLE":"A"},{"GRANTEE":"A","GRANTED_ROLE":"B"},{"GRANTEE":"B","GRANTED_ROLE":"A"}]);
        assert_eq!(closure("U", graph.as_array().unwrap(), true).unwrap().len(), 4);
    }
    #[test]
    fn role_password_preview_never_contains_the_secret() {
        let mut request = change("createRole", "role");
        request.authentication = Some("password".into());
        let step = plan(&request, &json!({"principalExists":false,"roles":[]}), Some("role-secret")).unwrap();
        assert!(step.sql.contains("role-secret"));
        assert!(!step.preview.contains("role-secret"));
    }
    #[test]
    fn revoking_a_direct_grant_keeps_a_remaining_public_source() {
        let request = change("revoke", "object");
        let mut after = before();
        after["objectGrants"] = json!([{"GRANTEE":"PUBLIC","OWNER":"Owner.X","TABLE_NAME":"T\"Q","GRANTOR":"Owner.X","PRIVILEGE":"SELECT"}]);
        assert!(verified(&request, &after));
        assert_eq!(sources(&request, &after).unwrap()[0]["source"], "public");
    }
    #[test]
    fn grant_option_is_not_implicitly_downgraded() {
        let request = change("grant", "object");
        let mut value = before();
        value["objectGrants"] = json!([{"GRANTEE":"User.中文","OWNER":"Owner.X","TABLE_NAME":"T\"Q","GRANTOR":"Owner.X","PRIVILEGE":"SELECT","GRANTABLE":"YES"}]);
        assert!(plan(&request, &value, None).err().unwrap().contains("revoke/regrant"));
    }
    #[test]
    fn a_role_cycle_is_rejected_before_dispatch() {
        let mut request = change("grant", "role");
        request.principal = "B".into();
        request.role = Some("A".into());
        request.grantor = None;
        let value = json!({"principalExists":true,"roles":[{"ROLE":"A"},{"ROLE":"B"}],"roleGrants":[{"GRANTEE":"A","GRANTED_ROLE":"B"}]});
        assert!(plan(&request, &value, None).err().unwrap().contains("cycle"));
    }
    #[test]
    fn a_changed_direct_grant_changes_the_preview_fingerprint() {
        let first = json!({"systemGrants":[{"GRANTEE":"U","PRIVILEGE":"CREATE SESSION","ADMIN_OPTION":"NO"}]});
        let mut second = first.clone();
        second["systemGrants"][0]["ADMIN_OPTION"] = json!("YES");
        assert_ne!(fingerprint(&first), fingerprint(&second));
    }
}
