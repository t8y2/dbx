use serde_json::Value;

use crate::models::connection::ConnectionConfig;

/// Reads the first present string value out of `ConnectionConfig::external_config`.
///
/// Drivers keep their extra settings in the free-form `external_config` JSON
/// blob, so a few of them accept more than one spelling for the same setting
/// (`apiPath` / `api_path`). This helper implements that lookup in one place.
pub fn external_string(config: &ConnectionConfig, keys: &[&str]) -> Option<String> {
    let value = config.external_config.as_ref()?;
    keys.iter()
        .find_map(|key| value.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Normalizes a user supplied base path into a prefix that can be appended to
/// a base URL.
///
/// - trims surrounding whitespace
/// - drops trailing slashes (`/influxdb/` -> `/influxdb`)
/// - adds the leading slash (`influxdb` -> `/influxdb`)
/// - maps `/` and empty input to an empty prefix, meaning "no prefix at all"
pub fn normalize_base_path(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

#[cfg(test)]
mod tests {
    use super::{external_string, normalize_base_path};
    use crate::models::connection::ConnectionConfig;
    use serde_json::json;

    #[test]
    fn normalizes_base_paths() {
        assert_eq!(normalize_base_path("influxdb"), "/influxdb");
        assert_eq!(normalize_base_path("/influxdb"), "/influxdb");
        assert_eq!(normalize_base_path("/influxdb/"), "/influxdb");
        assert_eq!(normalize_base_path("  /influxdb//  "), "/influxdb");
        assert_eq!(normalize_base_path("/select/42/prometheus/"), "/select/42/prometheus");
        assert_eq!(normalize_base_path("/"), "");
        assert_eq!(normalize_base_path(""), "");
        assert_eq!(normalize_base_path("   "), "");
    }

    #[test]
    fn reads_external_config_strings() {
        let config: ConnectionConfig = serde_json::from_value(json!({
            "id": "external-config",
            "name": "External Config",
            "db_type": "influxdb",
            "host": "127.0.0.1",
            "port": 8086,
            "username": "",
            "password": "",
            "external_config": {
                "basePath": " /influxdb ",
                "base_path": "/ignored"
            }
        }))
        .unwrap();

        assert_eq!(external_string(&config, &["basePath", "base_path"]).as_deref(), Some("/influxdb"));
        assert_eq!(external_string(&config, &["missing"]), None);
    }
}
