pub const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub fn safe_i64_to_json(v: i64) -> serde_json::Value {
    if !(-JS_MAX_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(&v) {
        serde_json::Value::String(v.to_string())
    } else {
        serde_json::Value::Number(v.into())
    }
}

pub fn safe_u64_to_json(v: u64) -> serde_json::Value {
    if v > JS_MAX_SAFE_INTEGER as u64 {
        serde_json::Value::String(v.to_string())
    } else {
        serde_json::Value::Number(v.into())
    }
}

pub fn json_value_for_js(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                safe_i64_to_json(value)
            } else if let Some(value) = number.as_u64() {
                safe_u64_to_json(value)
            } else {
                let value = number.to_string();
                if value.bytes().all(|byte| byte == b'-' || byte.is_ascii_digit()) {
                    serde_json::Value::String(value)
                } else {
                    serde_json::Value::Number(number)
                }
            }
        }
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(json_value_for_js).collect())
        }
        serde_json::Value::Object(entries) => {
            serde_json::Value::Object(entries.into_iter().map(|(key, value)| (key, json_value_for_js(value))).collect())
        }
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arbitrary_precision_integers_are_strings_for_js() {
        let value = serde_json::from_str(
            r#"{
                "positive": 20240302001417986771,
                "negative": -20240302001417986771
            }"#,
        )
        .unwrap();

        assert_eq!(
            json_value_for_js(value),
            serde_json::json!({
                "positive": "20240302001417986771",
                "negative": "-20240302001417986771"
            })
        );
    }

    #[test]
    fn json_value_for_js_preserves_existing_value_behavior_recursively() {
        let value = serde_json::from_str(
            r#"{
                "safe": [9007199254740991, -9007199254740991],
                "unsafe": [9007199254740992, -9007199254740992],
                "non_integer": [1.25, 1e-2],
                "other": [null, true, "text"]
            }"#,
        )
        .unwrap();
        let expected: serde_json::Value = serde_json::from_str(
            r#"{
                "safe": [9007199254740991, -9007199254740991],
                "unsafe": ["9007199254740992", "-9007199254740992"],
                "non_integer": [1.25, 1e-2],
                "other": [null, true, "text"]
            }"#,
        )
        .unwrap();

        assert_eq!(json_value_for_js(value), expected);
    }
}
