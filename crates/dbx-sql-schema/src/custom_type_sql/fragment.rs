//! Validation for SQL *fragments* that the planner embeds into generated DDL.
//!
//! Some parts of a type definition are not identifiers and cannot be quoted as
//! literals: a domain's base type, a default value, a CHECK body, an attribute's
//! data type, a range's opclass/function. They have to be spliced into the
//! statement text as-is.
//!
//! That makes them a trust boundary. A fragment containing a statement
//! terminator produces a statement that the executor's splitter turns into
//! *several* statements, which would let a caller smuggle arbitrary SQL past the
//! planner and past its statement-count and transaction-policy decisions. This
//! module is the gate that keeps every fragment a single, expression-shaped
//! token sequence.
//!
//! Deliberately conservative: rather than trying to understand every PostgreSQL
//! construct, it rejects anything whose meaning it cannot prove to be local —
//! comments, dollar quoting, embedded terminators.

use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::Token;

/// What a fragment is allowed to look like.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FragmentKind {
    /// A type expression: `text`, `numeric(18, 4)`, `"app"."address"[]`.
    TypeExpression,
    /// A value expression used as a default: `''::text`, `now()`, `0`.
    ValueExpression,
    /// A boolean expression used as a constraint body: `VALUE <> ''::text`.
    Expression,
    /// A possibly-schema-qualified object name: `pg_catalog.numeric_ops`.
    QualifiedName,
}

impl FragmentKind {
    fn label(self) -> &'static str {
        match self {
            Self::TypeExpression => "type expression",
            Self::ValueExpression => "value expression",
            Self::Expression => "expression",
            Self::QualifiedName => "qualified name",
        }
    }
}

/// Reject a fragment that is not a single, self-contained SQL fragment.
///
/// `field` is the user-facing name used in the error message so the UI can point
/// at the offending input.
pub fn validate_fragment(kind: FragmentKind, field: &str, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} is empty."));
    }
    scan(trimmed).map_err(|reason| format!("{field} is not a usable {}: {reason}", kind.label()))?;
    if kind == FragmentKind::QualifiedName {
        validate_qualified_name(field, trimmed)?;
    } else if matches!(kind, FragmentKind::TypeExpression | FragmentKind::ValueExpression) {
        // Balanced tokens alone still permit `text, DROP ATTRIBUTE secret`.
        // Parse the expected grammar and require EOF so an extra ALTER action,
        // column option or range option cannot escape this field's boundary.
        let dialect = PostgreSqlDialect {};
        let parse = || -> Result<(), String> {
            let mut parser = Parser::new(&dialect).try_with_sql(trimmed).map_err(|error| error.to_string())?;
            if kind == FragmentKind::TypeExpression {
                parser.parse_data_type().map_err(|error| error.to_string())?;
            } else {
                parser.parse_expr().map_err(|error| error.to_string())?;
            }
            if parser.peek_token().token != Token::EOF {
                return Err("unexpected SQL after the expression".to_string());
            }
            Ok(())
        };
        parse().map_err(|reason| format!("{field} is not a usable {}: {reason}", kind.label()))?;
    }
    Ok(())
}

/// Reject a fragment that is not a plain identifier (no qualification allowed).
pub fn validate_identifier_fragment(field: &str, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} is empty."));
    }
    scan(trimmed).map_err(|reason| format!("{field} is not a usable identifier: {reason}"))?;
    // A single identifier: `a.b` is a path, which this field does not accept.
    if split_qualified_name(trimmed).len() != 1 || !is_identifier(trimmed) {
        return Err(format!("{field} must be a single identifier."));
    }
    Ok(())
}

/// Structural scan: balanced quoting/parentheses, no comments, no statement
/// terminator, no dollar quoting.
fn scan(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let mut index = 0usize;
    let mut depth = 0i32;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' => {
                index = skip_quoted(bytes, index)?;
            }
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                // A line comment would comment out the remainder of the
                // generated statement, including its terminator.
                return Err("SQL comments are not allowed here".to_string());
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                return Err("SQL comments are not allowed here".to_string());
            }
            b'$' => {
                // Dollar quoting could hide a terminator from this scan, so it
                // is refused rather than parsed. Standard single-quoted literals
                // cover the realistic cases.
                return Err("dollar-quoted strings are not allowed here; use a single-quoted literal".to_string());
            }
            b'(' | b'[' => {
                depth += 1;
                index += 1;
            }
            b')' | b']' => {
                depth -= 1;
                if depth < 0 {
                    return Err("unbalanced parentheses".to_string());
                }
                index += 1;
            }
            b';' => {
                return Err("a statement terminator (;) is not allowed here".to_string());
            }
            _ => index += 1,
        }
    }
    if depth != 0 {
        return Err("unbalanced parentheses".to_string());
    }
    Ok(())
}

