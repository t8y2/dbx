use mysql_common::binlog::jsonb::{JsonContainer, JsonDom, JsonNumber, JsonScalar, Value};

fn validate_raw(value: &Value<'_>, depth: usize, remaining: &mut usize) -> Result<(), String> {
    if depth > 64 || *remaining == 0 {
        return Err("JSON depth/element limit exceeded".into());
    }
    *remaining -= 1;
    macro_rules! object {
        ($object:expr) => {{
            let mut keys = std::collections::HashSet::new();
            if $object.element_count() as usize > *remaining {
                return Err("JSON element limit exceeded".into());
            }
            for entry in $object.iter() {
                let (key, value) = entry.map_err(|e| e.to_string())?;
                let key = std::str::from_utf8(key.value_raw()).map_err(|_| "invalid UTF-8 JSON object key")?;
                if !keys.insert(key.to_owned()) {
                    return Err("duplicate JSON object key".into());
                }
                validate_raw(&value, depth + 1, remaining)?;
            }
        }};
    }
    macro_rules! array {
        ($array:expr) => {{
            if $array.element_count() as usize > *remaining {
                return Err("JSON element limit exceeded".into());
            }
            for entry in $array.iter() {
                validate_raw(&entry.map_err(|e| e.to_string())?, depth + 1, remaining)?;
            }
        }};
    }
    match value {
        Value::SmallObject(value) => object!(value),
        Value::LargeObject(value) => object!(value),
        Value::SmallArray(value) => array!(value),
        Value::LargeArray(value) => array!(value),
        _ => {}
    }
    Ok(())
}

fn validate(value: &JsonDom, depth: usize, remaining: &mut usize) -> Result<(), String> {
    if depth > 64 || *remaining == 0 {
        return Err("JSON depth/element limit exceeded".into());
    }
    *remaining -= 1;
    match value {
        JsonDom::Container(JsonContainer::Array(items)) => {
            for item in items {
                validate(item, depth + 1, remaining)?;
            }
        }
        JsonDom::Container(JsonContainer::Object(items)) => {
            for item in items.values() {
                validate(item, depth + 1, remaining)?;
            }
        }
        JsonDom::Scalar(
            JsonScalar::Opaque(_) | JsonScalar::DateTime(_) | JsonScalar::Number(JsonNumber::Decimal(_)),
        ) => return Err("opaque/typed JSON values cannot be restored losslessly yet".into()),
        JsonDom::Scalar(JsonScalar::Number(JsonNumber::Double(value))) if !value.is_finite() => {
            return Err("nonfinite JSON number".into())
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn convert(value: &Value<'_>) -> Result<String, String> {
    // Upstream DOM conversion replaces invalid object keys; validate raw bytes first.
    validate_raw(value, 0, &mut 100_000)?;
    let dom = value.clone().parse().map_err(|error| format!("invalid binary JSON: {error}"))?;
    validate(&dom, 0, &mut 100_000)?;
    let value: serde_json::Value = dom.into();
    serde_json::to_string(&value).map_err(|error| error.to_string())
}
