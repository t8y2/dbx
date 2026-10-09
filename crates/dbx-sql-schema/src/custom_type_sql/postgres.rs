//! PostgreSQL-family statement emission for custom type management.
//!
//! Everything here is pure string construction. Statement *ordering* and
//! change detection live in the parent module; this file only knows how to
//! spell one statement correctly, so quoting has exactly one implementation.

use super::fragment::skip_quoted;
use crate::types::{CustomTypeDomainConstraintDraft, CustomTypeKind};

/// Quote a SQL identifier: double quotes with `"` doubled.
///
/// Every object name (type, domain, schema, owner role, attribute, constraint)
/// goes through this. Type expressions, default expressions and CHECK bodies
/// are SQL fragments and must never be passed here.
pub fn quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Quote a string literal independently of `standard_conforming_strings`.
/// Backslashes require an explicit escape string with each backslash doubled.
pub fn quote_literal(value: &str) -> String {
    let escaped = value.replace('\'', "''");
    if value.contains('\\') {
        format!("E'{}'", escaped.replace('\\', "\\\\"))
    } else {
        format!("'{escaped}'")
    }
}

/// `"schema"."name"`.
pub fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(name))
}

/// `TYPE` or `DOMAIN` — the keyword pair PostgreSQL uses for `ALTER`,
/// `COMMENT ON` and `DROP` on this object kind. Domains are *not* types for
/// any of these statements, so every one of them must go through here.
pub fn object_keyword(kind: CustomTypeKind) -> &'static str {
    match kind {
        CustomTypeKind::Domain => "DOMAIN",
        _ => "TYPE",
    }
}

/// Canonical form of a CHECK expression, for **comparison only**.
///
/// The catalog renders `CHECK ((VALUE <> ''::text))` while a user types
/// `VALUE <> ''`. Stripping the leading keyword, one fully wrapping parenthesis
/// layer and whitespace runs makes those compare equal.
///
/// This must never be executed or emitted: whitespace inside a string literal is
/// significant (`'a  b'` is not `'a b'`), so the canonical form is only ever
/// compared against another canonical form. Emission uses the draft's own text.
pub fn canonical_check_expression(value: &str) -> String {
    canonical_whitespace(check_body(value))
}

/// The expression inside `CHECK (...)`, ready to be re-wrapped for emission.
///
/// Accepts what a user may plausibly type — `VALUE <> ''`, `(VALUE <> '')`, or
/// `CHECK (VALUE <> '')` — and removes only the redundant keyword and one
/// wrapping parenthesis layer. Unlike [`canonical_check_expression`] it never
/// rewrites anything *inside* the expression, because this text is what the
/// server stores and evaluates: whitespace within a string literal is part of
/// the constraint's meaning.
pub fn check_body(value: &str) -> &str {
    let trimmed = value.trim();
    let without_keyword = match strip_leading_keyword(trimmed, "CHECK") {
        Some(rest) => {
            // pg_get_constraintdef appends NOT VALID outside CHECK's closing
            // parenthesis. Remove only that suffix, never text in the expression.
            if let Some((before_valid, valid)) = rest.rsplit_once(char::is_whitespace) {
                if valid.eq_ignore_ascii_case("VALID") {
                    if let Some((body, not)) = before_valid.trim_end().rsplit_once(char::is_whitespace) {
                        let body = body.trim_end();
                        if not.eq_ignore_ascii_case("NOT") && strip_wrapping_parens(body) != body {
                            return strip_wrapping_parens(body);
                        }
                    }
                }
            }
            rest
        }
        None => trimmed,
    };
    strip_wrapping_parens(without_keyword)
}

/// Canonical form of a SQL expression, for **comparison only**. See
/// [`canonical_check_expression`].
pub fn canonical_expression(value: &str) -> String {
    canonical_whitespace(value.trim())
}

