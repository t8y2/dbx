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
}

impl OracleRoutineCompareContext {
    fn supported(&self) -> bool {
        self.source_database_type == self.target_database_type
            && matches!(self.source_database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
            && !self.source_schema.is_empty()
            && !self.target_schema.is_empty()
    }
}

fn kind(function: &FunctionInfo) -> Result<ObjectSourceKind, String> {
    match function.function_type.as_str() {
        "PROCEDURE" => Ok(ObjectSourceKind::Procedure),
        "FUNCTION" => Ok(ObjectSourceKind::Function),
        _ => Err("Routine kind must be exactly PROCEDURE or FUNCTION".into()),
    }
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
    let source_map = source.iter().map(|function| (function.name.as_str(), function)).collect::<BTreeMap<_, _>>();
    let target_map = target.iter().map(|function| (function.name.as_str(), function)).collect::<BTreeMap<_, _>>();
    let names = source_map.keys().chain(target_map.keys()).copied().collect::<BTreeSet<_>>();
    names
        .into_iter()
        .map(|name| {
            let source = source_map.get(name).copied();
            let target = target_map.get(name).copied();
            let mut diff = FunctionDiff {
                diff_type: "unreadable".into(),
                name: name.into(),
                source: source.cloned(),
                target: target.cloned(),
                changes: Vec::new(),
            };
            let compared = (|| {
                if !context.supported() {
                    return Err(
                        "Automatic routine comparison requires the same Oracle product type and exact owners".into()
                    );
                }
                if source.is_some() && context.source_incomplete_names.iter().any(|candidate| candidate == name) {
                    return Err("Source routine definition is incomplete; readable original text is retained".into());
                }
                if target.is_some() && context.target_incomplete_names.iter().any(|candidate| candidate == name) {
                    return Err("Target routine definition is incomplete; readable original text is retained".into());
                }
                if source.is_none() && !context.source_enumeration_complete {
                    return Err("Source inventory is incomplete; absence and deletion are not established".into());
                }
                if target.is_none() && !context.target_enumeration_complete {
                    return Err("Target inventory is incomplete; absence and creation are not established".into());
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
                _ => "FUNCTION",
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
