//! Selected Xugu schema objects. No Oracle-family routing or cross-engine DDL conversion.
//! Read all definitions and dependencies before the first write. Never replay uncertain DDL.

use super::*;
use sqlparser::{
    dialect::GenericDialect,
    tokenizer::{Token, Tokenizer},
};

pub(crate) fn supported_kinds() -> Vec<TransferObjectKind> {
    use TransferObjectKind::*;
    vec![Table, View, Procedure, Function, Trigger, Sequence, Package, Synonym]
}

fn source_kind(kind: TransferObjectKind) -> Result<db::ObjectSourceKind, String> {
    use db::ObjectSourceKind as S;
    Ok(match kind {
        TransferObjectKind::View => S::View,
        TransferObjectKind::Procedure => S::Procedure,
        TransferObjectKind::Function => S::Function,
        TransferObjectKind::Trigger => S::Trigger,
        TransferObjectKind::Sequence => S::Sequence,
        TransferObjectKind::Package => S::Package,
        TransferObjectKind::Synonym => S::Synonym,
        _ => return Err(format!("Unsupported Xugu schema object: {kind:?}")),
    })
}

fn keyword(kind: &db::ObjectSourceKind) -> &'static str {
    use db::ObjectSourceKind::*;
    match kind {
        View => "VIEW",
        Procedure => "PROCEDURE",
        Function => "FUNCTION",
        Trigger => "TRIGGER",
        Sequence => "SEQUENCE",
        Package => "PACKAGE",
        PackageBody => "PACKAGE BODY",
        Synonym => "SYNONYM",
        _ => "",
    }
}

fn word(token: &Token, expected: &str) -> bool {
    matches!(token, Token::Word(w) if w.quote_style.is_none() && w.value.eq_ignore_ascii_case(expected))
}

fn identifier_matches(token: &Token, expected: &str) -> bool {
    matches!(token, Token::Word(w) if if w.quote_style.is_some() { w.value == expected } else { w.value.to_uppercase() == expected })
}

/// Rewrite identifiers, not string literals/comments/dynamic SQL. Always qualify the
/// declaration, including catalog definitions whose object name was unqualified.
#[cfg(test)]
fn render_definition(
    source: &str,
    kind: &db::ObjectSourceKind,
    name: &str,
    source_schema: &str,
    target_schema: &str,
) -> Result<String, String> {
    render_definition_in_scope(source, kind, name, source_schema, target_schema, false)
}

fn render_definition_in_scope(
    source: &str,
    kind: &db::ObjectSourceKind,
    name: &str,
    source_schema: &str,
    target_schema: &str,
    schema_is_package: bool,
) -> Result<String, String> {
    let source = source.trim();
    let source = source.strip_suffix("\n/").unwrap_or(source).trim_end();
    let mut tokens = Tokenizer::new(&GenericDialect {}, source).tokenize().map_err(|e| e.to_string())?;
    let indices: Vec<usize> =
        tokens.iter().enumerate().filter_map(|(i, t)| (!matches!(t, Token::Whitespace(_))).then_some(i)).collect();
    let at = |p: usize| indices.get(p).and_then(|i| tokens.get(*i));
    let q = |s: &str| quote_identifier(s, &DatabaseType::Xugu);
    let qualified = format!("{}.{}", q(target_schema), q(name));
    if *kind == db::ObjectSourceKind::View && at(0).is_some_and(|t| word(t, "SELECT") || word(t, "WITH")) {
        let ddl = format!("CREATE VIEW {}.{} AS\n{source}", q(source_schema), q(name));
        return render_definition_in_scope(&ddl, kind, name, source_schema, target_schema, schema_is_package);
    }
    let mut p = 0;
    if at(p).is_some_and(|t| word(t, "CREATE")) {
        p += 1;
        if at(p).is_some_and(|t| word(t, "OR")) {
            if !at(p + 1).is_some_and(|t| word(t, "REPLACE")) {
                return Err("Invalid CREATE prefix".into());
            }
            p += 2;
        }
        if at(p).is_some_and(|t| word(t, "FORCE") || word(t, "NOFORCE")) {
            p += 1;
        }
    }
    for part in keyword(kind).split_whitespace() {
        if !at(p).is_some_and(|t| word(t, part)) {
            return Err(format!("Missing complete {} definition for {name}", keyword(kind)));
        }
        p += 1;
    }
    if at(p).is_some_and(|t| word(t, "IF")) {
        if !at(p + 1).is_some_and(|t| word(t, "NOT")) || !at(p + 2).is_some_and(|t| word(t, "EXISTS")) {
            return Err("Invalid IF NOT EXISTS prefix".into());
        }
        // Existence was checked separately. A concurrent create must fail,
        // never masquerade as this transfer successfully creating the object.
        p += 3;
    }
    let first = at(p).ok_or("Missing object declaration name")?;
    if at(p + 1) == Some(&Token::Period) {
        if !identifier_matches(first, source_schema) || !at(p + 2).is_some_and(|t| identifier_matches(t, name)) {
            return Err(format!("Source declaration does not match {source_schema}.{name}"));
        }
        p += 3;
    } else {
        if !identifier_matches(first, name) {
            return Err(format!("Source declaration does not match {name}"));
        }
        p += 1;
    }
    let body_start = *indices.get(p).ok_or("Incomplete object definition")?;
    let package_shadows_schema = schema_is_package
        || (matches!(kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody) && name == source_schema);
    // A qualifier can also be an alias or a PL/SQL variable. Fail closed when
    // the source schema name is declared/used as an unqualified identifier;
    // rewriting its later dotted references would silently change semantics.
    if source_schema != target_schema {
        for (position, index) in indices.iter().enumerate().filter(|(_, index)| **index >= body_start) {
            if identifier_matches(&tokens[*index], source_schema)
                && indices.get(position + 1).map(|i| &tokens[*i]) != Some(&Token::Period)
            {
                return Err(format!(
                    "Ambiguous schema/alias identifier {source_schema} in {name}; cross-schema transfer refused"
                ));
            }
        }
    }
    // Only the schema token preceding a period is rewritten. Quoted identifiers
    // retain exact-case semantics; unquoted identifiers follow Xugu case folding.
    for (position, index) in indices.iter().enumerate() {
        if *index >= body_start
            && indices.get(position + 1).map(|i| &tokens[*i]) == Some(&Token::Period)
            && position.checked_sub(1).map(|p| &tokens[indices[p]]) != Some(&Token::Period)
            && identifier_matches(&tokens[*index], source_schema)
        {
            // In a package named like its schema, SRC.F can mean a package
            // member rather than a schema-qualified standalone function. No
            // token-only rewrite can prove which meaning the compiler chose.
            let relation_position = position.checked_sub(1).is_some_and(|p| {
                ["FROM", "JOIN", "UPDATE", "INTO", "REFERENCES"].iter().any(|k| word(&tokens[indices[p]], k))
            });
            if source_schema != target_schema && package_shadows_schema && !relation_position {
                return Err(format!(
                    "Ambiguous package/schema qualifier {source_schema} in {name}; cross-schema transfer refused"
                ));
            }
            tokens[*index] = Token::Word(sqlparser::tokenizer::Word {
                value: target_schema.into(),
                quote_style: Some('"'),
                keyword: sqlparser::keywords::Keyword::NoKeyword,
            });
        }
    }
    let tail: String = tokens[body_start..].iter().map(ToString::to_string).collect();
    validate_single_definition(format!("CREATE {} {qualified} {tail}", keyword(kind)))
}

