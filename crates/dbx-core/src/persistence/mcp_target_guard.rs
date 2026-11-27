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
//!
//! Scope: the connection's own target, its saved `attached_databases`, and
//! DuckDB `init_script` ATTACH statements. MCP-issued SQL is separately limited
//! to no `ATTACH`/`DETACH` at all (`dbx_sql_core::sql_risk::mcp_sql_has_forbidden_file_attach`).
//!
//! Not covered: DuckDB's general file functions (`read_blob`, `read_csv`,
//! `read_parquet`, `COPY ... TO`, `INSTALL`/`LOAD`, `EXPORT DATABASE`, ...) can
//! still name an arbitrary path from SQL executed on an allowed connection.
//! Those surfaces are tracked separately as a follow-up to #9108; this guard is
//! a connection-target boundary, not a filesystem sandbox for SQL.

use std::path::{Path, PathBuf};

use crate::database_manifest;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::path_utils::expand_tilde;

/// Error code returned to MCP callers when a connection targets the config DB.
pub const CONFIG_DB_PATH_FORBIDDEN: &str = "CONFIG_DB_PATH_FORBIDDEN";

/// Whether this driver opens its target as a local file (`SQLite`, `DuckDB`,
/// `Access`, `H2`). Only those drivers have a file path to protect; for network
/// databases `host` is a hostname.
pub fn uses_local_file_target(db_type: DatabaseType) -> bool {
    database_manifest::entry(&db_type).is_some_and(|entry| entry.local_file)
}

/// Whether `config` names a local file the guard would have to compare with the
/// configuration path.
///
/// Used when no configuration path can be resolved: a `:memory:`, empty or URL
/// target cannot be the configuration database, so refusing it would only break
/// legitimate work, while anything that resolves to a file system path must be
/// refused rather than assumed safe.
pub fn names_a_local_file_target(config: &ConnectionConfig) -> bool {
    if !uses_local_file_target(config.db_type) {
        return false;
    }
    let targets = std::iter::once(config.host.as_str())
        .chain(config.attached_databases.iter().map(|attached| attached.path.as_str()));
    if targets.into_iter().any(|host| !matches!(resolve_local_target(host), LocalTarget::NotAPath)) {
        return true;
    }
    if config.db_type == DatabaseType::DuckDb {
        // An init-script ATTACH opens a file at pool creation even though the
        // connection target itself is not a path.
        return crate::db::duckdb_sql::split_sql_statements(config.init_script.as_deref().unwrap_or_default())
            .iter()
            .any(|statement| crate::db::duckdb_sql::is_attach_statement(statement));
    }
    false
}

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
/// (`dbx_drivers::db::sqlite::is_network_path`), which rewrites the host into a
/// `file:` URI opened with `SQLITE_OPEN_URI`. The loopback members of that
/// family address this machine's own drives — `\\localhost\c$`, the WSL
/// `\\wsl.localhost\<distro>\mnt\c` mount, or the machine's own `\\<host>` share.
/// They canonicalize to `\\?\UNC\...`, which never equals the drive-letter
/// configuration path, so a comparison cannot catch them; and an unreachable
/// share canonicalizes to nothing at all, which would silently read as "not the
/// configuration database". Which remote host is this machine is not decidable
/// from the path, so the guard fails closed here.
///
/// The driver predicate is not gated on Windows, so this rule is not either:
/// on POSIX any host containing `wsl$`/`wsl.localhost`, or starting with `//`,
/// is still opened as a URI, and SQLite ignores the query and the fragment —
/// `<config>?wsl$` opens the real configuration database. Refusing the whole
/// family keeps the guard from having to reimplement SQLite's URI parser.
pub fn ensure_mcp_target_allowed(config_db_path: &Path, config: &ConnectionConfig) -> Result<(), String> {
    if !uses_local_file_target(config.db_type) {
        return Ok(());
    }
    // Fail closed: without a resolved configuration path the guard cannot prove
    // the target differs, and this connection is only reachable through MCP.
    let Some(config_db_path) = canonicalize_allow_missing(config_db_path) else {
        return Err(config_db_forbidden(ForbiddenTarget::ConfigDb));
    };
    let targets = std::iter::once(config.host.as_str())
        .chain(config.attached_databases.iter().map(|attached| attached.path.as_str()));
    for host in targets {
        if let Some(reason) = host_targets_config_db(&config_db_path, host) {
            return Err(config_db_forbidden(reason));
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
                return Err(config_db_forbidden(ForbiddenTarget::ConfigDb));
            };
            if let Some(reason) = host_targets_config_db(&config_db_path, &target) {
                return Err(config_db_forbidden(reason));
            }
        }
    }
    Ok(())
}

