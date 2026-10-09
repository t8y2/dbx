use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use dbx_core::docs::{CollectOptions, SchemaSnapshot};
use dbx_core::models::connection::ConnectionConfig;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsSnapshotRequest {
    pub connection_id: String,
    pub database: String,
    #[serde(default)]
    pub schemas: Vec<String>,
    #[serde(default)]
    pub tables: Vec<String>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub max_concurrent_tables: Option<usize>,
}

async fn load_connection(state: &Arc<WebState>, connection_id: &str) -> Result<ConnectionConfig, AppError> {
    state
        .app
        .storage
        .load_connections()
        .await
        .map_err(AppError::from)?
        .into_iter()
        .find(|config| config.id == connection_id)
        .ok_or_else(|| AppError::from(format!("Connection with id '{connection_id}' not found")))
}

pub async fn collect_snapshot(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DocsSnapshotRequest>,
) -> Result<Json<SchemaSnapshot>, AppError> {
    let connection = load_connection(&state, &request.connection_id).await?;

    let options = CollectOptions {
        database: request.database.clone(),
        schemas: request.schemas.clone(),
        tables: request.tables.clone(),
        project_name: request.project_name.clone().unwrap_or_else(|| connection.name.clone()),
    };

    let snapshot = dbx_core::docs::collect_snapshot_with_concurrency(
        &state.app,
        &connection,
        &options,
        &|_progress| {},
        &AtomicBool::new(false),
        request.max_concurrent_tables.unwrap_or(8).clamp(1, 8),
    )
    .await
    .map_err(AppError::from)?;

    Ok(Json(snapshot))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsAnnotationsRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsApplyRequest {
    pub connection_id: String,
    pub snapshot: SchemaSnapshot,
    pub annotations: dbx_core::docs::annotations::AnnotationFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsSaveRequest {
    pub connection_id: String,
    pub annotations: dbx_core::docs::annotations::AnnotationFile,
}

/// On the HTTP surface an explicit connection-level `docsNotesPath` is a
/// drive-by arbitrary-path write primitive: `/api/connection/save` stores it
/// verbatim and `annotations/save` then creates and overwrites whatever it
/// points at, with the server process's permissions. The desktop keeps its
/// "point notes at a repo file" flow; the server confines notes under
/// `data_dir/docs-notes` unless the operator explicitly allowlists additional
/// absolute roots via `DBX_DOCS_NOTES_ROOTS`, injected through
/// `WebState::notes_roots` so the containment path stays testable.
fn notes_path_for(state: &Arc<WebState>, config: &ConnectionConfig) -> Result<std::path::PathBuf, AppError> {
    let explicit = config.docs_notes_path.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let Some(explicit) = explicit else {
        return Ok(dbx_core::docs::annotations::resolve_notes_path(&config.id, None, &state.data_dir));
    };
    let default_root = state.data_dir.join("docs-notes");
    let candidate = std::path::PathBuf::from(explicit);
    // Relative candidates resolve under the default root first; absolute ones
    // must prefix-match an allowlisted root (or the default). Any `..` in the
    // matched suffix rejects — traversal shapes are never worth allowing here.
    let resolved = if candidate.is_absolute() { candidate } else { default_root.join(&candidate) };
    let contained =
        std::iter::once(&default_root).chain(state.notes_roots.iter()).find_map(|root| contain_within(root, &resolved));
    contained.ok_or_else(|| {
        AppError::from(format!(
            "docsNotesPath \"{explicit}\" is outside the allowed notes roots; set DBX_DOCS_NOTES_ROOTS to allow this server's notes to live elsewhere"
        ))
    })
}

/// Allowlist roots are deployment-static: resolved once at startup (from
/// `DBX_DOCS_NOTES_ROOTS`), not per request. `split_paths` keeps Windows drive
/// roots (`C:\notes`) parseable, which a naive `:` split would break.
pub(crate) fn notes_roots_from_env(raw: Option<&std::ffi::OsStr>) -> Vec<std::path::PathBuf> {
    raw.map(std::env::split_paths)
        .into_iter()
        .flatten()
        .filter(|root| !root.as_os_str().is_empty() && root.is_absolute())
        .collect()
}

/// Prefix-based containment: the candidate must lexically sit under `base`,
/// and `..` is rejected anywhere in the remaining suffix so the rejoin can
/// never climb back out. No symlink resolution: notes files are host-authored
/// JSON, and create_dir_all would otherwise follow an attacker-planted link —
/// the containment boundary is the prefix check.
fn contain_within(base: &std::path::Path, candidate: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::path::Component;
    let suffix = candidate.strip_prefix(base).ok()?;
    if suffix.components().any(|component| component == Component::ParentDir) {
        return None;
    }
    Some(base.join(suffix))
}

pub async fn load_annotations(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DocsAnnotationsRequest>,
) -> Result<Json<Option<dbx_core::docs::annotations::AnnotationFile>>, AppError> {
    let config = load_connection(&state, &request.connection_id).await?;
    let path = notes_path_for(&state, &config)?;
    Ok(Json(dbx_core::docs::annotations::load_annotations(&path).map_err(AppError::from)?))
}

pub async fn apply_annotations(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DocsApplyRequest>,
) -> Result<Json<SchemaSnapshot>, AppError> {
    let config = load_connection(&state, &request.connection_id).await?;
    let mut applied = request.snapshot;
    dbx_core::docs::annotations::apply_annotations(&mut applied, &request.annotations, config.db_type);
    Ok(Json(applied))
}

pub async fn save_annotations(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DocsSaveRequest>,
) -> Result<Json<()>, AppError> {
    let config = load_connection(&state, &request.connection_id).await?;
    let path = notes_path_for(&state, &config)?;
    dbx_core::docs::annotations::save_annotations(&path, &request.annotations).map_err(AppError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsExportRequest {
    pub snapshot: SchemaSnapshot,
    pub annotations: dbx_core::docs::annotations::AnnotationFile,
    pub lang: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsExportResponse {
    pub content: String,
}

/// Returns the rendered HTML as a string rather than writing a file: the
/// browser has no filesystem to write to, so `http.ts` downloads this content
/// as a blob instead of the Tauri command's `std::fs::write`.
pub async fn export_html(Json(request): Json<DocsExportRequest>) -> Result<Json<DocsExportResponse>, AppError> {
    let content = dbx_core::docs::to_standalone_html(&request.snapshot, &request.annotations, &request.lang)
        .map_err(AppError::from)?;
    Ok(Json(DocsExportResponse { content }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_core::models::connection::{
        default_connect_timeout_secs, default_idle_timeout_secs, default_keepalive_interval_secs,
        default_query_timeout_secs, DatabaseType,
    };
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    /// Literal construction on purpose: `ConnectionConfig` deserializes through
    /// snake_case `ConnectionConfigData`, so a camelCase JSON fixture would
    /// fail with `missing field db_type` instead of exercising the notes logic.
    fn postgres_config(id: &str, docs_notes_path: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            docs_notes_path: docs_notes_path.map(str::to_string),
            id: id.to_string(),
            name: "Postgres".to_string(),
            note: String::new(),
            db_type: DatabaseType::Postgres,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: String::new(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            default_schema: None,
            visible_databases: None,
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
            sidebar_auto_load_all_tables: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: default_connect_timeout_secs(),
            query_timeout_secs: default_query_timeout_secs(),
            idle_timeout_secs: default_idle_timeout_secs(),
            keepalive_interval_secs: default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            oracle_oci_nls_lang: None,
            oracle_oci_tns_admin: None,
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
            redis_key_templates: Vec::new(),
            redis_key_filter: None,
            redis_key_grouping: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            plugin_id: None,
            plugin_connection_provider: None,
            plugin_connection_type: None,
            connection_secrets: Default::default(),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            save_password: true,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    async fn test_web_state(notes_roots: Vec<PathBuf>) -> (Arc<WebState>, tempfile::TempDir) {
        let directory = tempfile::tempdir().unwrap();
        let storage =
            dbx_core::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db")).await.unwrap();
        let mut state = WebState::for_tests(
            std::sync::Arc::new(dbx_core::connection::AppState::new(storage)),
            directory.path().to_path_buf(),
        );
        state.notes_roots = notes_roots;
        (std::sync::Arc::new(state), directory)
    }

    #[tokio::test]
    async fn notes_paths_stay_inside_the_data_dir_by_default() {
        let (state, _data_dir_guard) = test_web_state(Vec::new()).await;
        let data_dir = state.data_dir.clone();

        // 未配置 docsNotesPath 时使用默认的 data_dir/docs-notes/<id>.json。
        let config = postgres_config("conn-1", None);
        let path = notes_path_for(&state, &config).unwrap();
        assert_eq!(path, data_dir.join("docs-notes").join("conn-1.json"));

        // 指向 docs-notes 内部的相对路径可用（仓库笔记工作流的受控形态）。
        let config = postgres_config("conn-1", Some("repo/notes.json"));
        let path = notes_path_for(&state, &config).unwrap();
        assert_eq!(path, data_dir.join("docs-notes").join("repo").join("notes.json"));

        // ../ 逃逸与 default root 之外的绝对路径都拒绝：settings 写入不得变成任意文件覆盖。
        let escaping = postgres_config("conn-1", Some("../escape.json"));
        assert!(notes_path_for(&state, &escaping).is_err());
        let absolute_outside = postgres_config("conn-1", Some(data_dir.join("escape.json").to_str().unwrap()));
        assert!(notes_path_for(&state, &absolute_outside).is_err());
    }

    #[tokio::test]
    async fn allowlisted_roots_admit_absolute_paths_inside_them() {
        let repo_root = tempfile::tempdir().unwrap();
        let (state, _data_dir_guard) = test_web_state(vec![repo_root.path().to_path_buf()]).await;
        let data_dir = state.data_dir.clone();

        // allowlist 之外的绝对路径仍拒绝。
        let outside = postgres_config("conn-1", Some(data_dir.join("escape.json").to_str().unwrap()));
        assert!(notes_path_for(&state, &outside).is_err());

        // allowlist 之内的绝对路径放行（solo 部署把笔记指到仓库）。
        let inside =
            postgres_config("conn-1", Some(repo_root.path().join("project").join("notes.json").to_str().unwrap()));
        let path = notes_path_for(&state, &inside).unwrap();
        assert_eq!(path, repo_root.path().join("project").join("notes.json"));

        // root 本身也放行。
        let at_root = postgres_config("conn-1", Some(repo_root.path().to_str().unwrap()));
        assert_eq!(notes_path_for(&state, &at_root).unwrap(), repo_root.path());

        // suffix 里的 `..` 爬出 root 仍拒绝。
        let climbing = postgres_config(
            "conn-1",
            Some(repo_root.path().join("project").join("..").join("escape.json").to_str().unwrap()),
        );
        assert!(notes_path_for(&state, &climbing).is_err());
    }

    #[test]
    fn env_roots_parse_via_split_paths_and_require_absolute() {
        assert_eq!(notes_roots_from_env(None), Vec::<PathBuf>::new());
        assert_eq!(notes_roots_from_env(Some(OsStr::new(""))), Vec::<PathBuf>::new());
        assert_eq!(
            notes_roots_from_env(Some(OsStr::new("relative/path"))),
            Vec::<PathBuf>::new(),
            "roots must be absolute"
        );

        #[cfg(windows)]
        let roots = [PathBuf::from(r"C:\srv\notes"), PathBuf::from(r"D:\tmp\x")];
        #[cfg(not(windows))]
        let roots = [PathBuf::from("/srv/notes"), PathBuf::from("/tmp/x")];
        let joined = std::env::join_paths(roots.iter()).unwrap();
        assert_eq!(notes_roots_from_env(Some(joined.as_os_str())), roots);
    }

    #[test]
    fn contain_within_rejects_parent_components_and_keeps_prefix_matches() {
        let base = PathBuf::from("/srv/notes");
        assert_eq!(contain_within(&base, Path::new("/srv/notes/a/b.json")), Some(base.join("a").join("b.json")));
        assert_eq!(contain_within(&base, Path::new("/srv/notes/../escape.json")), None);
        assert_eq!(contain_within(&base, Path::new("/srv/other.json")), None);
        assert_eq!(contain_within(&base, Path::new("/etc/passwd")), None);
        assert_eq!(contain_within(&base, Path::new("relative/x.json")), None);
    }
}
