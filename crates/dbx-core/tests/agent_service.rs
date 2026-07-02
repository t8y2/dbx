use dbx_core::agent_manager::{
    AgentManager, AgentRegistry, ArtifactInfo, DriverInfo, InstalledDriver, JavaRuntimeConfig, JavaRuntimeMode,
    JreInfo, DEFAULT_JRE_KEY,
};
use dbx_core::agent_service::{
    build_agent_list, github_url_to_r2_path, import_agent_jar, import_agents_from_zip, is_app_version_compatible,
    jre_needs_install, local_agent_jar_candidates, replace_download, uninstall_agent_driver, AgentProgressEvent,
};

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
            jar: Some(ArtifactInfo { url: format!("https://example.com/dbx-agent-{db_type}.jar"), size: 42 }),
            native: std::collections::HashMap::new(),
        },
    );
    AgentRegistry { jre: None, jres: std::collections::HashMap::new(), drivers }
}

fn registry_with_jre_driver(db_type: &str, driver_version: &str, jre: &str, jre_version: &str) -> AgentRegistry {
    let mut registry = registry_with_driver(db_type, driver_version, jre);
    registry.jres.insert(
        jre.to_string(),
        JreInfo { version: jre_version.to_string(), platforms: std::collections::HashMap::new() },
    );
    registry
}

fn registry_with_native_driver(db_type: &str, version: &str, jre: &str) -> AgentRegistry {
    let mut drivers = std::collections::HashMap::new();
    drivers.insert(
        db_type.to_string(),
        DriverInfo {
            version: version.to_string(),
            label: db_type.to_string(),
            min_app_version: "0.1.0".to_string(),
            jre: jre.to_string(),
            jar: Some(ArtifactInfo {
                url: format!("https://example.com/dbx-agent-{db_type}-legacy-placeholder.jar"),
                size: 0,
            }),
            native: [(
                AgentManager::current_platform().to_string(),
                ArtifactInfo { url: format!("https://example.com/dbx-agent-{db_type}"), size: 42 },
            )]
            .into_iter()
            .collect(),
        },
    );
    AgentRegistry { jre: None, jres: std::collections::HashMap::new(), drivers }
}

#[test]
fn built_in_agent_list_includes_expected_driver_labels() {
    let manager = test_manager("labels");

    let agents = build_agent_list(&manager, None);

    assert!(agents.iter().any(|agent| agent.db_type == "tdengine" && agent.label == "TDengine"));
    assert!(agents.iter().any(|agent| agent.db_type == "iotdb" && agent.label == "Apache IoTDB"));
    assert!(agents.iter().any(|agent| agent.db_type == "yashandb" && agent.label == "崖山 YashanDB"));
    assert!(agents.iter().any(|agent| agent.db_type == "access" && agent.label == "Microsoft Access"));
}

#[test]
fn agent_list_marks_installed_driver_update_when_registry_version_differs() {
    let manager = test_manager("update");
    let jar_path = manager.driver_jar_path("h2");
    std::fs::create_dir_all(jar_path.parent().unwrap()).unwrap();
    write_test_agent_jar(&jar_path);
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
    assert!(h2.requires_java_runtime);
    assert!(h2.update_available);
}

