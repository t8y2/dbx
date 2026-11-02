use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleSupportingIndexDdl {
    pub constraint_name: String,
    pub owner: String,
    pub name: String,
    pub ddl: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleSupportingIndexIdentity {
    pub constraint_name: String,
    pub owner: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleTableConstraintSource {
    pub in_create_table: bool,
    pub name: Option<String>,
    pub constraint_type: String,
    pub disabled: bool,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleTableDdlSource {
    pub owner: Option<String>,
    pub table: String,
    pub index_organized: bool,
    pub supporting_constraints: Vec<OracleTableConstraintSource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleIndexDdlSource {
    pub owner: String,
    pub name: String,
    pub table_owner: String,
    pub table: String,
    pub ddl: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleTriggerDdlSource {
    pub owner: String,
    pub name: String,
    pub table_owner: String,
    pub table: String,
    pub ddl: String,
    pub state_statements: Vec<String>,
    pub dependencies: Vec<(String, String)>,
}

pub fn oracle_trigger_source_with_create(source: &str) -> Result<Option<String>, String> {
    let all = tokens(source)?;
    let ts = significant(&all);
    if ts.first().is_some_and(|token| unquoted_keyword_is(&token.token, "CREATE")) {
        return Ok(Some(source.to_string()));
    }
    if let Some(token) = ts.first().filter(|token| unquoted_keyword_is(&token.token, "TRIGGER")) {
        let mut result = source.to_string();
        result.insert_str(at(source, token.span.start)?, "CREATE ");
        return Ok(Some(result));
    }
    Ok(None)
}

pub fn oracle_trigger_metadata_matches(
    trigger: &OracleTriggerDdlSource,
    event: &str,
    timing: &str,
    level: Option<&str>,
    condition: Option<&str>,
) -> Result<bool, String> {
    let all = tokens(&trigger.ddl)?;
    let ts = significant(&all);
    let declaration = ts
        .iter()
        .position(|token| unquoted_keyword_is(&token.token, "TRIGGER"))
        .ok_or("Trigger declaration is unavailable")?;
    let (_, _, first) = qualified_name(&ts, declaration + 1, &trigger.owner)?;
    let on = (first..ts.len())
        .find(|position| unquoted_keyword_is(&ts[*position].token, "ON"))
        .ok_or("Trigger table binding is unavailable")?;
    let body = (on + 1..ts.len())
        .find(|position| {
            ["WHEN", "DECLARE", "BEGIN", "CALL", "COMPOUND"]
                .iter()
                .any(|word| unquoted_keyword_is(&ts[*position].token, word))
        })
        .unwrap_or(ts.len());
    let events = |tokens: &[&sqlparser::tokenizer::TokenWithSpan]| {
        tokens
            .iter()
            .filter_map(|token| {
                ["INSERT", "UPDATE", "DELETE"]
                    .iter()
                    .find(|word| unquoted_keyword_is(&token.token, word))
                    .map(|word| word.to_string())
            })
            .collect::<std::collections::BTreeSet<_>>()
    };
    let expected_tokens = tokens(event)?;
    if events(&ts[first..on]) != events(&significant(&expected_tokens)) {
        return Ok(false);
    }
    let raw_timing = if unquoted_keyword_is(&ts[first].token, "INSTEAD") {
        "INSTEAD OF"
    } else if unquoted_keyword_is(&ts[first].token, "BEFORE") {
        "BEFORE"
    } else if unquoted_keyword_is(&ts[first].token, "AFTER") {
        "AFTER"
    } else if unquoted_keyword_is(&ts[first].token, "FOR")
        && ts.get(body).is_some_and(|token| unquoted_keyword_is(&token.token, "COMPOUND"))
    {
        "COMPOUND"
    } else {
        return Err("Trigger timing is unavailable".into());
    };
    let normalized_timing = timing
        .split_whitespace()
        .map(str::to_ascii_uppercase)
        .filter(|word| !["EACH", "ROW", "STATEMENT"].contains(&word.as_str()))
        .collect::<Vec<_>>()
        .join(" ");
    if normalized_timing != raw_timing {
        return Ok(false);
    }
    if raw_timing != "COMPOUND" {
        let raw_row = ts[on + 1..body].windows(3).any(|tokens| {
            unquoted_keyword_is(&tokens[0].token, "FOR")
                && unquoted_keyword_is(&tokens[1].token, "EACH")
                && unquoted_keyword_is(&tokens[2].token, "ROW")
        });
        let expected_row = match level.map(str::to_ascii_uppercase).as_deref() {
            Some("ROW" | "EACH ROW") => true,
            Some("STATEMENT") => false,
            None => timing.to_ascii_uppercase().contains("ROW"),
            Some(_) => return Err("Trigger level is unavailable or unsupported".into()),
        };
        if raw_row != expected_row {
            return Ok(false);
        }
    }
    if let Some(condition) = condition {
        let end = (body..ts.len())
            .find(|position| {
                ["DECLARE", "BEGIN", "CALL", "COMPOUND"]
                    .iter()
                    .any(|word| unquoted_keyword_is(&ts[*position].token, word))
            })
            .unwrap_or(ts.len());
        let actual = if ts.get(body).is_some_and(|token| unquoted_keyword_is(&token.token, "WHEN")) {
            &ts[body + 1..end]
        } else {
            &[]
        };
        let expected = tokens(condition)?;
        let expected = significant(&expected);
        let normalize = |tokens: &[&sqlparser::tokenizer::TokenWithSpan]| {
            let mut tokens = tokens.iter().map(|token| token.token.clone()).collect::<Vec<_>>();
            if tokens.first().is_some_and(|token| unquoted_keyword_is(token, "WHEN")) {
                tokens.remove(0);
            }
            loop {
                if tokens.first() != Some(&Token::LParen) || tokens.last() != Some(&Token::RParen) {
                    break;
                }
                let mut depth = 0;
                let enclosing = tokens.iter().enumerate().all(|(position, token)| {
                    match token {
                        Token::LParen => depth += 1,
                        Token::RParen => depth -= 1,
                        _ => {}
                    }
                    depth > 0 || position == tokens.len() - 1
                });
                if !enclosing {
                    break;
                }
                tokens.remove(0);
                tokens.pop();
            }
            for token in &mut tokens {
                if let Token::Word(word) = token {
                    if word.quote_style.is_none() {
                        word.value = word.value.to_uppercase();
                    }
                }
            }
            tokens
        };
        if normalize(actual) != normalize(&expected) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn oracle_trigger_definitions_match(
    left: &OracleTriggerDdlSource,
    right: &OracleTriggerDdlSource,
) -> Result<bool, String> {
    let comparable = |trigger: &OracleTriggerDdlSource| -> Result<Vec<Token>, String> {
        let all = tokens(&trigger.ddl)?;
        let ts = significant(&all);
        let declaration = ts
            .iter()
            .position(|token| unquoted_keyword_is(&token.token, "TRIGGER"))
            .ok_or("Trigger declaration is unavailable")?;
        let (_, _, first) = qualified_name(&ts, declaration + 1, &trigger.owner)?;
        let body = (first..ts.len())
            .find(|position| {
                ["DECLARE", "BEGIN", "CALL", "COMPOUND"]
                    .iter()
                    .any(|word| unquoted_keyword_is(&ts[*position].token, word))
            })
            .ok_or("Trigger body is unavailable")?;
        let header = (first..body).find(|position| unquoted_keyword_is(&ts[*position].token, "WHEN")).unwrap_or(body);
        let mut result = Vec::new();
        let mut position = first;
        while position < ts.len() {
            if position < header && unquoted_keyword_is(&ts[position].token, "ON") {
                let (_, _, end) = qualified_name(&ts, position + 1, &trigger.table_owner)?;
                result.push(ts[position].token.clone());
                position = end;
                continue;
            }
            let default_referencing = ["REFERENCING", "NEW", "AS", "NEW", "OLD", "AS", "OLD"];
            if position < header
                && default_referencing.iter().enumerate().all(|(offset, word)| {
                    ts.get(position + offset).is_some_and(|token| unquoted_keyword_is(&token.token, word))
                })
            {
                position += default_referencing.len();
                continue;
            }
            if position < header
                && ["ENABLE", "DISABLE"].iter().any(|word| unquoted_keyword_is(&ts[position].token, word))
            {
                position += 1;
                continue;
            }
            let mut token = ts[position].token.clone();
            if let Token::Word(word) = &mut token {
                if word.quote_style.is_none() {
                    word.value = word.value.to_uppercase();
                }
            }
            result.push(token);
            position += 1;
        }
        Ok(result)
    };
    Ok(left.owner == right.owner
        && left.name == right.name
        && left.table_owner == right.table_owner
        && left.table == right.table
        && comparable(left)? == comparable(right)?)
}

pub fn oracle_trigger_enabled(trigger: &OracleTriggerDdlSource) -> Result<bool, String> {
    let mut state = None;
    for statement in &trigger.state_statements {
        let all = tokens(statement)?;
        let ts = significant(&all);
        let enabled = ts
            .iter()
            .find_map(|token| {
                if unquoted_keyword_is(&token.token, "ENABLE") {
                    Some(true)
                } else if unquoted_keyword_is(&token.token, "DISABLE") {
                    Some(false)
                } else {
                    None
                }
            })
            .ok_or("Trigger firing state is unavailable")?;
        if state.is_some_and(|previous| previous != enabled) {
            return Err(format!("{}.{}: conflicting trigger state statements", trigger.owner, trigger.name));
        }
        state = Some(enabled);
    }
    if let Some(enabled) = state {
        return Ok(enabled);
    }
    let all = tokens(&trigger.ddl)?;
    let ts = significant(&all);
    Ok(!ts
        .iter()
        .take_while(|token| {
            !["WHEN", "DECLARE", "BEGIN", "CALL", "COMPOUND"].iter().any(|word| unquoted_keyword_is(&token.token, word))
        })
        .any(|token| unquoted_keyword_is(&token.token, "DISABLE")))
}

pub fn order_oracle_trigger_sources(
    triggers: &[OracleTriggerDdlSource],
) -> Result<Vec<OracleTriggerDdlSource>, String> {
    let mut remaining = (0..triggers.len()).collect::<Vec<_>>();
    let mut emitted = std::collections::BTreeSet::new();
    let mut ordered = Vec::new();
    for trigger in triggers {
        oracle_trigger_enabled(trigger)?;
        for dependency in &trigger.dependencies {
            if !triggers.iter().any(|candidate| (&candidate.owner, &candidate.name) == (&dependency.0, &dependency.1)) {
                return Err(format!(
                    "{}.{}: trigger ordering dependency {}.{} is unavailable",
                    trigger.owner, trigger.name, dependency.0, dependency.1
                ));
            }
        }
    }
    while !remaining.is_empty() {
        let position = remaining
            .iter()
            .position(|index| triggers[*index].dependencies.iter().all(|dependency| emitted.contains(dependency)))
            .ok_or("Trigger ordering dependencies contain a cycle")?;
        let trigger = &triggers[remaining.remove(position)];
        if !emitted.insert((trigger.owner.clone(), trigger.name.clone())) {
            return Err(format!("{}.{}: duplicate trigger identity", trigger.owner, trigger.name));
        }
        ordered.push(trigger.clone());
    }
    Ok(ordered)
}

pub fn extract_oracle_table_triggers(
    source: &str,
    owner: &str,
    table: &str,
) -> Result<(String, Vec<OracleTriggerDdlSource>), String> {
    extract_oracle_triggers(source, owner, Some(table))
}

pub fn oracle_trigger_ddl_sources(source: &str, owner: &str) -> Result<Vec<OracleTriggerDdlSource>, String> {
    extract_oracle_triggers(source, owner, None).map(|(_, triggers)| triggers)
}

fn extract_oracle_triggers(
    source: &str,
    owner: &str,
    table: Option<&str>,
) -> Result<(String, Vec<OracleTriggerDdlSource>), String> {
    let mut triggers: Vec<OracleTriggerDdlSource> = Vec::new();
    let mut states = Vec::new();
    let mut removals = Vec::new();
    for statement in crate::sql::statement_ranges_for_database(source, DatabaseType::Oracle) {
        let all = tokens(&statement.text)?;
        let ts = significant(&all);
        let keyword =
            |position: usize, word: &str| ts.get(position).is_some_and(|token| unquoted_keyword_is(&token.token, word));
        let alter = keyword(0, "ALTER") && keyword(1, "TRIGGER");
        let mut position = 1;
        if keyword(position, "OR") && keyword(position + 1, "REPLACE") {
            position += 2;
        }
        if keyword(position, "EDITIONABLE") || keyword(position, "NONEDITIONABLE") {
            position += 1;
        }
        let create = keyword(0, "CREATE") && keyword(position, "TRIGGER");
        if !create && !alter {
            continue;
        }
        let first = if alter { 2 } else { position + 1 };
        let (trigger_owner, name, next) = qualified_name(&ts, first, owner)?;
        if alter {
            if !(keyword(next, "ENABLE") || keyword(next, "DISABLE"))
                || ts[next + 1..].iter().any(|token| token.token != Token::SemiColon)
            {
                return Err(format!("{trigger_owner}.{name}: unsupported trigger state statement"));
            }
            states.push((trigger_owner, name, statement.text.clone()));
        } else {
            if !crate::sql::oracle_plsql_block_is_complete(&statement.text) {
                return Err(format!("{trigger_owner}.{name}: complete trigger source is unavailable"));
            }
            let header_end = (next..ts.len())
                .find(|position| {
                    ["WHEN", "DECLARE", "BEGIN", "CALL", "COMPOUND"].iter().any(|word| keyword(*position, word))
                })
                .unwrap_or(ts.len());
            let on = (next..header_end).filter(|position| keyword(*position, "ON")).collect::<Vec<_>>();
            if on.len() != 1 {
                return Err(format!("{trigger_owner}.{name}: trigger table identity is unavailable"));
            }
            let (table_owner, trigger_table, _) = qualified_name(&ts, on[0] + 1, owner)?;
            if table.is_some_and(|table| table_owner != owner || trigger_table != table) {
                return Err(format!("{trigger_owner}.{name}: trigger source does not match the selected table"));
            }
            let mut dependencies = Vec::new();
            for position in next..header_end {
                if keyword(position, "FOLLOWS") || keyword(position, "PRECEDES") {
                    let mut first = position + 1;
                    loop {
                        let (dependency_owner, dependency_name, end) = qualified_name(&ts, first, &trigger_owner)?;
                        dependencies.push((dependency_owner, dependency_name));
                        if ts.get(end).is_none_or(|token| token.token != Token::Comma) {
                            break;
                        }
                        first = end + 1;
                    }
                }
            }
            if triggers.iter().any(|trigger| trigger.owner == trigger_owner && trigger.name == name) {
                return Err(format!("{trigger_owner}.{name}: duplicate trigger definitions"));
            }
            triggers.push(OracleTriggerDdlSource {
                owner: trigger_owner,
                name,
                table_owner,
                table: trigger_table,
                ddl: statement.text.clone(),
                state_statements: Vec::new(),
                dependencies,
            });
        }
        let mut end = statement.end;
        if source.as_bytes().get(end) == Some(&b';') {
            end += 1;
        }
        let remainder = &source[end..];
        let whitespace = remainder.len() - remainder.trim_start().len();
        let slash = end + whitespace;
        if source.as_bytes().get(slash) == Some(&b'/')
            && source[..slash].rsplit('\n').next().is_some_and(|line| line.trim().is_empty())
            && source[slash..].lines().next().is_some_and(|line| line.trim() == "/")
        {
            end = slash + 1;
        }
        removals.push((statement.start, end));
    }
    for (owner, name, state) in states {
        let trigger = triggers
            .iter_mut()
            .find(|trigger| trigger.owner == owner && trigger.name == name)
            .ok_or_else(|| format!("{owner}.{name}: trigger state has no complete definition"))?;
        trigger.state_statements.push(state);
    }
    let mut remaining = source.to_string();
    for (start, end) in removals.into_iter().rev() {
        remaining.replace_range(start..end, "");
    }
    Ok((remaining, triggers))
}

pub fn rebase_oracle_trigger_ddl(
    source: &str,
    table: &OracleDdlNameMapping,
    trigger_mappings: &[OracleDdlNameMapping],
) -> Result<String, String> {
    let (remaining, triggers) = extract_oracle_table_triggers(source, &table.source_owner, &table.source_name)?;
    if triggers.len() != 1 || !significant(&tokens(&remaining)?).is_empty() {
        return Err("Exactly one complete trigger definition is required".into());
    }
    let trigger = &triggers[0];
    let mapping = trigger_mappings
        .iter()
        .find(|mapping| mapping.source_owner == trigger.owner && mapping.source_name == trigger.name)
        .ok_or_else(|| format!("{}.{}: trigger mapping is unavailable", trigger.owner, trigger.name))?;
    let mut edits = std::collections::BTreeMap::new();
    for statement in crate::sql::statement_ranges_for_database(source, DatabaseType::Oracle) {
        let all = tokens(&statement.text)?;
        let ts = significant(&all);
        if ts.is_empty() {
            continue;
        }
        let keyword =
            |position: usize, word: &str| ts.get(position).is_some_and(|token| unquoted_keyword_is(&token.token, word));
        let alter = keyword(0, "ALTER");
        if !alter && keyword(1, "OR") && keyword(2, "REPLACE") {
            for position in [1, 2] {
                edits.insert(
                    statement.start + at(&statement.text, ts[position].span.start)?,
                    (statement.start + at(&statement.text, ts[position].span.end)?, String::new()),
                );
            }
        }
        let declaration =
            (1..ts.len()).find(|position| keyword(*position, "TRIGGER")).ok_or("Trigger declaration is unavailable")?
                + 1;
        let (_, _, name_end) = qualified_name(&ts, declaration, &trigger.owner)?;
        let mut replacements = vec![(declaration, mapping)];
        if !alter {
            let header_end = (name_end..ts.len())
                .find(|position| {
                    ["WHEN", "DECLARE", "BEGIN", "CALL", "COMPOUND"].iter().any(|word| keyword(*position, word))
                })
                .unwrap_or(ts.len());
            let on = (name_end..header_end)
                .find(|position| keyword(*position, "ON"))
                .ok_or("Trigger table identity is unavailable")?;
            replacements.push((on + 1, table));
            for position in name_end..header_end {
                if keyword(position, "FOLLOWS") || keyword(position, "PRECEDES") {
                    let mut first = position + 1;
                    loop {
                        let (owner, name, end) = qualified_name(&ts, first, &trigger.owner)?;
                        let dependency = trigger_mappings
                            .iter()
                            .find(|mapping| mapping.source_owner == owner && mapping.source_name == name)
                            .ok_or_else(|| format!("{owner}.{name}: trigger dependency mapping is unavailable"))?;
                        replacements.push((first, dependency));
                        if ts.get(end).is_none_or(|token| token.token != Token::Comma) {
                            break;
                        }
                        first = end + 1;
                    }
                }
            }
        }
        for (position, mapping) in replacements {
            let (owner, name, end) = qualified_name(&ts, position, &mapping.source_owner)?;
            if owner != mapping.source_owner || name != mapping.source_name {
                return Err("Trigger declaration or binding does not match the selected identity".into());
            }
            let qualified = end == position + 3;
            if qualified && mapping.source_owner != mapping.target_owner {
                edits.insert(
                    statement.start + at(&statement.text, ts[position].span.start)?,
                    (
                        statement.start + at(&statement.text, ts[position].span.end)?,
                        quote_postgres_identifier(&mapping.target_owner),
                    ),
                );
            }
            let name_position = if qualified { position + 2 } else { position };
            let replacement = if !qualified
                && (mapping.source_owner != mapping.target_owner || mapping.source_name != mapping.target_name)
            {
                Some(format!(
                    "{}.{}",
                    quote_postgres_identifier(&mapping.target_owner),
                    quote_postgres_identifier(&mapping.target_name)
                ))
            } else {
                (mapping.source_name != mapping.target_name).then(|| quote_postgres_identifier(&mapping.target_name))
            };
            if let Some(replacement) = replacement {
                edits.insert(
                    statement.start + at(&statement.text, ts[name_position].span.start)?,
                    (statement.start + at(&statement.text, ts[name_position].span.end)?, replacement),
                );
            }
        }
    }
    let mut result = source.to_string();
    for (start, (end, replacement)) in edits.into_iter().rev() {
        result.replace_range(start..end, &replacement);
    }
    let (_, mapped) = extract_oracle_table_triggers(&result, &table.target_owner, &table.target_name)?;
    if mapped.len() != 1 || mapped[0].owner != mapping.target_owner || mapped[0].name != mapping.target_name {
        return Err("Mapped trigger identity does not match the target".into());
    }
    Ok(result)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleTableDdlParts {
    pub table_ddl: String,
    pub indexes: Vec<String>,
    pub supporting_constraints: Vec<String>,
    pub foreign_keys: Vec<String>,
    pub trailing_ddl: String,
    pub triggers: Vec<OracleTriggerDdlSource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleDdlNameMapping {
    pub source_owner: String,
    pub source_name: String,
    pub target_owner: String,
    pub target_name: String,
}

fn oracle_default_sequence_owner_edits(
    source: &str,
    ts: &[&sqlparser::tokenizer::TokenWithSpan],
    table: &OracleDdlNameMapping,
) -> Result<std::collections::BTreeMap<usize, (usize, String)>, String> {
    let mut edits = std::collections::BTreeMap::new();
    if table.source_owner == table.target_owner {
        return Ok(edits);
    }
    let keyword =
        |position: usize, value: &str| ts.get(position).is_some_and(|token| unquoted_keyword_is(&token.token, value));
    for create in 0..ts.len() {
        if !keyword(create, "CREATE") {
            continue;
        }
        let Some(declaration) = (create + 1..(create + 5).min(ts.len())).find(|position| keyword(*position, "TABLE"))
        else {
            continue;
        };
        let (owner, name, open) = qualified_name(ts, declaration + 1, &table.source_owner)?;
        if owner != table.source_owner || name != table.source_name {
            return Err("DDL declaration does not match the selected table".into());
        }
        if ts.get(open).is_none_or(|token| token.token != Token::LParen) {
            continue;
        }
        let mut depth = 0;
        let mut start = open + 1;
        for end in open + 1..ts.len() {
            match ts[end].token {
                Token::LParen => {
                    depth += 1;
                    continue;
                }
                Token::RParen if depth > 0 => {
                    depth -= 1;
                    continue;
                }
                Token::Comma if depth == 0 => {}
                Token::RParen => {}
                _ => continue,
            }
            if depth != 0 || !matches!(ts[end].token, Token::Comma | Token::RParen) {
                continue;
            }
            if start < end
                && !["CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "SUPPLEMENTAL"]
                    .iter()
                    .any(|word| keyword(start, word))
            {
                let column = identifier(&ts[start].token)?;
                let mut nested = 0;
                let mut cases = 0;
                let mut expression = None;
                for position in start + 1..end {
                    if nested == 0 && cases == 0 {
                        if expression.is_none() && keyword(position, "GENERATED") {
                            break;
                        }
                        if expression.is_none() && keyword(position, "DEFAULT") {
                            expression = Some(position + 1);
                            continue;
                        }
                        if expression.is_some()
                            && ["CONSTRAINT", "NOT", "PRIMARY", "UNIQUE", "REFERENCES", "CHECK", "ENABLE", "DISABLE"]
                                .iter()
                                .any(|word| keyword(position, word))
                        {
                            break;
                        }
                    }
                    match ts[position].token {
                        Token::LParen => nested += 1,
                        Token::RParen => nested -= 1,
                        _ => {}
                    }
                    if keyword(position, "CASE") {
                        cases += 1;
                    } else if keyword(position, "END") && cases > 0 {
                        cases -= 1;
                    }
                    if expression.is_none()
                        || (position > 0 && ts[position - 1].token == Token::Period)
                        || identifier(&ts[position].token).ok().as_deref() != Some(&table.source_owner)
                        || ts.get(position + 1).is_none_or(|token| token.token != Token::Period)
                    {
                        continue;
                    }
                    if position + 2 < end
                        && identifier(&ts[position + 2].token).is_ok_and(|name| name == "NEXTVAL" || name == "CURRVAL")
                        && ts.get(position + 3).is_none_or(|token| {
                            !matches!(token.token, Token::Period | Token::LParen) && token.token.to_string() != "@"
                        })
                    {
                        continue;
                    }
                    let valid = position + 4 < end
                        && identifier(&ts[position + 2].token).is_ok()
                        && ts[position + 3].token == Token::Period
                        && identifier(&ts[position + 4].token).is_ok_and(|name| name == "NEXTVAL" || name == "CURRVAL")
                        && ts.get(position + 5).is_none_or(|token| {
                            !matches!(token.token, Token::Period | Token::LParen) && token.token.to_string() != "@"
                        });
                    if !valid {
                        return Err(format!(
                            "{}.{}.{column}: DEFAULT dependency cannot be safely mapped",
                            table.source_owner, table.source_name
                        ));
                    }
                    edits.insert(
                        at(source, ts[position].span.start)?,
                        (at(source, ts[position].span.end)?, quote_postgres_identifier(&table.target_owner)),
                    );
                }
            }
            if ts[end].token == Token::RParen {
                break;
            }
            start = end + 1;
        }
    }
    Ok(edits)
}

pub fn rebase_oracle_table_ddl(
    source: &str,
    table: &OracleDdlNameMapping,
    tables: &[OracleDdlNameMapping],
    indexes: &[OracleDdlNameMapping],
) -> Result<String, String> {
    for (table_names, mappings) in [(true, tables), (false, indexes)] {
        let mut identities = std::collections::BTreeMap::new();
        for mapping in mappings.iter().chain(table_names.then_some(table)) {
            let source = (&mapping.source_owner, &mapping.source_name);
            let target = (&mapping.target_owner, &mapping.target_name);
            if identities.insert(source, target).is_some_and(|previous| previous != target) {
                return Err(format!("{}.{}: conflicting Oracle DDL mappings", source.0, source.1));
            }
        }
    }
    let all = tokens(source)?;
    let ts = significant(&all);
    let mut edits = oracle_default_sequence_owner_edits(source, &ts, table)?;
    let mut rewrite = |position: usize, mapping: &OracleDdlNameMapping, qualified: bool| -> Result<(), String> {
        let name_position = if qualified { position + 2 } else { position };
        let name_token = ts.get(name_position).ok_or("Oracle DDL name is incomplete")?;
        let replacement = if qualified {
            if mapping.source_owner != mapping.target_owner {
                let token = ts[position];
                edits.insert(
                    at(source, token.span.start)?,
                    (at(source, token.span.end)?, quote_postgres_identifier(&mapping.target_owner)),
                );
            }
            (mapping.source_name != mapping.target_name).then(|| quote_postgres_identifier(&mapping.target_name))
        } else if mapping.source_owner != mapping.target_owner || mapping.source_name != mapping.target_name {
            Some(format!(
                "{}.{}",
                quote_postgres_identifier(&mapping.target_owner),
                quote_postgres_identifier(&mapping.target_name)
            ))
        } else {
            None
        };
        if let Some(replacement) = replacement {
            edits.insert(at(source, name_token.span.start)?, (at(source, name_token.span.end)?, replacement));
        }
        Ok(())
    };
    let keyword =
        |position: usize, value: &str| ts.get(position).is_some_and(|token| unquoted_keyword_is(&token.token, value));
    let mut depth = 0;
    let mut statement_start = 0;
    let mut grant_statement = false;
    for (position, token) in ts.iter().enumerate() {
        if grant_statement && token.token != Token::SemiColon {
            continue;
        }
        if token.token == Token::SemiColon && depth == 0 {
            statement_start = position + 1;
            grant_statement = false;
        }
        match token.token {
            Token::LParen => depth += 1,
            Token::RParen => {
                depth -= 1;
                if depth < 0 {
                    return Err("Oracle DDL parentheses are incomplete".into());
                }
            }
            _ => {}
        }
        if position == statement_start && keyword(position, "GRANT") {
            let mut grant_depth = 0;
            let mut object = None;
            for (next, next_token) in ts.iter().enumerate().skip(position + 1) {
                match next_token.token {
                    Token::SemiColon => break,
                    Token::LParen => grant_depth += 1,
                    Token::RParen => grant_depth -= 1,
                    _ => {}
                }
                if grant_depth == 0 && keyword(next, "ON") {
                    object = Some(next + 1 + usize::from(keyword(next + 1, "TABLE")));
                    break;
                }
            }
            let first = object.ok_or("Grant table identity is unavailable")?;
            let (owner, name, end) = qualified_name(&ts, first, &table.source_owner)?;
            if owner != table.source_owner || name != table.source_name || !keyword(end, "TO") {
                return Err("Grant DDL does not match the selected table".into());
            }
            rewrite(first, table, end == first + 3)?;
            grant_statement = true;
            continue;
        }
        let create_table = keyword(position, "CREATE")
            .then(|| (position + 1..position + 5).find(|next| keyword(*next, "TABLE")))
            .flatten();
        let create_index = keyword(position, "CREATE")
            .then(|| (position + 1..position + 4).find(|next| keyword(*next, "INDEX")))
            .flatten();
        if let Some(index_position) = create_index {
            let first = index_position + 1;
            let (owner, name, next) = qualified_name(&ts, first, &table.source_owner)?;
            let mapping = indexes
                .iter()
                .find(|mapping| mapping.source_owner == owner && mapping.source_name == name)
                .ok_or_else(|| format!("{owner}.{name}: index mapping is unavailable"))?;
            rewrite(first, mapping, next == first + 3)?;
            if !keyword(next, "ON") {
                return Err(format!("{owner}.{name}: index table identity is unavailable"));
            }
            let (owner, name, end) = qualified_name(&ts, next + 1, &table.source_owner)?;
            if owner != table.source_owner || name != table.source_name {
                return Err("Index DDL does not match the selected table".into());
            }
            rewrite(next + 1, table, end == next + 4)?;
            continue;
        }
        if keyword(position, "USING") && keyword(position + 1, "INDEX") {
            let first = position + 2;
            if ts.get(first).is_none_or(|token| token.token == Token::LParen)
                || [
                    "PCTFREE",
                    "INITRANS",
                    "MAXTRANS",
                    "TABLESPACE",
                    "STORAGE",
                    "COMPUTE",
                    "LOGGING",
                    "NOLOGGING",
                    "LOCAL",
                    "GLOBAL",
                    "ENABLE",
                    "DISABLE",
                    "VALIDATE",
                    "NOVALIDATE",
                    "RELY",
                    "NORELY",
                ]
                .iter()
                .any(|value| keyword(first, value))
            {
                continue;
            }
            let (owner, name, end) = qualified_name(&ts, first, &table.source_owner)?;
            let mapping = indexes
                .iter()
                .find(|mapping| mapping.source_owner == owner && mapping.source_name == name)
                .ok_or_else(|| format!("{owner}.{name}: supporting index mapping is unavailable"))?;
            rewrite(first, mapping, end == first + 3)?;
            continue;
        }
        let comment_table =
            keyword(position, "COMMENT") && keyword(position + 1, "ON") && keyword(position + 2, "TABLE");
        let comment_column =
            keyword(position, "COMMENT") && keyword(position + 1, "ON") && keyword(position + 2, "COLUMN");
        let references = keyword(position, "REFERENCES");
        let first = if let Some(table_position) = create_table {
            Some(table_position + 1)
        } else if keyword(position, "ALTER") && keyword(position + 1, "TABLE") {
            Some(position + 2)
        } else if comment_table || comment_column {
            Some(position + 3)
        } else if references {
            Some(position + 1)
        } else {
            None
        };
        let Some(first) = first else { continue };
        let (owner, name, qualified) =
            if comment_column && ts.get(first + 3).is_none_or(|token| token.token != Token::Period) {
                (
                    table.source_owner.clone(),
                    identifier(&ts.get(first).ok_or("Column comment table is unavailable")?.token)?,
                    false,
                )
            } else {
                let (owner, name, end) = qualified_name(&ts, first, &table.source_owner)?;
                (owner, name, end == first + 3)
            };
        if !references {
            if owner != table.source_owner || name != table.source_name {
                return Err("DDL declaration does not match the selected table".into());
            }
            rewrite(first, table, qualified)?;
        } else if owner == table.source_owner {
            let mapping = if name == table.source_name {
                table.clone()
            } else {
                tables
                    .iter()
                    .find(|mapping| mapping.source_owner == owner && mapping.source_name == name)
                    .cloned()
                    .unwrap_or(OracleDdlNameMapping {
                        source_owner: owner.clone(),
                        source_name: name.clone(),
                        target_owner: table.target_owner.clone(),
                        target_name: name,
                    })
            };
            rewrite(first, &mapping, qualified)?;
        }
    }
    if depth != 0 {
        return Err("Oracle DDL parentheses are incomplete".into());
    }
    let mut result = source.to_string();
    for (start, (end, replacement)) in edits.into_iter().rev() {
        result.replace_range(start..end, &replacement);
    }
    Ok(result)
}

fn qualified_name(
    ts: &[&sqlparser::tokenizer::TokenWithSpan],
    first: usize,
    default_owner: &str,
) -> Result<(String, String, usize), String> {
    let name = identifier(&ts.get(first).ok_or("Oracle DDL object name is unavailable")?.token)?;
    if ts.get(first + 1).is_some_and(|token| token.token == Token::Period) {
        Ok((
            name,
            identifier(&ts.get(first + 2).ok_or("Oracle DDL qualified object name is unavailable")?.token)?,
            first + 3,
        ))
    } else {
        Ok((default_owner.to_string(), name, first + 1))
    }
}

pub fn oracle_index_ddl_sources(source: &str, default_owner: &str) -> Result<Vec<OracleIndexDdlSource>, String> {
    Ok(oracle_index_ddl_source_ranges(source, default_owner)?.into_iter().map(|(index, _)| index).collect())
}

fn oracle_table_source_statement_ranges(source: &str) -> Result<Vec<std::ops::Range<usize>>, String> {
    let mut ranges = Vec::new();
    for statement in crate::sql::statement_ranges_for_database(source, DatabaseType::Oracle) {
        let mut statement_end = statement.start + statement.text.len();
        if source.as_bytes().get(statement_end) == Some(&b';') {
            statement_end += 1;
        }
        let all = tokens(&statement.text)?;
        let ts = significant(&all);
        let keyword = |position: usize, value: &str| {
            ts.get(position).is_some_and(|token| unquoted_keyword_is(&token.token, value))
        };
        let definition = |position: usize| -> Result<Option<usize>, String> {
            if keyword(position, "ALTER") && keyword(position + 1, "TABLE") {
                let (_, _, end) = qualified_name(&ts, position + 2, "")?;
                if !keyword(end, "ADD") || !keyword(end + 1, "CONSTRAINT") {
                    return Ok(None);
                }
                identifier(&ts.get(end + 2).ok_or("Post-table constraint name is unavailable")?.token)?;
                let kind = end + 3;
                let keys = if keyword(kind, "UNIQUE") {
                    kind + 1
                } else if (keyword(kind, "PRIMARY") || keyword(kind, "FOREIGN")) && keyword(kind + 1, "KEY") {
                    kind + 2
                } else {
                    return Ok(None);
                };
                if ts.get(keys).is_none_or(|token| token.token != Token::LParen) {
                    return Err("Post-table constraint keys are incomplete".into());
                }
                return Ok(Some(keys));
            }
            if !keyword(position, "CREATE") {
                return Ok(None);
            }
            let mut kind = position + 1;
            if keyword(kind, "UNIQUE") || keyword(kind, "BITMAP") {
                kind += 1;
            }
            if !keyword(kind, "TABLE") && !keyword(kind, "INDEX") {
                return Ok(None);
            }
            let (_, _, mut end) = qualified_name(&ts, kind + 1, "")?;
            if keyword(kind, "INDEX") {
                if !keyword(end, "ON") {
                    return Err("Oracle index table binding is incomplete".into());
                }
                (_, _, end) = qualified_name(&ts, end + 1, "")?;
            }
            if ts.get(end).is_none_or(|token| token.token != Token::LParen) {
                return Err("Oracle table or index definition is incomplete".into());
            }
            Ok(Some(end))
        };
        if definition(0)?.is_none() {
            ranges.push(statement.start..statement_end);
            continue;
        }
        let mut depth = 0;
        let mut closed = false;
        let mut start = statement.start;
        let incomplete_tail = |token: Option<&&sqlparser::tokenizer::TokenWithSpan>| {
            token.is_some_and(|token| {
                [
                    "TABLESPACE",
                    "PCTFREE",
                    "PCTUSED",
                    "INITRANS",
                    "MAXTRANS",
                    "STORAGE",
                    "PARAMETERS",
                    "BUFFER_POOL",
                    "FLASH_CACHE",
                    "CELL_FLASH_CACHE",
                ]
                .iter()
                .any(|word| unquoted_keyword_is(&token.token, word))
            })
        };
        for (position, token) in ts.iter().enumerate() {
            if position > 0 && depth == 0 && (keyword(position, "CREATE") || keyword(position, "ALTER")) {
                if !closed || incomplete_tail(ts[..position].last()) {
                    return Err("Oracle native DDL boundary precedes a complete definition".into());
                }
                let next = if keyword(position, "CREATE") {
                    if keyword(position + 1, "TABLE") {
                        return Err("Oracle native table source contains another table declaration".into());
                    }
                    definition(position)?.is_some()
                } else {
                    if !keyword(position + 1, "TABLE") {
                        return Err("Oracle native DDL boundary is ambiguous".into());
                    }
                    let (_, _, end) = qualified_name(&ts, position + 2, "")?;
                    keyword(end, "ADD") && keyword(end + 1, "CONSTRAINT")
                };
                if !next {
                    return Err("Oracle native DDL boundary is incomplete".into());
                }
                let end = statement.start + at(&statement.text, token.span.start)?;
                ranges.push(start..end);
                start = end;
                closed = false;
            }
            match token.token {
                Token::LParen => depth += 1,
                Token::RParen => {
                    depth -= 1;
                    if depth == 0 {
                        closed = true;
                    }
                }
                _ => {}
            }
            if depth < 0 {
                return Err("Oracle DDL parentheses are incomplete".into());
            }
        }
        if depth != 0 || !closed || incomplete_tail(ts.iter().rev().find(|token| token.token != Token::SemiColon)) {
            return Err("Oracle table or index definition is incomplete".into());
        }
        ranges.push(start..statement_end);
    }
    Ok(ranges)
}

fn oracle_post_table_constraints(
    source: &str,
    owner: &str,
    table: &str,
) -> Result<Vec<(std::ops::Range<usize>, String)>, String> {
    let mut result = Vec::new();
    for range in oracle_table_source_statement_ranges(source)? {
        let statement = &source[range.clone()];
        let all = tokens(statement)?;
        let ts = significant(&all);
        let keyword =
            |position: usize, word: &str| ts.get(position).is_some_and(|token| unquoted_keyword_is(&token.token, word));
        if !keyword(0, "ALTER") || !keyword(1, "TABLE") {
            continue;
        }
        let (actual_owner, actual_table, end) = qualified_name(&ts, 2, owner)?;
        if !keyword(end, "ADD") || !keyword(end + 1, "CONSTRAINT") {
            continue;
        }
        if actual_owner != owner || actual_table != table {
            return Err("Post-table constraint belongs to a different table".into());
        }
        identifier(&ts.get(end + 2).ok_or("Post-table constraint name is unavailable")?.token)?;
        let kind = end + 3;
        let keys = if keyword(kind, "PRIMARY") || keyword(kind, "FOREIGN") {
            if !keyword(kind + 1, "KEY") {
                return Err("Post-table constraint key definition is incomplete".into());
            }
            kind + 2
        } else if keyword(kind, "UNIQUE") {
            kind + 1
        } else {
            continue;
        };
        if ts.get(keys).is_none_or(|token| token.token != Token::LParen) {
            return Err("Post-table constraint key list is unavailable".into());
        }
        let mut depth = 0;
        for token in ts.iter().skip(keys) {
            match token.token {
                Token::LParen => depth += 1,
                Token::RParen => depth -= 1,
                _ => {}
            }
            if depth < 0 {
                return Err("Post-table constraint parentheses are incomplete".into());
            }
        }
        if depth != 0
            || (keyword(kind, "FOREIGN") && !ts.iter().any(|token| unquoted_keyword_is(&token.token, "REFERENCES")))
        {
            return Err("Post-table constraint definition is incomplete".into());
        }
        if keyword(kind, "FOREIGN") {
            let references = (keys..ts.len())
                .find(|position| keyword(*position, "REFERENCES"))
                .ok_or("Foreign key reference is unavailable")?;
            let (_, _, columns) = qualified_name(&ts, references + 1, owner)?;
            if ts.get(columns).is_some_and(|token| token.token == Token::LParen)
                && ts.get(columns + 1).is_none_or(|token| token.token == Token::RParen)
            {
                return Err("Foreign key reference columns are unavailable".into());
            }
        }
        let finish = ts
            .last()
            .filter(|token| token.token == Token::SemiColon)
            .map(|token| at(statement, token.span.start))
            .transpose()?
            .unwrap_or(statement.len());
        let clause_start = at(statement, ts[end + 1].span.start)?;
        let comments = all
            .iter()
            .filter(|token| {
                matches!(
                    token.token,
                    Token::Whitespace(Whitespace::SingleLineComment { .. } | Whitespace::MultiLineComment(_))
                )
            })
            .map(|token| Ok((at(statement, token.span.start)?, at(statement, token.span.end)?)))
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .filter(|(_, end)| *end <= clause_start)
            .map(|(start, end)| &statement[start..end])
            .collect::<Vec<_>>()
            .join("\n");
        result.push((
            range.clone(),
            format!("{}{}{}", comments, if comments.is_empty() { "" } else { "\n" }, &statement[clause_start..finish]),
        ));
    }
    Ok(result)
}

fn oracle_index_ddl_source_ranges(
    source: &str,
    default_owner: &str,
) -> Result<Vec<(OracleIndexDdlSource, std::ops::Range<usize>)>, String> {
    let all = tokens(source)?;
    let ts = significant(&all);
    let mut depth = 0;
    let mut result = Vec::new();
    for (position, token) in ts.iter().enumerate() {
        match token.token {
            Token::LParen => {
                depth += 1;
                continue;
            }
            Token::RParen => {
                depth -= 1;
                continue;
            }
            _ => {}
        }
        if depth < 0 {
            return Err("Oracle DDL parentheses are incomplete".into());
        }
        if depth != 0 || !unquoted_keyword_is(&token.token, "CREATE") {
            continue;
        }
        let Some(index_position) = ts
            .iter()
            .enumerate()
            .skip(position + 1)
            .take(3)
            .find_map(|(position, token)| unquoted_keyword_is(&token.token, "INDEX").then_some(position))
        else {
            continue;
        };
        let (owner, name, on_position) = qualified_name(&ts, index_position + 1, default_owner)?;
        if !ts.get(on_position).is_some_and(|token| unquoted_keyword_is(&token.token, "ON")) {
            return Err(format!("{owner}.{name}: complete index target is unavailable"));
        }
        let (table_owner, table, body_position) = qualified_name(&ts, on_position + 1, default_owner)?;
        if !ts.get(body_position).is_some_and(|token| token.token == Token::LParen) {
            return Err(format!("{owner}.{name}: complete index key definition is unavailable"));
        }
        let statement_ranges = oracle_table_source_statement_ranges(source)?;
        let finish = statement_ranges
            .iter()
            .find(|range| range.contains(&at(source, token.span.start).unwrap_or(usize::MAX)))
            .ok_or("Index statement boundary is unavailable")?
            .end;
        let range = at(source, token.span.start)?..finish;
        let ddl = source[range.clone()].to_string();
        if let Some((existing, _)) =
            result.iter().find(|(existing, _): &&(OracleIndexDdlSource, std::ops::Range<usize>)| {
                existing.owner == owner && existing.name == name
            })
        {
            if definition_tokens(&existing.ddl)? != definition_tokens(&ddl)? {
                return Err(format!("{owner}.{name}: conflicting standalone index definitions"));
            }
        }
        result.push((OracleIndexDdlSource { owner, name, table_owner, table, ddl }, range));
    }
    if depth != 0 {
        return Err("Oracle DDL parentheses are incomplete".into());
    }
    Ok(result)
}

fn identifier(token: &Token) -> Result<String, String> {
    match token {
        Token::Word(word) if word.quote_style == Some('"') => Ok(word.value.clone()),
        Token::Word(word) if word.quote_style.is_none() => Ok(word.value.to_uppercase()),
        _ => Err("Oracle DDL object identifier is unavailable".into()),
    }
}

pub fn parse_oracle_table_ddl(source: &str) -> Result<OracleTableDdlSource, String> {
    let all = tokens(source)?;
    let ts = significant(&all);
    if !ts.first().is_some_and(|token| unquoted_keyword_is(&token.token, "CREATE")) {
        return Err("Independent indexes require complete CREATE TABLE source".into());
    }
    let table_position = ts
        .iter()
        .take(5)
        .position(|token| unquoted_keyword_is(&token.token, "TABLE"))
        .ok_or("Independent indexes require CREATE TABLE source")?;
    let first = table_position + 1;
    let (owner, table, name_end) = if ts.get(first + 1).is_some_and(|token| token.token == Token::Period) {
        (
            Some(identifier(&ts.get(first).ok_or("Table owner is unavailable")?.token)?),
            identifier(&ts.get(first + 2).ok_or("Table name is unavailable")?.token)?,
            first + 3,
        )
    } else {
        (None, identifier(&ts.get(first).ok_or("Table name is unavailable")?.token)?, first + 1)
    };
    if !ts.get(name_end).is_some_and(|token| token.token == Token::LParen) {
        return Err("Complete Oracle table column list is unavailable".into());
    }
    let mut depth = 1;
    let mut start = at(source, ts[name_end].span.end)?;
    let mut segments = Vec::new();
    let mut close = None;
    for (position, token) in ts.iter().enumerate().skip(name_end + 1) {
        match token.token {
            Token::LParen => depth += 1,
            Token::RParen => {
                depth -= 1;
                if depth == 0 {
                    segments.push(&source[start..at(source, token.span.start)?]);
                    close = Some(position);
                    break;
                }
            }
            Token::Comma if depth == 1 => {
                segments.push(&source[start..at(source, token.span.start)?]);
                start = at(source, token.span.end)?;
            }
            _ => {}
        }
    }
    let close = close.ok_or("Oracle table column list is incomplete")?;
    let mut supporting_constraints = Vec::new();
    for segment in segments {
        let tokens = tokens(segment)?;
        let sig = significant(&tokens);
        let mut depth = 0;
        let mut name = None;
        for (position, token) in sig.iter().enumerate() {
            match token.token {
                Token::LParen => {
                    depth += 1;
                    continue;
                }
                Token::RParen => {
                    depth -= 1;
                    continue;
                }
                _ => {}
            }
            if depth != 0 {
                continue;
            }
            if unquoted_keyword_is(&token.token, "CONSTRAINT") {
                name = Some(identifier(&sig.get(position + 1).ok_or("Constraint name is unavailable")?.token)?);
            }
            let constraint_type = if unquoted_keyword_is(&token.token, "PRIMARY")
                && sig.get(position + 1).is_some_and(|token| unquoted_keyword_is(&token.token, "KEY"))
            {
                "P"
            } else if unquoted_keyword_is(&token.token, "UNIQUE") {
                "U"
            } else {
                continue;
            };
            let mut state_depth = 0;
            let mut disabled = false;
            for token in sig.iter().skip(position + 1) {
                match token.token {
                    Token::LParen => state_depth += 1,
                    Token::RParen => state_depth -= 1,
                    _ => {}
                }
                if state_depth == 0 && unquoted_keyword_is(&token.token, "CONSTRAINT") {
                    break;
                }
                if state_depth == 0 && unquoted_keyword_is(&token.token, "DISABLE") {
                    disabled = true;
                }
            }
            supporting_constraints.push(OracleTableConstraintSource {
                in_create_table: true,
                name: name.take(),
                constraint_type: constraint_type.into(),
                disabled,
                source: segment.to_string(),
            });
        }
    }
    let ranges = oracle_table_source_statement_ranges(source)?;
    let table_end = ranges.first().ok_or("Table statement boundary is unavailable")?.end;
    let tail = ts[close + 1..]
        .iter()
        .take_while(|token| at(source, token.span.start).is_ok_and(|offset| offset < table_end))
        .copied()
        .collect::<Vec<_>>();
    let index_organized = tail.windows(2).any(|pair| {
        unquoted_keyword_is(&pair[0].token, "ORGANIZATION") && unquoted_keyword_is(&pair[1].token, "INDEX")
    });
    for (_, clause) in oracle_post_table_constraints(source, owner.as_deref().unwrap_or(""), &table)? {
        let synthetic = format!("CREATE TABLE {} ({clause})", quote_postgres_identifier(&table));
        let parsed = parse_oracle_table_ddl(&synthetic)?;
        for mut constraint in parsed.supporting_constraints {
            constraint.in_create_table = false;
            constraint.source = clause.clone();
            supporting_constraints.push(constraint);
        }
    }
    let mut names = std::collections::BTreeSet::new();
    for constraint in &supporting_constraints {
        if let Some(name) = &constraint.name {
            if !names.insert(name) {
                return Err(format!("{name}: supporting constraint occurs more than once"));
            }
        }
    }
    Ok(OracleTableDdlSource { owner, table, index_organized, supporting_constraints })
}

fn tokens(sql: &str) -> Result<Vec<sqlparser::tokenizer::TokenWithSpan>, String> {
    Tokenizer::new(&OracleDialect {}, sql).tokenize_with_location().map_err(|error| error.to_string())
}

fn significant(tokens: &[sqlparser::tokenizer::TokenWithSpan]) -> Vec<&sqlparser::tokenizer::TokenWithSpan> {
    tokens.iter().filter(|token| !matches!(token.token, Token::Whitespace(_) | Token::EOF)).collect()
}

fn at(sql: &str, location: sqlparser::tokenizer::Location) -> Result<usize, String> {
    routine_location_to_byte_offset(sql, location).ok_or_else(|| "Cannot locate Oracle DDL source token".into())
}

fn definition_tokens(sql: &str) -> Result<Vec<Token>, String> {
    Ok(tokens(sql)?
        .into_iter()
        .filter_map(|token| {
            (!matches!(token.token, Token::Whitespace(_) | Token::EOF | Token::SemiColon)).then_some(token.token)
        })
        .collect())
}

fn terminate_oracle_table_statement(source: &str) -> Result<String, String> {
    let statement = source.trim_end();
    let all = tokens(statement)?;
    if significant(&all).last().is_some_and(|token| token.token == Token::SemiColon) {
        return Ok(statement.into());
    }
    let line_comment = all
        .iter()
        .rev()
        .find(|token| {
            !matches!(
                token.token,
                Token::EOF | Token::Whitespace(Whitespace::Space | Whitespace::Tab | Whitespace::Newline)
            )
        })
        .is_some_and(|token| matches!(token.token, Token::Whitespace(Whitespace::SingleLineComment { .. })));
    Ok(format!("{statement}{};", if line_comment { "\n" } else { "" }))
}

fn retained_index_create_is_redundant(
    index: &OracleIndexDdlSource,
    constraint: &OracleTableConstraintSource,
) -> Result<bool, String> {
    if constraint.name.as_deref() != Some(index.name.as_str()) {
        return Ok(false);
    }
    let statement = definition_tokens(&index.ddl)?;
    let constraint = definition_tokens(&constraint.source)?;
    if !statement.get(1).is_some_and(|token| unquoted_keyword_is(token, "UNIQUE")) {
        return Ok(false);
    }
    if constraint.iter().enumerate().any(|(position, token)| {
        unquoted_keyword_is(token, "DEFERRABLE")
            && !position.checked_sub(1).is_some_and(|previous| unquoted_keyword_is(&constraint[previous], "NOT"))
    }) {
        return Ok(false);
    }
    let keys = |tokens: &[Token], start: usize| {
        let open = (start..tokens.len()).find(|position| tokens[*position] == Token::LParen)?;
        let mut depth = 1;
        for close in open + 1..tokens.len() {
            match tokens[close] {
                Token::LParen => depth += 1,
                Token::RParen => depth -= 1,
                _ => {}
            }
            if depth == 0 {
                let values = tokens[open + 1..close]
                    .iter()
                    .cloned()
                    .map(|token| match token {
                        Token::Word(mut word) if word.quote_style.is_none() => {
                            word.value = word.value.to_uppercase();
                            Token::Word(word)
                        }
                        token => token,
                    })
                    .collect::<Vec<_>>();
                return Some((values, close));
            }
        }
        None
    };
    let Some(on) = statement.iter().position(|token| unquoted_keyword_is(token, "ON")) else {
        return Ok(false);
    };
    let Some(kind) = constraint
        .iter()
        .position(|token| unquoted_keyword_is(token, "PRIMARY") || unquoted_keyword_is(token, "UNIQUE"))
    else {
        return Ok(false);
    };
    let Some((actual, end)) = keys(&statement, on + 1) else {
        return Ok(false);
    };
    let Some((expected, _)) = keys(&constraint, kind + 1) else {
        return Ok(false);
    };
    Ok(end + 1 == statement.len() && actual == expected)
}

pub fn oracle_table_created_index_identities(
    source: &str,
    owner: &str,
    retained_indexes: &[OracleSupportingIndexIdentity],
) -> Result<Vec<(String, String)>, String> {
    let identity = parse_oracle_table_ddl(source)?;
    let parts = split_oracle_table_ddl_with_retained(source, owner, &identity.table, &[], retained_indexes)?;
    let mut names = std::collections::BTreeSet::new();
    for statement in parts.indexes {
        for index in oracle_index_ddl_sources(&statement, owner)? {
            names.insert((index.owner, index.name));
        }
    }
    Ok(names.into_iter().collect())
}

fn matches_name(tokens: &[&sqlparser::tokenizer::TokenWithSpan], position: usize, owner: &str, name: &str) -> bool {
    if tokens.get(position + 1).is_some_and(|token| token.token == Token::Period) {
        tokens.get(position).is_some_and(|token| identifier(&token.token).is_ok_and(|value| value == owner))
            && tokens.get(position + 2).is_some_and(|token| identifier(&token.token).is_ok_and(|value| value == name))
    } else {
        tokens.get(position).is_some_and(|token| identifier(&token.token).is_ok_and(|value| value == name))
    }
}

pub fn separate_oracle_supporting_indexes(
    source: &str,
    owner: &str,
    table: &str,
    indexes: &[OracleSupportingIndexDdl],
) -> Result<String, String> {
    separate_oracle_supporting_indexes_with_retained(source, owner, table, indexes, &[])
}

pub fn separate_oracle_supporting_indexes_with_retained(
    source: &str,
    owner: &str,
    table: &str,
    indexes: &[OracleSupportingIndexDdl],
    retained_indexes: &[OracleSupportingIndexIdentity],
) -> Result<String, String> {
    let identity = parse_oracle_table_ddl(source)?;
    if identity.table != table || identity.owner.as_deref().is_some_and(|source_owner| source_owner != owner) {
        return Err("Table DDL does not match the selected identity".into());
    }
    if indexes.is_empty() && retained_indexes.is_empty() {
        return Ok(source.into());
    }
    let parts = split_oracle_table_ddl_with_retained(source, owner, table, indexes, retained_indexes)?;
    let mut result = parts.table_ddl;
    for statement in parts.indexes.into_iter().chain(parts.supporting_constraints).chain(parts.foreign_keys) {
        result.push('\n');
        result.push_str(&statement);
    }
    result.push_str(&parts.trailing_ddl);
    for trigger in order_oracle_trigger_sources(&parts.triggers)? {
        result.push('\n');
        result.push_str(&trigger.ddl);
        for state in trigger.state_statements {
            result.push('\n');
            result.push_str(state.trim_end_matches(';'));
            result.push(';');
        }
    }
    Ok(result)
}

pub fn split_oracle_table_ddl(
    source: &str,
    owner: &str,
    table: &str,
    indexes: &[OracleSupportingIndexDdl],
) -> Result<OracleTableDdlParts, String> {
    split_oracle_table_ddl_with_retained(source, owner, table, indexes, &[])
}

pub fn split_oracle_table_ddl_with_retained(
    source: &str,
    owner: &str,
    table: &str,
    indexes: &[OracleSupportingIndexDdl],
    retained_indexes: &[OracleSupportingIndexIdentity],
) -> Result<OracleTableDdlParts, String> {
    let (table_source, triggers) = extract_oracle_table_triggers(source, owner, table)?;
    let source = table_source.as_str();
    let identity = parse_oracle_table_ddl(source)?;
    if identity.table != table || identity.owner.as_deref().is_some_and(|source_owner| source_owner != owner) {
        return Err("Table DDL does not match the selected identity".into());
    }
    let mut retained_identities = std::collections::BTreeSet::new();
    for index in retained_indexes {
        let constraint = identity
            .supporting_constraints
            .iter()
            .find(|constraint| constraint.name.as_deref() == Some(index.constraint_name.as_str()))
            .ok_or_else(|| format!("{}: complete inline constraint source is unavailable", index.constraint_name))?;
        if !constraint.in_create_table
            || index.owner != owner
            || constraint.disabled
            || !retained_identities.insert((&index.owner, &index.name))
        {
            return Err(format!(
                "{}: inline restoration of the supporting-index relationship is not verified",
                index.constraint_name
            ));
        }
        let all = tokens(&constraint.source)?;
        let sig = significant(&all);
        if sig.iter().enumerate().any(|(position, token)| {
            unquoted_keyword_is(&token.token, "DEFERRABLE")
                && !position.checked_sub(1).is_some_and(|previous| unquoted_keyword_is(&sig[previous].token, "NOT"))
        }) {
            return Err(format!("{}: deferred constraint index restoration is not verified", index.constraint_name));
        }
        if let Some(using) = sig.windows(2).position(|pair| {
            unquoted_keyword_is(&pair[0].token, "USING") && unquoted_keyword_is(&pair[1].token, "INDEX")
        }) {
            if sig.get(using + 2).is_some_and(|token| {
                ![
                    "ENABLE",
                    "VALIDATE",
                    "NOVALIDATE",
                    "RELY",
                    "NORELY",
                    "PCTFREE",
                    "INITRANS",
                    "MAXTRANS",
                    "STORAGE",
                    "TABLESPACE",
                    "LOGGING",
                    "NOLOGGING",
                    "LOCAL",
                    "GLOBAL",
                    "PARALLEL",
                    "NOPARALLEL",
                    "COMPRESS",
                    "NOCOMPRESS",
                ]
                .iter()
                .any(|word| unquoted_keyword_is(&token.token, word))
            }) {
                return Err(format!("{}: constraint source depends on an external supporting index; complete inline restoration is unavailable", index.constraint_name));
            }
        }
    }
    let all = tokens(source)?;
    let ts = significant(&all);
    if !ts.first().is_some_and(|token| unquoted_keyword_is(&token.token, "CREATE")) {
        return Err("Independent indexes require complete CREATE TABLE source".into());
    }
    let table_position = ts
        .iter()
        .take(5)
        .position(|token| unquoted_keyword_is(&token.token, "TABLE"))
        .ok_or("Independent indexes require CREATE TABLE source")?;
    if !matches_name(&ts, table_position + 1, owner, table) {
        return Err("Table DDL does not match the selected identity".into());
    }
    let open = ts.iter().position(|token| token.token == Token::LParen).ok_or("Table column list is unavailable")?;
    let mut depth = 0;
    let mut close = None;
    let mut start = at(source, ts[open].span.end)?;
    let mut segments = Vec::new();
    for (position, token) in ts.iter().enumerate().skip(open) {
        match token.token {
            Token::LParen => depth += 1,
            Token::RParen => {
                depth -= 1;
                if depth == 0 {
                    segments.push(&source[start..at(source, token.span.start)?]);
                    close = Some(position);
                    break;
                }
            }
            Token::Comma if depth == 1 => {
                segments.push(&source[start..at(source, token.span.start)?]);
                start = at(source, token.span.end)?;
            }
            _ => {}
        }
    }
    let close = close.ok_or("Table column list is incomplete")?;
    if identity.index_organized
        && indexes.iter().any(|index| {
            identity.supporting_constraints.iter().any(|constraint| {
                constraint.name.as_deref() == Some(index.constraint_name.as_str()) && constraint.constraint_type == "P"
            })
        })
    {
        return Err("An index-organized table cannot detach its primary index".into());
    }
    let table_end =
        oracle_table_source_statement_ranges(source)?.first().ok_or("Table statement boundary is unavailable")?.end;
    let mut definitions = std::collections::BTreeMap::new();
    for index in indexes {
        let key = (&index.owner, &index.name);
        let definition = definition_tokens(&index.ddl)?;
        if definitions.insert(key, definition.clone()).is_some_and(|previous| previous != definition) {
            return Err(format!("{}: conflicting definitions for the same index", index.name));
        }
    }
    let mut suffix = source[table_end..].to_string();
    let post_constraints = oracle_post_table_constraints(&suffix, owner, table)?
        .into_iter()
        .map(|(range, clause)| (range, clause.to_string()))
        .collect::<Vec<_>>();
    let mut segments = segments.into_iter().map(|segment| (segment.to_string(), true)).collect::<Vec<_>>();
    segments.extend(post_constraints.iter().map(|(_, clause)| (clause.clone(), false)));
    let mut existing = std::collections::BTreeMap::new();
    let mut ordinary_indexes = Vec::new();
    let mut ordinary_definitions = std::collections::BTreeMap::new();
    let mut retained_comments = Vec::new();
    let mut removals = post_constraints.iter().map(|(range, _)| range.clone()).collect::<Vec<_>>();
    for (standalone, range) in oracle_index_ddl_source_ranges(&suffix, owner)? {
        if standalone.table_owner != owner || standalone.table != table {
            return Err("Standalone index source belongs to a different table".into());
        }
        if let Some(index) =
            retained_indexes.iter().find(|index| index.owner == standalone.owner && index.name == standalone.name)
        {
            let constraint = identity
                .supporting_constraints
                .iter()
                .find(|constraint| constraint.name.as_deref() == Some(index.constraint_name.as_str()))
                .ok_or("Retained constraint source is unavailable")?;
            if !retained_index_create_is_redundant(&standalone, constraint)? {
                return Err(format!(
                    "{}: external supporting-index source requires inline equivalence verification",
                    standalone.name
                ));
            }
            for token in tokens(&standalone.ddl)? {
                if matches!(
                    token.token,
                    Token::Whitespace(Whitespace::SingleLineComment { .. } | Whitespace::MultiLineComment(_))
                ) {
                    retained_comments.push(
                        standalone.ddl[at(&standalone.ddl, token.span.start)?..at(&standalone.ddl, token.span.end)?]
                            .to_string(),
                    );
                }
            }
            removals.push(range);
            continue;
        }
        if let Some(index) =
            indexes.iter().find(|index| index.owner == standalone.owner && index.name == standalone.name)
        {
            if definition_tokens(&standalone.ddl)? != definitions[&(&index.owner, &index.name)] {
                return Err(format!("{}: standalone and supporting index definitions conflict", index.name));
            }
            existing.insert((&index.owner, &index.name), standalone.ddl);
        } else {
            let definition = definition_tokens(&standalone.ddl)?;
            match ordinary_definitions.insert((standalone.owner.clone(), standalone.name.clone()), definition.clone()) {
                Some(previous) if previous != definition => {
                    return Err(format!("{}: conflicting ordinary index definitions", standalone.name))
                }
                Some(_) => {}
                None => ordinary_indexes.push(terminate_oracle_table_statement(&standalone.ddl)?),
            }
        }
        removals.push(range);
    }
    removals.sort_by_key(|range| range.start);
    for range in removals.into_iter().rev() {
        suffix.replace_range(range, "");
    }
    if !retained_comments.is_empty() {
        suffix.push_str(&format!("\n{}\n", retained_comments.join("\n")));
    }
    let mut retained = Vec::new();
    let mut constraints = Vec::new();
    let mut foreign_keys = Vec::new();
    let mut found = std::collections::BTreeSet::new();
    for (segment, in_create_table) in &segments {
        let segment = segment.as_str();
        let st = tokens(segment)?;
        let sig = significant(&st);
        let named = sig.first().is_some_and(|token| unquoted_keyword_is(&token.token, "CONSTRAINT"));
        let index = indexes.iter().find(|index| {
            named
                && sig
                    .get(1)
                    .is_some_and(|token| identifier(&token.token).is_ok_and(|value| value == index.constraint_name))
        });
        if let Some(index) = index {
            if !found.insert(index.constraint_name.clone()) {
                return Err("Supporting constraint occurs more than once".into());
            }
            if !sig.get(2).is_some_and(|token| {
                unquoted_keyword_is(&token.token, "PRIMARY") || unquoted_keyword_is(&token.token, "UNIQUE")
            }) {
                return Err(format!("{} is not a primary or unique constraint", index.constraint_name));
            }
            let mut clause_depth = 0;
            let mut root_tokens = Vec::new();
            for (position, token) in sig.iter().enumerate() {
                match token.token {
                    Token::LParen => clause_depth += 1,
                    Token::RParen => clause_depth -= 1,
                    _ if clause_depth == 0 => root_tokens.push((position, *token)),
                    _ => {}
                }
            }
            if root_tokens.iter().any(|(_, token)| unquoted_keyword_is(&token.token, "DISABLE")) {
                return Err(format!(
                    "{}: disabled constraint index ownership requires separate verification",
                    index.constraint_name
                ));
            }
            let it = tokens(&index.ddl)?;
            let its = significant(&it);
            let ip = its
                .iter()
                .take(4)
                .position(|token| unquoted_keyword_is(&token.token, "INDEX"))
                .ok_or("Complete CREATE INDEX source is unavailable")?;
            let on = its
                .iter()
                .position(|token| unquoted_keyword_is(&token.token, "ON"))
                .ok_or("Index target is unavailable")?;
            if !its.first().is_some_and(|token| unquoted_keyword_is(&token.token, "CREATE"))
                || !matches_name(&its, ip + 1, &index.owner, &index.name)
                || !matches_name(&its, on + 1, owner, table)
            {
                return Err(format!("{}: index DDL identity does not match", index.name));
            }
            let using = root_tokens.windows(2).find_map(|pair| {
                (unquoted_keyword_is(&pair[0].1.token, "USING") && unquoted_keyword_is(&pair[1].1.token, "INDEX"))
                    .then_some(pair[0].0)
            });
            if let Some(using) = using {
                let first = using + 2;
                if sig.get(first).is_some_and(|token| matches!(&token.token, Token::Word(word) if word.quote_style.is_some() || !["ENABLE", "DISABLE", "VALIDATE", "NOVALIDATE", "RELY", "NORELY", "PCTFREE", "INITRANS", "MAXTRANS", "STORAGE", "TABLESPACE", "LOGGING", "NOLOGGING", "LOCAL", "GLOBAL", "PARALLEL", "NOPARALLEL", "COMPRESS", "NOCOMPRESS", "COMPUTE"].iter().any(|keyword| word.value.eq_ignore_ascii_case(keyword)))) {
                    let (binding_owner, binding_name, _) = qualified_name(&sig, first, owner)?;
                    if binding_owner != index.owner || binding_name != index.name {
                        return Err(format!("{}: constraint source and supporting-index binding disagree", index.constraint_name));
                    }
                }
            }
            let state = root_tokens.iter().find(|(position, token)| {
                using.is_none_or(|using| *position > using + 1)
                    && (unquoted_keyword_is(&token.token, "ENABLE")
                        || unquoted_keyword_is(&token.token, "VALIDATE")
                        || unquoted_keyword_is(&token.token, "NOVALIDATE")
                        || unquoted_keyword_is(&token.token, "RELY")
                        || unquoted_keyword_is(&token.token, "NORELY"))
            });
            let end = state.map(|(_, token)| at(segment, token.span.start)).transpose()?.unwrap_or(segment.len());
            let begin = using.map(|position| at(segment, sig[position].span.start)).transpose()?.unwrap_or(end);
            let comments = st
                .iter()
                .filter(|token| {
                    matches!(
                        token.token,
                        Token::Whitespace(Whitespace::SingleLineComment { .. } | Whitespace::MultiLineComment(_))
                    )
                })
                .filter_map(|token| {
                    let start = at(segment, token.span.start).ok()?;
                    let finish = at(segment, token.span.end).ok()?;
                    (start >= begin && finish <= end).then_some(&segment[start..finish])
                })
                .collect::<Vec<_>>()
                .join("\n");
            let binding = format!(
                "{}{} USING INDEX {}.{} {}",
                &segment[..begin],
                if comments.is_empty() { String::new() } else { format!("\n{comments}\n") },
                quote_postgres_identifier(&index.owner),
                quote_postgres_identifier(&index.name),
                &segment[end..]
            );
            constraints.push(binding.trim().to_string());
        } else if sig.iter().any(|token| unquoted_keyword_is(&token.token, "REFERENCES")) {
            if !named || !sig.get(2).is_some_and(|token| unquoted_keyword_is(&token.token, "FOREIGN")) {
                return Err(
                    "Inline foreign key needs complete out-of-line source before detaching its referenced key".into()
                );
            }
            foreign_keys.push(segment.trim().to_string());
        } else if !in_create_table {
            constraints.push(segment.trim().to_string());
        } else {
            retained.push(segment);
        }
    }
    if found.len() != indexes.len() {
        return Err("Not every supporting index has a complete named table constraint".into());
    }
    let mut table_ddl = format!(
        "{}{}{}",
        &source[..at(source, ts[open].span.end)?],
        retained.join(","),
        &source[at(source, ts[close].span.start)?..table_end]
    );
    table_ddl = terminate_oracle_table_statement(&table_ddl)?;
    let mut independent_indexes = ordinary_indexes;
    let mut emitted = std::collections::BTreeSet::new();
    for index in indexes {
        if emitted.insert((&index.owner, &index.name)) {
            let statement = existing
                .get(&(&index.owner, &index.name))
                .map(String::as_str)
                .unwrap_or(&index.ddl)
                .trim()
                .trim_end_matches(';');
            independent_indexes.push(terminate_oracle_table_statement(statement)?);
        }
    }
    let add_constraint = |constraint: String| {
        terminate_oracle_table_statement(&format!(
            "ALTER TABLE {}.{} ADD {}",
            quote_postgres_identifier(owner),
            quote_postgres_identifier(table),
            constraint
        ))
    };
    Ok(OracleTableDdlParts {
        table_ddl,
        indexes: independent_indexes,
        supporting_constraints: constraints.into_iter().map(add_constraint).collect::<Result<Vec<_>, _>>()?,
        foreign_keys: foreign_keys.into_iter().map(add_constraint).collect::<Result<Vec<_>, _>>()?,
        trailing_ddl: suffix,
        triggers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_supporting_index_keeps_inline_constraint_and_ordinary_index_separate() {
        let source = "CREATE TABLE APP.T(ID NUMBER, U NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID) USING INDEX ENABLE, CONSTRAINT UQ_T UNIQUE(U)); CREATE INDEX APP.IX_T ON APP.T(U); GRANT SELECT ON APP.T TO READER;";
        let retained = [
            OracleSupportingIndexIdentity { constraint_name: "PK_T".into(), owner: "APP".into(), name: "PK_T".into() },
            OracleSupportingIndexIdentity { constraint_name: "UQ_T".into(), owner: "APP".into(), name: "UQ_T".into() },
        ];
        let parts = split_oracle_table_ddl_with_retained(source, "APP", "T", &[], &retained).unwrap();
        assert!(parts.table_ddl.contains("CONSTRAINT PK_T PRIMARY KEY(ID) USING INDEX ENABLE"));
        assert!(parts.table_ddl.contains("CONSTRAINT UQ_T UNIQUE(U)"));
        assert!(parts.supporting_constraints.is_empty());
        assert_eq!(parts.indexes, ["CREATE INDEX APP.IX_T ON APP.T(U);"]);
        assert!(parts.trailing_ddl.contains("GRANT SELECT ON APP.T TO READER"));
        let result = separate_oracle_supporting_indexes_with_retained(source, "APP", "T", &[], &retained).unwrap();
        assert_eq!(result.matches("CREATE INDEX").count(), 1);
        assert!(!result.contains("ALTER TABLE"));
    }

    #[test]
    fn retained_supporting_index_requires_self_contained_recoverable_relationship() {
        let retained =
            OracleSupportingIndexIdentity { constraint_name: "PK_T".into(), owner: "APP".into(), name: "IX_PK".into() };
        for source in [
            "CREATE TABLE APP.T(ID NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID) DISABLE);",
            "CREATE TABLE APP.T(ID NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID) DEFERRABLE INITIALLY IMMEDIATE);",
            "CREATE TABLE APP.T(ID NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID) USING INDEX APP.IX_PK ENABLE);",
            "CREATE TABLE APP.T(ID NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID) USING INDEX (CREATE INDEX APP.IX_PK ON APP.T(ID)) ENABLE);",
            "CREATE TABLE APP.T(ID NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID)); CREATE INDEX APP.IX_PK ON APP.T(ID);",
        ] {
            assert!(split_oracle_table_ddl_with_retained(source, "APP", "T", &[], std::slice::from_ref(&retained)).is_err(), "{source}");
        }
        assert!(split_oracle_table_ddl_with_retained(
            "CREATE TABLE APP.T(ID NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID) NOT DEFERRABLE ENABLE);",
            "APP",
            "T",
            &[],
            std::slice::from_ref(&retained)
        )
        .is_ok());
        let shared = OracleSupportingIndexIdentity { constraint_name: "UQ_T".into(), ..retained.clone() };
        assert!(split_oracle_table_ddl_with_retained(
            "CREATE TABLE APP.T(ID NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID), CONSTRAINT UQ_T UNIQUE(ID));",
            "APP",
            "T",
            &[],
            &[retained, shared]
        )
        .is_err());
    }

    #[test]
    fn retained_inline_unique_index_removes_only_proven_redundant_create_and_preserves_comments() {
        let source = "CREATE TABLE APP.T(ID NUMBER, U NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID) USING INDEX ENABLE); CREATE /*keep duplicate source note*/ UNIQUE INDEX APP.PK_T ON APP.T(ID); CREATE INDEX APP.IX_T ON APP.T(U); CREATE INDEX APP.IX_T ON APP.T(U);";
        let retained = [OracleSupportingIndexIdentity {
            constraint_name: "PK_T".into(),
            owner: "APP".into(),
            name: "PK_T".into(),
        }];
        let parts = split_oracle_table_ddl_with_retained(source, "APP", "T", &[], &retained).unwrap();
        assert_eq!(parts.indexes, ["CREATE INDEX APP.IX_T ON APP.T(U);"]);
        assert!(parts.trailing_ddl.contains("/*keep duplicate source note*/"));
        assert_eq!(
            oracle_table_created_index_identities(source, "APP", &retained).unwrap(),
            [("APP".into(), "IX_T".into())]
        );
        for changed in [
            source.replace("UNIQUE INDEX APP.PK_T", "INDEX APP.PK_T"),
            source.replace("ON APP.T(ID)", "ON APP.T(U)"),
            source.replace("ON APP.T(ID)", "ON APP.T(ID) INVISIBLE"),
        ] {
            assert!(split_oracle_table_ddl_with_retained(&changed, "APP", "T", &[], &retained).is_err());
        }
        assert!(split_oracle_table_ddl_with_retained(
            &source.replacen("CREATE INDEX APP.IX_T ON APP.T(U);", "CREATE INDEX APP.IX_T ON APP.T(ID);", 1),
            "APP",
            "T",
            &[],
            &retained
        )
        .is_err());
    }
    #[test]
    fn trigger_state_uses_explicit_restore_and_rejects_conflicting_restores() {
        let source = "CREATE TRIGGER APP.TR BEFORE INSERT ON APP.T DISABLE BEGIN NULL; END;";
        let (_, mut triggers) = extract_oracle_table_triggers(source, "APP", "T").unwrap();
        assert!(!oracle_trigger_enabled(&triggers[0]).unwrap());
        triggers[0].state_statements.push("ALTER TRIGGER APP.TR ENABLE".into());
        assert!(oracle_trigger_enabled(&triggers[0]).unwrap());
        triggers[0].state_statements.push("ALTER TRIGGER APP.TR DISABLE".into());
        assert!(order_oracle_trigger_sources(&triggers).unwrap_err().contains("conflicting"));
    }

    #[test]
    fn trigger_creation_order_respects_follows_and_precedes_without_reversing_dependencies() {
        for ordering in ["FOLLOWS", "PRECEDES"] {
            let source = format!("CREATE TRIGGER APP.A BEFORE INSERT ON APP.T FOR EACH ROW {ordering} APP.Z BEGIN NULL; END;\nCREATE TRIGGER APP.Z BEFORE INSERT ON APP.T FOR EACH ROW BEGIN NULL; END;");
            let (_, triggers) = extract_oracle_table_triggers(&source, "APP", "T").unwrap();
            let ordered = order_oracle_trigger_sources(&triggers).unwrap();
            assert_eq!(ordered.iter().map(|trigger| trigger.name.as_str()).collect::<Vec<_>>(), ["Z", "A"]);
            assert!(order_oracle_trigger_sources(&triggers[..1]).unwrap_err().contains("unavailable"));
            let mut cyclic = triggers.clone();
            cyclic[1].dependencies.push(("APP".into(), "A".into()));
            assert!(order_oracle_trigger_sources(&cyclic).unwrap_err().contains("cycle"));
        }
    }

    #[test]
    fn independent_table_output_preserves_complete_raw_only_trigger_once() {
        let trigger = "CREATE TRIGGER APP.TR BEFORE INSERT ON APP.T FOR EACH ROW BEGIN :NEW.ID := 1; END;";
        let source = format!("CREATE TABLE APP.T(ID NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID));\n{trigger}\n/\nALTER TRIGGER APP.TR DISABLE;");
        let parts = split_oracle_table_ddl(&source, "APP", "T", &[index()]).unwrap();
        assert_eq!(parts.triggers.len(), 1);
        assert_eq!(parts.triggers[0].ddl, trigger);
        assert!(!parts.trailing_ddl.contains("TRIGGER"));
        let result = separate_oracle_supporting_indexes(&source, "APP", "T", &[index()]).unwrap();
        assert_eq!(result.matches("CREATE TRIGGER").count(), 1);
        assert!(result.contains(trigger));
        assert!(result.contains("ALTER TRIGGER APP.TR DISABLE;"));
    }

    #[test]
    fn trigger_mapping_changes_only_header_bindings_and_exact_state_identity() {
        let source = "CREATE OR REPLACE EDITIONABLE TRIGGER \"Src\".\"Tr\" BEFORE INSERT ON \"Src\"./*bind*/\"T\" REFERENCING NEW AS N FOR EACH ROW FOLLOWS \"Src\".\"Earlier\" WHEN (N.ID > 0)\nBEGIN\nUPDATE \"Src\".\"T\" SET ID = 1; EXECUTE IMMEDIATE nq'[ALTER TABLE Src.T ADD C NUMBER;]';\nEND;\n/\nALTER TRIGGER \"Src\".\"Tr\" DISABLE;";
        let result = rebase_oracle_trigger_ddl(
            source,
            &mapping("Src", "T", "Dst", "NewT"),
            &[mapping("Src", "Tr", "Dst", "Tr"), mapping("Src", "Earlier", "Dst", "Earlier")],
        )
        .unwrap();
        assert!(result.contains("TRIGGER \"Dst\".\"Tr\" BEFORE INSERT ON \"Dst\"./*bind*/\"NewT\""));
        assert!(result.contains("FOLLOWS \"Dst\".\"Earlier\" WHEN (N.ID > 0)"));
        assert!(result.contains("UPDATE \"Src\".\"T\" SET ID = 1"));
        assert!(result.contains("nq'[ALTER TABLE Src.T ADD C NUMBER;]'"));
        assert!(result.contains("ALTER TRIGGER \"Dst\".\"Tr\" DISABLE"));
        assert!(rebase_oracle_trigger_ddl(
            source,
            &mapping("Src", "T", "Dst", "NewT"),
            &[mapping("Src", "Tr", "Dst", "Tr")]
        )
        .is_err());
    }

    #[test]
    fn extracts_complete_triggers_and_states_without_swallowing_adjacent_table_ddl() {
        let trigger = "CREATE OR REPLACE TRIGGER APP.A BEFORE INSERT ON APP.T FOR EACH ROW FOLLOWS APP.Z BEGIN EXECUTE IMMEDIATE q'[ALTER TABLE APP.T DROP COLUMN ID;]'; END;";
        let call = "CREATE TRIGGER APP.Z BEFORE INSERT ON APP.T FOR EACH ROW CALL APP.P(:NEW.ID);";
        let source = format!("CREATE TABLE APP.T(ID NUMBER);\n{trigger}\n/\nALTER TRIGGER APP.A DISABLE;\n{call}\n/\nCOMMENT ON TABLE APP.T IS 'keep';\nCREATE INDEX APP.IX ON APP.T(ID);");
        let (remaining, triggers) = extract_oracle_table_triggers(&source, "APP", "T").unwrap();
        assert_eq!(triggers.len(), 2);
        assert_eq!(triggers[0].ddl, trigger);
        assert_eq!(triggers[0].dependencies, vec![("APP".into(), "Z".into())]);
        assert_eq!(triggers[0].state_statements, vec!["ALTER TRIGGER APP.A DISABLE"]);
        assert_eq!(triggers[1].ddl, call);
        assert!(!remaining.contains("TRIGGER"));
        assert!(!remaining.lines().any(|line| line.trim() == "/"));
        assert!(remaining.contains("COMMENT ON TABLE APP.T IS 'keep'"));
        assert!(remaining.contains("CREATE INDEX APP.IX ON APP.T(ID)"));
    }

    #[test]
    fn extraction_rejects_incomplete_foreign_or_orphan_trigger_sources() {
        for source in [
            "CREATE TRIGGER APP.TR BEFORE INSERT ON APP.T BEGIN NULL;",
            "CREATE TRIGGER APP.TR BEFORE INSERT ON APP.OTHER BEGIN NULL; END;",
            "ALTER TRIGGER APP.TR ENABLE;",
            "CREATE TRIGGER APP.TR BEFORE INSERT ON APP.T BEGIN NULL; END; ALTER TRIGGER APP.TR COMPILE;",
        ] {
            assert!(extract_oracle_table_triggers(source, "APP", "T").is_err(), "{source}");
        }
        let source = "CREATE TABLE APP.T(V VARCHAR2(100) DEFAULT q'[CREATE TRIGGER APP.TR BEFORE INSERT ON APP.T BEGIN NULL; END;]'); -- ALTER TRIGGER APP.TR ENABLE;";
        let (remaining, triggers) = extract_oracle_table_triggers(source, "APP", "T").unwrap();
        assert_eq!(remaining, source);
        assert!(triggers.is_empty());
    }

    fn mapping(owner: &str, name: &str, target_owner: &str, target_name: &str) -> OracleDdlNameMapping {
        OracleDdlNameMapping {
            source_owner: owner.into(),
            source_name: name.into(),
            target_owner: target_owner.into(),
            target_name: target_name.into(),
        }
    }

    #[test]
    fn rebases_table_and_column_grants_without_changing_privileges_or_grantees() {
        let source = "GRANT SELECT, UPDATE ON \"Src\"./* object */\"T\" TO \"Src\", PUBLIC WITH GRANT OPTION;\nGRANT UPDATE (\"ON\", \"Src\"), REFERENCES (\"T\") ON TABLE \"Src\".\"T\" TO \"REFERENCES\";";
        let result = rebase_oracle_table_ddl(source, &mapping("Src", "T", "Dst", "Renamed"), &[], &[]).unwrap();
        assert_eq!(result, "GRANT SELECT, UPDATE ON \"Dst\"./* object */\"Renamed\" TO \"Src\", PUBLIC WITH GRANT OPTION;\nGRANT UPDATE (\"ON\", \"Src\"), REFERENCES (\"T\") ON TABLE \"Dst\".\"Renamed\" TO \"REFERENCES\";");
        let result =
            rebase_oracle_table_ddl("GRANT SELECT ON t TO app;", &mapping("APP", "T", "APP", "T2"), &[], &[]).unwrap();
        assert_eq!(result, "GRANT SELECT ON \"APP\".\"T2\" TO app;");
        let escaped = "GRANT SELECT ON \"S'\".\"T\"\"x\" TO \"S'\";";
        assert_eq!(
            rebase_oracle_table_ddl(escaped, &mapping("S'", "T\"x", "D", "R"), &[], &[]).unwrap(),
            "GRANT SELECT ON \"D\".\"R\" TO \"S'\";"
        );
    }

    #[test]
    fn grant_mapping_rejects_other_objects_and_does_not_scan_past_statement_boundaries() {
        let table = mapping("APP", "T", "DEST", "T");
        for source in ["GRANT SELECT ON APP.OTHER TO APP;", "GRANT SELECT; COMMENT ON TABLE APP.T IS 'x';"] {
            assert!(rebase_oracle_table_ddl(source, &table, &[], &[]).is_err());
        }
        let source = "CREATE TABLE APP.T (V VARCHAR2(80) DEFAULT nq'[GRANT SELECT ON APP.T TO APP;]'); -- GRANT SELECT ON APP.T TO APP;\nCOMMENT ON TABLE APP.T IS q'[GRANT SELECT ON APP.T TO APP;]';";
        let result = rebase_oracle_table_ddl(source, &table, &[], &[]).unwrap();
        assert!(result.contains("nq'[GRANT SELECT ON APP.T TO APP;]'"));
        assert!(result.contains("-- GRANT SELECT ON APP.T TO APP;"));
        assert!(result.contains("q'[GRANT SELECT ON APP.T TO APP;]'"));
    }

    #[test]
    fn rebases_only_object_identity_spans_and_preserves_literals_comments_and_physical_names() {
        let source = "CREATE TABLE \"Src\"./* table identity */\"T\" (ID NUMBER DEFAULT nq'[a' \"Src\".\"T\" CREATE INDEX fake]', VALUE VARCHAR2(30) DEFAULT 'Src.T', CONSTRAINT FK_SELF FOREIGN KEY(ID) REFERENCES \"Src\".\"T\"(ID), CONSTRAINT FK_OTHER FOREIGN KEY(ID) REFERENCES \"Src\".\"Other\"(ID), CONSTRAINT FK_THIRD FOREIGN KEY(ID) REFERENCES THIRD.T(ID)) TABLESPACE \"Src\";\nCREATE INDEX \"Src\".\"Ix\" ON \"Src\".\"T\"(LOWER(VALUE) DESC) TABLESPACE \"Src\";\nALTER TABLE \"Src\".\"T\" ADD CONSTRAINT PK PRIMARY KEY(ID) USING INDEX \"Src\".\"Ix\" ENABLE;\nCOMMENT ON TABLE \"Src\".\"T\" IS q'[a' \"Src\".\"T\"]';\nCOMMENT ON COLUMN \"Src\".\"T\".VALUE IS 'unchanged';";
        let result = rebase_oracle_table_ddl(
            source,
            &mapping("Src", "T", "Dst", "Renamed"),
            &[mapping("Src", "Other", "Dst", "Unselected")],
            &[mapping("Src", "Ix", "Dst", "Ix")],
        )
        .unwrap();
        assert!(result.starts_with("CREATE TABLE \"Dst\"./* table identity */\"Renamed\""));
        assert!(result.contains("nq'[a' \"Src\".\"T\" CREATE INDEX fake]'"));
        assert!(result.contains("REFERENCES \"Dst\".\"Renamed\"(ID)"));
        assert!(result.contains("REFERENCES \"Dst\".\"Unselected\"(ID)"));
        assert!(result.contains("REFERENCES THIRD.T(ID)"));
        assert!(
            result.contains("CREATE INDEX \"Dst\".\"Ix\" ON \"Dst\".\"Renamed\"(LOWER(VALUE) DESC) TABLESPACE \"Src\"")
        );
        assert!(result.contains(
            "ALTER TABLE \"Dst\".\"Renamed\" ADD CONSTRAINT PK PRIMARY KEY(ID) USING INDEX \"Dst\".\"Ix\" ENABLE"
        ));
        assert!(result.contains("COMMENT ON TABLE \"Dst\".\"Renamed\" IS q'[a' \"Src\".\"T\"]'"));
        assert!(result.contains("COMMENT ON COLUMN \"Dst\".\"Renamed\".VALUE IS 'unchanged'"));
    }

    #[test]
    fn rebases_only_source_owned_sequence_references_in_column_defaults() {
        let source = "CREATE TABLE SRC.T (ID NUMBER DEFAULT SRC.T.NEXTVAL NOT NULL, V NUMBER DEFAULT ON NULL (src.SEQ.CURRVAL + 1), X NUMBER DEFAULT CASE WHEN 1=1 THEN SRC.SEQ.NEXTVAL ELSE 0 END CONSTRAINT C CHECK(X>0), Y NUMBER GENERATED BY DEFAULT AS IDENTITY, Z VARCHAR2(100) DEFAULT nq'[SRC.SEQ.NEXTVAL ' DEFAULT]', A NUMBER DEFAULT OTHER.SEQ.NEXTVAL, B NUMBER DEFAULT SEQ.NEXTVAL); CREATE INDEX SRC.IX ON SRC.T(SRC.SEQ.NEXTVAL);";
        let result = rebase_oracle_table_ddl(
            source,
            &mapping("SRC", "T", "DST", "RENAMED"),
            &[],
            &[mapping("SRC", "IX", "DST", "IX")],
        )
        .unwrap();
        assert!(result.contains("DEFAULT \"DST\".T.NEXTVAL NOT NULL"));
        assert!(result.contains("DEFAULT ON NULL (\"DST\".SEQ.CURRVAL + 1)"));
        assert!(result.contains("THEN \"DST\".SEQ.NEXTVAL ELSE 0 END CONSTRAINT C CHECK(X>0)"));
        assert!(result.contains("GENERATED BY DEFAULT AS IDENTITY"));
        assert!(result.contains("nq'[SRC.SEQ.NEXTVAL ' DEFAULT]'"));
        assert!(result.contains("DEFAULT OTHER.SEQ.NEXTVAL"));
        assert!(result.contains("DEFAULT SEQ.NEXTVAL"));
        assert!(result.contains("ON \"DST\".\"RENAMED\"(SRC.SEQ.NEXTVAL)"));
    }

    #[test]
    fn default_sequence_mapping_preserves_exact_identifiers_and_comments() {
        let source = "CREATE TABLE \"S\"\"rc\".T (ID NUMBER DEFAULT (\"S\"\"rc\" /*owner*/ . \"Seq\" . NEXTVAL), V NUMBER DEFAULT \"s\"\"rc\".SEQ.NEXTVAL, X NUMBER DEFAULT 'S\"rc.SEQ.NEXTVAL', Y NUMBER DEFAULT q'[S\"rc.SEQ.NEXTVAL]')";
        let result = rebase_oracle_table_ddl(source, &mapping("S\"rc", "T", "D\"st", "T"), &[], &[]).unwrap();
        assert!(result.contains("(\"D\"\"st\" /*owner*/ . \"Seq\" . NEXTVAL)"));
        assert!(result.contains("DEFAULT \"s\"\"rc\".SEQ.NEXTVAL"));
        assert!(result.contains("DEFAULT 'S\"rc.SEQ.NEXTVAL'"));
        assert!(result.contains("q'[S\"rc.SEQ.NEXTVAL]'"));
    }

    #[test]
    fn rejects_ambiguous_source_default_dependencies_without_rejecting_third_party_ones() {
        for expression in [
            "SRC.SEQ.NEXTVAL@LINK",
            "SRC.PKG.VALUE()",
            "SRC.PKG.NEXTVAL()",
            "SRC.PKG.CURRVAL()",
            "SRC.EXTRA.SEQ.NEXTVAL",
        ] {
            let source = format!("CREATE TABLE SRC.T (ID NUMBER DEFAULT {expression})");
            let error = rebase_oracle_table_ddl(&source, &mapping("SRC", "T", "DST", "T"), &[], &[]).unwrap_err();
            assert!(error.contains("SRC.T.ID: DEFAULT dependency"), "{error}");
        }
        let source =
            "CREATE TABLE SRC.T (ID NUMBER DEFAULT OTHER.SEQ.NEXTVAL@LINK, V NUMBER DEFAULT OTHER.SRC.SEQ.NEXTVAL)";
        let result = rebase_oracle_table_ddl(source, &mapping("SRC", "T", "DST", "T"), &[], &[]).unwrap();
        assert!(result.contains("DEFAULT OTHER.SEQ.NEXTVAL@LINK"));
        assert!(result.contains("DEFAULT OTHER.SRC.SEQ.NEXTVAL"));
        let same = rebase_oracle_table_ddl(
            "CREATE TABLE SRC.T (ID NUMBER DEFAULT SRC.SEQ.NEXTVAL)",
            &mapping("SRC", "T", "SRC", "T2"),
            &[],
            &[],
        )
        .unwrap();
        assert!(same.contains("DEFAULT SRC.SEQ.NEXTVAL"));
    }

    #[test]
    fn native_table_script_keeps_post_table_primary_key_and_index_boundaries() {
        let source = "CREATE TABLE APP.T (ID NUMBER, U NUMBER, CONSTRAINT UQ_T UNIQUE(U) USING INDEX ENABLE) TABLESPACE USERS\nCREATE INDEX APP.IX_PK ON APP.T(ID) TABLESPACE USERS\nALTER TABLE APP.T ADD CONSTRAINT PK_T PRIMARY KEY(ID) USING INDEX APP.IX_PK ENABLE;\nCREATE INDEX APP.IX_U ON APP.T(U);";
        let parsed = parse_oracle_table_ddl(source).unwrap();
        assert_eq!(parsed.supporting_constraints.len(), 2);
        assert!(parsed
            .supporting_constraints
            .iter()
            .any(|constraint| constraint.name.as_deref() == Some("PK_T") && constraint.constraint_type == "P"));
        let indexes = oracle_index_ddl_sources(source, "APP").unwrap();
        assert_eq!(indexes.len(), 2);
        assert!(!indexes[0].ddl.contains("ALTER TABLE"));
        let parts = split_oracle_table_ddl_with_retained(source, "APP", "T", &[], &[]).unwrap();
        assert!(!parts.table_ddl.contains("CREATE INDEX"));
        assert!(!parts.table_ddl.contains("ALTER TABLE"));
        assert_eq!(parts.supporting_constraints.len(), 1);
    }

    #[test]
    fn post_table_foreign_keys_are_deferred_and_binding_conflicts_are_rejected() {
        let source = "CREATE TABLE APP.T(ID NUMBER DEFAULT q'[CREATE INDEX fake ON T(ID)]')\nCREATE INDEX APP.IX_PK ON APP.T(ID)\nALTER TABLE APP.T ADD CONSTRAINT PK_T PRIMARY KEY(ID) USING INDEX APP.IX_PK ENABLE; ALTER TABLE APP.T ADD CONSTRAINT FK_T FOREIGN KEY(ID) REFERENCES APP.P(ID) ENABLE;";
        let supporting = OracleSupportingIndexDdl {
            constraint_name: "PK_T".into(),
            owner: "APP".into(),
            name: "IX_PK".into(),
            ddl: "CREATE INDEX APP.IX_PK ON APP.T(ID)".into(),
        };
        let parts =
            split_oracle_table_ddl_with_retained(source, "APP", "T", std::slice::from_ref(&supporting), &[]).unwrap();
        assert_eq!(parts.indexes.len(), 1);
        assert_eq!(parts.supporting_constraints.len(), 1);
        assert_eq!(parts.foreign_keys.len(), 1);
        assert!(parts.foreign_keys[0].contains("REFERENCES APP.P(ID) ENABLE"));
        assert!(!parts.trailing_ddl.contains("ALTER TABLE"));
        assert!(parts.table_ddl.contains("q'[CREATE INDEX fake ON T(ID)]'"));
        assert!(!parts.indexes[0].contains("UNIQUE"));
        let conflict = source.replace("USING INDEX APP.IX_PK", "USING INDEX APP.OTHER");
        assert!(split_oracle_table_ddl_with_retained(&conflict, "APP", "T", &[supporting], &[]).is_err());
        let retained =
            OracleSupportingIndexIdentity { constraint_name: "PK_T".into(), owner: "APP".into(), name: "IX_PK".into() };
        assert!(split_oracle_table_ddl_with_retained(source, "APP", "T", &[], &[retained]).is_err());
    }

    #[test]
    fn native_table_boundaries_reject_incomplete_and_mismatched_constraints() {
        for source in [
            "CREATE TABLE APP.T(ID NUMBER\nCREATE INDEX APP.IX ON APP.T(ID);",
            "CREATE TABLE APP.T(ID NUMBER)\nCREATE INDEX APP.IX ON APP.T(ID\nALTER TABLE APP.T ADD CONSTRAINT PK PRIMARY KEY(ID);",
            "CREATE TABLE APP.T(ID NUMBER)\nALTER TABLE OTHER.T ADD CONSTRAINT PK PRIMARY KEY(ID);",
            "CREATE TABLE APP.T(ID NUMBER)\nALTER TABLE APP.OTHER ADD CONSTRAINT PK PRIMARY KEY(ID);",
            "CREATE TABLE APP.T(ID NUMBER, CONSTRAINT PK PRIMARY KEY(ID)); ALTER TABLE APP.T ADD CONSTRAINT PK PRIMARY KEY(ID);",
            "CREATE TABLE APP.T(ID NUMBER)\nCREATE TABLE APP.OTHER(ID NUMBER);",
        ] {
            assert!(parse_oracle_table_ddl(source).is_err(), "{source}");
        }
    }

    #[test]
    fn continuous_post_constraints_keep_comments_and_defer_foreign_keys() {
        let source = "CREATE TABLE APP.T(ID NUMBER)\nALTER /*keep-a*/ TABLE APP.T ADD /*keep-b*/ CONSTRAINT P PRIMARY KEY(ID)\nALTER TABLE APP.T ADD CONSTRAINT U UNIQUE(ID)\nALTER TABLE APP.T ADD CONSTRAINT F FOREIGN KEY(ID) REFERENCES APP.PARENT(ID);";
        let parts = split_oracle_table_ddl_with_retained(source, "APP", "T", &[], &[]).unwrap();
        assert_eq!(parts.supporting_constraints.len(), 2);
        assert_eq!(parts.foreign_keys.len(), 1);
        assert!(parts.supporting_constraints[0].contains("/*keep-a*/"));
        assert!(parts.supporting_constraints[0].contains("/*keep-b*/"));
        assert!(!parts.supporting_constraints.iter().any(|sql| sql.contains("FOREIGN KEY")));
        assert!(!parts.trailing_ddl.contains("ALTER TABLE"));
        let implicit_primary = source.replace("REFERENCES APP.PARENT(ID)", "REFERENCES APP.PARENT ENABLE");
        let parts = split_oracle_table_ddl_with_retained(&implicit_primary, "APP", "T", &[], &[]).unwrap();
        assert!(parts.foreign_keys[0].contains("REFERENCES APP.PARENT ENABLE"));
    }

    #[test]
    fn native_statement_termination_uses_tokens_and_rejects_dangling_definitions() {
        let source = "CREATE TABLE APP.T(ID NUMBER)\nCREATE INDEX APP.IX ON APP.T(ID) -- keep-semicolon;\nALTER TABLE APP.T ADD CONSTRAINT P PRIMARY KEY(ID) USING INDEX APP.IX;";
        let parts = split_oracle_table_ddl_with_retained(source, "APP", "T", &[], &[]).unwrap();
        assert!(parts.indexes[0].contains("-- keep-semicolon;\n;"), "{:?}", parts.indexes);
        for source in [
            "CREATE TABLE APP.T(ID NUMBER) TABLESPACE\nCREATE INDEX APP.IX ON APP.T(ID);",
            "CREATE TABLE APP.T(ID NUMBER); ALTER TABLE APP.T ADD CONSTRAINT F FOREIGN KEY(ID) REFERENCES;",
        ] {
            assert!(parse_oracle_table_ddl(source).is_err(), "{source}");
        }
    }

    #[test]
    fn unqualified_sequences_named_like_the_source_owner_remain_unqualified() {
        let source = "CREATE TABLE SRC.T (ID NUMBER DEFAULT src.NEXTVAL, V NUMBER DEFAULT \"SRC\".CURRVAL)";
        let result = rebase_oracle_table_ddl(source, &mapping("SRC", "T", "DST", "T"), &[], &[]).unwrap();
        assert!(result.contains("DEFAULT src.NEXTVAL"));
        assert!(result.contains("DEFAULT \"SRC\".CURRVAL"));
        for expression in ["SRC.NEXTVAL()", "SRC.CURRVAL@LINK", "SRC.NEXTVAL.EXTRA"] {
            let source = format!("CREATE TABLE SRC.T(ID NUMBER DEFAULT {expression})");
            assert!(rebase_oracle_table_ddl(&source, &mapping("SRC", "T", "DST", "T"), &[], &[]).is_err());
        }
    }

    #[test]
    fn rebases_unqualified_names_and_same_owner_table_mapping_without_touching_expressions() {
        let source = "CREATE TABLE t (id NUMBER, CONSTRAINT fk FOREIGN KEY(id) REFERENCES parent(id)); CREATE INDEX ix ON t(id DESC); COMMENT ON COLUMN t.id IS 't.id';";
        let result = rebase_oracle_table_ddl(
            source,
            &mapping("APP", "T", "APP", "T2"),
            &[mapping("APP", "PARENT", "APP", "P2")],
            &[mapping("APP", "IX", "APP", "IX2")],
        )
        .unwrap();
        assert!(result.starts_with("CREATE TABLE \"APP\".\"T2\""));
        assert!(result.contains("REFERENCES \"APP\".\"P2\"(id)"));
        assert!(result.contains("CREATE INDEX \"APP\".\"IX2\" ON \"APP\".\"T2\"(id DESC)"));
        assert!(result.contains("COMMENT ON COLUMN \"APP\".\"T2\".id IS 't.id'"));
        assert!(rebase_oracle_table_ddl(source, &mapping("APP", "OTHER", "APP", "T2"), &[], &[]).is_err());
        assert!(rebase_oracle_table_ddl(source, &mapping("APP", "T", "APP", "T2"), &[], &[]).is_err());
    }

    #[test]
    fn requires_explicit_cross_owner_index_mapping_and_rejects_incomplete_source() {
        let source = "CREATE INDEX \"IndexOwner\".\"I\"\"x\" ON APP.T(id);";
        let table = mapping("APP", "T", "DEST", "T");
        assert!(rebase_oracle_table_ddl(source, &table, &[], &[]).is_err());
        assert!(rebase_oracle_table_ddl(
            "CREATE TABLE APP.T (id NUMBER);",
            &table,
            &[mapping("APP", "T", "DEST", "OTHER")],
            &[]
        )
        .is_err());
        let references =
            rebase_oracle_table_ddl("CREATE TABLE APP.T (id NUMBER REFERENCES APP.PARENT(id));", &table, &[], &[])
                .unwrap();
        assert!(references.contains("REFERENCES \"DEST\".PARENT(id)"));
        let result =
            rebase_oracle_table_ddl(source, &table, &[], &[mapping("IndexOwner", "I\"x", "MappedOwner", "I\"x")])
                .unwrap();
        assert_eq!(result, "CREATE INDEX \"MappedOwner\".\"I\"\"x\" ON \"DEST\".T(id);");
        assert!(rebase_oracle_table_ddl("CREATE TABLE APP.T (id NUMBER", &table, &[], &[]).is_err());
        assert!(rebase_oracle_table_ddl(
            "CREATE TABLE APP.T (id VARCHAR2(30) DEFAULT q'[unfinished)",
            &table,
            &[],
            &[]
        )
        .is_err());
    }
    fn index() -> OracleSupportingIndexDdl {
        OracleSupportingIndexDdl {
            constraint_name: "PK_T".into(),
            owner: "APP".into(),
            name: "IX_T".into(),
            ddl: "CREATE INDEX \"APP\".\"IX_T\" ON \"APP\".\"T\"(\"ID\")".into(),
        }
    }
    #[test]
    fn parses_exact_table_identity_and_constraint_states_without_reading_literals_as_ddl() {
        let source = "CREATE TABLE \"Mixed\".\"t\" (id NUMBER DEFAULT q'[PRIMARY KEY (fake) ' DISABLE]', CONSTRAINT \"Pk\" PRIMARY KEY(id) USING INDEX (CREATE INDEX \"Ix\" ON \"Mixed\".\"t\"(id) TABLESPACE \"DISABLE\") ENABLE, value NUMBER CONSTRAINT \"Uq\" UNIQUE DISABLE) ORGANIZATION INDEX;";
        let parsed = parse_oracle_table_ddl(source).unwrap();
        assert_eq!(parsed.owner.as_deref(), Some("Mixed"));
        assert_eq!(parsed.table, "t");
        assert!(parsed.index_organized);
        assert_eq!(parsed.supporting_constraints.len(), 2);
        assert_eq!(parsed.supporting_constraints[0].name.as_deref(), Some("Pk"));
        assert!(!parsed.supporting_constraints[0].disabled);
        assert_eq!(parsed.supporting_constraints[1].name.as_deref(), Some("Uq"));
        assert!(parsed.supporting_constraints[1].disabled);
    }

    #[test]
    fn validates_table_identity_even_when_no_supporting_index_is_supplied() {
        let source = "CREATE TABLE app.t (id NUMBER DEFAULT 'PRIMARY KEY');";
        assert_eq!(parse_oracle_table_ddl(source).unwrap().owner.as_deref(), Some("APP"));
        assert!(separate_oracle_supporting_indexes(source, "OTHER", "T", &[]).is_err());
        assert!(separate_oracle_supporting_indexes(source, "APP", "OTHER", &[]).is_err());
        assert!(separate_oracle_supporting_indexes("SELECT 1 FROM DUAL", "APP", "T", &[]).is_err());
        assert!(parse_oracle_table_ddl("CREATE TABLE app.t (id NUMBER").is_err());
    }

    #[test]
    fn extracts_only_standalone_index_source_without_rebuilding_expressions_or_storage() {
        let standalone = "CREATE UNIQUE INDEX \"MiX\".\"I\"\"x\" ON \"MiX\".\"T\" (LOWER(\"Value\"), CASE WHEN \"ID\" = 1 THEN q'[x'; CREATE INDEX fake ON O(x)]' ELSE 'z' END DESC) INVISIBLE LOCAL;";
        let script = format!("CREATE TABLE \"MiX\".\"T\" (\"ID\" NUMBER, CONSTRAINT PK PRIMARY KEY(\"ID\") USING INDEX (CREATE INDEX nested ON \"MiX\".\"T\"(\"ID\")));\n{standalone}");
        let indexes = oracle_index_ddl_sources(&script, "MiX").unwrap();
        assert_eq!(indexes.len(), 1);
        assert_eq!(indexes[0].owner, "MiX");
        assert_eq!(indexes[0].name, "I\"x");
        assert_eq!(indexes[0].table_owner, "MiX");
        assert_eq!(indexes[0].table, "T");
        assert_eq!(indexes[0].ddl, standalone);
    }

    #[test]
    fn standalone_index_identity_uses_oracle_name_rules_and_rejects_ambiguous_source() {
        let source = "CREATE INDEX ix ON t (id DESC);";
        let indexes = oracle_index_ddl_sources(source, "MiX").unwrap();
        assert_eq!(indexes[0].owner, "MiX");
        assert_eq!(indexes[0].name, "IX");
        assert_eq!(indexes[0].table, "T");
        assert_eq!(oracle_index_ddl_sources(&format!("{source}{source}"), "MiX").unwrap().len(), 2);
        assert!(
            oracle_index_ddl_sources(&format!("{source}{}", source.replace("id DESC", "other ASC")), "MiX").is_err()
        );
        assert!(oracle_index_ddl_sources("CREATE INDEX ix ON t (id", "MiX").is_err());
        assert!(oracle_index_ddl_sources("CREATE INDEX ix TABLE t (id);", "MiX").is_err());
    }
    #[test]
    fn separates_supporting_index_before_constraints_and_foreign_keys() {
        let source = "CREATE TABLE \"APP\".\"T\" (\"ID\" NUMBER, CONSTRAINT \"PK_T\" PRIMARY KEY(\"ID\") USING INDEX PCTFREE 10 ENABLE, CONSTRAINT \"FK_T\" FOREIGN KEY(\"ID\") REFERENCES \"APP\".\"T\"(\"ID\"));";
        let result = separate_oracle_supporting_indexes(source, "APP", "T", &[index()]).unwrap();
        assert!(result.starts_with("CREATE TABLE \"APP\".\"T\" (\"ID\" NUMBER);"));
        assert!(result.contains("USING INDEX \"APP\".\"IX_T\" ENABLE"));
        assert!(result.find("CREATE INDEX").unwrap() < result.find("ADD CONSTRAINT \"PK_T\"").unwrap());
        assert!(result.find("ADD CONSTRAINT \"PK_T\"").unwrap() < result.find("ADD CONSTRAINT \"FK_T\"").unwrap());
    }

    #[test]
    fn exposes_foreign_keys_separately_even_without_a_local_supporting_index() {
        let source = "CREATE TABLE APP.CHILD (ID NUMBER, CONSTRAINT FK_CHILD FOREIGN KEY(ID) REFERENCES APP.PARENT(ID));\nCOMMENT ON TABLE APP.CHILD IS 'child';";
        let parts = split_oracle_table_ddl(source, "APP", "CHILD", &[]).unwrap();
        assert_eq!(parts.table_ddl, "CREATE TABLE APP.CHILD (ID NUMBER);");
        assert!(parts.indexes.is_empty());
        assert!(parts.supporting_constraints.is_empty());
        assert_eq!(
            parts.foreign_keys,
            ["ALTER TABLE \"APP\".\"CHILD\" ADD CONSTRAINT FK_CHILD FOREIGN KEY(ID) REFERENCES APP.PARENT(ID);"]
        );
        assert_eq!(parts.trailing_ddl, "\nCOMMENT ON TABLE APP.CHILD IS 'child';");
        assert_eq!(separate_oracle_supporting_indexes(source, "APP", "CHILD", &[]).unwrap(), source);
    }

    #[test]
    fn groups_complete_ordinary_indexes_without_moving_lookalikes_in_comments_or_literals() {
        let ordinary = "CREATE INDEX APP.ORDINARY ON APP.T(LOWER(VALUE) DESC) INVISIBLE;";
        let source = format!("CREATE TABLE APP.T (ID NUMBER, VALUE VARCHAR2(30), CONSTRAINT PK_T PRIMARY KEY(ID));\n-- {ordinary}\n{ordinary}\nCOMMENT ON TABLE APP.T IS q'[a' {ordinary}]';");
        let parts = split_oracle_table_ddl(&source, "APP", "T", &[index()]).unwrap();
        assert_eq!(parts.indexes.len(), 2);
        assert_eq!(parts.indexes[0], ordinary);
        assert!(parts.indexes[1].contains("IX_T"));
        assert!(parts.trailing_ddl.contains(&format!("-- {ordinary}")));
        assert!(parts.trailing_ddl.contains(&format!("q'[a' {ordinary}]'")));
        assert_eq!(parts.supporting_constraints.len(), 1);
        let wrong = "CREATE TABLE APP.T(ID NUMBER); CREATE INDEX APP.I ON APP.OTHER(ID);";
        assert!(split_oracle_table_ddl(wrong, "APP", "T", &[]).is_err());
    }

    #[test]
    fn iot_retains_its_primary_index_but_can_separate_a_secondary_unique_constraint() {
        let source = "CREATE TABLE APP.T(ID NUMBER, VALUE NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID), CONSTRAINT UQ_T UNIQUE(VALUE)) ORGANIZATION INDEX;";
        let unique = OracleSupportingIndexDdl {
            constraint_name: "UQ_T".into(),
            owner: "APP".into(),
            name: "IX_UQ".into(),
            ddl: "CREATE UNIQUE INDEX APP.IX_UQ ON APP.T(VALUE);".into(),
        };
        let parts = split_oracle_table_ddl(source, "APP", "T", &[unique]).unwrap();
        assert!(parts.table_ddl.contains("CONSTRAINT PK_T PRIMARY KEY(ID)"));
        assert!(parts.table_ddl.ends_with("ORGANIZATION INDEX;"));
        assert!(!parts.table_ddl.contains("UQ_T"));
        assert_eq!(parts.indexes, ["CREATE UNIQUE INDEX APP.IX_UQ ON APP.T(VALUE);"]);
        assert!(parts.supporting_constraints[0].contains("UQ_T UNIQUE(VALUE) USING INDEX \"APP\".\"IX_UQ\""));
        assert!(split_oracle_table_ddl(source, "APP", "T", &[index()]).is_err());
    }
    #[test]
    fn does_not_guess_missing_or_mismatched_definitions() {
        let source = "CREATE TABLE \"APP\".\"T\" (ID NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID))";
        let mut wrong = index();
        wrong.name = "OTHER".into();
        assert!(separate_oracle_supporting_indexes(source, "APP", "T", &[wrong]).is_err());
        assert_eq!(separate_oracle_supporting_indexes(source, "APP", "T", &[]).unwrap(), source);
    }

    #[test]
    fn nested_index_options_do_not_become_constraint_state() {
        let source = "CREATE TABLE \"APP\".\"T\" (ID NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID) DEFERRABLE INITIALLY DEFERRED USING INDEX (CREATE INDEX \"APP\".\"IX_T\" ON \"APP\".\"T\"(CASE WHEN ID = 1 THEN q'[DISABLE ENABLE RELY]' ELSE 'x' END) PARAMETERS ('ENABLE')) RELY ENABLE NOVALIDATE);";
        let result = separate_oracle_supporting_indexes(source, "APP", "T", &[index()]).unwrap();
        assert!(result.contains(
            "PRIMARY KEY(ID) DEFERRABLE INITIALLY DEFERRED  USING INDEX \"APP\".\"IX_T\" RELY ENABLE NOVALIDATE"
        ));
        assert!(!result.contains("PARAMETERS"));
        assert_eq!(result.matches("CREATE INDEX").count(), 1);
    }

    #[test]
    fn moves_an_existing_identical_index_before_the_constraint_without_duplicates() {
        let index = index();
        let source =
            format!("CREATE TABLE \"APP\".\"T\" (ID NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID));\n{};", index.ddl);
        let result = separate_oracle_supporting_indexes(&source, "APP", "T", std::slice::from_ref(&index)).unwrap();
        assert_eq!(result.matches("CREATE INDEX").count(), 1);
        assert!(result.find("CREATE INDEX").unwrap() < result.find("ALTER TABLE").unwrap());
        let mut conflicting = index;
        conflicting.ddl.push_str(" INVISIBLE");
        assert!(separate_oracle_supporting_indexes(&source, "APP", "T", &[conflicting]).is_err());
    }
}
