use serde::{Deserialize, Serialize};
use sqlparser::ast::{
    CreateView, Expr, FunctionArg, FunctionArgExpr, FunctionArguments, Ident, ObjectName, Query, Select, SelectItem,
    SelectItemQualifiedWildcardKind, SetExpr, Statement, TableFactor, Visit, Visitor,
};
use sqlparser::dialect::OracleDialect;
use sqlparser::keywords::Keyword;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Location, Token, TokenWithSpan, Tokenizer};
use std::ops::ControlFlow;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleViewRenameSourceInput {
    pub source: String,
    pub owner: String,
    pub view_name: String,
    pub old_name: String,
    pub new_name: String,
    pub target_view_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleViewRenameSource {
    pub source: String,
    pub fingerprint: String,
    pub references: Vec<OracleViewRenameReference>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OracleViewRenameReference {
    pub owner: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleViewRenameIssueLocation {
    pub line: u64,
    pub column: u64,
    pub end_line: u64,
    pub end_column: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleViewRenameIssue {
    pub code: String,
    pub message: String,
    pub view_name: String,
    pub hint_text: Option<String>,
    pub location: Option<OracleViewRenameIssueLocation>,
    pub repairable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleViewRenameSourceReview {
    pub source: Option<OracleViewRenameSource>,
    pub references: Vec<OracleViewRenameReference>,
    pub issues: Vec<OracleViewRenameIssue>,
}

pub fn review_oracle_view_rename_source(input: OracleViewRenameSourceInput) -> OracleViewRenameSourceReview {
    let mut issues = Vec::new();
    for name in [
        &input.owner,
        &input.view_name,
        &input.old_name,
        &input.new_name,
        input.target_view_name.as_ref().unwrap_or(&input.view_name),
    ] {
        if let Err(message) = validate_exact_name(name) {
            issues.push(OracleViewRenameIssue {
                code: "invalid_metadata".into(),
                message,
                view_name: input.view_name.clone(),
                hint_text: None,
                location: None,
                repairable: false,
            });
            return OracleViewRenameSourceReview { source: None, references: Vec::new(), issues };
        }
    }
    let result = build_source(&input, &mut issues);
    let references = match &result {
        Ok(source) => source.references.clone(),
        Err(_) => Vec::new(),
    };
    match result {
        Ok(source) => OracleViewRenameSourceReview { source: Some(source), references, issues },
        Err(message) => {
            let code = if message == "The view declaration does not match the selected owner and name." {
                "invalid_declaration"
            } else {
                "invalid_definition"
            };
            let location = issue_location(code, &message, &input.source);
            issues.push(OracleViewRenameIssue {
                code: code.into(),
                message,
                view_name: input.view_name.clone(),
                hint_text: None,
                location,
                repairable: true,
            });
            OracleViewRenameSourceReview { source: None, references, issues }
        }
    }
}

fn issue_location(code: &str, message: &str, source: &str) -> Option<OracleViewRenameIssueLocation> {
    if code == "invalid_declaration" {
        let tokens = Tokenizer::new(&OracleDialect {}, source).tokenize_with_location().ok()?;
        let view_index = tokens
            .iter()
            .position(|token| matches!(&token.token, Token::Word(word) if word.value.eq_ignore_ascii_case("VIEW")))?;
        let declaration = tokens.get(view_index + 1)?;
        return Some(OracleViewRenameIssueLocation {
            line: declaration.span.start.line,
            column: declaration.span.start.column,
            end_line: declaration.span.end.line,
            end_column: declaration.span.end.column,
        });
    }
    let location = message.rsplit_once(" at Line: ")?.1;
    let (line, column) = location.split_once(", Column: ")?;
    let line = line.parse::<u64>().ok()?;
    let column = column.parse::<u64>().ok()?;
    Some(OracleViewRenameIssueLocation { line, column, end_line: line, end_column: column.saturating_add(1) })
}

pub fn parse_oracle_object_name(input: &str) -> Result<String, String> {
    let input = input.trim();
    let tokens = Tokenizer::new(&OracleDialect {}, input).tokenize().map_err(|e| e.to_string())?;
    let [Token::Word(word)] = tokens.as_slice() else {
        return Err("Enter one Oracle object name without a schema or SQL.".into());
    };
    if word.value.is_empty() || word.value.chars().any(char::is_control) {
        return Err("The object name must not be empty or contain control characters.".into());
    }
    match word.quote_style {
        Some('"') => Ok(word.value.clone()),
        None if word.keyword == Keyword::NoKeyword
            && word.value.chars().next().is_some_and(char::is_alphabetic)
            && word.value.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '$' | '#')) =>
        {
            Ok(word.value.to_uppercase())
        }
        _ => Err("Use an ordinary Oracle identifier or a double-quoted name.".into()),
    }
}

pub fn build_oracle_view_rename_source(input: OracleViewRenameSourceInput) -> Result<OracleViewRenameSource, String> {
    let review = review_oracle_view_rename_source(input);
    if !review.issues.is_empty() {
        return Err(review.issues.into_iter().map(|issue| issue.message).collect::<Vec<_>>().join("\n"));
    }
    review.source.ok_or_else(|| "Invalid view definition.".into())
}

fn build_source(
    input: &OracleViewRenameSourceInput,
    issues: &mut Vec<OracleViewRenameIssue>,
) -> Result<OracleViewRenameSource, String> {
    for name in [&input.owner, &input.view_name, &input.old_name, &input.new_name] {
        validate_exact_name(name)?;
    }
    let target = input.target_view_name.as_deref().unwrap_or(&input.view_name);
    validate_exact_name(target)?;
    let (view, _, tokens) = parse_view(&input.source)?;
    let declaration = name_parts(&view.name)?;
    if declaration.last().map(|name| canonical(name)) != Some(input.view_name.clone())
        || declaration.len() > 2
        || (declaration.len() == 2 && canonical(declaration[0]) != input.owner)
    {
        return Err("The view declaration does not match the selected owner and name.".into());
    }
    let mut edits = Vec::new();
    if !view.or_replace {
        let create = tokens.first().ok_or("Missing CREATE VIEW declaration.")?;
        let end = offset(&input.source, create.span.end)?;
        edits.push(Edit { start: end, end, value: " OR REPLACE".into() });
    }
    if target != input.view_name {
        add_ident_edit(&input.source, declaration[declaration.len() - 1], target, &mut edits)?;
    }
    let mut references = Vec::new();
    rewrite_query(&view.query, &[], input, &mut edits, issues, &mut references)?;
    let source = apply_edits(&input.source, edits)?;
    let (mut parsed, properties, _) = parse_view(&source)?;
    if issues.is_empty() && hint_bindings(&view.query)? != hint_bindings(&parsed.query)? {
        return Err("Reparsed optimizer hints changed their relation bindings.".into());
    }
    // GET_DDL may omit OR REPLACE and qualify the declaration. Neither changes the view.
    parsed.or_replace = true;
    parsed.name = ObjectName::from(vec![Ident::with_quote('"', &input.owner), Ident::with_quote('"', target)]);
    let mut hints = Vec::new();
    take_hint_fingerprints(&mut parsed.query, &mut hints)?;
    let fingerprint = serde_json::to_string(&(canonical_tokens(&parsed.to_string())?, properties, hints))
        .map_err(|e| e.to_string())?;
    Ok(OracleViewRenameSource { source, fingerprint, references })
}

fn validate_exact_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.chars().any(char::is_control) {
        Err("Object metadata contains an empty name or control character.".into())
    } else {
        Ok(())
    }
}

fn canonical(ident: &Ident) -> String {
    if ident.quote_style.is_some() {
        ident.value.clone()
    } else {
        ident.value.to_uppercase()
    }
}

fn name_parts(name: &ObjectName) -> Result<Vec<&Ident>, String> {
    name.0.iter().map(|part| part.as_ident().ok_or_else(|| "Unsupported computed object name.".into())).collect()
}

fn significant_tokens(source: &str) -> Result<Vec<TokenWithSpan>, String> {
    Ok(Tokenizer::new(&OracleDialect {}, source)
        .tokenize_with_location()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|t| !matches!(t.token, Token::Whitespace(_)))
        .collect())
}

fn word(token: &TokenWithSpan, expected: &str) -> bool {
    matches!(&token.token, Token::Word(w) if w.quote_style.is_none() && w.value.eq_ignore_ascii_case(expected))
}

// sqlparser does not represent Oracle FORCE/EDITIONABLE or the trailing view restriction.
// Recognize only these exact clauses, mask their tokens without moving spans, and keep them
// in the original DDL. Persistent properties enter the fingerprint; FORCE is only an
// execution modifier. Unknown syntax remains a parser error.
fn parse_view(source: &str) -> Result<(CreateView, Vec<String>, Vec<TokenWithSpan>), String> {
    let mut tokens = significant_tokens(source)?;
    if tokens.last().is_some_and(|t| t.token == Token::SemiColon) {
        tokens.pop();
    }
    if tokens.iter().any(|t| t.token == Token::SemiColon) || !tokens.first().is_some_and(|t| word(t, "CREATE")) {
        return Err("A complete single CREATE VIEW statement is required.".into());
    }
    let mut properties = Vec::new();
    let mut mask = Vec::new();
    let mut pos = 1;
    if tokens.get(pos).is_some_and(|t| word(t, "OR")) && tokens.get(pos + 1).is_some_and(|t| word(t, "REPLACE")) {
        pos += 2;
    }
    for alternatives in [["FORCE", "NOFORCE"], ["EDITIONABLE", "NONEDITIONABLE"]] {
        if let Some(token) = tokens.get(pos) {
            if alternatives.iter().any(|expected| word(token, expected)) {
                if !word(token, "FORCE") && !word(token, "NOFORCE") {
                    properties.push(token.token.to_string().to_uppercase());
                }
                mask.push(token.span);
                pos += 1;
            }
        }
    }
    if !tokens.get(pos).is_some_and(|t| word(t, "VIEW")) {
        return Err("Only ordinary Oracle CREATE VIEW declarations are supported.".into());
    }
    let mut tail = tokens.len();
    if tail >= 2 && word(&tokens[tail - 2], "CONSTRAINT") {
        if !matches!(tokens[tail - 1].token, Token::Word(_)) {
            return Err("Invalid view constraint name.".into());
        }
        tail -= 2;
    }
    if tail >= 3
        && word(&tokens[tail - 3], "WITH")
        && ((word(&tokens[tail - 2], "READ") && word(&tokens[tail - 1], "ONLY"))
            || (word(&tokens[tail - 2], "CHECK") && word(&tokens[tail - 1], "OPTION")))
    {
        let restriction = &tokens[tail - 3..];
        properties
            .extend(canonical_tokens(&restriction.iter().map(|t| t.token.to_string()).collect::<Vec<_>>().join(" "))?);
        mask.extend(restriction.iter().map(|t| t.span));
    }
    let mut masked = source.to_string();
    for span in mask.into_iter().rev() {
        let start = offset(source, span.start)?;
        let end = offset(source, span.end)?;
        let spaces: String =
            source[start..end].chars().map(|c| if matches!(c, '\r' | '\n') { c } else { ' ' }).collect();
        masked.replace_range(start..end, &spaces);
    }
    let mut statements = Parser::parse_sql(&OracleDialect {}, &masked)
        .map_err(|e| format!("Cannot safely parse the complete view: {e}"))?;
    if statements.len() != 1 {
        return Err("Exactly one CREATE VIEW statement is required.".into());
    }
    match statements.remove(0) {
        Statement::CreateView(view) if !view.materialized && !view.or_alter && !view.if_not_exists => {
            Ok((view, properties, tokens))
        }
        _ => Err("Only ordinary CREATE VIEW statements can be rebuilt.".into()),
    }
}

fn canonical_tokens(source: &str) -> Result<Vec<String>, String> {
    Ok(significant_tokens(source)?
        .iter()
        .map(|token| match &token.token {
            Token::Word(w) => {
                format!("word:{}", if w.quote_style.is_some() { w.value.clone() } else { w.value.to_uppercase() })
            }
            other => format!("{other:?}"),
        })
        .collect())
}

// Keep each hint attached to its query block, and prevent single-line Display
// output from turning the rest of the formatted statement into a comment.
fn take_hint_fingerprints(query: &mut Query, output: &mut Vec<Vec<String>>) -> Result<(), String> {
    if let Some(with) = &mut query.with {
        for cte in &mut with.cte_tables {
            take_hint_fingerprints(&mut cte.query, output)?;
        }
    }
    let SetExpr::Select(select) = query.body.as_mut() else {
        return Err("Unsupported query block.".into());
    };
    let mut block = Vec::new();
    for hint in &select.optimizer_hints {
        let tokens = significant_tokens(&hint.text)?;
        let known = hint.prefix.is_empty() && hint_arguments(&tokens).is_some();
        block.push(if known {
            let semantic: Vec<_> = tokens
                .iter()
                .map(|token| match &token.token {
                    Token::Word(w) if w.quote_style.is_some() => format!("quoted:{}", w.value),
                    Token::Word(w) => format!("word:{}", w.value.to_uppercase()),
                    other => format!("{other:?}"),
                })
                .collect();
            serde_json::to_string(&semantic).map_err(|e| e.to_string())?
        } else {
            format!("{}+{}", hint.prefix, hint.text)
        });
    }
    output.push(block);
    select.optimizer_hints.clear();
    Ok(())
}

// Return only table-spec tokens, never INDEX's index names or QB_NAME's block name.
fn hint_arguments(tokens: &[TokenWithSpan]) -> Option<Vec<usize>> {
    let mut tables = Vec::new();
    let mut pos = 0;
    while pos < tokens.len() {
        let Token::Word(name) = &tokens[pos].token else {
            return None;
        };
        if name.quote_style.is_some() {
            return None;
        }
        let name = name.value.to_uppercase();
        pos += 1;
        if matches!(name.as_str(), "ALL_ROWS" | "FIRST_ROWS" | "RULE")
            && !tokens.get(pos).is_some_and(|t| t.token == Token::LParen)
        {
            continue;
        }
        if !tokens.get(pos).is_some_and(|t| t.token == Token::LParen) {
            return None;
        }
        pos += 1;
        let start = pos;
        while tokens
            .get(pos)
            .is_some_and(|t| matches!(&t.token, Token::Word(w) if w.quote_style.is_some() || !w.value.contains('@')))
        {
            pos += 1;
        }
        if pos == start || !tokens.get(pos).is_some_and(|t| t.token == Token::RParen) {
            return None;
        }
        match name.as_str() {
            "FULL" | "QB_NAME" if pos - start == 1 => {
                if name == "FULL" {
                    tables.push(start);
                }
            }
            "INDEX" | "INDEX_ASC" | "INDEX_DESC" | "INDEX_FFS" | "NO_INDEX" => tables.push(start),
            "LEADING" | "USE_NL" | "USE_HASH" => tables.extend(start..pos),
            _ => return None,
        }
        pos += 1;
    }
    Some(tables)
}

fn hint_name(token: &TokenWithSpan) -> Option<String> {
    match &token.token {
        Token::Word(w) => Some(if w.quote_style.is_some() { w.value.clone() } else { w.value.to_uppercase() }),
        _ => None,
    }
}

fn hint_groups(tokens: &[TokenWithSpan]) -> Vec<&[TokenWithSpan]> {
    let mut groups = Vec::new();
    let mut start = 0;
    while start < tokens.len() {
        let mut end = start + 1;
        if tokens.get(end).is_some_and(|t| t.token == Token::LParen) {
            let mut depth = 0;
            while end < tokens.len() {
                match tokens[end].token {
                    Token::LParen => depth += 1,
                    Token::RParen => depth -= 1,
                    _ => {}
                }
                end += 1;
                if depth == 0 {
                    break;
                }
            }
        }
        groups.push(&tokens[start..end]);
        start = end;
    }
    groups
}

fn hint_bindings(query: &Query) -> Result<Vec<Vec<Vec<usize>>>, String> {
    let mut blocks = Vec::new();
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            blocks.extend(hint_bindings(&cte.query)?);
        }
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return Err("Unsupported query block.".into());
    };
    let mut exposed = Vec::new();
    for from in &select.from {
        for relation in std::iter::once(&from.relation).chain(from.joins.iter().map(|j| &j.relation)) {
            let TableFactor::Table { name, alias, .. } = relation else {
                return Err("Unsupported relation.".into());
            };
            exposed.push(if let Some(alias) = alias {
                canonical(&alias.name)
            } else {
                canonical(name_parts(name)?.last().ok_or("Empty relation name.")?)
            });
        }
    }
    let mut block = Vec::new();
    for hint in &select.optimizer_hints {
        if !hint.prefix.is_empty() {
            continue;
        }
        let tokens = significant_tokens(&hint.text)?;
        for group in hint_groups(&tokens) {
            if let Some(args) = hint_arguments(group) {
                for arg in args {
                    let name = hint_name(&group[arg]).ok_or("Invalid hint identifier.")?;
                    block.push(
                        exposed.iter().enumerate().filter(|(_, value)| **value == name).map(|(i, _)| i).collect(),
                    );
                }
            }
        }
    }
    blocks.push(block);
    Ok(blocks)
}

