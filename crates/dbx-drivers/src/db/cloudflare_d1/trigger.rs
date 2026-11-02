use super::sql_lexer::{lex_sql, SqlLexeme};

pub(super) struct TriggerMetadata {
    pub timing: &'static str,
    pub event: &'static str,
}

pub(super) fn metadata_from_sql(sql: &str) -> TriggerMetadata {
    let words = lex_sql(sql)
        .into_iter()
        .filter_map(|lexeme| match lexeme {
            SqlLexeme::Word(word) => Some(word),
            SqlLexeme::Number(_) | SqlLexeme::Symbol(_) | SqlLexeme::Semicolon(_) => None,
        })
        .collect::<Vec<_>>();
    let declaration_start =
        words.iter().position(|word| word.eq_ignore_ascii_case("TRIGGER")).map_or(0, |index| index + 1);
    let declaration_end = words[declaration_start..]
        .iter()
        .position(|word| word.eq_ignore_ascii_case("ON") || word.eq_ignore_ascii_case("BEGIN"))
        .map_or(words.len(), |index| declaration_start + index);
    let declaration = &words[declaration_start..declaration_end];

    let timing = if declaration
        .windows(2)
        .any(|words| words[0].eq_ignore_ascii_case("INSTEAD") && words[1].eq_ignore_ascii_case("OF"))
    {
        "INSTEAD OF"
    } else if declaration.iter().any(|word| word.eq_ignore_ascii_case("AFTER")) {
        "AFTER"
    } else {
        // SQLite defaults to BEFORE when no timing keyword is present.
        "BEFORE"
    };
    let event = declaration
        .iter()
        .find_map(|word| ["DELETE", "INSERT", "UPDATE"].into_iter().find(|event| word.eq_ignore_ascii_case(event)))
        .unwrap_or("UNKNOWN");

    TriggerMetadata { timing, event }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_event_from_declaration_not_trigger_body() {
        let metadata = metadata_from_sql(
            "CREATE TRIGGER audit AFTER UPDATE ON users BEGIN INSERT INTO audit_log VALUES (NEW.id); END",
        );

        assert_eq!(metadata.timing, "AFTER");
        assert_eq!(metadata.event, "UPDATE");
    }

    #[test]
    fn supports_default_and_instead_of_timing() {
        let default_timing = metadata_from_sql(
            "CREATE TRIGGER update_customer UPDATE OF name ON customers BEGIN DELETE FROM cache; END",
        );
        let instead_of = metadata_from_sql(
            "CREATE TRIGGER [insert] INSTEAD OF INSERT ON customer_view BEGIN UPDATE customers SET name = NEW.name; END",
        );

        assert_eq!(default_timing.timing, "BEFORE");
        assert_eq!(default_timing.event, "UPDATE");
        assert_eq!(instead_of.timing, "INSTEAD OF");
        assert_eq!(instead_of.event, "INSERT");
    }
}
