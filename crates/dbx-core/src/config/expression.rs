use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Expression {
    EnvVar(String),
    Ref(String),
    Eval(String),
    Literal(String),
}

pub fn parse_expression(input: &str) -> Expression {
    let trimmed = input.trim();
    if trimmed.starts_with("${env:") && trimmed.ends_with('}') {
        let inner = &trimmed[6..trimmed.len() - 1];
        Expression::EnvVar(inner.to_string())
    } else if trimmed.starts_with("${ref:") && trimmed.ends_with('}') {
        let inner = &trimmed[6..trimmed.len() - 1];
        Expression::Ref(inner.to_string())
    } else if trimmed.starts_with("${eval:") && trimmed.ends_with('}') {
        let inner = &trimmed[7..trimmed.len() - 1];
        Expression::Eval(inner.to_string())
    } else {
        Expression::Literal(input.to_string())
    }
}

pub fn resolve_env_var(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("Environment variable '${name}' not set"))
}

pub fn resolve_ref(path: &str, merged: &HashMap<String, serde_json::Value>) -> Result<serde_json::Value, String> {
    let parts: Vec<&str> = path.split('.').collect();
    let key = parts[0];
    let value = merged.get(key).ok_or_else(|| format!("Config reference '${path}' not found in merged config"))?;

    if parts.len() == 1 {
        return Ok(value.clone());
    }

    let mut current = value;
    for part in &parts[1..] {
        match current {
            serde_json::Value::Object(map) => {
                current =
                    map.get(*part).ok_or_else(|| format!("Config reference '${path}': key '{part}' not found"))?;
            }
            _ => {
                return Err(format!("Config reference '${path}': intermediate value is not an object"));
            }
        }
    }
    Ok(current.clone())
}

/// Parses JSON literals only (numbers, booleans, null, quoted strings).
/// Does NOT support arithmetic, operators, or function calls.
fn eval_simple(expr: &str) -> Result<serde_json::Value, String> {
    let expr = expr.trim();

    if let Ok(v) = expr.parse::<i64>() {
        return Ok(serde_json::Value::Number(v.into()));
    }

    if let Ok(v) = expr.parse::<f64>() {
        if let Some(n) = serde_json::Number::from_f64(v) {
            return Ok(serde_json::Value::Number(n));
        }
    }

    if expr == "true" {
        return Ok(serde_json::Value::Bool(true));
    }
    if expr == "false" {
        return Ok(serde_json::Value::Bool(false));
    }
    if expr == "null" {
        return Ok(serde_json::Value::Null);
    }

    if expr.starts_with('"') && expr.ends_with('"') && expr.len() >= 2 {
        return Ok(serde_json::Value::String(expr[1..expr.len() - 1].to_string()));
    }

    Err(format!("Cannot evaluate expression: '{expr}'"))
}

pub fn resolve_expression(
    expression: &Expression,
    merged: &HashMap<String, serde_json::Value>,
) -> Result<serde_json::Value, String> {
    match expression {
        Expression::EnvVar(name) => {
            let val = resolve_env_var(name)?;
            Ok(serde_json::Value::String(val))
        }
        Expression::Ref(path) => resolve_ref(path, merged),
        Expression::Eval(expr) => eval_simple(expr),
        Expression::Literal(val) => Ok(serde_json::Value::String(val.clone())),
    }
}

pub fn resolve_all_expressions_in_value(
    value: &serde_json::Value,
    merged: &HashMap<String, serde_json::Value>,
) -> Result<serde_json::Value, String> {
    match value {
        serde_json::Value::String(s) => {
            let expr = parse_expression(s);
            resolve_expression(&expr, merged)
        }
        serde_json::Value::Object(map) => {
            let mut resolved = serde_json::Map::new();
            for (k, v) in map {
                resolved.insert(k.clone(), resolve_all_expressions_in_value(v, merged)?);
            }
            Ok(serde_json::Value::Object(resolved))
        }
        serde_json::Value::Array(arr) => {
            let mut resolved = Vec::new();
            for v in arr {
                resolved.push(resolve_all_expressions_in_value(v, merged)?);
            }
            Ok(serde_json::Value::Array(resolved))
        }
        other => Ok(other.clone()),
    }
}

