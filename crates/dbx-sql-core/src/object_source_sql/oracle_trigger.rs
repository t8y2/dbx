//! Lossless trigger header edits, not a second PL/SQL parser. Dictionary identity,
//! privileges and concurrent changes are checked by the caller's execution plan.
use std::ops::Range;

use serde::{Deserialize, Serialize};
use sqlparser::tokenizer::TokenWithSpan;

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OracleTriggerSqlPurpose {
    Inspect,
    Create,
    Replace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTriggerSqlBinding {
    /// TABLE, VIEW, SCHEMA, DATABASE or TIMER, verified by the caller.
    pub scope: String,
    pub owner: Option<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub pluggable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTriggerSqlHeader {
    /// RELATION needs a dictionary lookup to distinguish TABLE from VIEW.
    pub scope: String,
    pub owner: Option<String>,
    pub name: Option<String>,
    pub view_only: bool,
    pub pluggable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTriggerSqlInput {
    pub database_type: DatabaseType,
    pub owner: String,
    pub name: String,
    pub source: String,
    pub purpose: OracleTriggerSqlPurpose,
    pub binding: Option<OracleTriggerSqlBinding>,
    pub enabled: Option<bool>,
    /// Only a trusted metadata export may contain the same target's state DDL.
    #[serde(default)]
    pub allow_export_appendix: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedOracleTriggerSql {
    pub definition: String,
    /// Whole source for readback comparison, with only the exported declaration
    /// wrapper canonicalized. Never execute this comparison form.
    pub comparison_source: String,
    pub header: OracleTriggerSqlHeader,
    pub inline_enabled: Option<bool>,
    pub export_enabled: Option<bool>,
    /// DM state restoration is a separately previewed and verified native step.
    pub requires_state_restore: bool,
    /// The complete header is representable by the timing/event/body form.
    pub structured_editable: bool,
}

struct TriggerTokens {
    source: String,
    lexical: String,
    tokens: Vec<TokenWithSpan>,
}

impl TriggerTokens {
    fn new(source: String, dm: bool) -> Result<Self, String> {
        let lexical = if dm { dm_lexical_view(&source) } else { source.clone() };
        let tokens = Tokenizer::new(&OracleDialect {}, &lexical)
            .tokenize_with_location()
            .map_err(|error| format!("Cannot tokenize trigger source: {error}"))?
            .into_iter()
            .filter(|token| !matches!(token.token, Token::Whitespace(_) | Token::EOF))
            .collect();
        Ok(Self { source, lexical, tokens })
    }

    fn token(&self, index: usize) -> Option<&Token> {
        self.tokens.get(index).map(|token| &token.token)
    }

    fn word(&self, index: usize, word: &str) -> bool {
        self.token(index).is_some_and(|token| token_unquoted_word_is(token, word))
    }

    fn range(&self, index: usize) -> Result<Range<usize>, String> {
        let token = self.tokens.get(index).ok_or("Incomplete trigger header")?;
        let start = routine_location_to_byte_offset(&self.source, token.span.start);
        let end = routine_location_to_byte_offset(&self.source, token.span.end);
        match (start, end) {
            (Some(start), Some(end)) if start < end && end <= self.source.len() => Ok(start..end),
            _ => Err("Cannot map trigger token positions to the source text".into()),
        }
    }

    fn identifier(&self, index: usize) -> Result<String, String> {
        match self.token(index) {
            Some(Token::Word(word)) if word.quote_style == Some('"') => Ok(word.value.clone()),
            // sqlparser's keyword set spans every dialect (including DATA).
            // Here the grammar already identifies an identifier position; a
            // write additionally binds this value to a dictionary target and
            // quotes it. Do not reject valid Oracle names using that union.
            Some(Token::Word(word)) if word.quote_style.is_none() && !word.value.contains('@') => {
                Ok(word.value.to_ascii_uppercase())
            }
            _ => Err("Trigger target must use a local Oracle identifier; quote reserved or special names".into()),
        }
    }

    fn qualified(&self, start: usize) -> Result<(Option<String>, String, usize), String> {
        let first = self.identifier(start)?;
        let result = if self.token(start + 1) == Some(&Token::Period) {
            (Some(first), self.identifier(start + 2)?, start + 3)
        } else {
            (None, first, start + 1)
        };
        if self.token(result.2) == Some(&Token::Period) {
            return Err("Three-part trigger targets are not supported".into());
        }
        Ok(result)
    }

    fn standalone_slash(&self, index: usize) -> Result<bool, String> {
        if self.token(index) != Some(&Token::Div) {
            return Ok(false);
        }
        let range = self.range(index)?;
        let start = self.source[..range.start].rfind('\n').map_or(0, |offset| offset + 1);
        let end = self.source[range.end..].find('\n').map_or(self.source.len(), |offset| range.end + offset);
        Ok(self.source[start..end].trim() == "/")
    }
}

struct Header {
    declaration: usize,
    declaration_end: usize,
    create_or_replace: Option<(usize, usize)>,
    parent: usize,
    parent_end: usize,
    state: Option<usize>,
    state_insert: usize,
    header: OracleTriggerSqlHeader,
    structured_editable: bool,
}

pub(super) fn validate(input: OracleObjectSourceValidationInput) -> Result<(), String> {
    // Validation without a selected owner must still check any explicit owner's
    // syntax, but cannot bind an omitted owner to the session schema.
    let mut source = normalized_source(input.database_type, input.source)?;
    strip_trailing_slash(&mut source, input.database_type)?;
    let tokens = TriggerTokens::new(source, input.database_type == DatabaseType::Dameng)?;
    analyze(&tokens, input.schema.as_deref(), &input.name, input.database_type)?;
    Ok(())
}

pub fn prepare_oracle_trigger_sql(input: OracleTriggerSqlInput) -> Result<PreparedOracleTriggerSql, String> {
    if input.owner.is_empty() || input.name.is_empty() {
        return Err("Select the exact trigger owner and name".into());
    }
    if input.allow_export_appendix && input.purpose != OracleTriggerSqlPurpose::Inspect {
        return Err("An editable trigger definition cannot contain export appendix statements".into());
    }
    let mut source = normalized_source(input.database_type, input.source)?;
    strip_trailing_slash(&mut source, input.database_type)?;
    let export_enabled = if input.allow_export_appendix {
        strip_export_appendix(&mut source, input.database_type, &input.owner, &input.name)?
    } else {
        None
    };
    let tokens = TriggerTokens::new(source, input.database_type == DatabaseType::Dameng)?;
    let parsed = analyze(&tokens, Some(&input.owner), &input.name, input.database_type)?;
    let inline_enabled = parsed.state.map(|index| tokens.word(index, "ENABLE"));
    let mut result = PreparedOracleTriggerSql {
        definition: tokens.source.clone(),
        comparison_source: String::new(),
        header: parsed.header.clone(),
        inline_enabled,
        export_enabled,
        requires_state_restore: false,
        structured_editable: parsed.structured_editable,
    };
    terminate_definition(&mut result.definition, input.database_type)?;
    result.comparison_source = comparison_source(&result.definition, input.database_type, &input.owner, &input.name)?;
    if let Some(binding) = &input.binding {
        verify_binding(&parsed.header, binding)?;
    }
    if input.purpose == OracleTriggerSqlPurpose::Inspect {
        return Ok(result);
    }

    let binding = input.binding.as_ref().ok_or("Verify the candidate's ON target before preparing trigger SQL")?;
    let enabled = input
        .enabled
        .or_else(|| (input.purpose == OracleTriggerSqlPurpose::Create).then_some(inline_enabled.unwrap_or(true)))
        .ok_or("Read the current enabled state before replacing a trigger")?;
    let mut edits = Vec::new();
    // Edit tokens separately to preserve comments between CREATE/OR/REPLACE or
    // between the owner, period and name. The PL/SQL body is never reconstructed.
    match (input.purpose, parsed.create_or_replace) {
        (OracleTriggerSqlPurpose::Create, Some((or, replace))) => {
            edits.push((tokens.range(or)?, String::new()));
            edits.push((tokens.range(replace)?, String::new()));
        }
        (OracleTriggerSqlPurpose::Replace, None) => {
            let end = tokens.range(0)?.end;
            edits.push((end..end, " OR REPLACE".into()));
        }
        _ => {}
    }
    qualify(&tokens, parsed.declaration, parsed.declaration_end, &input.owner, &input.name, &mut edits)?;
    match parsed.header.scope.as_str() {
        "RELATION" => qualify(
            &tokens,
            parsed.parent,
            parsed.parent_end,
            binding.owner.as_deref().unwrap(),
            binding.name.as_deref().unwrap(),
            &mut edits,
        )?,
        "SCHEMA" => {
            if parsed.header.owner.is_some() {
                edits
                    .push((tokens.range(parsed.parent)?, quote_postgres_identifier(binding.owner.as_deref().unwrap())));
            } else {
                let start = tokens.range(parsed.parent)?.start;
                edits
                    .push((start..start, format!("{}.", quote_postgres_identifier(binding.owner.as_deref().unwrap()))));
            }
        }
        _ => {}
    }
    if input.database_type == DatabaseType::Dameng {
        if let Some(state) = parsed.state {
            edits.push((tokens.range(state)?, String::new()));
        }
        result.requires_state_restore = !enabled;
    } else if let Some(state) = parsed.state {
        edits.push((tokens.range(state)?, if enabled { "ENABLE" } else { "DISABLE" }.into()));
    } else {
        let start = tokens.range(parsed.state_insert)?.start;
        edits.push((start..start, format!("{}\n", if enabled { "ENABLE" } else { "DISABLE" })));
    }
    edits.sort_by_key(|(range, _)| (range.start, range.end));
    for (range, replacement) in edits.into_iter().rev() {
        result.definition.replace_range(range, &replacement);
    }
    result.header.owner = binding.owner.clone();
    result.comparison_source = comparison_source(&result.definition, input.database_type, &input.owner, &input.name)?;
    Ok(result)
}

fn comparison_source(source: &str, database: DatabaseType, owner: &str, name: &str) -> Result<String, String> {
    let tokens = TriggerTokens::new(source.to_owned(), database == DatabaseType::Dameng)?;
    let parsed = analyze(&tokens, Some(owner), name, database)?;
    let end = tokens.range(parsed.declaration_end - 1)?.end;
    // GET_DDL reconstructs CREATE OR REPLACE and the declared owner/name;
    // ALL_SOURCE starts at TRIGGER. Ignore whitespace only in that wrapper,
    // retaining every comment and the complete header/body suffix verbatim.
    let mut comments = Vec::new();
    let mut previous = 0;
    for index in 0..parsed.declaration_end {
        let range = tokens.range(index)?;
        let gap = source[previous..range.start].trim();
        if !gap.is_empty() {
            comments.push(gap);
        }
        previous = range.end;
    }
    let edition = if (0..parsed.declaration).any(|index| tokens.word(index, "NONEDITIONABLE")) {
        " NONEDITIONABLE"
    } else if (0..parsed.declaration).any(|index| tokens.word(index, "EDITIONABLE")) {
        " EDITIONABLE"
    } else {
        ""
    };
    let comments = if comments.is_empty() { String::new() } else { format!("{}\n", comments.join("\n")) };
    Ok(format!(
        "{comments}CREATE OR REPLACE{edition} TRIGGER {}.{}{}",
        quote_postgres_identifier(owner),
        quote_postgres_identifier(name),
        &source[end..]
    ))
}

fn qualify(
    tokens: &TriggerTokens,
    start: usize,
    end: usize,
    owner: &str,
    name: &str,
    edits: &mut Vec<(Range<usize>, String)>,
) -> Result<(), String> {
    if end - start == 3 {
        edits.push((tokens.range(start)?, quote_postgres_identifier(owner)));
        edits.push((tokens.range(start + 2)?, quote_postgres_identifier(name)));
    } else {
        edits.push((
            tokens.range(start)?,
            format!("{}.{}", quote_postgres_identifier(owner), quote_postgres_identifier(name)),
        ));
    }
    Ok(())
}

fn verify_binding(header: &OracleTriggerSqlHeader, binding: &OracleTriggerSqlBinding) -> Result<(), String> {
    let matches = match header.scope.as_str() {
        "RELATION" => {
            matches!(binding.scope.as_str(), "TABLE" | "VIEW")
                && (!header.view_only || binding.scope == "VIEW")
                && binding.owner.as_ref().is_some_and(|owner| {
                    !owner.is_empty() && header.owner.as_ref().is_none_or(|expected| expected == owner)
                })
                && binding.name.as_ref().is_some_and(|name| !name.is_empty() && header.name.as_ref() == Some(name))
                && !binding.pluggable
        }
        "SCHEMA" => {
            binding.scope == "SCHEMA"
                && binding.name.is_none()
                && !binding.pluggable
                && binding.owner.as_ref().is_some_and(|owner| {
                    !owner.is_empty() && header.owner.as_ref().is_none_or(|expected| expected == owner)
                })
        }
        "DATABASE" | "TIMER" => {
            binding.scope == header.scope
                && binding.owner.is_none()
                && binding.name.is_none()
                && binding.pluggable == header.pluggable
        }
        _ => false,
    };
    if matches {
        Ok(())
    } else {
        Err("The candidate ON target does not match the verified owning object or scope; keep the draft and verify the selection".into())
    }
}

fn normalized_source(database: DatabaseType, source: String) -> Result<String, String> {
    if !matches!(database, DatabaseType::Oracle | DatabaseType::OceanbaseOracle | DatabaseType::Dameng) {
        return Err("Exact trigger source is supported only for Oracle, OceanBase Oracle and DM8".into());
    }
    let tokens = TriggerTokens::new(source, database == DatabaseType::Dameng)?;
    let mut source = tokens.source.clone();
    if tokens.word(0, "TRIGGER")
        || (tokens.word(0, "EDITIONABLE") || tokens.word(0, "NONEDITIONABLE")) && tokens.word(1, "TRIGGER")
    {
        let start = tokens.range(0)?.start;
        source.insert_str(start, "CREATE ");
    } else if !tokens.word(0, "CREATE") {
        return Err("A complete TRIGGER declaration is required, not only its body".into());
    }
    Ok(source)
}

fn strip_trailing_slash(source: &mut String, database: DatabaseType) -> Result<(), String> {
    let tokens = TriggerTokens::new(source.clone(), database == DatabaseType::Dameng)?;
    if let Some(last) = tokens.tokens.len().checked_sub(1) {
        if tokens.standalone_slash(last)? {
            source.replace_range(tokens.range(last)?, "");
        }
    }
    Ok(())
}

fn strip_export_appendix(
    source: &mut String,
    database: DatabaseType,
    owner: &str,
    name: &str,
) -> Result<Option<bool>, String> {
    let tokens = TriggerTokens::new(source.clone(), database == DatabaseType::Dameng)?;
    let Some(alter) = (0..tokens.tokens.len()).rev().find(|index| tokens.word(*index, "ALTER")) else {
        return Ok(None);
    };
    if !tokens.word(alter + 1, "TRIGGER") {
        return Ok(None);
    }
    let (declared_owner, declared_name, end) = tokens.qualified(alter + 2)?;
    if !(tokens.word(end, "ENABLE") || tokens.word(end, "DISABLE")) {
        return Ok(None);
    }
    let tail = if tokens.token(end + 1) == Some(&Token::SemiColon) { end + 2 } else { end + 1 };
    if tail != tokens.tokens.len() {
        return Err("Unexpected statements after the trigger export state".into());
    }
    if declared_owner.as_deref() != Some(owner) || declared_name != name {
        return Err("The trigger export appendix targets a different object".into());
    }
    let mut prefix = source[..tokens.range(alter)?.start].to_string();
    strip_trailing_slash(&mut prefix, database)?;
    let prefix_tokens = TriggerTokens::new(prefix.clone(), database == DatabaseType::Dameng)?;
    analyze(&prefix_tokens, Some(owner), name, database)?;
    *source = prefix;
    Ok(Some(tokens.word(end, "ENABLE")))
}

fn analyze(tokens: &TriggerTokens, owner: Option<&str>, name: &str, database: DatabaseType) -> Result<Header, String> {
    let mut index = 1;
    let create_or_replace = if tokens.word(index, "OR") && tokens.word(index + 1, "REPLACE") {
        index += 2;
        Some((1, 2))
    } else {
        None
    };
    if tokens.word(index, "EDITIONABLE") || tokens.word(index, "NONEDITIONABLE") {
        index += 1;
    }
    if !tokens.word(0, "CREATE") || !tokens.word(index, "TRIGGER") {
        return Err("The source must declare one TRIGGER".into());
    }
    let declaration = index + 1;
    let (declared_owner, declared_name, declaration_end) = tokens.qualified(declaration)?;
    if declared_name != name
        || declared_owner.as_deref().is_some_and(|declared| owner.is_some_and(|owner| owner != declared))
    {
        return Err("The trigger declaration does not match the selected exact owner and name".into());
    }
    let mut event = declaration_end;
    if database == DatabaseType::Dameng && tokens.word(event, "WITH") && tokens.word(event + 1, "ENCRYPTION") {
        event += 2;
    }
    if !["BEFORE", "AFTER", "INSTEAD", "FOR"].iter().any(|word| tokens.word(event, word)) {
        return Err("Cannot locate the trigger timing and event header".into());
    }
    let on = (event + 1..tokens.tokens.len())
        .find(|index| {
            tokens.word(*index, "ON")
                || tokens.word(*index, "BEGIN")
                || tokens.word(*index, "DECLARE")
                || tokens.word(*index, "CALL")
                || tokens.token(*index) == Some(&Token::SemiColon)
        })
        .filter(|index| tokens.word(*index, "ON"))
        .ok_or("Cannot locate the trigger header's ON target")?;
    let timer = database == DatabaseType::Dameng && (event..on).any(|index| tokens.word(index, "TIMER"));
    let mut parent = on + 1;
    let nested = tokens.word(parent, "NESTED") && tokens.word(parent + 1, "TABLE");
    if nested {
        tokens.identifier(parent + 2)?;
        if !tokens.word(parent + 3, "OF") {
            return Err("Incomplete NESTED TABLE trigger target".into());
        }
        parent += 4;
    }
    let (header, parent_end) = if tokens.word(parent, "SCHEMA") && tokens.token(parent + 1) != Some(&Token::Period) {
        (
            OracleTriggerSqlHeader {
                scope: "SCHEMA".into(),
                owner: None,
                name: None,
                view_only: false,
                pluggable: false,
            },
            parent + 1,
        )
    } else if tokens.word(parent, "DATABASE") && tokens.token(parent + 1) != Some(&Token::Period)
        || tokens.word(parent, "PLUGGABLE") && tokens.word(parent + 1, "DATABASE")
    {
        let pluggable = tokens.word(parent, "PLUGGABLE");
        if nested || timer && pluggable {
            return Err("Unsupported trigger scope header".into());
        }
        (
            OracleTriggerSqlHeader {
                scope: if timer { "TIMER" } else { "DATABASE" }.into(),
                owner: None,
                name: None,
                view_only: false,
                pluggable,
            },
            parent + if pluggable { 2 } else { 1 },
        )
    } else if tokens.token(parent + 1) == Some(&Token::Period) && tokens.word(parent + 2, "SCHEMA") {
        (
            OracleTriggerSqlHeader {
                scope: "SCHEMA".into(),
                owner: Some(tokens.identifier(parent)?),
                name: None,
                view_only: false,
                pluggable: false,
            },
            parent + 3,
        )
    } else {
        let (owner, name, end) = tokens.qualified(parent)?;
        if timer {
            return Err("A DM TIMER trigger must target DATABASE".into());
        }
        (
            OracleTriggerSqlHeader {
                scope: "RELATION".into(),
                owner,
                name: Some(name),
                view_only: nested || tokens.word(event, "INSTEAD"),
                pluggable: false,
            },
            end,
        )
    };
    if tokens.token(parent_end) == Some(&Token::Period) {
        return Err("The trigger ON target has an unexpected extra qualifier".into());
    }
    if nested && header.scope != "RELATION" {
        return Err("A nested-table trigger requires a verified view".into());
    }
    let mut depth = 0usize;
    let mut body = None;
    let mut state = None;
    let mut state_insert = None;
    for index in parent_end..tokens.tokens.len() {
        match tokens.token(index) {
            Some(Token::LParen) => depth += 1,
            Some(Token::RParen) => depth = depth.checked_sub(1).ok_or("Unbalanced trigger header parentheses")?,
            Some(Token::SemiColon) => return Err("Trigger header has no complete body".into()),
            _ => {}
        }
        if depth != 0 {
            continue;
        }
        if tokens.word(index, "ON") {
            return Err("Ambiguous extra ON target in the trigger header".into());
        }
        if tokens.word(index, "WHEN") {
            state_insert.get_or_insert(index);
        }
        if (tokens.word(index, "ENABLE") || tokens.word(index, "DISABLE")) && state.replace(index).is_some() {
            return Err("Duplicate top-level trigger state clauses".into());
        }
        if ["BEGIN", "DECLARE", "CALL"].iter().any(|word| tokens.word(index, word))
            || tokens.word(index, "COMPOUND") && tokens.word(index + 1, "TRIGGER")
        {
            body = Some(index);
            break;
        }
    }
    let body = body.ok_or("A complete trigger body is required")?;
    let last = tokens.tokens.len().checked_sub(1).ok_or("Empty trigger definition")?;
    let mut complete_source = tokens.lexical.clone();
    if tokens.token(last) != Some(&Token::SemiColon) {
        // ALL_SOURCE commonly omits the final terminator. Add it for analysis,
        // never by searching for END inside a string or comment.
        complete_source.insert(tokens.range(last)?.end, ';');
    }
    if tokens.word(body, "CALL") {
        validate_call(tokens, body)?;
    } else if !crate::sql::oracle_plsql_block_is_complete(&complete_source) {
        return Err("The trigger PL/SQL block is incomplete".into());
    }
    if split_sql_statements_for_database(&complete_source, database).len() != 1 {
        return Err("Trigger source must contain exactly one complete definition and no extra SQL".into());
    }
    let event_start = if tokens.word(event, "BEFORE") || tokens.word(event, "AFTER") {
        event + 1
    } else if tokens.word(event, "INSTEAD") && tokens.word(event + 1, "OF") {
        event + 2
    } else {
        on
    };
    let mut structured_editable = header.scope == "RELATION"
        && !nested
        && event == declaration_end
        && !(0..declaration).any(|index| tokens.word(index, "EDITIONABLE") || tokens.word(index, "NONEDITIONABLE"))
        && !tokens.word(body, "COMPOUND")
        && event_start < on
        && (on - event_start) % 2 == 1
        && (event_start..on).enumerate().all(|(offset, index)| {
            if offset % 2 == 1 {
                tokens.word(index, "OR")
            } else {
                ["INSERT", "UPDATE", "DELETE"].iter().any(|word| tokens.word(index, word))
            }
        });
    let mut index = parent_end;
    let mut row_clause = false;
    let mut referencing_clause = false;
    while structured_editable && index < body {
        if !row_clause && tokens.word(index, "FOR") && tokens.word(index + 1, "EACH") && tokens.word(index + 2, "ROW") {
            row_clause = true;
            index += 3;
        } else if tokens.word(index, "ENABLE") || tokens.word(index, "DISABLE") {
            index += 1;
        } else if !referencing_clause && tokens.word(index, "REFERENCING") {
            referencing_clause = true;
            index += 1;
            let mut aliases = 0u8;
            while tokens.word(index, "NEW") || tokens.word(index, "OLD") {
                let (word, bit) = if tokens.word(index, "NEW") { ("NEW", 1) } else { ("OLD", 2) };
                if aliases & bit != 0 || !tokens.word(index + 1, "AS") || !tokens.word(index + 2, word) {
                    structured_editable = false;
                    break;
                }
                aliases |= bit;
                index += 3;
            }
            structured_editable &= aliases != 0;
        } else {
            structured_editable = false;
        }
    }
    Ok(Header {
        declaration,
        declaration_end,
        create_or_replace,
        parent,
        parent_end,
        state,
        state_insert: state_insert.unwrap_or(body),
        header,
        structured_editable,
    })
}

fn terminate_definition(source: &mut String, database: DatabaseType) -> Result<(), String> {
    let tokens = TriggerTokens::new(source.clone(), database == DatabaseType::Dameng)?;
    if let Some(last) = tokens.tokens.len().checked_sub(1) {
        if tokens.token(last) != Some(&Token::SemiColon) {
            source.insert(tokens.range(last)?.end, ';');
        }
    }
    Ok(())
}

fn validate_call(tokens: &TriggerTokens, body: usize) -> Result<(), String> {
    // The CALL body is not the DDL target: packaged/remote routine references
    // keep their original semantics. Check its boundary, not local ownership.
    let mut end = body + 1;
    loop {
        if !matches!(tokens.token(end), Some(Token::Word(_))) {
            return Err("Incomplete trigger CALL routine reference".into());
        }
        end += 1;
        if tokens.token(end) != Some(&Token::Period) {
            break;
        }
        end += 1;
    }
    if tokens.token(end) != Some(&Token::LParen) {
        return Err("A trigger CALL body requires its complete argument list".into());
    }
    let mut depth = 0usize;
    for index in end..tokens.tokens.len() {
        match tokens.token(index) {
            Some(Token::LParen) => depth += 1,
            Some(Token::RParen) => {
                depth = depth.checked_sub(1).ok_or("Unbalanced CALL body")?;
                if depth == 0 {
                    let tail = &tokens.tokens[index + 1..];
                    return if tail.is_empty() || tail.len() == 1 && tail[0].token == Token::SemiColon {
                        Ok(())
                    } else {
                        Err("Unexpected SQL after the trigger CALL body".into())
                    };
                }
            }
            Some(Token::SemiColon) => return Err("Unexpected statement in the trigger CALL body".into()),
            _ => {}
        }
    }
    Err("The trigger CALL body is incomplete".into())
}

/// DM accepts // comments. Use the mature Oracle tokenizer/block detector on a
/// same-length lexical view, preserving all original source and token offsets.
fn dm_lexical_view(source: &str) -> String {
    let mut view = source.to_string();
    let mut index = 0;
    while index < source.len() {
        let end = if source[index..].starts_with('\'') && crate::sql::ends_with_oracle_q_quote_prefix(&source[..index])
        {
            Some(crate::sql::oracle_q_quote_end(source, index).unwrap_or(source.len()))
        } else {
            sql_single_quoted_literal_end(source, index)
                .or_else(|| read_quoted_sql_identifier(source, index).map(|(end, _)| end))
                .or_else(|| sql_line_comment_end(source, index))
                .or_else(|| sql_block_comment_end(source, index))
        };
        if let Some(end) = end {
            index = end;
            continue;
        }
        if source[index..].starts_with("//") {
            view.replace_range(index..index + 2, "--");
            index += source[index..].find('\n').unwrap_or(source.len() - index);
            continue;
        }
        index += source[index..].chars().next().unwrap().len_utf8();
    }
    view
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(source: &str) -> OracleTriggerSqlInput {
        OracleTriggerSqlInput {
            database_type: DatabaseType::Oracle,
            owner: "APP".into(),
            name: "T".into(),
            source: source.into(),
            purpose: OracleTriggerSqlPurpose::Inspect,
            binding: None,
            enabled: None,
            allow_export_appendix: false,
        }
    }

    fn relation(owner: &str, name: &str, view: bool) -> OracleTriggerSqlBinding {
        OracleTriggerSqlBinding {
            scope: if view { "VIEW" } else { "TABLE" }.into(),
            owner: Some(owner.into()),
            name: Some(name.into()),
            pluggable: false,
        }
    }

    fn scope(scope: &str, owner: Option<&str>) -> OracleTriggerSqlBinding {
        OracleTriggerSqlBinding { scope: scope.into(), owner: owner.map(str::to_string), name: None, pluggable: false }
    }

    const SIMPLE: &str = "CREATE TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS FOR EACH ROW BEGIN NULL; END;";

    #[test]
    fn reports_whether_the_complete_definition_is_losslessly_structured() {
        for (source, expected) in [
            (SIMPLE, true),
            ("CREATE TRIGGER APP.T AFTER INSERT OR UPDATE ON DATA.ORDERS REFERENCING NEW AS NEW OLD AS OLD FOR EACH ROW DISABLE BEGIN NULL; END;", true),
            ("CREATE TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS BEGIN pkg.run('FOLLOWS REFERENCING'); /* WHEN */ NULL; END;", true),
            ("CREATE TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS FOR EACH ROW FOLLOWS OTHER_T BEGIN NULL; END;", false),
            ("CREATE TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS REFERENCING NEW AS N FOR EACH ROW BEGIN NULL; END;", false),
            ("CREATE TRIGGER APP.T BEFORE UPDATE OF ID ON DATA.ORDERS FOR EACH ROW BEGIN NULL; END;", false),
            ("CREATE TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS FOR EACH ROW WHEN (NEW.ID > 0) BEGIN NULL; END;", false),
            ("CREATE NONEDITIONABLE TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS BEGIN NULL; END;", false),
            ("CREATE TRIGGER APP.T INSTEAD OF INSERT ON NESTED TABLE ITEMS OF DATA.V FOR EACH ROW BEGIN NULL; END;", false),
        ] {
            let prepared = serde_json::to_value(prepare_oracle_trigger_sql(input(source)).unwrap()).unwrap();
            assert_eq!(prepared.get("structuredEditable").and_then(serde_json::Value::as_bool), Some(expected), "{source}");
        }
    }

    #[test]
    fn strict_entry_accepts_oracle_family_triggers_without_changing_routines_or_default_trigger_building() {
        for (database, source) in [
            (DatabaseType::Oracle, SIMPLE),
            (DatabaseType::OceanbaseOracle, "CREATE OR REPLACE TRIGGER APP.T BEFORE UPDATE OF V ON DATA.ORDERS REFERENCING NEW AS N FOR EACH ROW DISABLE WHEN (N.V > 0) BEGIN NULL; END;"),
            (DatabaseType::Dameng, "CREATE OR REPLACE TRIGGER APP.T AFTER TIMER ON DATABASE FOR EACH 1 DAY FOR EACH 1 MINUTE BEGIN NULL; END;"),
        ] {
            validate_oracle_executable_object_source(OracleObjectSourceValidationInput { database_type: database, object_type: ObjectSourceKind::Trigger, schema: Some("APP".into()), name: "T".into(), source: source.into() }).unwrap();
        }
        validate_oracle_executable_object_source(OracleObjectSourceValidationInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Procedure,
            schema: Some("APP".into()),
            name: "P".into(),
            source: "CREATE OR REPLACE PROCEDURE APP.P AS BEGIN NULL; END;".into(),
        })
        .unwrap();
        let legacy = build_executable_object_source_statements(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Oracle,
            object_type: ObjectSourceKind::Trigger,
            schema: Some("APP".into()),
            name: "T".into(),
            source: "BEGIN NULL; END;".into(),
        })
        .unwrap();
        assert_eq!(legacy, ["BEGIN NULL; END;"]);
    }

    #[test]
    fn all_source_bare_declaration_and_missing_final_terminator_are_normalized_without_rebuilding_the_body() {
        let source = "-- 原始声明\nTRIGGER APP.T BEFORE INSERT ON DATA.ORDERS BEGIN NULL; END -- 尾注释\n";
        let prepared = prepare_oracle_trigger_sql(input(source)).unwrap();
        assert_eq!(
            prepared.definition,
            "-- 原始声明\nCREATE TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS BEGIN NULL; END; -- 尾注释\n"
        );
        assert_eq!(prepared.header.owner.as_deref(), Some("DATA"));
        assert_eq!(prepared.header.name.as_deref(), Some("ORDERS"));
        let editioned =
            prepare_oracle_trigger_sql(input(&SIMPLE.replace("CREATE TRIGGER", "NONEDITIONABLE TRIGGER"))).unwrap();
        assert!(editioned.definition.starts_with("CREATE NONEDITIONABLE TRIGGER"));
    }

    #[test]
    fn export_same_target_state_is_separate_from_the_original_inline_state() {
        let source = format!("{SIMPLE}\n/\nALTER TRIGGER \"APP\".\"T\" DISABLE;\n/\n-- export tail\n");
        let mut request = input(&source);
        request.allow_export_appendix = true;
        let prepared = prepare_oracle_trigger_sql(request.clone()).unwrap();
        assert_eq!(prepared.export_enabled, Some(false));
        assert_eq!(prepared.inline_enabled, None);
        assert!(!prepared.definition.contains("ALTER TRIGGER"));
        assert!(!prepared.definition.lines().any(|line| line.trim() == "/"));
        request.purpose = OracleTriggerSqlPurpose::Replace;
        assert!(prepare_oracle_trigger_sql(request).is_err());
    }

    #[test]
    fn comparison_canonicalizes_only_the_known_declaration_wrapper_and_keeps_body_literals_and_comments() {
        let source = "CREATE TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS BEGIN X := q'[a\r\nb]'; /* body */ NULL; END;";
        let plain = prepare_oracle_trigger_sql(input(source)).unwrap();
        let export = prepare_oracle_trigger_sql(input(
            &source.replace("CREATE TRIGGER APP.T", "\nCREATE OR REPLACE\nTRIGGER \"APP\" . \"T\""),
        ))
        .unwrap();
        assert_eq!(plain.definition, source);
        assert_eq!(plain.comparison_source, export.comparison_source);
        for changed in [
            source.replace("\r\n", "\n"),
            source.replace("/* body */", "/* changed */"),
            source.replace("CREATE TRIGGER", "CREATE /* wrapper comment */ TRIGGER"),
            source.replace("CREATE TRIGGER", "CREATE NONEDITIONABLE TRIGGER"),
        ] {
            let changed = prepare_oracle_trigger_sql(input(&changed)).unwrap();
            assert_ne!(plain.comparison_source, changed.comparison_source);
        }
    }

    #[test]
    fn export_cannot_strip_a_different_target_or_an_arbitrary_second_statement() {
        for tail in [
            "ALTER TRIGGER APP.OTHER DISABLE;",
            "ALTER TRIGGER OTHER.T DISABLE;",
            "DROP TABLE DATA.ORDERS;",
            "ALTER TRIGGER APP.T DISABLE; ALTER TRIGGER APP.T ENABLE;",
        ] {
            let mut request = input(&format!("{SIMPLE}\n{tail}"));
            request.allow_export_appendix = true;
            assert!(prepare_oracle_trigger_sql(request).is_err(), "{tail}");
        }
        assert!(prepare_oracle_trigger_sql(input(&format!("{SIMPLE}\nALTER TRIGGER APP.T DISABLE;"))).is_err());
    }

    #[test]
    fn slash_lines_in_q_and_nq_literals_and_comments_are_not_removed() {
        let source = "CREATE TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS DECLARE V VARCHAR2(100); BEGIN V := q'[\n/\nON WRONG ENABLE END;]'; V := nq'!\n/\n中文😀!'; /*\n/\n*/ NULL; END;\n/\n";
        let prepared = prepare_oracle_trigger_sql(input(source)).unwrap();
        assert!(prepared.definition.contains("q'[\n/\nON WRONG ENABLE END;]'"));
        assert!(prepared.definition.contains("nq'!\n/\n中文😀!'"));
        assert!(prepared.definition.contains("/*\n/\n*/"));
        assert!(!prepared.definition.trim_end().ends_with('/'));
    }

    #[test]
    fn declaration_identity_is_exact_and_cannot_be_inferred_from_the_parent() {
        for source in [
            SIMPLE.replace("APP.T", "OTHER.T"),
            SIMPLE.replace("APP.T", "APP.OTHER"),
            SIMPLE.replace("APP.T", "APP.\"t\""),
            SIMPLE.replace("APP.T", "APP.T@REMOTE"),
            SIMPLE.replace("APP.T", "APP.DATA.T"),
        ] {
            assert!(prepare_oracle_trigger_sql(input(&source)).is_err(), "{source}");
        }
        let mut quoted =
            input("CREATE TRIGGER \" Owner \".\" Tr\"\"ig \" BEFORE INSERT ON \" Data \".\" A:b \" BEGIN NULL; END;");
        quoted.owner = " Owner ".into();
        quoted.name = " Tr\"ig ".into();
        let parsed = prepare_oracle_trigger_sql(quoted).unwrap();
        assert_eq!(parsed.header.name.as_deref(), Some(" A:b "));
        assert_eq!(parsed.header.owner.as_deref(), Some(" Data "));
    }

    #[test]
    fn explicit_on_target_must_match_the_verified_binding_before_any_rewrite() {
        let mut request = input(SIMPLE);
        request.purpose = OracleTriggerSqlPurpose::Replace;
        request.enabled = Some(false);
        for binding in
            [relation("OTHER", "ORDERS", false), relation("DATA", "OTHER", false), scope("SCHEMA", Some("DATA"))]
        {
            request.binding = Some(binding);
            assert!(prepare_oracle_trigger_sql(request.clone()).is_err());
        }
        request.binding = Some(relation("DATA", "ORDERS", false));
        let prepared = prepare_oracle_trigger_sql(request).unwrap();
        assert!(prepared.definition.contains("ON \"DATA\".\"ORDERS\""));
        assert!(prepared.definition.contains("DISABLE\nBEGIN NULL; END;"));
    }

    #[test]
    fn unqualified_parent_uses_verified_selection_not_trigger_owner_or_execution_schema() {
        let mut request = input("CREATE TRIGGER T BEFORE INSERT ON ORDERS BEGIN NULL; END;");
        request.purpose = OracleTriggerSqlPurpose::Create;
        request.binding = Some(relation(" Parent Owner ", "ORDERS", false));
        let prepared = prepare_oracle_trigger_sql(request).unwrap();
        assert!(prepared.definition.contains("TRIGGER \"APP\".\"T\""));
        assert!(prepared.definition.contains("ON \" Parent Owner \".\"ORDERS\""));
        assert_eq!(prepared.header.owner.as_deref(), Some(" Parent Owner "));
    }

    #[test]
    fn a_scope_word_used_as_an_owner_is_not_misread_as_a_scope() {
        for owner in ["SCHEMA", "DATABASE"] {
            let parsed = prepare_oracle_trigger_sql(input(&format!(
                "CREATE TRIGGER APP.T BEFORE INSERT ON {owner}.ORDERS BEGIN NULL; END;"
            )))
            .unwrap();
            assert_eq!(parsed.header.scope, "RELATION");
            assert_eq!(parsed.header.owner.as_deref(), Some(owner));
            assert_eq!(parsed.header.name.as_deref(), Some("ORDERS"));
        }
        assert!(prepare_oracle_trigger_sql(input(
            "CREATE TRIGGER APP.T AFTER CREATE ON APP.SCHEMA.EXTRA BEGIN NULL; END;"
        ))
        .is_err());
    }

    #[test]
    fn schema_scope_is_qualified_only_with_the_verified_scope_owner() {
        let mut request = input("CREATE TRIGGER APP.T AFTER CREATE ON SCHEMA BEGIN NULL; END;");
        request.purpose = OracleTriggerSqlPurpose::Create;
        request.binding = Some(scope("SCHEMA", Some(" Scope Owner ")));
        let prepared = prepare_oracle_trigger_sql(request.clone()).unwrap();
        assert!(prepared.definition.contains("ON \" Scope Owner \".SCHEMA"));
        request.source = request.source.replace("ON SCHEMA", "ON OTHER.SCHEMA");
        assert!(prepare_oracle_trigger_sql(request).is_err());
    }

    #[test]
    fn database_scope_is_not_prefixed_with_a_schema_and_pluggable_is_bound() {
        let mut request = input("CREATE TRIGGER APP.T AFTER LOGON ON DATABASE BEGIN NULL; END;");
        request.purpose = OracleTriggerSqlPurpose::Create;
        request.binding = Some(scope("DATABASE", None));
        assert!(prepare_oracle_trigger_sql(request.clone()).unwrap().definition.contains("ON DATABASE"));
        request.source = request.source.replace("ON DATABASE", "ON PLUGGABLE DATABASE");
        assert!(prepare_oracle_trigger_sql(request.clone()).is_err());
        request.binding.as_mut().unwrap().pluggable = true;
        assert!(prepare_oracle_trigger_sql(request).unwrap().header.pluggable);
    }

    #[test]
    fn nested_table_instead_of_requires_a_view_and_edits_only_its_reference() {
        let mut request = input("CREATE TRIGGER APP.T INSTEAD OF INSERT ON NESTED TABLE \"Items\" OF ORDERS REFERENCING NEW AS N FOR EACH ROW BEGIN NULL; END;");
        request.purpose = OracleTriggerSqlPurpose::Replace;
        request.enabled = Some(true);
        request.binding = Some(relation("DATA", "ORDERS", false));
        assert!(prepare_oracle_trigger_sql(request.clone()).is_err());
        request.binding = Some(relation("DATA", "ORDERS", true));
        let prepared = prepare_oracle_trigger_sql(request).unwrap();
        assert!(prepared.definition.contains("ON NESTED TABLE \"Items\" OF \"DATA\".\"ORDERS\" REFERENCING NEW AS N"));
    }

    #[test]
    fn compound_crossedition_when_and_ordering_clauses_are_preserved_and_state_is_top_level_only() {
        for source in [
            "CREATE OR REPLACE EDITIONABLE TRIGGER APP.T FOR UPDATE OF V ON DATA.ORDERS REFERENCING NEW AS N FOLLOWS APP.EARLIER DISABLE WHEN (N.V > 0) COMPOUND TRIGGER BEFORE EACH ROW IS BEGIN NULL; END BEFORE EACH ROW; END T;",
            "CREATE OR REPLACE EDITIONABLE TRIGGER APP.T BEFORE UPDATE OF V ON DATA.ORDERS REFERENCING NEW AS N FOR EACH ROW FORWARD CROSSEDITION FOLLOWS APP.EARLIER DISABLE WHEN (N.V > 0) DECLARE \"ENABLE\" NUMBER; BEGIN NULL; END;",
        ] {
            let mut request = input(source);
            request.purpose = OracleTriggerSqlPurpose::Replace; request.enabled = Some(false);
            request.binding = Some(relation("DATA", "ORDERS", false));
            let prepared = prepare_oracle_trigger_sql(request).unwrap();
            assert!(prepared.definition.contains("REFERENCING NEW AS N"));
            assert!(prepared.definition.contains("FOLLOWS APP.EARLIER DISABLE WHEN (N.V > 0)"));
            assert!(prepared.definition.ends_with(if source.contains("COMPOUND") { "END T;" } else { "END;" }));
        }
    }

    #[test]
    fn create_removes_replace_without_losing_comments_and_replace_preserves_inline_disabled_in_one_statement() {
        let source = "CREATE /*a*/ OR /*b*/ REPLACE /*c*/ TRIGGER APP /*d*/ . /*e*/ T BEFORE INSERT ON DATA /*f*/ . /*g*/ ORDERS BEGIN DBMS_OUTPUT.PUT_LINE('ENABLE ON OTHER'); END;";
        let mut request = input(source);
        request.purpose = OracleTriggerSqlPurpose::Create;
        request.binding = Some(relation("DATA", "ORDERS", false));
        request.enabled = Some(false);
        let prepared = prepare_oracle_trigger_sql(request.clone()).unwrap();
        for comment in ["/*a*/", "/*b*/", "/*c*/", "/*d*/", "/*e*/", "/*f*/", "/*g*/"] {
            assert!(prepared.definition.contains(comment));
        }
        assert!(!prepared.definition.contains("REPLACE"));
        assert!(prepared.definition.contains("DISABLE\nBEGIN DBMS_OUTPUT.PUT_LINE('ENABLE ON OTHER'); END;"));
        request.purpose = OracleTriggerSqlPurpose::Replace;
        let prepared = prepare_oracle_trigger_sql(request.clone()).unwrap();
        assert!(prepared.definition.contains("OR /*b*/ REPLACE"));
        assert!(!prepared.requires_state_restore);
        request.enabled = None;
        assert!(prepare_oracle_trigger_sql(request).is_err());
    }

    #[test]
    fn dm_timer_and_double_slash_comments_keep_native_text_and_require_explicit_state_restoration() {
        let source = "// ' ON WRONG BEGIN\nCREATE TRIGGER APP.T AFTER TIMER ON DATABASE FOR EACH 1 DAY FOR EACH 1 MINUTE BEGIN DBMS_OUTPUT.PUT_LINE(q'[// ON WRONG DISABLE]'); // ' END;\n NULL; END;";
        let mut request = input(source);
        request.database_type = DatabaseType::Dameng;
        request.purpose = OracleTriggerSqlPurpose::Replace;
        request.enabled = Some(false);
        request.binding = Some(scope("TIMER", None));
        let prepared = prepare_oracle_trigger_sql(request).unwrap();
        assert_eq!(prepared.header.scope, "TIMER");
        assert!(prepared.requires_state_restore);
        assert!(prepared.definition.contains("AFTER TIMER ON DATABASE FOR EACH 1 DAY FOR EACH 1 MINUTE"));
        assert!(prepared.definition.starts_with("// ' ON WRONG BEGIN\nCREATE OR REPLACE TRIGGER"));
        assert!(prepared.definition.contains("q'[// ON WRONG DISABLE]'"));
        assert!(prepared.definition.contains("// ' END;\n NULL; END;"));
    }

    #[test]
    fn call_body_is_complete_but_does_not_admit_a_second_statement() {
        let source = "CREATE TRIGGER APP.T AFTER INSERT ON DATA.ORDERS CALL APP.P(:NEW.V, f('ON'));";
        assert!(prepare_oracle_trigger_sql(input(source)).is_ok());
        for routine in ["APP.PKG.P", "APP.P@REMOTE"] {
            assert!(prepare_oracle_trigger_sql(input(&source.replace("APP.P(", &format!("{routine}(")))).is_ok());
        }
        for source in [
            source.replace("f('ON'));", "f('ON');"),
            format!("{source} DROP TABLE DATA.ORDERS;"),
            source.replace("CALL APP.P", "CALL APP.P SELECT EXTRA"),
        ] {
            assert!(prepare_oracle_trigger_sql(input(&source)).is_err(), "{source}");
        }
    }

    #[test]
    fn partial_body_extra_sql_and_ambiguous_headers_cannot_be_promoted_to_complete_sources() {
        for source in [
            "BEGIN NULL; END;",
            "TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS BEGIN NULL;",
            "TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS BEGIN IF 1=1 THEN NULL; END IF;",
            "TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS ENABLE DISABLE BEGIN NULL; END;",
            "TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS ON OTHER BEGIN NULL; END;",
            "TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS BEGIN NULL; END; SELECT 1 FROM DUAL;",
            "CREATE PROCEDURE APP.T AS BEGIN NULL; END;",
        ] {
            assert!(prepare_oracle_trigger_sql(input(source)).is_err(), "{source}");
        }
    }

    #[test]
    fn long_unicode_crlf_source_keeps_comments_and_body_bytes_through_header_edits() {
        let body = format!("BEGIN\r\n/* {} */\r\nNULL; END; -- 尾注释\r\n", "中文😀 ON ENABLE DISABLE ".repeat(8_000));
        let mut request = input(&format!("-- 😀\r\nCREATE TRIGGER APP.T BEFORE INSERT ON DATA.ORDERS\r\n{body}"));
        request.purpose = OracleTriggerSqlPurpose::Replace;
        request.enabled = Some(false);
        request.binding = Some(relation("DATA", "ORDERS", false));
        let prepared = prepare_oracle_trigger_sql(request).unwrap();
        assert!(prepared.definition.ends_with(&body));
        assert!(prepared.definition.contains("ON \"DATA\".\"ORDERS\"\r\nDISABLE\nBEGIN\r\n"));
    }
}
