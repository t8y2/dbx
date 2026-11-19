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

/// JDBC URL prefixes of the two Oracle protocols. The connection dialog always
/// stores the thin form; an OCI connection has to launch the same target with
/// the `oci8` protocol instead.
const ORACLE_THIN_URL_PREFIX: &str = "jdbc:oracle:thin:";
const ORACLE_OCI_URL_PREFIX: &str = "jdbc:oracle:oci8:";

/// Whether `config` selects the OCI (thick) driver.
pub fn uses_oracle_oci_profile(config: &crate::models::connection::ConnectionConfig) -> bool {
    config.driver_profile.as_deref() == Some(ORACLE_OCI_DRIVER_PROFILE)
}

/// Switches an Oracle JDBC URL between the thin and OCI protocol.
///
/// Unknown shapes are returned trimmed but unchanged, so a hand-written URL
/// (connect descriptor, TNS alias, `//host:port/service`) keeps working.
pub fn rewrite_oracle_url_protocol(url: &str, oci: bool) -> String {
    let trimmed = url.trim();
    let (from, to) = if oci {
        (ORACLE_THIN_URL_PREFIX, ORACLE_OCI_URL_PREFIX)
    } else {
        (ORACLE_OCI_URL_PREFIX, ORACLE_THIN_URL_PREFIX)
    };
    if trimmed.len() >= from.len() && trimmed[..from.len()].eq_ignore_ascii_case(from) {
        return format!("{to}{}", &trimmed[from.len()..]);
    }
    trimmed.to_string()
}

/// Drops a query string that only carries `TNS_ADMIN`.
///
/// OCI reads the directory from the `TNS_ADMIN` environment variable of the
/// agent process (see [`oracle_oci_launch_env`]), so the dialog's
/// `?TNS_ADMIN=…` suffix is redundant there. Any other parameter is preserved.
pub fn strip_oracle_tns_admin_query(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return url.to_string();
    };
    let pairs: Vec<&str> = query.split('&').filter(|pair| !pair.trim().is_empty()).collect();
    let only_tns_admin = !pairs.is_empty()
        && pairs.iter().all(|pair| pair.split('=').next().is_some_and(|key| key.eq_ignore_ascii_case("TNS_ADMIN")));
    if only_tns_admin {
        base.to_string()
    } else {
        url.to_string()
    }
}

/// Reads the `TNS_ADMIN` directory the TNS connection form packs into the URL.
pub fn oracle_tns_admin_from_connection_string(connection_string: &str) -> Option<String> {
    let (_, query) = connection_string.trim().split_once('?')?;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if !key.eq_ignore_ascii_case("TNS_ADMIN") {
            return None;
        }
        let decoded = percent_decode(value.trim());
        (!decoded.is_empty()).then_some(decoded)
    })
}

/// 解析 OCI 连接使用的 `TNS_ADMIN` 目录。
///
/// 优先级：连接级字段 > TNS 连接串里打包的目录 > 全局默认。连接串里的目录
/// 来自 TNS 连接方式（前端把它打包进 JDBC URL），属于本连接自己的配置，
/// 因此优先于全局默认。
pub fn resolve_oci_tns_admin(
    explicit: Option<&str>,
    connection_string: Option<&str>,
    global_default: Option<&str>,
) -> Option<String> {
    trimmed_non_empty(explicit)
        .map(str::to_string)
        .or_else(|| connection_string.and_then(oracle_tns_admin_from_connection_string))
        .or_else(|| trimmed_non_empty(global_default).map(str::to_string))
}

