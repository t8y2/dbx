use super::{FunctionDiff, SchemaSyncSqlPlan};
use crate::models::connection::DatabaseType;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineStep {
    pub name: String,
    pub routine_type: String,
    pub operation: String,
    pub sql: Option<String>,
    pub blocked_reason: Option<String>,
    pub dependencies: Vec<String>,
}

pub fn is_oracle_routine_database(database: DatabaseType) -> bool {
    matches!(database, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
}

fn header(definition: &str) -> Option<(String, usize)> {
    let identifier = r#"(?:"(?:[^"]|"")*"|[A-Za-z][A-Za-z0-9_$#]*)"#;
    let pattern = format!(r"(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION)\s+{identifier}(?:\s*\.\s*{identifier})?");
    let captures = Regex::new(&pattern).ok()?.captures(definition)?;
    Some((captures[1].to_ascii_uppercase(), captures.get(0)?.end()))
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
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
    Ok(format!("CREATE OR REPLACE {}{kind} {}.{}{}", edition_clause(definition), quote(schema), quote(name), &definition[end..]))
}

/// Cross-engine automatic conversion is deliberately limited to a portable PL/SQL
/// subset. Other definitions remain visible and require a target-specific migration.
fn portable_cross_engine_body(definition: &str) -> bool {
    if !edition_clause(definition).is_empty() { return false; }
    let Some((kind, end)) = header(definition) else { return false };
    let body = definition_without_client_delimiter(&definition[end..]);
    let pattern = if kind == "PROCEDURE" {
        r"(?is)^\s*(?:\(\s*\))?\s*(?:AS|IS)\s+BEGIN\s+NULL\s*;\s*END\s*;\s*$"
    } else {
        r"(?is)^\s*(?:\(\s*\))?\s*RETURN\s+(?:NUMBER|INTEGER)\s+(?:AS|IS)\s+BEGIN\s+RETURN\s+[+-]?[0-9]+(?:\.[0-9]+)?\s*;\s*END\s*;\s*$"
    };
    Regex::new(pattern).is_ok_and(|pattern| pattern.is_match(body))
}

pub fn oracle_routine_steps(
    diffs: &[FunctionDiff],
    target: DatabaseType,
    target_schema: Option<&str>,
    source: Option<DatabaseType>,
) -> Vec<RoutineStep> {
    if !is_oracle_routine_database(target) { return Vec::new(); }
    let mut steps: Vec<_> = diffs.iter().map(|diff| {
        let info = if diff.diff_type == "removed" { diff.target.as_ref() } else { diff.source.as_ref() };
        let kind = info.map(|info| info.function_type.to_ascii_uppercase()).unwrap_or_default();
        let result = (|| {
            let schema = target_schema.filter(|schema| !schema.is_empty()).ok_or("An explicit target schema is required")?;
            if !matches!(kind.as_str(), "PROCEDURE" | "FUNCTION") { return Err("This routine type is not supported".to_string()); }
            if diff.diff_type == "removed" {
                return Ok(format!("DROP {kind} {}.{};", quote(schema), quote(&diff.name)));
            }
            let info = info.ok_or("The complete routine source is missing")?;
            if info.status.as_deref() != Some("VALID") {
                return Err("The source routine is not confirmed VALID".to_string());
            }
            if let Some(owner) = info.schema.as_deref().filter(|owner| *owner != schema) {
                let qualified = format!(r#"(?i)(?:{}|{})\s*\."#, regex::escape(owner), regex::escape(&quote(owner)));
                let (_, header_end) = header(&info.definition).ok_or("The routine declaration is incomplete")?;
                if Regex::new(&qualified).is_ok_and(|pattern| pattern.is_match(&info.definition[header_end..])) {
                    return Err("The body contains an explicit source-schema reference; review its target mapping before applying".to_string());
                }
            }
            let source = source.ok_or("The source database type must be explicit")?;
            if !is_oracle_routine_database(source) { return Err("This source language cannot be converted to Oracle PL/SQL automatically".to_string()); }
            if source != target && !portable_cross_engine_body(&info.definition) {
                return Err("This cross-engine routine requires target-version compatibility verification; automatic conversion supports only parameterless NULL procedures and numeric constant functions".to_string());
            }
            oracle_routine_sql(&info.definition, &diff.name, schema, &kind)
        })();
        let (sql, blocked_reason) = match result { Ok(sql) => (Some(sql), None), Err(reason) => (None, Some(reason)) };
        let dependencies = info.map(|info| info.dependencies.iter().map(|dependency| {
            match (info.schema.as_deref(), target_schema) {
                (Some(owner), Some(target_owner)) if dependency.starts_with(&format!("{}.", quote(owner))) => format!("{}{}", quote(target_owner), &dependency[quote(owner).len()..]),
                _ => dependency.clone(),
            }
        }).collect()).unwrap_or_default();
        RoutineStep { name: diff.name.clone(), routine_type: kind, operation: diff.diff_type.clone(), sql, blocked_reason, dependencies }
    }).collect();
    steps.sort_by_key(|step| step.operation != "removed");
    let mut ordered = Vec::with_capacity(steps.len());
    while !steps.is_empty() {
        let next = steps.iter().position(|step| {
            let identity = format!("{}.{}", quote(target_schema.unwrap_or_default()), quote(&step.name));
            !steps.iter().any(|other| {
                if other.name == step.name && other.routine_type == step.routine_type { return false; }
                let other_identity = format!("{}.{}", quote(target_schema.unwrap_or_default()), quote(&other.name));
                if step.operation == "removed" { other.operation == "removed" && other.dependencies.contains(&identity) }
                else { other.operation != "removed" && step.dependencies.contains(&other_identity) }
            })
        });
        if let Some(index) = next { ordered.push(steps.remove(index)); }
        else {
            for step in &mut steps { step.sql = None; step.blocked_reason = Some("Routine dependency cycle requires an explicit compilation plan".to_string()); }
            ordered.append(&mut steps);
        }
    }
    ordered
}

pub fn add_oracle_routines_to_plan(plan: &mut SchemaSyncSqlPlan, diffs: &[FunctionDiff], target: DatabaseType, schema: Option<&str>, source: Option<DatabaseType>, source_schema: Option<&str>) {
    plan.routine_steps = oracle_routine_steps(diffs, target, schema, source);
    for step in &mut plan.routine_steps {
        if step.operation == "removed" { continue; }
        let actual_schema = diffs.iter().find(|diff| diff.name == step.name && diff.source.as_ref().is_some_and(|info| info.function_type.eq_ignore_ascii_case(&step.routine_type))).and_then(|diff| diff.source.as_ref()).and_then(|info| info.schema.as_deref());
        if source_schema.is_none() || actual_schema != source_schema {
            step.sql = None;
            step.blocked_reason = Some("Routine source owner does not match the selected source schema".to_string());
        }
    }
    for step in &plan.routine_steps {
        if let Some(sql) = &step.sql {
            plan.sync_sql.push_str("\n\n");
            plan.sync_sql.push_str(sql);
            if step.operation != "removed" { plan.sync_sql.push_str("\n/"); }
        }
    }
    if let Some(rollback) = &mut plan.rollback_sync_sql {
        let reverse: Vec<_> = diffs.iter().map(|diff| FunctionDiff {
            diff_type: match diff.diff_type.as_str() { "added" => "removed", "removed" => "added", _ => "modified" }.to_string(),
            name: diff.name.clone(), source: diff.target.clone(), target: diff.source.clone(), changes: Vec::new(),
        }).collect();
        for step in oracle_routine_steps(&reverse, target, schema, Some(target)) {
            if let Some(sql) = step.sql {
                rollback.push_str("\n\n"); rollback.push_str(&sql);
                if step.operation != "removed" { rollback.push_str("\n/"); }
            } else if let Some(reason) = step.blocked_reason {
                plan.rollback_completeness = super::RollbackCompleteness::Incomplete;
                plan.missing_rollback_objects.push(super::MissingRollbackObject { kind: step.routine_type, name: step.name, table: None, reason });
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
        assert_ne!(comparable_oracle_routine(source), comparable_oracle_routine(&source.replace("old  owner", "old owner")));
    }
    #[test]
    fn cross_engine_subset_does_not_accept_arbitrary_body_or_dynamic_sql() {
        assert!(portable_cross_engine_body("CREATE PROCEDURE p IS BEGIN NULL; END;"));
        assert!(portable_cross_engine_body("CREATE FUNCTION f RETURN NUMBER IS BEGIN RETURN 12; END;"));
        assert!(!portable_cross_engine_body("CREATE PROCEDURE p IS BEGIN EXECUTE IMMEDIATE 'DROP TABLE t'; END;"));
    }

    fn routine(name: &str, definition: &str) -> crate::types::FunctionInfo {
        crate::types::FunctionInfo { name: name.to_string(), function_type: "PROCEDURE".into(), data_type: String::new(), definition: definition.to_string(), arguments: String::new(), schema: Some("SOURCE".into()), status: Some("VALID".into()), dependencies: Vec::new() }
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
        let steps = oracle_routine_steps(&super::super::diff_functions(&[invalid], &[]), DatabaseType::Oracle, Some("TARGET"), Some(DatabaseType::Oracle));
        assert!(steps[0].sql.is_none());
        assert!(steps[0].blocked_reason.as_deref().unwrap().contains("VALID"));
    }
}
