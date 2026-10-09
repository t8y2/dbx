use super::{FunctionDiff, SchemaSyncSqlPlan};
use crate::models::connection::DatabaseType;
use regex::Regex;
use serde::{Deserialize, Serialize};
use dbx_sql_core::oracle_program_compatibility::{self as compatibility, OracleProgramContext};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineEndpoints {
    #[serde(default)]
    pub recovery: bool,
    pub source_connection_id: String,
    pub source_database: String,
    pub target_connection_id: String,
    pub target_database: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineStep {
    pub name: String,
    pub routine_type: String,
    pub operation: String,
    pub sql: Option<String>,
    pub blocked_reason: Option<String>,
    #[serde(default)]
    pub compatibility_warnings: Vec<String>,
    pub dependencies: Vec<String>,
    pub incoming_dependencies: Vec<crate::types::RoutineDependency>,
    pub post_sql: Vec<String>,
    pub trigger: Option<crate::types::RoutineTriggerInfo>,
    pub type_info: Option<crate::types::RoutineTypeInfo>,
    pub source_schema: Option<String>,
    pub target_schema: Option<String>,
}

pub fn is_oracle_routine_database(database: DatabaseType) -> bool {
    matches!(database, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
}

fn header(definition: &str) -> Option<(String, usize)> {
    let identifier = r#"(?:"(?:[^"]|"")*"|[A-Za-z][A-Za-z0-9_$#]*)"#;
    let pattern = format!(
        r"(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(PACKAGE\s+BODY|TYPE\s+BODY|PACKAGE|TYPE|TRIGGER|PROCEDURE|FUNCTION)\s+{identifier}(?:\s*\.\s*{identifier})?"
    );
    let captures = Regex::new(&pattern).ok()?.captures(definition)?;
    Some((captures[1].split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase(), captures.get(0)?.end()))
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn decode_identifier(value: &str) -> String {
    if value.starts_with('"') {
        value[1..value.len() - 1].replace("\"\"", "\"")
    } else {
        value.to_ascii_uppercase()
    }
}

fn trigger_declaration_identity(definition: &str) -> Option<(Option<String>, String)> {
    let identifier = r#"(?:"(?:[^"]|"")*"|[A-Za-z][A-Za-z0-9_$#]*)"#;
    let pattern = Regex::new(&format!(r"(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?TRIGGER\s+({identifier})(?:\s*\.\s*({identifier}))?" )).ok()?;
    let captures = pattern.captures(definition)?;
    Some(match captures.get(2) {
        Some(value) => (Some(decode_identifier(&captures[1])), decode_identifier(value.as_str())),
        None => (None, decode_identifier(&captures[1])),
    })
}

fn trigger_program_source(definition: &str, name: &str, owner: Option<&str>) -> Result<String, String> {
    let statements = crate::sql::split_sql_statements_for_database(definition, DatabaseType::Oracle);
    let first = statements.first().ok_or("The complete trigger declaration is missing")?;
    if statements.len() > 2 {
        return Err("Additional trigger source statements require explicit review".into());
    }
    if let Some(state) = statements.get(1) {
        let identifier = r#"(?:"(?:[^"]|"")*"|[A-Za-z][A-Za-z0-9_$#]*)"#;
        let pattern = Regex::new(&format!(
            r"(?is)^\s*ALTER\s+TRIGGER\s+({identifier})(?:\s*\.\s*({identifier}))?\s+(?:ENABLE|DISABLE)\s*;?\s*$"
        ))
        .unwrap();
        let captures = pattern
            .captures(state)
            .ok_or("Only an ENABLE/DISABLE statement for the same trigger may follow its declaration")?;
        let (actual_owner, actual_name) = match captures.get(2) {
            Some(value) => (Some(decode_identifier(&captures[1])), decode_identifier(value.as_str())),
            None => (None, decode_identifier(&captures[1])),
        };
        if actual_name != name || actual_owner.as_deref().is_some_and(|actual| Some(actual) != owner) {
            return Err("Trailing ALTER TRIGGER targets a different object".into());
        }
    }
    Ok(first.clone())
}

fn edition_clause(definition: &str) -> &str {
    let prefix = Regex::new(r"(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(NONEDITIONABLE|EDITIONABLE)\b").unwrap();
    match prefix.captures(definition).and_then(|captures| captures.get(1)) {
        Some(value) if value.as_str().eq_ignore_ascii_case("NONEDITIONABLE") => "NONEDITIONABLE ",
        Some(_) => "EDITIONABLE ",
        None => "",
    }
}

fn definition_without_client_delimiter(definition: &str) -> &str {
    let definition = definition.trim();
    match definition.rsplit_once('\n') {
        Some((body, tail)) if tail.trim() == "/" => body.trim_end(),
        _ => definition,
    }
}

/// Only the object declaration's owner/name and optional client slash are ignored.
/// Strings, comments, quoted identifiers and all body whitespace remain byte-for-byte.
pub fn comparable_oracle_routine(definition: &str) -> String {
    let trigger_source = trigger_declaration_identity(definition)
        .and_then(|(owner, name)| trigger_program_source(definition, &name, owner.as_deref()).ok());
    let definition = trigger_source.as_deref().unwrap_or(definition);
    let definition = definition_without_client_delimiter(definition);
    match header(definition) {
        Some((kind, end)) => format!("{}{kind}{}", edition_clause(definition), &definition[end..]),
        None => definition.to_string(),
    }
}

pub fn oracle_routine_sql(definition: &str, name: &str, schema: &str, kind: &str) -> Result<String, String> {
    let definition = definition_without_client_delimiter(definition);
    let (parsed_kind, end) = header(definition).ok_or("The complete CREATE routine declaration could not be read")?;
    if parsed_kind != kind {
        return Err("Routine metadata and source declaration disagree".to_string());
    }
    if !definition.ends_with(';') {
        return Err("The complete routine must end with its PL/SQL terminator".to_string());
    }
    Ok(format!(
        "CREATE OR REPLACE {}{kind} {}.{}{}",
        edition_clause(definition),
        quote(schema),
        quote(name),
        &definition[end..]
    ))
}

/// Cross-engine automatic conversion is deliberately limited to a portable PL/SQL
/// subset. Other definitions remain visible and require a target-specific migration.
fn portable_cross_engine_body(definition: &str) -> bool {
    if !edition_clause(definition).is_empty() {
        return false;
    }
    let Some((kind, end)) = header(definition) else { return false };
    let body = definition_without_client_delimiter(&definition[end..]);
    let identifier = r#"(?:"(?:[^"]|"")*"|[A-Za-z][A-Za-z0-9_$#]*)"#;
    let procedure = r"(?:\(\s*\))?\s*(?:AS|IS)\s+BEGIN\s+NULL\s*;\s*END\s*;";
    let function = r"(?:\(\s*\))?\s*RETURN\s+(?:NUMBER|INTEGER)\s+(?:AS|IS)\s+BEGIN\s+RETURN\s+[+-]?[0-9]+(?:\.[0-9]+)?\s*;\s*END\s*;";
    let tail = match kind.as_str() {
        "PROCEDURE" => procedure.to_string(),
        "FUNCTION" => function.to_string(),
        "PACKAGE" => format!(r"(?:AS|IS)\s+(?:(?:PROCEDURE\s+{identifier}\s*(?:\(\s*\))?\s*;|FUNCTION\s+{identifier}\s*(?:\(\s*\))?\s*RETURN\s+(?:NUMBER|INTEGER)\s*;)\s*)+END(?:\s+{identifier})?\s*;"),
        "PACKAGE BODY" => format!(r"(?:AS|IS)\s+(?:(?:PROCEDURE\s+{identifier}\s*{procedure}|FUNCTION\s+{identifier}\s*{function})\s*)+END(?:\s+{identifier})?\s*;"),
        "TRIGGER" => format!(r"(?:BEFORE|AFTER)\s+(?:INSERT|UPDATE|DELETE)(?:\s+OR\s+(?:INSERT|UPDATE|DELETE))*\s+ON\s+{identifier}(?:\s*\.\s*{identifier})?\s*(?:FOR\s+EACH\s+ROW\s*)?BEGIN\s+NULL\s*;\s*END\s*;"),
        _ => return false,
    };
    Regex::new(&format!(r"(?is)^\s*{tail}\s*$")).is_ok_and(|pattern| pattern.is_match(body))
}

fn mapped_dependency(
    dependency: &crate::types::RoutineDependency,
    owner: Option<&str>,
    target: &str,
) -> crate::types::RoutineDependency {
    let mut mapped = dependency.clone();
    if owner == Some(dependency.owner.as_str()) {
        mapped.owner = target.to_string();
    }
    mapped
}
fn step_identity(step: &RoutineStep) -> (String, String, String) {
    (step.target_schema.clone().unwrap_or_default(), step.name.clone(), step.routine_type.clone())
}
fn typed_dependencies(diff: &FunctionDiff, target: &str) -> Vec<(String, String, String)> {
    let info = if diff.diff_type == "removed" { diff.target.as_ref() } else { diff.source.as_ref() };
    let Some(info) = info else { return Vec::new() };
    let mut dependencies: Vec<_> = info
        .dependency_objects
        .iter()
        .map(|dependency| {
            let mapped = mapped_dependency(dependency, info.schema.as_deref(), target);
            (mapped.owner, mapped.name, mapped.object_type)
        })
        .collect();
    if matches!(info.function_type.as_str(), "PACKAGE BODY" | "TYPE BODY") {
        dependencies.push((target.to_string(), info.name.clone(), info.function_type.trim_end_matches(" BODY").into()));
    }
    dependencies
}

fn complete_type_metadata(info: &crate::types::FunctionInfo) -> Result<(), String> {
    use dbx_types::oracle_types::OracleMetadataReadState;
    let metadata = info.type_info.as_ref().ok_or("Complete type metadata is required")?;
    if [&metadata.pairing_state, &metadata.dependency_state, &metadata.incoming_state].iter().any(|state| !matches!(state, OracleMetadataReadState::Available | OracleMetadataReadState::Empty)) {
        return Err(metadata.metadata_message.clone().unwrap_or_else(|| "Type pair or dependency metadata is unknown, unavailable or unsupported".into()));
    }
    if info.paired_object_present.is_none() {
        return Err("Type pair presence is unknown".into());
    }
    Ok(())
}

fn type_has_table_references(info: &crate::types::FunctionInfo) -> bool {
    info.type_info.as_ref().is_some_and(|metadata| !metadata.referenced_columns.is_empty())
        || info.incoming_dependencies.iter().any(|dependency| matches!(dependency.object_type.as_str(), "TABLE" | "MATERIALIZED VIEW"))
}

pub fn oracle_routine_steps(
    diffs: &[FunctionDiff],
    target: DatabaseType,
    target_schema: Option<&str>,
    source: Option<DatabaseType>,
) -> Vec<RoutineStep> {
    oracle_routine_steps_with_context(diffs, target, target_schema, source, None)
}

pub fn oracle_routine_steps_with_context(
    diffs: &[FunctionDiff],
    target: DatabaseType,
    target_schema: Option<&str>,
    source: Option<DatabaseType>,
    context: Option<&OracleProgramContext>,
) -> Vec<RoutineStep> {
    if !is_oracle_routine_database(target) {
        return Vec::new();
    }
    let target_owner = target_schema.unwrap_or_default();
    let mut steps: Vec<_> = diffs.iter().map(|diff| {
        let info = if diff.diff_type == "removed" { diff.target.as_ref() } else { diff.source.as_ref() };
        let kind = info.map(|info| info.function_type.to_ascii_uppercase()).unwrap_or_default();
        let result = (|| {
            let schema = target_schema.filter(|schema| !schema.is_empty()).ok_or("An explicit target schema is required")?;
            if !matches!(kind.as_str(), "PROCEDURE" | "FUNCTION" | "PACKAGE" | "PACKAGE BODY" | "TRIGGER" | "TYPE" | "TYPE BODY") { return Err("This routine type is not supported".to_string()); }
            let info = info.ok_or("The complete routine source is missing")?;
            if info.name != diff.name { return Err("Routine identity does not match its metadata".into()); }
            let source = source.ok_or("The source database type must be explicit")?;
            if !is_oracle_routine_database(source) { return Err("This source language cannot be converted to Oracle PL/SQL automatically".into()); }
            let mut definition = info.definition.clone();
            if source != target && diff.diff_type != "removed" {
                let context = context.ok_or("Live source/target version and edition metadata are required for cross-engine comparison")?;
                definition = compatibility::conversion_source(&definition, &kind, &info.name, source, target, context)?;
                if matches!(kind.as_str(), "TYPE" | "TYPE BODY") {
                    compatibility::compatible_type_source(&definition, &kind, &info.dependency_objects)?;
                } else if !portable_cross_engine_body(&definition) {
                    return Err("This program definition is outside the confirmed cross-engine subset; target-specific verification is required".into());
                }
            }
            if matches!(kind.as_str(), "TYPE" | "TYPE BODY") {
                if kind == "TYPE BODY" {
                    if let Some((_, reason)) = context.and_then(|context| context.blocked_bodies.iter().find(|(name, _)| name == &info.name)) { return Err(reason.clone()); }
                }
                if kind == "TYPE" {
                    if let Some((_, reason)) = context.and_then(|context| context.blocked_types.iter().find(|(name, _)| name == &info.name)) { return Err(reason.clone()); }
                }
                complete_type_metadata(info)?;
                if let Some(target) = &diff.target { complete_type_metadata(target)?; }
                if kind == "TYPE" && context.is_none() && diff.target.as_ref().is_some_and(type_has_table_references) {
                    return Err("The target type is referenced by stored table data; replacement or deletion requires a separate data-preserving migration".into());
                }
                if kind == "TYPE" && context.is_none() && diff.diff_type == "modified" && diff.target.as_ref().is_some_and(|target| target.incoming_dependencies.iter().any(|dependency| dependency.object_type == "TYPE")) {
                    return Err("Dependent target types require a coordinated type evolution plan before replacement".into());
                }
            }
            if diffs.iter().any(|other| other.name == diff.name && other.diff_type != diff.diff_type && other.source.as_ref().or(other.target.as_ref()).is_some_and(|candidate| candidate.function_type == kind) && matches!(other.diff_type.as_str(), "added" | "removed") && matches!(diff.diff_type.as_str(), "added" | "removed")) { return Err("Conflicting routine identities share a target name; review the trigger table mapping".into()); }
            if diff.diff_type == "removed" {
                if info.schema.as_deref() != Some(schema) { return Err("Removed routine owner does not match the selected target schema".into()); }
                if matches!(kind.as_str(), "PACKAGE" | "PACKAGE BODY" | "TYPE" | "TYPE BODY") {
                    let paired = match kind.as_str() { "PACKAGE" => "PACKAGE BODY", "PACKAGE BODY" => "PACKAGE", "TYPE" => "TYPE BODY", _ => "TYPE" };
                    match info.paired_object_present {
                        None => return Err("Specification/body pair presence is unknown; deletion is blocked".into()),
                        Some(true) if !diffs.iter().any(|other| other.diff_type == "removed" && other.name == diff.name && other.target.as_ref().is_some_and(|other| other.function_type == paired && other.schema == info.schema)) => return Err("Specification and body must be selected together for deletion".into()),
                        _ => {}
                    }
                }
                if info.incoming_dependencies.iter().any(|dependency| !diffs.iter().any(|other| other.diff_type == "removed" && other.target.as_ref().is_some_and(|candidate| candidate.schema.as_deref() == Some(dependency.owner.as_str()) && candidate.name == dependency.name && candidate.function_type == dependency.object_type))) { return Err("Unselected dependent objects would be invalidated by this deletion".into()); }
                return Ok(format!("DROP {kind} {}.{};", quote(schema), quote(&diff.name)));
            }
            if !matches!(diff.diff_type.as_str(), "added" | "modified") { return Err("Unknown routine operation".into()); }
            if matches!(kind.as_str(), "TYPE" | "TYPE BODY") {
                for dependency in info.dependency_objects.iter().filter(|dependency| dependency.object_type == "TYPE") {
                    let mapped = mapped_dependency(dependency, info.schema.as_deref(), schema);
                    let selected = diffs.iter().any(|other| other.diff_type != "removed" && other.source.as_ref().is_some_and(|candidate| candidate.schema == info.schema && candidate.name == dependency.name && candidate.function_type == "TYPE" && dependency.owner == info.schema.clone().unwrap_or_default()));
                    let existing = diff.target.as_ref().is_some_and(|target| target.status.as_deref() == Some("VALID") && target.dependency_objects.contains(&mapped));
                    let confirmed = context.is_some_and(|context| context.target_dependencies.contains(&(mapped.owner.clone(), mapped.name.clone(), mapped.object_type.clone())));
                    if !selected && !existing && !confirmed {
                        return Err(format!("Target type dependency {}.{} is not confirmed; include its definition or verify the existing target dependency", mapped.owner, mapped.name));
                    }
                }
            }
            if info.status.as_deref() != Some("VALID") { return Err("The source routine is not confirmed VALID".into()); }
            let mut program = if kind == "TRIGGER" { trigger_program_source(&definition, &info.name, info.schema.as_deref())? } else { definition };
            if matches!(kind.as_str(), "PACKAGE BODY" | "TYPE BODY") && info.paired_object_present != Some(true) { return Err("A complete specification is required before its body".into()); }
            if matches!(kind.as_str(), "PACKAGE BODY" | "TYPE BODY") && diff.diff_type == "added" && !diffs.iter().any(|other| other.name == diff.name && other.source.as_ref().is_some_and(|candidate| candidate.function_type == kind.trim_end_matches(" BODY") && candidate.schema == info.schema)) && !context.is_some_and(|context| context.target_dependencies.contains(&(schema.to_string(), info.name.clone(), kind.trim_end_matches(" BODY").to_string()))) {
                return Err("The target specification is not confirmed by this plan; include its specification".into());
            }
            if kind == "TRIGGER" && source != target {
                    let trigger = info.trigger.as_ref().ok_or("Complete trigger metadata is required")?;
                    let mapped_owner = if Some(trigger.table_owner.as_str()) == info.schema.as_deref() { schema } else { &trigger.table_owner };
                    if !context.is_some_and(|context| context.target_dependencies.contains(&(mapped_owner.to_string(), trigger.table_name.clone(), trigger.base_object_type.clone()))) {
                        return Err("The cross-engine trigger target table/view is not confirmed VALID".into());
                    }
            }
            if let Some(owner) = info.schema.as_deref().filter(|owner| *owner != schema) {
                if kind == "TRIGGER" && source != target {
                    let trigger = info.trigger.as_ref().ok_or("Complete trigger metadata is required")?;
                    if trigger.table_owner == owner { program = compatibility::map_reference(&program, owner, &trigger.table_name, schema)?; }
                }
                if matches!(kind.as_str(), "TYPE" | "TYPE BODY") {
                    for dependency in &info.dependency_objects {
                        let mapped = mapped_dependency(dependency, info.schema.as_deref(), schema);
                        let confirmed = context.is_some_and(|context| context.target_dependencies.contains(&(mapped.owner.clone(), mapped.name.clone(), mapped.object_type.clone())));
                        let existing = diff.target.as_ref().is_some_and(|target| target.status.as_deref() == Some("VALID") && target.dependency_objects.contains(&mapped));
                        if dependency.owner == owner && (confirmed || existing || diffs.iter().any(|other| other.diff_type != "removed" && other.source.as_ref().is_some_and(|candidate| candidate.schema == info.schema && candidate.name == dependency.name && candidate.function_type == dependency.object_type))) {
                            program = compatibility::map_reference(&program, owner, &dependency.name, schema)?;
                        }
                    }
                    if kind == "TYPE BODY" { program = compatibility::map_reference(&program, owner, &info.name, schema)?; }
                }
                let (_, header_end) = header(&program).ok_or("The routine declaration is incomplete")?;
                if compatibility::source_tokens(&program[header_end..]).windows(2).any(|pair| compatibility::identifier_word(&pair[0].2) == owner && pair[1].2 == ".") { return Err("The body contains an explicit source-schema reference; review its target mapping before applying".into()); }
            }
            if kind == "TRIGGER" {
                let trigger = info.trigger.as_ref().ok_or("Complete trigger metadata is required")?;
                if !matches!(trigger.status.as_str(), "ENABLED" | "DISABLED") { return Err("Unknown trigger enabled state".into()); }
                if !matches!(trigger.base_object_type.as_str(), "TABLE" | "VIEW") || trigger.table_owner.is_empty() || trigger.table_name.is_empty() { return Err("Schema/database triggers require a separate target compatibility review".into()); }
            }
            oracle_routine_sql(&program, &diff.name, schema, &kind)
        })();
        let (sql, blocked_reason) = match result { Ok(sql) => (Some(sql), None), Err(reason) => (None, Some(reason)) };
        let dependencies = info.map(|info| info.dependencies.iter().map(|dependency| match (info.schema.as_deref(), target_schema) {
            (Some(owner), Some(target_owner)) if dependency.starts_with(&format!("{}.", quote(owner))) => format!("{}{}", quote(target_owner), &dependency[quote(owner).len()..]), _ => dependency.clone()
        }).collect()).unwrap_or_default();
        let trigger = info.and_then(|info| info.trigger.clone().map(|mut trigger| { if Some(trigger.table_owner.as_str()) == info.schema.as_deref() { trigger.table_owner = target_owner.to_string(); } trigger }));
        let post_sql = if sql.is_some() && diff.diff_type != "removed" { trigger.as_ref().map(|trigger| vec![format!("ALTER TRIGGER {}.{} {};", quote(target_owner), quote(&diff.name), if trigger.status == "DISABLED" { "DISABLE" } else { "ENABLE" })]).unwrap_or_default() } else { Vec::new() };
        // Target callers matter on replacement, even if no source caller references the new object.
        let mut incoming_dependencies = info.map(|info| info.incoming_dependencies.iter().map(|dependency| mapped_dependency(dependency, info.schema.as_deref(), target_owner)).collect::<Vec<_>>()).unwrap_or_default();
        if let Some(target_info) = &diff.target { for dependency in &target_info.incoming_dependencies { if !incoming_dependencies.contains(dependency) { incoming_dependencies.push(dependency.clone()); } } }
        let type_info = info.and_then(|info| info.type_info.clone().map(|mut metadata| {
            for column in &mut metadata.referenced_columns { if Some(column.owner.as_str()) == info.schema.as_deref() { column.owner = target_owner.to_string(); } }
            if let Some(target) = diff.target.as_ref().and_then(|target| target.type_info.as_ref()) { for column in &target.referenced_columns { if !metadata.referenced_columns.contains(column) { metadata.referenced_columns.push(column.clone()); } } }
            metadata
        }));
        let compatibility_warnings = if sql.is_some() && source != Some(target) && info.is_some_and(|info| !edition_clause(&info.definition).is_empty()) {
            vec!["The verified non-editioned definition is converted without its edition clause; future edition capability is not preserved".into()]
        } else { Vec::new() };
        RoutineStep { name: diff.name.clone(), routine_type: kind, operation: diff.diff_type.clone(), sql, blocked_reason, compatibility_warnings, dependencies, incoming_dependencies, post_sql, trigger, type_info, source_schema: info.and_then(|info| info.schema.clone()), target_schema: target_schema.map(str::to_string) }
    }).collect();
    let dependencies: Vec<_> = diffs.iter().map(|diff| typed_dependencies(diff, target_owner)).collect();
    // Keep dependency identities typed: a package body may depend on its same-name spec without a self cycle.
    let mut pending: Vec<usize> = (0..steps.len()).collect();
    pending.sort_by_key(|index| steps[*index].operation != "removed");
    let mut ordered = Vec::with_capacity(steps.len());
    while !pending.is_empty() {
        let next = pending.iter().position(|index| {
            !pending.iter().any(|other| {
                if index == other {
                    return false;
                }
                let step = &steps[*index];
                let other_step = &steps[*other];
                if step.operation == "removed" {
                    other_step.operation == "removed" && dependencies[*other].contains(&step_identity(step))
                } else if other_step.operation == "removed" {
                    false
                } else if dependencies[*index].is_empty() {
                    step.dependencies.contains(&format!("{}.{}", quote(target_owner), quote(&other_step.name)))
                } else {
                    dependencies[*index].contains(&step_identity(other_step))
                }
            })
        });
        if let Some(position) = next {
            ordered.push(pending.remove(position));
        } else {
            for index in pending.drain(..) {
                steps[index].sql = None;
                steps[index].post_sql.clear();
                steps[index].blocked_reason =
                    Some("Routine dependency cycle requires an explicit compilation plan".into());
                ordered.push(index);
            }
        }
    }
    // Propagate blocked prerequisite states; never offer a body whose selected spec cannot execute.
    loop {
        let mut changed = false;
        for index in 0..steps.len() {
            if steps[index].blocked_reason.is_none()
                && dependencies[index].iter().any(|dependency| {
                    steps.iter().any(|step| step_identity(step) == *dependency && step.blocked_reason.is_some())
                })
            {
                steps[index].sql = None;
                steps[index].post_sql.clear();
                steps[index].blocked_reason = Some("A selected dependency is blocked".into());
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    ordered.into_iter().map(|index| steps[index].clone()).collect()
}
pub fn add_oracle_routines_to_plan(
    plan: &mut SchemaSyncSqlPlan,
    diffs: &[FunctionDiff],
    target: DatabaseType,
    schema: Option<&str>,
    source: Option<DatabaseType>,
    source_schema: Option<&str>,
) {
    add_oracle_routines_to_plan_with_context(plan, diffs, target, schema, source, source_schema, None);
}

pub fn add_oracle_routines_to_plan_with_context(
    plan: &mut SchemaSyncSqlPlan,
    diffs: &[FunctionDiff],
    target: DatabaseType,
    schema: Option<&str>,
    source: Option<DatabaseType>,
    source_schema: Option<&str>,
    context: Option<&OracleProgramContext>,
) {
    plan.routine_steps = oracle_routine_steps_with_context(diffs, target, schema, source, context);
    for step in &mut plan.routine_steps {
        if step.operation == "removed" {
            continue;
        }
        let actual_schema = diffs
            .iter()
            .find(|diff| {
                diff.name == step.name
                    && diff
                        .source
                        .as_ref()
                        .is_some_and(|info| info.function_type.eq_ignore_ascii_case(&step.routine_type))
            })
            .and_then(|diff| diff.source.as_ref())
            .and_then(|info| info.schema.as_deref());
        if source_schema.is_none() || actual_schema != source_schema {
            step.sql = None;
            step.post_sql.clear();
            step.blocked_reason = Some("Routine source owner does not match the selected source schema".to_string());
        }
    }
    for step in &plan.routine_steps {
        if let Some(sql) = &step.sql {
            plan.sync_sql.push_str("\n\n");
            plan.sync_sql.push_str(sql);
            if step.operation != "removed" {
                plan.sync_sql.push_str("\n/");
            }
            for sql in &step.post_sql {
                plan.sync_sql.push('\n');
                plan.sync_sql.push_str(sql);
            }
        }
    }
    if let Some(rollback) = &mut plan.rollback_sync_sql {
        let reverse: Vec<_> = diffs
            .iter()
            .map(|diff| FunctionDiff {
                diff_type: match diff.diff_type.as_str() {
                    "added" => "removed",
                    "removed" => "added",
                    _ => "modified",
                }
                .to_string(),
                name: diff.name.clone(),
                source: diff.target.clone(),
                target: diff.source.clone().map(|mut info| {
                    if let Some(schema) = schema {
                        info.dependency_objects = info
                            .dependency_objects
                            .iter()
                            .map(|dependency| mapped_dependency(dependency, info.schema.as_deref(), schema))
                            .collect();
                        info.incoming_dependencies = info
                            .incoming_dependencies
                            .iter()
                            .map(|dependency| mapped_dependency(dependency, info.schema.as_deref(), schema))
                            .collect();
                        if let Some(trigger) = &mut info.trigger {
                            if Some(trigger.table_owner.as_str()) == info.schema.as_deref() {
                                trigger.table_owner = schema.to_string();
                            }
                        }
                        if let Some(metadata) = &mut info.type_info {
                            for column in &mut metadata.referenced_columns {
                                if Some(column.owner.as_str()) == info.schema.as_deref() {
                                    column.owner = schema.to_string();
                                }
                            }
                        }
                        info.schema = Some(schema.to_string());
                    }
                    info
                }),
                changes: Vec::new(),
            })
            .collect();
        for step in oracle_routine_steps(&reverse, target, schema, Some(target)) {
            if let Some(sql) = step.sql {
                rollback.push_str("\n\n");
                rollback.push_str(&sql);
                if step.operation != "removed" {
                    rollback.push_str("\n/");
                }
                for sql in &step.post_sql {
                    rollback.push('\n');
                    rollback.push_str(sql);
                }
            } else if let Some(reason) = step.blocked_reason {
                plan.rollback_completeness = super::RollbackCompleteness::Incomplete;
                plan.missing_rollback_objects.push(super::MissingRollbackObject {
                    kind: step.routine_type,
                    name: step.name,
                    table: None,
                    reason,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrites_only_the_declaration_and_preserves_literal_and_comment_spacing() {
        let source = "CREATE OR REPLACE PROCEDURE \"Old Owner\".\"Mixed Name\" AS BEGIN x := q'[old  owner]'; -- keep  spaces\nNULL; END;\n/";
        let sql = oracle_routine_sql(source, "Mixed Name", "New Owner", "PROCEDURE").unwrap();
        assert!(sql.starts_with("CREATE OR REPLACE PROCEDURE \"New Owner\".\"Mixed Name\" AS"));
        assert!(sql.contains("q'[old  owner]'; -- keep  spaces"));
        assert_eq!(comparable_oracle_routine(source), comparable_oracle_routine(&sql));
        assert_ne!(
            comparable_oracle_routine(source),
            comparable_oracle_routine(&source.replace("old  owner", "old owner"))
        );
    }
    #[test]
    fn cross_engine_subset_does_not_accept_arbitrary_body_or_dynamic_sql() {
        assert!(portable_cross_engine_body("CREATE PROCEDURE p IS BEGIN NULL; END;"));
        assert!(portable_cross_engine_body("CREATE FUNCTION f RETURN NUMBER IS BEGIN RETURN 12; END;"));
        assert!(!portable_cross_engine_body("CREATE PROCEDURE p IS BEGIN EXECUTE IMMEDIATE 'DROP TABLE t'; END;"));
    }

    fn routine(name: &str, definition: &str) -> crate::types::FunctionInfo {
        crate::types::FunctionInfo {
            type_info: None, trigger: None,
            dependency_objects: Vec::new(),
            incoming_dependencies: Vec::new(),
            paired_object_present: None,
            name: name.to_string(),
            function_type: "PROCEDURE".into(),
            data_type: String::new(),
            definition: definition.to_string(),
            arguments: String::new(),
            schema: Some("SOURCE".into()),
            status: Some("VALID".into()),
            dependencies: Vec::new(),
        }
    }

    #[test]
    fn compares_owner_mapping_without_erasing_body_semantics_and_detects_all_operations() {
        let unchanged = routine("same", "CREATE PROCEDURE SOURCE.same IS BEGIN NULL; END;");
        let mut mapped = unchanged.clone();
        mapped.schema = Some("TARGET".into());
        mapped.definition = mapped.definition.replace("SOURCE.same", "TARGET.same");
        assert!(super::super::diff_functions(&[unchanged.clone()], &[mapped]).is_empty());
        let changed = routine("same", "CREATE PROCEDURE SOURCE.same IS BEGIN x := 'a  b'; END;");
        let diffs = super::super::diff_functions(&[changed], &[unchanged.clone()]);
        assert_eq!(diffs[0].diff_type, "modified");
        assert_eq!(super::super::diff_functions(&[unchanged.clone()], &[])[0].diff_type, "added");
        assert_eq!(super::super::diff_functions(&[], &[unchanged])[0].diff_type, "removed");
    }

    #[test]
    fn dependency_order_and_invalid_sources_are_explicit() {
        let parent = routine("parent", "CREATE PROCEDURE parent IS BEGIN NULL; END;");
        let mut child = routine("child", "CREATE PROCEDURE child IS BEGIN parent; END;");
        child.dependencies = vec!["\"SOURCE\".\"parent\"".into()];
        let diffs = super::super::diff_functions(&[child, parent], &[]);
        let steps = oracle_routine_steps(&diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
        assert_eq!(steps.iter().map(|step| step.name.as_str()).collect::<Vec<_>>(), vec!["parent", "child"]);
        assert_eq!(steps[1].dependencies, vec!["\"TARGET\".\"parent\""]);
        let mut invalid = routine("bad", "CREATE PROCEDURE bad IS BEGIN NULL; END;");
        invalid.status = Some("INVALID".into());
        let steps = oracle_routine_steps(
            &super::super::diff_functions(&[invalid], &[]),
            DatabaseType::Oracle,
            Some("TARGET"),
            Some(DatabaseType::Oracle),
        );
        assert!(steps[0].sql.is_none());
        assert!(steps[0].blocked_reason.as_deref().unwrap().contains("VALID"));
    }

    fn package(name: &str, body: bool) -> crate::types::FunctionInfo {
        let mut info =
            routine(name, &format!("CREATE {} {name} AS END;", if body { "PACKAGE BODY" } else { "PACKAGE" }));
        info.function_type = if body { "PACKAGE BODY" } else { "PACKAGE" }.into();
        info.paired_object_present = Some(true);
        info
    }
    fn trigger_info(name: &str, table: &str, status: &str) -> crate::types::FunctionInfo {
        let mut info = routine(
            name,
            &format!("CREATE TRIGGER {name} BEFORE INSERT ON {table} FOR EACH ROW BEGIN :NEW.x := 'a  b'; END;"),
        );
        info.function_type = "TRIGGER".into();
        info.trigger = Some(crate::types::RoutineTriggerInfo {
            table_owner: "SOURCE".into(),
            table_name: table.into(),
            timing: "BEFORE EACH ROW".into(),
            event: "INSERT".into(),
            status: status.into(),
            base_object_type: "TABLE".into(),
        });
        info
    }
    #[test]
    fn package_spec_and_same_name_body_have_distinct_identity_and_order() {
        let diffs = super::super::diff_functions(&[package("p", true), package("p", false)], &[]);
        assert_eq!(diffs.len(), 2);
        let steps = oracle_routine_steps(&diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
        assert_eq!(
            steps.iter().map(|step| step.routine_type.as_str()).collect::<Vec<_>>(),
            vec!["PACKAGE", "PACKAGE BODY"]
        );
        assert!(steps.iter().all(|step| step.sql.is_some()));
    }
    #[test]
    fn missing_package_half_never_becomes_an_independent_drop() {
        let source = package("p", false);
        let mut target_body = package("p", true);
        target_body.schema = Some("TARGET".into());
        let diffs = super::super::diff_functions(&[source], &[target_body]);
        let steps = oracle_routine_steps(&diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
        assert!(steps.iter().find(|step| step.routine_type == "PACKAGE BODY").unwrap().sql.is_none());
        let mut unknown = package("p", false);
        unknown.schema = Some("TARGET".into());
        unknown.paired_object_present = None;
        assert!(oracle_routine_steps(
            &super::super::diff_functions(&[], &[unknown]),
            DatabaseType::Oracle,
            Some("TARGET"),
            Some(DatabaseType::Oracle)
        )[0]
        .sql
        .is_none());
    }
    #[test]
    fn package_deletion_orders_body_before_spec_and_blocks_unselected_callers() {
        let mut spec = package("p", false);
        spec.schema = Some("TARGET".into());
        let mut body = package("p", true);
        body.schema = Some("TARGET".into());
        let steps = oracle_routine_steps(
            &super::super::diff_functions(&[], &[spec.clone(), body.clone()]),
            DatabaseType::Oracle,
            Some("TARGET"),
            Some(DatabaseType::Oracle),
        );
        assert_eq!(steps[0].routine_type, "PACKAGE BODY");
        assert_eq!(steps[1].routine_type, "PACKAGE");
        spec.incoming_dependencies.push(crate::types::RoutineDependency {
            owner: "TARGET".into(),
            name: "caller".into(),
            object_type: "PROCEDURE".into(),
        });
        let steps = oracle_routine_steps(
            &super::super::diff_functions(&[], &[spec, body]),
            DatabaseType::Oracle,
            Some("TARGET"),
            Some(DatabaseType::Oracle),
        );
        assert!(steps.iter().all(|step| step.sql.is_none()));
    }
    #[test]
    fn trigger_state_is_separate_from_body_and_same_name_tables_do_not_merge() {
        let enabled = trigger_info("tr", "t", "ENABLED");
        let disabled = trigger_info("tr", "t", "DISABLED");
        let diffs = super::super::diff_functions(&[disabled], &[enabled.clone()]);
        assert_eq!(diffs[0].diff_type, "modified");
        let steps = oracle_routine_steps(&diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
        assert!(steps[0].sql.as_ref().unwrap().contains("'a  b'"));
        assert_eq!(steps[0].post_sql, vec!["ALTER TRIGGER \"TARGET\".\"tr\" DISABLE;"]);
        let diffs = super::super::diff_functions(&[trigger_info("tr", "other", "ENABLED")], &[enabled]);
        assert_eq!(diffs.len(), 2);
        assert!(oracle_routine_steps(&diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle))
            .iter()
            .all(|step| step.sql.is_none()));
    }
    #[test]
    fn package_cross_engine_and_typed_cycles_are_blocked_without_losing_source() {
        let a = package("p", false);
        let cross = oracle_routine_steps(
            &super::super::diff_functions(&[a.clone()], &[]),
            DatabaseType::OceanbaseOracle,
            Some("TARGET"),
            Some(DatabaseType::Oracle),
        );
        assert!(cross[0].sql.is_none());
        let mut a = a;
        let mut b = package("q", false);
        a.dependency_objects.push(crate::types::RoutineDependency {
            owner: "SOURCE".into(),
            name: "q".into(),
            object_type: "PACKAGE".into(),
        });
        b.dependency_objects.push(crate::types::RoutineDependency {
            owner: "SOURCE".into(),
            name: "p".into(),
            object_type: "PACKAGE".into(),
        });
        let diffs = super::super::diff_functions(&[a, b], &[]);
        assert!(oracle_routine_steps(&diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle))
            .iter()
            .all(|step| step.sql.is_none()));
        assert!(diffs[0].source.as_ref().unwrap().definition.starts_with("CREATE PACKAGE"));
    }
    #[test]
    fn compound_trigger_keeps_complete_body_and_rejects_unrelated_trailing_sql() {
        let mut info = trigger_info("TR", "T", "DISABLED");
        let body = "CREATE TRIGGER TR FOR INSERT ON T COMPOUND TRIGGER\nBEFORE STATEMENT IS BEGIN NULL; END BEFORE STATEMENT;\nAFTER EACH ROW IS BEGIN NULL; END AFTER EACH ROW;\nEND TR;";
        info.definition = format!("{body}\n/\nALTER TRIGGER SOURCE.TR DISABLE;");
        let diffs = super::super::diff_functions(&[info.clone()], &[]);
        let steps = oracle_routine_steps(&diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
        assert!(steps[0].sql.as_ref().unwrap().ends_with("END TR;"));
        assert!(steps[0].sql.as_ref().unwrap().contains("END BEFORE STATEMENT;"));
        assert_eq!(steps[0].post_sql, vec!["ALTER TRIGGER \"TARGET\".\"TR\" DISABLE;"]);
        for tail in ["ALTER TRIGGER SOURCE.OTHER DISABLE;", "DROP TABLE T;"] {
            info.definition = format!("{body}\n/\n{tail}");
            let diffs = super::super::diff_functions(&[info.clone()], &[]);
            let steps = oracle_routine_steps(&diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
            assert!(steps[0].sql.is_none());
            assert!(steps[0].post_sql.is_empty());
            assert_eq!(diffs[0].source.as_ref().unwrap().definition, info.definition);
        }
    }

    fn user_type(name: &str, body: bool) -> crate::types::FunctionInfo {
        use dbx_types::oracle_types::OracleMetadataReadState;
        let mut info = routine(name, &format!("CREATE TYPE{} {name} {}", if body { " BODY" } else { "" }, if body { "AS MEMBER FUNCTION value RETURN NUMBER IS BEGIN RETURN 1; END; END;" } else { "AS OBJECT (\"First\" NUMBER, \"Second\" VARCHAR2(20)) NOT FINAL;" }));
        info.function_type = if body { "TYPE BODY" } else { "TYPE" }.into();
        info.paired_object_present = Some(body);
        info.type_info = Some(crate::types::RoutineTypeInfo {
            pairing_state: if body { OracleMetadataReadState::Available } else { OracleMetadataReadState::Empty },
            dependency_state: OracleMetadataReadState::Empty,
            incoming_state: OracleMetadataReadState::Empty,
            referenced_columns: Vec::new(), metadata_message: None,
        });
        info
    }

    #[test]
    fn type_identity_and_comparison_preserve_attribute_order_inheritance_and_quotes() {
        let original = user_type("T", false);
        let mut target = original.clone();
        target.schema = Some("TARGET".into());
        target.definition = target.definition.replace("TYPE T", "TYPE \"TARGET\".\"T\"");
        assert!(super::super::diff_functions(&[original.clone()], &[target.clone()]).is_empty());
        for definition in [
            original.definition.replace("\"First\" NUMBER, \"Second\" VARCHAR2(20)", "\"Second\" VARCHAR2(20), \"First\" NUMBER"),
            original.definition.replace("NOT FINAL", "FINAL"),
            original.definition.replace("\"First\"", "\"first\""),
        ] {
            let mut changed = original.clone(); changed.definition = definition;
            assert_eq!(super::super::diff_functions(&[changed], &[target.clone()])[0].diff_type, "modified");
        }
        let diffs = super::super::diff_functions(&[original, user_type("T", true)], &[]);
        assert_eq!(diffs.len(), 2);
        assert_ne!(diffs[0].source.as_ref().unwrap().function_type, diffs[1].source.as_ref().unwrap().function_type);
    }

    #[test]
    fn type_dependencies_and_body_are_ordered_and_missing_target_types_are_blocked() {
        let mut child = user_type("C", false);
        child.definition = "CREATE TYPE C AS TABLE OF P;".into();
        child.dependency_objects.push(crate::types::RoutineDependency { owner: "SOURCE".into(), name: "P".into(), object_type: "TYPE".into() });
        let mut parent = user_type("P", false);
        parent.paired_object_present = Some(true);
        let steps = oracle_routine_steps(&super::super::diff_functions(&[child.clone(), user_type("P", true), parent.clone()], &[]), DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
        assert!(steps.iter().all(|step| step.sql.is_some()));
        let spec = steps.iter().position(|step| step.name == "P" && step.routine_type == "TYPE").unwrap();
        assert!(spec < steps.iter().position(|step| step.name == "C").unwrap());
        assert!(spec < steps.iter().position(|step| step.routine_type == "TYPE BODY").unwrap());
        let steps = oracle_routine_steps(&super::super::diff_functions(&[child], &[]), DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
        assert!(steps[0].blocked_reason.as_ref().unwrap().contains("dependency"));
        parent.schema = Some("TARGET".into());
        let mut body = user_type("P", true); body.schema = Some("TARGET".into());
        let steps = oracle_routine_steps(&super::super::diff_functions(&[], &[parent, body]), DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
        assert_eq!(steps[0].routine_type, "TYPE BODY");
        assert!(steps.iter().all(|step| step.sql.as_ref().is_some_and(|sql| !sql.contains("FORCE") && !sql.contains("CASCADE"))));
    }

    #[test]
    fn unavailable_type_metadata_table_data_and_cross_engine_types_are_blocked() {
        use dbx_types::oracle_types::OracleMetadataReadState;
        let source = user_type("T", false);
        for state in [OracleMetadataReadState::Unknown, OracleMetadataReadState::Denied, OracleMetadataReadState::Unsupported, OracleMetadataReadState::Error] {
            let mut unavailable = source.clone(); unavailable.type_info.as_mut().unwrap().dependency_state = state;
            let steps = oracle_routine_steps(&super::super::diff_functions(&[unavailable], &[]), DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
            assert!(steps[0].sql.is_none());
        }
        let mut target = source.clone(); target.schema = Some("TARGET".into());
        target.type_info.as_mut().unwrap().referenced_columns.push(crate::types::RoutineColumnDependency { owner: "OTHER".into(), table_name: "Data Table".into(), column_name: "Value".into() });
        let mut changed = source.clone(); changed.definition = changed.definition.replace("NOT FINAL", "FINAL");
        for diffs in [super::super::diff_functions(&[changed], &[target.clone()]), super::super::diff_functions(&[], &[target])] {
            let steps = oracle_routine_steps(&diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
            assert!(steps[0].sql.is_none());
            assert_eq!(steps[0].type_info.as_ref().unwrap().referenced_columns[0].owner, "OTHER");
        }
        let steps = oracle_routine_steps(&super::super::diff_functions(&[source], &[]), DatabaseType::OceanbaseOracle, Some("TARGET"), Some(DatabaseType::Oracle));
        assert!(steps[0].sql.is_none());
    }

    #[test]
    fn type_recovery_preserves_target_schema_and_reports_unsafe_reverse_deletion() {
        let source = user_type("T", false);
        let diffs = super::super::diff_functions(&[source.clone()], &[]);
        let mut plan = SchemaSyncSqlPlan { routine_steps: Vec::new(), sync_sql: String::new(), rollback_sync_sql: Some(String::new()), rollback_completeness: super::super::RollbackCompleteness::Complete, missing_rollback_objects: Vec::new() };
        add_oracle_routines_to_plan(&mut plan, &diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle), Some("SOURCE"));
        assert!(plan.rollback_sync_sql.as_ref().unwrap().contains("DROP TYPE \"TARGET\".\"T\";"));
        assert_eq!(plan.rollback_completeness, super::super::RollbackCompleteness::Complete);
        let mut referenced = source;
        referenced.type_info.as_mut().unwrap().referenced_columns.push(crate::types::RoutineColumnDependency { owner: "SOURCE".into(), table_name: "Data".into(), column_name: "Value".into() });
        let diffs = super::super::diff_functions(&[referenced], &[]);
        let mut plan = SchemaSyncSqlPlan { routine_steps: Vec::new(), sync_sql: String::new(), rollback_sync_sql: Some(String::new()), rollback_completeness: super::super::RollbackCompleteness::Complete, missing_rollback_objects: Vec::new() };
        add_oracle_routines_to_plan(&mut plan, &diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle), Some("SOURCE"));
        assert_eq!(plan.rollback_completeness, super::super::RollbackCompleteness::Incomplete);
        assert_eq!(plan.missing_rollback_objects[0].kind, "TYPE");
        assert!(!plan.rollback_sync_sql.as_ref().unwrap().contains("FORCE"));
    }

    fn conversion_context(objects: &[crate::types::FunctionInfo], source: DatabaseType, target: DatabaseType) -> OracleProgramContext {
        OracleProgramContext {
            source_version: if source == DatabaseType::Oracle { "Oracle Database 19c Enterprise Edition" } else { "4.2.5.6" }.into(),
            target_version: if target == DatabaseType::Oracle { "Oracle Database 21c Enterprise Edition" } else { "4.2.5.6" }.into(),
            target_editions_disabled: true,
            non_editioned_source_objects: objects.iter().map(|info| (info.name.clone(), info.function_type.clone())).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn cross_engine_type_spec_body_and_collection_generate_mapped_ordered_plans_in_both_directions() {
        let mut parent = user_type("P", false);
        parent.definition = "CREATE TYPE P AS OBJECT (n NUMBER, MEMBER FUNCTION f RETURN NUMBER);".into();
        parent.paired_object_present = Some(true);
        let mut body = user_type("P", true);
        body.definition = "CREATE TYPE BODY P AS MEMBER FUNCTION f RETURN NUMBER IS v SOURCE.P; msg VARCHAR2(80) := nq'{O'Reilly SOURCE.P}'; BEGIN -- SOURCE.P\nRETURN 1; END; END;".into();
        body.dependency_objects.push(crate::types::RoutineDependency { owner: "SOURCE".into(), name: "P".into(), object_type: "TYPE".into() });
        let mut child = user_type("C", false);
        child.definition = "CREATE TYPE C AS TABLE OF SOURCE.P;".into();
        child.dependency_objects = body.dependency_objects.clone();
        let objects = vec![body, child, parent];
        for (source, target) in [(DatabaseType::Oracle, DatabaseType::OceanbaseOracle), (DatabaseType::OceanbaseOracle, DatabaseType::Oracle)] {
            let context = conversion_context(&objects, source, target);
            let diffs = super::super::diff_functions(&objects, &[]);
            let steps = oracle_routine_steps_with_context(&diffs, target, Some("Mixed Target"), Some(source), Some(&context));
            assert!(steps.iter().all(|step| step.blocked_reason.is_none()), "{steps:?}");
            assert_eq!(steps[0].routine_type, "TYPE");
            assert_eq!(steps[0].name, "P");
            assert!(steps.iter().find(|step| step.name == "C").unwrap().sql.as_ref().unwrap().contains("OF \"Mixed Target\".P"));
            let sql = steps.iter().find(|step| step.routine_type == "TYPE BODY").unwrap().sql.as_ref().unwrap();
            assert!(sql.contains("v \"Mixed Target\".P;"));
            assert!(sql.contains("nq'{O'Reilly SOURCE.P}'"));
            assert!(sql.contains("-- SOURCE.P\n"));
            let mut plan = SchemaSyncSqlPlan { routine_steps: Vec::new(), sync_sql: String::new(), rollback_sync_sql: Some(String::new()), rollback_completeness: super::super::RollbackCompleteness::Complete, missing_rollback_objects: Vec::new() };
            add_oracle_routines_to_plan_with_context(&mut plan, &diffs, target, Some("Mixed Target"), Some(source), Some("SOURCE"), Some(&context));
            let rollback = plan.rollback_sync_sql.unwrap();
            assert!(rollback.find("DROP TYPE BODY").unwrap() < rollback.find("DROP TYPE \"Mixed Target\".\"P\"").unwrap());
            assert!(!rollback.contains("FORCE") && !rollback.contains("CASCADE"));
        }
    }

    #[test]
    fn cross_engine_quoted_type_and_verified_edition_conversion_keep_loss_visible() {
        let mut info = user_type("Mixed.Type", false);
        info.definition = "CREATE OR REPLACE EDITIONABLE TYPE \"Mixed.Type\" AS VARRAY(8) OF NUMBER;".into();
        let objects = vec![info];
        let mut context = conversion_context(&objects, DatabaseType::Oracle, DatabaseType::OceanbaseOracle);
        let diffs = super::super::diff_functions(&objects, &[]);
        let steps = oracle_routine_steps_with_context(&diffs, DatabaseType::OceanbaseOracle, Some("Target.Owner"), Some(DatabaseType::Oracle), Some(&context));
        assert!(steps[0].sql.as_ref().unwrap().starts_with("CREATE OR REPLACE TYPE \"Target.Owner\".\"Mixed.Type\""));
        assert_eq!(steps[0].compatibility_warnings.len(), 1);
        context.non_editioned_source_objects.clear();
        let steps = oracle_routine_steps_with_context(&diffs, DatabaseType::OceanbaseOracle, Some("Target.Owner"), Some(DatabaseType::Oracle), Some(&context));
        assert!(steps[0].blocked_reason.as_ref().unwrap().contains("edition"));
    }

    #[test]
    fn cross_engine_unknown_versions_semantics_permissions_and_global_data_references_stay_blocked() {
        let mut info = user_type("T", false);
        info.definition = "CREATE TYPE T AS OBJECT (n NUMBER);".into();
        let diffs = super::super::diff_functions(&[info.clone()], &[]);
        let valid = conversion_context(&[info.clone()], DatabaseType::Oracle, DatabaseType::OceanbaseOracle);
        for banner in ["", "4.3.0", "5.7.25-OceanBase-v4.2.5.0"] {
            let mut context = valid.clone(); context.target_version = banner.into();
            let steps = oracle_routine_steps_with_context(&diffs, DatabaseType::OceanbaseOracle, Some("TARGET"), Some(DatabaseType::Oracle), Some(&context));
            assert!(steps[0].blocked_reason.as_ref().unwrap().contains("version"));
        }
        let mut context = valid.clone(); context.blocked_types.push(("T".into(), "OTHER.Data references target TYPE".into()));
        assert!(oracle_routine_steps_with_context(&diffs, DatabaseType::OceanbaseOracle, Some("TARGET"), Some(DatabaseType::Oracle), Some(&context))[0].blocked_reason.as_ref().unwrap().contains("OTHER.Data"));
        let mut inherited = info.clone(); inherited.definition = "CREATE TYPE T UNDER Parent (n NUMBER);".into();
        let steps = oracle_routine_steps_with_context(&super::super::diff_functions(&[inherited], &[]), DatabaseType::OceanbaseOracle, Some("TARGET"), Some(DatabaseType::Oracle), Some(&valid));
        assert!(steps[0].blocked_reason.as_ref().unwrap().contains("UNDER"));
        info.type_info.as_mut().unwrap().dependency_state = dbx_types::oracle_types::OracleMetadataReadState::Denied;
        assert!(oracle_routine_steps_with_context(&super::super::diff_functions(&[info], &[]), DatabaseType::OceanbaseOracle, Some("TARGET"), Some(DatabaseType::Oracle), Some(&valid))[0].sql.is_none());
        let mut reverse = conversion_context(&diffs.iter().filter_map(|diff| diff.source.clone()).collect::<Vec<_>>(), DatabaseType::OceanbaseOracle, DatabaseType::Oracle);
        reverse.target_editions_disabled = false;
        assert!(oracle_routine_steps_with_context(&diffs, DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::OceanbaseOracle), Some(&reverse))[0].blocked_reason.as_ref().unwrap().contains("edition"));
    }

    #[test]
    fn cross_engine_type_dependency_cycles_and_blocked_specs_never_offer_a_body() {
        let mut a = user_type("A", false); a.definition = "CREATE TYPE A AS TABLE OF SOURCE.B;".into();
        a.dependency_objects.push(crate::types::RoutineDependency { owner: "SOURCE".into(), name: "B".into(), object_type: "TYPE".into() });
        let mut b = user_type("B", false); b.definition = "CREATE TYPE B AS TABLE OF SOURCE.A;".into();
        b.dependency_objects.push(crate::types::RoutineDependency { owner: "SOURCE".into(), name: "A".into(), object_type: "TYPE".into() });
        let objects = vec![a, b]; let context = conversion_context(&objects, DatabaseType::Oracle, DatabaseType::OceanbaseOracle);
        let steps = oracle_routine_steps_with_context(&super::super::diff_functions(&objects, &[]), DatabaseType::OceanbaseOracle, Some("TARGET"), Some(DatabaseType::Oracle), Some(&context));
        assert!(steps.iter().all(|step| step.blocked_reason.as_ref().unwrap().contains("cycle")));
        let mut spec = user_type("T", false); spec.definition = "CREATE TYPE T AS OBJECT(n NUMBER, MEMBER FUNCTION f RETURN NUMBER) NOT FINAL;".into(); spec.paired_object_present = Some(true);
        let mut body = user_type("T", true); body.definition = "CREATE TYPE BODY T AS MEMBER FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; END;".into();
        let objects = vec![spec, body]; let context = conversion_context(&objects, DatabaseType::Oracle, DatabaseType::OceanbaseOracle);
        let steps = oracle_routine_steps_with_context(&super::super::diff_functions(&objects, &[]), DatabaseType::OceanbaseOracle, Some("TARGET"), Some(DatabaseType::Oracle), Some(&context));
        assert!(steps.iter().all(|step| step.sql.is_none()));
        assert!(steps.iter().find(|step| step.routine_type == "TYPE BODY").unwrap().blocked_reason.as_ref().unwrap().contains("dependency"));
    }

    #[test]
    fn cross_engine_packages_and_simple_triggers_have_explicit_positive_and_unknown_paths() {
        let mut spec = routine("PKG", "CREATE PACKAGE PKG AS PROCEDURE p; FUNCTION f RETURN NUMBER; END PKG;"); spec.function_type = "PACKAGE".into(); spec.paired_object_present = Some(true);
        let mut body = routine("PKG", "CREATE PACKAGE BODY PKG AS PROCEDURE p IS BEGIN NULL; END; FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; END PKG;"); body.function_type = "PACKAGE BODY".into(); body.paired_object_present = Some(true);
        let objects = vec![body.clone(), spec];
        for (source, target) in [(DatabaseType::Oracle, DatabaseType::OceanbaseOracle), (DatabaseType::OceanbaseOracle, DatabaseType::Oracle)] {
            let context = conversion_context(&objects, source, target);
            let steps = oracle_routine_steps_with_context(&super::super::diff_functions(&objects, &[]), target, Some("TARGET"), Some(source), Some(&context));
            assert!(steps.iter().all(|step| step.sql.is_some()), "{steps:?}");
            assert_eq!(steps[0].routine_type, "PACKAGE");
        }
        body.definition = body.definition.replace("BEGIN NULL;", "BEGIN EXECUTE IMMEDIATE 'DELETE FROM DATA';");
        let unknown = vec![body]; let context = conversion_context(&unknown, DatabaseType::Oracle, DatabaseType::OceanbaseOracle);
        assert!(!portable_cross_engine_body(&unknown[0].definition));
        assert!(oracle_routine_steps_with_context(&super::super::diff_functions(&unknown, &[]), DatabaseType::OceanbaseOracle, Some("TARGET"), Some(DatabaseType::Oracle), Some(&context))[0].sql.is_none());
        let mut trigger = routine("TR", "CREATE TRIGGER TR BEFORE UPDATE ON SOURCE.DATA FOR EACH ROW BEGIN NULL; END;"); trigger.function_type = "TRIGGER".into();
        trigger.trigger = Some(crate::types::RoutineTriggerInfo { table_owner: "SOURCE".into(), table_name: "DATA".into(), timing: "BEFORE EACH ROW".into(), event: "UPDATE".into(), status: "DISABLED".into(), base_object_type: "TABLE".into() });
        let objects = vec![trigger]; let mut context = conversion_context(&objects, DatabaseType::Oracle, DatabaseType::OceanbaseOracle);
        let diffs = super::super::diff_functions(&objects, &[]);
        assert!(oracle_routine_steps_with_context(&diffs, DatabaseType::OceanbaseOracle, Some("TARGET"), Some(DatabaseType::Oracle), Some(&context))[0].sql.is_none());
        context.target_dependencies.push(("TARGET".into(), "DATA".into(), "TABLE".into()));
        let steps = oracle_routine_steps_with_context(&diffs, DatabaseType::OceanbaseOracle, Some("TARGET"), Some(DatabaseType::Oracle), Some(&context));
        assert!(steps[0].sql.as_ref().unwrap().contains("ON \"TARGET\".DATA"));
        assert_eq!(steps[0].post_sql, vec!["ALTER TRIGGER \"TARGET\".\"TR\" DISABLE;"]);
    }
}
