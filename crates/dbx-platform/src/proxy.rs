pub fn system_proxy_url() -> Option<String> {
    system_proxy_url_from_platform()
}

#[cfg(target_os = "macos")]
fn system_proxy_url_from_platform() -> Option<String> {
    let output = crate::process::new_std_command("scutil").arg("--proxy").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    system_proxy_url_from_scutil_output(&stdout)
}

#[cfg(target_os = "windows")]
fn system_proxy_url_from_platform() -> Option<String> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let proxy_enable =
        crate::process::new_std_command("reg").args(["query", key, "/v", "ProxyEnable"]).output().ok()?;
    let proxy_server =
        crate::process::new_std_command("reg").args(["query", key, "/v", "ProxyServer"]).output().ok()?;
    if !proxy_enable.status.success() || !proxy_server.status.success() {
        return None;
    }
    let proxy_enable = String::from_utf8(proxy_enable.stdout).ok()?;
    let proxy_server = String::from_utf8(proxy_server.stdout).ok()?;
    system_proxy_url_from_windows_registry_output(&proxy_enable, &proxy_server)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_proxy_url_from_platform() -> Option<String> {
    None
}

#[cfg_attr(not(test), allow(dead_code))]
fn system_proxy_url_from_scutil_output(output: &str) -> Option<String> {
    let value = |key: &str| {
        output.lines().find_map(|line| {
            let (line_key, line_value) = line.split_once(':')?;
            (line_key.trim() == key).then(|| line_value.trim())
        })
    };

    if value("HTTPSEnable") == Some("1") {
        if let Some(url) = proxy_url(value("HTTPSProxy")?, value("HTTPSPort")?) {
            return Some(url);
        }
    }

    if value("HTTPEnable") == Some("1") {
        if let Some(url) = proxy_url(value("HTTPProxy")?, value("HTTPPort")?) {
            return Some(url);
        }
    }

    None
}

#[cfg_attr(not(test), allow(dead_code))]
fn system_proxy_url_from_windows_registry_output(proxy_enable: &str, proxy_server: &str) -> Option<String> {
    let enabled = proxy_enable
        .lines()
        .find(|line| line.contains("ProxyEnable"))?
        .split_whitespace()
        .last()
        .is_some_and(|value| value == "0x1" || value == "1");
    if !enabled {
        return None;
    }

    let server = proxy_server.lines().find(|line| line.contains("ProxyServer"))?.split_whitespace().last()?;

    proxy_url_from_windows_proxy_server(server)
}

fn proxy_url_from_windows_proxy_server(server: &str) -> Option<String> {
    let entries = server.split(';').map(str::trim).filter(|entry| !entry.is_empty()).collect::<Vec<_>>();

    for key in ["https=", "http="] {
        if let Some(entry) = entries.iter().find_map(|entry| entry.strip_prefix(key)) {
            if let Some(url) = proxy_url_from_host_port(entry) {
                return Some(url);
            }
        }
    }

    entries.iter().find(|entry| !entry.contains('=')).and_then(|entry| proxy_url_from_host_port(entry))
}

fn proxy_url_from_host_port(value: &str) -> Option<String> {
    let value = value.trim();
    if value.starts_with("http://") || value.starts_with("https://") {
        return Some(value.to_string());
    }
    if value.starts_with("socks://") || value.starts_with("socks5://") || value.starts_with("socks5h://") {
        return None;
    }

    let (host, port) = if let Some(rest) = value.strip_prefix('[') {
        let (host, rest) = rest.split_once(']')?;
        let port = rest.strip_prefix(':')?;
        (host, port)
    } else {
        value.rsplit_once(':')?
    };
    proxy_url(host, port)
}

fn proxy_url(host: &str, port: &str) -> Option<String> {
    if host.is_empty() || port.parse::<u16>().is_err() {
        return None;
    }
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
    Some(format!("http://{host}:{port}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_macos_https_system_proxy() {
        let output = r#"<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
}"#;

        assert_eq!(system_proxy_url_from_scutil_output(output), Some("http://127.0.0.1:7891".to_string()));
    }

    #[test]
    fn falls_back_to_macos_http_system_proxy() {
        let output = r#"<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
}"#;

        assert_eq!(system_proxy_url_from_scutil_output(output), Some("http://127.0.0.1:7890".to_string()));
    }

    #[test]
    fn ignores_disabled_or_incomplete_macos_system_proxy() {
        assert_eq!(system_proxy_url_from_scutil_output("HTTPEnable : 0\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890"), None);
        assert_eq!(system_proxy_url_from_scutil_output("HTTPEnable : 1\nHTTPProxy : 127.0.0.1"), None);
    }

    #[test]
    fn parses_windows_system_proxy() {
        let enabled = r#"
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyEnable    REG_DWORD    0x1
"#;
        let server = r#"
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891
"#;

        assert_eq!(
            system_proxy_url_from_windows_registry_output(enabled, server),
            Some("http://127.0.0.1:7891".to_string())
        );
    }

    #[test]
    fn ignores_disabled_windows_system_proxy() {
        let disabled = "ProxyEnable    REG_DWORD    0x0";
        let server = "ProxyServer    REG_SZ    127.0.0.1:7890";

        assert_eq!(system_proxy_url_from_windows_registry_output(disabled, server), None);
    }
}
