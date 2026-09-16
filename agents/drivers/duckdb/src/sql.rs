pub fn split_sql_statements(script: &str) -> Vec<String> {
    let bytes = script.as_bytes();
    let mut statements = Vec::new();
    let mut start = 0;
    let mut index = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_escape_single = false;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' if in_single && in_escape_single => {
                index = (index + 2).min(bytes.len());
                continue;
            }
            b'\'' if !in_double => {
                if in_single && index + 1 < bytes.len() && bytes[index + 1] == b'\'' {
                    index += 2;
                    continue;
                }
                if !in_single {
                    in_escape_single = is_escape_string_quote(bytes, index);
                }
                in_single = !in_single;
                if !in_single {
                    in_escape_single = false;
                }
            }
            b'"' if !in_single => {
                if in_double && index + 1 < bytes.len() && bytes[index + 1] == b'"' {
                    index += 2;
                    continue;
                }
                in_double = !in_double;
            }
            b'-' if !in_single && !in_double && bytes.get(index + 1) == Some(&b'-') => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
                continue;
            }
            b'/' if !in_single && !in_double && bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index < bytes.len() && !(bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/')) {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
                continue;
            }
            b'$' if !in_single && !in_double => {
                if let Some(end) = dollar_quote_end(bytes, index) {
                    index = end;
                    continue;
                }
            }
            b';' if !in_single && !in_double => {
                push_statement(&mut statements, &script[start..index]);
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    push_statement(&mut statements, &script[start..]);
    statements
}

fn is_escape_string_quote(bytes: &[u8], quote_index: usize) -> bool {
    if quote_index == 0 || !matches!(bytes[quote_index - 1], b'E' | b'e') {
        return false;
    }
    quote_index == 1 || !(bytes[quote_index - 2].is_ascii_alphanumeric() || bytes[quote_index - 2] == b'_')
}

fn push_statement(statements: &mut Vec<String>, fragment: &str) {
    let trimmed = fragment.trim();
    if !trimmed.is_empty() {
        statements.push(trimmed.to_string());
    }
}

fn dollar_quote_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut tag_end = start + 1;
    while tag_end < bytes.len() && (bytes[tag_end] == b'_' || bytes[tag_end].is_ascii_alphanumeric()) {
        tag_end += 1;
    }
    if tag_end >= bytes.len() || bytes[tag_end] != b'$' {
        return None;
    }
    if tag_end > start + 1 && bytes[start + 1].is_ascii_digit() {
        return None;
    }
    let tag = &bytes[start..=tag_end];
    let mut index = tag_end + 1;
    while index + tag.len() <= bytes.len() {
        if &bytes[index..index + tag.len()] == tag {
            return Some(index + tag.len());
        }
        index += 1;
    }
    Some(bytes.len())
}

pub fn attached_name_from_attach_sql(sql: &str) -> Option<String> {
    let trimmed = strip_leading_comments(sql);
    let first_word = trimmed.split(|character: char| character.is_whitespace() || character == ';').next()?;
    if !first_word.eq_ignore_ascii_case("ATTACH") {
        return None;
    }

    let as_index = find_as_keyword_outside_quotes(trimmed)?;
    parse_identifier_after_as(&trimmed[as_index + 2..])
}

pub fn strip_leading_comments(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map(|(_, tail)| tail).unwrap_or("").trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map(|(_, tail)| tail).unwrap_or("").trim_start();
        } else {
            return rest;
        }
    }
}

