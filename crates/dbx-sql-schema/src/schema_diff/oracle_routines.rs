use super::{DatabaseType, FunctionDiff, FunctionInfo};
use dbx_sql_core::object_source_sql::{
    comparable_oracle_routine_definition, prepare_oracle_routine_definition, OracleRoutineDefinitionInput,
};
use dbx_sql_core::types::ObjectSourceKind;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleRoutineCompareContext {
    pub source_database_type: DatabaseType,
    pub target_database_type: DatabaseType,
    pub source_schema: String,
    pub target_schema: String,
    pub source_enumeration_complete: bool,
    pub target_enumeration_complete: bool,
    pub source_incomplete_names: Vec<String>,
    pub target_incomplete_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_kinds: Option<Vec<ObjectSourceKind>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_incomplete_objects: Option<Vec<OracleRoutineCompareIdentity>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_incomplete_objects: Option<Vec<OracleRoutineCompareIdentity>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleRoutineCompareIdentity {
    pub name: String,
    pub kind: ObjectSourceKind,
}

impl OracleRoutineCompareContext {
    fn supported(&self) -> bool {
        self.source_database_type == self.target_database_type
            && matches!(self.source_database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
            && !self.source_schema.is_empty()
            && !self.target_schema.is_empty()
    }

    fn package_enabled(&self, kind: &ObjectSourceKind) -> bool {
        is_package(kind) && self.object_kinds.as_ref().is_some_and(|kinds| kinds.contains(kind))
    }

    fn readable(&self, kind: &ObjectSourceKind) -> bool {
        if is_package(kind) && !self.package_enabled(kind) {
            return false;
        }
        self.supported()
            || (self.package_enabled(kind)
                && matches!(self.source_database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
                && matches!(self.target_database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
                && !self.source_schema.is_empty()
                && !self.target_schema.is_empty())
    }
}

fn is_package(kind: &ObjectSourceKind) -> bool {
    matches!(kind, ObjectSourceKind::Package | ObjectSourceKind::PackageBody)
}

fn kind(function: &FunctionInfo) -> Result<ObjectSourceKind, String> {
    match function.function_type.as_str() {
        "PROCEDURE" => Ok(ObjectSourceKind::Procedure),
        "FUNCTION" => Ok(ObjectSourceKind::Function),
        "PACKAGE" => Ok(ObjectSourceKind::Package),
        "PACKAGE_BODY" => Ok(ObjectSourceKind::PackageBody),
        _ => Err("Program kind must be exactly PROCEDURE, FUNCTION, PACKAGE or PACKAGE_BODY".into()),
    }
}

fn comparison_key(function: &FunctionInfo, typed: bool) -> (&'static str, &str) {
    let namespace = if typed {
        match function.function_type.as_str() {
            "PACKAGE" => "PACKAGE",
            "PACKAGE_BODY" => "PACKAGE_BODY",
            _ => "ROUTINE",
        }
    } else {
        "ROUTINE"
    };
    (namespace, function.name.as_str())
}

fn incomplete(
    objects: Option<&[OracleRoutineCompareIdentity]>,
    names: &[String],
    name: &str,
    kind: &ObjectSourceKind,
) -> bool {
    objects.map_or_else(
        || names.iter().any(|candidate| candidate == name),
        |objects| objects.iter().any(|object| object.name == name && object.kind == *kind),
    )
}

fn definition_input(
    function: &FunctionInfo,
    context: &OracleRoutineCompareContext,
    source: bool,
    replace: bool,
) -> Result<OracleRoutineDefinitionInput, String> {
    Ok(OracleRoutineDefinitionInput {
        database_type: if source { context.source_database_type } else { context.target_database_type },
        object_type: kind(function)?,
        source_owner: if source { &context.source_schema } else { &context.target_schema }.clone(),
        target_owner: context.target_schema.clone(),
        name: function.name.clone(),
        source: function.definition.clone(),
        replace,
    })
}

/// Keep equal and unreadable rows for the existing side-by-side source viewer.
/// Absence is actionable only when the opposite inventory is complete.
pub fn diff_oracle_routines(
    source: &[FunctionInfo],
    target: &[FunctionInfo],
    context: &OracleRoutineCompareContext,
) -> Vec<FunctionDiff> {
    let typed = context.object_kinds.is_some();
    let included = |function: &&FunctionInfo| {
        context.object_kinds.as_ref().is_none_or(|kinds| kind(function).map_or(true, |kind| kinds.contains(&kind)))
    };
    let source_map = source
        .iter()
        .filter(included)
        .map(|function| (comparison_key(function, typed), function))
        .collect::<BTreeMap<_, _>>();
    let target_map = target
        .iter()
        .filter(included)
        .map(|function| (comparison_key(function, typed), function))
        .collect::<BTreeMap<_, _>>();
    let names = source_map.keys().chain(target_map.keys()).copied().collect::<BTreeSet<_>>();
    names
        .into_iter()
        .map(|key| {
            let name = key.1;
            let source = source_map.get(&key).copied();
            let target = target_map.get(&key).copied();
            let object_kind = kind(source.or(target).expect("comparison keys have an object"));
            let mut diff = FunctionDiff {
                diff_type: "unreadable".into(),
                program_kind: if typed { object_kind.as_ref().ok().cloned() } else { None },
                name: name.into(),
                source: source.cloned(),
                target: target.cloned(),
                changes: Vec::new(),
            };
            let compared = (|| {
                let object_kind = object_kind.as_ref().map_err(Clone::clone)?;
                if !context.readable(object_kind) {
                    return Err(
                        "Automatic routine comparison requires the same Oracle product type and exact owners".into()
                    );
                }
                if let Some(source) = source {
                    if incomplete(
                        if typed { context.source_incomplete_objects.as_deref() } else { None },
                        &context.source_incomplete_names,
                        name,
                        &kind(source)?,
                    ) {
                        return Err(
                            "Source routine definition is incomplete; readable original text is retained".into()
                        );
                    }
                }
                if let Some(target) = target {
                    if incomplete(
                        if typed { context.target_incomplete_objects.as_deref() } else { None },
                        &context.target_incomplete_names,
                        name,
                        &kind(target)?,
                    ) {
                        return Err(
                            "Target routine definition is incomplete; readable original text is retained".into()
                        );
                    }
                }
                if source.is_none() && !context.source_enumeration_complete {
                    return Err("Source inventory is incomplete; absence and deletion are not established".into());
                }
                if target.is_none() && !context.target_enumeration_complete {
                    return Err("Target inventory is incomplete; absence and creation are not established".into());
                }
                if typed
                    && source_map.values().filter(|object| object.name == name).any(|source| {
                        target_map.values().filter(|object| object.name == name).any(|target| {
                            kind(source)
                                .ok()
                                .zip(kind(target).ok())
                                .is_some_and(|(source, target)| is_package(&source) != is_package(&target))
                        })
                    })
                {
                    return Ok("conflict");
                }
                match (source, target) {
                    (Some(source), Some(target)) => {
                        if kind(source)? != kind(target)? {
                            return Ok("conflict");
                        }
                        let source =
                            comparable_oracle_routine_definition(definition_input(source, context, true, true)?)?;
                        let target =
                            comparable_oracle_routine_definition(definition_input(target, context, false, true)?)?;
                        Ok(if source == target { "equal" } else { "modified" })
                    }
                    (Some(source), None) => {
                        prepare_oracle_routine_definition(definition_input(source, context, true, false)?)?;
                        Ok("added")
                    }
                    (None, Some(target)) => {
                        comparable_oracle_routine_definition(definition_input(target, context, false, true)?)?;
                        Ok("removed")
                    }
                    _ => unreachable!("names are collected from the two inventories"),
                }
            })();
            match compared {
                Ok(state) => {
                    diff.diff_type = state.into();
                    if state == "conflict" {
                        diff.changes.push(
                            "Routine kind conflict: review an explicit drop/create plan; no implicit replacement"
                                .into(),
                        );
                    }
                    if state == "modified" {
                        diff.changes.push("definition changed".into());
                    }
                }
                Err(error) => diff.changes.push(error),
            }
            diff
        })
        .collect()
}

pub fn oracle_routine_diff_sql(diff: &FunctionDiff, context: &OracleRoutineCompareContext) -> Result<String, String> {
    if !context.supported() {
        return Err("Oracle routine target adaptation requires the same product type".into());
    }
    if let Some(function) = diff.source.as_ref().or(diff.target.as_ref()) {
        let object_kind = kind(function)?;
        if is_package(&object_kind)
            && (!context.package_enabled(&object_kind) || diff.program_kind.as_ref() != Some(&object_kind))
        {
            return Err("Package target SQL requires its explicit program kind and comparison scope".into());
        }
        if diff.program_kind.as_ref().is_some_and(|kind| *kind != object_kind || function.name != diff.name) {
            return Err("Program diff identity does not match its definition".into());
        }
    }
    match diff.diff_type.as_str() {
        "added" | "modified" => {
            let source = diff.source.as_ref().ok_or("Routine source is unavailable")?;
            if diff.diff_type == "modified"
                && kind(source)? != kind(diff.target.as_ref().ok_or("Routine target is unavailable")?)?
            {
                return Err("A routine kind conflict cannot be replaced".into());
            }
            prepare_oracle_routine_definition(definition_input(source, context, true, diff.diff_type == "modified")?)
        }
        "removed" => {
            let target = diff.target.as_ref().ok_or("Routine target is unavailable")?;
            let keyword = match kind(target)? {
                ObjectSourceKind::Procedure => "PROCEDURE",
                ObjectSourceKind::Function => "FUNCTION",
                ObjectSourceKind::Package => "PACKAGE",
                ObjectSourceKind::PackageBody => "PACKAGE BODY",
                _ => return Err("Unsupported program kind".into()),
            };
            Ok(format!(
                "DROP {keyword} \"{}\".\"{}\";",
                context.target_schema.replace('"', "\"\""),
                target.name.replace('"', "\"\"")
            ))
        }
        "equal" => Ok(String::new()),
        _ => Err("Routine comparison is unresolved; keep the draft and resolve its issues before deployment".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema_diff::{prepare_schema_diff, SchemaDiffPreparationOptions};

    fn context() -> OracleRoutineCompareContext {
        OracleRoutineCompareContext {
            source_database_type: DatabaseType::OceanbaseOracle,
            target_database_type: DatabaseType::OceanbaseOracle,
            source_schema: "Source.Owner".into(),
            target_schema: "Target.Owner".into(),
            source_enumeration_complete: true,
            target_enumeration_complete: true,
            source_incomplete_names: Vec::new(),
            target_incomplete_names: Vec::new(),
            object_kinds: None,
            source_incomplete_objects: None,
            target_incomplete_objects: None,
        }
    }

    fn function(name: &str, value: &str) -> FunctionInfo {
        FunctionInfo {
            name: name.into(),
            function_type: "FUNCTION".into(),
            data_type: String::new(),
            arguments: String::new(),
            definition: format!(
                "FUNCTION \"{}\" RETURN VARCHAR2 AS BEGIN RETURN '{}'; END",
                name.replace('"', "\"\""),
                value
            ),
        }
    }

    fn package_context() -> OracleRoutineCompareContext {
        let mut value = serde_json::to_value(context()).unwrap();
        value["objectKinds"] = serde_json::json!(["PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"]);
        serde_json::from_value(value).unwrap()
    }

    fn package(name: &str, body: bool, value: u32) -> FunctionInfo {
        let quoted_name = name.replace('"', "\"\"");
        FunctionInfo {
            name: name.into(),
            function_type: if body { "PACKAGE_BODY" } else { "PACKAGE" }.into(),
            data_type: String::new(),
            arguments: String::new(),
            definition: if body {
                format!("PACKAGE BODY \"{quoted_name}\" AS FUNCTION f RETURN NUMBER IS BEGIN RETURN {value}; END; END;")
            } else {
                format!("PACKAGE \"{quoted_name}\" AS c CONSTANT NUMBER := {value}; FUNCTION f RETURN NUMBER; END;")
            },
        }
    }

    #[test]
    fn package_specification_and_body_have_explicit_separate_identities_in_every_state() {
        let context = package_context();
        for state in ["equal", "modified", "added", "removed"] {
            let source = if state == "removed" {
                vec![]
            } else {
                vec![package("Pkg.With.Dot", false, 2), package("Pkg.With.Dot", true, 2)]
            };
            let target = if state == "added" {
                vec![]
            } else {
                let value = if state == "modified" { 1 } else { 2 };
                vec![package("Pkg.With.Dot", false, value), package("Pkg.With.Dot", true, value)]
            };
            let diffs = diff_oracle_routines(&source, &target, &context);
            assert_eq!(diffs.len(), 2, "{state}: a pair must not collapse by name");
            assert!(diffs.iter().all(|diff| diff.diff_type == state), "{state}: {diffs:?}");
            let kinds = diffs
                .iter()
                .map(|diff| serde_json::to_value(diff).unwrap()["programKind"].as_str().unwrap().to_string())
                .collect::<BTreeSet<_>>();
            assert_eq!(kinds, BTreeSet::from(["PACKAGE".into(), "PACKAGE_BODY".into()]));
        }
    }

    #[test]
    fn a_body_read_failure_does_not_mark_its_same_name_specification_unreadable() {
        let mut value = serde_json::to_value(package_context()).unwrap();
        value["sourceIncompleteNames"] = serde_json::json!(["P"]);
        value["sourceIncompleteObjects"] = serde_json::json!([{"name":"P","kind":"PACKAGE_BODY"}]);
        let context = serde_json::from_value(value).unwrap();
        let pair = vec![package("P", false, 1), package("P", true, 1)];
        let diffs = diff_oracle_routines(&pair, &pair, &context);
        assert_eq!(diffs.len(), 2);
        for diff in diffs {
            let kind = serde_json::to_value(&diff).unwrap()["programKind"].as_str().unwrap().to_string();
            assert_eq!(diff.diff_type, if kind == "PACKAGE" { "equal" } else { "unreadable" });
        }
    }

    #[test]
    fn kind_scoped_read_failures_follow_each_actual_side_of_a_standalone_conflict() {
        let mut value = serde_json::to_value(package_context()).unwrap();
        value["targetIncompleteNames"] = serde_json::json!(["P"]);
        value["targetIncompleteObjects"] = serde_json::json!([{"name":"P","kind":"FUNCTION"}]);
        let context = serde_json::from_value(value).unwrap();
        let source = FunctionInfo {
            function_type: "PROCEDURE".into(),
            definition: "PROCEDURE P AS BEGIN NULL; END;".into(),
            ..function("P", "")
        };
        let target = function("P", "retained target");
        let diffs = diff_oracle_routines(&[source], std::slice::from_ref(&target), &context);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].diff_type, "unreadable");
        assert_eq!(diffs[0].target.as_ref().unwrap().definition, target.definition);
        assert!(oracle_routine_diff_sql(&diffs[0], &context).is_err());
    }

    #[test]
    fn cross_product_packages_are_readable_but_never_automatic_target_sql() {
        let mut context = package_context();
        context.source_database_type = DatabaseType::Oracle;
        let source = vec![package("P", false, 1), function("Standalone", "v")];
        let diffs = diff_oracle_routines(&source, &[], &context);
        assert_eq!(diffs.iter().find(|diff| diff.name == "P").unwrap().diff_type, "added");
        assert_eq!(diffs.iter().find(|diff| diff.name == "Standalone").unwrap().diff_type, "unreadable");
        assert!(diffs.iter().all(|diff| oracle_routine_diff_sql(diff, &context).is_err()));
    }

    #[test]
    fn package_deletion_sql_distinguishes_body_only_and_the_implicit_pair_drop() {
        let context = package_context();
        let pair = vec![package("P", false, 1), package("P", true, 1)];
        let diffs = diff_oracle_routines(&pair[..1], &pair, &context);
        let body = diffs.iter().find(|diff| diff.diff_type == "removed").unwrap();
        assert_eq!(oracle_routine_diff_sql(body, &context).unwrap(), "DROP PACKAGE BODY \"Target.Owner\".\"P\";");
        let prepared = prepare_schema_diff(SchemaDiffPreparationOptions {
            target_functions: pair,
            database_type: DatabaseType::OceanbaseOracle,
            oracle_routines: Some(context),
            ..Default::default()
        });
        assert_eq!(prepared.sync_sql.trim(), "DROP PACKAGE \"Target.Owner\".\"P\";");
    }

    #[test]
    fn package_namespace_conflicts_and_legacy_routine_kind_conflicts_remain_unresolved() {
        let context = package_context();
        let diffs = diff_oracle_routines(&[package("P", false, 1)], &[function("P", "v")], &context);
        assert!(!diffs.is_empty());
        assert!(diffs.iter().all(|diff| diff.diff_type == "conflict"));
        assert!(diffs.iter().all(|diff| oracle_routine_diff_sql(diff, &context).is_err()));
        let procedure = FunctionInfo {
            function_type: "PROCEDURE".into(),
            definition: "PROCEDURE P AS BEGIN NULL; END;".into(),
            ..function("P", "")
        };
        let diffs = diff_oracle_routines(&[procedure], &[function("P", "v")], &context);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].diff_type, "conflict");
    }

    #[test]
    fn a_package_never_falls_through_generic_function_ddl_templates() {
        let diff: FunctionDiff = serde_json::from_value(
            serde_json::json!({"type":"removed","name":"P","programKind":"PACKAGE_BODY","target":package("P",true,1)}),
        )
        .unwrap();
        let sql = crate::schema_diff::generate_schema_sync_sql(
            &[],
            &[diff],
            &[],
            &[],
            &[],
            DatabaseType::Mysql,
            Some("T"),
            false,
            None,
            &[],
        );
        assert!(!sql.contains("DROP FUNCTION"));
        assert!(sql.contains("reviewed package plan"));
    }

    #[test]
    fn real_preparation_keeps_all_four_states_and_kind() {
        let source = vec![
            function("Added.Func", "new"),
            function("Changed.Func", "two  spaces"),
            function("Equal.Func", "same"),
        ];
        let target = vec![
            function("Removed.Func", "old"),
            function("Changed.Func", "two spaces"),
            function("Equal.Func", "same"),
        ];
        let prepared = prepare_schema_diff(SchemaDiffPreparationOptions {
            source_functions: source,
            target_functions: target,
            database_type: DatabaseType::OceanbaseOracle,
            oracle_routines: Some(context()),
            ..Default::default()
        });
        assert_eq!(
            prepared
                .function_diffs
                .iter()
                .map(|diff| (diff.name.as_str(), diff.diff_type.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("Added.Func", "added"),
                ("Changed.Func", "modified"),
                ("Equal.Func", "equal"),
                ("Removed.Func", "removed")
            ]
        );
        assert!(prepared.sync_sql.contains("DROP FUNCTION \"Target.Owner\".\"Removed.Func\";"));
        assert!(!prepared.sync_sql.contains("DROP PROCEDURE"));
    }

    #[test]
    fn incomplete_inventory_does_not_create_a_false_deletion_or_addition() {
        let mut context = context();
        context.source_enumeration_complete = false;
        let diffs = diff_oracle_routines(&[], &[function("Kept.Func", "v")], &context);
        assert_eq!(diffs[0].diff_type, "unreadable");
        assert!(oracle_routine_diff_sql(&diffs[0], &context).is_err());
        context.source_enumeration_complete = true;
        context.target_enumeration_complete = false;
        assert_eq!(diff_oracle_routines(&[function("Kept.Func", "v")], &[], &context)[0].diff_type, "unreadable");
    }

    #[test]
    fn per_object_failure_retains_raw_text_and_other_actionable_rows() {
        let mut context = context();
        context.source_incomplete_names.push("Unread.Func".into());
        let source = vec![function("Unread.Func", "retained"), function("Good.Func", "new")];
        let diffs = diff_oracle_routines(&source, &[function("Unread.Func", "old")], &context);
        assert_eq!(diffs[0].diff_type, "added");
        assert_eq!(diffs[1].diff_type, "unreadable");
        assert_eq!(diffs[1].source.as_ref().unwrap().definition, source[0].definition);
    }

    #[test]
    fn kind_conflict_is_not_a_replace_or_implicit_drop() {
        let source = FunctionInfo {
            function_type: "PROCEDURE".into(),
            definition: "PROCEDURE \"Kind.Mixed\" AS BEGIN NULL; END".into(),
            ..function("Kind.Mixed", "")
        };
        let diffs = diff_oracle_routines(&[source], &[function("Kind.Mixed", "v")], &context());
        assert_eq!(diffs[0].diff_type, "conflict");
        assert!(oracle_routine_diff_sql(&diffs[0], &context()).is_err());
    }

    #[test]
    fn product_types_do_not_collapse_to_the_oracle_dialect() {
        let mut context = context();
        context.source_database_type = DatabaseType::Oracle;
        let diffs = diff_oracle_routines(&[function("Mixed.Func", "v")], &[], &context);
        assert_eq!(diffs[0].diff_type, "unreadable");
        assert!(oracle_routine_diff_sql(&diffs[0], &context).is_err());
    }

    #[test]
    fn new_create_cannot_replace_a_concurrent_object_and_does_not_rewrite_body_literals() {
        let source = function("New.Func", "Source.Owner text");
        let diffs = diff_oracle_routines(&[source], &[], &context());
        let sql = oracle_routine_diff_sql(&diffs[0], &context()).unwrap();
        assert!(sql.contains("FUNCTION \"Target.Owner\".\"New.Func\""));
        assert!(!sql.contains("OR REPLACE"));
        assert!(sql.contains("'Source.Owner text'"));
    }

    #[test]
    fn quoted_owner_mapping_is_confined_to_the_declaration() {
        let mut source = function("Mixed.Func", "same");
        source.definition = source.definition.replacen("FUNCTION ", "CREATE FUNCTION \"Source.Owner\".", 1);
        let mut target = function("Mixed.Func", "same");
        target.definition = format!("CREATE OR REPLACE {};\n/", target.definition).replacen(
            "FUNCTION ",
            "FUNCTION \"Target.Owner\".",
            1,
        );
        assert_eq!(diff_oracle_routines(&[source], &[target], &context())[0].diff_type, "equal");
    }
}
