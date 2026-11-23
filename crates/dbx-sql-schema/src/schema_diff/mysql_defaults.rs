//! Render expression defaults returned by MySQL column metadata.
use sqlparser::dialect::MySqlDialect;
use sqlparser::tokenizer::{Token, Tokenizer};
use std::borrow::Cow;

pub(super) fn generated_default(value: &str, data_type: &str) -> String {
    let expression = decode_metadata_expression(value);
    if is_wrapped(&expression) || is_timestamp_default(&expression, data_type) {
        expression.into_owned()
    } else {
        format!("({expression})")
    }
}

fn decode_metadata_expression(value: &str) -> Cow<'_, str> {
    // INFORMATION_SCHEMA can escape the entire expression, including its quote
    // delimiters: _utf8mb4\'[0]\'. SQL received from other metadata paths may
    // already be decoded. Inspect the first string delimiter outside identifiers
    // so we never unescape the contents of an already valid SQL string twice.
    let mut chars = value.chars().peekable();
    let mut in_identifier = false;
    let mut encoded = false;
    while let Some(ch) = chars.next() {
        match ch {
            '`' => {
                if in_identifier && chars.next_if_eq(&'`').is_some() {
                    continue;
                }
                in_identifier = !in_identifier;
            }
            '\'' | '"' if !in_identifier => break,
            '\\' if !in_identifier => {
                if matches!(chars.peek(), Some('\'' | '"')) {
                    encoded = true;
                    break;
                }
                // Skip an escaped backslash, which cannot introduce a quote.
                chars.next_if_eq(&'\\');
            }
            _ => {}
        }
    }
    if !encoded {
        return Cow::Borrowed(value);
    }

    // Remove exactly one metadata escape layer. In particular, retain the SQL
    // layer of escaped apostrophes, JSON escapes, and literal backslashes.
    let mut decoded = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && matches!(chars.peek(), Some('\'' | '"' | '\\')) {
            decoded.push(chars.next().expect("peeked escape character"));
        } else {
            decoded.push(ch);
        }
    }
    Cow::Owned(decoded)
}

fn is_wrapped(expression: &str) -> bool {
    let Ok(tokens) = Tokenizer::new(&MySqlDialect {}, expression).tokenize() else {
        return false;
    };
    let mut tokens = tokens.iter().filter(|token| !matches!(token, Token::Whitespace(_))).peekable();
    if tokens.next() != Some(&Token::LParen) {
        return false;
    }
    let mut depth = 1;
    while let Some(token) = tokens.next() {
        match token {
            Token::LParen => depth += 1,
            Token::RParen => {
                depth -= 1;
                if depth == 0 {
                    return tokens.peek().is_none();
                }
            }
            _ => {}
        }
    }
    false
}

fn is_timestamp_default(expression: &str, data_type: &str) -> bool {
    let base_type = data_type.split('(').next().unwrap_or(data_type).trim();
    if !base_type.eq_ignore_ascii_case("timestamp") && !base_type.eq_ignore_ascii_case("datetime") {
        return false;
    }
    let keyword = if let Some((keyword, precision)) = expression.split_once('(') {
        let Some(precision) = precision.strip_suffix(')') else { return false };
        if !precision.bytes().all(|ch| ch.is_ascii_digit()) {
            return false;
        }
        keyword
    } else {
        expression
    };
    ["CURRENT_TIMESTAMP", "NOW", "LOCALTIME", "LOCALTIMESTAMP"]
        .iter()
        .any(|candidate| keyword.eq_ignore_ascii_case(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_one_metadata_escape_layer_and_preserves_sql_escapes() {
        for (metadata, sql) in [
            (r"_utf8mb4\'[0]\'", "_utf8mb4'[0]'"),
            (r"_utf8mb4\'it\\\'s\'", r"_utf8mb4'it\'s'"),
            (r"_utf8mb4\'C:\\\\tmp\'", r"_utf8mb4'C:\\tmp'"),
            (r#"_utf8mb4\'[\"a\\\\b\"]\'"#, r#"_utf8mb4'["a\\b"]'"#),
            (r"concat(_utf8mb4\'路径\', _utf8mb4\'\\n\')", r"concat(_utf8mb4'路径', _utf8mb4'\n')"),
        ] {
            assert_eq!(generated_default(metadata, "json"), format!("({sql})"), "{metadata}");
            assert_eq!(generated_default(sql, "json"), format!("({sql})"), "already decoded: {sql}");
        }
    }

    #[test]
    fn preserves_complete_parentheses_but_wraps_compound_expressions() {
        for expression in ["(_utf8mb4'[0]')", "((json_array(0)))", r"(concat('it\'s', ')'))"] {
            assert_eq!(generated_default(expression, "json"), expression);
        }
        assert_eq!(generated_default(r"(_utf8mb4\'[0]\')", "json"), "(_utf8mb4'[0]')");
        assert_eq!(generated_default("(1) + (2)", "int"), "((1) + (2))");
        assert_eq!(generated_default("json_array(0)", "json"), "(json_array(0))");
        assert_eq!(generated_default("uuid()", "varchar(36)"), "(uuid())");
        assert_eq!(generated_default("concat(`it's`, _utf8mb4'[0]')", "json"), "(concat(`it's`, _utf8mb4'[0]'))");
    }

    #[test]
    fn only_timestamp_defaults_can_omit_expression_parentheses() {
        for data_type in ["timestamp", "datetime(6)", "TIMESTAMP(3)"] {
            for expression in ["CURRENT_TIMESTAMP", "current_timestamp(6)", "NOW()", "LOCALTIME(3)", "LOCALTIMESTAMP"] {
                assert_eq!(generated_default(expression, data_type), expression);
            }
        }
        for (expression, data_type) in [
            ("CURRENT_TIMESTAMP + INTERVAL 1 DAY", "datetime"),
            ("CURRENT_TIMESTAMP(6) + INTERVAL 1 DAY", "datetime(6)"),
            ("CURRENT_DATE", "date"),
            ("CURRENT_TIMESTAMP", "varchar(32)"),
        ] {
            assert_eq!(generated_default(expression, data_type), format!("({expression})"));
        }
    }
}