#[test]
fn agent_list_marks_update_when_installed_managed_jre_version_differs() {
    let manager = test_manager("jre-update");
    let jar_path = manager.driver_jar_path("h2");
    let java_path = manager.jre_java_path(DEFAULT_JRE_KEY);
    std::fs::create_dir_all(jar_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(java_path.parent().unwrap()).unwrap();
    write_test_agent_jar(&jar_path);
    std::fs::write(&java_path, b"java").unwrap();
    manager
        .save_state(&dbx_core::agent_manager::AgentState {
            jre_versions: [(DEFAULT_JRE_KEY.to_string(), "21.0.10".to_string())].into_iter().collect(),
            installed_drivers: [(
                "h2".to_string(),
                InstalledDriver {
                    version: "0.2.0".to_string(),
                    installed_at: "2026-05-18T00:00:00Z".to_string(),
                    jre: DEFAULT_JRE_KEY.to_string(),
                },
            )]
            .into_iter()
            .collect(),
            ..Default::default()
        })
        .unwrap();
    let registry = registry_with_jre_driver("h2", "0.2.0", DEFAULT_JRE_KEY, "21.0.11");

    let agents = build_agent_list(&manager, Some(&registry));
    let h2 = agents.iter().find(|agent| agent.db_type == "h2").unwrap();

    assert!(h2.update_available);
}

#[test]
fn agent_list_does_not_mark_jre_update_for_system_java_runtime() {
    let manager = test_manager("system-java-no-jre-update");
    let jar_path = manager.driver_jar_path("dameng");
    std::fs::create_dir_all(jar_path.parent().unwrap()).unwrap();
    write_test_agent_jar(&jar_path);
    manager
        .save_state(&dbx_core::agent_manager::AgentState {
            java_runtime: JavaRuntimeConfig { mode: JavaRuntimeMode::System, custom_java_path: None },
            installed_drivers: [(
                "dameng".to_string(),
                InstalledDriver {
                    version: "0.2.0".to_string(),
                    installed_at: "2026-05-18T00:00:00Z".to_string(),
                    jre: DEFAULT_JRE_KEY.to_string(),
                },
            )]
            .into_iter()
            .collect(),
            ..Default::default()
        })
        .unwrap();
    let registry = registry_with_jre_driver("dameng", "0.2.0", DEFAULT_JRE_KEY, "21.0.11");

    let agents = build_agent_list(&manager, Some(&registry));
    let dameng = agents.iter().find(|agent| agent.db_type == "dameng").unwrap();

    assert!(dameng.installed);
    assert!(!dameng.jre_installed);
    assert!(!dameng.update_available);
}

#[test]
fn agent_list_does_not_require_jre_for_native_agent() {
    let manager = test_manager("native-no-jre");
    let native_path = manager.driver_native_path("dameng");
    std::fs::create_dir_all(native_path.parent().unwrap()).unwrap();
    std::fs::write(&native_path, b"agent").unwrap();
    manager
        .save_state(&dbx_core::agent_manager::AgentState {
            installed_drivers: [(
                "dameng".to_string(),
                InstalledDriver {
                    version: "0.2.0".to_string(),
                    installed_at: "2026-05-18T00:00:00Z".to_string(),
                    jre: DEFAULT_JRE_KEY.to_string(),
                },
            )]
            .into_iter()
            .collect(),
            ..Default::default()
        })
        .unwrap();

    let agents = build_agent_list(&manager, None);
    let dameng = agents.iter().find(|agent| agent.db_type == "dameng").unwrap();

    assert!(dameng.installed);
    assert!(!dameng.requires_java_runtime);
    assert!(dameng.jre_installed);
}

#[test]
fn agent_list_does_not_require_jre_for_registry_native_agent() {
    let manager = test_manager("registry-native-no-jre");
    let registry = registry_with_native_driver("xugu", "0.2.0", DEFAULT_JRE_KEY);

    let agents = build_agent_list(&manager, Some(&registry));
    let xugu = agents.iter().find(|agent| agent.db_type == "xugu").unwrap();

    assert!(!xugu.installed);
    assert_eq!(xugu.jre, DEFAULT_JRE_KEY);
    assert!(!xugu.requires_java_runtime);
    assert!(xugu.jre_installed);
}

#[test]
fn agent_list_keeps_jre_requirement_for_installed_jar_when_registry_has_native() {
    let manager = test_manager("installed-jar-registry-native");
    let jar_path = manager.driver_jar_path("xugu");
    std::fs::create_dir_all(jar_path.parent().unwrap()).unwrap();
    write_test_agent_jar(&jar_path);
    manager
        .save_state(&dbx_core::agent_manager::AgentState {
            installed_drivers: [(
                "xugu".to_string(),
                InstalledDriver {
                    version: "0.2.0".to_string(),
                    installed_at: "2026-05-18T00:00:00Z".to_string(),
                    jre: DEFAULT_JRE_KEY.to_string(),
                },
            )]
            .into_iter()
            .collect(),
            ..Default::default()
        })
        .unwrap();
    let registry = registry_with_native_driver("xugu", "0.2.0", DEFAULT_JRE_KEY);

    let agents = build_agent_list(&manager, Some(&registry));
    let xugu = agents.iter().find(|agent| agent.db_type == "xugu").unwrap();

    assert!(xugu.installed);
    assert!(xugu.requires_java_runtime);
    assert!(!xugu.jre_installed);
}

#[test]
fn agent_list_reports_missing_jre_for_uninstalled_java_drivers() {
    let manager = test_manager("uninstalled-java-driver-missing-jre");
    let registry = registry_with_jre_driver("dameng", "0.2.0", DEFAULT_JRE_KEY, "21.0.11");

    let agents = build_agent_list(&manager, Some(&registry));
    let dameng = agents.iter().find(|agent| agent.db_type == "dameng").unwrap();

    assert!(!dameng.installed);
    assert!(!dameng.jre_installed);
}

#[test]
fn agent_list_uses_legacy_default_jre_version_when_checking_updates() {
    let manager = test_manager("legacy-jre-version");
    let jar_path = manager.driver_jar_path("dameng");
    let java_path = manager.jre_java_path(DEFAULT_JRE_KEY);
    std::fs::create_dir_all(jar_path.parent().unwrap()).unwrap();
    std::fs::create_dir_all(java_path.parent().unwrap()).unwrap();
    write_test_agent_jar(&jar_path);
    std::fs::write(&java_path, b"java").unwrap();
    manager
        .save_state(&dbx_core::agent_manager::AgentState {
            jre_version: Some("21.0.11".to_string()),
            installed_drivers: [(
                "dameng".to_string(),
                InstalledDriver {
                    version: "0.2.0".to_string(),
                    installed_at: "2026-05-18T00:00:00Z".to_string(),
                    jre: DEFAULT_JRE_KEY.to_string(),
                },
            )]
            .into_iter()
            .collect(),
            ..Default::default()
        })
        .unwrap();
    let registry = registry_with_jre_driver("dameng", "0.2.0", DEFAULT_JRE_KEY, "21.0.11");

    let agents = build_agent_list(&manager, Some(&registry));
    let dameng = agents.iter().find(|agent| agent.db_type == "dameng").unwrap();

    assert!(!dameng.update_available);
}

#[test]
fn jre_needs_install_when_managed_runtime_version_differs() {
    let manager = test_manager("jre-needs-install");
    let java_path = manager.jre_java_path(DEFAULT_JRE_KEY);
    std::fs::create_dir_all(java_path.parent().unwrap()).unwrap();
    std::fs::write(&java_path, b"java").unwrap();
    manager
        .save_state(&dbx_core::agent_manager::AgentState {
            jre_versions: [(DEFAULT_JRE_KEY.to_string(), "21.0.10".to_string())].into_iter().collect(),
            ..Default::default()
        })
        .unwrap();
    let registry = registry_with_jre_driver("h2", "0.2.0", DEFAULT_JRE_KEY, "21.0.11");

    assert!(jre_needs_install(&manager, &registry, DEFAULT_JRE_KEY));
}

#[test]
fn local_agent_jar_candidates_include_monorepo_and_legacy_build_output() {
    let candidates = local_agent_jar_candidates("tdengine");

    assert!(candidates.iter().any(|path| path.ends_with("agents/drivers/tdengine/build/libs/dbx-agent-tdengine.jar")));
    assert!(candidates.iter().any(|path| path.ends_with("dbx-agents/tdengine/build/libs/dbx-agent-tdengine.jar")));
}

#[test]
fn github_agent_asset_urls_map_to_r2_paths_by_category() {
    assert_eq!(
        github_url_to_r2_path("https://github.com/t8y2/dbx-agents/releases/download/v1/dbx-jre-21.tar.gz", "jre"),
        "agents/jre/dbx-jre-21.tar.gz"
    );
    assert_eq!(
        github_url_to_r2_path("https://github.com/t8y2/dbx-agents/releases/download/v1/dbx-agent-h2.jar", "driver"),
        "agents/drivers/dbx-agent-h2.jar"
    );
    assert_eq!(
        github_url_to_r2_path("https://github.com/t8y2/dbx/releases/download/agents-v0.3.0/dbx-agent-h2.jar", "driver"),
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

#[test]
fn agent_progress_event_serializes_backward_compatible_fields() {
    let event = AgentProgressEvent::transfer("driver", 512, 1024).with_batch(Some("h2"), Some(1), Some(2));

    let value = serde_json::to_value(event).unwrap();

    assert_eq!(value["step"], "driver");
    assert_eq!(value["downloaded"], 512);
    assert_eq!(value["total"], 1024);
    assert_eq!(value["db_type"], "h2");
    assert_eq!(value["current"], 1);
    assert_eq!(value["total_drivers"], 2);
}

#[test]
fn local_jar_import_updates_driver_state() {
    let manager = test_manager("local-import");
    let source = test_path("local-import-source").join("dbx-agent-h2.jar");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    write_test_agent_jar(&source);

    import_agent_jar(&manager, "h2", &source).unwrap();

    assert_eq!(std::fs::read(manager.driver_jar_path("h2")).unwrap(), std::fs::read(&source).unwrap());
    let state = manager.load_state();
    let installed = state.installed_drivers.get("h2").unwrap();
    assert_eq!(installed.version, "0.1.0-local");
    assert_eq!(installed.jre, DEFAULT_JRE_KEY);
}

#[test]
fn local_jar_import_rejects_corrupt_jar() {
    let manager = test_manager("local-import-corrupt");
    let source = test_path("local-import-corrupt-source").join("dbx-agent-h2.jar");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, b"jar").unwrap();

    let err = import_agent_jar(&manager, "h2", &source).unwrap_err();

    assert!(err.contains("invalid or corrupt"));
    assert!(!manager.driver_jar_path("h2").exists());
    assert!(!manager.load_state().installed_drivers.contains_key("h2"));
}

#[tokio::test]
async fn uninstall_driver_removes_artifact_and_state() {
    let manager = test_manager("uninstall");
    let jar_path = manager.driver_jar_path("h2");
    std::fs::create_dir_all(jar_path.parent().unwrap()).unwrap();
    std::fs::write(&jar_path, b"jar").unwrap();
    let cache_dir = manager.download_cache_dir();
    std::fs::create_dir_all(&cache_dir).unwrap();
    let h2_cache = cache_dir.join("driver-h2-0.1.0-abc-agent.jar");
    let dameng_cache = cache_dir.join("driver-dameng-0.1.0-abc-agent.jar");
    let jre_cache = cache_dir.join("jre-21-21.0.11-abc-jre-download.tar.gz");
    std::fs::write(&h2_cache, b"h2").unwrap();
    std::fs::write(&dameng_cache, b"dameng").unwrap();
    std::fs::write(&jre_cache, b"jre").unwrap();
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

    uninstall_agent_driver(&manager, "h2").await.unwrap();

    assert!(!jar_path.exists());
    assert!(!h2_cache.exists());
    assert!(dameng_cache.exists());
    assert!(jre_cache.exists());
    assert!(!manager.load_state().installed_drivers.contains_key("h2"));
}

#[test]
fn offline_zip_import_emits_progress_and_updates_state() {
    let manager = test_manager("offline-progress");
    let zip_path = test_path("offline-progress-zip").join("agents.zip");
    std::fs::create_dir_all(zip_path.parent().unwrap()).unwrap();
    write_offline_driver_zip(&zip_path, "h2", "0.2.0");
    let events = std::sync::Mutex::new(Vec::new());

    let result = import_agents_from_zip(&manager, &zip_path, |event| {
        events.lock().unwrap().push(event);
    })
    .unwrap();

    assert_eq!(result.drivers_installed, vec!["h2"]);
    let installed_jar = std::fs::read(manager.driver_jar_path("h2")).unwrap();
    assert!(installed_jar.windows(b"Main-Class:".len()).any(|window| window == b"Main-Class:"));
    assert_eq!(manager.load_state().installed_drivers.get("h2").unwrap().version, "0.2.0");
    let events = events.lock().unwrap();
    assert!(events.iter().any(|event| event.step == "driver" && event.db_type.as_deref() == Some("H2")));
}

#[test]
fn offline_zip_import_rejects_corrupt_jar() {
    let manager = test_manager("offline-corrupt-driver");
    let zip_path = test_path("offline-corrupt-driver-zip").join("agents.zip");
    std::fs::create_dir_all(zip_path.parent().unwrap()).unwrap();
    write_offline_driver_zip_with_jar(&zip_path, "h2", "0.2.0", b"jar".to_vec());

    let err = import_agents_from_zip(&manager, &zip_path, |_| {}).unwrap_err();

    assert!(err.contains("invalid or corrupt"));
    assert!(!manager.driver_jar_path("h2").exists());
    assert!(!manager.load_state().installed_drivers.contains_key("h2"));
}

fn write_offline_driver_zip(path: &std::path::Path, db_type: &str, version: &str) {
    write_offline_driver_zip_with_jar(path, db_type, version, test_agent_jar_bytes());
}

fn write_offline_driver_zip_with_jar(path: &std::path::Path, db_type: &str, version: &str, jar: Vec<u8>) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let registry = serde_json::json!({
        "drivers": {
            db_type: {
                "version": version,
                "label": db_type,
                "min_app_version": "0.1.0",
                "jre": DEFAULT_JRE_KEY,
                "jar": { "url": format!("https://example.com/dbx-agent-{db_type}.jar"), "size": jar.len() }
            }
        }
    });

    zip.start_file("agent-registry.json", options).unwrap();
    std::io::Write::write_all(&mut zip, registry.to_string().as_bytes()).unwrap();
    zip.start_file(format!("drivers/dbx-agent-{db_type}.jar"), options).unwrap();
    std::io::Write::write_all(&mut zip, &jar).unwrap();
    zip.finish().unwrap();
}

fn write_test_agent_jar(path: &std::path::Path) {
    std::fs::write(path, test_agent_jar_bytes()).unwrap();
}

fn test_agent_jar_bytes() -> Vec<u8> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    // The production validator rejects corrupt driver artifacts by requiring a real JAR manifest.
    zip.start_file("META-INF/MANIFEST.MF", options).unwrap();
    std::io::Write::write_all(&mut zip, b"Manifest-Version: 1.0\nMain-Class: com.dbx.agent.TestAgent\n\n").unwrap();
    zip.finish().unwrap().into_inner()
}
