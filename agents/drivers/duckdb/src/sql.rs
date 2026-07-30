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

pub fn starts_with_duckdb_result_sql_keyword(sql: &str) -> bool {
    let Some(token) = first_executable_sql_token(sql) else {
        return false;
    };
    ["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH", "PRAGMA", "FROM", "SUMMARIZE", "SUMMARISE", "PIVOT", "UNPIVOT"]
        .iter()
        .any(|keyword| {
            token.eq_ignore_ascii_case(keyword) || (*keyword == "DESCRIBE" && token.eq_ignore_ascii_case("DESC"))
        })
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
        assert!(!starts_with_duckdb_result_sql_keyword("INSERT INTO items VALUES (1)"));
    }
}
