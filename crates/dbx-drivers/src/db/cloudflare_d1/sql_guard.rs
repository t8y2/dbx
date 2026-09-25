use super::sql_lexer::{complete_sql_statements, lex_sql, SqlLexeme};

const SUPPORTED_PRAGMAS: &[&str] = &[
    "case_sensitive_like",
    "defer_foreign_keys",
    "foreign_key_check",
    "foreign_key_list",
    "foreign_keys",
    "ignore_check_constraints",
    "index_info",
    "index_list",
    "index_xinfo",
    "legacy_alter_table",
    "optimize",
    "quick_check",
    "recursive_triggers",
    "reverse_unordered_selects",
    "table_info",
    "table_list",
    "table_xinfo",
];

pub(super) fn validate_sql(sql: &str) -> Result<(), String> {
    for statement in complete_sql_statements(sql) {
        validate_statement(statement)?;
    }
    Ok(())
}

fn validate_statement(statement: &str) -> Result<(), String> {
    let lexemes = lex_sql(statement);
    let words = lexemes
        .iter()
        .filter_map(|lexeme| match lexeme {
            SqlLexeme::Word(word) => Some(*word),
            SqlLexeme::Number(_) | SqlLexeme::Symbol(_) | SqlLexeme::Semicolon(_) => None,
        })
        .collect::<Vec<_>>();
    let Some(first) = words.first() else {
        return Ok(());
    };

    if ["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "START"]
        .iter()
        .any(|keyword| first.eq_ignore_ascii_case(keyword))
    {
        return Err(
            "Cloudflare D1 does not support explicit transaction or savepoint statements. Submit the SQL statements together without BEGIN, COMMIT, ROLLBACK, SAVEPOINT, or RELEASE."
                .to_string(),
        );
    }

    if first.eq_ignore_ascii_case("ATTACH") || first.eq_ignore_ascii_case("DETACH") {
        return Err(
            "Cloudflare D1 does not support ATTACH or DETACH. Each connection targets one provider-managed D1 database."
                .to_string(),
        );
    }

    if first.eq_ignore_ascii_case("CREATE") {
        validate_create_statement(&words)?;
    }

    if first.eq_ignore_ascii_case("PRAGMA") {
        validate_pragma(&words, &lexemes)?;
    }

    Ok(())
}

fn validate_create_statement(words: &[&str]) -> Result<(), String> {
    if words.get(1).is_some_and(|word| word.eq_ignore_ascii_case("TEMP") || word.eq_ignore_ascii_case("TEMPORARY")) {
        return Err(
            "Cloudflare D1 does not support temporary tables, indexes, views, or triggers. Create a persistent object instead."
                .to_string(),
        );
    }

    let creates_virtual_table = words
        .get(1..3)
        .is_some_and(|prefix| prefix[0].eq_ignore_ascii_case("VIRTUAL") && prefix[1].eq_ignore_ascii_case("TABLE"));
    if !creates_virtual_table {
        return Ok(());
    }

    let module =
        words.iter().position(|word| word.eq_ignore_ascii_case("USING")).and_then(|index| words.get(index + 1));
    if module.is_some_and(|module| module.eq_ignore_ascii_case("fts5") || module.eq_ignore_ascii_case("fts5vocab")) {
        return Ok(());
    }

    Err("Cloudflare D1 only supports FTS5 and fts5vocab virtual table modules.".to_string())
}

fn validate_pragma(words: &[&str], lexemes: &[SqlLexeme<'_>]) -> Result<(), String> {
    let mut pragma = words.get(1).copied();
    if pragma.is_some_and(|word| word.eq_ignore_ascii_case("main") || word.eq_ignore_ascii_case("temp")) {
        pragma = words.get(2).copied();
    }
    let Some(pragma) = pragma else {
        return Err("Cloudflare D1 requires a supported PRAGMA name.".to_string());
    };

    if !SUPPORTED_PRAGMAS.iter().any(|supported| pragma.eq_ignore_ascii_case(supported)) {
        return Err(format!(
            "Cloudflare D1 does not support PRAGMA {pragma}. Use one of the documented D1-compatible PRAGMA statements."
        ));
    }

    if pragma.eq_ignore_ascii_case("optimize") && contains_negative_one(lexemes) {
        return Err("Cloudflare D1 does not support PRAGMA optimize(-1); use PRAGMA optimize instead.".to_string());
    }

    Ok(())
}

fn contains_negative_one(lexemes: &[SqlLexeme<'_>]) -> bool {
    lexemes
        .windows(2)
        .any(|pair| matches!(pair[0], SqlLexeme::Symbol(b'-')) && matches!(pair[1], SqlLexeme::Number("1")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_d1_sql_features() {
        assert!(validate_sql(
            "CREATE TRIGGER audit AFTER INSERT ON users BEGIN INSERT INTO logs VALUES (NEW.id); END;"
        )
        .is_ok());
        assert!(
            validate_sql("CREATE VIRTUAL TABLE docs USING fts5(title, body); SELECT json_extract('{}', '$');").is_ok()
        );
        assert!(validate_sql("PRAGMA table_info(users); PRAGMA optimize;").is_ok());
    }

    #[test]
    fn rejects_explicit_transaction_control() {
        for sql in [
            "BEGIN; INSERT INTO users VALUES (1); COMMIT;",
            "SAVEPOINT before_update",
            "ROLLBACK TO before_update",
            "RELEASE before_update",
        ] {
            let error = validate_sql(sql).unwrap_err();
            assert!(error.contains("does not support explicit transaction"));
        }
    }

    #[test]
    fn rejects_attached_temporary_and_unknown_virtual_databases() {
        assert!(validate_sql("ATTACH DATABASE 'other.db' AS other").unwrap_err().contains("ATTACH"));
        assert!(validate_sql("CREATE TEMP TABLE scratch(id INTEGER)").unwrap_err().contains("temporary"));
        assert!(validate_sql("CREATE VIRTUAL TABLE places USING rtree(id, min_x, max_x)")
            .unwrap_err()
            .contains("only supports FTS5"));
    }

    #[test]
    fn rejects_unsupported_pragma_forms() {
        assert!(validate_sql("PRAGMA journal_mode=WAL").unwrap_err().contains("PRAGMA journal_mode"));
        assert!(validate_sql("PRAGMA data_version").unwrap_err().contains("PRAGMA data_version"));
        assert!(validate_sql("PRAGMA optimize(-1)").unwrap_err().contains("optimize(-1)"));
        assert!(validate_sql("PRAGMA optimize /* -1 is only a comment */").is_ok());
    }
}
