use super::descriptor::{DialectKind, TypeMappingMatrix};

#[derive(Debug, Clone, PartialEq)]
pub struct ColumnType {
    pub base_type: String,
    pub precision: Option<u32>,
    pub scale: Option<u32>,
    pub length: Option<u32>,
    pub is_array: bool,
    pub is_unsigned: bool,
    pub extras: Vec<String>,
}

impl ColumnType {
    pub fn parse(type_str: &str) -> Self {
        let trimmed = type_str.trim();
        let (base_type, params_str) = match trimmed.find('(') {
            Some(pos) if trimmed.ends_with(')') => {
                let base = trimmed[..pos].trim().to_string();
                let params = trimmed[pos + 1..trimmed.len() - 1].trim();
                (base, Some(params))
            }
            _ => (trimmed.to_string(), None),
        };

        let is_unsigned = base_type.to_ascii_lowercase().contains("unsigned");
        let is_array = trimmed.ends_with("[]") || trimmed.to_ascii_lowercase().contains(" array");
        let base_type_clean =
            base_type.replace(" unsigned", "").replace(" UNSIGNED", "").replace("[]", "").trim().to_string();

        let (precision, scale, length) = match params_str {
            Some(params) if params.contains(',') => {
                let parts: Vec<&str> = params.split(',').collect();
                if parts.len() >= 2 {
                    let p = parts[0].trim().parse().ok();
                    let s = parts[1].trim().parse().ok();
                    (p, s, None)
                } else {
                    (None, None, params.parse().ok())
                }
            }
            Some(params) => {
                let v = params.parse().ok();
                (None, None, v)
            }
            None => (None, None, None),
        };

        Self { base_type: base_type_clean, precision, scale, length, is_array, is_unsigned, extras: Vec::new() }
    }

    pub fn to_string(&self, dialect: DialectKind) -> String {
        let mut result = self.base_type.clone();

        if self.is_unsigned && dialect == DialectKind::Mysql {
            result.push_str(" UNSIGNED");
        }

        if let Some(len) = self.length {
            result.push_str(&format!("({len})"));
        } else if let Some(p) = self.precision {
            if let Some(s) = self.scale {
                result.push_str(&format!("({p},{s})"));
            } else {
                result.push_str(&format!("({p})"));
            }
        }

        if self.is_array && (dialect == DialectKind::Postgres || dialect == DialectKind::DuckDb) {
            result.push_str("[]");
        }

        result
    }
}

pub trait TypeInferenceEngine {
    fn infer_type(&self, source_type: &str, source_dialect: DialectKind, target_dialect: DialectKind) -> ColumnType;

    fn suggest_type(&self, column: &ColumnType, target_dialect: DialectKind) -> String;

    fn convert_default_value(
        &self,
        default_expr: &str,
        source_dialect: DialectKind,
        target_dialect: DialectKind,
    ) -> String;

    fn type_compatibility_score(&self, source: &ColumnType, target: &ColumnType) -> f64;
}

const SCORE_IDENTICAL: f64 = 1.0;
const SCORE_ALIAS: f64 = 0.9;
const SCORE_INTEGER_FAMILY: f64 = 0.8;
const SCORE_TEXT_FAMILY: f64 = 0.7;
const SCORE_UNRELATED: f64 = 0.3;

pub struct DefaultTypeInferenceEngine;

impl DefaultTypeInferenceEngine {
    fn map_type_name(&self, type_name: &str, from: DialectKind, to: DialectKind) -> String {
        let matrix = TypeMappingMatrix::for_dialects(from, to);
        let (converted, _) = matrix.convert_type(type_name);
        converted
    }
}

impl TypeInferenceEngine for DefaultTypeInferenceEngine {
    fn infer_type(&self, source_type: &str, source_dialect: DialectKind, target_dialect: DialectKind) -> ColumnType {
        let source_parsed = ColumnType::parse(source_type);
        let mapped_base = self.map_type_name(&source_parsed.base_type, source_dialect, target_dialect);

        let target_caps = crate::sql_dialect::resolve(target_dialect);
        let needs_precision = mapped_base.to_ascii_lowercase().contains("decimal")
            || mapped_base.to_ascii_lowercase().contains("numeric")
            || mapped_base.to_ascii_lowercase().contains("varchar");

        let (precision, scale, length) = if needs_precision {
            (source_parsed.precision, source_parsed.scale, source_parsed.length)
        } else if mapped_base.eq_ignore_ascii_case("integer") && source_parsed.precision.is_some() {
            (None, None, None)
        } else {
            (source_parsed.precision, source_parsed.scale, source_parsed.length)
        };

        ColumnType {
            base_type: mapped_base,
            precision,
            scale,
            length,
            is_array: source_parsed.is_array && target_caps.supports_array_type,
            is_unsigned: source_parsed.is_unsigned && target_dialect == DialectKind::Mysql,
            extras: source_parsed.extras,
        }
    }

    fn suggest_type(&self, column: &ColumnType, target_dialect: DialectKind) -> String {
        column.to_string(target_dialect)
    }

    fn convert_default_value(
        &self,
        default_expr: &str,
        source_dialect: DialectKind,
        target_dialect: DialectKind,
    ) -> String {
        let trimmed = default_expr.trim();
        if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") || trimmed.eq_ignore_ascii_case("NULL") {
            return String::new();
        }

