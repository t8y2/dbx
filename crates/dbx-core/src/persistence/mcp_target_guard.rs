//! Rejects MCP connection targets that would open DBX's own configuration
//! database.
//!
//! `dbx.db` holds `app_settings` (including `mcp_global_policy`) and the stored
//! connection credentials. An agent that can open that file through an ordinary
//! SQLite/DuckDB connection can rewrite the policy meant to constrain it, and the
//! policy is re-read on every tool call. Every MCP connection mutation reaches
//! [`Storage::add_connection_for_mcp`](crate::persistence::storage::Storage::add_connection_for_mcp)
//! and [`Storage::duplicate_connection_for_mcp`](crate::persistence::storage::Storage::duplicate_connection_for_mcp),
//! so the rejection lives there rather than only in the MCP tool handlers: the
//! storage owns the real database path even when a standalone MCP process
//! resolves `DBX_DATA_DIR` differently.

use std::path::{Path, PathBuf};

use crate::database_manifest;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::path_utils::expand_tilde;

/// Error code returned to MCP callers when a connection targets the config DB.
pub const CONFIG_DB_PATH_FORBIDDEN: &str = "CONFIG_DB_PATH_FORBIDDEN";

/// Returns `Err(CONFIG_DB_PATH_FORBIDDEN: ...)` when `config` is a local-file
/// database whose target — its own file, one of its saved `attached_databases`,
/// or an `ATTACH` inside the DuckDB `init_script` — resolves to `config_db_path`
/// or one of its SQLite sidecars (`-wal`, `-shm`, `-journal`).
///
/// Saved attachments and init scripts matter as much as the main file: DBX
/// restores both during pool creation, so a connection whose main file is
/// harmless could still expose `dbx.db` under another schema name.
///
/// Only the configuration database is protected, not its whole directory: an
/// agent may legitimately work with other SQLite/DuckDB files stored next to
/// `dbx.db`. The check is also limited to drivers flagged `local_file` in the
/// driver manifest (SQLite, DuckDB, Access, H2): for network databases `host`
/// is a hostname, not a path.
///
/// UNC/WSL targets are refused as a family instead of being compared: the
/// sqlite driver opens them through its network path handling
/// (`dbx_drivers::db::sqlite::is_network_path`), and the loopback members of
/// that family address this machine's own drives — `\\localhost\c$`, the WSL
/// `\\wsl.localhost\<distro>\mnt\c` mount, or the machine's own `\\<host>` share.
/// They canonicalize to `\\?\UNC\...`, which never equals the drive-letter
/// configuration path, so a comparison cannot catch them; and an unreachable
/// share canonicalizes to nothing at all, which would silently read as "not the
/// configuration database". Which remote host is this machine is not decidable
/// from the path, so the guard fails closed here.
pub fn ensure_mcp_target_allowed(config_db_path: &Path, config: &ConnectionConfig) -> Result<(), String> {
    if !database_manifest::entry(&config.db_type).is_some_and(|entry| entry.local_file) {
        return Ok(());
    }
    // Fail closed: without a resolved configuration path the guard cannot prove
    // the target differs, and this connection is only reachable through MCP.
    let Some(config_db_path) = canonicalize_allow_missing(config_db_path) else {
        return Err(config_db_forbidden());
    };
    let targets = std::iter::once(config.host.as_str())
        .chain(config.attached_databases.iter().map(|attached| attached.path.as_str()));
    for host in targets {
        if host_targets_config_db(&config_db_path, host) {
            return Err(config_db_forbidden());
        }
    }
    // DuckDB executes its init script when the pool is created, so an ATTACH
    // there opens a local file without ever naming it as the connection target.
    if config.db_type == DatabaseType::DuckDb {
        let script = config.init_script.as_deref().unwrap_or_default();
        for statement in crate::db::duckdb_sql::split_sql_statements(script) {
            if !crate::db::duckdb_sql::is_attach_statement(&statement) {
                continue;
            }
            // Fail closed: an ATTACH whose target cannot be read could hide a
            // local file, and the connection is only reachable through MCP here.
            let Some(target) = crate::db::duckdb_sql::attached_target_from_attach_sql(&statement) else {
                return Err(config_db_forbidden());
            };
            if host_targets_config_db(&config_db_path, &target) {
                return Err(config_db_forbidden());
            }
        }
    }
    Ok(())
}

/// Whether a connection target/reference names the configuration database.
///
/// Network shares are refused outright — see the module docs — because their
/// resolved form cannot be compared with the local configuration path.
fn host_targets_config_db(config_db_path: &Path, host: &str) -> bool {
    match resolve_local_target(host) {
        LocalTarget::NetworkShare => true,
        LocalTarget::File(target) => is_config_db_path(config_db_path, &target),
        LocalTarget::NotAPath => false,
    }
}

