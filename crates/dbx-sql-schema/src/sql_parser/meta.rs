use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaData {
    #[serde(default)]
    pub dialect: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub charset: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
    #[serde(default)]
    pub sql_mode: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub explicit_dependencies: HashMap<String, Vec<String>>,
}

pub struct MetaReader;

impl MetaReader {
    pub fn from_file(path: &Path) -> Result<MetaData, String> {
        let content = std::fs::read_to_string(path).map_err(|e| format!("Failed to read meta file: {e}"))?;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        match ext {
            "json" => Self::from_json(&content),
            "yaml" | "yml" => Self::from_yaml(&content),
            _ => Self::from_json(&content),
        }
    }

    pub fn from_json(content: &str) -> Result<MetaData, String> {
        serde_json::from_str(content).map_err(|e| format!("Invalid meta JSON: {e}"))
    }

    pub fn from_yaml(content: &str) -> Result<MetaData, String> {
        serde_yaml::from_str(content).map_err(|e| format!("Invalid meta YAML: {e}"))
    }

    pub fn to_json(meta: &MetaData) -> Result<String, String> {
        serde_json::to_string_pretty(meta).map_err(|e| format!("Serialize meta error: {e}"))
    }

    pub fn validate_consistency(meta: &MetaData) -> Vec<String> {
        let mut warnings = Vec::new();
        if let Some(ref dialect) = meta.dialect {
            let lower = dialect.to_ascii_lowercase();
            let known = [
                "mysql",
                "postgres",
                "postgresql",
                "sqlite",
                "mssql",
                "sqlserver",
                "clickhouse",
                "duckdb",
                "oracle",
                "tidb",
                "mariadb",
            ];
            if !known.contains(&lower.as_str()) {
                warnings.push(format!("Unknown dialect '{}' in metadata", meta.dialect.as_ref().unwrap()));
            }
        }
        if let Some(ref version) = meta.version {
            let cleaned = version.trim_start_matches(|c: char| c.is_ascii_alphabetic() || c == 'v' || c == 'V');
            let is_valid = !cleaned.is_empty()
                && cleaned.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-')
                && cleaned.chars().any(|c| c.is_ascii_digit());
            if !is_valid {
                warnings.push(format!("Unusual version format '{}'", version));
            }
        }
        warnings
    }
}

pub fn validate_sql_meta_consistency(sql: &str, meta: &MetaData) -> Vec<String> {
    let mut warnings = Vec::new();
    if let Some(ref charset) = meta.charset {
        if !charset_mentions_match(sql, charset, meta.dialect.as_deref()) {
            warnings.push(format!("SQL content does not reference charset '{}' from metadata", charset));
        }
    }
    warnings
}

fn charset_mentions_match(sql: &str, charset: &str, dialect: Option<&str>) -> bool {
    let sql_upper = sql.to_ascii_uppercase();
    let charset_upper = charset.to_ascii_uppercase();
    let is_pg = dialect.is_some_and(|d| matches!(d.to_ascii_lowercase().as_str(), "postgres" | "postgresql"));
    if is_pg {
        sql_upper.contains(&format!("ENCODING '{}'", charset_upper))
            || sql_upper.contains(&format!("ENCODING '{}'", charset_upper.to_ascii_lowercase()))
    } else {
        let pattern = format!("CHARACTER SET {}", charset_upper);
        sql_upper.contains(&pattern) || sql_upper.contains(&format!("CHARSET {}", charset_upper))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_valid_json_metadata() {
        let json = r#"{
            "dialect": "mysql",
            "version": "8.0",
            "charset": "utf8mb4",
            "explicitDependencies": {
                "view_orders": ["orders", "users"]
            }
        }"#;
        let meta = MetaReader::from_json(json).unwrap();
        assert_eq!(meta.dialect.as_deref(), Some("mysql"));
        assert_eq!(meta.version.as_deref(), Some("8.0"));
        assert_eq!(
            meta.explicit_dependencies.get("view_orders").map(|v| v.as_slice()),
            Some(&["orders".to_string(), "users".to_string()][..])
        );
    }

    #[test]
    fn reads_valid_yaml_metadata() {
        let yaml = r#"
dialect: postgres
version: "15"
charset: UTF8
explicitDependencies:
  expensive_view: [table_a, table_b]
"#;
        let meta = MetaReader::from_yaml(yaml).unwrap();
        assert_eq!(meta.dialect.as_deref(), Some("postgres"));
        assert_eq!(meta.explicit_dependencies.get("expensive_view").map(|v| v.len()), Some(2));
    }

    #[test]
    fn validates_known_dialect() {
        let meta = MetaData {
            dialect: Some("mysql".into()),
            version: Some("8.0".into()),
            charset: None,
            collation: None,
            sql_mode: None,
            explicit_dependencies: HashMap::new(),
        };
        assert!(MetaReader::validate_consistency(&meta).is_empty());
    }

    #[test]
    fn warns_unknown_dialect() {
        let meta = MetaData {
            dialect: Some("fakedb".into()),
            version: None,
            charset: None,
            collation: None,
            sql_mode: None,
            explicit_dependencies: HashMap::new(),
        };
        let warnings = MetaReader::validate_consistency(&meta);
        assert!(!warnings.is_empty());
        assert!(warnings[0].contains("fakedb"));
    }

    #[test]
    fn warns_unusual_version_format() {
        let meta = MetaData {
            dialect: Some("mysql".into()),
            version: Some("latest".into()),
            charset: None,
            collation: None,
            sql_mode: None,
            explicit_dependencies: HashMap::new(),
        };
        let warnings = MetaReader::validate_consistency(&meta);
        assert!(!warnings.is_empty());
        assert!(warnings[0].contains("latest"));
    }

    #[test]
    fn charset_consistency_check() {
        let meta = MetaData {
            dialect: Some("mysql".into()),
            version: Some("8.0".into()),
            charset: Some("utf8mb4".into()),
            collation: None,
            sql_mode: None,
            explicit_dependencies: HashMap::new(),
        };
        let sql = "CREATE TABLE t (c VARCHAR(100)) CHARACTER SET utf8mb4";
        assert!(validate_sql_meta_consistency(sql, &meta).is_empty());

        let sql_no_charset = "CREATE TABLE t (c VARCHAR(100))";
        let warnings = validate_sql_meta_consistency(sql_no_charset, &meta);
        assert!(!warnings.is_empty());
        assert!(warnings[0].contains("utf8mb4"));
    }

    #[test]
    fn empty_meta_has_no_warnings() {
        let meta = MetaData {
            dialect: None,
            version: None,
            charset: None,
            collation: None,
            sql_mode: None,
            explicit_dependencies: HashMap::new(),
        };
        assert!(MetaReader::validate_consistency(&meta).is_empty());
    }

    #[test]
    fn serializes_and_deserializes_roundtrip() {
        let meta = MetaData {
            dialect: Some("postgres".into()),
            version: Some("16".into()),
            charset: Some("UTF8".into()),
            collation: Some("en_US.UTF-8".into()),
            sql_mode: None,
            explicit_dependencies: HashMap::from([("v".into(), vec!["a".into(), "b".into()])]),
        };
        let json = MetaReader::to_json(&meta).unwrap();
        let restored = MetaReader::from_json(&json).unwrap();
        assert_eq!(restored.dialect, meta.dialect);
        assert_eq!(restored.version, meta.version);
        assert_eq!(restored.explicit_dependencies.len(), 1);
    }
}
