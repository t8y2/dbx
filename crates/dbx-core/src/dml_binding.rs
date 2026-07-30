use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::sql_dialect::descriptor::DialectKind;
use crate::sql_dialect::dialect_yaml::DialectYaml;
use crate::sql_dialect::inference::{ColumnType, DefaultTypeInferenceEngine, TypeInferenceEngine};

// ============================================================================
// DML Clean Rules — lossy type mapping → pre-transform DML template
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmlCleanRulesFile {
    pub rules: Vec<DmlCleanRule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmlCleanRule {
    pub name: String,
    pub source_type: String,
    pub target_type: String,
    pub max_fidelity: f64,
    #[serde(default)]
    pub pre_transform_sql: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

impl DmlCleanRule {
    pub fn transform_sql(&self, table: &str, column: &str) -> Option<String> {
        self.pre_transform_sql.as_ref().map(|tmpl| tmpl.replace("{table}", table).replace("{column}", column))
    }

    /// Check if this rule matches the source → target type pair.
    pub fn matches(&self, source_type: &str, target_type: &str) -> bool {
        let src_norm = normalize_type(source_type);
        let tgt_norm = normalize_type(target_type);
        let rule_src = normalize_type(&self.source_type);
        let rule_tgt = normalize_type(&self.target_type);
        src_norm == rule_src && tgt_norm == rule_tgt
    }

    fn applies(&self, source_type: &str, target_type: &str, fidelity: f64) -> bool {
        self.matches(source_type, target_type) && fidelity < self.max_fidelity
    }
}

fn normalize_type(t: &str) -> String {
    t.trim().to_ascii_uppercase().split('(').next().unwrap_or("").to_string()
}

// ============================================================================
// DmlCleanRuleRegistry — global singleton, loads from YAML
// ============================================================================

pub struct DmlCleanRuleRegistry {
    pub(crate) rules: Vec<DmlCleanRule>,
}

impl DmlCleanRuleRegistry {
    pub fn new() -> Self {
        Self { rules: Vec::new() }
    }

    pub fn global() -> &'static RwLock<Self> {
        use std::sync::OnceLock;
        static INSTANCE: OnceLock<RwLock<DmlCleanRuleRegistry>> = OnceLock::new();
        INSTANCE.get_or_init(|| RwLock::new(Self::new()))
    }

    pub fn load(path: &Path) -> Result<Vec<DmlCleanRule>, String> {
        let content = std::fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        let parsed: DmlCleanRulesFile =
            serde_yaml::from_str(&content).map_err(|e| format!("YAML parse error in {}: {e}", path.display()))?;
        Ok(parsed.rules)
    }

    pub fn load_default() -> Result<(), String> {
        let paths = [
            "plugins/mappings/rules/dml_clean_rules.yaml",
            "../plugins/mappings/rules/dml_clean_rules.yaml",
            "../../plugins/mappings/rules/dml_clean_rules.yaml",
        ];
        for path in &paths {
            let p = Path::new(path);
            if p.exists() {
                let rules = Self::load(p)?;
                if let Ok(mut registry) = Self::global().write() {
                    registry.rules = rules;
                }
                return Ok(());
            }
        }
        Ok(())
    }

    pub fn find_rule(&self, source_type: &str, target_type: &str) -> Option<&DmlCleanRule> {
        self.rules.iter().find(|r| r.matches(source_type, target_type))
    }

    pub fn all_rules(&self) -> &[DmlCleanRule] {
        &self.rules
    }
}

impl Default for DmlCleanRuleRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// BindingEngine — auto-binds DML clean SQL to lossy type mappings
// ============================================================================

pub struct BindingEngine;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingResult {
    pub source_type: String,
    pub target_type: String,
    pub fidelity: f64,
    pub pre_transform_sql: Option<String>,
    pub rule_name: Option<String>,
}

impl BindingEngine {
    /// Compute fidelity for a single type mapping and auto-bind DML if lossy.
    pub fn bind(source_type: &str, target_type: &str, table: &str, column: &str, threshold: f64) -> BindingResult {
        let engine = DefaultTypeInferenceEngine;
        let src_parsed = ColumnType::parse(source_type);
        let tgt_parsed = ColumnType::parse(target_type);
        let fidelity = engine.type_compatibility_score(&src_parsed, &tgt_parsed);

        if let Ok(registry) = DmlCleanRuleRegistry::global().read() {
            if let Some(rule) = registry.find_rule(source_type, target_type) {
                // A pair-specific rule owns its fidelity boundary; the caller
                // threshold remains the fallback for mappings without a rule.
                if rule.applies(source_type, target_type, fidelity) {
                    return BindingResult {
                        source_type: source_type.to_string(),
                        target_type: target_type.to_string(),
                        fidelity,
                        pre_transform_sql: rule.transform_sql(table, column),
                        rule_name: Some(rule.name.clone()),
                    };
                }
            }
        }

        if fidelity >= threshold {
            return BindingResult {
                source_type: source_type.to_string(),
                target_type: target_type.to_string(),
                fidelity,
                pre_transform_sql: None,
                rule_name: None,
            };
        }

        BindingResult {
            source_type: source_type.to_string(),
            target_type: target_type.to_string(),
            fidelity,
            pre_transform_sql: None,
            rule_name: None,
        }
    }

    /// Bind for a full set of column mappings.
    pub fn bind_columns(
        source_types: &[(String, String)], // (col_name, type)
        target_types: &[(String, String)],
        table: &str,
        threshold: f64,
    ) -> Vec<BindingResult> {
        let source_map: HashMap<&str, &str> = source_types.iter().map(|(n, t)| (n.as_str(), t.as_str())).collect();

        target_types
            .iter()
            .map(|(col_name, target_type)| {
                let source_type = source_map.get(col_name.as_str()).copied().unwrap_or(target_type);
                Self::bind(source_type, target_type, table, col_name, threshold)
            })
            .collect()
    }
}

// ============================================================================
// MappingCache — cache derivation results to plugins/mappings/base/
// ============================================================================

const MAPPING_BASE_DIR: &str = "plugins/mappings/base";
const MAPPING_CUSTOM_DIR: &str = "plugins/mappings/custom";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingCacheFile {
    pub status: String, // "UNVERIFIED" | "VERIFIED" | "REJECTED"
    pub generated_at: String,
    pub derived_from: MappingDerivationInfo,
    pub transformations: Vec<CachedTransformation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingDerivationInfo {
    pub source_dialect: String,
    pub target_dialect: String,
    pub source_type_count: usize,
    pub target_type_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTransformation {
    pub source_type: String,
    pub target_type: String,
    pub fidelity: f64,
    pub pre_transform_sql: Option<String>,
    pub rule_name: Option<String>,
}

impl MappingCacheFile {
    pub fn cache_path(source: DialectKind, target: DialectKind) -> PathBuf {
        let dir = Path::new(MAPPING_BASE_DIR);
        let name = format!("{}_to_{}.base.yaml", source.label(), target.label());
        dir.join(name)
    }

    pub fn custom_path(source: DialectKind, target: DialectKind, env: &str) -> PathBuf {
        let dir = Path::new(MAPPING_CUSTOM_DIR);
        let name = format!("{}_to_{}.{}.yaml", source.label(), target.label(), env);
        dir.join(name)
    }

    /// Load from cache if exists. Checks custom override first, then base cache.
    pub fn load(source: DialectKind, target: DialectKind, env: &str) -> Option<Self> {
        let custom = Self::custom_path(source, target, env);
        if custom.exists() {
            let content = std::fs::read_to_string(&custom).ok()?;
            return serde_yaml::from_str(&content).ok();
        }

        let base = Self::cache_path(source, target);
        if base.exists() {
            let content = std::fs::read_to_string(&base).ok()?;
            return serde_yaml::from_str(&content).ok();
        }

        None
    }

    /// Save derivation result to base cache (UNVERIFIED).
    pub fn save(source: DialectKind, target: DialectKind, bindings: &[BindingResult]) -> Result<(), String> {
        let dir = Path::new(MAPPING_BASE_DIR);
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create mappings dir: {e}"))?;

        let source_yaml = DialectYaml::from_descriptor(source);
        let target_yaml = DialectYaml::from_descriptor(target);

        let cache = MappingCacheFile {
            status: "UNVERIFIED".to_string(),
            generated_at: chrono::Utc::now().to_rfc3339(),
            derived_from: MappingDerivationInfo {
                source_dialect: source.label().to_string(),
                target_dialect: target.label().to_string(),
                source_type_count: source_yaml.types.len(),
                target_type_count: target_yaml.types.len(),
            },
            transformations: bindings
                .iter()
                .map(|b| CachedTransformation {
                    source_type: b.source_type.clone(),
                    target_type: b.target_type.clone(),
                    fidelity: b.fidelity,
                    pre_transform_sql: b.pre_transform_sql.clone(),
                    rule_name: b.rule_name.clone(),
                })
                .collect(),
        };

        let path = Self::cache_path(source, target);
        let yaml_str = serde_yaml::to_string(&cache).map_err(|e| format!("YAML serialize: {e}"))?;
        std::fs::write(&path, &yaml_str).map_err(|e| format!("Write cache {}: {e}", path.display()))?;
        Ok(())
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_matches_exact() {
        let rule = DmlCleanRule {
            name: "test".to_string(),
            source_type: "BIGINT".to_string(),
            target_type: "INT".to_string(),
            max_fidelity: 0.8,
            pre_transform_sql: Some("UPDATE {table} SET {column} = NULL".to_string()),
            description: None,
        };
        assert!(rule.matches("BIGINT", "INT"));
        assert!(!rule.matches("INT", "BIGINT"));
    }

    #[test]
    fn rule_matches_normalized() {
        let rule = DmlCleanRule {
            name: "test".to_string(),
            source_type: "BIGINT".to_string(),
            target_type: "INT".to_string(),
            max_fidelity: 0.8,
            pre_transform_sql: None,
            description: None,
        };
        assert!(rule.matches("BIGINT(20)", "INT"));
        assert!(rule.matches("bigint", "int"));
    }

    #[test]
    fn rule_transform_sql() {
        let rule = DmlCleanRule {
            name: "test".to_string(),
            source_type: "BIGINT".to_string(),
            target_type: "INT".to_string(),
            max_fidelity: 0.8,
            pre_transform_sql: Some("UPDATE {table} SET {column} = NULL WHERE {column} > 2147483647".to_string()),
            description: None,
        };
        let sql = rule.transform_sql("users", "age").unwrap();
        assert_eq!(sql, "UPDATE users SET age = NULL WHERE age > 2147483647");
    }

    #[test]
    fn binding_engine_high_fidelity_no_dml() {
        let result = BindingEngine::bind("INT", "INTEGER", "t", "c", 0.7);
        assert!(result.pre_transform_sql.is_none());
        assert!((result.fidelity - 0.9).abs() < 0.01);
    }

    #[test]
    fn binding_engine_low_fidelity_with_dml() {
        let _registry = DmlCleanRuleRegistry::new();
        if let Ok(mut reg) = DmlCleanRuleRegistry::global().write() {
            reg.rules = vec![DmlCleanRule {
                name: "bigint_to_int".to_string(),
                source_type: "BIGINT".to_string(),
                target_type: "INT".to_string(),
                max_fidelity: 0.9,
                pre_transform_sql: Some("UPDATE {table} SET {column} = NULL WHERE {column} > 2147483647".to_string()),
                description: None,
            }];
        }

        let result = BindingEngine::bind("BIGINT", "INT", "users", "id", 0.4);
        assert!(result.pre_transform_sql.is_some());
        assert!(result.pre_transform_sql.unwrap().contains("2147483647"));
    }

    #[test]
    fn rule_max_fidelity_boundary_is_exclusive() {
        let rule = DmlCleanRule {
            name: "boundary".to_string(),
            source_type: "BIGINT".to_string(),
            target_type: "INT".to_string(),
            max_fidelity: 0.5,
            pre_transform_sql: Some("SELECT 1".to_string()),
            description: None,
        };

        assert!(rule.applies("BIGINT", "INT", 0.49));
        assert!(!rule.applies("BIGINT", "INT", 0.5));
    }

    #[test]
    fn default_rules_honor_configured_max_fidelity() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/mappings/rules/dml_clean_rules.yaml");
        let rules = DmlCleanRuleRegistry::load(&path).unwrap();
        let rule = rules.iter().find(|rule| rule.matches("BIGINT", "INT")).unwrap();

        assert!(rule.applies("BIGINT", "INT", rule.max_fidelity - f64::EPSILON));
        assert!(!rule.applies("BIGINT", "INT", rule.max_fidelity));
    }

    #[test]
    fn binding_engine_no_rule_found() {
        let result = BindingEngine::bind("GEOGRAPHY", "INT", "t", "c", 0.5);
        assert!(result.pre_transform_sql.is_none());
        assert!((result.fidelity - 0.3).abs() < 0.01);
    }

    #[test]
    fn mapping_cache_path() {
        let path = MappingCacheFile::cache_path(DialectKind::Mysql, DialectKind::Postgres);
        assert!(path.to_string_lossy().contains("mysql_to_postgres"));
        let custom = MappingCacheFile::custom_path(DialectKind::Mysql, DialectKind::Postgres, "prod");
        assert!(custom.to_string_lossy().contains("prod"));
    }
}