        match (source_dialect, target_dialect) {
            (DialectKind::Mysql, DialectKind::Postgres) => {
                let lower = trimmed.to_ascii_lowercase();
                if lower == "current_timestamp" || lower == "current_timestamp()" || lower == "now()" {
                    return "CURRENT_TIMESTAMP".to_string();
                }
                if lower.starts_with("on update ") {
                    return String::new();
                }
            }
            (DialectKind::Postgres, DialectKind::Mysql) => {
                let lower = trimmed.to_ascii_lowercase();
                if lower == "current_timestamp" || lower == "now()" || lower == "transaction_timestamp()" {
                    return "CURRENT_TIMESTAMP".to_string();
                }
            }
            (DialectKind::Mysql, DialectKind::Sqlite) => {
                let lower = trimmed.to_ascii_lowercase();
                if lower == "current_timestamp" || lower == "current_timestamp()" || lower == "now()" {
                    return "CURRENT_TIMESTAMP".to_string();
                }
            }
            _ => {}
        }

        trimmed.to_string()
    }

    fn type_compatibility_score(&self, source: &ColumnType, target: &ColumnType) -> f64 {
        let source_lower = source.base_type.to_ascii_lowercase();
        let target_lower = target.base_type.to_ascii_lowercase();

        if source_lower == target_lower {
            return SCORE_IDENTICAL;
        }

        let exact_matches = [
            ("int", "integer"),
            ("integer", "int"),
            ("float", "real"),
            ("real", "float"),
            ("double", "double precision"),
            ("double precision", "double"),
            ("bool", "boolean"),
            ("boolean", "bool"),
            ("timestamp", "datetime"),
            ("datetime", "timestamp"),
        ];
        if exact_matches.contains(&(source_lower.as_str(), target_lower.as_str())) {
            return SCORE_ALIAS;
        }

        let integer_family = ["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "serial", "bigserial"];
        let text_family = ["char", "varchar", "text", "tinytext", "mediumtext", "longtext", "clob", "nclob"];

        if integer_family.contains(&source_lower.as_str()) && integer_family.contains(&target_lower.as_str()) {
            return SCORE_INTEGER_FAMILY;
        }
        if text_family.contains(&source_lower.as_str()) && text_family.contains(&target_lower.as_str()) {
            return SCORE_TEXT_FAMILY;
        }

        SCORE_UNRELATED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_type() {
        let t = ColumnType::parse("INT");
        assert_eq!(t.base_type, "INT");
        assert!(t.precision.is_none());
        assert!(t.length.is_none());
    }

    #[test]
    fn parse_type_with_length() {
        let t = ColumnType::parse("VARCHAR(255)");
        assert_eq!(t.base_type, "VARCHAR");
        assert_eq!(t.length, Some(255));
    }

    #[test]
    fn parse_type_with_precision_scale() {
        let t = ColumnType::parse("DECIMAL(10,2)");
        assert_eq!(t.base_type, "DECIMAL");
        assert_eq!(t.precision, Some(10));
        assert_eq!(t.scale, Some(2));
    }

    #[test]
    fn parse_unsigned_type() {
        let t = ColumnType::parse("INT UNSIGNED");
        assert_eq!(t.base_type, "INT");
        assert!(t.is_unsigned);
    }

    #[test]
    fn infer_mysql_int_to_postgres() {
        let engine = DefaultTypeInferenceEngine;
        let result = engine.infer_type("INT", DialectKind::Mysql, DialectKind::Postgres);
        assert_eq!(result.base_type, "INTEGER");
    }

    #[test]
    fn infer_mysql_datetime_to_postgres() {
        let engine = DefaultTypeInferenceEngine;
        let result = engine.infer_type("DATETIME", DialectKind::Mysql, DialectKind::Postgres);
        assert_eq!(result.base_type, "TIMESTAMP");
    }

    #[test]
    fn infer_postgres_text_to_mysql() {
        let engine = DefaultTypeInferenceEngine;
        let result = engine.infer_type("TEXT", DialectKind::Postgres, DialectKind::Mysql);
        assert_eq!(result.base_type, "LONGTEXT");
    }

    #[test]
    fn type_compatibility_exact_match() {
        let engine = DefaultTypeInferenceEngine;
        let a = ColumnType::parse("INT");
        let b = ColumnType::parse("INTEGER");
        let score = engine.type_compatibility_score(&a, &b);
        assert!((score - 0.9).abs() < 0.01);
    }

    #[test]
    fn type_compatibility_integer_family() {
        let engine = DefaultTypeInferenceEngine;
        let a = ColumnType::parse("SMALLINT");
        let b = ColumnType::parse("BIGINT");
        let score = engine.type_compatibility_score(&a, &b);
        assert!((score - 0.8).abs() < 0.01);
    }

    #[test]
    fn convert_default_value_mysql_to_postgres() {
        let engine = DefaultTypeInferenceEngine;
        assert_eq!(
            engine.convert_default_value("CURRENT_TIMESTAMP", DialectKind::Mysql, DialectKind::Postgres),
            "CURRENT_TIMESTAMP"
        );
        assert_eq!(
            engine.convert_default_value("NOW()", DialectKind::Mysql, DialectKind::Postgres),
            "CURRENT_TIMESTAMP"
        );
        assert!(engine
            .convert_default_value("ON UPDATE CURRENT_TIMESTAMP", DialectKind::Mysql, DialectKind::Postgres)
            .is_empty());
    }

    #[test]
    fn unknown_type_passthrough() {
        let engine = DefaultTypeInferenceEngine;
        let result = engine.infer_type("GEOGRAPHY(POINT)", DialectKind::Postgres, DialectKind::Mysql);
        assert_eq!(result.base_type, "GEOGRAPHY");
    }

    #[test]
    fn parse_array_type() {
        let t = ColumnType::parse("INTEGER[]");
        assert!(t.is_array);
        assert_eq!(t.base_type, "INTEGER");
    }
}
