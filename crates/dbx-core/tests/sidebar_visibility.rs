use dbx_core::connection::{connection_configs_pool_equivalent, connection_configs_session_credentials_compatible};
use dbx_core::models::connection::ConnectionConfig;

#[test]
fn sidebar_visibility_preserves_sessions_without_ignoring_target_changes() {
    let base: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "sidebar", "name": "Sidebar", "db_type": "oracle", "host": "localhost",
        "port": 1521, "username": "test", "password": "", "save_password": false
    }))
    .unwrap();
    for field in ["show_database_links", "show_native_jobs", "show_user_admin"] {
        for before in [None, Some(true), Some(false)] {
            for after in [None, Some(true), Some(false)] {
                let set = |config: &mut ConnectionConfig, value| match field {
                    "show_database_links" => config.show_database_links = value,
                    "show_native_jobs" => config.show_native_jobs = value,
                    _ => config.show_user_admin = value,
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