/// Index just past the quoted run starting at `start`.
///
/// Doubled quotes escape both literals and identifiers. An explicit PostgreSQL
/// E/e string also consumes the character after each backslash. Check the token
/// boundary so an identifier ending in `e` does not enable string escapes.
/// Shared with CHECK normalization so validation, comparison and emission agree.
pub(super) fn skip_quoted(bytes: &[u8], start: usize) -> Result<usize, String> {
    let quote = bytes[start];
    let escape_string = quote == b'\''
        && start > 0
        && matches!(bytes[start - 1], b'E' | b'e')
        && (start == 1 || !is_identifier_continuation(bytes[start - 2]));
    let mut index = start + 1;
    while index < bytes.len() {
        if escape_string && bytes[index] == b'\\' {
            index += 2;
            continue;
        }
        if bytes[index] == quote {
            if bytes.get(index + 1) == Some(&quote) {
                index += 2;
                continue;
            }
            return Ok(index + 1);
        }
        index += 1;
    }
    Err(if quote == b'\'' {
        "unterminated string literal".to_string()
    } else {
        "unterminated quoted identifier".to_string()
    })
}

fn is_identifier_continuation(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$') || !byte.is_ascii()
}

/// One identifier or one dotted path of identifiers.
fn is_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0usize;
    let mut expect_separator = false;
    while index < bytes.len() {
        // An identifier cannot be followed by a second identifier/keyword
        // without a dot (e.g. `"C"DEFAULT`).
        if expect_separator && bytes[index] != b'.' {
            return false;
        }
        match bytes[index] {
            b'"' => {
                let Ok(next) = skip_quoted(bytes, index) else {
                    return false;
                };
                // An empty quoted identifier (`""`) is not a name PostgreSQL can
                // use, and accepting it would let `""."x"` masquerade as a path.
                if next == index + 2 {
                    return false;
                }
                index = next;
                expect_separator = true;
            }
            byte if byte.is_ascii_alphabetic() || byte == b'_' => {
                index += 1;
                while index < bytes.len() {
                    let byte = bytes[index];
                    if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' {
                        index += 1;
                    } else {
                        break;
                    }
                }
                expect_separator = true;
            }
            b'.' if expect_separator => {
                index += 1;
                expect_separator = false;
            }
            _ => return false,
        }
    }
    expect_separator
}

fn validate_qualified_name(field: &str, value: &str) -> Result<(), String> {
    for part in split_qualified_name(value) {
        if !is_identifier(part.trim()) {
            return Err(format!("{field} must be an object name, optionally schema-qualified."));
        }
    }
    Ok(())
}