fn validate_single_definition(ddl: String) -> Result<String, String> {
    let statements = split_sql_statements_for_database(&ddl, DatabaseType::Xugu);
    if statements.len() != 1 {
        return Err("Xugu object source must contain exactly one complete definition".into());
    }
    Ok(statements.into_iter().next().unwrap())
}

#[derive(Debug)]
struct PlannedObject {
    kind: TransferObjectKind,
    name: String,
    definition: String,
    package_body: Option<String>,
    trigger_state_sql: Option<String>,
    exists: bool,
    dependencies: HashSet<String>,
}

#[derive(Debug, Default)]
pub(crate) struct Plan {
    objects: Vec<PlannedObject>,
}

fn metadata_bool(value: &serde_json::Value) -> Option<bool> {
    if let Some(value) = value.as_bool() {
        return Some(value);
    }
    if let Some(value) = value.as_i64() {
        return match value {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        };
    }
    match value.as_str()?.trim().to_ascii_lowercase().as_str() {
        "false" | "f" | "0" => Some(false),
        "true" | "t" | "1" => Some(true),
        _ => None,
    }
}

/// The dictionary is the same permission-scoped dependency source used by the
/// dependency inspector. Some servers omit dependency rows, so selected SQL
/// references are also collected below; unselected objects are never copied.
fn dependencies_sql(schema: &str) -> String {
    format!("SELECT o.OBJ_NAME, r.OBJ_NAME FROM ALL_DEPENDS d \
      JOIN ALL_OBJECTS o ON o.DB_ID=d.DB_ID AND o.SCHEMA_ID=d.OWNER_ID2 AND o.OBJ_ID=d.OBJ_ID2 AND o.OBJ_TYPE=d.OBJ_TYPE2 \
      JOIN ALL_OBJECTS r ON r.DB_ID=d.DB_ID AND r.SCHEMA_ID=d.OWNER_ID1 AND r.OBJ_ID=d.OBJ_ID1 AND r.OBJ_TYPE=d.OBJ_TYPE1 \
      JOIN ALL_SCHEMAS s ON s.DB_ID=o.DB_ID AND s.SCHEMA_ID=o.SCHEMA_ID \
      WHERE o.DB_ID=CURRENT_DB_ID AND s.SCHEMA_NAME={} AND r.SCHEMA_ID=o.SCHEMA_ID",quote_string_literal(schema))
}

struct CteBinding {
    name: Token,
    declaration: usize,
    visible: std::ops::Range<usize>,
}