/// Minimal `application/x-www-form-urlencoded` decoder (`%XX` escapes and `+`).
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            b'%' if index + 3 <= bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                    .ok()
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok());
                match hex {
                    Some(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    None => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
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
        assert_eq!(
            prepend_oracle_client_dir(Some("/usr/lib"), "/opt/oracle"),
            format!("/opt/oracle{separator}/usr/lib")
        );
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

    #[test]
    fn thin_urls_are_rewritten_to_the_oci_protocol() {
        assert_eq!(
            rewrite_oracle_url_protocol("jdbc:oracle:thin:@//db.example.com:1521/ORCLPDB1", true),
            "jdbc:oracle:oci8:@//db.example.com:1521/ORCLPDB1"
        );
        assert_eq!(
            rewrite_oracle_url_protocol("jdbc:oracle:thin:@db.example.com:1521:ORCL", true),
            "jdbc:oracle:oci8:@db.example.com:1521:ORCL"
        );
        assert_eq!(
            rewrite_oracle_url_protocol(
                "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521)))",
                true
            ),
            "jdbc:oracle:oci8:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521)))"
        );
    }

    #[test]
    fn oci_urls_are_rewritten_back_to_thin() {
        assert_eq!(
            rewrite_oracle_url_protocol("jdbc:oracle:oci8:@//db.example.com:1521/ORCLPDB1", false),
            "jdbc:oracle:thin:@//db.example.com:1521/ORCLPDB1"
        );
    }

    #[test]
    fn unknown_url_shapes_are_left_alone() {
        assert_eq!(rewrite_oracle_url_protocol("jdbc:postgresql://db/app", true), "jdbc:postgresql://db/app");
        assert_eq!(rewrite_oracle_url_protocol("", true), "");
    }

    #[test]
    fn tns_admin_prefers_the_connection_field_over_the_url_and_global() {
        assert_eq!(
            resolve_oci_tns_admin(
                Some("C:/wallets/adb"),
                Some("jdbc:oracle:oci8:@ALIAS?TNS_ADMIN=C:/from-url"),
                Some("C:/global"),
            )
            .as_deref(),
            Some("C:/wallets/adb")
        );
    }

    #[test]
    fn tns_admin_falls_back_to_the_url_then_the_global_default() {
        assert_eq!(
            resolve_oci_tns_admin(None, Some("jdbc:oracle:oci8:@ALIAS?TNS_ADMIN=C:/from-url"), Some("C:/global"),)
                .as_deref(),
            Some("C:/from-url")
        );
        assert_eq!(
            resolve_oci_tns_admin(None, Some("jdbc:oracle:oci8:@ALIAS"), Some("C:/global")).as_deref(),
            Some("C:/global")
        );
        assert_eq!(resolve_oci_tns_admin(None, None, None), None);
        assert_eq!(resolve_oci_tns_admin(Some("   "), None, Some("C:/global")).as_deref(), Some("C:/global"));
    }

    #[test]
    fn tns_admin_query_is_read_and_decoded() {
        assert_eq!(
            oracle_tns_admin_from_connection_string(
                "jdbc:oracle:thin:@ORCLPDB1?TNS_ADMIN=C%3A%5Coracle%5Cnetwork%5Cadmin"
            ),
            Some("C:\\oracle\\network\\admin".to_string())
        );
        assert_eq!(
            oracle_tns_admin_from_connection_string("jdbc:oracle:thin:@ORCLPDB1?TNS_ADMIN=/opt/oracle/admin"),
            Some("/opt/oracle/admin".to_string())
        );
        assert_eq!(oracle_tns_admin_from_connection_string("jdbc:oracle:thin:@//host:1521/svc"), None);
        assert_eq!(oracle_tns_admin_from_connection_string(""), None);
    }

    #[test]
    fn tns_admin_query_is_stripped_only_when_it_stands_alone() {
        assert_eq!(
            strip_oracle_tns_admin_query("jdbc:oracle:oci8:@ORCLPDB1?TNS_ADMIN=/opt/oracle/admin"),
            "jdbc:oracle:oci8:@ORCLPDB1"
        );
        assert_eq!(
            strip_oracle_tns_admin_query("jdbc:oracle:oci8:@ORCLPDB1?TNS_ADMIN=/opt/oracle/admin&other=1"),
            "jdbc:oracle:oci8:@ORCLPDB1?TNS_ADMIN=/opt/oracle/admin&other=1"
        );
    }
}