fn rewrite_hints(
    select: &Select,
    bindings: &[Binding],
    input: &OracleViewRenameSourceInput,
    edits: &mut Vec<Edit>,
    issues: &mut Vec<OracleViewRenameIssue>,
) -> Result<(), String> {
    use sqlparser::ast::OptimizerHintStyle;
    use sqlparser::tokenizer::Whitespace;
    if select.optimizer_hints.is_empty() {
        return Ok(());
    }
    let original =
        Tokenizer::new(&OracleDialect {}, &input.source).tokenize_with_location().map_err(|e| e.to_string())?;
    let select_index = original
        .iter()
        .position(|t| t.span == select.select_token.0.span && word(t, "SELECT"))
        .ok_or("Missing original SELECT token.")?;
    let mut comments = Vec::new();
    for token in original.iter().skip(select_index + 1) {
        let Token::Whitespace(whitespace) = &token.token else {
            break;
        };
        let (text, style, marker) = match whitespace {
            Whitespace::MultiLineComment(text) => (text, OptimizerHintStyle::MultiLine, 2),
            Whitespace::SingleLineComment { comment, prefix } => {
                (comment, OptimizerHintStyle::SingleLine { prefix: prefix.clone() }, prefix.len())
            }
            _ => continue,
        };
        if let Some(plus) = text.find('+') {
            if text[..plus].chars().all(|c| c.is_ascii_alphanumeric()) {
                comments.push((token, &text[..plus], &text[plus + 1..], style, marker + plus + 1));
            }
        }
    }
    if comments.len() != select.optimizer_hints.len() {
        return Err("Original hint comments do not match parsed hints.".into());
    }
    for (hint, (comment, prefix, text, style, marker)) in select.optimizer_hints.iter().zip(comments) {
        if hint.prefix != prefix || hint.text != text || hint.style != style {
            return Err("Original hint comment does not match parsed hint.".into());
        }
        let tokens = significant_tokens(text)?;
        let affected = bindings.iter().any(|b| b.renamed) && input.old_name != input.new_name;
        if !affected {
            continue;
        }
        let mut problem = None;
        for group in hint_groups(&tokens) {
            let table_args = if prefix.is_empty() { hint_arguments(group) } else { None };
            let related = group.iter().any(|token| {
                let Token::Word(w) = &token.token else {
                    return false;
                };
                if w.quote_style.is_some() {
                    return w.value == input.old_name || w.value == input.new_name;
                }
                w.value.split('@').any(|part| {
                    let name = part.to_uppercase();
                    name == input.old_name || name == input.new_name
                })
            });
            if let Some(args) = table_args {
                for index in args {
                    let name = hint_name(&group[index]).ok_or("Invalid hint identifier.")?;
                    let before: Vec<_> =
                        bindings.iter().enumerate().filter(|(_, b)| b.exposed == name).map(|(i, _)| i).collect();
                    if before.is_empty() && name == input.old_name {
                        problem = Some((
                            "unsupported_hint",
                            "This hint names the renamed relation instead of its visible query alias.",
                        ));
                        break;
                    }
                    let replacement =
                        if before.len() == 1 && bindings[before[0]].renamed && !bindings[before[0]].aliased {
                            input.new_name.as_str()
                        } else {
                            name.as_str()
                        };
                    let after: Vec<_> = bindings
                        .iter()
                        .enumerate()
                        .filter(|(_, b)| {
                            (if b.renamed && !b.aliased { &input.new_name } else { &b.exposed }) == replacement
                        })
                        .map(|(i, _)| i)
                        .collect();
                    if before.len() > 1 && before.iter().any(|i| bindings[*i].renamed && !bindings[*i].aliased) {
                        problem = Some((
                            "ambiguous_binding",
                            "An optimizer hint table-spec has ambiguous relation bindings.",
                        ));
                        break;
                    }
                    if before != after {
                        problem = Some(("hint_capture", "Renaming would change an optimizer hint's relation binding."));
                        break;
                    }
                    if replacement != name {
                        let base = offset(&input.source, comment.span.start)? + marker;
                        edits.push(Edit {
                            start: base + offset(text, group[index].span.start)?,
                            end: base + offset(text, group[index].span.end)?,
                            value: format!("\"{}\"", replacement.replace('"', "\"\"")),
                        });
                    }
                }
            } else if related {
                problem = Some((
                    "unsupported_hint",
                    "This optimizer hint may refer to the renamed relation but its table-spec cannot be safely bound.",
                ));
            }
            if problem.is_some() {
                break;
            }
        }
        if let Some((code, message)) = problem {
            issues.push(OracleViewRenameIssue {
                code: code.into(),
                message: format!("{} [{}]", message, text),
                view_name: input.view_name.clone(),
                hint_text: Some(text.into()),
                location: Some(OracleViewRenameIssueLocation {
                    line: comment.span.start.line,
                    column: comment.span.start.column,
                    end_line: comment.span.end.line,
                    end_column: comment.span.end.column,
                }),
                repairable: true,
            });
        }
    }
    Ok(())
}

