use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableQueryInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub schema_quoted: bool,
    pub table_name: String,
    pub table_name_quoted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table_alias: Option<String>,
    pub select_star: bool,
    pub columns: Vec<EditableQueryColumn>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableQueryColumn {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    pub source_name_quoted: bool,
    pub result_name: String,
    pub expression: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueryEditabilityReason {
    NotSelect,
    Cte,
    SetOperation,
    Aggregation,
    ExternalSource,
    ComplexSource,
    ComputedColumns,
    NoTable,
    NoPrimaryKey,
    PrimaryKeyNotReturned,
    AliasedColumns,
    MetadataUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryEditability {
    pub editable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis: Option<EditableQueryInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<QueryEditabilityReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FromSource {
    schema: Option<String>,
    schema_quoted: bool,
    table_name: String,
    table_name_quoted: bool,
    alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct QualifiedIdentifier {
    parts: Vec<Identifier>,
    end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Identifier {
    value: String,
    quoted: bool,
    end: usize,
}

pub fn analyze_editable_query(sql: &str) -> Option<EditableQueryInfo> {
    let result = analyze_editable_query_editability(sql);
    if result.editable {
        result.analysis
    } else {
        None
    }
}

pub fn analyze_editable_query_editability(sql: &str) -> QueryEditability {
    let normalized = strip_sql_comments(sql).trim_end_matches(';').trim().to_string();
    if normalized.is_empty() {
        return not_editable(QueryEditabilityReason::NotSelect);
    }
    if starts_with_keyword(&normalized, "WITH") {
        return not_editable(QueryEditabilityReason::Cte);
    }
    if !starts_with_keyword(&normalized, "SELECT") {
        return not_editable(QueryEditabilityReason::NotSelect);
    }
    if has_top_level_keyword(&normalized, &["UNION", "INTERSECT", "EXCEPT"]) {
        return not_editable(QueryEditabilityReason::SetOperation);
    }
    if normalized.contains(';') {
        return not_editable(QueryEditabilityReason::ComplexSource);
    }

    let Some(from_index) = find_top_level_keyword(&normalized, "FROM", 0) else {
        return not_editable(QueryEditabilityReason::NoTable);
    };

    let select_body = normalized["SELECT".len()..from_index].trim();
    if starts_with_keyword(select_body, "DISTINCT") {
        return not_editable(QueryEditabilityReason::Aggregation);
    }

    let group_index = find_top_level_keyword(&normalized, "GROUP", from_index + "FROM".len());
    let having_index = find_top_level_keyword(&normalized, "HAVING", from_index + "FROM".len());
    if group_index.is_some() || having_index.is_some() {
        return not_editable(QueryEditabilityReason::Aggregation);
    }

    let from_body_start = from_index + "FROM".len();
    let from_end =
        first_top_level_keyword_index(&normalized, &["WHERE", "ORDER", "LIMIT", "OFFSET", "FETCH"], from_body_start)
            .unwrap_or(normalized.len());
    let from_body = normalized[from_body_start..from_end].trim();
    if is_external_from_source(from_body) {
        return not_editable(QueryEditabilityReason::ExternalSource);
    }
    let Some(source) = parse_from_source(from_body) else {
        return not_editable(QueryEditabilityReason::ComplexSource);
    };

    let select_star = is_select_star(select_body, source.alias.as_deref());
    let columns = if select_star { Vec::new() } else { parse_select_columns(select_body) };
    if !select_star && columns.is_empty() {
        return not_editable(QueryEditabilityReason::ComputedColumns);
    }

    QueryEditability {
        editable: true,
        analysis: Some(EditableQueryInfo {
            schema: source.schema,
            schema_quoted: source.schema_quoted,
            table_name: source.table_name,
            table_name_quoted: source.table_name_quoted,
            table_alias: source.alias,
            select_star,
            columns,
        }),
        reason: None,
    }
}

fn not_editable(reason: QueryEditabilityReason) -> QueryEditability {
    QueryEditability { editable: false, analysis: None, reason: Some(reason) }
}

fn parse_select_columns(body: &str) -> Vec<EditableQueryColumn> {
    let mut columns = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in body.chars() {
        if let Some(close) = quote {
            current.push(ch);
            if ch == close {
                quote = None;
            }
            continue;
        }

        match ch {
            '\'' | '"' | '`' => quote = Some(ch),
            '[' => quote = Some(']'),
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                let Some(column) = parse_select_column(current.trim()) else {
                    return Vec::new();
                };
                columns.push(column);
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(ch);
    }

    if !current.trim().is_empty() {
        let Some(column) = parse_select_column(current.trim()) else {
            return Vec::new();
        };
        columns.push(column);
    }

    columns
}

fn parse_select_column(column: &str) -> Option<EditableQueryColumn> {
    let Some(source) = parse_qualified_identifier(column) else {
        return parse_computed_select_column(column);
    };
    let rest = &column[source.end..];
    let Some(alias) = parse_column_alias(rest) else {
        return parse_computed_select_column(column);
    };
    let source = source.parts.last()?;
    let source_name = source.value.clone();
    Some(EditableQueryColumn {
        source_name: Some(source_name.clone()),
        source_name_quoted: source.quoted,
        result_name: alias.unwrap_or(source_name),
        expression: column[..source.end].trim().to_string(),
    })
}

fn parse_computed_select_column(column: &str) -> Option<EditableQueryColumn> {
    let alias = parse_expression_alias(column)?;
    Some(EditableQueryColumn {
        source_name: None,
        source_name_quoted: false,
        result_name: alias.result_name,
        expression: alias.expression,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExpressionAlias {
    expression: String,
    result_name: String,
}

fn parse_expression_alias(column: &str) -> Option<ExpressionAlias> {
    let trimmed_end = column.trim_end();
    for (index, _) in trimmed_end.match_indices(['A', 'a']) {
        let candidate = &trimmed_end[index..];
        if !candidate.get(..2).is_some_and(|prefix| prefix.eq_ignore_ascii_case("AS")) {
            continue;
        }
        let before = if index == 0 { "" } else { &trimmed_end[..index] };
        if before.chars().last().is_some_and(is_identifier_char) {
            continue;
        }
        let after_as = &candidate[2..];
        if !after_as.chars().next().is_some_and(char::is_whitespace) {
            continue;
        }
        let alias_text = after_as.trim();
        let alias = read_identifier(alias_text, 0)?;
        if alias.end != alias_text.len() {
            continue;
        }
        let expression = trimmed_end[..index].trim().to_string();
        if expression.is_empty() {
            return None;
        }
        return Some(ExpressionAlias { expression, result_name: alias.value });
    }
    None
}

fn parse_column_alias(rest: &str) -> Option<Option<String>> {
    let trimmed = rest.trim();
    if trimmed.is_empty() {
        return Some(None);
    }
    let alias_text = strip_leading_as(trimmed).unwrap_or(trimmed).trim();
    let alias = read_identifier(alias_text, 0)?;
    if alias.end != alias_text.len() {
        return None;
    }
    Some(Some(alias.value))
}

fn strip_leading_as(text: &str) -> Option<&str> {
    let prefix = text.get(..2)?;
    if !prefix.eq_ignore_ascii_case("AS") {
        return None;
    }
    let rest = &text[2..];
    if rest.chars().next().is_some_and(char::is_whitespace) {
        Some(rest)
    } else {
        None
    }
}

fn is_select_star(body: &str, alias: Option<&str>) -> bool {
    let trimmed = body.trim();
    if trimmed == "*" {
        return true;
    }
    let Some(alias) = alias else {
        return false;
    };
    let Some((prefix, suffix)) = trimmed.split_once('.') else {
        return false;
    };
    prefix.trim().eq_ignore_ascii_case(alias) && suffix.trim() == "*"
}

fn parse_from_source(body: &str) -> Option<FromSource> {
    if body.is_empty()
        || body.contains(',')
        || body.contains('(')
        || body.contains(')')
        || contains_keyword(body, "JOIN")
    {
        return None;
    }
    let ident = parse_qualified_identifier(body)?;
    if ident.parts.is_empty() || ident.parts.len() > 2 {
        return None;
    }
    let tail = body[ident.end..].trim();
    let alias = if tail.is_empty() {
        None
    } else {
        let alias_text = strip_leading_as(tail).unwrap_or(tail).trim();
        let alias_ident = read_identifier(alias_text, 0)?;
        if alias_ident.end != alias_text.len() {
            return None;
        }
        Some(alias_ident.value)
    };
    let table = ident.parts.last()?;
    let table_name = table.value.clone();
    let table_name_quoted = table.quoted;
    let (schema, schema_quoted) = if ident.parts.len() == 2 {
        let schema = &ident.parts[0];
        (Some(schema.value.clone()), schema.quoted)
    } else {
        (None, false)
    };
    Some(FromSource { schema, schema_quoted, table_name, table_name_quoted, alias })
}

fn is_external_from_source(body: &str) -> bool {
    let trimmed = body.trim();
    is_single_quoted_source_with_optional_alias(trimmed) || starts_with_table_function(trimmed)
}

fn is_single_quoted_source_with_optional_alias(text: &str) -> bool {
    let mut chars = text.char_indices().peekable();
    if chars.next().map(|(_, ch)| ch) != Some('\'') {
        return false;
    }
    while let Some((idx, ch)) = chars.next() {
        if ch == '\'' {
            if chars.peek().is_some_and(|(_, next)| *next == '\'') {
                chars.next();
                continue;
            }
            let tail = text[idx + ch.len_utf8()..].trim();
            if tail.is_empty() {
                return true;
            }
            let alias_text = strip_leading_as(tail).unwrap_or(tail).trim();
            return read_identifier(alias_text, 0).is_some_and(|alias| alias.end == alias_text.len());
        }
    }
    false
}

fn starts_with_table_function(text: &str) -> bool {
    let Some(ident) = read_identifier(text, 0) else {
        return false;
    };
    text[ident.end..].trim_start().starts_with('(')
}

fn parse_qualified_identifier(text: &str) -> Option<QualifiedIdentifier> {
    let mut parts = Vec::new();
    let mut pos = 0usize;
    while pos < text.len() {
        pos = skip_whitespace(text, pos);
        let Some(ident) = read_identifier(text, pos) else {
            break;
        };
        let ident_end = ident.end;
        parts.push(ident);
        pos = skip_whitespace(text, ident_end);
        if !text[pos..].starts_with('.') {
            break;
        }
        pos += 1;
    }
    if parts.is_empty() {
        return None;
    }
    Some(QualifiedIdentifier { parts, end: pos })
}

fn read_identifier(text: &str, start: usize) -> Option<Identifier> {
    let pos = skip_whitespace(text, start);
    let mut chars = text[pos..].char_indices();
    let (_, first) = chars.next()?;
    if matches!(first, '"' | '`' | '[') {
        let close = if first == '[' { ']' } else { first };
        let mut value = String::new();
        for (offset, ch) in chars {
            if ch == close {
                return Some(Identifier { value, quoted: true, end: pos + offset + ch.len_utf8() });
            }
            value.push(ch);
        }
        return None;
    }

    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let mut end = pos + first.len_utf8();
    for (offset, ch) in text[end..].char_indices() {
        if !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '$') {
            return Some(Identifier { value: text[pos..end + offset].to_string(), quoted: false, end: end + offset });
        }
    }
    end = text.len();
    Some(Identifier { value: text[pos..end].to_string(), quoted: false, end })
}

fn skip_whitespace(text: &str, pos: usize) -> usize {
    let mut current = pos;
    for (offset, ch) in text[pos..].char_indices() {
        if !ch.is_whitespace() {
            return pos + offset;
        }
        current = pos + offset + ch.len_utf8();
    }
    current
}

fn strip_sql_comments(sql: &str) -> String {
    let mut result = String::new();
    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '-' && chars.peek() == Some(&'-') {
            chars.next();
            for next in chars.by_ref() {
                if next == '\n' {
                    result.push('\n');
                    break;
                }
            }
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut previous = '\0';
            for next in chars.by_ref() {
                if previous == '*' && next == '/' {
                    break;
                }
                previous = next;
            }
            continue;
        }
        result.push(ch);
    }
    result
}

fn has_top_level_keyword(sql: &str, keywords: &[&str]) -> bool {
    keywords.iter().any(|keyword| find_top_level_keyword(sql, keyword, 0).is_some())
}

fn first_top_level_keyword_index(sql: &str, keywords: &[&str], start: usize) -> Option<usize> {
    keywords.iter().filter_map(|keyword| find_top_level_keyword(sql, keyword, start)).min()
}

fn find_top_level_keyword(sql: &str, keyword: &str, start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let upper_keyword = keyword.to_ascii_uppercase();

    for (index, ch) in sql.char_indices().filter(|(index, _)| *index >= start) {
        if let Some(close) = quote {
            if ch == close {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' | '`' => {
                quote = Some(ch);
                continue;
            }
            '[' => {
                quote = Some(']');
                continue;
            }
            '(' => {
                depth += 1;
                continue;
            }
            ')' => {
                depth = 0.max(depth - 1);
                continue;
            }
            _ => {}
        }
        if depth != 0 {
            continue;
        }
        let Some(candidate) = sql.get(index..index + keyword.len()) else {
            continue;
        };
        if candidate.to_ascii_uppercase() != upper_keyword {
            continue;
        }
        let before = previous_char(sql, index);
        let after = sql[index + keyword.len()..].chars().next();
        if !before.is_some_and(is_identifier_char) && !after.is_some_and(is_identifier_char) {
            return Some(index);
        }
    }
    None
}

fn starts_with_keyword(sql: &str, keyword: &str) -> bool {
    let trimmed = sql.trim_start();
    let Some(candidate) = trimmed.get(..keyword.len()) else {
        return false;
    };
    if !candidate.eq_ignore_ascii_case(keyword) {
        return false;
    }
    !trimmed[keyword.len()..].chars().next().is_some_and(is_identifier_char)
}

fn contains_keyword(sql: &str, keyword: &str) -> bool {
    find_top_level_keyword(sql, keyword, 0).is_some()
}

fn previous_char(text: &str, index: usize) -> Option<char> {
    text[..index].chars().next_back()
}

fn is_identifier_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_simple_single_table_select_as_editable() {
        let result =
            analyze_editable_query_editability("select id, name from public.users where active = true order by id");

        assert_eq!(
            result,
            QueryEditability {
                editable: true,
                analysis: Some(EditableQueryInfo {
                    schema: Some("public".to_string()),
                    schema_quoted: false,
                    table_name: "users".to_string(),
                    table_name_quoted: false,
                    table_alias: None,
                    select_star: false,
                    columns: vec![
                        EditableQueryColumn {
                            source_name: Some("id".to_string()),
                            source_name_quoted: false,
                            result_name: "id".to_string(),
                            expression: "id".to_string(),
                        },
                        EditableQueryColumn {
                            source_name: Some("name".to_string()),
                            source_name_quoted: false,
                            result_name: "name".to_string(),
                            expression: "name".to_string(),
                        },
                    ],
                }),
                reason: None,
            }
        );
    }

    #[test]
    fn recognizes_quoted_table_names_and_aliases() {
        let result =
            analyze_editable_query_editability(r#"SELECT u."id", u."full name" FROM "app schema"."user table" AS u"#);

        assert_eq!(
            result.analysis.unwrap(),
            EditableQueryInfo {
                schema: Some("app schema".to_string()),
                schema_quoted: true,
                table_name: "user table".to_string(),
                table_name_quoted: true,
                table_alias: Some("u".to_string()),
                select_star: false,
                columns: vec![
                    EditableQueryColumn {
                        source_name: Some("id".to_string()),
                        source_name_quoted: true,
                        result_name: "id".to_string(),
                        expression: r#"u."id""#.to_string(),
                    },
                    EditableQueryColumn {
                        source_name: Some("full name".to_string()),
                        source_name_quoted: true,
                        result_name: "full name".to_string(),
                        expression: r#"u."full name""#.to_string(),
                    },
                ],
            }
        );
    }

    #[test]
    fn keeps_select_star_empty_columns() {
        assert_eq!(
            analyze_editable_query("select * from users").unwrap(),
            EditableQueryInfo {
                schema: None,
                schema_quoted: false,
                table_name: "users".to_string(),
                table_name_quoted: false,
                table_alias: None,
                select_star: true,
                columns: Vec::new(),
            }
        );
    }

    #[test]
    fn reports_joined_query_as_complex_source() {
        let result =
            analyze_editable_query_editability("select u.id, o.total from users u join orders o on o.user_id = u.id");

        assert!(!result.editable);
        assert_eq!(result.reason, Some(QueryEditabilityReason::ComplexSource));
    }

    #[test]
    fn reports_external_file_scan_as_external_source() {
        let result = analyze_editable_query_editability("SELECT * FROM '/tmp/duckdb_excel_extension_test.xlsx'");

        assert!(!result.editable);
        assert_eq!(result.reason, Some(QueryEditabilityReason::ExternalSource));
    }

    #[test]
    fn reports_grouped_query_as_aggregation() {
        let result = analyze_editable_query_editability("select id, count(*) as total from users group by id");

        assert!(!result.editable);
        assert_eq!(result.reason, Some(QueryEditabilityReason::Aggregation));
    }

    #[test]
    fn keeps_single_table_expression_columns() {
        let result = analyze_editable_query_editability(
            "select iso3, year, country_name, ihli / gdp_pc as score from ihli_data",
        );

        assert_eq!(
            result.analysis.unwrap().columns,
            vec![
                EditableQueryColumn {
                    source_name: Some("iso3".to_string()),
                    source_name_quoted: false,
                    result_name: "iso3".to_string(),
                    expression: "iso3".to_string(),
                },
                EditableQueryColumn {
                    source_name: Some("year".to_string()),
                    source_name_quoted: false,
                    result_name: "year".to_string(),
                    expression: "year".to_string(),
                },
                EditableQueryColumn {
                    source_name: Some("country_name".to_string()),
                    source_name_quoted: false,
                    result_name: "country_name".to_string(),
                    expression: "country_name".to_string(),
                },
                EditableQueryColumn {
                    source_name: None,
                    source_name_quoted: false,
                    result_name: "score".to_string(),
                    expression: "ihli / gdp_pc".to_string(),
                },
            ]
        );
    }

    #[test]
    fn serializes_reason_values_like_frontend_union() {
        let json = serde_json::to_value(not_editable(QueryEditabilityReason::SetOperation)).unwrap();

        assert_eq!(json, serde_json::json!({ "editable": false, "reason": "set-operation" }));
    }
}
