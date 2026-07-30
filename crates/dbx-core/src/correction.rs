use serde::{Deserialize, Serialize};

use crate::data_compare::{DataCompareFromTablesPreparation, DataCompareResult};
use crate::schema_diff::SchemaDiffPreparation;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CorrectionStepType {
    SchemaCreate,
    SchemaAlter,
    SchemaDrop,
    DataInsert,
    DataUpdate,
    DataDelete,
    SchemaPostSync,
    Checkpoint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionStep {
    pub step_type: CorrectionStepType,
    pub table_name: Option<String>,
    pub sql: String,
    pub rollback_sql: Option<String>,
    pub description: String,
    pub risk_level: CorrectionRiskLevel,
    #[serde(default)]
    pub depends_on: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub enum CorrectionRiskLevel {
    Safe,
    #[default]
    Caution,
    Dangerous,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CorrectionStrategy {
    StructureFirst,
    DataFirst,
    Interleaved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JointCorrectionPlan {
    pub strategy: CorrectionStrategy,
    pub steps: Vec<CorrectionStep>,
    pub schema_diff_count: usize,
    pub data_diff_count: usize,
    pub total_estimated_duration_secs: Option<u64>,
    #[serde(default)]
    pub rollback_steps: Vec<CorrectionStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JointCorrectionOptions {
    pub strategy: CorrectionStrategy,
    #[serde(default)]
    pub include_checkpoints: bool,
    #[serde(default)]
    pub include_rollback: bool,
}

impl Default for JointCorrectionOptions {
    fn default() -> Self {
        Self { strategy: CorrectionStrategy::StructureFirst, include_checkpoints: true, include_rollback: true }
    }
}

/// Build a joint correction plan from schema diff and data compare results.
///
/// Orchestrates schema + data changes according to `CorrectionStrategy`:
/// - `StructureFirst`: schema → data → post-sync checks
/// - `DataFirst`: data → schema
/// - `Interleaved`: per-table schema + data interleaved
///
/// # Limitations
/// - `Interleaved` uses placeholder SQL rather than actual per-table DDL slices.
/// - Table name matching uses substring checks (`line.contains(&name)`), which can
///   produce false positives when one table name is a prefix of another.
pub fn build_joint_correction_plan(
    schema_diff: Option<&SchemaDiffPreparation>,
    data_compare: Option<&DataCompareFromTablesPreparation>,
    options: JointCorrectionOptions,
) -> JointCorrectionPlan {
    let mut steps = Vec::new();
    let mut rollback_steps = Vec::new();
    let mut step_index = 0usize;

    match options.strategy {
        CorrectionStrategy::StructureFirst => {
            step_index = append_schema_steps(schema_diff, &mut steps, &mut rollback_steps, &options, step_index);
            let _ = append_data_steps(data_compare, &mut steps, &mut rollback_steps, &options, step_index);
        }
        CorrectionStrategy::DataFirst => {
            step_index = append_data_steps(data_compare, &mut steps, &mut rollback_steps, &options, step_index);
            let _ = append_schema_steps(schema_diff, &mut steps, &mut rollback_steps, &options, step_index);
        }
        CorrectionStrategy::Interleaved => {
            if let Some(schema) = schema_diff {
                let table_diffs: Vec<_> = schema.diffs.iter().filter(|d| d.diff_type != "unchanged").collect();

                for table_diff in &table_diffs {
                    let tbl_name = &table_diff.name;

                    if let Some(dc) = data_compare {
                        if contains_table(&dc.sync_sql, tbl_name) {
                            step_index = append_table_data_step(
                                &dc.result,
                                tbl_name,
                                &mut steps,
                                &mut rollback_steps,
                                &options,
                                step_index,
                            );
                        }
                    }

                    step_index = append_table_schema_step(
                        table_diff,
                        tbl_name,
                        &mut steps,
                        &mut rollback_steps,
                        &options,
                        step_index,
                    );
                }
            } else if let Some(dc) = data_compare {
                let _ = append_data_steps(Some(dc), &mut steps, &mut rollback_steps, &options, step_index);
            }
        }
    }

    let schema_diff_count = steps
        .iter()
        .filter(|s| {
            matches!(
                s.step_type,
                CorrectionStepType::SchemaCreate
                    | CorrectionStepType::SchemaAlter
                    | CorrectionStepType::SchemaDrop
                    | CorrectionStepType::SchemaPostSync
            )
        })
        .count();
    let data_diff_count = steps
        .iter()
        .filter(|s| {
            matches!(
                s.step_type,
                CorrectionStepType::DataInsert | CorrectionStepType::DataUpdate | CorrectionStepType::DataDelete
            )
        })
        .count();

    JointCorrectionPlan {
        strategy: options.strategy,
        steps,
        schema_diff_count,
        data_diff_count,
        total_estimated_duration_secs: None,
        rollback_steps,
    }
}

fn append_schema_steps(
    schema_diff: Option<&SchemaDiffPreparation>,
    steps: &mut Vec<CorrectionStep>,
    _rollback_steps: &mut Vec<CorrectionStep>,
    options: &JointCorrectionOptions,
    mut step_index: usize,
) -> usize {
    let Some(schema) = schema_diff else {
        return step_index;
    };

    if schema.sync_sql.is_empty() {
        return step_index;
    }

    if options.include_checkpoints {
        steps.push(CorrectionStep {
            step_type: CorrectionStepType::Checkpoint,
            table_name: None,
            sql: String::new(),
            rollback_sql: None,
            description: "Schema correction checkpoint".to_string(),
            risk_level: CorrectionRiskLevel::Safe,
            depends_on: Vec::new(),
        });
        step_index += 1;
    }

    let table_diffs: Vec<_> = schema.diffs.iter().filter(|d| d.diff_type != "unchanged").collect();

    for table_diff in &table_diffs {
        let tbl_name = &table_diff.name;
        step_index = append_table_schema_step(table_diff, tbl_name, steps, _rollback_steps, options, step_index);
    }

    step_index
}

fn append_table_schema_step(
    table_diff: &crate::schema_diff::TableDiff,
    tbl_name: &str,
    steps: &mut Vec<CorrectionStep>,
    rollback_steps: &mut Vec<CorrectionStep>,
    options: &JointCorrectionOptions,
    mut step_index: usize,
) -> usize {
    let step_type = match table_diff.diff_type.as_str() {
        "added" => CorrectionStepType::SchemaCreate,
        "removed" => CorrectionStepType::SchemaDrop,
        _ => CorrectionStepType::SchemaAlter,
    };

    let risk_level = match table_diff.diff_type.as_str() {
        "removed" => CorrectionRiskLevel::Dangerous,
        "modified" => CorrectionRiskLevel::Caution,
        _ => CorrectionRiskLevel::Safe,
    };

    let has_incomplete_triggers = table_diff
        .triggers
        .as_ref()
        .is_some_and(|triggers| triggers.iter().any(|t| t.source.as_ref().is_some_and(|s| s.statement.is_none())));

    let rollback_sql = if options.include_rollback {
        match table_diff.diff_type.as_str() {
            "added" => Some(format!("DROP TABLE IF EXISTS {};", tbl_name)),
            "removed" => {
                table_diff.target_ddl.as_ref().map(|ddl| {
                    if has_incomplete_triggers {
                        format!(
                            "-- WARNING: Rollback DDL is INCOMPLETE — trigger bodies could not be reconstructed.\n-- Manual review required. Original DDL:\n{}",
                            ddl
                        )
                    } else {
                        ddl.clone()
                    }
                }).or_else(|| {
                    if has_incomplete_triggers {
                        Some(format!(
                            "-- WARNING: Rollback is INCOMPLETE — table '{}' had triggers that cannot be reconstructed.\n-- Manual intervention required before executing.",
                            tbl_name
                        ))
                    } else {
                        Some(format!(
                            "-- Manual rollback required: recreate table {} with original DDL",
                            tbl_name
                        ))
                    }
                })
            }
            "modified" => table_diff.sync_sql.as_ref().map(|s| format!("-- Rollback: {}", s)),
            _ => None,
        }
    } else {
        None
    };

    let rollback_risk = if has_incomplete_triggers { CorrectionRiskLevel::Blocked } else { risk_level.clone() };

    let rollback_desc = if has_incomplete_triggers {
        format!(
            "INCOMPLETE Rollback for schema {} on table: {tbl_name} — trigger bodies cannot be reconstructed",
            table_diff.diff_type
        )
    } else {
        format!("Rollback for schema {} on table: {tbl_name}", table_diff.diff_type)
    };

    let sql = table_diff.sync_sql.clone().unwrap_or_else(|| format!("-- Schema change for table: {tbl_name}"));

    steps.push(CorrectionStep {
        step_type,
        table_name: Some(tbl_name.to_string()),
        sql,
        rollback_sql: rollback_sql.clone(),
        description: format!("Schema {} for table: {tbl_name}", table_diff.diff_type),
        risk_level,
        depends_on: Vec::new(),
    });

    if let Some(rollback) = rollback_sql {
        rollback_steps.push(CorrectionStep {
            step_type: match table_diff.diff_type.as_str() {
                "added" => CorrectionStepType::SchemaDrop,
                "removed" => CorrectionStepType::SchemaCreate,
                _ => CorrectionStepType::SchemaAlter,
            },
            table_name: Some(tbl_name.to_string()),
            sql: rollback,
            rollback_sql: None,
            description: rollback_desc,
            risk_level: rollback_risk,
            depends_on: Vec::new(),
        });
    }

    step_index += 1;

    step_index
}

fn append_data_steps(
    data_compare: Option<&DataCompareFromTablesPreparation>,
    steps: &mut Vec<CorrectionStep>,
    _rollback_steps: &mut Vec<CorrectionStep>,
    options: &JointCorrectionOptions,
    mut step_index: usize,
) -> usize {
    let Some(dc) = data_compare else {
        return step_index;
    };

    if dc.result.added.is_empty() && dc.result.removed.is_empty() && dc.result.modified.is_empty() {
        return step_index;
    }

    if options.include_checkpoints {
        steps.push(CorrectionStep {
            step_type: CorrectionStepType::Checkpoint,
            table_name: None,
            sql: String::new(),
            rollback_sql: None,
            description: "Data correction checkpoint".to_string(),
            risk_level: CorrectionRiskLevel::Safe,
            depends_on: Vec::new(),
        });
        step_index += 1;
    }

    for statement in &dc.sync_statements {
        let (step_type, description) = if statement.to_uppercase().starts_with("INSERT") {
            (CorrectionStepType::DataInsert, format!("Insert data: {}", summary(statement, 80)))
        } else if statement.to_uppercase().starts_with("UPDATE") {
            (CorrectionStepType::DataUpdate, format!("Update data: {}", summary(statement, 80)))
        } else if statement.to_uppercase().starts_with("DELETE") {
            (CorrectionStepType::DataDelete, format!("Delete data: {}", summary(statement, 80)))
        } else {
            (CorrectionStepType::SchemaPostSync, format!("Pre-sync: {}", summary(statement, 80)))
        };

        let rollback_sql = if options.include_rollback {
            if statement.to_uppercase().starts_with("INSERT") {
                Some(format!("-- Rollback: DELETE matching rows; manual review needed: {}", summary(statement, 60)))
            } else if statement.to_uppercase().starts_with("DELETE") {
                Some(format!("-- Rollback: INSERT deleted rows; manual review needed: {}", summary(statement, 60)))
            } else if statement.to_uppercase().starts_with("UPDATE") {
                Some(format!("-- Rollback: reverse UPDATE; manual review needed: {}", summary(statement, 60)))
            } else {
                None
            }
        } else {
            None
        };

        steps.push(CorrectionStep {
            step_type,
            table_name: None,
            sql: statement.clone(),
            rollback_sql,
            description,
            risk_level: CorrectionRiskLevel::Caution,
            depends_on: Vec::new(),
        });
        step_index += 1;
    }

    step_index
}

fn append_table_data_step(
    data_prep: &DataCompareResult,
    tbl_name: &str,
    steps: &mut Vec<CorrectionStep>,
    _rollback_steps: &mut Vec<CorrectionStep>,
    _options: &JointCorrectionOptions,
    mut step_index: usize,
) -> usize {
    let total = data_prep.added.len() + data_prep.modified.len() + data_prep.removed.len();
    if total == 0 {
        return step_index;
    }

    steps.push(CorrectionStep {
        step_type: CorrectionStepType::DataInsert,
        table_name: Some(tbl_name.to_string()),
        sql: format!(
            "-- Data sync for table: {tbl_name} ({} added, {} modified, {} removed)",
            data_prep.added.len(),
            data_prep.modified.len(),
            data_prep.removed.len()
        ),
        rollback_sql: None,
        description: format!(
            "Data sync for table: {tbl_name} ({} added, {} modified, {} removed)",
            data_prep.added.len(),
            data_prep.modified.len(),
            data_prep.removed.len()
        ),
        risk_level: CorrectionRiskLevel::Caution,
        depends_on: Vec::new(),
    });
    step_index += 1;

    step_index
}

fn contains_table(sync_sql: &str, table_name: &str) -> bool {
    sync_sql.contains(table_name)
}

fn summary(text: &str, max_len: usize) -> String {
    let cleaned = text.replace('\n', " ");
    if cleaned.len() <= max_len {
        cleaned
    } else {
        format!("{}...", &cleaned[..max_len.min(cleaned.len())])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_compare::{
        DataCompareChangedCell, DataCompareFromTablesPreparation, DataCompareModifiedRow, DataCompareResult,
        DataCompareRow,
    };
    use crate::schema_diff::{SchemaDiffPreparation, TableDiff};
    use serde_json::json;
    use std::collections::HashMap;

    fn sample_table_diff(diff_type: &str, name: &str) -> TableDiff {
        TableDiff {
            diff_type: diff_type.to_string(),
            object_type: Some("table".to_string()),
            name: name.to_string(),
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: Some(format!("-- SQL for {name}")),
        }
    }

    fn sample_schema_preparation() -> SchemaDiffPreparation {
        SchemaDiffPreparation {
            diffs: vec![sample_table_diff("added", "users"), sample_table_diff("modified", "orders")],
            sync_sql: "-- Schema sync SQL for users\n-- Schema sync SQL for orders".to_string(),
            function_diffs: Vec::new(),
            sequence_diffs: Vec::new(),
            rule_diffs: Vec::new(),
            owner_diffs: Vec::new(),
            rollback_sync_sql: Some("-- Rollback SQL".to_string()),
            rollback_completeness: crate::schema_diff::RollbackCompleteness::Complete,
            missing_rollback_objects: Vec::new(),
            rename_candidates: Vec::new(),
            rollback_graph: None,
            compatibility_warnings: Vec::new(),
            permission_diffs: Vec::new(),
            permission_sync_sql: None,
            dependency_graph: None,
        }
    }

    fn sample_data_preparation() -> DataCompareFromTablesPreparation {
        DataCompareFromTablesPreparation {
            result: DataCompareResult {
                added: vec![DataCompareRow {
                    key: "1".to_string(),
                    key_values: HashMap::from([("id".to_string(), json!(1))]),
                    values: HashMap::from([("id".to_string(), json!(1)), ("name".to_string(), json!("Ada"))]),
                }],
                removed: vec![],
                modified: vec![DataCompareModifiedRow {
                    key: "2".to_string(),
                    key_values: HashMap::from([("id".to_string(), json!(2))]),
                    source_values: HashMap::new(),
                    target_values: HashMap::new(),
                    changes: vec![DataCompareChangedCell {
                        column: "name".to_string(),
                        source: json!("Bob"),
                        target: json!("Bobby"),
                    }],
                }],
            },
            sync_statements: vec![
                "INSERT INTO \"public\".\"users\" (\"id\", \"name\") VALUES (1, 'Ada');".to_string(),
                "UPDATE \"public\".\"users\" SET \"name\" = 'Bob' WHERE \"id\" = 2;".to_string(),
            ],
            sync_sql: "INSERT INTO \"public\".\"users\" (\"id\", \"name\") VALUES (1, 'Ada');\n\
                      UPDATE \"public\".\"users\" SET \"name\" = 'Bob' WHERE \"id\" = 2;"
                .to_string(),
            pre_sync_statements: vec![],
            source_row_count: 2,
            target_row_count: 2,
            source_truncated: false,
            target_truncated: false,
            degradation_level: Some("full".to_string()),
            sampling_rate: Some(1.0),
            confidence_score: Some(1.0),
            verification_method: Some("full_compare".to_string()),
            source_checksums: None,
            target_checksums: None,
        }
    }

    #[test]
    fn builds_structure_first_correction_plan() {
        let schema = sample_schema_preparation();
        let data = sample_data_preparation();
        let plan = build_joint_correction_plan(
            Some(&schema),
            Some(&data),
            JointCorrectionOptions {
                strategy: CorrectionStrategy::StructureFirst,
                include_checkpoints: true,
                include_rollback: true,
            },
        );

        assert_eq!(plan.strategy, CorrectionStrategy::StructureFirst);
        assert!(plan.schema_diff_count > 0);
        assert!(plan.data_diff_count > 0);

        let first_data_idx = plan.steps.iter().position(|s| {
            matches!(
                s.step_type,
                CorrectionStepType::DataInsert | CorrectionStepType::DataUpdate | CorrectionStepType::DataDelete
            )
        });

        let last_schema_idx = plan.steps.iter().rposition(|s| {
            matches!(
                s.step_type,
                CorrectionStepType::SchemaCreate | CorrectionStepType::SchemaAlter | CorrectionStepType::SchemaDrop
            )
        });

        if let (Some(si), Some(di)) = (last_schema_idx, first_data_idx) {
            assert!(si < di, "Schema steps should come before data steps in StructureFirst strategy");
        }
    }

    #[test]
    fn builds_data_first_correction_plan() {
        let schema = sample_schema_preparation();
        let data = sample_data_preparation();
        let plan = build_joint_correction_plan(
            Some(&schema),
            Some(&data),
            JointCorrectionOptions {
                strategy: CorrectionStrategy::DataFirst,
                include_checkpoints: true,
                include_rollback: true,
            },
        );

        assert_eq!(plan.strategy, CorrectionStrategy::DataFirst);
        assert!(plan
            .steps
            .iter()
            .any(|s| matches!(s.step_type, CorrectionStepType::DataInsert | CorrectionStepType::DataUpdate)));
        assert!(plan
            .steps
            .iter()
            .any(|s| matches!(s.step_type, CorrectionStepType::SchemaCreate | CorrectionStepType::SchemaAlter)));
    }

    #[test]
    fn builds_interleaved_correction_plan() {
        let schema = sample_schema_preparation();
        let data = sample_data_preparation();
        let plan = build_joint_correction_plan(
            Some(&schema),
            Some(&data),
            JointCorrectionOptions {
                strategy: CorrectionStrategy::Interleaved,
                include_checkpoints: true,
                include_rollback: true,
            },
        );

        assert_eq!(plan.strategy, CorrectionStrategy::Interleaved);
        assert!(!plan.steps.is_empty());
    }

    #[test]
    fn handles_missing_schema_diff() {
        let data = sample_data_preparation();
        let plan = build_joint_correction_plan(None, Some(&data), JointCorrectionOptions::default());

        assert_eq!(plan.schema_diff_count, 0);
        assert!(plan.data_diff_count > 0);
    }

    #[test]
    fn handles_missing_data_compare() {
        let schema = sample_schema_preparation();
        let plan = build_joint_correction_plan(Some(&schema), None, JointCorrectionOptions::default());

        assert!(plan.schema_diff_count > 0);
        assert_eq!(plan.data_diff_count, 0);
    }

    #[test]
    fn handles_empty_input() {
        let plan = build_joint_correction_plan(None, None, JointCorrectionOptions::default());

        assert_eq!(plan.steps.len(), 0);
        assert_eq!(plan.schema_diff_count, 0);
        assert_eq!(plan.data_diff_count, 0);
    }

    #[test]
    fn correction_step_serialization() {
        let step = CorrectionStep {
            step_type: CorrectionStepType::SchemaCreate,
            table_name: Some("public.users".to_string()),
            sql: "CREATE TABLE ...".to_string(),
            rollback_sql: Some("DROP TABLE ...".to_string()),
            description: "Create users table".to_string(),
            risk_level: CorrectionRiskLevel::Safe,
            depends_on: vec![0],
        };

        let json = serde_json::to_string(&step).expect("serialization should succeed");
        let deserialized: CorrectionStep = serde_json::from_str(&json).expect("deserialization should succeed");

        assert_eq!(deserialized.step_type, CorrectionStepType::SchemaCreate);
        assert_eq!(deserialized.table_name, Some("public.users".to_string()));
        assert_eq!(deserialized.risk_level, CorrectionRiskLevel::Safe);
    }

    #[test]
    fn joint_correction_plan_serialization() {
        let schema = sample_schema_preparation();
        let data = sample_data_preparation();
        let plan = build_joint_correction_plan(Some(&schema), Some(&data), JointCorrectionOptions::default());

        let json = serde_json::to_string(&plan).expect("serialization should succeed");
        assert!(json.contains("structureFirst") || json.contains("StructureFirst"));
    }
}
