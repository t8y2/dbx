// Gating and connection setup copied from live_postgres_docs_snapshot.rs.
//
// This is the end-to-end proof for Part 2: a hand-authored notes file, read
// off disk, merged into a snapshot collected from a REAL database, and
// showing up verbatim in the generated DBML.

use dbx_core::connection::AppState;
use dbx_core::docs::{NoteSource, SnapshotWarning};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;

fn live_postgres_config(
    id: &str,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> ConnectionConfig {
    ConnectionConfig {
        docs_notes_path: None,
        id: id.to_string(),
        name: id.to_string(),
        note: String::new(),
        db_type: DatabaseType::Postgres,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: host.to_string(),
        port,
        username: user.to_string(),
        password: password.to_string(),
        database: Some(database.to_string()),
        visible_databases: None,
        visible_schemas: None,
        attached_databases: Vec::new(),
        init_script: None,
        color: None,
        transport_layers: Vec::new(),
        connect_timeout_secs: 10,
        query_timeout_secs: 30,
        idle_timeout_secs: 60,
        keepalive_interval_secs: 0,
        ssl: false,
        ca_cert_path: String::new(),
        client_cert_path: String::new(),
        client_key_path: String::new(),
        sysdba: false,
        oracle_connection_type: None,
        connection_string: None,
        redis_connection_mode: None,
        redis_sentinel_master: String::new(),
        redis_sentinel_nodes: String::new(),
        redis_sentinel_username: String::new(),
        redis_sentinel_password: String::new(),
        redis_sentinel_tls: false,
        redis_cluster_nodes: String::new(),
        redis_key_separator: dbx_core::models::connection::default_redis_key_separator(),
        redis_scan_page_size: None,
        redis_database_aliases: Default::default(),
        etcd_endpoints: String::new(),
        gbase_server: String::new(),
        informix_server: String::new(),
        external_config: None,
        jdbc_driver_class: None,
        jdbc_driver_paths: Vec::new(),
        one_time: false,
        read_only: false,
        is_production: false,
        production_databases: vec![],
        show_system_schemas: false,
        database_info: None,
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE pointing at a live db"]
async fn annotations_reach_the_generated_dbml() {
    let host = std::env::var("DBX_LIVE_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_POSTGRES_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5432);
    let user = std::env::var("DBX_LIVE_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string());
    let password = std::env::var("DBX_LIVE_POSTGRES_PASSWORD").unwrap_or_default();
    let database = std::env::var("DBX_LIVE_POSTGRES_DATABASE").unwrap_or_else(|_| "postgres".to_string());

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-postgres-docs-annotations-{}", &suffix[..8]);
    let config = live_postgres_config(&connection_id, &host, port, &user, &password, &database);

    const TABLE_NOTE: &str = "Every tenant's client roster. Owned by the billing team.";
    const COLUMN_NOTE: &str = "Stable natural key used by the legacy billing export.";
    const PROJECT_NOTE: &str = "# Keycloak\n\nGenerated for live annotation verification.";
    const GROUP_NAME: &str = "Core Accounts";

    let notes_json = format!(
        r#"{{
  "formatVersion": 1,
  "project": {{ "name": "Keycloak", "note": {project_note:?} }},
  "groups": [
    {{ "id": "core-accounts", "name": {group_name:?}, "hue": 210, "note": "Tables owned by the accounts team." }}
  ],
  "tables": {{
    "public.clients": {{
      "group": "core-accounts",
      "note": {table_note:?},
      "columns": {{ "name": {{ "note": {column_note:?} }} }}
    }},
    "public.no_such_table_xyz": {{
      "note": "Orphaned annotation — the table it references does not exist."
    }}
  }}
}}"#,
        project_note = PROJECT_NOTE,
        group_name = GROUP_NAME,
        table_note = TABLE_NOTE,
        column_note = COLUMN_NOTE,
    );

    let notes_path = std::env::temp_dir().join(format!("dbx-live-docs-notes-{}.json", uuid::Uuid::new_v4()));
    std::fs::write(&notes_path, &notes_json).expect("write temp notes file");

    let dir = std::env::temp_dir().join(format!("dbx-live-postgres-docs-annotations-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config.clone());

    let options = dbx_core::docs::CollectOptions {
        database: database.clone(),
        schemas: vec!["public".to_string()],
        tables: vec![],
        project_name: "live-test".to_string(),
    };

    let snapshot_result = dbx_core::docs::collect_snapshot(
        &state,
        &config,
        &options,
        &|_progress| {},
        &std::sync::atomic::AtomicBool::new(false),
    )
    .await;

    let annotations_result = dbx_core::docs::annotations::load_annotations(&notes_path);

    // Clean up temp resources before any assertion that can panic.
    let _ = std::fs::remove_file(&notes_path);
    let _ = std::fs::remove_dir_all(&dir);

    let mut snapshot = snapshot_result.expect("collect");
    let annotations = annotations_result.expect("load annotations").expect("annotations file present");

    dbx_core::docs::annotations::apply_annotations(&mut snapshot, &annotations, DatabaseType::Postgres);

    let clients = snapshot.tables.iter().find(|table| table.name == "clients").expect("clients table collected");

    assert_eq!(clients.note.as_deref(), Some(TABLE_NOTE), "table note must be the annotated text");
    assert_eq!(clients.note_source, NoteSource::Local, "annotated note must be sourced as Local");

    let column_note =
        clients.column_notes.get("name").expect("column note for `name` present, keyed by real column name");
    assert_eq!(column_note.note, COLUMN_NOTE);
    assert_eq!(column_note.source, NoteSource::Local);

    assert_eq!(snapshot.groups.len(), 1, "expected the one group from the notes file");
    let group = &snapshot.groups[0];
    assert_eq!(group.name, GROUP_NAME);
    assert_eq!(clients.group_id.as_deref(), Some(group.id.as_str()), "clients.group_id must point at the group");

    let orphan_count = snapshot
        .warnings
        .iter()
        .find_map(|warning| match warning {
            SnapshotWarning::OrphanedNotes { count } => Some(*count),
            _ => None,
        })
        .expect("an OrphanedNotes warning must be present for the no_such_table_xyz annotation");
    assert_eq!(orphan_count, 1, "exactly one annotation targets a nonexistent table");

    let dbml = dbx_core::docs::to_dbml(&snapshot);
    println!("{}", dbml.text);

    assert!(dbml.text.contains(TABLE_NOTE), "generated DBML must contain the table note text:\n{}", dbml.text);
    assert!(dbml.text.contains(GROUP_NAME), "generated DBML must contain the group name:\n{}", dbml.text);
}