/// Why a connection target was refused.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ForbiddenTarget {
    /// The target resolves to the configuration database or one of its sidecars.
    ConfigDb,
    /// A UNC/WSL or driver-URI form the guard cannot compare against a local
    /// path. Refused as a family because its message is different: the target
    /// may be a perfectly legitimate SMB/WSL database, not the configuration
    /// database itself.
    NetworkShare,
    /// A path-shaped target that has no canonical form in this process.
    Unresolved,
}

/// Whether a connection target/reference names the configuration database.
///
/// Network shares are refused outright — see the module docs — because their
/// resolved form cannot be compared with the local configuration path.
fn host_targets_config_db(config_db_path: &Path, host: &str) -> Option<ForbiddenTarget> {
    match resolve_local_target(host) {
        LocalTarget::NetworkShare => Some(ForbiddenTarget::NetworkShare),
        LocalTarget::File(target) => is_config_db_path(config_db_path, &target).then_some(ForbiddenTarget::ConfigDb),
        LocalTarget::Unresolved => Some(ForbiddenTarget::Unresolved),
        LocalTarget::NotAPath => None,
    }
}

/// Message for a rejected target; the resolved path is deliberately omitted so
/// the agent cannot learn where the configuration database lives.
fn config_db_forbidden(reason: ForbiddenTarget) -> String {
    match reason {
        ForbiddenTarget::ConfigDb => format!(
            "{CONFIG_DB_PATH_FORBIDDEN}: MCP connections cannot target DBX's own configuration database, which stores DBX's settings and credentials."
        ),
        // The sqlite driver opens these through its URI branch, so they can
        // alias this machine's drives. Say that instead of pretending the
        // target was the configuration database — the refusal is about an
        // unverifiable path family, not about this specific file.
        ForbiddenTarget::NetworkShare => format!(
            "{CONFIG_DB_PATH_FORBIDDEN}: MCP does not allow network (UNC), WSL or double-slash database paths. They are opened through SQLite's URI handling and cannot be verified against the local configuration database."
        ),
        // Fail closed: an unresolvable path cannot be proven harmless, and this
        // connection is only reachable through MCP.
        ForbiddenTarget::Unresolved => format!(
            "{CONFIG_DB_PATH_FORBIDDEN}: MCP cannot resolve this local database path in the MCP process, so it cannot rule out DBX's own configuration database. Use an absolute path whose parent directory exists."
        ),
    }
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
    if case_insensitive_paths() {
        target_name.to_lowercase().starts_with(&prefix.to_lowercase())
    } else {
        target_name.starts_with(&prefix)
    }
}

/// Windows file systems and macOS's default volume format compare file names
/// case-insensitively, so `DBX.DB-WAL` can be the same file as `dbx.db-wal`
/// there. Linux file systems do not, and the guard must not refuse an unrelated
/// file that merely differs in case.
fn case_insensitive_paths() -> bool {
    cfg!(any(windows, target_os = "macos"))
}

