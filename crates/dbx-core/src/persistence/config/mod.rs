pub mod expression;
// governance disabled — storage methods not available at HEAD after main merge
// pub mod governance;
pub mod layer;
pub mod tag;
pub mod trace;

pub use expression::{parse_expression, resolve_all_expressions_in_value, resolve_expression, Expression};
// pub use governance::{ ... };
pub use layer::{ConfigLayer, ConfigTree, LayerConfig, MergedConfig};
pub use tag::{
    BlockStats, BusinessTag, TagGuard, TagInheritanceWhitelist, TagPolicy, TagValidationResult, TagValidator,
};
pub use trace::{TraceEntry, TraceRingBuffer, TraceStats};

#[cfg(test)]
mod integration_tests {
    use crate::config::*;
    use crate::models::connection::DatabaseType;
    use crate::schema_diff::SchemaDiffPreparationOptions;
    use std::collections::HashMap;

    #[test]
    fn test_config_tree_with_schema_diff_options() {
        let mut tree = ConfigTree::new();

        let mut global_vals = HashMap::new();
        global_vals.insert("target_schema".to_string(), serde_json::Value::String("public".to_string()));
        global_vals.insert("ignore_comments".to_string(), serde_json::Value::Bool(true));
        global_vals.insert("db_type".to_string(), serde_json::Value::String("postgres".to_string()));

        tree.add_layer(LayerConfig {
            layer: ConfigLayer::Global,
            name: "defaults".to_string(),
            values: global_vals,
            tags: HashMap::from([("env".to_string(), "prod".to_string())]),
            enabled: true,
            ..Default::default()
        });

        tree.add_layer(LayerConfig {
            layer: ConfigLayer::Task,
            name: "task-override".to_string(),
            values: HashMap::from([
                ("cascade_delete".to_string(), serde_json::Value::Bool(true)),
                ("compare_column_order".to_string(), serde_json::Value::String("${eval:true}".to_string())),
            ]),
            tags: HashMap::new(),
            enabled: true,
            ..Default::default()
        });

        let mut merged = tree.merge().unwrap();
        let merged_snapshot = merged.clone();

        let resolved: HashMap<_, _> = merged
            .values
            .iter()
            .map(|(k, v)| {
                let resolved = resolve_all_expressions_in_value(v, &merged.values)
                    .unwrap_or_else(|e| panic!("Failed to resolve expression for key '{k}': {e}"));
                (k.clone(), resolved)
            })
            .collect();
        merged.values.extend(resolved);

        let db_val = merged.values.get("db_type").and_then(|v| v.as_str()).unwrap_or("mysql");
        let database_type: DatabaseType = serde_json::from_str(&format!("\"{db_val}\"")).unwrap_or(DatabaseType::Mysql);

        let opts = SchemaDiffPreparationOptions {
            source_tables: vec![],
            target_tables: vec![],
            source_details: vec![],
            target_details: vec![],
            source_functions: vec![],
            target_functions: vec![],
            source_sequences: vec![],
            target_sequences: vec![],
            source_rules: vec![],
            target_rules: vec![],
            source_owners: vec![],
            target_owners: vec![],
            database_type,
            target_schema: merged.values.get("target_schema").and_then(|v| v.as_str()).map(String::from),
            ignore_comments: merged.values.get("ignore_comments").and_then(|v| v.as_bool()).unwrap_or(false),
            cascade_delete: merged.values.get("cascade_delete").and_then(|v| v.as_bool()).unwrap_or(false),
            compare_column_order: merged.values.get("compare_column_order").and_then(|v| v.as_bool()).unwrap_or(false),
            ..Default::default()
        };

        assert_eq!(opts.database_type, DatabaseType::Postgres);
        assert_eq!(opts.target_schema.as_deref(), Some("public"));
        assert!(opts.ignore_comments);
        assert!(opts.cascade_delete);
        assert!(opts.compare_column_order);

        let whitelist = TagInheritanceWhitelist::new(vec!["env".to_string()], TagPolicy::Strict);
        let validator = TagValidator::new(whitelist, true);
        let tags: Vec<BusinessTag> = merged_snapshot
            .tags
            .iter()
            .map(|(k, v)| BusinessTag {
                key: k.clone(),
                value: v.clone(),
                description: String::new(),
                immutable: false,
            })
            .collect();
        let result = validator.validate_tags(&tags, &HashMap::new());
        assert_eq!(result.allowed.len(), 1);
        assert_eq!(result.blocked.len(), 0);

        let mut trace = TraceRingBuffer::new(100);
        trace.record(ConfigLayer::Global, "target_schema", "read", "used for SchemaDiffPreparationOptions");
        trace.record(ConfigLayer::Global, "db_type", "read", "used for DatabaseType");
        trace.record(ConfigLayer::Task, "cascade_delete", "read", "overridden from task layer");
        assert_eq!(trace.len(), 3);
    }

    #[test]
    fn test_config_expression_with_value_injection() {
        let mut tree = ConfigTree::new();

        let mut global = HashMap::new();
        global.insert("base_host".to_string(), serde_json::Value::String("db.example.com".to_string()));
        global.insert("base_port".to_string(), serde_json::Value::Number(serde_json::Number::from(5432)));

        tree.add_layer(LayerConfig {
            layer: ConfigLayer::Global,
            name: "global".to_string(),
            values: global,
            ..Default::default()
        });

        tree.add_layer(LayerConfig {
            layer: ConfigLayer::Project,
            name: "project".to_string(),
            values: HashMap::from([
                ("jdbc_url".to_string(), serde_json::Value::String("${eval:\"jdbc:postgresql://\"}".to_string())),
                ("host".to_string(), serde_json::Value::String("${ref:base_host}".to_string())),
            ]),
            ..Default::default()
        });

        let merged = tree.merge().unwrap();
        let scope = merged.values.clone();

        let url_resolved = resolve_all_expressions_in_value(
            &serde_json::Value::String("${eval:\"jdbc:postgresql://\"}".to_string()),
            &scope,
        )
        .unwrap();
        assert_eq!(url_resolved, serde_json::Value::String("jdbc:postgresql://".to_string()));

        let host_resolved =
            resolve_all_expressions_in_value(&serde_json::Value::String("${ref:base_host}".to_string()), &scope)
                .unwrap();
        assert_eq!(host_resolved, serde_json::Value::String("db.example.com".to_string()));
    }
}
