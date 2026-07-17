#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SqlLexeme<'a> {
    Word(&'a str),
    Number(&'a str),
    Symbol(u8),
    Semicolon(usize),
}

pub(super) fn lex_sql(sql: &str) -> Vec<SqlLexeme<'_>> {
    let bytes = sql.as_bytes();
    let mut lexemes = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
            }
            quote @ (b'\'' | b'"' | b'`') => {
                index += 1;
                while index < bytes.len() {
                    if bytes[index] != quote {
                        index += 1;
                        continue;
                    }
                    if bytes.get(index + 1) == Some(&quote) {
                        index += 2;
                    } else {
                        index += 1;
                        break;
                    }
                }
            }
            b'[' => {
                index += 1;
                while index < bytes.len() {
                    if bytes[index] != b']' {
                        index += 1;
                        continue;
                    }
                    if bytes.get(index + 1) == Some(&b']') {
                        index += 2;
                    } else {
                        index += 1;
                        break;
                    }
                }
            }
            b';' => {
                lexemes.push(SqlLexeme::Semicolon(index));
                index += 1;
            }
            byte if byte.is_ascii_digit() => {
                let start = index;
                index += 1;
                while index < bytes.len() && bytes[index].is_ascii_digit() {
                    index += 1;
                }
                lexemes.push(SqlLexeme::Number(&sql[start..index]));
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'_' | b'$'))
                {
                    index += 1;
                }
                lexemes.push(SqlLexeme::Word(&sql[start..index]));
            }
            byte if matches!(byte, b'(' | b')' | b'=' | b'.' | b',' | b'-' | b'+') => {
                lexemes.push(SqlLexeme::Symbol(byte));
                index += 1;
            }
            _ => index += 1,
        }
    }

    lexemes
}

pub(super) fn complete_sql_statements(sql: &str) -> Vec<&str> {
    let mut statements = Vec::new();
    let mut statement_start = 0;
    let mut prefix = Vec::with_capacity(3);
    let mut is_trigger = false;
    let mut trigger_body_started = false;
    let mut trigger_depth = 0_usize;

    for lexeme in lex_sql(sql) {
        match lexeme {
            SqlLexeme::Word(word) => {
                if prefix.len() < 3 {
                    prefix.push(word);
                    is_trigger = is_create_trigger_prefix(&prefix);
                }

                if !is_trigger {
                    continue;
                }
                if !trigger_body_started && word.eq_ignore_ascii_case("BEGIN") {
                    trigger_body_started = true;
                    trigger_depth = 1;
                } else if trigger_body_started
                    && (word.eq_ignore_ascii_case("BEGIN") || word.eq_ignore_ascii_case("CASE"))
                {
                    trigger_depth += 1;
                } else if trigger_body_started && word.eq_ignore_ascii_case("END") {
                    trigger_depth = trigger_depth.saturating_sub(1);
                }
            }
            SqlLexeme::Semicolon(position) => {
                if is_trigger && trigger_body_started && trigger_depth > 0 {
                    continue;
                }
                push_statement(sql, statement_start, position, &mut statements);
                statement_start = position + 1;
                prefix.clear();
                is_trigger = false;
                trigger_body_started = false;
                trigger_depth = 0;
            }
            SqlLexeme::Number(_) | SqlLexeme::Symbol(_) => {}
        }
    }

    push_statement(sql, statement_start, sql.len(), &mut statements);
    statements
}

fn is_create_trigger_prefix(words: &[&str]) -> bool {
    words.first().is_some_and(|word| word.eq_ignore_ascii_case("CREATE"))
        && (words.get(1).is_some_and(|word| word.eq_ignore_ascii_case("TRIGGER"))
            || (words
                .get(1)
                .is_some_and(|word| word.eq_ignore_ascii_case("TEMP") || word.eq_ignore_ascii_case("TEMPORARY"))
                && words.get(2).is_some_and(|word| word.eq_ignore_ascii_case("TRIGGER"))))
}

fn push_statement<'a>(sql: &'a str, start: usize, end: usize, statements: &mut Vec<&'a str>) {
    let statement = sql[start..end].trim();
    if !statement.is_empty() {
        statements.push(statement);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_trigger_body_semicolons_in_one_statement() {
        let sql = "CREATE TRIGGER audit AFTER UPDATE ON users BEGIN INSERT INTO logs VALUES ('a;b'); UPDATE stats SET value = CASE WHEN value > 0 THEN value ELSE 0 END; END; SELECT 1;";
        let statements = complete_sql_statements(sql);

        assert_eq!(statements.len(), 2);
        assert!(statements[0].starts_with("CREATE TRIGGER"));
        assert!(statements[0].ends_with("END"));
        assert_eq!(statements[1], "SELECT 1");
    }

    #[test]
    fn ignores_trigger_words_in_comments_and_strings() {
        let sql = "SELECT 'CREATE TRIGGER fake; BEGIN END'; -- CREATE TRIGGER ignored\nSELECT 2;";
        assert_eq!(
            complete_sql_statements(sql),
            ["SELECT 'CREATE TRIGGER fake; BEGIN END'", "-- CREATE TRIGGER ignored\nSELECT 2"]
        );
    }
}
