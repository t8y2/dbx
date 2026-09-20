use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ConfigLayer {
    Global = 0,
    Team = 1,
    Project = 2,
    Env = 3,
    Task = 4,
}

impl ConfigLayer {
    pub fn priority(&self) -> u8 {
        *self as u8
    }

    pub fn label(&self) -> &'static str {
        match self {
            ConfigLayer::Global => "global",
            ConfigLayer::Team => "team",
            ConfigLayer::Project => "project",
            ConfigLayer::Env => "env",
            ConfigLayer::Task => "task",
        }
    }

    pub fn all() -> &'static [ConfigLayer] {
        &[ConfigLayer::Global, ConfigLayer::Team, ConfigLayer::Project, ConfigLayer::Env, ConfigLayer::Task]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerConfig {
    pub layer: ConfigLayer,
    pub name: String,

    #[serde(default)]
    pub description: String,

    #[serde(default)]
    pub values: HashMap<String, serde_json::Value>,

    #[serde(default)]
    pub tags: HashMap<String, String>,

    #[serde(default)]
    pub enabled: bool,

    #[serde(default = "default_priority")]
    pub priority_override: Option<u8>,

    #[serde(default)]
    pub metadata: HashMap<String, String>,
}

impl Default for LayerConfig {
    fn default() -> Self {
        Self {
            layer: ConfigLayer::Global,
            name: String::new(),
            description: String::new(),
            values: HashMap::new(),
            tags: HashMap::new(),
            enabled: true,
            priority_override: None,
            metadata: HashMap::new(),
        }
    }
}

fn default_priority() -> Option<u8> {
    None
}