#[derive(Debug)]
struct Edit {
    start: usize,
    end: usize,
    value: String,
}

fn offset(source: &str, target: Location) -> Result<usize, String> {
    let (mut line, mut column) = (1, 1);
    for (index, ch) in source.char_indices() {
        if (line, column) == (target.line, target.column) {
            return Ok(index);
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    if (line, column) == (target.line, target.column) {
        Ok(source.len())
    } else {
        Err("Invalid SQL identifier span.".into())
    }
}

fn add_ident_edit(source: &str, ident: &Ident, replacement: &str, edits: &mut Vec<Edit>) -> Result<(), String> {
    if canonical(ident) == replacement {
        return Ok(());
    }
    let start = offset(source, ident.span.start)?;
    let end = offset(source, ident.span.end)?;
    let original = source.get(start..end).ok_or("Invalid SQL identifier range.")?;
    let tokens = significant_tokens(original)?;
    if !matches!(tokens.as_slice(), [TokenWithSpan { token: Token::Word(w), .. }] if w.value == ident.value && w.quote_style == ident.quote_style)
    {
        return Err("The parsed identifier does not match its original SQL token.".into());
    }
    edits.push(Edit { start, end, value: format!("\"{}\"", replacement.replace('"', "\"\"")) });
    Ok(())
}

fn apply_edits(source: &str, mut edits: Vec<Edit>) -> Result<String, String> {
    edits.sort_by_key(|e| (e.start, e.end));
    edits.dedup_by(|a, b| a.start == b.start && a.end == b.end && a.value == b.value);
    if edits.windows(2).any(|pair| pair[0].end > pair[1].start) {
        return Err("Overlapping SQL identifier edits.".into());
    }
    let mut result = source.to_string();
    for edit in edits.into_iter().rev() {
        result.replace_range(edit.start..edit.end, &edit.value);
    }
    Ok(result)
}

#[derive(Clone)]
struct Binding {
    exposed: String,
    owner: String,
    name: String,
    renamed: bool,
    aliased: bool,
}

fn rewrite_query(
    query: &Query,
    inherited_ctes: &[String],
    input: &OracleViewRenameSourceInput,
    edits: &mut Vec<Edit>,
    issues: &mut Vec<OracleViewRenameIssue>,
    references: &mut Vec<OracleViewRenameReference>,
) -> Result<(), String> {
    let mut ctes = inherited_ctes.to_vec();
    if let Some(with) = &query.with {
        if with.recursive {
            return Err("Recursive CTE references cannot be safely renamed automatically.".into());
        }
        for cte in &with.cte_tables {
            let name = canonical(&cte.alias.name);
            if ctes.contains(&name) {
                return Err("Shadowed CTE names require manual review.".into());
            }
            let mut body_ctes = ctes.clone();
            // Prevent new self/forward CTE references without hiding old physical relations.
            if input.new_name != input.old_name
                && !body_ctes.contains(&input.new_name)
                && with.cte_tables.iter().any(|candidate| canonical(&candidate.alias.name) == input.new_name)
            {
                body_ctes.push(input.new_name.clone());
            }
            rewrite_query(&cte.query, &body_ctes, input, edits, issues, references)?;
            ctes.push(name);
        }
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return Err("Set operations and nested query blocks require manual dependency review.".into());
    };
    if !query.locks.is_empty()
        || query.for_clause.is_some()
        || query.settings.is_some()
        || query.format_clause.is_some()
        || !query.pipe_operators.is_empty()
    {
        return Err("Unsupported view query clause.".into());
    }
    let mut bindings = Vec::new();
    for from in &select.from {
        add_binding(&from.relation, &ctes, input, &mut bindings, edits, references)?;
        for join in &from.joins {
            add_binding(&join.relation, &ctes, input, &mut bindings, edits, references)?;
        }
    }
    if bindings.iter().any(|b| b.renamed && !b.aliased)
        && bindings.iter().any(|b| (!b.renamed || b.aliased) && b.exposed == input.new_name)
    {
        return Err("The new name would collide with an existing query alias or relation.".into());
    }
    rewrite_hints(select, &bindings, input, edits, issues)?;
    let mut visitor = References { input, bindings: &bindings, edits };
    visit_result(select.visit(&mut visitor))?;
    visit_result(query.order_by.visit(&mut visitor))?;
    visit_result(query.limit_clause.visit(&mut visitor))?;
    visit_result(query.fetch.visit(&mut visitor))?;
    Ok(())
}

fn add_binding(
    table: &TableFactor,
    ctes: &[String],
    input: &OracleViewRenameSourceInput,
    bindings: &mut Vec<Binding>,
    edits: &mut Vec<Edit>,
    references: &mut Vec<OracleViewRenameReference>,
) -> Result<(), String> {
    let TableFactor::Table {
        name,
        alias,
        args,
        with_hints,
        version,
        with_ordinality,
        partitions,
        json_path,
        sample,
        index_hints,
    } = table
    else {
        return Err("Derived tables, table functions and special table sources require manual review.".into());
    };
    if args.is_some()
        || !with_hints.is_empty()
        || version.is_some()
        || *with_ordinality
        || !partitions.is_empty()
        || json_path.is_some()
        || sample.is_some()
        || !index_hints.is_empty()
    {
        return Err("Unsupported qualified table source.".into());
    }
    let parts = name_parts(name)?;
    if parts.iter().any(|part| part.quote_style.is_none() && part.value.contains('@')) {
        return Err("Database links require manual dependency review.".into());
    }
    if parts.is_empty() || parts.len() > 2 {
        return Err("Database links and multi-part relation names require manual review.".into());
    }
    let relation_name = canonical(parts[parts.len() - 1]);
    let owner = if parts.len() == 2 { canonical(parts[0]) } else { input.owner.clone() };
    let is_cte = parts.len() == 1 && ctes.contains(&relation_name);
    if !is_cte {
        let reference = OracleViewRenameReference { owner: owner.clone(), name: relation_name.clone() };
        if !references.contains(&reference) {
            references.push(reference);
        }
    }
    let renamed = !is_cte && owner == input.owner && relation_name == input.old_name;
    if renamed {
        if parts.len() == 1 && ctes.contains(&input.new_name) {
            return Err("The new view name would bind to a CTE.".into());
        }
        add_ident_edit(&input.source, parts[parts.len() - 1], &input.new_name, edits)?;
    }
    bindings.push(Binding {
        exposed: alias.as_ref().map(|a| canonical(&a.name)).unwrap_or_else(|| relation_name.clone()),
        owner,
        name: relation_name,
        renamed,
        aliased: alias.is_some(),
    });
    Ok(())
}

struct References<'a> {
    input: &'a OracleViewRenameSourceInput,
    bindings: &'a [Binding],
    edits: &'a mut Vec<Edit>,
}

impl References<'_> {
    fn qualifier(&mut self, parts: &[&Ident]) -> Result<(), String> {
        if parts.is_empty() {
            return Ok(());
        }
        if parts.len() > 2 {
            return Err("Multi-part expression qualifiers require manual review.".into());
        }
        let name = canonical(parts[parts.len() - 1]);
        let matches: Vec<_> = self
            .bindings
            .iter()
            .filter(|binding| {
                if parts.len() == 1 {
                    binding.exposed == name
                } else {
                    !binding.aliased && binding.owner == canonical(parts[0]) && binding.name == name
                }
            })
            .collect();
        if matches.iter().any(|b| b.renamed && !b.aliased) {
            if matches.len() != 1 {
                return Err("An ambiguous relation qualifier cannot be renamed safely.".into());
            }
            add_ident_edit(&self.input.source, parts[parts.len() - 1], &self.input.new_name, self.edits)?;
        }
        Ok(())
    }

    fn function_arguments(&mut self, args: &FunctionArguments) -> Result<(), String> {
        if let FunctionArguments::List(list) = args {
            for arg in &list.args {
                let arg = match arg {
                    FunctionArg::Named { arg, .. } | FunctionArg::ExprNamed { arg, .. } | FunctionArg::Unnamed(arg) => {
                        arg
                    }
                };
                if let FunctionArgExpr::QualifiedWildcard(name) = arg {
                    self.qualifier(&name_parts(name)?)?;
                }
            }
        }
        Ok(())
    }
}

