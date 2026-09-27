const DEFAULT_SQL_DIAGNOSTIC_MAX_CHARS: usize = 512;

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("password")
        || key.contains("passwd")
        || key == "pwd"
        || key.contains("secret")
        || key.contains("token")
        || key.contains("api_key")
        || key.contains("apikey")
        || key.contains("access_key")
        || key.contains("private_key")
        || key.contains("credential")
        || key.contains("authorization")
        || key.contains("bearer")
}

fn truncate_for_diagnostics(value: String, max_chars: usize, input_truncated: bool) -> String {
    if value.chars().count() <= max_chars {
        return if input_truncated { format!("{value}…[truncated]") } else { value };
    }
    let head: String = value.chars().take(max_chars).collect();
    format!("{head}…[truncated]")
}

fn bounded_input(sql: &str, max_chars: usize) -> (&str, bool) {
    if max_chars == 0 {
        return ("", !sql.is_empty());
    }
    match sql.char_indices().nth(max_chars) {
        Some((index, _)) => (&sql[..index], true),
        None => (sql, false),
    }
}

fn redact_literals(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let next = chars.get(i + 1).copied();
        if matches!(ch, '\'' | '"' | '`') {
            out.push(ch);
            out.push_str("[REDACTED]");
            out.push(ch);
            i += 1;
            while i < chars.len() {
                let current = chars[i];
                if current == ch {
                    if chars.get(i + 1).copied() == Some(ch) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                if current == '\\' && ch != '`' {
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if ch == '$' {
            let j = i + 1;
            if j >= chars.len() {
                out.push(ch);
                i += 1;
                continue;
            }
            if chars[j] == '$' {
                // $$...$$ dollar-quoted string
                out.push_str("$$[REDACTED]$$");
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '$' && chars[i + 1] == '$') {
                    i += 1;
                }
                if i + 1 < chars.len() {
                    i += 2;
                }
                continue;
            }
            // $tag$...$tag$ dollar-quoted string
            let tag_start = j;
            let mut tag_end = j;
            while tag_end < chars.len() && (chars[tag_end].is_ascii_alphanumeric() || chars[tag_end] == '_') {
                tag_end += 1;
            }
            if tag_end > tag_start && tag_end < chars.len() && chars[tag_end] == '$' {
                let tag: String = chars[tag_start..tag_end].iter().collect();
                out.push_str("$[REDACTED]$");
                i = tag_end + 1;
                let closing: Vec<char> = format!("${}$", tag).chars().collect();
                while i + closing.len() <= chars.len() {
                    if chars[i..i + closing.len()] == closing[..] {
                        i += closing.len();
                        break;
                    }
                    i += 1;
                }
                continue;
            }
            out.push(ch);
            i += 1;
            continue;
        }
        if ch == '-' && next == Some('-') {
            out.push_str("--[REDACTED_COMMENT]");
            i += 2;
            while i < chars.len() && chars[i] != '\n' && chars[i] != '\r' {
                i += 1;
            }
            continue;
        }
        if ch == '/' && next == Some('*') {
            out.push_str("/*[REDACTED_COMMENT]*/");
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            if i + 1 < chars.len() {
                i += 2;
            }
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

fn redact_sensitive_assignments(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len()
            && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '-' || chars[i] == '.')
        {
            i += 1;
        }
        if i == start {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let key: String = chars[start..i].iter().collect();
        let mut j = i;
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        if j < chars.len() && (chars[j] == '=' || chars[j] == ':') && is_sensitive_key(&key) {
            out.push_str(&key);
            out.extend(chars[i..j].iter().copied());
            out.push(chars[j]);
            j += 1;
            while j < chars.len() && chars[j].is_whitespace() {
                out.push(chars[j]);
                j += 1;
            }
            while j < chars.len() && !chars[j].is_whitespace() {
                j += 1;
            }
            out.push_str("[REDACTED]");
            i = j;
            continue;
        }
        out.push_str(&key);
    }
    out
}

pub fn redact_sql_for_diagnostics(sql: &str) -> String {
    let max_chars = DEFAULT_SQL_DIAGNOSTIC_MAX_CHARS;
    let (bounded_sql, input_truncated) = bounded_input(sql, max_chars);
    truncate_for_diagnostics(redact_sensitive_assignments(&redact_literals(bounded_sql)), max_chars, input_truncated)
}

pub fn debug_sql(scope: &str, sql: &str) {
    log::debug!("[{scope}] sql={}", redact_sql_for_diagnostics(sql));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_sensitive_literals_and_bounds_large_sql() {
        let sql = format!(
            "select * from users where password = 'secret-123' and api_key=abc and name = 'alice' {};",
            "x".repeat(900)
        );
        let redacted = redact_sql_for_diagnostics(&sql);
        assert!(!redacted.contains("secret-123"));
        assert!(!redacted.contains("api_key=abc"));
        assert!(!redacted.contains("alice"));
        // Literals not part of sensitive assignments retain single-quote redaction
        assert!(redacted.contains("'[REDACTED]'"), "name literal should be redacted: {}", redacted);
        // Sensitive assignment values are redacted with bracket notation
        assert!(redacted.contains("password = [REDACTED]"));
        assert!(redacted.contains("api_key=[REDACTED]"));
        assert!(redacted.contains("truncated"));
        assert!(redacted.len() < sql.len());
    }

    #[test]
    fn redacts_space_separated_sensitive_assignments() {
        let sql = "select * from users where password = hunter2";
        let redacted = redact_sensitive_assignments(sql);
        assert!(!redacted.contains("hunter2"));
        assert!(redacted.contains("password = [REDACTED]"));
        assert!(redacted.contains("select"));
    }

    #[test]
    fn redacts_dollar_quoted_strings() {
        let sql = "select $$secret$$, $tag$hello$tag$ from t";
        let redacted = redact_sql_for_diagnostics(sql);
        assert!(redacted.contains("$$[REDACTED]$$"));
        assert!(redacted.contains("$[REDACTED]$"));
        assert!(!redacted.contains("secret"));
        assert!(!redacted.contains("hello"));
    }

    #[test]
    fn large_input_bounded_allocation() {
        let sql = "x".repeat(1_000_000);
        let redacted = redact_sql_for_diagnostics(&sql);
        assert!(redacted.len() <= 550);
    }

    #[test]
    fn truncation_inside_unclosed_literal_does_not_leak_prefix() {
        let sql = format!("select '{}'", "secret-".repeat(1_000));
        let redacted = truncate_for_diagnostics(redact_literals(bounded_input(&sql, 32).0), 32, true);
        assert!(!redacted.contains("secret-"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.contains("truncated"));
    }

    #[test]
    fn truncation_inside_sensitive_assignment_does_not_leak_prefix() {
        let sql = format!("password = {}", "secret-token".repeat(1_000));
        let (bounded, truncated) = bounded_input(&sql, 24);
        let redacted = truncate_for_diagnostics(redact_sensitive_assignments(&redact_literals(bounded)), 24, truncated);
        assert!(!redacted.contains("secret-token"));
        assert!(redacted.contains("password = [REDACTED]"));
        assert!(redacted.contains("truncated"));
    }
}
