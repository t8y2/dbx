use dbx_core::connection::{connection_configs_pool_equivalent, connection_configs_session_credentials_compatible};
use dbx_core::models::connection::{ConnectionConfig, ProductionBadgeScope};

#[test]
fn sidebar_visibility_preserves_sessions_without_ignoring_target_changes() {
    let base: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "sidebar", "name": "Sidebar", "db_type": "oracle", "host": "localhost",
        "port": 1521, "username": "test", "password": "", "save_password": false
    }))
    .unwrap();
    for field in ["show_database_links", "show_native_jobs", "show_user_admin", "show_extensions"] {
        for before in [None, Some(true), Some(false)] {
            for after in [None, Some(true), Some(false)] {
                let set = |config: &mut ConnectionConfig, value| match field {
                    "show_database_links" => config.show_database_links = value,
                    "show_native_jobs" => config.show_native_jobs = value,
                    "show_user_admin" => config.show_user_admin = value,
                    _ => config.show_extensions = value,
                };
                let mut initial = base.clone();
                let mut edited = base.clone();
                set(&mut initial, before);
                set(&mut edited, after);
                assert!(connection_configs_pool_equivalent(&initial, &edited));
                assert!(connection_configs_session_credentials_compatible(&initial, &edited));

                for target in ["host", "username", "tls"] {
                    let mut changed_target = edited.clone();
                    match target {
                        "host" => changed_target.host = "other.example.test".into(),
                        "username" => changed_target.username = "other-user".into(),
                        _ => changed_target.ssl = !initial.ssl,
                    }
                    assert!(!connection_configs_pool_equivalent(&initial, &changed_target));
                    assert!(!connection_configs_session_credentials_compatible(&initial, &changed_target));
                }
            }
        }
    }
}

#[test]
fn native_oracle_dialog_defaults_preserve_identity_but_real_drivers_do_not() {
    for engine in ["oracle", "oceanbase-oracle"] {
        let base: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "dialog", "name": "Dialog", "db_type": engine, "host": "localhost",
            "port": 1521, "username": "test", "password": "fixture", "save_password": true
        }))
        .unwrap();
        let mut edited = base.clone();
        edited.show_extensions = Some(false);
        edited.color = Some(String::new());
        edited.production_badge_scope = Some(ProductionBadgeScope::Database);
        edited.driver_label = Some("Display label".into());
        edited.driver_profile = Some(engine.into());
        if engine == "oracle" {
            edited.oracle_connection_type = Some("service_name".into());
        }
        assert!(connection_configs_pool_equivalent(&base, &edited));
        assert!(connection_configs_session_credentials_compatible(&base, &edited));
        for profile in ["oci", "oracle-legacy", "oracle-10g", "custom-driver"] {
            let mut changed = edited.clone();
            changed.driver_profile = Some(profile.into());
            assert!(!connection_configs_pool_equivalent(&base, &changed));
            assert!(!connection_configs_session_credentials_compatible(&base, &changed));
        }
        for field in [
            "host",
            "username",
            "password",
            "tls",
            "read_only",
            "is_production",
            "production_databases",
            "sysdba",
            "sid",
            "tns",
            "jdbc_driver_paths",
        ] {
            let mut changed = edited.clone();
            match field {
                "host" => changed.host = "other.test".into(),
                "username" => changed.username = "other".into(),
                "password" => changed.password = "replacement".into(),
                "tls" => changed.ssl = !changed.ssl,
                "read_only" => changed.read_only = !changed.read_only,
                "is_production" => changed.is_production = !changed.is_production,
                "sysdba" => changed.sysdba = true,
                "sid" | "tns" => changed.oracle_connection_type = Some(field.into()),
                "jdbc_driver_paths" => changed.jdbc_driver_paths.push("driver.jar".into()),
                _ => changed.production_databases.push("other".into()),
            }
            assert!(!connection_configs_pool_equivalent(&base, &changed), "{engine}: {field}");
        }
    }
}

#[test]
fn jdbc_labels_and_custom_profiles_remain_runtime_identity() {
    let base: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "jdbc", "name": "JDBC", "db_type": "jdbc", "host": "localhost",
        "port": 1521, "username": "test", "password": "", "driver_label": "Oracle"
    }))
    .unwrap();
    let mut edited = base.clone();
    edited.driver_label = Some("PostgreSQL".into());
    assert!(!connection_configs_pool_equivalent(&base, &edited));
    edited = base.clone();
    edited.driver_profile = Some("jdbc".into());
    assert!(!connection_configs_pool_equivalent(&base, &edited));
    assert!(!connection_configs_session_credentials_compatible(&base, &edited));
}