pub fn apply_expression_resolution(
    config: &mut HashMap<String, serde_json::Value>,
    merged: &HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    let mut resolved = HashMap::new();
    for (k, v) in config.iter() {
        resolved.insert(k.clone(), resolve_all_expressions_in_value(v, merged)?);
    }
    config.extend(resolved);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_env_var_expression() {
        assert_eq!(parse_expression("${env:HOME}"), Expression::EnvVar("HOME".to_string()));
    }

    #[test]
    fn test_parse_ref_expression() {
        assert_eq!(parse_expression("${ref:database.host}"), Expression::Ref("database.host".to_string()));
    }

    #[test]
    fn test_parse_eval_expression() {
        assert_eq!(parse_expression("${eval:42}"), Expression::Eval("42".to_string()));
    }

    #[test]
    fn test_parse_literal() {
        assert_eq!(parse_expression("hello"), Expression::Literal("hello".to_string()));
        assert_eq!(parse_expression("${not-an-expr}"), Expression::Literal("${not-an-expr}".to_string()));
    }

    #[test]
    fn test_resolve_env_var() {
        std::env::set_var("DBX_TEST_VAR", "test_value");
        let result = resolve_env_var("DBX_TEST_VAR");
        assert_eq!(result.unwrap(), "test_value");
        std::env::remove_var("DBX_TEST_VAR");
    }

    #[test]
    fn test_resolve_env_var_missing() {
        let result = resolve_env_var("DBX_NONEXISTENT_VAR_12345");
        assert!(result.is_err());
    }

    #[test]
    fn test_resolve_ref_simple() {
        let mut merged = HashMap::new();
        merged.insert("host".to_string(), serde_json::Value::String("localhost".to_string()));

        let result = resolve_ref("host", &merged).unwrap();
        assert_eq!(result, serde_json::Value::String("localhost".to_string()));
    }

    #[test]
    fn test_resolve_ref_nested() {
        let mut merged = HashMap::new();
        let mut db = serde_json::Map::new();
        db.insert("host".to_string(), serde_json::Value::String("pg.example.com".to_string()));
        db.insert("port".to_string(), serde_json::Value::Number(serde_json::Number::from(5432)));
        merged.insert("database".to_string(), serde_json::Value::Object(db));

        let host = resolve_ref("database.host", &merged).unwrap();
        assert_eq!(host, serde_json::Value::String("pg.example.com".to_string()));

        let port = resolve_ref("database.port", &merged).unwrap();
        assert_eq!(port, serde_json::Value::Number(serde_json::Number::from(5432)));
    }

    #[test]
    fn test_resolve_ref_missing() {
        let merged = HashMap::new();
        let result = resolve_ref("nonexistent", &merged);
        assert!(result.is_err());
    }

    #[test]
    fn test_eval_simple_integer() {
        let result = eval_simple("42").unwrap();
        assert_eq!(result, serde_json::Value::Number(serde_json::Number::from(42)));
    }

    #[test]
    fn test_eval_simple_bool() {
        assert_eq!(eval_simple("true").unwrap(), serde_json::Value::Bool(true));
        assert_eq!(eval_simple("false").unwrap(), serde_json::Value::Bool(false));
    }

    #[test]
    fn test_eval_simple_null() {
        assert_eq!(eval_simple("null").unwrap(), serde_json::Value::Null);
    }

    #[test]
    fn test_eval_simple_string() {
        let result = eval_simple(r#""hello world""#).unwrap();
        assert_eq!(result, serde_json::Value::String("hello world".to_string()));
    }

    #[test]
    fn test_eval_simple_invalid() {
        assert!(eval_simple("some_random_text").is_err());
    }

    #[test]
    fn test_resolve_expression_env_var() {
        std::env::set_var("DBX_TEST_PORT", "8080");
        let expr = Expression::EnvVar("DBX_TEST_PORT".to_string());
        let merged = HashMap::new();
        let result = resolve_expression(&expr, &merged).unwrap();
        assert_eq!(result, serde_json::Value::String("8080".to_string()));
        std::env::remove_var("DBX_TEST_PORT");
    }

    #[test]
    fn test_resolve_expression_ref() {
        let mut merged = HashMap::new();
        merged.insert("host".to_string(), serde_json::Value::String("db.local".to_string()));
        let expr = Expression::Ref("host".to_string());
        let result = resolve_expression(&expr, &merged).unwrap();
        assert_eq!(result, serde_json::Value::String("db.local".to_string()));
    }

    #[test]
    fn test_resolve_expression_eval() {
        let expr = Expression::Eval("true".to_string());
        let merged = HashMap::new();
        let result = resolve_expression(&expr, &merged).unwrap();
        assert_eq!(result, serde_json::Value::Bool(true));
    }

    #[test]
    fn test_resolve_expression_literal() {
        let expr = Expression::Literal("hello".to_string());
        let merged = HashMap::new();
        let result = resolve_expression(&expr, &merged).unwrap();
        assert_eq!(result, serde_json::Value::String("hello".to_string()));
    }

    #[test]
    fn test_resolve_all_in_nested_object() {
        let mut merged = HashMap::new();
        merged.insert("default_host".to_string(), serde_json::Value::String("pg.example.com".to_string()));

        let mut obj = serde_json::Map::new();
        obj.insert("host".to_string(), serde_json::Value::String("${ref:default_host}".to_string()));
        obj.insert("port".to_string(), serde_json::Value::Number(serde_json::Number::from(5432)));
        obj.insert("debug".to_string(), serde_json::Value::String("${eval:true}".to_string()));

        let input = serde_json::Value::Object(obj);
        let result = resolve_all_expressions_in_value(&input, &merged).unwrap();

        let obj = result.as_object().unwrap();
        assert_eq!(obj.get("host").unwrap(), &serde_json::Value::String("pg.example.com".to_string()));
        assert_eq!(obj.get("port").unwrap(), &serde_json::Value::Number(serde_json::Number::from(5432)));
        assert_eq!(obj.get("debug").unwrap(), &serde_json::Value::Bool(true));
    }

    #[test]
    fn test_apply_expression_resolution() {
        let mut merged = HashMap::new();
        merged.insert("base_url".to_string(), serde_json::Value::String("https://api.example.com".to_string()));

        let mut config = HashMap::new();
        config.insert("url".to_string(), serde_json::Value::String("${ref:base_url}".to_string()));
        config.insert("timeout".to_string(), serde_json::Value::String("${eval:30}".to_string()));

        apply_expression_resolution(&mut config, &merged).unwrap();
        assert_eq!(config.get("url").unwrap(), &serde_json::Value::String("https://api.example.com".to_string()));
        assert_eq!(config.get("timeout").unwrap(), &serde_json::Value::Number(serde_json::Number::from(30)));
    }
}
