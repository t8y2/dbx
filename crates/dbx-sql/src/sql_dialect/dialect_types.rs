use crate::sql_dialect::descriptor::DialectKind;
use crate::sql_dialect::dialect_loader::DialectRegistry;

pub fn list_dialect_type_names(dialect_name: &str) -> Vec<String> {
    super::lazy_init();
    list_dialect_type_names_in(dialect_name, DialectRegistry::global())
}

fn list_dialect_type_names_in(dialect_name: &str, registry: &DialectRegistry) -> Vec<String> {
    if let Some(loaded) = registry.get(dialect_name) {
        return loaded.yaml.types.iter().map(|t| t.name.clone()).collect();
    }

    // Public callers may use stable dialect labels such as `postgres`,
    // while the embedded catalog keeps the product name `PostgreSQL`.
    if let Some(kind) = DialectKind::from_label(dialect_name) {
        if let Some(loaded) = registry.get(core_catalog_name(kind)) {
            return loaded.yaml.types.iter().map(|t| t.name.clone()).collect();
        }
        // Last-resort fallback: any dialect in the same family
        if let Some(loaded) = registry.get_by_kind(kind) {
            return loaded.yaml.types.iter().map(|t| t.name.clone()).collect();
        }
    }

    Vec::new()
}

fn core_catalog_name(kind: DialectKind) -> &'static str {
    match kind {
        DialectKind::Mysql => "MySQL",
        DialectKind::Postgres => "PostgreSQL",
        DialectKind::Sqlite => "SQLite",
        DialectKind::DuckDb => "DuckDB",
        DialectKind::SqlServer => "SQL Server",
        DialectKind::Oracle => "Oracle",
        DialectKind::H2 => "H2",
        DialectKind::ClickHouse => "ClickHouse",
        DialectKind::ManticoreSearch => "ManticoreSearch",
        DialectKind::Informix => "Informix",
        DialectKind::Questdb => "QuestDB",
        DialectKind::Unsupported => "Unsupported",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_dialect::descriptor::DialectCapabilityDescriptor;
    use crate::sql_dialect::dialect_yaml::{DialectMeta, DialectType, DialectVersion, DialectYaml, IdentifierRules};

    fn make_registry_with_types(dialect_name: &str, type_names: &[&str]) -> DialectRegistry {
        let registry = DialectRegistry::new();
        let types: Vec<DialectType> = type_names
            .iter()
            .map(|&name| DialectType {
                name: name.to_string(),
                category: "STRING".to_string(),
                max_precision: None,
                precision_range: None,
                has_length: false,
                has_precision: false,
                aliases: vec![],
                semantic_fidelity_base: 1.0,
            })
            .collect();

        let yaml = DialectYaml {
            dialect: DialectMeta {
                name: dialect_name.to_string(),
                display_name: Some(dialect_name.to_string()),
                versions: vec![DialectVersion { version: "1.0".to_string(), status: "COMPATIBLE".to_string() }],
            },
            types,
            identifier_rules: IdentifierRules { quote_char: "\"".to_string(), case_sensitive: false, max_length: 64 },
            ..Default::default()
        };

        let kind = yaml.dialect_kind().unwrap();
        let descriptor = DialectCapabilityDescriptor::for_dialect(kind);
        registry.register_descriptor(dialect_name, descriptor, yaml);
        registry
    }

    #[test]
    fn list_mysql_types() {
        let registry = make_registry_with_types("MySQL", &["VARCHAR", "INT", "BIGINT"]);
        let types = list_dialect_type_names_in("MySQL", &registry);
        assert_eq!(types, vec!["VARCHAR", "INT", "BIGINT"]);
        assert!(types.contains(&"VARCHAR".to_string()));
    }

    #[test]
    fn list_dameng_types() {
        let registry = make_registry_with_types(
            "Dameng",
            &[
                "VARCHAR",
                "VARCHAR2",
                "INT",
                "INTEGER",
                "BIGINT",
                "FLOAT",
                "DOUBLE",
                "DATE",
                "TIMESTAMP",
                "CLOB",
                "BLOB",
                "TEXT",
            ],
        );
        let types = list_dialect_type_names_in("Dameng", &registry);
        assert!(!types.is_empty(), "Dameng should have types");
        assert!(types.contains(&"VARCHAR2".to_string()));
        assert_eq!(types.len(), 12);
    }

    #[test]
    fn list_unknown_dialect_returns_empty() {
        let registry = DialectRegistry::new();
        let types = list_dialect_type_names_in("nonexistent_db", &registry);
        assert!(types.is_empty());
    }

    #[test]
    fn lists_embedded_postgres_types_by_name_and_label() {
        let by_name = list_dialect_type_names("PostgreSQL");
        let by_label = list_dialect_type_names("postgres");

        assert!(!by_name.is_empty());
        assert_eq!(by_label, by_name);
        assert!(by_name.contains(&"SMALLINT".to_string()));
    }
}