/// Collapse whitespace runs outside quoted runs.
///
/// Quote-aware on purpose: `'a  b'` and `'a b'` are different values, and
/// collapsing inside the literal would both hide a real user edit and make two
/// distinct expressions compare equal.
fn canonical_whitespace(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut index = 0usize;
    let mut pending_space = false;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' => {
                if pending_space && !out.is_empty() {
                    out.push(' ');
                    pending_space = false;
                }
                let end = skip_quoted(bytes, index).unwrap_or(bytes.len());
                out.push_str(&value[index..end]);
                index = end;
            }
            byte if byte.is_ascii_whitespace() => {
                pending_space = true;
                index += 1;
            }
            _ => {
                if pending_space && !out.is_empty() {
                    out.push(' ');
                }
                pending_space = false;
                let start = index;
                while index < bytes.len()
                    && !bytes[index].is_ascii_whitespace()
                    && bytes[index] != b'\''
                    && bytes[index] != b'"'
                {
                    index += 1;
                }
                out.push_str(&value[start..index]);
            }
        }
    }
    out
}

/// Drop one layer of parentheses when it wraps the whole expression.
///
/// The scan is quote-aware: parentheses inside string literals (`'a)'`) and
/// quoted identifiers (`"a)b"`) do not count toward the depth. Dollar-quoted
/// strings are not handled — they do not appear in domain CHECK expressions,
/// and mis-counting one would only cost an unnecessary constraint rewrite.
fn strip_wrapping_parens(value: &str) -> &str {
    let trimmed = value.trim();
    if !trimmed.starts_with('(') || !trimmed.ends_with(')') {
        return trimmed;
    }
    let bytes = trimmed.as_bytes();
    let mut depth = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' => index = skip_quoted(bytes, index).unwrap_or(bytes.len()),
            b'(' => {
                depth += 1;
                index += 1;
            }
            b')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    // Only strip when this closing paren is also the last byte.
                    return if index + 1 == bytes.len() { trimmed[1..trimmed.len() - 1].trim() } else { trimmed };
                }
                index += 1;
            }
            _ => index += 1,
        }
    }
    trimmed
}