/// Shared message for every rejected target; the resolved path is deliberately
/// omitted so the agent cannot learn where the configuration database lives.
fn config_db_forbidden() -> String {
    format!(
        "{CONFIG_DB_PATH_FORBIDDEN}: MCP connections cannot target DBX's own configuration database, which stores DBX's settings and credentials."
    )
}

/// Matches `dbx.db` itself and the SQLite sidecars that share its file-name
/// prefix (`dbx.db-wal`, `dbx.db-shm`, `dbx.db-journal`).
fn is_config_db_path(config_db_path: &Path, target: &Path) -> bool {
    if same_path(target, config_db_path) {
        return true;
    }
    if !target.parent().zip(config_db_path.parent()).is_some_and(|(left, right)| same_path(left, right)) {
        return false;
    }
    let (Some(target_name), Some(db_name)) = (target.file_name(), config_db_path.file_name()) else {
        return false;
    };
    let target_name = target_name.to_string_lossy();
    let prefix = format!("{}-", db_name.to_string_lossy());
    // Windows file systems are case-insensitive; elsewhere the exact bytes are
    // what the driver will open.
    if cfg!(windows) {
        target_name.to_lowercase().starts_with(&prefix.to_lowercase())
    } else {
        target_name.starts_with(&prefix)
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

/// How a connection `host` (or saved attachment / `ATTACH` target) resolves.
enum LocalTarget {
    /// A local file the embedded driver opens directly, canonicalized.
    File(PathBuf),
    /// Not a path this guard can compare: JDBC URLs, `file://` URIs and socket
    /// names are not files the embedded drivers open through the URI flags, and
    /// a path whose existing ancestors cannot be resolved (an offline drive, a
    /// missing cwd) has no canonical form to compare against.
    NotAPath,
    /// A UNC/WSL share form that can alias one of this machine's own drives.
    /// Refused by the caller.
    NetworkShare,
}

/// Whether `host` is a UNC/WSL form that can alias a local drive
/// (`\\localhost\c$`, `\\wsl.localhost\<distro>\mnt\c`, `\\<hostname>\c$`).
///
/// Decided on the raw string, before canonicalization: an unreachable share
/// canonicalizes to nothing, and that must not read as "not the config DB".
/// The predicate is the driver's own, so the two cannot drift apart. POSIX
/// needs no such rule — `//server/share` is an ordinary path there and
/// `canonicalize` collapses it to a normal absolute path.
fn is_local_drive_alias(host: &str) -> bool {
    cfg!(windows) && crate::db::sqlite::is_network_path(host)
}

/// Resolves a connection `host` the same way the drivers do (tilde expansion,
/// relative to the process cwd) and canonicalizes it.
fn resolve_local_target(host: &str) -> LocalTarget {
    let host = host.trim();
    // `file:` URIs stay unresolvable here on purpose: the sqlite driver only
    // sets `SQLITE_OPEN_URI` for `is_network_path` hosts, so a `file:///...`
    // string is opened as a literal file name and cannot address `dbx.db`.
    // Revisit this branch if that ever changes.
    if host.is_empty() || host.contains("://") || host.starts_with("jdbc:") {
        return LocalTarget::NotAPath;
    }
    if is_local_drive_alias(host) {
        return LocalTarget::NetworkShare;
    }
    let path = PathBuf::from(expand_tilde(host));
    let absolute = if path.is_absolute() {
        path
    } else {
        let Ok(cwd) = std::env::current_dir() else {
            return LocalTarget::NotAPath;
        };
        cwd.join(path)
    };
    canonicalize_allow_missing(&absolute).map_or(LocalTarget::NotAPath, LocalTarget::File)
}

/// Canonicalizes `path`, tolerating a final component that does not exist yet.
///
/// A new SQLite/DuckDB connection usually points at a file that has not been
/// created, so `fs::canonicalize` fails on it. Walk up to the closest existing
/// ancestor, canonicalize that (resolving symlinks/junctions and Windows 8.3
/// short names or casing), then append the missing components unchanged.
fn canonicalize_allow_missing(path: &Path) -> Option<PathBuf> {
    if let Ok(resolved) = std::fs::canonicalize(path) {
        return Some(resolved);
    }
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        let name = current.file_name()?.to_os_string();
        missing.push(name);
        if !current.pop() {
            return None;
        }
        if let Ok(mut resolved) = std::fs::canonicalize(&current) {
            for component in missing.iter().rev() {
                resolved.push(component);
            }
            return Some(resolved);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqlite_connection(host: &str) -> ConnectionConfig {
        // `ConnectionConfig` has defaults for most fields but no `Default` impl,
        // so build the minimal required shape through serde like the MCP tool does.
        serde_json::from_value(serde_json::json!({
            "id": "conn",
            "name": "conn",
            "db_type": "sqlite",
            "host": host,
            "port": 0,
            "username": "",
            "password": "",
            "database": null,
        }))
        .expect("connection config")
    }

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temporary directory")
    }

    fn duckdb_connection(host: &str, init_script: &str) -> ConnectionConfig {
        let mut config = sqlite_connection(host);
        config.db_type = DatabaseType::DuckDb;
        config.init_script = Some(init_script.to_string());
        config
    }

    #[test]
    fn rejects_a_duckdb_init_script_that_attaches_the_config_database() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let host = directory.path().join("lake.duckdb").to_string_lossy().into_owned();
        for script in [
            format!("INSTALL httpfs;\nATTACH '{}' AS cfg;", config_db.display()),
            format!("ATTACH DATABASE '{}' AS cfg", config_db.display()),
            format!("attach if not exists '{}' as cfg", config_db.display()),
            format!("-- note\n/* block */ ATTACH '{}' AS cfg", config_db.display()),
        ] {
            let error = ensure_mcp_target_allowed(&config_db, &duckdb_connection(&host, &script)).unwrap_err();
            assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{script}: {error}");
        }
    }

    #[test]
    fn rejects_a_duckdb_init_script_attach_it_cannot_parse() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let host = directory.path().join("lake.duckdb").to_string_lossy().into_owned();
        let error = ensure_mcp_target_allowed(&config_db, &duckdb_connection(&host, "ATTACH some_expression AS cfg"))
            .unwrap_err();
        assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{error}");
    }

    #[test]
    fn allows_duckdb_init_scripts_that_attach_other_files() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let host = directory.path().join("lake.duckdb").to_string_lossy().into_owned();
        let sibling = directory.path().join("sales.duckdb");
        let script = format!(
            "INSTALL httpfs; LOAD httpfs; ATTACH '{}' AS sales; ATTACH 'ducklake:postgres:dbname=lake' AS lake",
            sibling.display()
        );
        assert!(ensure_mcp_target_allowed(&config_db, &duckdb_connection(&host, &script)).is_ok());
    }

    #[test]
    fn ignores_init_scripts_for_non_duckdb_connections() {
        // `init_script` is a DuckDB-only field; SQLite never executes it, so the
        // same text must not turn a valid SQLite connection into a rejection.
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let host = directory.path().join("app.db").to_string_lossy().into_owned();
        let mut config = sqlite_connection(&host);
        config.init_script = Some(format!("ATTACH '{}' AS cfg", config_db.display()));
        assert!(ensure_mcp_target_allowed(&config_db, &config).is_ok());
    }

    #[test]
    fn rejects_the_config_database_and_its_sidecars() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        for name in ["dbx.db", "dbx.db-wal", "dbx.db-shm", "dbx.db-journal"] {
            let target = directory.path().join(name);
            let error =
                ensure_mcp_target_allowed(&config_db, &sqlite_connection(&target.to_string_lossy())).unwrap_err();
            assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{error}");
        }
    }

    #[test]
    fn rejects_traversal_and_not_yet_created_targets() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        std::fs::create_dir_all(directory.path().join("sub")).unwrap();

        let traversal = format!("{}/sub/../dbx.db", directory.path().display());
        let error = ensure_mcp_target_allowed(&config_db, &sqlite_connection(&traversal)).unwrap_err();
        assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{error}");

        // Sidecars may not exist yet; the existing ancestor is enough.
        let future_sidecar = directory.path().join("dbx.db-wal");
        assert!(!future_sidecar.exists());
        let error =
            ensure_mcp_target_allowed(&config_db, &sqlite_connection(&future_sidecar.to_string_lossy())).unwrap_err();
        assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{error}");
    }

    #[test]
    fn allows_other_databases_in_the_same_directory() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        std::fs::create_dir_all(directory.path().join("sub")).unwrap();
        for name in ["query.db", "dbx_backup.db", "sub/app.db", "dbx.db.backup"] {
            let target = directory.path().join(name);
            assert!(
                ensure_mcp_target_allowed(&config_db, &sqlite_connection(&target.to_string_lossy())).is_ok(),
                "{name}"
            );
        }
    }

    #[test]
    fn allows_targets_outside_the_config_directory() {
        let directory = temp_dir();
        let config_db = directory.path().join("data").join("dbx.db");
        let outside = directory.path().join("scratch").join("app.db");
        assert!(ensure_mcp_target_allowed(&config_db, &sqlite_connection(&outside.to_string_lossy())).is_ok());
        // A sibling directory with a same-named file is a different database.
        let sibling = directory.path().join("other").join("dbx.db");
        assert!(ensure_mcp_target_allowed(&config_db, &sqlite_connection(&sibling.to_string_lossy())).is_ok());
    }

    #[test]
    fn rejects_a_saved_attachment_that_points_at_the_config_database() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let mut config = sqlite_connection(&directory.path().join("app.db").to_string_lossy());
        config.attached_databases = vec![crate::models::connection::AttachedDatabaseConfig {
            name: "cfg".to_string(),
            path: config_db.to_string_lossy().into_owned(),
        }];
        let error = ensure_mcp_target_allowed(&config_db, &config).unwrap_err();
        assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{error}");
    }

    #[test]
    fn allows_saved_attachments_next_to_the_config_database() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let sibling = directory.path().join("reporting.db");
        let mut config = sqlite_connection(&directory.path().join("app.db").to_string_lossy());
        config.attached_databases = vec![crate::models::connection::AttachedDatabaseConfig {
            name: "reporting".to_string(),
            path: sibling.to_string_lossy().into_owned(),
        }];
        assert!(ensure_mcp_target_allowed(&config_db, &config).is_ok());
    }

    #[test]
    fn allows_network_databases_whose_host_is_not_a_path() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let mut config = sqlite_connection(&config_db.to_string_lossy());
        config.db_type = DatabaseType::Mysql;
        assert!(ensure_mcp_target_allowed(&config_db, &config).is_ok());
    }

    #[test]
    fn allows_non_path_hosts() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        for host in ["jdbc:h2:file:/data/example", "file:///data/example", "  "] {
            assert!(ensure_mcp_target_allowed(&config_db, &sqlite_connection(host)).is_ok(), "{host}");
        }
    }

    #[test]
    fn rejects_every_local_file_target_when_the_config_path_is_unresolvable() {
        // Fail closed: an empty (unresolvable) configuration path must not read
        // as "nothing to protect" — this connection is only reachable via MCP.
        let directory = temp_dir();
        let host = directory.path().join("app.db").to_string_lossy().into_owned();
        let error = ensure_mcp_target_allowed(Path::new(""), &sqlite_connection(&host)).unwrap_err();
        assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{error}");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_unc_aliases_of_this_machine() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let target = r"Users\me\AppData\Roaming\dbx\dbx.db";
        for host in [
            // The admin share of this machine opens a local drive directly, and
            // canonicalizes to \\?\UNC\LOCALHOST\C$\... — never the drive path.
            format!(r"\\localhost\c$\{target}"),
            format!(r"\\127.0.0.1\c$\{target}"),
            format!("//localhost/c$/{target}"),
            // The WSL automount of a Windows drive is the same file.
            format!(r"\\wsl.localhost\Ubuntu\mnt\c\{target}"),
            format!(r"\\wsl$\Ubuntu\mnt\c\{target}"),
            // Every UNC form is refused as a family, reachable or not, because
            // an unreachable one canonicalizes to nothing.
            r"\\fileserver\share\dbx.db".to_string(),
        ] {
            let error = ensure_mcp_target_allowed(&config_db, &sqlite_connection(&host)).unwrap_err();
            assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{host}: {error}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_unc_aliases_in_saved_attachments_and_init_scripts() {
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let host = directory.path().join("app.db").to_string_lossy().into_owned();

        let mut config = sqlite_connection(&host);
        config.attached_databases = vec![crate::models::connection::AttachedDatabaseConfig {
            name: "cfg".to_string(),
            path: r"\\wsl.localhost\Ubuntu\mnt\c\Users\me\AppData\Roaming\dbx\dbx.db".to_string(),
        }];
        let error = ensure_mcp_target_allowed(&config_db, &config).unwrap_err();
        assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{error}");

        let script = r"ATTACH '\\localhost\c$\Users\me\AppData\Roaming\dbx\dbx.db' AS cfg";
        let error = ensure_mcp_target_allowed(&config_db, &duckdb_connection(&host, script)).unwrap_err();
        assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{error}");
    }

    #[cfg(not(windows))]
    #[test]
    fn allows_double_slash_paths_on_posix() {
        // Outside Windows `//x` is an ordinary path with no drive aliasing, so
        // the UNC rule must not reject it. `display()` already yields an
        // absolute path on POSIX, so prefixing one slash gives `//tmp/...`.
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let host = format!("/{}/app.db", directory.path().display());
        assert!(ensure_mcp_target_allowed(&config_db, &sqlite_connection(&host)).is_ok(), "{host}");
    }
}
