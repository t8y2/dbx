use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Controls how `TagInheritanceWhitelist` handles unlisted tags.
///
/// - `Allow` — all tags pass through by default; the whitelist is purely informational.
/// - `Block` — only tags whose keys appear in `allowed_keys` pass through; unlisted tags
///   are collected in `TagValidationResult::blocked` and count as blocking violations.
/// - `Strict` — same key filtering as `Block`, but additionally checks that tag *values*
///   match the base-layer values. Any value mismatch (or blocked key) is reported as a
///   violation, and **all** violations (including value mismatches) count as blocking.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TagPolicy {
    #[default]
    Allow,
    Block,
    Strict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusinessTag {
    pub key: String,
    pub value: String,

    #[serde(default)]
    pub description: String,

    #[serde(default)]
    pub immutable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagInheritanceWhitelist {
    #[serde(default)]
    pub allowed_keys: HashSet<String>,

    #[serde(default = "default_policy")]
    pub default_policy: TagPolicy,
}

fn default_policy() -> TagPolicy {
    TagPolicy::Block
}

impl Default for TagInheritanceWhitelist {
    fn default() -> Self {
        Self { allowed_keys: HashSet::new(), default_policy: TagPolicy::Block }
    }
}

impl TagInheritanceWhitelist {
    pub fn new(allowed: Vec<String>, policy: TagPolicy) -> Self {
        Self { allowed_keys: allowed.into_iter().collect(), default_policy: policy }
    }

    pub fn is_allowed(&self, key: &str) -> bool {
        match self.default_policy {
            TagPolicy::Allow => true,
            TagPolicy::Block => self.allowed_keys.contains(key),
            TagPolicy::Strict => self.allowed_keys.contains(key),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagValidationResult {
    pub allowed: Vec<BusinessTag>,
    pub blocked: Vec<BusinessTag>,
    pub violations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TagValidator {
    pub whitelist: TagInheritanceWhitelist,
    #[serde(default)]
    pub strict_mode: bool,
}

impl TagValidator {
    pub fn new(whitelist: TagInheritanceWhitelist, strict_mode: bool) -> Self {
        Self { whitelist, strict_mode }
    }

    pub fn validate_tags(&self, tags: &[BusinessTag], base_tags: &HashMap<String, String>) -> TagValidationResult {
        let mut allowed = Vec::new();
        let mut blocked = Vec::new();
        let mut violations = Vec::new();

        for tag in tags {
            if !self.whitelist.is_allowed(&tag.key) {
                blocked.push(tag.clone());
                let msg = if self.strict_mode {
                    format!("BLOCKED: Tag '{}'='{}' is not in whitelist (strict mode)", tag.key, tag.value)
                } else {
                    format!("BLOCKED: Tag '{}'='{}' is not in whitelist", tag.key, tag.value)
                };
                violations.push(msg);
                continue;
            }

            if let Some(base_val) = base_tags.get(&tag.key) {
                if tag.value != *base_val && self.strict_mode {
                    violations.push(format!(
                        "STRICT VIOLATION: Tag '{}'='{}' differs from base value '{}'",
                        tag.key, tag.value, base_val
                    ));
                }
            }

            allowed.push(tag.clone());
        }

        TagValidationResult { allowed, blocked, violations }
    }

    pub fn has_blocking_violations(&self, result: &TagValidationResult) -> bool {
        if self.strict_mode {
            !result.violations.is_empty()
        } else {
            !result.blocked.is_empty()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockStats {
    pub total_tags: usize,
    pub blocked_count: usize,
    pub violation_count: usize,
    pub by_key: HashMap<String, usize>,
    pub strict_mode: bool,
}

impl BlockStats {
    pub fn from_validation(result: &TagValidationResult, strict_mode: bool) -> Self {
        let mut by_key = HashMap::new();
        for tag in &result.blocked {
            *by_key.entry(tag.key.clone()).or_insert(0) += 1;
        }
        Self {
            total_tags: result.allowed.len() + result.blocked.len(),
            blocked_count: result.blocked.len(),
            violation_count: result.violations.len(),
            by_key,
            strict_mode,
        }
    }
}

pub struct TagGuard {
    pub validator: TagValidator,
    pub stats: std::sync::Mutex<Vec<BlockStats>>,
}

impl TagGuard {
    pub fn new(validator: TagValidator) -> Self {
        Self { validator, stats: std::sync::Mutex::new(Vec::new()) }
    }

    pub fn validate_and_collect(
        &self,
        tags: &[BusinessTag],
        base_tags: &HashMap<String, String>,
    ) -> TagValidationResult {
        let result = self.validator.validate_tags(tags, base_tags);
        let stats = BlockStats::from_validation(&result, self.validator.strict_mode);
        if let Ok(mut guard) = self.stats.lock() {
            guard.push(stats);
        }
        result
    }

    pub fn accumulated_stats(&self) -> Vec<BlockStats> {
        self.stats.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn blocking_summary(&self) -> (usize, usize, usize) {
        let stats = self.accumulated_stats();
        let total_blocked = stats.iter().map(|s| s.blocked_count).sum();
        let total_violations = stats.iter().map(|s| s.violation_count).sum();
        let total_tags = stats.iter().map(|s| s.total_tags).sum();
        (total_blocked, total_violations, total_tags)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allow_policy_allows_all() {
        let whitelist = TagInheritanceWhitelist::new(vec![], TagPolicy::Allow);
        assert!(whitelist.is_allowed("anything"));
    }

    #[test]
    fn test_block_policy_blocks_unlisted() {
        let whitelist = TagInheritanceWhitelist::new(vec!["allowed_key".to_string()], TagPolicy::Block);
        assert!(whitelist.is_allowed("allowed_key"));
        assert!(!whitelist.is_allowed("blocked_key"));
    }

    #[test]
    fn test_strict_policy_blocks_unlisted() {
        let whitelist = TagInheritanceWhitelist::new(vec!["safe".to_string()], TagPolicy::Strict);
        assert!(whitelist.is_allowed("safe"));
        assert!(!whitelist.is_allowed("unsafe"));
    }

    #[test]
    fn test_validator_allows_all_with_allow_policy() {
        let whitelist = TagInheritanceWhitelist::new(vec![], TagPolicy::Allow);
        let validator = TagValidator::new(whitelist, false);

        let tags = vec![BusinessTag {
            key: "env".to_string(),
            value: "prod".to_string(),
            description: String::new(),
            immutable: false,
        }];
        let base = HashMap::new();
        let result = validator.validate_tags(&tags, &base);
        assert_eq!(result.allowed.len(), 1);
        assert_eq!(result.blocked.len(), 0);
    }

    #[test]
    fn test_validator_blocks_unlisted_in_block_mode() {
        let whitelist = TagInheritanceWhitelist::new(vec!["allowed".to_string()], TagPolicy::Block);
        let validator = TagValidator::new(whitelist, false);

        let tags = vec![
            BusinessTag {
                key: "allowed".to_string(),
                value: "yes".to_string(),
                description: String::new(),
                immutable: false,
            },
            BusinessTag {
                key: "blocked".to_string(),
                value: "no".to_string(),
                description: String::new(),
                immutable: false,
            },
        ];
        let base = HashMap::new();
        let result = validator.validate_tags(&tags, &base);
        assert_eq!(result.allowed.len(), 1);
        assert_eq!(result.blocked.len(), 1);
        assert_eq!(result.blocked[0].key, "blocked");
    }

    #[test]
    fn test_strict_mode_reports_value_mismatch() {
        let whitelist = TagInheritanceWhitelist::new(vec!["env".to_string()], TagPolicy::Strict);
        let validator = TagValidator::new(whitelist, true);

        let tags = vec![BusinessTag {
            key: "env".to_string(),
            value: "staging".to_string(),
            description: String::new(),
            immutable: false,
        }];
        let mut base = HashMap::new();
        base.insert("env".to_string(), "prod".to_string());
        let result = validator.validate_tags(&tags, &base);
        assert_eq!(result.violations.len(), 1);
        assert!(result.violations[0].contains("STRICT VIOLATION"));
    }

    #[test]
    fn test_has_blocking_violations_standard_mode() {
        let whitelist = TagInheritanceWhitelist::new(vec![], TagPolicy::Block);
        let validator = TagValidator::new(whitelist, false);

        let result = TagValidationResult {
            allowed: vec![],
            blocked: vec![BusinessTag {
                key: "x".to_string(),
                value: "y".to_string(),
                description: String::new(),
                immutable: false,
            }],
            violations: vec![],
        };
        assert!(validator.has_blocking_violations(&result));
    }

    #[test]
    fn test_has_blocking_violations_strict_mode() {
        let whitelist = TagInheritanceWhitelist::new(vec![], TagPolicy::Strict);
        let validator = TagValidator::new(whitelist, true);

        let result =
            TagValidationResult { allowed: vec![], blocked: vec![], violations: vec!["STRICT VIOLATION".to_string()] };
        assert!(validator.has_blocking_violations(&result));
    }

    #[test]
    fn test_has_blocking_violations_no_violations() {
        let whitelist = TagInheritanceWhitelist::new(vec![], TagPolicy::Allow);
        let validator = TagValidator::new(whitelist, false);

        let result = TagValidationResult { allowed: vec![], blocked: vec![], violations: vec![] };
        assert!(!validator.has_blocking_violations(&result));
    }

    #[test]
    fn test_immutable_tag_field() {
        let tag = BusinessTag {
            key: "env".to_string(),
            value: "prod".to_string(),
            description: "Environment".to_string(),
            immutable: true,
        };
        assert!(tag.immutable);
    }

    #[test]
    fn block_stats_from_validation() {
        let whitelist = TagInheritanceWhitelist::new(vec!["allowed".to_string()], TagPolicy::Block);
        let validator = TagValidator::new(whitelist, false);

        let tags = vec![
            BusinessTag {
                key: "allowed".to_string(),
                value: "yes".to_string(),
                description: String::new(),
                immutable: false,
            },
            BusinessTag {
                key: "blocked1".to_string(),
                value: "no".to_string(),
                description: String::new(),
                immutable: false,
            },
            BusinessTag {
                key: "blocked2".to_string(),
                value: "no".to_string(),
                description: String::new(),
                immutable: false,
            },
        ];
        let base = HashMap::new();
        let result = validator.validate_tags(&tags, &base);
        let stats = BlockStats::from_validation(&result, false);
        assert_eq!(stats.total_tags, 3);
        assert_eq!(stats.blocked_count, 2);
        assert_eq!(stats.violation_count, 2);
        assert_eq!(stats.by_key.get("blocked1"), Some(&1usize));
        assert_eq!(stats.by_key.get("blocked2"), Some(&1usize));
        assert!(!stats.strict_mode);
    }

    #[test]
    fn block_stats_with_strict_mode_violations() {
        let whitelist = TagInheritanceWhitelist::new(vec!["env".to_string()], TagPolicy::Strict);
        let validator = TagValidator::new(whitelist, true);

        let tags = vec![BusinessTag {
            key: "env".to_string(),
            value: "dev".to_string(),
            description: String::new(),
            immutable: false,
        }];
        let mut base = HashMap::new();
        base.insert("env".to_string(), "prod".to_string());
        let result = validator.validate_tags(&tags, &base);
        let stats = BlockStats::from_validation(&result, true);
        assert_eq!(stats.blocked_count, 0);
        assert_eq!(stats.violation_count, 1);
        assert!(stats.strict_mode);
    }

    #[test]
    fn tag_guard_collects_multiple_validations() {
        let whitelist = TagInheritanceWhitelist::new(vec!["env".to_string()], TagPolicy::Strict);
        let validator = TagValidator::new(whitelist, true);
        let guard = TagGuard::new(validator);

        let tags1 = vec![BusinessTag {
            key: "env".to_string(),
            value: "staging".to_string(),
            description: String::new(),
            immutable: false,
        }];
        let mut base1 = HashMap::new();
        base1.insert("env".to_string(), "prod".to_string());

        let tags2 = vec![BusinessTag {
            key: "blocked".to_string(),
            value: "x".to_string(),
            description: String::new(),
            immutable: false,
        }];

        guard.validate_and_collect(&tags1, &base1);
        guard.validate_and_collect(&tags2, &HashMap::new());

        let stats = guard.accumulated_stats();
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].violation_count, 1);
        assert_eq!(stats[1].blocked_count, 1);

        let (blocked, violations, total) = guard.blocking_summary();
        assert_eq!(blocked, 1);
        assert_eq!(violations, 2);
        assert_eq!(total, 2);
    }

    #[test]
    fn tag_guard_empty_stats() {
        let whitelist = TagInheritanceWhitelist::new(vec![], TagPolicy::Allow);
        let validator = TagValidator::new(whitelist, false);
        let guard = TagGuard::new(validator);

        assert!(guard.accumulated_stats().is_empty());
        let (blocked, violations, total) = guard.blocking_summary();
        assert_eq!(blocked, 0);
        assert_eq!(violations, 0);
        assert_eq!(total, 0);
    }

    #[test]
    fn tag_guard_blocking_with_strict_mode() {
        let whitelist = TagInheritanceWhitelist::new(vec![], TagPolicy::Strict);
        let validator = TagValidator::new(whitelist, true);
        let guard = TagGuard::new(validator);

        let tags = vec![BusinessTag {
            key: "env".to_string(),
            value: "dev".to_string(),
            description: String::new(),
            immutable: false,
        }];
        let result = guard.validate_and_collect(&tags, &HashMap::new());
        assert_eq!(result.blocked.len(), 1);
        assert!(guard.validator.has_blocking_violations(&result));
    }
}