/// Remove a leading SQL keyword when it stands alone as a word.
fn strip_leading_keyword<'a>(value: &'a str, keyword: &str) -> Option<&'a str> {
    if !value.as_bytes().get(..keyword.len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case(keyword.as_bytes())) {
        return None;
    }
    let rest = &value[keyword.len()..];
    match rest.chars().next() {
        None => Some(""),
        Some(next) if next.is_whitespace() || next == '(' => Some(rest.trim_start()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

/// `CREATE TYPE "s"."n" AS ENUM (...)`
pub fn create_enum(schema: &str, name: &str, values: &[String]) -> String {
    let labels = values.iter().map(|value| quote_literal(value)).collect::<Vec<_>>().join(", ");
    format!("CREATE TYPE {} AS ENUM ({});", qualified(schema, name), labels)
}

/// `CREATE TYPE "s"."n" AS ( ... )`
pub fn create_composite(schema: &str, name: &str, attributes: &[(String, String)]) -> String {
    let fields = attributes
        .iter()
        .map(|(attribute, data_type)| format!("  {} {}", quote_ident(attribute), data_type.trim()))
        .collect::<Vec<_>>()
        .join(",\n");
    format!("CREATE TYPE {} AS (\n{}\n);", qualified(schema, name), fields)
}

/// `CREATE DOMAIN "s"."n" AS base [COLLATE] [DEFAULT] [NOT NULL] [CONSTRAINT ...]`
pub fn create_domain(
    schema: &str,
    name: &str,
    base_type: &str,
    collation: Option<&str>,
    default: Option<&str>,
    not_null: bool,
    constraints: &[CustomTypeDomainConstraintDraft],
) -> String {
    let mut parts = vec![format!("CREATE DOMAIN {} AS {}", qualified(schema, name), base_type.trim())];
    if let Some(collation) = collation.map(str::trim).filter(|value| !value.is_empty()) {
        // This field has already been validated as a qualified name. Preserve
        // quoted components and quote each bare component, never the whole path.
        let collation = super::fragment::split_qualified_name(collation)
            .into_iter()
            .map(str::trim)
            .map(|part| if part.starts_with('"') { part.to_string() } else { quote_ident(part) })
            .collect::<Vec<_>>()
            .join(".");
        parts.push(format!("COLLATE {collation}"));
    }
    if let Some(default) = default.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(format!("DEFAULT {default}"));
    }
    if not_null {
        parts.push("NOT NULL".to_string());
    }
    let constraint_fragments = constraints
        .iter()
        // CREATE DOMAIN has no NOT VALID form. The planner adds these later
        // with ALTER DOMAIN, in the same transaction as creation.
        .filter(|constraint| constraint.validated != Some(false))
        .map(|constraint| {
            // The draft's own text, not a canonical form: whitespace inside a
            // string literal is part of the constraint's meaning.
            let body = check_body(&constraint.expression);
            format!("CONSTRAINT {} CHECK ({body})", quote_ident(constraint.name.as_str()))
        })
        .collect::<Vec<_>>();
    parts.extend(constraint_fragments);
    format!("{};", parts.join("\n  "))
}

/// `CREATE TYPE "s"."n" AS RANGE ( ... )`
pub fn create_range(
    schema: &str,
    name: &str,
    subtype: &str,
    subtype_opclass: Option<&str>,
    canonical: Option<&str>,
    subtype_diff: Option<&str>,
    multirange_name: Option<&str>,
) -> String {
    let mut args = vec![format!("subtype = {}", subtype.trim())];
    if let Some(value) = subtype_opclass.map(str::trim).filter(|value| !value.is_empty()) {
        args.push(format!("subtype_opclass = {value}"));
    }
    if let Some(value) = canonical.map(str::trim).filter(|value| !value.is_empty()) {
        args.push(format!("canonical = {value}"));
    }
    if let Some(value) = subtype_diff.map(str::trim).filter(|value| !value.is_empty()) {
        args.push(format!("subtype_diff = {value}"));
    }
    if let Some(value) = multirange_name.filter(|value| !value.is_empty()) {
        args.push(format!("multirange_type_name = {}", quote_ident(value)));
    }
    format!("CREATE TYPE {} AS RANGE (\n  {}\n);", qualified(schema, name), args.join(",\n  "))
}

pub fn comment_on_type(kind: CustomTypeKind, schema: &str, name: &str, comment: Option<&str>) -> String {
    let target = qualified(schema, name);
    match comment {
        Some(comment) => format!("COMMENT ON {} {} IS {};", object_keyword(kind), target, quote_literal(comment)),
        None => format!("COMMENT ON {} {} IS NULL;", object_keyword(kind), target),
    }
}

pub fn comment_on_composite_attribute(schema: &str, name: &str, attribute: &str, comment: Option<&str>) -> String {
    let target = format!("{}.{}", qualified(schema, name), quote_ident(attribute));
    match comment {
        Some(comment) => format!("COMMENT ON COLUMN {target} IS {};", quote_literal(comment)),
        None => format!("COMMENT ON COLUMN {target} IS NULL;"),
    }
}

pub fn alter_owner(kind: CustomTypeKind, schema: &str, name: &str, owner: &str) -> String {
    format!("ALTER {} {} OWNER TO {};", object_keyword(kind), qualified(schema, name), quote_ident(owner))
}

pub fn alter_rename(kind: CustomTypeKind, schema: &str, name: &str, new_name: &str) -> String {
    format!("ALTER {} {} RENAME TO {};", object_keyword(kind), qualified(schema, name), quote_ident(new_name))
}

pub fn alter_set_schema(kind: CustomTypeKind, schema: &str, name: &str, new_schema: &str) -> String {
    format!("ALTER {} {} SET SCHEMA {};", object_keyword(kind), qualified(schema, name), quote_ident(new_schema))
}

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

pub fn alter_enum_add_value(schema: &str, name: &str, value: &str, position: Option<EnumAddPosition<'_>>) -> String {
    let target = qualified(schema, name);
    let position = match position {
        Some(EnumAddPosition::Before(anchor)) => format!(" BEFORE {}", quote_literal(anchor)),
        Some(EnumAddPosition::After(anchor)) => format!(" AFTER {}", quote_literal(anchor)),
        None => String::new(),
    };
    format!("ALTER TYPE {target} ADD VALUE {}{position};", quote_literal(value),)
}

pub enum EnumAddPosition<'a> {
    Before(&'a str),
    After(&'a str),
}

pub fn alter_enum_rename_value(schema: &str, name: &str, from: &str, to: &str) -> String {
    format!("ALTER TYPE {} RENAME VALUE {} TO {};", qualified(schema, name), quote_literal(from), quote_literal(to))
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

pub fn alter_composite_add_attribute(schema: &str, name: &str, attribute: &str, data_type: &str) -> String {
    format!(
        "ALTER TYPE {} ADD ATTRIBUTE {} {} RESTRICT;",
        qualified(schema, name),
        quote_ident(attribute),
        data_type.trim()
    )
}

pub fn alter_composite_rename_attribute(schema: &str, name: &str, from: &str, to: &str) -> String {
    format!(
        "ALTER TYPE {} RENAME ATTRIBUTE {} TO {} RESTRICT;",
        qualified(schema, name),
        quote_ident(from),
        quote_ident(to)
    )
}

pub fn alter_composite_alter_attribute_type(schema: &str, name: &str, attribute: &str, data_type: &str) -> String {
    format!(
        "ALTER TYPE {} ALTER ATTRIBUTE {} SET DATA TYPE {} RESTRICT;",
        qualified(schema, name),
        quote_ident(attribute),
        data_type.trim()
    )
}

pub fn alter_composite_drop_attribute(schema: &str, name: &str, attribute: &str) -> String {
    format!("ALTER TYPE {} DROP ATTRIBUTE {} RESTRICT;", qualified(schema, name), quote_ident(attribute))
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

pub fn alter_domain_set_default(schema: &str, name: &str, default: &str) -> String {
    format!("ALTER DOMAIN {} SET DEFAULT {};", qualified(schema, name), default.trim())
}

pub fn alter_domain_drop_default(schema: &str, name: &str) -> String {
    format!("ALTER DOMAIN {} DROP DEFAULT;", qualified(schema, name))
}

pub fn alter_domain_set_not_null(schema: &str, name: &str, not_null: bool) -> String {
    let action = if not_null { "SET NOT NULL" } else { "DROP NOT NULL" };
    format!("ALTER DOMAIN {} {action};", qualified(schema, name))
}

pub fn alter_domain_add_constraint(
    schema: &str,
    name: &str,
    constraint: &str,
    expression: &str,
    validated: Option<bool>,
) -> String {
    let mut statement = format!(
        "ALTER DOMAIN {} ADD CONSTRAINT {} CHECK ({});",
        qualified(schema, name),
        quote_ident(constraint),
        check_body(expression)
    );
    if validated == Some(false) {
        statement.truncate(statement.len() - 1);
        statement.push_str(" NOT VALID;");
    }
    statement
}

pub fn alter_domain_drop_constraint(schema: &str, name: &str, constraint: &str) -> String {
    format!("ALTER DOMAIN {} DROP CONSTRAINT {} RESTRICT;", qualified(schema, name), quote_ident(constraint))
}

pub fn alter_domain_rename_constraint(schema: &str, name: &str, from: &str, to: &str) -> String {
    format!("ALTER DOMAIN {} RENAME CONSTRAINT {} TO {};", qualified(schema, name), quote_ident(from), quote_ident(to))
}

pub fn alter_domain_validate_constraint(schema: &str, name: &str, constraint: &str) -> String {
    format!("ALTER DOMAIN {} VALIDATE CONSTRAINT {};", qualified(schema, name), quote_ident(constraint))
}

// ---------------------------------------------------------------------------
// DROP
// ---------------------------------------------------------------------------

pub fn drop_statement(kind: CustomTypeKind, schema: &str, name: &str, cascade: bool) -> String {
    let behavior = if cascade { "CASCADE" } else { "RESTRICT" };
    format!("DROP {} {} {behavior};", object_keyword(kind), qualified(schema, name))
}
