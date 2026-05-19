use dbx_core::agent_manager::{
    AgentManager, AgentRegistry, ArtifactInfo, DriverInfo, InstalledDriver, DEFAULT_JRE_KEY,
};
use dbx_core::agent_service::{build_agent_list, github_url_to_r2_path, local_agent_jar_candidates};
use dbx_core::agent_service::{is_app_version_compatible, replace_download};

fn test_manager(name: &str) -> AgentManager {
    let dir = std::env::temp_dir().join(format!("dbx-agent-service-{name}-{}", uuid::Uuid::new_v4()));
    AgentManager::new_with_base_dir(dir)
}

fn registry_with_driver(db_type: &str, version: &str, jre: &str) -> AgentRegistry {
    let mut drivers = std::collections::HashMap::new();
    drivers.insert(
        db_type.to_string(),
        DriverInfo {
            version: version.to_string(),
            label: db_type.to_string(),
            min_app_version: "0.1.0".to_string(),
            jre: jre.to_string(),
            jar: ArtifactInfo { url: format!("https://example.com/dbx-agent-{db_type}.jar"), size: 42 },
        },
    );
    AgentRegistry { jre: None, jres: std::collections::HashMap::new(), drivers }
}

#[test]
fn built_in_agent_list_includes_expected_driver_labels() {
    let manager = test_manager("labels");

    let agents = build_agent_list(&manager, None);

    assert!(agents.iter().any(|agent| agent.db_type == "tdengine" && agent.label == "TDengine"));
    assert!(agents.iter().any(|agent| agent.db_type == "yashandb" && agent.label == "崖山 YashanDB"));
    assert!(agents.iter().any(|agent| agent.db_type == "access" && agent.label == "Microsoft Access"));
}

#[test]
fn agent_list_marks_installed_driver_update_when_registry_version_differs() {
    let manager = test_manager("update");
    let jar_path = manager.driver_jar_path("h2");
    std::fs::create_dir_all(jar_path.parent().unwrap()).unwrap();
    std::fs::write(&jar_path, b"jar").unwrap();
    manager
        .save_state(&dbx_core::agent_manager::AgentState {
            installed_drivers: [(
                "h2".to_string(),
                InstalledDriver {
                    version: "0.1.0".to_string(),
                    installed_at: "2026-05-18T00:00:00Z".to_string(),
                    jre: DEFAULT_JRE_KEY.to_string(),
                },
            )]
            .into_iter()
            .collect(),
            ..Default::default()
        })
        .unwrap();
    let registry = registry_with_driver("h2", "0.2.0", "21");

    let agents = build_agent_list(&manager, Some(&registry));
    let h2 = agents.iter().find(|agent| agent.db_type == "h2").unwrap();

    assert!(h2.installed);
    assert_eq!(h2.installed_version.as_deref(), Some("0.1.0"));
    assert_eq!(h2.version, "0.2.0");
    assert_eq!(h2.size, 42);
    assert_eq!(h2.jre, "21");
    assert!(h2.update_available);
}

#[test]
fn local_agent_jar_candidates_include_sibling_build_output() {
    let candidates = local_agent_jar_candidates("tdengine");

    assert!(candidates.iter().any(|path| path.ends_with("dbx-agents/tdengine/build/libs/dbx-agent-tdengine.jar")));
}

#[test]
fn github_agent_asset_urls_map_to_r2_paths_by_category() {
    assert_eq!(
        github_url_to_r2_path("https://github.com/t8y2/dbx-agents/releases/download/v1/jre-17.tar.gz", "jre"),
        "agents/jre/jre-17.tar.gz"
    );
    assert_eq!(
        github_url_to_r2_path("https://github.com/t8y2/dbx-agents/releases/download/v1/dbx-agent-h2.jar", "driver"),
        "agents/drivers/dbx-agent-h2.jar"
    );
}

fn test_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("dbx-agent-service-{name}-{}", uuid::Uuid::new_v4()))
}

#[test]
fn accepts_current_app_when_min_version_is_not_newer() {
    assert!(is_app_version_compatible("0.5.13", "0.5.13"));
    assert!(is_app_version_compatible("0.5.12", "0.5.13"));
    assert!(!is_app_version_compatible("0.5.14", "0.5.13"));
}

#[test]
fn atomic_replace_moves_download_into_place() {
    let dir = test_path("atomic");
    std::fs::create_dir_all(&dir).unwrap();
    let dest = dir.join("agent.jar");
    let tmp = dir.join("agent.jar.download");
    std::fs::write(&dest, b"old").unwrap();
    std::fs::write(&tmp, b"new").unwrap();

    replace_download(&tmp, &dest).unwrap();

    assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    assert!(!tmp.exists());
    std::fs::remove_dir_all(dir).ok();
}