fn closing_parenthesis(code: &[&Token], start: usize) -> Option<usize> {
    if code.get(start).copied() != Some(&Token::LParen) {
        return None;
    }
    let mut depth = 0;
    for (i, token) in code.iter().enumerate().skip(start) {
        match token {
            Token::LParen => depth += 1,
            Token::RParen => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// CTE names are query-local relations, not catalog objects. Preserve lexical
/// scope, sequential visibility and quoted case; an explicit schema qualifier
/// still denotes a real object even when a CTE has the same name.
fn cte_bindings(code: &[&Token]) -> Result<Vec<CteBinding>, String> {
    let mut bindings = Vec::new();
    for start in 0..code.len() {
        if !word(code[start], "WITH") {
            continue;
        }
        let mut p = start + 1;
        let recursive = code.get(p).is_some_and(|t| word(t, "RECURSIVE"));
        p += usize::from(recursive);
        let mut depth = 0;
        let end = (p..code.len())
            .find(|&i| match code[i] {
                Token::LParen => {
                    depth += 1;
                    false
                }
                Token::RParen if depth == 0 => true,
                Token::RParen => {
                    depth -= 1;
                    false
                }
                Token::SemiColon => depth == 0,
                _ => false,
            })
            .unwrap_or(code.len());
        let first_body = p;
        while p < end && matches!(code[p], Token::Word(_)) {
            let declaration = p;
            let name = code[p].clone();
            p += 1;
            if code.get(p).copied() == Some(&Token::LParen) {
                p = closing_parenthesis(code, p).ok_or("Incomplete CTE column list")? + 1;
            }
            if !code.get(p).is_some_and(|t| word(t, "AS")) {
                break; // WITH CHECK OPTION, WITH READ ONLY, etc.
            }
            p += 1;
            if code.get(p).is_some_and(|t| word(t, "NOT")) {
                p += 1;
            }
            if code.get(p).is_some_and(|t| word(t, "MATERIALIZED")) {
                p += 1;
            }
            let Some(close) = closing_parenthesis(code, p) else {
                return Err("Incomplete or unsupported CTE definition".into());
            };
            bindings.push(CteBinding {
                name,
                declaration,
                visible: (if recursive { first_body } else { close + 1 })..end,
            });
            p = close + 1;
            if code.get(p).copied() != Some(&Token::Comma) {
                break;
            }
            p += 1;
        }
    }
    Ok(bindings)
}

/// Supplement incomplete dependency dictionaries using identifier tokens in the
/// definitions we already read. This is ordering only, not SQL rewriting or an
/// automatic dependency-copy closure. Literals/comments and explicitly external
/// schemas cannot create local dependencies.
fn add_definition_dependencies(
    objects: &mut [PlannedObject],
    tables: &[String],
    source_schema: &str,
    target_schema: &str,
) -> Result<(), String> {
    let names: Vec<String> = objects.iter().map(|o| o.name.clone()).chain(tables.iter().cloned()).collect();
    for object in objects.iter_mut().filter(|o| !o.exists) {
        for ddl in std::iter::once(object.definition.as_str()).chain(object.package_body.as_deref()) {
            let tokens = Tokenizer::new(&GenericDialect {}, ddl).tokenize().map_err(|e| e.to_string())?;
            let code: Vec<&Token> = tokens.iter().filter(|t| !matches!(t, Token::Whitespace(_))).collect();
            let ctes = cte_bindings(&code)?;
            let local_routines: Vec<&Token> = code
                .windows(2)
                .filter(|pair| word(pair[0], "FUNCTION") || word(pair[0], "PROCEDURE"))
                .map(|pair| pair[1])
                .collect();
            for (i, token) in code.iter().enumerate() {
                let Some(name) = names.iter().find(|name| **name != object.name && identifier_matches(token, name))
                else {
                    continue;
                };
                let previous = i.checked_sub(1).and_then(|p| code.get(p)).copied();
                let next = code.get(i + 1).copied();
                let cte_name = ctes.iter().any(|cte| {
                    cte.declaration == i
                        || (cte.visible.contains(&i)
                            && identifier_matches(&cte.name, name)
                            && previous != Some(&Token::Period)
                            && next != Some(&Token::LParen)
                            && (next == Some(&Token::Period)
                                || previous.is_some_and(|t| word(t, "FROM") || word(t, "JOIN"))))
                });
                if cte_name {
                    continue;
                }
                let is_reference = if previous == Some(&Token::Period) {
                    i.checked_sub(2).and_then(|p| code.get(p)).is_some_and(|qualifier| {
                        identifier_matches(qualifier, source_schema) || identifier_matches(qualifier, target_schema)
                    })
                } else {
                    let is_local = local_routines.iter().any(|local| identifier_matches(local, name));
                    let is_declaration = previous.is_some_and(|t| {
                        ["FUNCTION", "PROCEDURE", "TRIGGER", "PACKAGE", "VIEW", "SEQUENCE", "SYNONYM"]
                            .iter()
                            .any(|k| word(t, k))
                    });
                    !is_local
                        && !is_declaration
                        && (matches!(next, Some(Token::LParen | Token::Period))
                            || previous.is_some_and(|t| {
                                ["FROM", "JOIN", "INTO", "UPDATE", "REFERENCES", "FOR", "CALL", "EXEC", "EXECUTE"]
                                    .iter()
                                    .any(|k| word(t, k))
                            }))
                };
                if is_reference {
                    object.dependencies.insert(name.clone());
                }
            }
        }
    }
    Ok(())
}

fn order_objects(mut objects: Vec<PlannedObject>) -> Result<Vec<PlannedObject>, String> {
    let mut ordered = Vec::with_capacity(objects.len());
    while !objects.is_empty() {
        let remaining: HashSet<String> = objects.iter().filter(|o| !o.exists).map(|o| o.name.clone()).collect();
        let next = objects.iter().position(|o| {
            o.exists
                || (o.dependencies.is_disjoint(&remaining)
                    && (o.kind != TransferObjectKind::Trigger
                        || objects.iter().all(|other| other.kind == TransferObjectKind::Trigger || other.exists)))
        });
        let Some(i) = next else {
            let phase_note = if objects.iter().any(|o| o.package_body.is_some()) {
                "; separate package specification/body compilation phases are not supported"
            } else {
                ""
            };
            return Err(format!(
                "Cyclic Xugu object dependencies: {}{phase_note}",
                objects.iter().map(|o| o.name.as_str()).collect::<Vec<_>>().join(", "),
            ));
        };
        ordered.push(objects.remove(i));
    }
    Ok(ordered)
}

pub(crate) async fn prepare(state: &AppState, request: &TransferRequest, source_pool: &str) -> Result<Plan, String> {
    if request.content == TransferContent::DataOnly {
        return Ok(Plan::default());
    }
    if request.source_schema.is_empty()
        || request.target_schema.is_empty()
        || request.source_schema.contains('\0')
        || request.target_schema.contains('\0')
    {
        return Err("Xugu schema-object transfer requires real source and target schemas".into());
    }
    let mut objects = Vec::new();
    let mut seen = HashSet::new();
    // The qualifier can occur outside the package too. Include unselected,
    // visible packages before treating the prefix as a schema name.
    let schema_is_package = if request.source_schema != request.target_schema {
        crate::schema::list_objects_core(
            state,
            &request.source_connection_id,
            &request.source_database,
            &request.source_schema,
            None,
            None,
            None,
            Some(&["PACKAGE".to_string()]),
            None,
        )
        .await?
        .iter()
        .any(|package| package.name == request.source_schema)
    } else {
        false
    };
    for selection in request.objects.as_deref().unwrap_or_default() {
        if selection.object_type == TransferObjectKind::Table {
            continue;
        }
        let kind = source_kind(selection.object_type)?;
        let kinds = [keyword(&kind).to_string()];
        let source_objects = crate::schema::list_objects_core(
            state,
            &request.source_connection_id,
            &request.source_database,
            &request.source_schema,
            None,
            None,
            None,
            Some(&kinds),
            None,
        )
        .await?;
        let target_objects = crate::schema::list_objects_core(
            state,
            &request.target_connection_id,
            &request.target_database,
            &request.target_schema,
            None,
            None,
            None,
            Some(&kinds),
            None,
        )
        .await?;
        for name in &selection.names {
            if !seen.insert(name.clone()) {
                return Err(format!("Duplicate or ambiguous Xugu object selection: {name}"));
            }
            if source_objects.iter().filter(|o| o.name == *name).count() != 1 {
                return Err(format!("Xugu source object not found, not visible or ambiguous: {name}"));
            }
            if selection.object_type == TransferObjectKind::Sequence {
                let sql = format!("SELECT q.IS_SYS FROM ALL_SEQUENCES q JOIN ALL_SCHEMAS s ON q.DB_ID=s.DB_ID AND q.SCHEMA_ID=s.SCHEMA_ID WHERE q.DB_ID=CURRENT_DB_ID AND s.SCHEMA_NAME={} AND q.SEQ_NAME={}",quote_string_literal(&request.source_schema),quote_string_literal(name));
                let result = execute_read_on_pool(state, source_pool, &sql).await?;
                let value = result.rows.first().and_then(|r| r.first()).ok_or("Sequence metadata is unavailable")?;
                if metadata_bool(value) != Some(false) {
                    return Err(format!("Identity/system sequence {name} must not be transferred independently"));
                }
            }
            let target_count = target_objects.iter().filter(|o| o.name == *name).count();
            if target_count > 1 {
                return Err(format!("Ambiguous Xugu target object: {name}"));
            }
            let exists = target_count == 1;
            let mut object = PlannedObject {
                kind: selection.object_type,
                name: name.clone(),
                definition: String::new(),
                package_body: None,
                trigger_state_sql: None,
                exists,
                dependencies: HashSet::new(),
            };
            if !exists {
                if source_objects.iter().any(|o| o.name == *name && o.valid == Some(false)) {
                    return Err(format!("Xugu source object is invalid: {name}; compile or repair it before transfer"));
                }
                if selection.object_type == TransferObjectKind::Trigger {
                    let sql = format!("SELECT t.ENABLE FROM ALL_TRIGGERS t JOIN ALL_SCHEMAS s ON t.DB_ID=s.DB_ID AND t.SCHEMA_ID=s.SCHEMA_ID WHERE t.DB_ID=CURRENT_DB_ID AND s.SCHEMA_NAME={} AND t.TRIG_NAME={}", quote_string_literal(&request.source_schema), quote_string_literal(name));
                    let result = execute_read_on_pool(state, source_pool, &sql).await?;
                    let enabled = result
                        .rows
                        .first()
                        .and_then(|r| r.first())
                        .and_then(metadata_bool)
                        .filter(|_| result.rows.len() == 1)
                        .ok_or_else(|| format!("Trigger state unavailable or ambiguous: {name}"))?;
                    object.trigger_state_sql = Some(format!(
                        "ALTER TRIGGER {}.{} {}",
                        quote_identifier(&request.target_schema, &DatabaseType::Xugu),
                        quote_identifier(name, &DatabaseType::Xugu),
                        if enabled { "ENABLE" } else { "DISABLE" }
                    ));
                }
                let source = crate::schema::get_object_source_core(
                    state,
                    &request.source_connection_id,
                    &request.source_database,
                    &request.source_schema,
                    name,
                    kind.clone(),
                    None,
                    None,
                )
                .await?;
                object.definition = render_definition_in_scope(
                    &source.source,
                    &kind,
                    name,
                    &request.source_schema,
                    &request.target_schema,
                    schema_is_package,
                )?;
                if selection.object_type == TransferObjectKind::Package {
                    let body = crate::schema::get_object_source_core(
                        state,
                        &request.source_connection_id,
                        &request.source_database,
                        &request.source_schema,
                        name,
                        db::ObjectSourceKind::PackageBody,
                        None,
                        None,
                    )
                    .await?;
                    if !body.source.trim().is_empty() {
                        object.package_body = Some(render_definition_in_scope(
                            &body.source,
                            &db::ObjectSourceKind::PackageBody,
                            name,
                            &request.source_schema,
                            &request.target_schema,
                            schema_is_package,
                        )?);
                    }
                }
            }
            objects.push(object);
        }
    }
    if objects.iter().all(|o| o.exists) {
        return Ok(Plan { objects });
    }
    let dependencies = execute_read_on_pool(state, source_pool, &dependencies_sql(&request.source_schema)).await?;
    for row in dependencies.rows {
        if let (Some(name), Some(dependency)) =
            (row.first().and_then(|v| v.as_str()), row.get(1).and_then(|v| v.as_str()))
        {
            if name != dependency {
                for object in objects.iter_mut().filter(|o| o.name == name) {
                    object.dependencies.insert(dependency.into());
                }
            }
        }
    }
    add_definition_dependencies(&mut objects, &request.tables, &request.source_schema, &request.target_schema)?;
    // Independent sequences are prerequisites for table defaults. Packages run
    // after tables because their specifications can declare table%ROWTYPE.
    objects.sort_by_key(|o| match o.kind {
        TransferObjectKind::Sequence => 0,
        TransferObjectKind::Package => 1,
        TransferObjectKind::Trigger => 3,
        _ => 2,
    });
    Ok(Plan { objects: order_objects(objects)? })
}

impl Plan {
    pub(crate) fn preview_before_tables(&self) -> String {
        self.objects
            .iter()
            .filter(|o| !o.exists && o.kind == TransferObjectKind::Sequence)
            .map(|o| format!("{};", o.definition.trim_end_matches(';')))
            .collect::<Vec<_>>()
            .join("\n\n")
    }
    pub(crate) fn preview_after_tables(&self) -> String {
        self.objects
            .iter()
            .filter(|o| o.kind != TransferObjectKind::Sequence || o.exists)
            .map(|o| {
                if o.exists {
                    return format!("-- Skip existing {:?}: {}", o.kind, o.name);
                }
                let sql = if o.kind == TransferObjectKind::Package {
                    return match &o.package_body {
                        Some(body) => {
                            format!("{};\n\n{};", o.definition.trim_end_matches(';'), body.trim_end_matches(';'))
                        }
                        None => format!("{};", o.definition.trim_end_matches(';')),
                    };
                } else {
                    &o.definition
                };
                if sql.is_empty() {
                    format!("-- Package {} has no body", o.name)
                } else {
                    let mut sql = format!("{};", sql.trim_end_matches(';'));
                    if let Some(state) = &o.trigger_state_sql {
                        sql.push_str(&format!("\n{state};"));
                    }
                    sql
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
    pub(crate) async fn before_tables(
        &self,
        state: &AppState,
        request: &TransferRequest,
        target_pool: &str,
    ) -> Result<(), String> {
        for object in &self.objects {
            if is_cancelled(&request.transfer_id).await {
                return Err("Cancelled".into());
            }
            if !object.exists && object.kind == TransferObjectKind::Sequence {
                execute_on_pool(state, target_pool, &object.definition)
                    .await
                    .map_err(|e| format!("Xugu prerequisite {:?} {} failed: {e}", object.kind, object.name))?;
            }
        }
        Ok(())
    }
    pub(crate) async fn after_tables<F: FnMut(TransferProgress)>(
        &self,
        state: &AppState,
        request: &TransferRequest,
        target_pool: &str,
        failed_tables: &[String],
        mut progress: F,
    ) -> Result<TransferObjectOutcome, String> {
        let mut outcome = TransferObjectOutcome::default();
        let mut failed: HashSet<String> = failed_tables.iter().cloned().collect();
        for object in &self.objects {
            if is_cancelled(&request.transfer_id).await {
                return Err("Cancelled".into());
            }
            let label = format!("{:?}:{}", object.kind, object.name);
            let result = if object.exists {
                outcome.skipped.push(label.clone());
                Ok(())
            } else if !object.dependencies.is_disjoint(&failed) {
                Err("A selected prerequisite failed; dependent object was not created".to_string())
            } else {
                let sql = match object.kind {
                    TransferObjectKind::Sequence => None,
                    _ => Some(object.definition.as_str()),
                };
                match sql {
                    Some(sql) => {
                        let result = execute_on_pool(state, target_pool, sql).await.map(|_| ());
                        if result.is_ok() {
                            if let Some(sql) = object.package_body.as_ref().or(object.trigger_state_sql.as_ref()) {
                                execute_on_pool(state, target_pool, sql).await.map(|_| ())
                            } else {
                                result
                            }
                        } else {
                            result
                        }
                    }
                    None => Ok(()),
                }
            };
            let result = if result.is_ok() && !object.exists {
                // Some database DDL can succeed while leaving a programmable
                // object invalid. Do not report such a transfer as successful.
                let kinds = [keyword(&source_kind(object.kind)?).to_string()];
                match crate::schema::list_objects_core(
                    state,
                    &request.target_connection_id,
                    &request.target_database,
                    &request.target_schema,
                    None,
                    None,
                    None,
                    Some(&kinds),
                    None,
                )
                .await
                {
                    Ok(objects) => {
                        let verified = verify_created_object(&objects, &object.name);
                        if verified.is_ok() && object.package_body.is_some() {
                            let sql = package_body_state_sql(&request.target_schema, &object.name);
                            match execute_read_on_pool(state, target_pool, &sql).await {
                                Ok(result) => verify_package_body_state(&result.rows, &object.name),
                                Err(error) => Err(format!("Unable to verify package body {}: {error}", object.name)),
                            }
                        } else {
                            verified
                        }
                    }
                    Err(error) => Err(format!("Unable to verify created object {}: {error}", object.name)),
                }
            } else {
                result
            };
            let error = result.err();
            if error.is_some() {
                failed.insert(object.name.clone());
                outcome.failed.push(label.clone());
            } else if !object.exists {
                outcome.transferred.push(label.clone());
            }
            progress(TransferProgress {
                oracle_package_approval: None,
                oracle_package_preflight: None,
                oracle_routine_operation: None,
                transfer_id: request.transfer_id.clone(),
                table: format!("schema object: {label}"),
                table_index: request.tables.len(),
                total_tables: request.tables.len(),
                rows_transferred: (outcome.transferred.len() + outcome.skipped.len()) as u64,
                total_rows: None,
                status: if error.is_some() { TransferStatus::Error } else { TransferStatus::Running },
                error,
                terminal: false,
            });
        }
        Ok(outcome)
    }
}

fn package_body_state_sql(schema: &str, name: &str) -> String {
    format!("SELECT p.ALL_OK FROM ALL_PACKAGES p JOIN ALL_SCHEMAS s ON s.DB_ID=p.DB_ID AND s.SCHEMA_ID=p.SCHEMA_ID WHERE p.DB_ID=CURRENT_DB_ID AND s.SCHEMA_NAME={} AND p.PACK_NAME={} AND p.BODY IS NOT NULL", quote_string_literal(schema), quote_string_literal(name))
}

fn verify_package_body_state(rows: &[Vec<serde_json::Value>], name: &str) -> Result<(), String> {
    if rows.len() == 1 && rows[0].first().and_then(metadata_bool) == Some(true) {
        Ok(())
    } else {
        Err(format!("Created Xugu package body is missing, invalid or its state is unavailable: {name}"))
    }
}

fn verify_created_object(objects: &[db::ObjectInfo], name: &str) -> Result<(), String> {
    let matching: Vec<_> = objects.iter().filter(|o| o.name == name).collect();
    match matching.as_slice() {
        [object] if object.valid != Some(false) => Ok(()),
        [_] => Err(format!("Created Xugu object is invalid: {name}")),
        _ => Err(format!("Created Xugu object not found or ambiguous: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_body_verification_uses_all_ok_and_refuses_unknown_state() {
        use serde_json::json;
        let sql = package_body_state_sql("Dst'Q", "Pkg");
        assert!(sql.contains("SELECT p.ALL_OK"));
        assert!(!sql.contains("VALID"));
        assert!(sql.contains("'Dst''Q'"));
        assert!(sql.contains("p.BODY IS NOT NULL"));
        assert!(verify_package_body_state(&[vec![json!(true)]], "Pkg").is_ok());
        for rows in
            [vec![], vec![vec![json!(false)]], vec![vec![json!(null)]], vec![vec![json!(true)], vec![json!(true)]]]
        {
            assert!(verify_package_body_state(&rows, "Pkg").is_err());
        }
    }

    fn planned(kind: TransferObjectKind, name: &str, dependencies: &[&str]) -> PlannedObject {
        PlannedObject {
            kind,
            name: name.into(),
            definition: format!("CREATE {kind:?} \"DST\".\"{name}\""),
            package_body: None,
            trigger_state_sql: None,
            exists: false,
            dependencies: dependencies.iter().map(|s| (*s).into()).collect(),
        }
    }

    #[test]
    fn orders_selected_dependencies_and_places_triggers_last() {
        use TransferObjectKind::*;
        let objects = order_objects(vec![
            planned(Trigger, "TR", &["P"]),
            planned(Procedure, "P", &["V2", "PKG"]),
            planned(View, "V2", &["V1"]),
            planned(Package, "PKG", &["F"]),
            planned(Function, "F", &[]),
            planned(View, "V1", &["UNSELECTED_TABLE"]),
        ])
        .unwrap();
        let names: Vec<_> = objects.iter().map(|o| o.name.as_str()).collect();
        let pos = |name| names.iter().position(|n| *n == name).unwrap();
        assert!(pos("F") < pos("PKG"));
        assert!(pos("PKG") < pos("P"));
        assert!(pos("V1") < pos("V2"));
        assert!(pos("V2") < pos("P"));
        assert_eq!(names.last(), Some(&"TR"));
    }

    #[test]
    fn missing_dictionary_rows_still_order_real_view_and_routine_references() {
        use TransferObjectKind::*;
        let mut objects = vec![
            planned(Package, "PKG_TEST", &[]),
            planned(Procedure, "P_ADD", &[]),
            planned(View, "V_CHAIN", &[]),
            planned(View, "V_ITEMS", &[]),
            planned(Function, "F_ADD", &[]),
        ];
        objects[0].package_body = Some("CREATE PACKAGE BODY DST.PKG_TEST AS FUNCTION GET_BASE RETURN INT AS BEGIN RETURN DST.F_ADD(40, 2); END; END;".into());
        objects[1].definition =
            "CREATE PROCEDURE DST.P_ADD AS BEGIN INSERT INTO DST.AUDIT_LOG VALUES (DST.F_ADD(1, 2)); END;".into();
        objects[2].definition = "CREATE VIEW DST.V_CHAIN AS SELECT * FROM DST.V_ITEMS".into();
        objects[3].definition = "CREATE VIEW DST.V_ITEMS AS SELECT * FROM DST.ITEMS".into();
        add_definition_dependencies(&mut objects, &["AUDIT_LOG".into(), "ITEMS".into()], "SRC", "DST").unwrap();
        assert!(objects[1].dependencies.contains("AUDIT_LOG"));
        assert!(objects[3].dependencies.contains("ITEMS"));
        let objects = order_objects(objects).unwrap();
        let pos = |name| objects.iter().position(|o| o.name == name).unwrap();
        assert!(pos("F_ADD") < pos("PKG_TEST"));
        assert!(pos("F_ADD") < pos("P_ADD"));
        assert!(pos("V_ITEMS") < pos("V_CHAIN"));
    }

    #[test]
    fn selected_reference_scan_ignores_literals_external_schemas_and_local_routines() {
        use TransferObjectKind::*;
        let mut objects = vec![planned(Package, "P", &[]), planned(Function, "F", &[]), planned(View, "V", &[])];
        objects[0].package_body = Some("CREATE PACKAGE BODY DST.P AS FUNCTION F RETURN INT AS BEGIN RETURN 1; END; PROCEDURE LOCAL_P AS BEGIN OTHER.F(); F(); -- DST.V\n DBMS_OUTPUT.PUT_LINE('DST.V'); END; END;".into());
        add_definition_dependencies(&mut objects, &[], "SRC", "DST").unwrap();
        assert!(objects[0].dependencies.is_empty());
        objects[0].package_body = Some("CREATE PACKAGE BODY DST.P AS PROCEDURE LOCAL_P AS BEGIN F(); END; END;".into());
        add_definition_dependencies(&mut objects, &[], "SRC", "DST").unwrap();
        assert!(objects[0].dependencies.contains("F"));
    }

    #[test]
    fn refuses_cycles_but_accepts_existing_dependencies() {
        use TransferObjectKind::*;
        assert!(order_objects(vec![planned(View, "A", &["B"]), planned(View, "B", &["A"])]).is_err());
        let mut existing = planned(View, "B", &["A"]);
        existing.exists = true;
        let ordered = order_objects(vec![planned(View, "A", &["B"]), existing]).unwrap();
        // B is already present on the destination, so A need not wait for its
        // skip record. Existing B's source dependencies are not replayed.
        assert_eq!(ordered.len(), 2);
        assert!(ordered.iter().any(|o| o.name == "B" && o.exists));
        assert!(ordered.iter().any(|o| o.name == "A" && !o.exists));
    }

    #[test]
    fn cte_names_do_not_create_false_catalog_dependencies_or_cycles() {
        use TransferObjectKind::*;
        for query in [
            "WITH V_B AS (SELECT 1 AS N) SELECT N FROM V_B",
            "WITH V_B(N) AS (SELECT 1) SELECT V_B.N FROM V_B",
            "WITH FIRST_CTE AS (SELECT 1 AS N), V_B AS (SELECT N FROM FIRST_CTE) SELECT N FROM V_B",
            "WITH RECURSIVE V_B(N) AS (SELECT 1 UNION ALL SELECT N + 1 FROM V_B WHERE N < 3) SELECT N FROM V_B",
            "SELECT N FROM (WITH V_B AS (SELECT 1 AS N) SELECT N FROM V_B) Q",
        ] {
            let mut objects = vec![planned(View, "V_A", &[]), planned(View, "V_B", &[])];
            objects[0].definition = format!("CREATE VIEW DST.V_A AS {query}");
            objects[1].definition = "CREATE VIEW DST.V_B AS SELECT N FROM DST.V_A".into();
            add_definition_dependencies(&mut objects, &[], "SRC", "DST").unwrap();
            assert!(objects[0].dependencies.is_empty(), "{query}");
            let ordered = order_objects(objects).unwrap();
            assert_eq!(ordered[0].name, "V_A");
            assert_eq!(ordered[1].name, "V_B");
        }
    }

    #[test]
    fn cte_scopes_preserve_real_qualified_outer_and_function_dependencies() {
        use TransferObjectKind::*;
        for query in [
            // A non-recursive CTE cannot shadow the relation in its own body.
            "WITH V_B AS (SELECT * FROM V_B) SELECT * FROM V_B",
            "WITH V_B AS (SELECT 1 AS N) SELECT * FROM DST.V_B",
            "SELECT * FROM (WITH V_B AS (SELECT 1 AS N) SELECT N FROM V_B) Q JOIN V_B ON 1=1",
            // Quoted CTE names retain exact case.
            "WITH \"v_b\" AS (SELECT 1 AS N) SELECT * FROM V_B",
            // Relation aliases do not shadow the function namespace.
            "WITH V_B AS (SELECT 1 AS N) SELECT V_B() FROM V_B",
            // CTE declarations in a later statement cannot affect earlier ones.
            "SELECT * FROM V_B; WITH V_B AS (SELECT 1 AS N) SELECT N FROM V_B",
        ] {
            let mut objects = vec![planned(View, "V_A", &[]), planned(View, "V_B", &[])];
            objects[0].definition = format!("CREATE VIEW DST.V_A AS {query}");
            add_definition_dependencies(&mut objects, &[], "SRC", "DST").unwrap();
            assert!(objects[0].dependencies.contains("V_B"), "{query}");
        }
    }

    #[test]
    fn ctes_in_programmable_objects_have_statement_local_scope() {
        use TransferObjectKind::*;
        let mut objects = vec![planned(Procedure, "P", &[]), planned(View, "V", &[])];
        objects[0].definition =
            "CREATE PROCEDURE DST.P AS BEGIN WITH V AS (SELECT 1 AS N) SELECT N FROM V; SELECT * FROM DST.V; END;"
                .into();
        add_definition_dependencies(&mut objects, &[], "SRC", "DST").unwrap();
        assert!(objects[0].dependencies.contains("V"));
        objects[0].dependencies.clear();
        objects[0].definition =
            "CREATE PROCEDURE DST.P AS BEGIN WITH V AS (SELECT 1 AS N) SELECT N FROM V; END;".into();
        add_definition_dependencies(&mut objects, &[], "SRC", "DST").unwrap();
        assert!(objects[0].dependencies.is_empty());
    }

    #[test]
    fn package_phase_cycles_are_explicitly_rejected_before_execution() {
        use TransferObjectKind::*;
        let mut package = planned(Package, "PKG", &[]);
        package.package_body = Some(
            "CREATE PACKAGE BODY DST.PKG AS FUNCTION F(N INT) RETURN INT AS BEGIN RETURN DST.G(N); END; END;".into(),
        );
        let mut function = planned(Function, "G", &[]);
        function.definition = "CREATE FUNCTION DST.G(N INT) RETURN INT AS BEGIN RETURN DST.PKG.BASE(N); END;".into();
        let mut objects = vec![package, function];
        add_definition_dependencies(&mut objects, &[], "SRC", "DST").unwrap();
        let error = order_objects(objects).unwrap_err();
        assert!(error.contains("Cyclic Xugu object dependencies"));
        assert!(error.contains("separate package specification/body compilation phases are not supported"));
    }

    #[test]
    fn same_named_package_and_schema_never_rewrite_ambiguous_member_calls() {
        for kind in [db::ObjectSourceKind::Package, db::ObjectSourceKind::PackageBody] {
            let source = format!(
                "CREATE {} SRC.SRC AS FUNCTION F RETURN INT AS BEGIN RETURN SRC.G(); END; END;",
                keyword(&kind)
            );
            let error = render_definition(&source, &kind, "SRC", "SRC", "DST").unwrap_err();
            assert!(error.contains("Ambiguous package/schema qualifier"));
            let unchanged = render_definition(&source, &kind, "SRC", "SRC", "SRC").unwrap();
            assert!(unchanged.contains("RETURN \"SRC\".G()"));
        }
        let literal = render_definition(
            "PACKAGE SRC.SRC AS V VARCHAR := 'SRC.G()'; END;",
            &db::ObjectSourceKind::Package,
            "SRC",
            "SRC",
            "DST",
        )
        .unwrap();
        assert!(literal.contains("'SRC.G()'"));
    }

    #[test]
    fn only_the_first_schema_qualifier_is_rewritten() {
        let ddl = render_definition(
            "SELECT OTHER.SRC.ID, SRC.T.ID FROM OTHER.SRC JOIN SRC.T ON 1=1",
            &db::ObjectSourceKind::View,
            "V",
            "SRC",
            "DST",
        );
        // An unqualified schema-name occurrence remains conservatively rejected.
        assert!(ddl.is_err());
        let ddl = render_definition("SELECT OTHER.SRC.ID FROM OTHER.T", &db::ObjectSourceKind::View, "V", "SRC", "DST")
            .unwrap();
        assert!(ddl.contains("OTHER.SRC.ID"));
        assert!(!ddl.contains("OTHER.\"DST\""));
    }

    #[test]
    fn unselected_same_named_packages_also_guard_view_and_routine_rewrites() {
        for (kind, source) in [
            (db::ObjectSourceKind::View, "SELECT SRC.G(1) AS N FROM DUAL"),
            (db::ObjectSourceKind::Function, "FUNCTION F RETURN INT AS BEGIN RETURN SRC.G(1); END;"),
        ] {
            assert!(render_definition_in_scope(source, &kind, "F", "SRC", "DST", true)
                .unwrap_err()
                .contains("Ambiguous package/schema qualifier"));
            let sql = render_definition_in_scope(source, &kind, "F", "SRC", "DST", false).unwrap();
            assert!(sql.contains("\"DST\".G(1)"));
        }
        let sql =
            render_definition_in_scope("SELECT N FROM SRC.V", &db::ObjectSourceKind::View, "F", "SRC", "DST", true)
                .unwrap();
        assert!(sql.contains("FROM \"DST\".V"));
    }

    #[test]
    fn preview_matches_sequence_package_trigger_phases_and_existing_skips() {
        use TransferObjectKind::*;
        let sequence = planned(Sequence, "SEQ", &[]);
        let mut existing = planned(Sequence, "EXISTING", &[]);
        existing.exists = true;
        let mut package = planned(Package, "PKG", &[]);
        package.package_body = Some("CREATE PACKAGE BODY \"DST\".\"PKG\" AS END;".into());
        let mut trigger = planned(Trigger, "TR", &[]);
        trigger.trigger_state_sql = Some("ALTER TRIGGER \"DST\".\"TR\" DISABLE".into());
        let plan = Plan { objects: vec![sequence, existing, package, trigger] };
        let before = plan.preview_before_tables();
        assert!(before.contains("\"SEQ\""));
        assert!(!before.contains("PKG"));
        let after = plan.preview_after_tables();
        assert!(after.contains("-- Skip existing Sequence: EXISTING"));
        assert!(after.contains("CREATE Package \"DST\".\"PKG\";"));
        assert!(after.contains("CREATE PACKAGE BODY"));
        assert!(after.ends_with("ALTER TRIGGER \"DST\".\"TR\" DISABLE;"));
        assert!(!after.contains("\"SEQ\""));
    }

    #[test]
    fn metadata_booleans_never_default_unknown_values_to_false() {
        use serde_json::json;
        for value in [json!(false), json!(0), json!("FALSE"), json!("f"), json!("0")] {
            assert_eq!(metadata_bool(&value), Some(false));
        }
        for value in [json!(true), json!(1), json!("TRUE"), json!("t"), json!("1")] {
            assert_eq!(metadata_bool(&value), Some(true));
        }
        for value in [json!(null), json!(2), json!("unknown"), json!({})] {
            assert_eq!(metadata_bool(&value), None);
        }
    }

    #[test]
    fn verifies_existence_and_validity_instead_of_trusting_create_success() {
        let object = |valid| {
            serde_json::from_value::<db::ObjectInfo>(serde_json::json!({
                "name": "V", "object_type": "VIEW", "valid": valid,
            }))
            .unwrap()
        };
        assert!(verify_created_object(&[object(Some(true))], "V").is_ok());
        assert!(verify_created_object(&[object(None)], "V").is_ok());
        assert!(verify_created_object(&[object(Some(false))], "V").is_err());
        assert!(verify_created_object(&[], "V").is_err());
        assert!(verify_created_object(&[object(Some(true)), object(Some(true))], "V").is_err());
    }

    #[test]
    fn rejects_schema_name_used_as_an_alias_or_variable_across_schemas() {
        assert!(render_definition("SELECT SRC.ID FROM OTHER.T SRC", &db::ObjectSourceKind::View, "V", "SRC", "DST")
            .is_err());
        assert!(render_definition(
            "PROCEDURE P AS SRC INTEGER; BEGIN SRC := 1; END;",
            &db::ObjectSourceKind::Procedure,
            "P",
            "SRC",
            "DST"
        )
        .is_err());
        assert!(
            render_definition("SELECT SRC.ID FROM OTHER.T SRC", &db::ObjectSourceKind::View, "V", "SRC", "SRC").is_ok()
        );
    }
    #[test]
    fn definition_qualifies_and_rewrites_identifiers_only() {
        let ddl = render_definition(
            "CREATE OR REPLACE PROCEDURE SRC.P AS BEGIN INSERT INTO SRC.T VALUES ('SRC.T'); -- SRC.T\nEND;",
            &db::ObjectSourceKind::Procedure,
            "P",
            "SRC",
            "Dst",
        )
        .unwrap();
        assert!(ddl.starts_with("CREATE PROCEDURE \"Dst\".\"P\""));
        assert!(ddl.contains("INSERT INTO \"Dst\".T"));
        assert!(ddl.contains("'SRC.T'"));
        assert!(ddl.contains("-- SRC.T"));
        assert!(!ddl.contains("OR REPLACE"));
    }
    #[test]
    fn refuses_wrong_objects_and_empty_sources() {
        for source in [
            "",
            "-- metadata unavailable",
            "CREATE VIEW OTHER.V AS SELECT 1",
            "CREATE VIEW SRC.WRONG AS SELECT 1",
            "CREATE PUBLIC SYNONYM S FOR SRC.T",
        ] {
            assert!(render_definition(source, &db::ObjectSourceKind::View, "V", "SRC", "DST").is_err(), "{source}");
        }
        assert!(render_definition("SELECT 1; DROP TABLE T;", &db::ObjectSourceKind::View, "V", "SRC", "DST").is_err());
    }
    #[test]
    fn preserves_quoted_case_and_package_body() {
        let ddl = render_definition(
            "PACKAGE BODY \"Src\".\"Pkg\" AS FUNCTION F RETURN INT AS BEGIN RETURN 1; END; END;\n/",
            &db::ObjectSourceKind::PackageBody,
            "Pkg",
            "Src",
            "Dst",
        )
        .unwrap();
        assert!(ddl.starts_with("CREATE PACKAGE BODY \"Dst\".\"Pkg\""));
        assert!(ddl.contains("RETURN 1; END; END"));
        assert!(render_definition("CREATE VIEW SRC.\"v\" AS SELECT 1", &db::ObjectSourceKind::View, "V", "SRC", "DST")
            .is_err());
    }
    #[test]
    fn wraps_bare_view_and_preserves_external_schema() {
        let ddl = render_definition(
            "SELECT 'SRC.X' FROM SRC.T JOIN OTHER.T U ON 1=1",
            &db::ObjectSourceKind::View,
            "V",
            "SRC",
            "DST",
        )
        .unwrap();
        // Bare view sources must pass through the same identifier rewrite.
        assert!(ddl.starts_with("CREATE VIEW \"DST\".\"V\" AS"));
        assert!(ddl.contains("FROM \"DST\".T"));
        assert!(ddl.contains("OTHER.T"));
    }
}
