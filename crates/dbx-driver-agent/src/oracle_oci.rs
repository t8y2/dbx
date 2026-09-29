//! Launch environment for the Oracle OCI ("thick") driver.
//!
//! The Oracle Client is a process-scoped C library: `NLS_LANG` is read once when
//! the client initialises, and the Instant Client shared library is resolved
//! through the platform loader path. Neither can be changed after the process
//! has started, so a connection that declares either setting must get its own
//! agent process.
//!
//! The entries produced here are folded into
//! [`crate::agent_driver::AgentLaunchSpec::env`], which
//! [`crate::agent_runtime::shared_runtime_key`] hashes. That is the whole
//! isolation mechanism: distinct environments land on distinct runtime keys,
//! hence distinct processes, with no extra bookkeeping at the call site.

/// `driver_profile` value that selects the OCI (thick) driver for Oracle.
pub const ORACLE_OCI_DRIVER_PROFILE: &str = "oci";

/// Client-side character set and territory, read by the Oracle Client on init.
pub const NLS_LANG_ENV: &str = "NLS_LANG";

/// Directory holding `tnsnames.ora` / `sqlnet.ora`.
pub const TNS_ADMIN_ENV: &str = "TNS_ADMIN";

/// Loader path variable the Oracle Client shared library is resolved through.
pub fn oracle_client_lib_path_var() -> &'static str {
    if cfg!(windows) {
        "PATH"
    } else if cfg!(target_os = "macos") {
        "DYLD_LIBRARY_PATH"
    } else {
        "LD_LIBRARY_PATH"
    }
}

fn path_separator() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

fn trimmed_non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// Prepends `client_dir` to an existing loader path value.
///
/// Already-present entries are left alone so repeated resolution cannot grow the
/// variable without bound.
pub fn prepend_oracle_client_dir(current: Option<&str>, client_dir: &str) -> String {
    let client_dir = client_dir.trim();
    let separator = path_separator();
    match trimmed_non_empty(current) {
        Some(existing) if !existing.split(separator).any(|entry| entry.trim() == client_dir) => {
            format!("{client_dir}{separator}{existing}")
        }
        Some(existing) => existing.to_string(),
        None => client_dir.to_string(),
    }
}

/// Builds the agent-process environment for an Oracle OCI connection.
///
/// Returns an empty vector when nothing is configured, which keeps the launch
/// fingerprint identical to a plain Oracle launch so the default process stays
/// shared.
pub fn oracle_oci_launch_env(
    nls_lang: Option<&str>,
    client_dir: Option<&str>,
    tns_admin: Option<&str>,
) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(nls_lang) = trimmed_non_empty(nls_lang) {
        env.push((NLS_LANG_ENV.to_string(), nls_lang.to_string()));
    }
    if let Some(tns_admin) = trimmed_non_empty(tns_admin) {
        env.push((TNS_ADMIN_ENV.to_string(), tns_admin.to_string()));
    }
    if let Some(client_dir) = trimmed_non_empty(client_dir) {
        let var = oracle_client_lib_path_var();
        let current = std::env::var(var).ok();
        env.push((var.to_string(), prepend_oracle_client_dir(current.as_deref(), client_dir)));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_oci_launch_shares_the_default_process() {
        assert!(oracle_oci_launch_env(None, None, None).is_empty());
        assert!(oracle_oci_launch_env(Some("  "), Some(""), None).is_empty());
    }

    #[test]
    fn nls_lang_is_process_scoped_environment() {
        let env = oracle_oci_launch_env(Some("  SIMPLIFIED CHINESE_CHINA.AL32UTF8  "), None, None);
        assert_eq!(env, vec![(NLS_LANG_ENV.to_string(), "SIMPLIFIED CHINESE_CHINA.AL32UTF8".to_string())]);
    }

    #[test]
    fn tns_admin_is_passed_through() {
        let env = oracle_oci_launch_env(None, None, Some("/opt/oracle/network/admin"));
        assert_eq!(env, vec![(TNS_ADMIN_ENV.to_string(), "/opt/oracle/network/admin".to_string())]);
    }

    #[test]
    fn client_dir_is_prepended_to_the_loader_path() {
        let env = oracle_oci_launch_env(None, Some("C:/instantclient_21_12"), None);
        let var = oracle_client_lib_path_var();
        assert_eq!(env.len(), 1);
        assert_eq!(env[0].0, var);
        assert!(env[0].1.starts_with("C:/instantclient_21_12"));
    }

    #[test]
    fn prepend_uses_the_platform_separator() {
        let separator = path_separator();
        assert_eq!(prepend_oracle_client_dir(Some("/usr/lib"), "/opt/oracle"), format!("/opt/oracle{separator}/usr/lib"));
    }

    #[test]
    fn prepend_is_idempotent() {
        let once = prepend_oracle_client_dir(Some("/usr/lib"), "/opt/oracle");
        assert_eq!(prepend_oracle_client_dir(Some(&once), "/opt/oracle"), once);
    }

    #[test]
    fn prepend_without_current_value_returns_client_dir() {
        assert_eq!(prepend_oracle_client_dir(None, "/opt/oracle"), "/opt/oracle");
        assert_eq!(prepend_oracle_client_dir(Some("   "), "/opt/oracle"), "/opt/oracle");
    }

    #[test]
    fn oci_profile_matches_the_connection_type_declaration() {
        assert_eq!(ORACLE_OCI_DRIVER_PROFILE, "oci");
    }
}
