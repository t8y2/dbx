/// Adds PostgreSQL operator-class and ordering suffixes to an already-rendered index key.
///
/// `rendered_key` must already contain the caller's identifier quoting or expression rendering.
/// `key_options` uses PostgreSQL `pg_index.indoption` bits: bit 0 selects DESC instead of ASC,
/// and bit 1 selects NULLS FIRST instead of NULLS LAST. When ordering options are present, both
/// clauses are emitted explicitly to preserve the existing transfer and schema-sync SQL.
pub fn decorate_postgres_index_key(rendered_key: &str, opclass: Option<&str>, key_options: Option<i16>) -> String {
    let with_opclass = match opclass.filter(|opclass| !opclass.is_empty()) {
        Some(opclass) => format!("{rendered_key} {opclass}"),
        None => rendered_key.to_string(),
    };

    match key_options {
        Some(options) => format!(
            "{with_opclass} {} NULLS {}",
            if options & 1 != 0 { "DESC" } else { "ASC" },
            if options & 2 != 0 { "FIRST" } else { "LAST" }
        ),
        None => with_opclass,
    }
}

#[cfg(test)]
mod tests {
    use super::decorate_postgres_index_key;

    #[test]
    fn leaves_plain_rendered_key_unchanged() {
        assert_eq!(decorate_postgres_index_key("\"name\"", None, None), "\"name\"");
    }

    #[test]
    fn appends_nonempty_opclass() {
        assert_eq!(
            decorate_postgres_index_key("\"name\"", Some("text_pattern_ops"), None),
            "\"name\" text_pattern_ops"
        );
        assert_eq!(decorate_postgres_index_key("\"name\"", Some(""), None), "\"name\"");
    }

    #[test]
    fn renders_ascending_and_descending_order_with_null_order() {
        assert_eq!(decorate_postgres_index_key("\"name\"", None, Some(0)), "\"name\" ASC NULLS LAST");
        assert_eq!(decorate_postgres_index_key("\"name\"", None, Some(1)), "\"name\" DESC NULLS LAST");
        assert_eq!(decorate_postgres_index_key("\"name\"", None, Some(2)), "\"name\" ASC NULLS FIRST");
        assert_eq!(decorate_postgres_index_key("\"name\"", None, Some(3)), "\"name\" DESC NULLS FIRST");
    }

    #[test]
    fn decorates_an_already_rendered_expression() {
        assert_eq!(
            decorate_postgres_index_key("lower(\"email\")", Some("text_pattern_ops"), Some(1)),
            "lower(\"email\") text_pattern_ops DESC NULLS LAST"
        );
    }
}