/// Split on dots that are not inside a quoted identifier.
pub(super) fn split_qualified_name(value: &str) -> Vec<&str> {
    let bytes = value.as_bytes();
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                if let Ok(next) = skip_quoted(bytes, index) {
                    index = next;
                    continue;
                }
                index += 1;
            }
            b'.' => {
                parts.push(&value[start..index]);
                index += 1;
                start = index;
            }
            _ => index += 1,
        }
    }
    parts.push(&value[start..]);
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(kind: FragmentKind, value: &str) {
        assert_eq!(validate_fragment(kind, "field", value), Ok(()), "{value}");
    }

    fn rejected(value: &str) -> String {
        validate_fragment(FragmentKind::ValueExpression, "field", value).expect_err("should be rejected")
    }

    #[test]
    fn accepts_realistic_type_and_value_expressions() {
        ok(FragmentKind::TypeExpression, "text");
        ok(FragmentKind::TypeExpression, "numeric(18, 4)");
        ok(FragmentKind::TypeExpression, "\"app\".\"address\"[]");
        ok(FragmentKind::TypeExpression, "character varying(12)");
        ok(FragmentKind::ValueExpression, "''::text");
        ok(FragmentKind::ValueExpression, "now()");
        ok(FragmentKind::ValueExpression, "0");
        ok(FragmentKind::Expression, "VALUE <> ''::text");
        ok(FragmentKind::Expression, "VALUE ~ '.+@.+'");
        ok(FragmentKind::Expression, "VALUE ~ 'a;b'");
        ok(FragmentKind::Expression, "VALUE = 'it''s'");
        ok(FragmentKind::QualifiedName, "numeric_ops");
        ok(FragmentKind::QualifiedName, "pg_catalog.numeric_ops");
        ok(FragmentKind::QualifiedName, "\"app\".\"my func\"");
    }

    #[test]
    fn rejects_a_statement_terminator_that_would_split_into_a_second_statement() {
        let message = rejected("0; DROP TABLE app.orders; --");
        assert!(message.contains("statement terminator"), "{message}");
    }

    #[test]
    fn rejects_terminators_even_when_they_only_end_the_statement() {
        assert!(rejected("0;").contains("statement terminator"));
    }

    #[test]
    fn allows_a_terminator_inside_a_string_literal() {
        ok(FragmentKind::ValueExpression, "'a;b'");
        ok(FragmentKind::Expression, "VALUE <> 'a;b'");
    }

    #[test]
    fn accepts_escape_strings_without_exposing_their_contents_as_sql() {
        for literal in [r"E'it\'s'", r"e'it\'s; -- (a)  /* b */'", r"E'ends\\'", r"E'it''s\\fine'"] {
            ok(FragmentKind::ValueExpression, literal);
            ok(FragmentKind::Expression, &format!("VALUE <> {literal}"));
        }
        // Backslashes remain ordinary characters in standard strings and names.
        ok(FragmentKind::ValueExpression, r"'ends\'");
        ok(FragmentKind::QualifiedName, r#""e\name""#);
    }

    #[test]
    fn escape_strings_still_reject_unterminated_literals_and_extra_sql() {
        for value in [r"E'it\'s'; SELECT 1", r"E'ends\\'; SELECT 1"] {
            assert!(rejected(value).contains("statement terminator"), "{value}");
        }
        assert!(rejected(r"E'it\'s' --").contains("comments"));
        assert!(rejected(r"E'it\'s' /* hidden */").contains("comments"));
        assert!(rejected(r"E'ends\'").contains("unterminated"));
        assert!(rejected(r"'it\'s'").contains("unterminated"));
        // An e at the end of an identifier is not an escape-string prefix.
        assert!(rejected(r"name'it\'s'").contains("unterminated"));
    }

    #[test]
    fn rejects_comments_that_could_hide_the_generated_terminator() {
        assert!(rejected("0 --").contains("comments"));
        assert!(rejected("0 /* x */").contains("comments"));
        // A comment marker inside a literal is data, not a comment.
        ok(FragmentKind::ValueExpression, "'a--b'");
    }

    #[test]
    fn rejects_dollar_quoting_instead_of_guessing_at_it() {
        let message = rejected("$$;DROP TABLE t;$$");
        assert!(message.contains("dollar-quoted"), "{message}");
    }

    #[test]
    fn rejects_unbalanced_constructs() {
        assert!(rejected("f(").contains("unbalanced"));
        assert!(rejected("f)").contains("unbalanced"));
        assert!(rejected("'unterminated").contains("unterminated"));
        assert!(rejected("\"unterminated").contains("unterminated"));
    }

    #[test]
    fn rejects_an_empty_fragment() {
        assert!(validate_fragment(FragmentKind::TypeExpression, "field", "   ").is_err());
    }

    #[test]
    fn qualified_name_rejects_anything_that_is_not_a_name() {
        for value in ["numeric_ops; DROP TABLE t", "now()", "1 + 1", "\"\"", "a..b", "a.", ".a", "'x'"] {
            assert!(
                validate_fragment(FragmentKind::QualifiedName, "field", value).is_err(),
                "{value} should be rejected as a qualified name"
            );
        }
    }

    #[test]
    fn identifier_fragment_rejects_qualification_and_expressions() {
        assert!(validate_identifier_fragment("field", "email_valid").is_ok());
        assert!(validate_identifier_fragment("field", "\"My Constraint\"").is_ok());
        assert!(validate_identifier_fragment("field", "a.b").is_err());
        assert!(validate_identifier_fragment("field", "x y").is_err());
        assert!(validate_identifier_fragment("field", "a;b").is_err());
    }
}
