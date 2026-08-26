use crate::connection::{AppState, PoolKind};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

use crate::db::ldap_driver;

/// LDAP search back-end. Native simple bind uses the `ldap3` pool; GSSAPI
/// connections are routed to the Java LDAP agent (JNDI + JAAS) and so
/// dispatch via the generic agent pool.
pub async fn ldap_search_core(
    state: &AppState,
    connection_id: &str,
    base_dn: &str,
    scope: &str,
    filter: &str,
    attributes: Option<&[String]>,
    size_limit: Option<i32>,
) -> Result<Value, String> {
    dispatch_ldap_search(state, connection_id, base_dn, scope, filter, attributes, size_limit).await
}

/// Read the children of a base DN (`scope = one`, `filter = (objectClass=*)`)
/// using the same contract used by the sidebar tree builder.
pub async fn ldap_list_children_core(
    state: &AppState,
    connection_id: &str,
    base_dn: &str,
    size_limit: Option<i32>,
) -> Result<Value, String> {
    dispatch_ldap_search(state, connection_id, base_dn, "one", "(objectClass=*)", None, size_limit).await
}

/// Resolve the connection pool and run the search against whichever backend
/// the pool holds (native `ldap3` client or the Java agent), returning the
/// same JSON shape from both.
async fn dispatch_ldap_search(
    state: &AppState,
    connection_id: &str,
    base_dn: &str,
    scope: &str,
    filter: &str,
    attributes: Option<&[String]>,
    size_limit: Option<i32>,
) -> Result<Value, String> {
    state.get_or_create_pool(connection_id, None).await?;
    // Copy out the data we need while holding the read lock, then drop the
    // lock before any async work.
    enum Dispatch {
        Native(Arc<ldap_driver::LdapClient>),
        Agent(Arc<crate::db::agent_driver::PooledAgentClient>),
    }
    let dispatch = {
        let connections = state.connections.read().await;
        match connections.get(connection_id) {
            Some(PoolKind::Ldap(client)) => Dispatch::Native(client.clone()),
            Some(PoolKind::Agent(client)) => Dispatch::Agent(client.clone()),
            _ => return Err("Not an LDAP connection".to_string()),
        }
    };
    match dispatch {
        Dispatch::Native(client) => {
            let result = ldap_driver::search(
                &client,
                base_dn,
                scope,
                filter,
                attributes,
                size_limit,
                Some(Duration::from_secs(60)),
            )
            .await?;
            Ok(ldap_driver::output_to_json(result))
        }
        Dispatch::Agent(client) => {
            let mut agent = client.lock().await;
            let mut params = serde_json::json!({
                "base_dn": base_dn,
                "scope": scope,
                "filter": filter,
            });
            if let Some(attrs) = attributes {
                params["attributes"] = serde_json::json!(attrs);
            }
            if let Some(limit) = size_limit {
                params["size_limit"] = serde_json::json!(limit);
            }
            let result: Value = agent.call_with_timeout("ldap_search", params, Some(Duration::from_secs(60))).await?;
            Ok(result)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ldap_driver::{LdapEntryOutput, LdapSearchOutput};
    use serde_json::{Map, Value};

    #[test]
    fn output_to_json_matches_java_agent_shape() {
        // The web layer expects the same JSON the Java agent used to emit:
        // { entries: [{ dn, attributes: {...} }], count, truncated }
        let output = LdapSearchOutput {
            entries: vec![LdapEntryOutput {
                dn: "CN=Alice,DC=corp,DC=com".into(),
                attributes: {
                    let mut map = Map::new();
                    map.insert("cn".into(), Value::String("Alice".into()));
                    map.insert("memberOf".into(), Value::Array(vec![Value::String("admins".into())]));
                    map
                },
            }],
            count: 1,
            truncated: false,
        };
        let value = ldap_driver::output_to_json(output);
        assert_eq!(value["count"], 1);
        assert_eq!(value["truncated"], false);
        assert_eq!(value["entries"][0]["dn"], "CN=Alice,DC=corp,DC=com");
        assert_eq!(value["entries"][0]["attributes"]["cn"], "Alice");
        assert_eq!(value["entries"][0]["attributes"]["memberOf"][0], "admins");
    }

    #[test]
    fn empty_search_returns_zero_count() {
        let value = ldap_driver::output_to_json(LdapSearchOutput { entries: Vec::new(), count: 0, truncated: false });
        assert_eq!(value["count"], 0);
        assert!(value["entries"].as_array().unwrap().is_empty());
    }
}
