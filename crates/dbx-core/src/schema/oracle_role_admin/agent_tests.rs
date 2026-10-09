use super::*;
use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec};
use std::time::Duration;

struct Fixture {
    client: AgentDriverClient,
    directory: tempfile::TempDir,
    oceanbase: bool,
}

impl Fixture {
    async fn new(config: Value, oceanbase: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/oracle_role_agent.py");
        let python = if cfg!(windows) { "python" } else { "python3" };
        let client = AgentDriverClient::spawn(AgentLaunchSpec::new(python).with_args([
            script.to_string_lossy().to_string(),
            directory.path().join("queries.json").to_string_lossy().to_string(),
            config.to_string(),
        ]))
        .await
        .unwrap();
        Self { client, directory, oceanbase }
    }

    async fn request(
        &mut self,
        operation: &str,
        change: &RoleChange,
        revision: Option<String>,
    ) -> Result<Value, String> {
        let mut session = SecuritySession {
            client: &mut self.client,
            database: "test-service",
            timeout: Some(Duration::from_secs(3)),
            oceanbase: self.oceanbase,
        };
        execute_role_request(
            &mut session,
            OracleRoleRequest { operation: operation.into(), change: change.clone(), revision, password: None },
            if self.oceanbase { "4.2.5.7" } else { "19.26.0" },
        )
        .await
    }

    fn queries(&self) -> Vec<String> {
        serde_json::from_slice(&std::fs::read(self.directory.path().join("queries.json")).unwrap()).unwrap()
    }

    fn no_mutations(&self) {
        assert!(self.queries().iter().all(|sql| sql.starts_with("SELECT ")));
    }
}

fn change(action: &str, kind: &str) -> RoleChange {
    RoleChange {
        action: action.into(),
        principal: "U".into(),
        kind: Some(kind.into()),
        privilege: Some("SELECT".into()),
        role: Some("R".into()),
        owner: Some("Owner".into()),
        object_name: Some("T".into()),
        column: None,
        grantor: Some("Owner".into()),
        authentication: None,
        option: false,
    }
}

#[tokio::test]
async fn ob_role_and_system_previews_do_not_depend_on_session_privilege_views() {
    let mut fixture = Fixture::new(json!({"permissionError":true}), true).await;
    let mut role = change("createRole", "role");
    role.principal = "NewRole".into();
    role.authentication = Some("none".into());
    let preview = fixture.request("preview", &role, None).await.unwrap();
    assert!(preview["blocked"].is_null());
    assert!(preview["revision"].is_string());
    let read = fixture.request("read", &role, None).await.unwrap();
    assert_eq!(read["snapshot"]["grantAnyObject"]["state"], "notRequired");
    let mut system = change("grant", "system");
    system.privilege = Some("CREATE SESSION".into());
    system.grantor = None;
    let preview = fixture.request("preview", &system, None).await.unwrap();
    assert!(preview["blocked"].is_null());
    assert!(preview["revision"].is_string());
    assert!(fixture.queries().iter().all(|sql| !sql.contains("SESSION_PRIVS")
        && !sql.contains("SESSION_ROLES")
        && !sql.contains("IS_ENABLED_ROLE")
        && !sql.contains("SYS.DBA_SYS_PRIVS")));
    fixture.no_mutations();
}

#[tokio::test]
async fn ob_current_grantor_can_revoke_without_session_or_delegation_dictionary_queries() {
    let mut fixture = Fixture::new(json!({"actor":"Owner","permissionError":true}), true).await;
    let change = change("revoke", "object");
    let preview = fixture.request("preview", &change, None).await.unwrap();
    assert_eq!(preview["before"]["grantAnyObject"]["state"], "notRequired");
    let result = fixture.request("apply", &change, preview["revision"].as_str().map(str::to_owned)).await.unwrap();
    assert_eq!(result["outcome"], "verified");
    assert_eq!(result["completedSteps"], json!(["revoke"]));
    assert!(fixture.queries().iter().all(|sql| !sql.contains("SESSION_PRIVS")
        && !sql.contains("SESSION_ROLES")
        && !sql.contains("SYS.DBA_SYS_PRIVS")));
}

#[tokio::test]
async fn ob_unprivileged_delegate_is_denied_before_ddl() {
    let mut fixture = Fixture::new(json!({}), true).await;
    let preview = fixture.request("preview", &change("revoke", "object"), None).await.unwrap();
    assert_eq!(preview["before"]["grantAnyObject"]["state"], "absent");
    assert!(preview["blocked"].as_str().unwrap().contains("does not have"));
    fixture.no_mutations();
}

