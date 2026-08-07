// Gating and connection setup copied from live_postgres_docs_annotations.rs.
//
// This is not a test of correctness — it is a generator. Its job is to write
// `apps/desktop/src/docs/fixtures/keycloak.snapshot.json` from a REAL Rust
// snapshot so that `fixtureConformance.spec.ts` can fail whenever the
// hand-maintained `types.ts` drifts from this crate's serialized shape.

use dbx_core::connection::AppState;
use dbx_core::docs::annotations::{
    AnnotationFile, ColumnAnnotation, GroupAnnotation, ProjectAnnotation, TableAnnotation,
};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;
use std::collections::BTreeMap;

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
        default_schema: None,
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

/// Which tables to keep in the committed fixture.
///
/// Keycloak's public schema has 90 tables; committing all of them with full
/// column/index/FK data would bloat the fixture for no gain. This is an
/// explicit allowlist rather than "the first N alphabetically" because the
/// conformance test needs a CONNECTED foreign-key subgraph — an alphabetical
/// slice can easily keep a table while dropping everything it references,
/// leaving `relationships` empty and `Relationship`/`FieldRef` unexercised.
///
/// The set is chosen for shape coverage: `realm` and `client` are wide
/// (53 and 26 columns), `protocol_mapper` has two foreign keys to DIFFERENT
/// tables, and `composite_role` has two to the SAME table.
const KEEP_TABLES: &[&str] = &[
    "realm",
    "client",
    "client_attributes",
    "client_scope",
    "client_scope_attributes",
    "protocol_mapper",
    "protocol_mapper_config",
    "user_entity",
    "credential",
    "federated_identity",
    "keycloak_role",
    "composite_role",
];

/// The table the fixture's annotations attach to. Must be in `KEEP_TABLES`.
const ANCHOR_TABLE: &str = "client";
const ANCHOR_COLUMN: &str = "client_id";

const TABLE_NOTE: &str = "Every registered OIDC/SAML client. Owned by the platform team.";
const COLUMN_NOTE: &str = "The public client identifier callers send at the token endpoint.";
const PROJECT_NOTE: &str = "# Keycloak\n\nFixture generated for the docs viewer conformance test.";
const GROUP_ID: &str = "client-registry";
const GROUP_NAME: &str = "Client Registry";
const ORPHAN_TABLE_KEY: &str = "public.no_such_table_xyz";

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE pointing at a live db"]
async fn dump_keycloak_fixture() {
    let host = std::env::var("DBX_LIVE_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_POSTGRES_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5432);
    let user = std::env::var("DBX_LIVE_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string());
    let password = std::env::var("DBX_LIVE_POSTGRES_PASSWORD").unwrap_or_default();
    let database = std::env::var("DBX_LIVE_POSTGRES_DATABASE").unwrap_or_else(|_| "postgres".to_string());

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("dump-docs-fixture-{}", &suffix[..8]);
    let config = live_postgres_config(&connection_id, &host, port, &user, &password, &database);

    let dir = std::env::temp_dir().join(format!("dbx-dump-docs-fixture-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config.clone());

    let options = dbx_core::docs::CollectOptions {
        database: database.clone(),
        schemas: vec!["public".to_string()],
        tables: vec![],
        project_name: "Keycloak".to_string(),
    };

    let snapshot_result = dbx_core::docs::collect_snapshot(
        &state,
        &config,
        &options,
        &|_progress| {},
        &std::sync::atomic::AtomicBool::new(false),
    )
    .await;

    let _ = std::fs::remove_dir_all(&dir);

    let mut snapshot = snapshot_result.expect("collect");
    assert!(!snapshot.tables.is_empty(), "expected the keycloak schema to have tables");

    // Every field the viewer must render: a table note (LOCAL source), a
    // column note, a group with a hue, and an annotation targeting a table
    // that does not exist (so an `orphanedNotes` warning appears).
    let mut tables = BTreeMap::new();
    tables.insert(
        format!("public.{ANCHOR_TABLE}"),
        TableAnnotation {
            group: Some(GROUP_ID.to_string()),
            note: Some(TABLE_NOTE.to_string()),
            columns: BTreeMap::from([(ANCHOR_COLUMN.to_string(), ColumnAnnotation { note: COLUMN_NOTE.to_string() })]),
        },
    );
    tables.insert(
        ORPHAN_TABLE_KEY.to_string(),
        TableAnnotation {
            note: Some("Orphaned annotation — the table it references does not exist.".to_string()),
            ..Default::default()
        },
    );

    let annotations = AnnotationFile {
        format_version: 1,
        project: Some(ProjectAnnotation { name: Some("Keycloak".to_string()), note: Some(PROJECT_NOTE.to_string()) }),
        groups: vec![GroupAnnotation {
            id: GROUP_ID.to_string(),
            name: GROUP_NAME.to_string(),
            hue: 210,
            note: Some("Tables describing registered clients and their protocol mappers.".to_string()),
        }],
        tables,
    };

    dbx_core::docs::annotations::apply_annotations(&mut snapshot, &annotations, DatabaseType::Postgres);

    let anchor = snapshot.tables.iter().find(|table| table.name == ANCHOR_TABLE).expect("anchor table collected");
    assert_eq!(anchor.note_source, dbx_core::docs::NoteSource::Local, "annotation setup must have taken effect");
    assert!(
        snapshot
            .warnings
            .iter()
            .any(|warning| matches!(warning, dbx_core::docs::SnapshotWarning::OrphanedNotes { .. })),
        "annotation setup must produce an orphanedNotes warning"
    );

    // Trim to the allowlist, then rebuild relationships over the surviving
    // set. Rebuilding matters: the first pass resolved foreign keys against
    // all 90 tables, so edges pointing at dropped tables would otherwise
    // survive as relationships to nothing.
    snapshot.tables.retain(|table| KEEP_TABLES.contains(&table.name.as_str()));
    assert_eq!(
        snapshot.tables.len(),
        KEEP_TABLES.len(),
        "every allowlisted table must exist in the schema; got {:?}",
        snapshot.tables.iter().map(|table| &table.name).collect::<Vec<_>>()
    );
    snapshot.relationships = dbx_core::docs::build_relationships(&snapshot.tables);
    assert!(!snapshot.relationships.is_empty(), "the allowlist must form a connected foreign-key subgraph");

    let json = serde_json::to_string_pretty(&snapshot).expect("serialize snapshot");

    let out_path = std::env::var("DBX_FIXTURE_OUT").map(std::path::PathBuf::from).unwrap_or_else(|_| {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src/docs/fixtures/keycloak.snapshot.json")
    });

    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).expect("create fixture directory");
    }
    std::fs::write(&out_path, &json).expect("write fixture file");

    println!("Wrote {} bytes to {}", json.len(), out_path.display());
    println!("Tables kept: {}", snapshot.tables.len());
}
