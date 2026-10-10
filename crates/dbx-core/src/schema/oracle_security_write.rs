//! Shared transport boundaries for Oracle user and role mutations.
//! Do not derive Debug for credentials or pass these statements through query history.
use crate::db::{agent_driver::AgentDriverClient, QueryResult};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::time::Duration;

pub(super) fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
pub(super) fn identifier(value: &str) -> Result<String, String> {
    if value.is_empty() || value.contains(['\0', '\r', '\n']) {
        return Err("An exact nonempty identifier is required".into());
    }
    Ok(format!("\"{}\"", value.replace('"', "\"\"")))
}
pub(super) fn password(value: &str) -> Result<String, String> {
    if value.is_empty() || value.contains(['\0', '\r', '\n', '"']) {
        return Err("Password is empty or contains a character unsupported by Oracle password syntax".into());
    }
    Ok(format!("\"{value}\""))
}
pub(super) fn safe_error(error: &str) -> String {
    for prefix in ["ORA-", "OB-"] {
        if let Some(index) = error.find(prefix) {
            let code: String = error[index + prefix.len()..].chars().take_while(char::is_ascii_digit).take(8).collect();
            if !code.is_empty() {
                return format!("Account operation failed ({prefix}{code}); credentials are omitted");
            }
        }
    }
    "Account operation failed; credentials and SQL are omitted".into()
}
pub(super) fn fingerprint(value: &Value) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap_or_default()))
}
pub(super) fn text(row: &Value, key: &str) -> String {
    row[key].as_str().map(str::to_owned).unwrap_or_else(|| {
        if row[key].is_null() {
            String::new()
        } else {
            row[key].to_string()
        }
    })
}
pub(super) fn known_version(value: &str, oceanbase: bool) -> bool {
    value.split(|c: char| !c.is_ascii_digit() && c != '.').any(|part| {
        if oceanbase {
            part == "4.2.5" || part.starts_with("4.2.5.")
        } else {
            part.starts_with("19.")
        }
    })
}

pub(super) struct SecuritySession<'a> {
    pub client: &'a mut AgentDriverClient,
    pub database: &'a str,
    pub timeout: Option<Duration>,
    pub oceanbase: bool,
}
impl SecuritySession<'_> {
    pub async fn query(&mut self, sql: &str) -> Result<Vec<Value>, String> {
        let result = self.client.execute_query_with_timeout::<QueryResult>(json!({"database":self.database,"sql":sql,"maxRows":10001,"timeoutSecs":self.timeout.map(|t|t.as_secs()).unwrap_or(0)}), self.timeout).await.map_err(|error| safe_error(&error))?;
        if result.truncated || result.has_more || result.rows.len() > 10000 {
            return Err("Complete account metadata is unavailable; the response was truncated".into());
        }
        Ok(result
            .rows
            .into_iter()
            .map(|row| {
                Value::Object(
                    result.columns.iter().zip(row).map(|(key, value)| (key.to_ascii_uppercase(), value)).collect(),
                )
            })
            .collect())
    }
}

/// Evidence for the executing session, not a claim based on DEFAULT_ROLE or role grants alone.
pub(super) async fn effective_system_privilege(
    session: &mut SecuritySession<'_>,
    actor: &str,
    privilege: &str,
    role_scope: &BTreeSet<String>,
) -> Value {
    if !session.oceanbase {
        let sql = format!("SELECT PRIVILEGE FROM SYS.SESSION_PRIVS WHERE PRIVILEGE = {}", literal(privilege));
        return match session.query(&sql).await {
            Ok(rows) if rows.is_empty() => json!({"state":"absent","source":"SYS.SESSION_PRIVS"}),
            Ok(rows) if rows.iter().all(|row| text(row, "PRIVILEGE") == privilege) => {
                json!({"state":"present","source":"SYS.SESSION_PRIVS"})
            }
            Ok(_) => {
                json!({"state":"unknown","source":"SYS.SESSION_PRIVS","reason":"Unexpected session privilege response"})
            }
            Err(reason) => json!({"state":"unknown","source":"SYS.SESSION_PRIVS","reason":reason}),
        };
    }

    // USER_SYS_PRIVS confirms direct grants independently of role visibility.
    // OB 4.2.5 role dictionaries cannot establish the executing session's enabled roles.
    let direct_sql = format!(
        "SELECT USERNAME, PRIVILEGE FROM SYS.USER_SYS_PRIVS WHERE USERNAME = {} AND PRIVILEGE = {}",
        literal(actor),
        literal(privilege)
    );
    let direct_unknown = match session.query(&direct_sql).await {
        Ok(rows) if rows.is_empty() => None,
        Ok(rows) if rows.iter().all(|row| text(row, "USERNAME") == actor && text(row, "PRIVILEGE") == privilege) => {
            return json!({"state":"present","source":"SYS.USER_SYS_PRIVS/direct","grantee":actor});
        }
        Ok(_) => Some("Unexpected direct privilege response".to_string()),
        Err(reason) => Some(reason),
    };
    if role_scope.iter().any(String::is_empty) || !role_scope.contains(actor) || !role_scope.contains("PUBLIC") {
        return json!({"state":"unknown","source":"SYS.DBA_SYS_PRIVS","reason":"Complete privilege grantee scope is unavailable"});
    }
    let scope = role_scope.iter().map(|name| literal(name)).collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT GRANTEE, PRIVILEGE FROM SYS.DBA_SYS_PRIVS WHERE GRANTEE IN ({scope}) AND PRIVILEGE = {} ORDER BY GRANTEE", literal(privilege));
    let rows = match session.query(&sql).await {
        Ok(rows) => rows,
        Err(reason) => return json!({"state":"unknown","source":"SYS.DBA_SYS_PRIVS","reason":reason}),
    };
    if rows.iter().any(|row| text(row, "PRIVILEGE") != privilege || !role_scope.contains(&text(row, "GRANTEE"))) {
        return json!({"state":"unknown","source":"SYS.DBA_SYS_PRIVS","reason":"Unexpected privilege grantee or value"});
    }
    if rows.iter().any(|row| text(row, "GRANTEE") == actor) {
        return json!({"state":"present","source":"SYS.DBA_SYS_PRIVS/direct","grantee":actor});
    }
    let roles: BTreeSet<String> = rows.iter().map(|row| text(row, "GRANTEE")).collect();
    if roles.is_empty() && direct_unknown.is_none() {
        json!({"state":"absent","source":"SYS.USER_SYS_PRIVS/SYS.DBA_SYS_PRIVS"})
    } else {
        json!({"state":"unknown","source":"SYS.USER_SYS_PRIVS/SYS.DBA_SYS_PRIVS","roleCandidates":roles,"directUnknown":direct_unknown,"reason":"Cannot confirm effective session privilege from role grant metadata"})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_and_passwords_have_separate_quoting_rules() {
        assert_eq!(identifier("Mixed.\"Name").unwrap(), "\"Mixed.\"\"Name\"");
        assert_eq!(password("a'b;密码").unwrap(), "\"a'b;密码\"");
        assert!(password("secret\"value").is_err());
        assert!(password("secret\nvalue").is_err());
    }
    #[test]
    fn driver_diagnostics_cannot_echo_credentials() {
        let value = safe_error("ORA-28003 password-secret CREATE USER X IDENTIFIED BY password-secret");
        assert!(value.contains("ORA-28003"));
        assert!(!value.contains("password-secret"));
        assert!(!value.contains("CREATE USER"));
        assert_eq!(safe_error("secret driver exception"), "Account operation failed; credentials and SQL are omitted");
    }
}