#[tokio::test]
async fn ob_confirmed_direct_system_privilege_allows_owner_grant_revocation_by_non_owner() {
    let mut fixture = Fixture::new(json!({"directPrivilege":true,"roleDictionaryError":true}), true).await;
    let change = change("revoke", "object");
    let preview = fixture.request("preview", &change, None).await.unwrap();
    assert_eq!(preview["before"]["grantAnyObject"]["state"], "present");
    assert_eq!(preview["before"]["grantAnyObject"]["source"], "SYS.USER_SYS_PRIVS/direct");
    let result = fixture.request("apply", &change, preview["revision"].as_str().map(str::to_owned)).await.unwrap();
    assert_eq!(result["outcome"], "verified");
    assert!(fixture.queries().iter().any(|sql| sql == "REVOKE SELECT ON \"Owner\".\"T\" FROM \"U\""));
    assert!(fixture.queries().iter().all(|sql| !sql.contains("SESSION_PRIVS") && !sql.contains("SESSION_ROLES")));
}

#[tokio::test]
async fn ob_role_grants_require_actual_session_activation_evidence() {
    let mut fixture = Fixture::new(json!({"rolePrivilege":true}), true).await;
    let preview = fixture.request("preview", &change("revoke", "object"), None).await.unwrap();
    assert_eq!(preview["before"]["grantAnyObject"]["state"], "unknown");
    assert_eq!(preview["before"]["roleGrants"][0]["DEFAULT_ROLE"], "YES");
    assert!(preview["blocked"].is_string());
    assert!(fixture.queries().iter().all(|sql| !sql.contains("IS_ENABLED_ROLE(")));
    fixture.no_mutations();
}

#[tokio::test]
async fn ob_role_candidates_remain_unknown_without_current_dictionary_membership() {
    let mut fixture = Fixture::new(json!({"rolePrivilege":true,"noRoleGrant":true}), true).await;
    let preview = fixture.request("preview", &change("revoke", "object"), None).await.unwrap();
    assert_eq!(preview["before"]["grantAnyObject"]["state"], "unknown");
    assert!(preview["before"]["roleGrants"].as_array().unwrap().is_empty());
    assert!(preview["blocked"].is_string());
    fixture.no_mutations();
}

#[tokio::test]
async fn ob_unknown_dictionary_permission_stays_unknown_and_does_not_block_current_grantor() {
    let mut fixture = Fixture::new(json!({"permissionError":true}), true).await;
    let preview = fixture.request("preview", &change("revoke", "object"), None).await.unwrap();
    assert_eq!(preview["before"]["grantAnyObject"]["state"], "unknown");
    assert!(preview["blocked"].as_str().unwrap().contains("Cannot confirm"));
    assert!(!preview.to_string().contains("private-driver-detail"));
    fixture.no_mutations();
}

#[tokio::test]
async fn ob_a_non_owner_grantor_is_not_targeted_even_with_delegate_privilege() {
    let mut fixture = Fixture::new(json!({"directPrivilege":true,"grantor":"OtherGrantor"}), true).await;
    let mut change = change("revoke", "object");
    change.grantor = Some("OtherGrantor".into());
    let preview = fixture.request("preview", &change, None).await.unwrap();
    assert!(preview["blocked"].as_str().unwrap().contains("selected grantor"));
    fixture.no_mutations();
}

#[tokio::test]
async fn apply_rechecks_delegation_evidence_in_the_executing_session() {
    let mut fixture = Fixture::new(json!({"directPrivilege":true,"permissionLostAfterPreview":true}), true).await;
    let change = change("revoke", "object");
    let preview = fixture.request("preview", &change, None).await.unwrap();
    assert!(preview["blocked"].is_null());
    let error = fixture.request("apply", &change, preview["revision"].as_str().map(str::to_owned)).await.unwrap_err();
    assert!(error.contains("does not have"));
    fixture.no_mutations();
}

#[tokio::test]
async fn oracle_uses_effective_session_privileges_and_preserves_unknown_errors() {
    for (config, state) in [
        (json!({"directPrivilege":true}), "present"),
        (json!({}), "absent"),
        (json!({"permissionError":true}), "unknown"),
    ] {
        let mut fixture = Fixture::new(config, false).await;
        let preview = fixture.request("preview", &change("revoke", "object"), None).await.unwrap();
        assert_eq!(preview["before"]["grantAnyObject"]["state"], state);
        assert!(fixture.queries().iter().any(|sql| sql.contains("SYS.SESSION_PRIVS")));
        assert!(fixture.queries().iter().all(|sql| !sql.contains("IS_ENABLED_ROLE")));
        fixture.no_mutations();
    }
}
