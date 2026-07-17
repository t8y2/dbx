use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableQueryInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub catalog_quoted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub schema_quoted: bool,
    pub table_name: String,
    pub table_name_quoted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table_alias: Option<String>,
    pub select_star: bool,
    pub columns: Vec<EditableQueryColumn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<EditableQuerySource>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editable_source_key: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub multi_source: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_insert_delete: Option<bool>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub distinct: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableQueryColumn {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    pub source_name_quoted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_qualifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_key: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub star: bool,
    pub result_name: String,
    pub expression: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableQuerySource {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub catalog_quoted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub schema_quoted: bool,
    pub table_name: String,
    pub table_name_quoted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
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
    key: String,
    catalog: Option<String>,
    catalog_quoted: bool,
    schema: Option<String>,
    schema_quoted: bool,
    table_name: String,
    table_name_quoted: bool,
    alias: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
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

    let raw_select_body = normalized["SELECT".len()..from_index].trim();
    let (select_body, distinct) = if starts_with_keyword(raw_select_body, "DISTINCT") {
        let body = raw_select_body["DISTINCT".len()..].trim_start();
        // DISTINCT ON has database-specific row-selection semantics and cannot be
        // treated as a plain projection whose rows map directly to base records.
        if starts_with_keyword(body, "ON") {
            return not_editable(QueryEditabilityReason::Aggregation);
        }
        (body, true)
    } else {
        (raw_select_body, false)
    };
    let select_body = strip_sql_server_top_clause(select_body);

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
    let sources = parse_from_sources(from_body);
    if sources.is_empty() {
        return not_editable(QueryEditabilityReason::ComplexSource);
    }
    let source = sources[0].clone();

    let select_star = sources.len() == 1 && is_select_star(select_body, source.alias.as_deref());
    let columns = if select_star { Vec::new() } else { parse_select_columns(select_body, &sources) };
    if !select_star && columns.is_empty() {
        return not_editable(QueryEditabilityReason::ComputedColumns);
    }
    if sources.len() > 1 && columns.iter().any(|column| column.star && column.source_key.is_none()) {
        return not_editable(QueryEditabilityReason::ComplexSource);
    }

    let mut analysis = EditableQueryInfo {
        catalog: source.catalog,
        catalog_quoted: source.catalog_quoted,
        schema: source.schema,
        schema_quoted: source.schema_quoted,
        table_name: source.table_name,
        table_name_quoted: source.table_name_quoted,
        table_alias: source.alias,
        select_star,
        columns,
        sources: None,
        editable_source_key: None,
        multi_source: false,
        // Updating an identified base row is safe, but insert/delete semantics are
        // ambiguous when the displayed set is de-duplicated by the query.
        allow_insert_delete: distinct.then_some(false),
        distinct,
    };
    if sources.len() > 1 {
        analysis.sources = Some(sources.into_iter().map(EditableQuerySource::from).collect());
        analysis.multi_source = true;
        analysis.allow_insert_delete = Some(false);
    }

    QueryEditability { editable: true, analysis: Some(analysis), reason: None }
}

fn not_editable(reason: QueryEditabilityReason) -> QueryEditability {
    QueryEditability { editable: false, analysis: None, reason: Some(reason) }
}

fn parse_select_columns(body: &str, sources: &[FromSource]) -> Vec<EditableQueryColumn> {
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
                let Some(column) = parse_select_column(current.trim(), sources) else {
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
        let Some(column) = parse_select_column(current.trim(), sources) else {
            return Vec::new();
        };
        columns.push(column);
    }

    columns
}

fn parse_select_column(column: &str, sources: &[FromSource]) -> Option<EditableQueryColumn> {
    if let Some(star) = parse_star_select_column(column, sources) {
        return Some(star);
    }
    let Some(source) = parse_qualified_identifier(column) else {
        return parse_computed_select_column(column);
    };
    let rest = &column[source.end..];
    let Some(alias) = parse_column_alias(rest) else {
        return parse_computed_select_column(column);
    };
    let source_name_part = source.parts.last()?;
    let source_name = source_name_part.value.clone();
    let qualifier = if source.parts.len() >= 2 {
        source.parts.get(source.parts.len() - 2).map(|part| part.value.clone())
    } else {
        None
    };
    let source_key = qualifier.as_deref().and_then(|qualifier| source_key_for_qualifier(sources, qualifier));
    Some(EditableQueryColumn {
        source_name: Some(source_name.clone()),
        source_name_quoted: source_name_part.quoted,
        source_qualifier: qualifier,
        source_key,
        star: false,
        result_name: alias.unwrap_or(source_name),
        expression: column[..source.end].trim().to_string(),
    })
}

fn parse_star_select_column(column: &str, sources: &[FromSource]) -> Option<EditableQueryColumn> {
    let trimmed = column.trim();
    if trimmed == "*" {
        return Some(EditableQueryColumn {
            source_name: None,
            source_name_quoted: false,
            source_qualifier: None,
            source_key: None,
            star: true,
            result_name: "*".to_string(),
            expression: trimmed.to_string(),
        });
    }
    let qualifier = read_identifier(trimmed, 0)?;
    let mut pos = skip_whitespace(trimmed, qualifier.end);
    if !trimmed[pos..].starts_with('.') {
        return None;
    }
    pos = skip_whitespace(trimmed, pos + 1);
    if trimmed[pos..].trim() != "*" {
        return None;
    }
    let source_key = source_key_for_qualifier(sources, &qualifier.value);
    Some(EditableQueryColumn {
        source_name: None,
        source_name_quoted: false,
        source_qualifier: Some(qualifier.value),
        source_key,
        star: true,
        result_name: "*".to_string(),
        expression: trimmed.to_string(),
    })
}

fn parse_computed_select_column(column: &str) -> Option<EditableQueryColumn> {
    let alias = parse_expression_alias(column)?;
    Some(EditableQueryColumn {
        source_name: None,
        source_name_quoted: false,
        source_qualifier: None,
        source_key: None,
        star: false,
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

fn strip_sql_server_top_clause(body: &str) -> &str {
    let trimmed = body.trim_start();
    if !starts_with_keyword(trimmed, "TOP") {
        return trimmed;
    }

    let mut pos = skip_whitespace(trimmed, "TOP".len());
    if trimmed[pos..].starts_with('(') {
        let mut depth = 0i32;
        let mut quote: Option<char> = None;
        let mut end = None;
        for (offset, ch) in trimmed[pos..].char_indices() {
            if let Some(close) = quote {
                if ch == close {
                    quote = None;
                }
                continue;
            }
            match ch {
                '\'' | '"' | '`' => quote = Some(ch),
                '[' => quote = Some(']'),
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(pos + offset + ch.len_utf8());
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else {
            return trimmed;
        };
        pos = end;
    } else {
        let number_end = trimmed[pos..]
            .char_indices()
            .take_while(|(_, ch)| ch.is_ascii_digit())
            .last()
            .map(|(offset, ch)| pos + offset + ch.len_utf8());
        let Some(end) = number_end else {
            return trimmed;
        };
        pos = end;
    }

    pos = skip_whitespace(trimmed, pos);
    if starts_with_keyword_at(trimmed, pos, "PERCENT") {
        pos = skip_whitespace(trimmed, pos + "PERCENT".len());
    }
    if starts_with_keyword_at(trimmed, pos, "WITH") {
        let ties_pos = skip_whitespace(trimmed, pos + "WITH".len());
        if starts_with_keyword_at(trimmed, ties_pos, "TIES") {
            pos = skip_whitespace(trimmed, ties_pos + "TIES".len());
        }
    }
    let remaining = trimmed[pos..].trim_start();
    if remaining.is_empty() {
        trimmed
    } else {
        remaining
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

fn parse_from_sources(body: &str) -> Vec<FromSource> {
    if body.is_empty() || body.contains('(') || body.contains(')') {
        return Vec::new();
    }

    let mut sources = Vec::new();
    let Some(first) = parse_table_source_at(body, 0, sources.len()) else {
        return Vec::new();
    };
    sources.push(first.0);
    let mut pos = first.1;

    while pos < body.len() {
        pos = skip_whitespace(body, pos);
        if pos >= body.len() {
            break;
        }
        if body[pos..].starts_with(',') {
            let Some(next) = parse_table_source_at(body, pos + 1, sources.len()) else {
                return Vec::new();
            };
            sources.push(next.0);
            pos = next.1;
            continue;
        }
        let Some(join_index) = find_top_level_keyword(body, "JOIN", pos) else {
            break;
        };
        let Some(next) = parse_table_source_at(body, join_index + "JOIN".len(), sources.len()) else {
            return Vec::new();
        };
        sources.push(next.0);
        pos = next.1;
    }

    sources
}

fn parse_table_source_at(text: &str, start: usize, index: usize) -> Option<(FromSource, usize)> {
    let pos = skip_whitespace(text, start);
    if text[pos..].starts_with('\'') || text[pos..].starts_with('(') {
        return None;
    }
    let ident = parse_qualified_identifier(&text[pos..])?;
    if ident.parts.is_empty() || ident.parts.len() > 3 {
        return None;
    }
    let mut end = pos + ident.end;
    let tail_pos = skip_whitespace(text, end);
    let alias = if starts_with_keyword_at(text, tail_pos, "AS") {
        let alias_ident = read_identifier(text, tail_pos + 2)?;
        end = alias_ident.end;
        Some(alias_ident.value)
    } else if table_source_terminator_at(text, tail_pos) {
        None
    } else {
        let alias_ident = read_identifier(text, tail_pos)?;
        end = alias_ident.end;
        Some(alias_ident.value)
    };

    let table = ident.parts.last()?;
    let table_name = table.value.clone();
    let table_name_quoted = table.quoted;
    let (schema, schema_quoted) = if ident.parts.len() >= 2 {
        let schema = &ident.parts[ident.parts.len() - 2];
        (Some(schema.value.clone()), schema.quoted)
    } else {
        (None, false)
    };
    let (catalog, catalog_quoted) = if ident.parts.len() == 3 {
        let catalog = &ident.parts[0];
        (Some(catalog.value.clone()), catalog.quoted)
    } else {
        (None, false)
    };
    let key = format!("{}:{}", alias.as_deref().unwrap_or(&table_name), index);
    Some((
        FromSource { key, catalog, catalog_quoted, schema, schema_quoted, table_name, table_name_quoted, alias },
        end,
    ))
}

fn is_external_from_source(body: &str) -> bool {
    let trimmed = body.trim();
    is_single_quoted_source_with_optional_alias(trimmed) || starts_with_table_function(trimmed)
}

fn table_source_terminator_at(text: &str, pos: usize) -> bool {
    let pos = skip_whitespace(text, pos);
    if pos >= text.len() || text[pos..].starts_with(',') {
        return true;
    }
    ["ON", "USING", "JOIN", "LEFT", "RIGHT", "INNER", "FULL", "CROSS", "OUTER", "NATURAL"]
        .iter()
        .any(|keyword| starts_with_keyword_at(text, pos, keyword))
}

fn starts_with_keyword_at(text: &str, pos: usize, keyword: &str) -> bool {
    let start = skip_whitespace(text, pos);
    let Some(candidate) = text.get(start..start + keyword.len()) else {
        return false;
    };
    if !candidate.eq_ignore_ascii_case(keyword) {
        return false;
    }
    let before = previous_char(text, start);
    let after = text[start + keyword.len()..].chars().next();
    !before.is_some_and(is_identifier_char) && !after.is_some_and(is_identifier_char)
}

fn source_key_for_qualifier(sources: &[FromSource], qualifier: &str) -> Option<String> {
    let matches = sources
        .iter()
        .filter(|source| {
            source.alias.as_deref().is_some_and(|alias| alias.eq_ignore_ascii_case(qualifier))
                || source.table_name.eq_ignore_ascii_case(qualifier)
        })
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        Some(matches[0].key.clone())
    } else {
        None
    }
}

impl From<FromSource> for EditableQuerySource {
    fn from(source: FromSource) -> Self {
        Self {
            key: source.key,
            catalog: source.catalog,
            catalog_quoted: source.catalog_quoted,
            schema: source.schema,
            schema_quoted: source.schema_quoted,
            table_name: source.table_name,
            table_name_quoted: source.table_name_quoted,
            alias: source.alias,
        }
    }
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

        assert!(result.editable);
        assert_eq!(result.reason, None);
        let analysis = result.analysis.unwrap();
        assert_eq!(analysis.schema.as_deref(), Some("public"));
        assert_eq!(analysis.table_name, "users");
        assert_eq!(
            analysis.columns,
            vec![
                column(Some("id"), false, None, None, "id", "id"),
                column(Some("name"), false, None, None, "name", "name"),
            ]
        );
    }

    #[test]
    fn recognizes_sql_server_top_selects_as_editable() {
        for sql in [
            "SELECT TOP 2 name, note FROM dbo.users ORDER BY name",
            "SELECT TOP(2) name, note FROM dbo.users ORDER BY name",
            "SELECT TOP (2) name, note FROM dbo.users ORDER BY name",
            "SELECT TOP 10 PERCENT name, note FROM dbo.users ORDER BY name",
            "SELECT TOP (2) WITH TIES name, note FROM dbo.users ORDER BY name",
        ] {
            let result = analyze_editable_query_editability(sql);
            assert!(result.editable, "{sql}: {:?}", result.reason);
            let analysis = result.analysis.unwrap();
            assert_eq!(analysis.table_name, "users");
            assert_eq!(analysis.columns[0].source_name.as_deref(), Some("name"));
            assert_eq!(analysis.columns[1].source_name.as_deref(), Some("note"));
        }
    }

    #[test]
    fn recognizes_quoted_table_names_and_aliases() {
        let result =
            analyze_editable_query_editability(r#"SELECT u."id", u."full name" FROM "app schema"."user table" AS u"#);

        let analysis = result.analysis.unwrap();
        assert_eq!(analysis.schema.as_deref(), Some("app schema"));
        assert_eq!(analysis.table_name, "user table");
        assert_eq!(analysis.table_alias.as_deref(), Some("u"));
        assert_eq!(
            analysis.columns,
            vec![
                column(Some("id"), true, Some("u"), Some("u:0"), "id", r#"u."id""#),
                column(Some("full name"), true, Some("u"), Some("u:0"), "full name", r#"u."full name""#),
            ]
        );
    }

    #[test]
    fn keeps_select_star_empty_columns() {
        let analysis = analyze_editable_query("select * from users").unwrap();
        assert_eq!(analysis.table_name, "users");
        assert!(analysis.select_star);
        assert!(analysis.columns.is_empty());
    }

    #[test]
    fn ignores_where_subquery_sources_for_editable_target() {
        let result = analyze_editable_query_editability(
            "SELECT t.* FROM app.platform_cars t WHERE t.customer_no IN (SELECT c.customer_no FROM app.customers c WHERE c.enabled = 1)",
        );

        assert!(result.editable);
        let analysis = result.analysis.unwrap();
        assert_eq!(analysis.schema.as_deref(), Some("app"));
        assert_eq!(analysis.table_name, "platform_cars");
        assert_eq!(analysis.table_alias.as_deref(), Some("t"));
        assert!(analysis.select_star);
        assert!(!analysis.multi_source);
        assert_eq!(analysis.allow_insert_delete, None);
    }

    #[test]
    fn maps_single_table_explicit_column_with_alias_star() {
        let result = analyze_editable_query_editability(
            "select t.create_date, t.* from tt_kd_material_container_sap t where t.order_no = 'KD2607071336' order by t.create_date desc",
        );

        assert!(result.editable);
        let analysis = result.analysis.unwrap();
        assert_eq!(analysis.table_name, "tt_kd_material_container_sap");
        assert_eq!(analysis.table_alias.as_deref(), Some("t"));
        assert_eq!(
            analysis.columns,
            vec![
                column(Some("create_date"), false, Some("t"), Some("t:0"), "create_date", "t.create_date"),
                star_column(Some("t"), Some("t:0"), "t.*"),
            ]
        );
    }

    #[test]
    fn recognizes_distinct_single_table_projection_as_update_only() {
        let result = analyze_editable_query_editability("select distinct id, name from users");

        assert!(result.editable);
        let analysis = result.analysis.unwrap();
        assert!(analysis.distinct);
        assert_eq!(analysis.allow_insert_delete, Some(false));
        assert_eq!(analysis.columns.len(), 2);
    }

    #[test]
    fn recognizes_distinct_qualified_star_from_join() {
        let result = analyze_editable_query_editability(
            "select distinct u.* from users u left join orders o on o.user_id = u.id",
        );

        assert!(result.editable);
        let analysis = result.analysis.unwrap();
        assert!(analysis.distinct);
        assert!(analysis.multi_source);
        assert_eq!(analysis.allow_insert_delete, Some(false));
        assert_eq!(analysis.columns, vec![star_column(Some("u"), Some("u:0"), "u.*")]);
    }

    #[test]
    fn rejects_unqualified_star_from_join() {
        let result =
            analyze_editable_query_editability("select distinct * from users u join orders o on o.user_id = u.id");

        assert!(!result.editable);
        assert_eq!(result.reason, Some(QueryEditabilityReason::ComplexSource));
    }

    #[test]
    fn rejects_distinct_on_projection() {
        let result = analyze_editable_query_editability(
            "select distinct on (user_id) id, user_id from orders order by user_id, id desc",
        );

        assert!(!result.editable);
        assert_eq!(result.reason, Some(QueryEditabilityReason::Aggregation));
    }

    #[test]
    fn maps_joined_query_source_columns() {
        let result = analyze_editable_query_editability(
            "select u.id as user_id, u.name, o.total from users u join orders o on o.user_id = u.id",
        );

        assert!(result.editable);
        let analysis = result.analysis.unwrap();
        assert!(analysis.multi_source);
        assert_eq!(analysis.allow_insert_delete, Some(false));
        assert_eq!(
            analysis
                .sources
                .unwrap()
                .iter()
                .map(|source| (&source.key, &source.table_name, source.alias.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                (&"u:0".to_string(), &"users".to_string(), Some("u")),
                (&"o:1".to_string(), &"orders".to_string(), Some("o")),
            ]
        );
        assert_eq!(
            analysis.columns,
            vec![
                column(Some("id"), false, Some("u"), Some("u:0"), "user_id", "u.id"),
                column(Some("name"), false, Some("u"), Some("u:0"), "name", "u.name"),
                column(Some("total"), false, Some("o"), Some("o:1"), "total", "o.total"),
            ]
        );
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
                column(Some("iso3"), false, None, None, "iso3", "iso3"),
                column(Some("year"), false, None, None, "year", "year"),
                column(Some("country_name"), false, None, None, "country_name", "country_name"),
                column(None, false, None, None, "score", "ihli / gdp_pc"),
            ]
        );
    }

    #[test]
    fn serializes_reason_values_like_frontend_union() {
        let json = serde_json::to_value(not_editable(QueryEditabilityReason::SetOperation)).unwrap();

        assert_eq!(json, serde_json::json!({ "editable": false, "reason": "set-operation" }));
    }

    fn column(
        source_name: Option<&str>,
        source_name_quoted: bool,
        source_qualifier: Option<&str>,
        source_key: Option<&str>,
        result_name: &str,
        expression: &str,
    ) -> EditableQueryColumn {
        EditableQueryColumn {
            source_name: source_name.map(str::to_string),
            source_name_quoted,
            source_qualifier: source_qualifier.map(str::to_string),
            source_key: source_key.map(str::to_string),
            star: false,
            result_name: result_name.to_string(),
            expression: expression.to_string(),
        }
    }

    fn star_column(source_qualifier: Option<&str>, source_key: Option<&str>, expression: &str) -> EditableQueryColumn {
        EditableQueryColumn {
            source_name: None,
            source_name_quoted: false,
            source_qualifier: source_qualifier.map(str::to_string),
            source_key: source_key.map(str::to_string),
            star: true,
            result_name: "*".to_string(),
            expression: expression.to_string(),
        }
    }
}