fn same_path(left: &Path, right: &Path) -> bool {
    if case_insensitive_paths() {
        left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

/// How a connection `host` (or saved attachment / `ATTACH` target) resolves.
#[derive(Debug, PartialEq, Eq)]
enum LocalTarget {
    /// A local file the embedded driver opens directly, canonicalized.
    File(PathBuf),
    /// Not a path this guard can compare: JDBC URLs, `file://` URIs and socket
    /// names are not files the embedded drivers open through the URI flags.
    NotAPath,
    /// A UNC/WSL share form that can alias one of this machine's own drives.
    /// Refused by the caller.
    NetworkShare,
    /// A host that reads as a file system path but has no canonical form in
    /// this process (a missing ancestor for the whole chain, an unavailable
    /// cwd). Refused by the caller: the guard cannot prove it is not the
    /// configuration database.
    Unresolved,
}

/// Whether `host` is a form the sqlite driver opens through its network-path
/// branch (`dbx_drivers::db::sqlite::is_network_path`), which rewrites it into
/// a `file:` URI opened with `SQLITE_OPEN_URI`.
///
/// Decided on the raw string, before canonicalization, on every platform: the
/// driver predicate has no OS gate, so a POSIX host such as `<config>?wsl$` is
/// opened as `file:<config>?…`, and SQLite ignores unknown query parameters and
/// the fragment — the literal string names no file, yet the real one is opened.
/// The predicate is the driver's own, so the two cannot drift apart.
fn is_driver_network_path(host: &str) -> bool {
    crate::db::sqlite::is_network_path(host)
}

/// Resolves a connection `host` the same way the drivers do (tilde expansion,
/// relative to the process cwd) and canonicalizes it.
fn resolve_local_target(host: &str) -> LocalTarget {
    resolve_local_target_with_cwd(host, std::env::current_dir().ok().as_deref())
}

/// [`resolve_local_target`] with an explicit cwd, so the fail-closed behaviour
/// for an unavailable cwd is testable on every platform.
fn resolve_local_target_with_cwd(host: &str, cwd: Option<&Path>) -> LocalTarget {
    let host = host.trim();
    // `file:` URIs stay unresolvable here on purpose: the sqlite driver only
    // sets `SQLITE_OPEN_URI` for `is_network_path` hosts, so a `file:///...`
    // string is opened as a literal file name and cannot address `dbx.db`.
    // Revisit this branch if that ever changes.
    if host.is_empty() || host.contains("://") || host.starts_with("jdbc:") {
        return LocalTarget::NotAPath;
    }
    if is_driver_network_path(host) {
        return LocalTarget::NetworkShare;
    }
    let path = PathBuf::from(expand_tilde(host));
    let absolute = if path.is_absolute() {
        path
    } else {
        let Some(cwd) = cwd else {
            // Fail closed: a relative path with no cwd cannot be compared.
            return LocalTarget::Unresolved;
        };
        cwd.join(path)
    };
    // Fail closed as well: without a canonical form the guard cannot prove the
    // target differs from the configuration database.
    canonicalize_allow_missing(&absolute).map_or(LocalTarget::Unresolved, LocalTarget::File)
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

    #[test]
    fn refuses_network_shares_with_a_network_path_message() {
        // The refusal is about an unverifiable path family, not about having
        // recognized this file as `dbx.db`; legitimate SMB/WSL connections are
        // blocked too, so the message must say so.
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let error =
            ensure_mcp_target_allowed(&config_db, &sqlite_connection(r"\\fileserver\share\dbx.db")).unwrap_err();
        assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{error}");
        assert!(error.contains("network (UNC)"), "{error}");

        // A real configuration-database target keeps the original message.
        let target = config_db.to_string_lossy().into_owned();
        let error = ensure_mcp_target_allowed(&config_db, &sqlite_connection(&target)).unwrap_err();
        assert!(error.contains("own configuration database"), "{error}");
    }

    #[test]
    fn classifies_driver_network_paths_on_every_platform() {
        // The sqlite driver predicate is not gated on Windows, so the guard
        // must not be either; this runs in Linux CI where the Windows-only
        // guard tests would otherwise be skipped.
        for host in [
            r"\\fileserver\share\dbx.db",
            "//localhost/c$/Users/me/dbx.db",
            r"\\?\UNC\server\share\dbx.db",
            "/data/config.db?wsl$",
            "/data/config.db#wsl.localhost",
            r"\\wsl$\Ubuntu\mnt\c\dbx.db",
        ] {
            assert!(is_driver_network_path(host), "{host}");
        }
        for host in ["/data/app.db", "reporting.db", "jdbc:h2:file:/data/example", "file:///data/example", ""] {
            assert!(!is_driver_network_path(host), "{host}");
        }
    }

    #[test]
    fn rejects_uri_suffixes_that_sqlite_ignores() {
        // Regression: the driver rewrites any host containing `wsl$` or
        // `wsl.localhost` into a `file:` URI and SQLite ignores the query and
        // the fragment, so `<config>?wsl$` opens the configuration database
        // while the literal string names nothing. This must be refused on
        // POSIX too, where the Windows-only gate used to let it through.
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let config = config_db.to_string_lossy();
        for host in [
            format!("{config}?wsl$"),
            format!("{config}#wsl.localhost"),
            format!("{config}?wsl$#wsl.localhost"),
            format!("{config}-wal?wsl$"),
        ] {
            let error = ensure_mcp_target_allowed(&config_db, &sqlite_connection(&host)).unwrap_err();
            assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{host}: {error}");
        }
    }

    #[test]
    fn fails_closed_without_a_resolvable_cwd() {
        // An unavailable cwd leaves a relative target with no canonical form;
        // the guard must refuse rather than read it as "not the config DB".
        assert_eq!(resolve_local_target_with_cwd("app.db", None), LocalTarget::Unresolved);
        let directory = temp_dir();
        assert!(matches!(resolve_local_target_with_cwd("app.db", Some(directory.path())), LocalTarget::File(_)));
    }

    #[cfg(windows)]
    #[test]
    fn fails_closed_on_a_missing_drive() {
        // A path on a drive that does not exist has no ancestor to canonicalize,
        // so it cannot be compared with the configuration path.
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let Some(root) = ["Q:", "R:", "S:", "T:", "U:", "V:", "W:", "X:", "Y:", "Z:"]
            .map(PathBuf::from)
            .into_iter()
            .find(|root| !root.exists())
        else {
            return;
        };
        let host = root.join("dbx").join("app.db");
        let error = ensure_mcp_target_allowed(&config_db, &sqlite_connection(&host.to_string_lossy())).unwrap_err();
        assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{error}");
        assert!(error.contains("cannot resolve"), "{error}");
    }

    #[test]
    fn unresolved_boundary_only_counts_real_file_targets() {
        // No config path to compare: targets that cannot be a file stay usable,
        // anything that names a file is unverifiable.
        for host in ["", "jdbc:h2:file:/data/example", "file:///data/example", "  "] {
            assert!(!names_a_local_file_target(&sqlite_connection(host)), "{host}");
        }
        let directory = temp_dir();
        let host = directory.path().join("app.db").to_string_lossy().into_owned();
        assert!(names_a_local_file_target(&sqlite_connection(&host)));

        let mut duck = duckdb_connection("", "ATTACH 'sales.duckdb' AS sales");
        assert!(names_a_local_file_target(&duck));
        duck.init_script = Some("INSTALL httpfs".to_string());
        assert!(!names_a_local_file_target(&duck));
    }

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
    fn refuses_double_slash_paths_on_posix() {
        // The sqlite driver's network-path predicate has no OS gate, so a
        // `//`-prefixed host is opened through its URI branch on POSIX as well
        // and the literal string is not what gets opened. `display()` already
        // yields an absolute path on POSIX, so prefixing one slash gives
        // `//tmp/...`.
        let directory = temp_dir();
        let config_db = directory.path().join("dbx.db");
        let host = format!("/{}/app.db", directory.path().display());
        let error = ensure_mcp_target_allowed(&config_db, &sqlite_connection(&host)).unwrap_err();
        assert!(error.starts_with(CONFIG_DB_PATH_FORBIDDEN), "{host}: {error}");
    }
}