fn find_as_keyword_outside_quotes(sql: &str) -> Option<usize> {
    let bytes = sql.as_bytes();
    let mut index = 0;
    let mut in_single = false;
    let mut in_double = false;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' if !in_double => {
                if in_single && index + 1 < bytes.len() && bytes[index + 1] == b'\'' {
                    index += 2;
                    continue;
                }
                in_single = !in_single;
            }
            b'"' if !in_single => {
                if in_double && index + 1 < bytes.len() && bytes[index + 1] == b'"' {
                    index += 2;
                    continue;
                }
                in_double = !in_double;
            }
            b'a' | b'A'
                if !in_single
                    && !in_double
                    && index + 1 < bytes.len()
                    && matches!(bytes[index + 1], b's' | b'S')
                    && is_sql_word_boundary(bytes.get(index.wrapping_sub(1)).copied())
                    && is_sql_word_boundary(bytes.get(index + 2).copied()) =>
            {
                return Some(index);
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn is_sql_word_boundary(byte: Option<u8>) -> bool {
    !matches!(byte, Some(b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_'))
}

fn parse_identifier_after_as(input: &str) -> Option<String> {
    let input = input.trim_start();
    if input.is_empty() {
        return None;
    }
    if let Some(rest) = input.strip_prefix('"') {
        let mut name = String::new();
        let mut characters = rest.chars().peekable();
        while let Some(character) = characters.next() {
            if character == '"' {
                if characters.peek() == Some(&'"') {
                    name.push('"');
                    characters.next();
                    continue;
                }
                return (!name.trim().is_empty()).then_some(name);
            }
            name.push(character);
        }
        return None;
    }

    let name =
        input.split(|character: char| character.is_whitespace() || character == ';').next().unwrap_or_default().trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Works around a DuckDB binder bug: `CURRENT_DATE - 4` (a bare numeric literal directly
/// against the `CURRENT_DATE` keyword node) fails with "No function matches ... (DATE,
/// INTEGER_LITERAL)", while the functionally identical `current_date() - 4` binds fine.
/// Rewrites only that narrow pattern (`CURRENT_DATE` immediately followed by `+`/`-` and a raw
/// numeric literal) to the function-call form, so plain `CURRENT_DATE`, qualified references
/// (`t.current_date`), aliases (`AS current_date`), and already-cast literals are left untouched.
pub fn rewrite_duckdb_current_date_literal_arithmetic(sql: &str) -> std::borrow::Cow<'_, str> {
    const KEYWORD: &str = "CURRENT_DATE";
    let bytes = sql.as_bytes();
    let mut rewritten: Option<String> = None;
    let mut copied_to = 0usize;
    let mut index = 0usize;
    let mut in_single = false;
    let mut in_double = false;

    while index < bytes.len() {
        match bytes[index] {
            b'\'' if !in_double => {
                if in_single && bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                in_single = !in_single;
                index += 1;
                continue;
            }
            b'"' if !in_single => {
                if in_double && bytes.get(index + 1) == Some(&b'"') {
                    index += 2;
                    continue;
                }
                in_double = !in_double;
                index += 1;
                continue;
            }
            b'-' if !in_single && !in_double && bytes.get(index + 1) == Some(&b'-') => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
                continue;
            }
            b'/' if !in_single && !in_double && bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
                continue;
            }
            b'$' if !in_single && !in_double => {
                if let Some(end) = dollar_quote_end(bytes, index) {
                    index = end;
                    continue;
                }
                index += 1;
            }
            _ if !in_single && !in_double && matches_keyword_at(bytes, index, KEYWORD) => {
                let word_end = index + KEYWORD.len();
                let preceded_by_dot = index > 0 && bytes[index - 1] == b'.';
                let preceded_by_ident = index > 0 && is_ident_byte(bytes[index - 1]);
                let followed_by_ident = bytes.get(word_end).copied().is_some_and(is_ident_byte);
                if !preceded_by_dot
                    && !preceded_by_ident
                    && !followed_by_ident
                    && has_raw_numeric_arithmetic_after(bytes, word_end)
                {
                    let buf = rewritten.get_or_insert_with(String::new);
                    buf.push_str(&sql[copied_to..index]);
                    buf.push_str("current_date()");
                    copied_to = word_end;
                }
                index = word_end;
                continue;
            }
            _ => {
                index += 1;
            }
        }
    }

    match rewritten {
        Some(mut buf) => {
            buf.push_str(&sql[copied_to..]);
            std::borrow::Cow::Owned(buf)
        }
        None => std::borrow::Cow::Borrowed(sql),
    }
}

fn matches_keyword_at(bytes: &[u8], index: usize, keyword: &str) -> bool {
    let keyword_bytes = keyword.as_bytes();
    bytes.len() >= index + keyword_bytes.len()
        && bytes[index..index + keyword_bytes.len()].eq_ignore_ascii_case(keyword_bytes)
}

fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// After the `CURRENT_DATE` token: skip whitespace, require a `+`/`-` that isn't the start of a
/// `--` comment, skip whitespace again, and require a raw numeric literal (not `CAST(`/`::`).
fn has_raw_numeric_arithmetic_after(bytes: &[u8], from: usize) -> bool {
    let mut index = from;
    while bytes.get(index).copied().is_some_and(|b| b.is_ascii_whitespace()) {
        index += 1;
    }
    let Some(&op) = bytes.get(index) else { return false };
    if op != b'+' && op != b'-' {
        return false;
    }
    if op == b'-' && bytes.get(index + 1) == Some(&b'-') {
        return false;
    }
    index += 1;
    while bytes.get(index).copied().is_some_and(|b| b.is_ascii_whitespace()) {
        index += 1;
    }
    bytes.get(index).copied().is_some_and(|b| b.is_ascii_digit())
}

pub fn starts_with_duckdb_result_sql_keyword(sql: &str) -> bool {
    let Some(token) = first_executable_sql_token(sql) else {
        return false;
    };
    ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH", "PRAGMA", "FROM", "SUMMARIZE", "SUMMARISE", "PIVOT", "UNPIVOT"]
        .iter()
        .any(|keyword| {
            token.eq_ignore_ascii_case(keyword) || (*keyword == "DESCRIBE" && token.eq_ignore_ascii_case("DESC"))
        })
        || matches!(token.to_ascii_uppercase().as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE")
            && contains_unquoted_sql_keyword(sql, "RETURNING")
}

fn contains_unquoted_sql_keyword(sql: &str, keyword: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut index = 0;
    let mut in_single = false;
    let mut in_double = false;

    while index < bytes.len() {
        match bytes[index] {
            b'\'' if !in_double => {
                if in_single && bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                in_single = !in_single;
                index += 1;
            }
            b'"' if !in_single => {
                if in_double && bytes.get(index + 1) == Some(&b'"') {
                    index += 2;
                    continue;
                }
                in_double = !in_double;
                index += 1;
            }
            b'-' if !in_single && !in_double && bytes.get(index + 1) == Some(&b'-') => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if !in_single && !in_double && bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
            }
            byte if !in_single && !in_double && (byte.is_ascii_alphabetic() || byte == b'_') => {
                let start = index;
                index += 1;
                while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_') {
                    index += 1;
                }
                if sql[start..index].eq_ignore_ascii_case(keyword) {
                    return true;
                }
            }
            _ => index += 1,
        }
    }

    false
}

fn first_executable_sql_token(sql: &str) -> Option<&str> {
    let bytes = sql.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        while index < bytes.len() && (bytes[index].is_ascii_whitespace() || bytes[index] == b'(') {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        if index + 1 < bytes.len() && bytes[index] == b'-' && bytes[index + 1] == b'-' {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        break;
    }

    let start = index;
    while index < bytes.len() && (bytes[index].is_ascii_alphabetic() || bytes[index] == b'_') {
        index += 1;
    }
    (index > start).then_some(&sql[start..index])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_quoted_and_commented_statements() {
        let script = "SET s3_endpoint='host;port'; -- comment;\nATTACH 'db;x.duckdb' AS a; SELECT $$a;b$$";
        assert_eq!(
            split_sql_statements(script),
            vec![
                "SET s3_endpoint='host;port'".to_string(),
                "-- comment;\nATTACH 'db;x.duckdb' AS a".to_string(),
                "SELECT $$a;b$$".to_string(),
            ]
        );
    }

    #[test]
    fn detects_attach_alias_after_comments() {
        assert_eq!(
            attached_name_from_attach_sql("-- note\nATTACH 'sales.duckdb' AS \"sales db\";"),
            Some("sales db".to_string())
        );
    }

    #[test]
    fn detects_result_statements_after_comments() {
        assert!(starts_with_duckdb_result_sql_keyword("/* note */ WITH rows AS (SELECT 1) SELECT * FROM rows"));
        assert!(starts_with_duckdb_result_sql_keyword("DESC SELECT 1"));
        assert!(starts_with_duckdb_result_sql_keyword("INSERT INTO items VALUES (1) RETURNING id"));
        assert!(!starts_with_duckdb_result_sql_keyword("INSERT INTO items(note) VALUES ('RETURNING')"));
        assert!(!starts_with_duckdb_result_sql_keyword("INSERT INTO items VALUES (1)"));
    }

    #[test]
    fn rewrites_current_date_literal_arithmetic() {
        assert_eq!(
            rewrite_duckdb_current_date_literal_arithmetic("SELECT CURRENT_DATE - 4"),
            "SELECT current_date() - 4"
        );
        assert_eq!(rewrite_duckdb_current_date_literal_arithmetic("SELECT CURRENT_DATE-4"), "SELECT current_date()-4");
        assert_eq!(
            rewrite_duckdb_current_date_literal_arithmetic("SELECT current_date + 1.5 AS d"),
            "SELECT current_date() + 1.5 AS d"
        );
        assert_eq!(
            rewrite_duckdb_current_date_literal_arithmetic("SELECT CURRENT_DATE - 4, CURRENT_DATE - 1"),
            "SELECT current_date() - 4, current_date() - 1"
        );
        // Already-cast literals still match the narrow "digit right after the operator" check;
        // rewriting them too is harmless since current_date() binds fine against any numeric form.
        assert_eq!(
            rewrite_duckdb_current_date_literal_arithmetic("SELECT CURRENT_DATE - 4::INTEGER"),
            "SELECT current_date() - 4::INTEGER"
        );
    }

    #[test]
    fn leaves_non_literal_current_date_usage_untouched() {
        for sql in [
            "SELECT CURRENT_DATE",
            "SELECT CURRENT_DATE::VARCHAR",
            "SELECT CURRENT_DATE - CAST(4 AS INTEGER)",
            "SELECT t.current_date - 4 FROM t",
            "SELECT 1 AS current_date",
            "CREATE TABLE cd_test (current_date INTEGER)",
            "SELECT 4 - CURRENT_DATE",
            "SELECT current_date() - 4",
            "-- CURRENT_DATE - 4\nSELECT 1",
            "SELECT '-- CURRENT_DATE - 4'",
        ] {
            assert_eq!(rewrite_duckdb_current_date_literal_arithmetic(sql), sql, "should not rewrite: {sql}");
        }
    }

    #[test]
    fn leaves_dollar_quoted_current_date_arithmetic_untouched() {
        assert_eq!(
            rewrite_duckdb_current_date_literal_arithmetic(
                "SELECT $$CURRENT_DATE - 4$$ AS source, CURRENT_DATE - 1 AS actual"
            ),
            "SELECT $$CURRENT_DATE - 4$$ AS source, current_date() - 1 AS actual"
        );
        assert_eq!(
            rewrite_duckdb_current_date_literal_arithmetic(
                "SELECT $body_1$CURRENT_DATE + 2$body_1$ AS source, CURRENT_DATE + 3 AS actual"
            ),
            "SELECT $body_1$CURRENT_DATE + 2$body_1$ AS source, current_date() + 3 AS actual"
        );
        assert_eq!(
            rewrite_duckdb_current_date_literal_arithmetic(
                "SELECT $outer$CURRENT_DATE - 4 $inner$ CURRENT_DATE + 2 $inner$$outer$ AS source"
            ),
            "SELECT $outer$CURRENT_DATE - 4 $inner$ CURRENT_DATE + 2 $inner$$outer$ AS source"
        );
        assert_eq!(
            rewrite_duckdb_current_date_literal_arithmetic("SELECT $body$CURRENT_DATE - 4"),
            "SELECT $body$CURRENT_DATE - 4"
        );
    }
}