impl LayerConfig {
    pub fn effective_priority(&self) -> u8 {
        self.priority_override.unwrap_or_else(|| self.layer.priority())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergedConfig {
    pub values: HashMap<String, serde_json::Value>,
    pub tags: HashMap<String, String>,
    pub provenance: HashMap<String, ConfigLayer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigTree {
    pub layers: Vec<LayerConfig>,
}

impl Default for ConfigTree {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigTree {
    pub fn new() -> Self {
        Self { layers: Vec::new() }
    }

    pub fn add_layer(&mut self, config: LayerConfig) {
        self.layers.push(config);
    }

    pub fn merge(&self) -> Result<MergedConfig, String> {
        let mut sorted: Vec<&LayerConfig> = self.layers.iter().filter(|l| l.enabled).collect();
        sorted.sort_by_key(|l| l.effective_priority());

        let mut values: HashMap<String, serde_json::Value> = HashMap::new();
        let mut tags: HashMap<String, String> = HashMap::new();
        let mut provenance: HashMap<String, ConfigLayer> = HashMap::new();

        for layer_config in &sorted {
            for (k, v) in &layer_config.values {
                values.insert(k.clone(), v.clone());
                provenance.insert(k.clone(), layer_config.layer);
            }
            for (k, v) in &layer_config.tags {
                tags.insert(k.clone(), v.clone());
            }
        }

        Ok(MergedConfig { values, tags, provenance })
    }

    pub fn merge_with_guard(&self, tag_guard: &crate::config::tag::TagGuard) -> Result<MergedConfig, String> {
        let merged = self.merge()?;
        let tags: Vec<crate::config::tag::BusinessTag> = merged
            .tags
            .iter()
            .map(|(k, v)| crate::config::tag::BusinessTag {
                key: k.clone(),
                value: v.clone(),
                description: String::new(),
                immutable: false,
            })
            .collect();
        let base_tags: HashMap<String, String> = HashMap::new();
        let result = tag_guard.validate_and_collect(&tags, &base_tags);
        if tag_guard.validator.has_blocking_violations(&result) {
            let (blocked, violations, _total) = tag_guard.blocking_summary();
            return Err(format!("Tag guard blocked config merge: {blocked} tags blocked, {violations} violations"));
        }
        Ok(merged)
    }

    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        let mut seen_keys: HashMap<&str, usize> = HashMap::new();

        for (i, layer) in self.layers.iter().enumerate() {
            if layer.name.is_empty() {
                errors.push(format!("Layer at index {i} has empty name"));
            }
            if layer.values.is_empty() && layer.tags.is_empty() {
                errors.push(format!("Layer '{}' ({}) has no values or tags", layer.name, layer.layer.label()));
            }
            for key in layer.values.keys() {
                if let Some(prev) = seen_keys.get(key.as_str()) {
                    errors.push(format!("Key '{}' defined in multiple layers (index {prev} and {i})", key));
                }
                seen_keys.entry(key.as_str()).or_insert(i);
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_layer(layer: ConfigLayer, name: &str, key: &str, value: &str) -> LayerConfig {
        let mut values = HashMap::new();
        values.insert(key.to_string(), serde_json::Value::String(value.to_string()));
        LayerConfig { layer, name: name.to_string(), values, enabled: true, ..Default::default() }
    }

    #[test]
    fn test_layer_priority_order() {
        assert!(ConfigLayer::Global.priority() < ConfigLayer::Team.priority());
        assert!(ConfigLayer::Team.priority() < ConfigLayer::Project.priority());
        assert!(ConfigLayer::Project.priority() < ConfigLayer::Env.priority());
        assert!(ConfigLayer::Env.priority() < ConfigLayer::Task.priority());
    }

    #[test]
    fn test_layer_label() {
        assert_eq!(ConfigLayer::Global.label(), "global");
        assert_eq!(ConfigLayer::Task.label(), "task");
    }

    #[test]
    fn test_config_tree_merge_basic() {
        let mut tree = ConfigTree::new();
        tree.add_layer(make_layer(ConfigLayer::Global, "global-cfg", "host", "db-global"));
        tree.add_layer(make_layer(ConfigLayer::Project, "proj-cfg", "host", "db-proj"));

        let merged = tree.merge().unwrap();
        assert_eq!(merged.values.get("host").unwrap(), &serde_json::Value::String("db-proj".to_string()));
        assert_eq!(*merged.provenance.get("host").unwrap(), ConfigLayer::Project);
    }

    #[test]
    fn test_config_tree_merge_lower_priority_does_not_override() {
        let mut tree = ConfigTree::new();
        tree.add_layer(make_layer(ConfigLayer::Project, "proj-cfg", "port", "5432"));
        tree.add_layer(make_layer(ConfigLayer::Global, "global-cfg", "port", "3306"));

        let merged = tree.merge().unwrap();
        assert_eq!(merged.values.get("port").unwrap(), &serde_json::Value::String("5432".to_string()));
        assert_eq!(*merged.provenance.get("port").unwrap(), ConfigLayer::Project);
    }

    #[test]
    fn test_config_tree_merge_disabled_layer_ignored() {
        let mut tree = ConfigTree::new();
        let mut global = make_layer(ConfigLayer::Global, "global-cfg", "host", "db-global");
        global.enabled = false;
        tree.add_layer(global);
        tree.add_layer(make_layer(ConfigLayer::Task, "task-cfg", "host", "db-task"));

        let merged = tree.merge().unwrap();
        assert_eq!(merged.values.get("host").unwrap(), &serde_json::Value::String("db-task".to_string()));
    }

    #[test]
    fn test_config_tree_merge_distinct_keys() {
        let mut tree = ConfigTree::new();
        tree.add_layer(make_layer(ConfigLayer::Global, "g", "host", "g-host"));
        tree.add_layer(make_layer(ConfigLayer::Team, "t", "port", "t-port"));

        let merged = tree.merge().unwrap();
        assert_eq!(merged.values.len(), 2);
        assert!(merged.values.contains_key("host"));
        assert!(merged.values.contains_key("port"));
    }

    #[test]
    fn test_priority_override() {
        let mut tree = ConfigTree::new();
        let mut global = make_layer(ConfigLayer::Global, "override-cfg", "key", "val");
        global.priority_override = Some(255);
        tree.add_layer(global);
        tree.add_layer(make_layer(ConfigLayer::Task, "task-cfg", "key", "task-val"));

        let merged = tree.merge().unwrap();
        assert_eq!(merged.values.get("key").unwrap(), &serde_json::Value::String("val".to_string()));
    }

    #[test]
    fn test_validate_empty_name() {
        let tree = ConfigTree {
            layers: vec![LayerConfig {
                layer: ConfigLayer::Global,
                name: String::new(),
                values: HashMap::from([("k".to_string(), serde_json::Value::String("v".to_string()))]),
                ..Default::default()
            }],
        };
        assert!(tree.validate().is_err());
    }

    #[test]
    fn test_validate_empty_values_and_tags() {
        let layer = LayerConfig {
            layer: ConfigLayer::Global,
            name: "empty".to_string(),
            values: HashMap::new(),
            tags: HashMap::new(),
            ..Default::default()
        };
        let tree = ConfigTree { layers: vec![layer] };
        let errs = tree.validate().unwrap_err();
        assert!(errs.iter().any(|e| e.contains("empty")));
    }

    #[test]
    fn test_effective_priority_default() {
        let l = make_layer(ConfigLayer::Env, "env", "k", "v");
        assert_eq!(l.effective_priority(), ConfigLayer::Env.priority());
    }

    #[test]
    fn test_effective_priority_override() {
        let mut l = make_layer(ConfigLayer::Global, "g", "k", "v");
        l.priority_override = Some(100);
        assert_eq!(l.effective_priority(), 100);
    }

    #[test]
    fn test_all_layers() {
        let all = ConfigLayer::all();
        assert_eq!(all.len(), 5);
        assert_eq!(all[0], ConfigLayer::Global);
        assert_eq!(all[4], ConfigLayer::Task);
    }
}
