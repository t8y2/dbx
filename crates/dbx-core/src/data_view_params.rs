use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::data_view::DataViewVariable;

/// A single variable value submitted by the data-view runner.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataViewParamValue {
    /// `string` | `number` | `boolean` | `date` | `null`.
    pub kind: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubstituteError {
    MissingRequired(String),
    InvalidNumber { name: String, value: String },
    InvalidBoolean { name: String, value: String },
}

impl std::fmt::Display for SubstituteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SubstituteError::MissingRequired(name) => write!(f, "缺少必填变量: {name}"),
            SubstituteError::InvalidNumber { name, value } => {
                write!(f, "变量 {name} 不是合法数字: {value}")
            }
            SubstituteError::InvalidBoolean { name, value } => {
                write!(f, "变量 {name} 不是合法布尔值: {value}")
            }
        }
    }
}

impl std::error::Error for SubstituteError {}

/// Resolves dynamic default tokens to concrete literals. `{{today}}`,
/// `{{yesterday}}`, `{{tomorrow}}` produce a `YYYY-MM-DD` date and `{{now}}` a
/// full local timestamp. Non-token input is returned unchanged.
pub fn resolve_dynamic_token(value: &str) -> String {
    let trimmed = value.trim();
    let today = chrono::Local::now().date_naive();
    match trimmed {
        "{{today}}" => today.format("%Y-%m-%d").to_string(),
        "{{yesterday}}" => today.pred_opt().unwrap_or(today).format("%Y-%m-%d").to_string(),
        "{{tomorrow}}" => today.succ_opt().unwrap_or(today).format("%Y-%m-%d").to_string(),
        "{{now}}" => chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        _ => value.to_string(),
    }
}

/// Resolves a value to a safe SQL literal for the declared `kind`. Untrusted
/// input never reaches the SQL text unquoted: strings/dates are single-quote
/// escaped, numbers are parsed (rejecting anything non-numeric), and booleans
/// are normalized. This is the injection boundary for shared data views.
fn to_sql_literal(name: &str, kind: &str, value: &str) -> Result<String, SubstituteError> {
    match kind {
        "number" => {
            let trimmed = value.trim();
            if trimmed.parse::<f64>().is_ok() && !trimmed.eq_ignore_ascii_case("nan") && !trimmed.contains(['x', 'X']) {
                Ok(trimmed.to_string())
            } else {
                Err(SubstituteError::InvalidNumber { name: name.to_string(), value: value.to_string() })
            }
        }
        "boolean" => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "t" => Ok("TRUE".to_string()),
            "false" | "0" | "no" | "f" | "" => Ok("FALSE".to_string()),
            _ => Err(SubstituteError::InvalidBoolean { name: name.to_string(), value: value.to_string() }),
        },
        "null" => Ok("NULL".to_string()),
        // string, date, and any unknown kind are treated as quoted string literals.
        _ => Ok(format!("'{}'", value.replace('\'', "''"))),
    }
}

/// Which target syntax `substitute()` should escape literals for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubstituteDialect {
    Sql,
    Redis,
}

/// Resolves a value to a safe Redis command argument for the declared `kind`.
/// Redis's own command tokenizer (`redis_driver::parse_command_argv`) uses
/// shell-style `"..."` quoting with backslash escapes, not SQL's doubled-quote
/// convention, so strings are wrapped and escaped accordingly.
fn to_redis_literal(name: &str, kind: &str, value: &str) -> Result<String, SubstituteError> {
    match kind {
        "number" => {
            let trimmed = value.trim();
            if trimmed.parse::<f64>().is_ok() && !trimmed.eq_ignore_ascii_case("nan") && !trimmed.contains(['x', 'X']) {
                Ok(trimmed.to_string())
            } else {
                Err(SubstituteError::InvalidNumber { name: name.to_string(), value: value.to_string() })
            }
        }
        "boolean" => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "t" => Ok("true".to_string()),
            "false" | "0" | "no" | "f" | "" => Ok("false".to_string()),
            _ => Err(SubstituteError::InvalidBoolean { name: name.to_string(), value: value.to_string() }),
        },
        // Redis has no NULL literal; an empty string argument is the closest equivalent.
        "null" => Ok("\"\"".to_string()),
        _ => Ok(format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))),
    }
}

fn to_literal(name: &str, kind: &str, value: &str, dialect: SubstituteDialect) -> Result<String, SubstituteError> {
    match dialect {
        SubstituteDialect::Sql => to_sql_literal(name, kind, value),
        SubstituteDialect::Redis => to_redis_literal(name, kind, value),
    }
}

/// Replaces every `${name}` placeholder in `template` with a safe literal
/// derived from `values` (falling back to each variable's `default_value`).
/// Unknown placeholders are left intact so they surface as SQL errors rather
/// than silently vanishing.
pub fn substitute(
    template: &str,
    variables: &[DataViewVariable],
    values: &HashMap<String, DataViewParamValue>,
    dialect: SubstituteDialect,
) -> Result<String, SubstituteError> {
    let mut resolved: HashMap<String, String> = HashMap::new();
    for variable in variables {
        let submitted = values.get(&variable.name);
        let raw_value =
            submitted.map(|v| v.value.clone()).filter(|v| !v.is_empty()).or_else(|| variable.default_value.clone());
        let kind = submitted.map(|v| v.kind.clone()).unwrap_or_else(|| variable.kind.clone());
        match raw_value {
            Some(value) => {
                let value = resolve_dynamic_token(&value);
                resolved.insert(variable.name.clone(), to_literal(&variable.name, &kind, &value, dialect)?);
            }
            None if variable.required => {
                return Err(SubstituteError::MissingRequired(variable.name.clone()));
            }
            None => {
                resolved.insert(
                    variable.name.clone(),
                    if dialect == SubstituteDialect::Redis { "\"\"".to_string() } else { "NULL".to_string() },
                );
            }
        }
    }

    Ok(replace_placeholders(template, &resolved))
}