fn visit_result(flow: ControlFlow<String>) -> Result<(), String> {
    match flow {
        ControlFlow::Continue(()) => Ok(()),
        ControlFlow::Break(error) => Err(error),
    }
}

impl Visitor for References<'_> {
    type Break = String;

    fn pre_visit_query(&mut self, _: &Query) -> ControlFlow<Self::Break> {
        ControlFlow::Break("Subqueries may contain correlated references and require manual review.".into())
    }

    fn pre_visit_select(&mut self, select: &Select) -> ControlFlow<Self::Break> {
        if !select.lateral_views.is_empty() || !select.connect_by.is_empty() || select.into.is_some() {
            return ControlFlow::Break("Special Oracle query scopes require manual review.".into());
        }
        for item in &select.projection {
            if matches!(item, SelectItem::QualifiedWildcard(SelectItemQualifiedWildcardKind::Expr(_), _)) {
                return ControlFlow::Break("Expression-qualified wildcards require manual review.".into());
            }
            if let SelectItem::QualifiedWildcard(SelectItemQualifiedWildcardKind::ObjectName(name), _) = item {
                match name_parts(name).and_then(|parts| self.qualifier(&parts)) {
                    Ok(()) => {}
                    Err(e) => return ControlFlow::Break(e),
                }
            }
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<Self::Break> {
        let result = match expr {
            Expr::CompoundIdentifier(parts) => self.qualifier(&parts[..parts.len() - 1].iter().collect::<Vec<_>>()),
            Expr::QualifiedWildcard(name, _) => name_parts(name).and_then(|parts| self.qualifier(&parts)),
            Expr::Function(function) => {
                self.function_arguments(&function.args).and_then(|_| self.function_arguments(&function.parameters))
            }
            _ => Ok(()),
        };
        match result {
            Ok(()) => ControlFlow::Continue(()),
            Err(e) => ControlFlow::Break(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(source: &str) -> OracleViewRenameSourceInput {
        OracleViewRenameSourceInput {
            source: source.into(),
            owner: "APP".into(),
            view_name: "DEP".into(),
            old_name: "OLD".into(),
            new_name: "New View".into(),
            target_view_name: None,
        }
    }

    #[test]
    fn accepts_one_oracle_identifier_and_rejects_extra_sql() {
        assert_eq!(parse_oracle_object_name(" new_view ").unwrap(), "NEW_VIEW");
        assert_eq!(parse_oracle_object_name("\"New View\"").unwrap(), "New View");
        for value in ["", "a.b", "a; DROP VIEW b", "a -- comment", "\"\"", "1abc", "SELECT", "`name`"] {
            assert!(parse_oracle_object_name(value).is_err(), "{value}");
        }
    }

    #[test]
    fn preserves_source_and_changes_bound_relations_and_qualifiers() {
        let source = "CREATE VIEW \"APP\".\"DEP\" (\"列\") AS\r\nSELECT /*+ ALL_ROWS */ OLD.N FROM APP.OLD -- OLD\r\nWHERE OLD.N > 1 AND 'OLD' = 'OLD' WITH READ ONLY";
        let result = build_oracle_view_rename_source(input(source)).unwrap();
        assert_eq!(result.source, "CREATE OR REPLACE VIEW \"APP\".\"DEP\" (\"列\") AS\r\nSELECT /*+ ALL_ROWS */ \"New View\".N FROM APP.\"New View\" -- OLD\r\nWHERE \"New View\".N > 1 AND 'OLD' = 'OLD' WITH READ ONLY");
    }

    #[test]
    fn rewrites_hints_whose_relation_spec_would_become_stale() {
        for source in [
            "CREATE VIEW DEP AS SELECT /*+ FULL(OLD) */ OLD.N FROM OLD",
            "CREATE VIEW DEP AS SELECT --+ INDEX(OLD IDX)\n OLD.N FROM OLD",
            "CREATE VIEW DEP AS SELECT /*+ LEADING(\"OLD\") */ * FROM APP.OLD",
        ] {
            assert!(build_oracle_view_rename_source(input(source)).is_ok(), "{source}");
        }
        for source in [
            "CREATE VIEW DEP AS SELECT /*+ FULL(X) */ X.N FROM OLD X",
            "CREATE VIEW DEP AS SELECT /*+ FULL(OLD) */ OLD.N FROM OLD OLD",
            "CREATE VIEW DEP AS SELECT /*+ FULL(OLD) */ OLD.N FROM OTHER.OLD",
            "CREATE VIEW DEP AS SELECT /* FULL(OLD) */ OLD.N FROM OLD",
        ] {
            assert!(build_oracle_view_rename_source(input(source)).is_ok(), "{source}");
        }
    }

    #[test]
    fn preserves_aliases_ctes_other_owners_and_literals() {
        let source = "CREATE VIEW DEP AS WITH OLD AS (SELECT * FROM OTHER.OLD) SELECT OLD.N, X.N FROM OLD JOIN APP.OLD X ON OLD.N = X.N";
        let result = build_oracle_view_rename_source(input(source)).unwrap();
        assert_eq!(result.source, "CREATE OR REPLACE VIEW DEP AS WITH OLD AS (SELECT * FROM OTHER.OLD) SELECT OLD.N, X.N FROM OLD JOIN APP.\"New View\" X ON OLD.N = X.N");
    }

    #[test]
    fn indirect_dependencies_keep_their_query_and_properties() {
        let source = "CREATE OR REPLACE FORCE VIEW DEP (N) AS SELECT N FROM INTERMEDIATE WITH CHECK OPTION";
        assert_eq!(build_oracle_view_rename_source(input(source)).unwrap().source, source);
    }

    #[test]
    fn refuses_wrong_declaration_multiple_statements_and_uncertain_bindings() {
        for source in [
            "SELECT N FROM OLD",
            "CREATE VIEW OTHER.DEP AS SELECT N FROM OLD",
            "CREATE VIEW WRONG AS SELECT N FROM OLD",
            "CREATE VIEW DEP AS SELECT N FROM OLD; DROP VIEW OLD",
            "CREATE VIEW DEP AS SELECT OLD.N FROM OLD, OTHER.OLD",
            "CREATE VIEW DEP AS SELECT (SELECT OLD.N FROM DUAL) FROM OLD",
            "CREATE VIEW DEP AS SELECT * FROM OLD@REMOTE",
        ] {
            assert!(build_oracle_view_rename_source(input(source)).is_err(), "{source}");
        }
    }

    #[test]
    fn fingerprint_ignores_format_but_preserves_literal_and_view_properties() {
        let a = build_oracle_view_rename_source(input("CREATE VIEW DEP AS SELECT 'a b' N FROM OLD WITH READ ONLY"))
            .unwrap();
        let b = build_oracle_view_rename_source(input("create view DEP as\n select 'a b' N from OLD with read only;"))
            .unwrap();
        let c =
            build_oracle_view_rename_source(input("CREATE VIEW DEP AS SELECT 'ab' N FROM OLD WITH READ ONLY")).unwrap();
        let d = build_oracle_view_rename_source(input("CREATE VIEW DEP AS SELECT 'a b' N FROM OLD")).unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_ne!(a.fingerprint, c.fingerprint);
        assert_ne!(a.fingerprint, d.fingerprint);
    }

    #[test]
    fn rewrites_quoted_names_stars_and_order_by_without_touching_aliases() {
        let mut request = input("CREATE VIEW DEP AS SELECT \"old\".*, X.N FROM \"old\" JOIN OTHER.\"old\" X ON \"old\".N = X.N ORDER BY \"old\".N");
        request.old_name = "old".into();
        let result = build_oracle_view_rename_source(request).unwrap();
        assert_eq!(result.source, "CREATE OR REPLACE VIEW DEP AS SELECT \"New View\".*, X.N FROM \"New View\" JOIN OTHER.\"old\" X ON \"New View\".N = X.N ORDER BY \"New View\".N");
        let result =
            build_oracle_view_rename_source(input("CREATE VIEW DEP AS SELECT OLD.N FROM APP.OLD OLD")).unwrap();
        assert_eq!(result.source, "CREATE OR REPLACE VIEW DEP AS SELECT OLD.N FROM APP.\"New View\" OLD");
    }

    #[test]
    fn matches_schema_qualified_columns_and_respects_case_sensitive_names() {
        let result = build_oracle_view_rename_source(input(
            "CREATE VIEW DEP AS SELECT APP.OLD.N, OTHER.OLD.N FROM APP.OLD JOIN OTHER.OLD ON APP.OLD.N = OTHER.OLD.N",
        ))
        .unwrap();
        assert_eq!(result.source, "CREATE OR REPLACE VIEW DEP AS SELECT APP.\"New View\".N, OTHER.OLD.N FROM APP.\"New View\" JOIN OTHER.OLD ON APP.\"New View\".N = OTHER.OLD.N");
        let source = "CREATE OR REPLACE VIEW DEP AS SELECT \"old\".N FROM \"old\"";
        assert_eq!(build_oracle_view_rename_source(input(source)).unwrap().source, source);
    }

    #[test]
    fn fingerprints_renamed_declaration_like_database_readback() {
        let mut request = input("CREATE OR REPLACE FORCE VIEW APP.DEP (N) AS SELECT 42 FROM DUAL WITH READ ONLY");
        request.target_view_name = Some("Renamed".into());
        let expected = build_oracle_view_rename_source(request).unwrap();
        let mut readback = input("CREATE VIEW \"Renamed\" (N) AS\n SELECT 42 FROM DUAL WITH READ ONLY;");
        readback.view_name = "Renamed".into();
        assert_eq!(expected.fingerprint, build_oracle_view_rename_source(readback).unwrap().fingerprint);
    }

    #[test]
    fn rejects_new_name_capture_and_preserves_previous_cte_bindings() {
        for source in [
            "CREATE VIEW DEP AS WITH \"New View\" AS (SELECT 1 FROM DUAL) SELECT * FROM OLD",
            "CREATE VIEW DEP AS SELECT OLD.N FROM OLD, OTHER.T \"New View\"",
            "CREATE VIEW DEP AS SELECT OLD.N FROM OLD, OLD \"New View\"",
            "CREATE VIEW DEP AS SELECT * FROM (SELECT * FROM OLD)",
            "CREATE VIEW DEP AS SELECT * FROM OLD UNION SELECT * FROM OLD",
        ] {
            assert!(build_oracle_view_rename_source(input(source)).is_err(), "{source}");
        }
        let result = build_oracle_view_rename_source(input(
            "CREATE VIEW DEP AS WITH X AS (SELECT * FROM OLD), Y AS (SELECT * FROM X) SELECT * FROM Y",
        ))
        .unwrap();
        assert_eq!(result.source, "CREATE OR REPLACE VIEW DEP AS WITH X AS (SELECT * FROM \"New View\"), Y AS (SELECT * FROM X) SELECT * FROM Y");
    }

    #[test]
    fn rejects_current_cte_capture_but_keeps_qualified_references() {
        let mut request = input("CREATE VIEW DEP AS WITH \"NEW\" AS (SELECT * FROM OLD) SELECT * FROM \"NEW\"");
        request.new_name = "NEW".into();
        assert!(build_oracle_view_rename_source(request).is_err());

        let mut request = input("CREATE VIEW DEP AS WITH \"NEW\" AS (SELECT * FROM APP.OLD) SELECT * FROM \"NEW\"");
        request.new_name = "NEW".into();
        assert_eq!(
            build_oracle_view_rename_source(request).unwrap().source,
            "CREATE OR REPLACE VIEW DEP AS WITH \"NEW\" AS (SELECT * FROM APP.\"NEW\") SELECT * FROM \"NEW\""
        );

        let mut request = input("CREATE VIEW DEP AS WITH \"new\" AS (SELECT * FROM OLD) SELECT * FROM \"new\"");
        request.new_name = "NEW".into();
        assert_eq!(
            build_oracle_view_rename_source(request).unwrap().source,
            "CREATE OR REPLACE VIEW DEP AS WITH \"new\" AS (SELECT * FROM \"NEW\") SELECT * FROM \"new\""
        );
    }

    #[test]
    fn rejects_capture_by_a_later_cte() {
        let mut request = input(
            "CREATE VIEW DEP AS WITH X AS (SELECT * FROM OLD), \"NEW\" AS (SELECT 1 N FROM DUAL) SELECT * FROM X",
        );
        request.new_name = "NEW".into();
        assert!(build_oracle_view_rename_source(request).is_err());
        let mut request = input(
            "CREATE VIEW DEP AS WITH X AS (SELECT * FROM APP.OLD), \"NEW\" AS (SELECT 1 N FROM DUAL) SELECT * FROM X",
        );
        request.new_name = "NEW".into();
        assert_eq!(build_oracle_view_rename_source(request).unwrap().source,
            "CREATE OR REPLACE VIEW DEP AS WITH X AS (SELECT * FROM APP.\"NEW\"), \"NEW\" AS (SELECT 1 N FROM DUAL) SELECT * FROM X");
    }

    #[test]
    fn preserves_escaped_identifiers_comments_and_constraint_names() {
        let mut request = input("CREATE /* 保留 */ VIEW DEP AS SELECT \"old\"\"name\".N FROM \"old\"\"name\" WITH CHECK OPTION CONSTRAINT \"中文约束\"");
        request.old_name = "old\"name".into();
        request.new_name = "新\"名".into();
        assert_eq!(build_oracle_view_rename_source(request).unwrap().source, "CREATE OR REPLACE /* 保留 */ VIEW DEP AS SELECT \"新\"\"名\".N FROM \"新\"\"名\" WITH CHECK OPTION CONSTRAINT \"中文约束\"");
    }

    #[test]
    fn rewrites_hint_table_roles_and_preserves_other_parameters() {
        let source = "CREATE VIEW DEP AS\r\nSELECT /*+ FULL(OLD) INDEX(OLD OLD IDX) QB_NAME(OLD) LEADING(OLD X) USE_NL(OLD X) USE_HASH(X OLD) MYSTERY(X) */ 'OLD' N FROM APP.OLD JOIN OTHER.T X ON 1=1";
        let result = build_oracle_view_rename_source(input(source)).unwrap();
        assert!(result.source.contains("FULL(\"New View\") INDEX(\"New View\" OLD IDX) QB_NAME(OLD) LEADING(\"New View\" X) USE_NL(\"New View\" X) USE_HASH(X \"New View\") MYSTERY(X)"));
        for name in ["INDEX_ASC", "INDEX_DESC", "INDEX_FFS", "NO_INDEX"] {
            let result = build_oracle_view_rename_source(input(&format!(
                "CREATE VIEW DEP AS SELECT --+ {name}(OLD IDX)\r\n OLD.N FROM OLD"
            )))
            .unwrap();
            assert!(result.source.contains(&format!("--+ {name}(\"New View\" IDX)\r\n")));
        }
        let result =
            build_oracle_view_rename_source(input("CREATE VIEW DEP AS SELECT /*+ INDEX(T OLD) */ * FROM OLD T"))
                .unwrap();
        assert!(result.source.contains("INDEX(T OLD)"));
    }

    #[test]
    fn reports_related_unsupported_hints_and_binding_capture_with_locations() {
        for hint in ["FULL(OLD@Q)", "FULL(APP.OLD)", "LEADING((OLD X))", "UNKNOWN(OLD)"] {
            let source = format!("CREATE VIEW DEP AS\r\nSELECT /*+ {hint} */ * FROM OLD");
            let review = review_oracle_view_rename_source(input(&source));
            assert!(review.source.is_some(), "{hint}");
            assert_eq!(review.issues[0].code, "unsupported_hint");
            assert_eq!(review.issues[0].location.as_ref().unwrap().line, 2);
            assert_eq!(review.issues[0].location.as_ref().unwrap().column, 8);
            assert!(review.issues[0].hint_text.as_ref().unwrap().contains(hint));
            let proposed = review.source.unwrap().source;
            assert!(proposed.contains(hint), "unsupported hint must remain visible for manual repair: {proposed}");
            assert!(
                proposed.contains("FROM \"New View\""),
                "safe relation rewrite should remain available: {proposed}"
            );
        }
        let review =
            review_oracle_view_rename_source(input("CREATE VIEW DEP AS SELECT /*+ FULL(\"New View\") */ * FROM OLD"));
        assert_eq!(review.issues[0].code, "hint_capture");
        let review =
            review_oracle_view_rename_source(input("CREATE VIEW DEP AS SELECT /*+ FULL(OLD) */ * FROM OLD, OTHER.OLD"));
        assert_eq!(review.issues[0].code, "ambiguous_binding");
        assert_eq!(review.references.len(), 2);
        assert!(build_oracle_view_rename_source(input("CREATE VIEW DEP AS SELECT /*+ UNKNOWN(X@Q) */ * FROM OLD X"))
            .is_ok());

        let source = "CREATE VIEW \"DBX_G8_HINT\" (\"Value X\") AS SELECT /*+ FULL(DBX_G8_BASE@Q) */ \"Value X\" FROM DBX_G8_BASE B";
        let mut request = input(source);
        request.owner = "DBX_G8_UI_261013".into();
        request.view_name = "DBX_G8_HINT".into();
        request.old_name = "DBX_G8_BASE".into();
        request.new_name = "DBX_G8_BASE_NEW".into();
        let review = review_oracle_view_rename_source(request);
        assert!(review.issues.iter().any(|issue| issue.code == "unsupported_hint"));
        assert!(review.source.unwrap().source.contains("FROM \"DBX_G8_BASE_NEW\" B"));
    }

    #[test]
    fn keeps_hint_bindings_separate_across_repeated_cte_comments() {
        let source = "CREATE VIEW DEP AS WITH X AS (SELECT /*+ FULL(OLD) */ * FROM OTHER.OLD), Y AS (SELECT /*+ FULL(OLD) */ * FROM APP.OLD) SELECT /*+ FULL(X) */ * FROM X, Y";
        let result = build_oracle_view_rename_source(input(source)).unwrap();
        assert!(result.source.contains("SELECT /*+ FULL(OLD) */ * FROM OTHER.OLD"));
        assert!(result.source.contains("SELECT /*+ FULL(\"New View\") */ * FROM APP.\"New View\""));
        assert_eq!(
            result.references,
            vec![
                OracleViewRenameReference { owner: "OTHER".into(), name: "OLD".into() },
                OracleViewRenameReference { owner: "APP".into(), name: "OLD".into() }
            ]
        );
    }

    #[test]
    fn fingerprints_hint_semantics_and_single_line_sql_body() {
        let fingerprint = |sql: &str| build_oracle_view_rename_source(input(sql)).unwrap().fingerprint;
        let a = fingerprint("CREATE VIEW DEP AS SELECT --+ FULL(OLD)\n N FROM OLD WHERE N=1");
        assert_eq!(a, fingerprint("create view DEP as SELECT /*+ full( old ) */ N from OLD -- ordinary\n where N = 1"));
        assert_ne!(a, fingerprint("CREATE VIEW DEP AS SELECT --+ FULL(OLD)\n N FROM OLD WHERE N=2"));
        assert_ne!(a, fingerprint("CREATE VIEW DEP AS SELECT /*+ INDEX(OLD IDX) */ N FROM OLD WHERE N=1"));
        assert_ne!(
            fingerprint("CREATE VIEW DEP AS SELECT /*+ UNKNOWN('a') */ N FROM OLD"),
            fingerprint("CREATE VIEW DEP AS SELECT /*+ UNKNOWN('b') */ N FROM OLD")
        );
        let source =
            build_oracle_view_rename_source(input("CREATE VIEW DEP AS SELECT --+ INDEX(OLD IDX)\n OLD.N FROM OLD"))
                .unwrap();
        assert_eq!(source.fingerprint, build_oracle_view_rename_source(input(&source.source)).unwrap().fingerprint);
    }

    #[test]
    fn review_returns_parse_problem_without_a_source() {
        let review = review_oracle_view_rename_source(input("CREATE VIEW DEP AS unsupported original"));
        assert!(review.source.is_none());
        assert_eq!(review.issues[0].code, "invalid_definition");
        assert!(review.issues[0].location.is_some());
        let declaration = review_oracle_view_rename_source(input("CREATE VIEW WRONG AS SELECT 1 FROM OLD"));
        assert_eq!(declaration.issues[0].code, "invalid_declaration");
        assert!(declaration.issues[0].location.is_some());
    }
}