fn replace_placeholders(template: &str, resolved: &HashMap<String, String>) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(close) = template[i + 2..].find('}') {
                let name = &template[i + 2..i + 2 + close];
                if let Some(replacement) = resolved.get(name.trim()) {
                    out.push_str(replacement);
                    i = i + 2 + close + 1;
                    continue;
                }
            }
        }
        // Copy the current UTF-8 char whole so multibyte text is preserved.
        let ch = template[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn var(name: &str, kind: &str, required: bool, default: Option<&str>) -> DataViewVariable {
        DataViewVariable {
            name: name.to_string(),
            label: String::new(),
            kind: kind.to_string(),
            input_type: "text".to_string(),
            options: vec![],
            required,
            default_value: default.map(|s| s.to_string()),
        }
    }

    fn val(kind: &str, value: &str) -> DataViewParamValue {
        DataViewParamValue { kind: kind.to_string(), value: value.to_string() }
    }

    #[test]
    fn substitutes_string_with_escaping() {
        let vars = vec![var("userId", "string", true, None)];
        let mut values = HashMap::new();
        values.insert("userId".to_string(), val("string", "o'brien"));
        let sql = substitute("SELECT * FROM u WHERE id = ${userId}", &vars, &values, SubstituteDialect::Sql).unwrap();
        assert_eq!(sql, "SELECT * FROM u WHERE id = 'o''brien'");
    }

    #[test]
    fn rejects_non_numeric_number() {
        let vars = vec![var("age", "number", true, None)];
        let mut values = HashMap::new();
        values.insert("age".to_string(), val("number", "1; DROP TABLE u"));
        let err = substitute("SELECT ${age}", &vars, &values, SubstituteDialect::Sql).unwrap_err();
        assert!(matches!(err, SubstituteError::InvalidNumber { .. }));
    }

    #[test]
    fn uses_default_when_missing() {
        let vars = vec![var("day", "date", false, Some("2026-08-29"))];
        let values = HashMap::new();
        let sql = substitute("WHERE d = ${day}", &vars, &values, SubstituteDialect::Sql).unwrap();
        assert_eq!(sql, "WHERE d = '2026-08-29'");
    }

    #[test]
    fn missing_required_errors() {
        let vars = vec![var("userId", "string", true, None)];
        let values = HashMap::new();
        assert!(matches!(
            substitute("${userId}", &vars, &values, SubstituteDialect::Sql).unwrap_err(),
            SubstituteError::MissingRequired(_)
        ));
    }

    #[test]
    fn unknown_placeholder_is_left_intact() {
        let vars = vec![];
        let values = HashMap::new();
        let sql = substitute("SELECT ${missing}", &vars, &values, SubstituteDialect::Sql).unwrap();
        assert_eq!(sql, "SELECT ${missing}");
    }

    #[test]
    fn resolves_today_dynamic_default() {
        let vars = vec![var("day", "date", false, Some("{{today}}"))];
        let values = HashMap::new();
        let expected = chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
        let sql = substitute("WHERE d = ${day}", &vars, &values, SubstituteDialect::Sql).unwrap();
        assert_eq!(sql, format!("WHERE d = '{expected}'"));
    }

    #[test]
    fn resolves_dynamic_token_from_submitted_value() {
        let vars = vec![var("day", "date", true, None)];
        let mut values = HashMap::new();
        values.insert("day".to_string(), val("date", "{{yesterday}}"));
        let expected = chrono::Local::now().date_naive().pred_opt().unwrap().format("%Y-%m-%d").to_string();
        let sql = substitute("WHERE d = ${day}", &vars, &values, SubstituteDialect::Sql).unwrap();
        assert_eq!(sql, format!("WHERE d = '{expected}'"));
    }

    #[test]
    fn redis_dialect_leaves_numbers_and_booleans_unquoted() {
        let vars = vec![var("count", "number", true, None), var("flag", "boolean", true, None)];
        let mut values = HashMap::new();
        values.insert("count".to_string(), val("number", "42"));
        values.insert("flag".to_string(), val("boolean", "true"));
        let cmd = substitute("SET n ${count} f ${flag}", &vars, &values, SubstituteDialect::Redis).unwrap();
        assert_eq!(cmd, "SET n 42 f true");
    }

    #[test]
    fn redis_dialect_quotes_and_escapes_strings() {
        let vars = vec![var("key", "string", true, None)];
        let mut values = HashMap::new();
        values.insert("key".to_string(), val("string", "o\"brien two"));
        let cmd = substitute("GET user:${key}", &vars, &values, SubstituteDialect::Redis).unwrap();
        assert_eq!(cmd, "GET user:\"o\\\"brien two\"");
        // Round-trip through Redis's own tokenizer: the substituted value must parse back as one argument.
        let argv = crate::db::redis_driver::parse_command_argv(&cmd).unwrap();
        assert_eq!(argv, vec!["GET".to_string(), format!("user:{}", "o\"brien two")]);
    }

    #[test]
    fn redis_dialect_uses_empty_string_for_null() {
        let vars = vec![var("opt", "string", false, None)];
        let values = HashMap::new();
        let cmd = substitute("SET k ${opt}", &vars, &values, SubstituteDialect::Redis).unwrap();
        assert_eq!(cmd, "SET k \"\"");
    }
}
