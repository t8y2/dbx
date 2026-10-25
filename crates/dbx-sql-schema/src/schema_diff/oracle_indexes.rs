use super::*;
use dbx_sql_core::object_source_sql::{
    extract_oracle_table_triggers, oracle_index_ddl_sources, rebase_oracle_table_ddl, rebase_oracle_trigger_ddl,
    split_oracle_table_ddl_with_retained, OracleDdlNameMapping, OracleIndexDdlSource, OracleSupportingIndexDdl,
    OracleSupportingIndexIdentity, OracleTableDdlParts,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleSchemaSyncEndpoint {
    pub connection_id: String,
    pub database: String,
    pub schema: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleSchemaSyncDdlOptions {
    #[serde(default)]
    pub separate_indexes: bool,
    pub source: Option<OracleSchemaSyncEndpoint>,
    pub target: Option<OracleSchemaSyncEndpoint>,
    #[serde(default)]
    pub table_mappings: Vec<SchemaDiffTableMapping>,
}

#[derive(Debug, Clone)]
pub struct OracleSchemaSyncTableDdl {
    pub diff_name: String,
    pub owner: String,
    pub table: String,
    pub table_ddl: Option<String>,
    pub indexes: Vec<OracleIndexDdlSource>,
    pub supporting_indexes: Vec<OracleSupportingIndexDdl>,
    pub retained_supporting_indexes: Vec<OracleSupportingIndexIdentity>,
    pub protected_drop_indexes: Vec<String>,
    pub issues: Vec<MissingRollbackObject>,
}

#[derive(Debug, Clone, Default)]
pub struct OracleSchemaSyncDdlSources {
    pub forward: Vec<OracleSchemaSyncTableDdl>,
    pub rollback: Vec<OracleSchemaSyncTableDdl>,
    pub table_mappings: Vec<SchemaDiffTableMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSyncGenerationIssue {
    pub direction: String,
    pub kind: String,
    pub name: String,
    pub table: Option<String>,
    pub reason: String,
}

impl OracleSchemaSyncTableDdl {
    fn table_mapping(&self, owner: &str, table: &str) -> OracleDdlNameMapping {
        OracleDdlNameMapping {
            source_owner: self.owner.clone(),
            source_name: self.table.clone(),
            target_owner: owner.into(),
            target_name: table.into(),
        }
    }

    fn index_mapping(&self, owner: &str, name: &str, target_owner: &str) -> Result<OracleDdlNameMapping, String> {
        if owner != self.owner {
            return Err(format!("{owner}.{name}: cross-owner index requires an explicit target-owner mapping"));
        }
        Ok(OracleDdlNameMapping {
            source_owner: owner.into(),
            source_name: name.into(),
            target_owner: target_owner.into(),
            target_name: name.into(),
        })
    }

    pub(super) fn render_table(
        &self,
        target_owner: &str,
        target_table: &str,
        table_mappings: &[SchemaDiffTableMapping],
        trigger_snapshots: &[TriggerInfo],
    ) -> Result<OracleTableDdlParts, String> {
        let source = self.table_ddl.as_deref().ok_or("Complete native table DDL is unavailable")?;
        let (source, triggers) = extract_oracle_table_triggers(source, &self.owner, &self.table)?;
        let mut index_mappings = Vec::new();
        for index in oracle_index_ddl_sources(&source, &self.owner)? {
            index_mappings.push(self.index_mapping(&index.owner, &index.name, target_owner)?);
        }
        for index in &self.supporting_indexes {
            index_mappings.push(self.index_mapping(&index.owner, &index.name, target_owner)?);
        }
        for index in &self.retained_supporting_indexes {
            index_mappings.push(self.index_mapping(&index.owner, &index.name, target_owner)?);
        }
        let table_mapping = self.table_mapping(target_owner, target_table);
        let mappings = table_mappings
            .iter()
            .map(|mapping| OracleDdlNameMapping {
                source_owner: self.owner.clone(),
                source_name: mapping.source_table.clone(),
                target_owner: target_owner.into(),
                target_name: mapping.target_table.clone(),
            })
            .collect::<Vec<_>>();
        let rebased = rebase_oracle_table_ddl(&source, &table_mapping, &mappings, &index_mappings)?;
        let supporting = self
            .supporting_indexes
            .iter()
            .map(|index| {
                Ok(OracleSupportingIndexDdl {
                    constraint_name: index.constraint_name.clone(),
                    owner: target_owner.into(),
                    name: index.name.clone(),
                    ddl: rebase_oracle_table_ddl(&index.ddl, &table_mapping, &mappings, &index_mappings)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut trigger_mappings = triggers
            .iter()
            .map(|trigger| {
                if trigger.owner != self.owner {
                    return Err(format!(
                        "{}.{}: cross-owner trigger requires an explicit mapping",
                        trigger.owner, trigger.name
                    ));
                }
                Ok(OracleDdlNameMapping {
                    source_owner: trigger.owner.clone(),
                    source_name: trigger.name.clone(),
                    target_owner: target_owner.into(),
                    target_name: trigger.name.clone(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        for trigger in trigger_snapshots {
            if !trigger_mappings.iter().any(|mapping| mapping.source_name == trigger.name) {
                trigger_mappings.push(OracleDdlNameMapping {
                    source_owner: self.owner.clone(),
                    source_name: trigger.name.clone(),
                    target_owner: target_owner.into(),
                    target_name: trigger.name.clone(),
                });
            }
        }
        let retained = self
            .retained_supporting_indexes
            .iter()
            .map(|index| OracleSupportingIndexIdentity {
                constraint_name: index.constraint_name.clone(),
                owner: target_owner.into(),
                name: index.name.clone(),
            })
            .collect::<Vec<_>>();
        let mut parts =
            split_oracle_table_ddl_with_retained(&rebased, target_owner, target_table, &supporting, &retained)?;
        for trigger in triggers {
            let mut source = trigger.ddl;
            for state in trigger.state_statements {
                source.push('\n');
                source.push_str(state.trim_end_matches(';'));
                source.push(';');
            }
            let mapped = rebase_oracle_trigger_ddl(&source, &table_mapping, &trigger_mappings)?;
            let (_, mapped) = extract_oracle_table_triggers(&mapped, target_owner, target_table)?;
            parts.triggers.extend(mapped);
        }
        Ok(parts)
    }

    pub(super) fn render_index(&self, name: &str, target_owner: &str, target_table: &str) -> Result<String, String> {
        let mut matches = self.indexes.iter().filter(|index| index.name == name);
        let index = matches.next().ok_or_else(|| format!("{name}: complete index definition is unavailable"))?;
        if matches.next().is_some() || index.table_owner != self.owner || index.table != self.table {
            return Err(format!("{name}: index definition has an ambiguous or mismatched identity"));
        }
        let mapping = self.index_mapping(&index.owner, &index.name, target_owner)?;
        let ddl =
            rebase_oracle_table_ddl(&index.ddl, &self.table_mapping(target_owner, target_table), &[], &[mapping])?;
        Ok(format!("{};", ddl.trim_end().trim_end_matches(';')))
    }

    pub(super) fn render_triggers(
        &self,
        mut raw: Vec<dbx_sql_core::object_source_sql::OracleTriggerDdlSource>,
        snapshots: &[TriggerInfo],
        target_owner: &str,
        target_table: &str,
    ) -> (Vec<String>, Vec<MissingRollbackObject>) {
        let mut issues = Vec::new();
        let mappings = raw
            .iter()
            .map(|trigger| trigger.name.clone())
            .chain(snapshots.iter().map(|trigger| trigger.name.clone()))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .map(|name| OracleDdlNameMapping {
                source_owner: self.owner.clone(),
                source_name: name.clone(),
                target_owner: target_owner.into(),
                target_name: name,
            })
            .collect::<Vec<_>>();
        for snapshot in snapshots {
            if snapshot.enabled.is_none() {
                issues.push(MissingRollbackObject {
                    kind: "trigger".into(),
                    name: snapshot.name.clone(),
                    table: Some(target_table.into()),
                    reason: "Trigger firing state is unavailable; compare again".into(),
                });
                continue;
            }
            let existing = raw.iter().find(|trigger| trigger.name == snapshot.name).cloned();
            let snapshot = snapshot.clone();
            if let Some(trigger) = &existing {
                match dbx_sql_core::object_source_sql::oracle_trigger_metadata_matches(
                    trigger,
                    &snapshot.event,
                    &snapshot.timing,
                    snapshot.level.as_deref(),
                    snapshot.condition.as_deref(),
                ) {
                    Ok(true) => {}
                    result => issues.push(MissingRollbackObject {
                        kind: "trigger".into(),
                        name: snapshot.name.clone(),
                        table: Some(target_table.into()),
                        reason: result.err().unwrap_or_else(|| {
                            "Trigger event, timing, level or condition changed since comparison".into()
                        }),
                    }),
                }
                let state = dbx_sql_core::object_source_sql::oracle_trigger_enabled(trigger);
                if let Err(reason) = state {
                    issues.push(MissingRollbackObject {
                        kind: "trigger".into(),
                        name: snapshot.name.clone(),
                        table: Some(target_table.into()),
                        reason,
                    });
                } else if snapshot.enabled.is_some_and(|enabled| Some(enabled) != state.ok()) {
                    issues.push(MissingRollbackObject {
                        kind: "trigger".into(),
                        name: snapshot.name.clone(),
                        table: Some(target_table.into()),
                        reason: "Trigger firing state changed since comparison".into(),
                    });
                }
                if snapshot.statement.as_deref().is_none_or(|statement| statement.trim().is_empty()) {
                    continue;
                }
            }
            let result: Result<Vec<dbx_sql_core::object_source_sql::OracleTriggerDdlSource>, String> = (|| {
                let source =
                    crate::table_structure_sql::oracle_snapshot_trigger_source(&self.owner, &self.table, &snapshot)?;
                let (_, original) = extract_oracle_table_triggers(&source, &self.owner, &self.table)?;
                if original.len() != 1 || original[0].owner != self.owner || original[0].name != snapshot.name {
                    return Err("Trigger snapshot identity does not match the selected object".into());
                }
                if !dbx_sql_core::object_source_sql::oracle_trigger_metadata_matches(
                    &original[0],
                    &snapshot.event,
                    &snapshot.timing,
                    snapshot.level.as_deref(),
                    snapshot.condition.as_deref(),
                )? {
                    return Err("Trigger source metadata conflicts with snapshot".into());
                }
                if Some(dbx_sql_core::object_source_sql::oracle_trigger_enabled(&original[0])?) != snapshot.enabled {
                    return Err("Trigger source firing state conflicts with snapshot".into());
                }
                let mapped =
                    rebase_oracle_trigger_ddl(&source, &self.table_mapping(target_owner, target_table), &mappings)?;
                let (_, triggers) = extract_oracle_table_triggers(&mapped, target_owner, target_table)?;
                Ok(triggers)
            })();
            match result {
                Ok(triggers) => {
                    if let Some(existing) = &existing {
                        match dbx_sql_core::object_source_sql::oracle_trigger_definitions_match(existing, &triggers[0])
                        {
                            Ok(true) => {}
                            result => issues.push(MissingRollbackObject {
                                kind: "trigger".into(),
                                name: snapshot.name.clone(),
                                table: Some(target_table.into()),
                                reason: result
                                    .err()
                                    .unwrap_or_else(|| "Trigger definition changed since comparison".into()),
                            }),
                        }
                    } else {
                        raw.extend(triggers);
                    }
                }
                Err(reason) => issues.push(MissingRollbackObject {
                    kind: "trigger".into(),
                    name: snapshot.name.clone(),
                    table: Some(target_table.into()),
                    reason,
                }),
            }
        }
        match dbx_sql_core::object_source_sql::order_oracle_trigger_sources(&raw) {
            Ok(triggers) => {
                let sql = triggers
                    .into_iter()
                    .flat_map(|trigger| {
                        std::iter::once(trigger.ddl).chain(
                            trigger
                                .state_statements
                                .into_iter()
                                .map(|state| format!("{};", state.trim_end_matches(';'))),
                        )
                    })
                    .collect();
                (sql, issues)
            }
            Err(reason) => {
                issues.push(MissingRollbackObject {
                    kind: "trigger".into(),
                    name: target_table.into(),
                    table: Some(target_table.into()),
                    reason,
                });
                (Vec::new(), issues)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn captured(name: &str, ddl: &str) -> OracleSchemaSyncTableDdl {
        OracleSchemaSyncTableDdl {
            diff_name: name.into(),
            owner: "APP".into(),
            table: name.into(),
            table_ddl: Some(ddl.into()),
            indexes: Vec::new(),
            supporting_indexes: Vec::new(),
            retained_supporting_indexes: Vec::new(),
            protected_drop_indexes: Vec::new(),
            issues: Vec::new(),
        }
    }

    fn plan(diffs: &[TableDiff], sources: Option<&OracleSchemaSyncDdlSources>, rollback: bool) -> SchemaSyncSqlPlan {
        generate_schema_sync_sql_plan_with_oracle_ddl(
            diffs,
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Oracle,
            Some("DEST"),
            false,
            Some(DialectKind::Oracle),
            &[],
            rollback,
            false,
            sources,
        )
    }

    #[test]
    fn independent_plan_maps_default_sequences_and_blocks_unknown_source_dependencies() {
        for rollback in [false, true] {
            for expression in ["SEQ.NEXTVAL", "PKG.VALUE()"] {
                let owner = if rollback { "DEST" } else { "APP" };
                let ddl = format!("CREATE TABLE {owner}.T(ID NUMBER DEFAULT {owner}.{expression});");
                let mut original = captured("T", &ddl);
                original.owner = owner.into();
                let diffs: Vec<TableDiff> = serde_json::from_value(json!([{"type":if rollback {"removed"} else {"added"},"name":"T","columns":[{"type":if rollback {"removed"} else {"added"},"name":"ID"}]}])).unwrap();
                let sources = if rollback {
                    OracleSchemaSyncDdlSources { rollback: vec![original], ..Default::default() }
                } else {
                    OracleSchemaSyncDdlSources { forward: vec![original], ..Default::default() }
                };
                let result = plan(&diffs, Some(&sources), rollback);
                let (sql, completeness) = if rollback {
                    (result.rollback_sync_sql.as_deref().unwrap(), &result.rollback_completeness)
                } else {
                    (result.sync_sql.as_str(), &result.forward_completeness)
                };
                if !rollback && expression == "PKG.VALUE()" {
                    assert_eq!(*completeness, RollbackCompleteness::Incomplete);
                    assert!(result
                        .generation_issues
                        .iter()
                        .any(|issue| issue.direction == "forward" && issue.reason.contains("DEFAULT dependency")));
                    assert!(!sql.is_empty());
                } else {
                    assert_eq!(*completeness, RollbackCompleteness::Complete, "{:?}", result.generation_issues);
                    let expected = if rollback { format!("DEST.{expression}") } else { "\"DEST\".SEQ.NEXTVAL".into() };
                    assert!(sql.contains(&expected), "{sql}");
                }
            }
        }
    }

    #[test]
    fn retained_inline_supporting_indexes_survive_forward_mapping_and_removed_rollback() {
        for rollback in [false, true] {
            let owner = if rollback { "DEST" } else { "APP" };
            let ddl = format!("CREATE TABLE {owner}.T(ID NUMBER, U NUMBER, CONSTRAINT PK_T PRIMARY KEY(ID) USING INDEX ENABLE); CREATE INDEX {owner}.IX_T ON {owner}.T(U); GRANT SELECT ON {owner}.T TO READER;");
            let mut original = captured("T", &ddl);
            original.owner = owner.into();
            original.retained_supporting_indexes.push(OracleSupportingIndexIdentity {
                constraint_name: "PK_T".into(),
                owner: owner.into(),
                name: "PK_T".into(),
            });
            let diffs: Vec<TableDiff> = serde_json::from_value(json!([{"type":if rollback {"removed"} else {"added"},"name":"T","columns":[{"type":if rollback {"removed"} else {"added"},"name":"ID"}]}])).unwrap();
            let sources = if rollback {
                OracleSchemaSyncDdlSources { rollback: vec![original], ..Default::default() }
            } else {
                OracleSchemaSyncDdlSources { forward: vec![original], ..Default::default() }
            };
            let result = plan(&diffs, Some(&sources), rollback);
            let (sql, completeness) = if rollback {
                (result.rollback_sync_sql.as_deref().unwrap(), &result.rollback_completeness)
            } else {
                (result.sync_sql.as_str(), &result.forward_completeness)
            };
            assert_eq!(*completeness, RollbackCompleteness::Complete, "{:?}", result.generation_issues);
            assert!(sql.contains("CONSTRAINT PK_T PRIMARY KEY(ID) USING INDEX ENABLE"), "{sql}");
            assert_eq!(sql.matches("CREATE INDEX").count(), 1, "{sql}");
            assert!(!sql.contains("ADD CONSTRAINT"), "{sql}");
            assert!(sql.contains("TO READER"), "{sql}");
            assert!(!sql.contains("APP."), "{sql}");
        }
    }

    #[test]
    fn complete_raw_trigger_checks_known_metadata_even_when_snapshot_body_is_missing() {
        for (event, condition, complete) in [
            ("INSERT", "NEW.ID > 0", true),
            ("DELETE", "NEW.ID > 0", false),
            ("INSERT", "NEW.ID > 1", false),
            ("INSERT", "", false),
        ] {
            let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([{"type":"added", "name":"T", "triggers":[
                {"type":"added", "name":"TR", "source":{"name":"TR", "event":event, "timing":"BEFORE EACH ROW", "condition":condition,"enabled":true}}
            ]}])).unwrap();
            let sources = OracleSchemaSyncDdlSources { forward: vec![captured("T", "CREATE TABLE APP.T(ID NUMBER); CREATE TRIGGER APP.TR BEFORE INSERT ON APP.T FOR EACH ROW WHEN (NEW.ID > 0) BEGIN NULL; END;")], ..Default::default() };
            let result = plan(&diffs, Some(&sources), false);
            assert_eq!(
                result.forward_completeness == RollbackCompleteness::Complete,
                complete,
                "{:?}",
                result.generation_issues
            );
            assert!(result.sync_sql.contains("WHEN (NEW.ID > 0) BEGIN NULL; END;"));
        }
    }

    #[test]
    fn raw_trigger_default_does_not_supply_an_unknown_snapshot_firing_state() {
        let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([{"type":"added","name":"T","triggers":[
            {"type":"added","name":"TR","source":{"name":"TR","event":"INSERT","timing":"BEFORE EACH ROW"}}
        ]}]))
        .unwrap();
        let sources = OracleSchemaSyncDdlSources { forward: vec![captured("T", "CREATE TABLE APP.T(ID NUMBER); CREATE TRIGGER APP.TR BEFORE INSERT ON APP.T FOR EACH ROW BEGIN NULL; END;")], ..Default::default() };
        let result = plan(&diffs, Some(&sources), false);
        assert_eq!(result.forward_completeness, RollbackCompleteness::Incomplete);
        assert!(result.generation_issues.iter().any(|issue| issue.reason.contains("firing state is unavailable")));
        assert!(result.sync_sql.contains("CREATE TRIGGER"));
    }

    #[test]
    fn trigger_dependency_can_be_supplied_by_a_complete_snapshot_only_definition() {
        let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([{"type":"added", "name":"T", "triggers":[
            {"type":"added", "name":"Z", "source":{"name":"Z", "timing":"BEFORE EACH ROW", "event":"INSERT", "enabled":true, "statement":"BEGIN NULL; END;"}}
        ]}])).unwrap();
        let sources = OracleSchemaSyncDdlSources { forward: vec![captured("T", "CREATE TABLE APP.T(ID NUMBER); CREATE TRIGGER APP.A BEFORE INSERT ON APP.T FOR EACH ROW FOLLOWS APP.Z BEGIN NULL; END;")], ..Default::default() };
        let result = plan(&diffs, Some(&sources), false);
        assert_eq!(result.forward_completeness, RollbackCompleteness::Complete, "{:?}", result.generation_issues);
        assert!(
            result.sync_sql.find("TRIGGER \"DEST\".\"Z\"").unwrap()
                < result.sync_sql.find("TRIGGER \"DEST\".A").unwrap()
        );
    }

    #[test]
    fn rollback_trigger_validation_uses_the_original_target_snapshot_and_preserves_forward_drop() {
        for (statement, complete) in [("BEGIN :NEW.ID := 7; END;", true), ("BEGIN :NEW.ID := 8; END;", false)] {
            let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([{"type":"removed", "name":"T", "columns":[{"type":"removed", "name":"ID"}], "targetDdl":"CREATE TABLE DEST.T(ID NUMBER);", "triggers":[
                {"type":"removed", "name":"TR", "target":{"name":"TR", "timing":"BEFORE EACH ROW", "event":"INSERT", "enabled":false, "statement":statement}}
            ]}])).unwrap();
            let mut original = captured("T", "CREATE TABLE DEST.T(ID NUMBER); CREATE TRIGGER DEST.TR BEFORE INSERT ON DEST.T FOR EACH ROW BEGIN :NEW.ID := 7; END; ALTER TRIGGER DEST.TR DISABLE;");
            original.owner = "DEST".into();
            let sources = OracleSchemaSyncDdlSources { rollback: vec![original], ..Default::default() };
            let result = plan(&diffs, Some(&sources), true);
            assert_eq!(result.forward_completeness, RollbackCompleteness::Complete);
            assert_eq!(
                result.rollback_completeness == RollbackCompleteness::Complete,
                complete,
                "{:?}",
                result.generation_issues
            );
            let rollback = result.rollback_sync_sql.unwrap();
            assert!(rollback.contains("BEGIN :NEW.ID := 7; END;"));
            assert_eq!(rollback.matches("CREATE TRIGGER").count(), 1);
            assert!(rollback.contains("ALTER TRIGGER DEST.TR DISABLE;"));
            assert!(result.sync_sql.contains("DROP TABLE"));
        }
    }

    #[test]
    fn raw_trigger_conflicts_preserve_preview_and_block_only_the_affected_direction() {
        for (event, statement, enabled, complete) in [
            ("INSERT", "BEGIN :NEW.ID := 1; END;", true, true),
            ("DELETE", "BEGIN :NEW.ID := 1; END;", true, false),
            ("INSERT", "BEGIN :NEW.ID := 2; END;", true, false),
            ("INSERT", "BEGIN :NEW.ID := 1; END;", false, false),
        ] {
            let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([{
                "type":"added", "name":"T", "triggers":[{"type":"added", "name":"TR", "source":{
                    "name":"TR", "timing":"BEFORE EACH ROW", "event":event, "enabled":enabled, "statement":statement
                }}]
            }]))
            .unwrap();
            let sources = OracleSchemaSyncDdlSources { forward: vec![captured("T", "CREATE TABLE APP.T(ID NUMBER); CREATE OR REPLACE TRIGGER APP.TR BEFORE INSERT ON APP.T REFERENCING NEW AS NEW OLD AS OLD FOR EACH ROW ENABLE BEGIN :NEW.ID := 1; END;")], ..Default::default() };
            let result = plan(&diffs, Some(&sources), true);
            assert_eq!(
                result.forward_completeness == RollbackCompleteness::Complete,
                complete,
                "{event} {statement}: {:?}",
                result.generation_issues
            );
            assert!(result.sync_sql.contains("BEGIN :NEW.ID := 1; END;"));
            assert_eq!(result.sync_sql.matches("TRIGGER \"DEST\".TR").count(), 1);
            assert!(!result.sync_sql.contains("OR REPLACE"));
            assert_eq!(result.rollback_completeness, RollbackCompleteness::Complete);
        }
    }

    #[test]
    fn snapshot_only_triggers_preserve_complete_sources_and_simple_body_metadata() {
        let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([{
            "type":"added", "name":"T", "targetName":"T2", "triggers":[
                {"type":"added", "name":"FULL", "source":{"name":"FULL", "timing":"BEFORE EACH ROW", "event":"INSERT OR UPDATE", "enabled":false,
                    "statement":"/* keep source */ CREATE OR REPLACE EDITIONABLE TRIGGER APP.FULL BEFORE INSERT OR UPDATE ON APP.T FOR EACH ROW WHEN (NEW.ID > 0) BEGIN NULL; END;"}},
                {"type":"added", "name":"SIMPLE", "source":{"name":"SIMPLE", "timing":"AFTER", "level":"ROW", "event":"INSERT OR DELETE", "enabled":true,
                    "statement":"BEGIN :NEW.ID := 2; END;"}}
            ]
        }])).unwrap();
        let sources = OracleSchemaSyncDdlSources {
            forward: vec![captured("T", "CREATE TABLE APP.T(ID NUMBER);")],
            ..Default::default()
        };
        let result = plan(&diffs, Some(&sources), false);
        assert_eq!(result.forward_completeness, RollbackCompleteness::Complete, "{:?}", result.generation_issues);
        assert_eq!(result.sync_sql.matches("TRIGGER").count(), 3);
        assert!(result
            .sync_sql
            .contains("BEFORE INSERT OR UPDATE ON \"DEST\".\"T2\" FOR EACH ROW WHEN (NEW.ID > 0) BEGIN NULL; END;"));
        assert!(result.sync_sql.contains("AFTER INSERT OR DELETE ON \"DEST\".\"T2\"\nFOR EACH ROW"));
        assert!(result.sync_sql.contains("ALTER TRIGGER \"DEST\".\"FULL\" DISABLE;"));
        assert!(!result.sync_sql.contains("BEGIN TRIGGER"));
    }

    #[test]
    fn independent_plan_maps_and_deduplicates_raw_triggers_after_foreign_keys() {
        let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([
            {"type":"added", "name":"T", "targetName":"T2", "triggers":[
                {"type":"added", "name":"A", "source":{"name":"A", "timing":"BEFORE EACH ROW", "event":"INSERT", "enabled":false}},
                {"type":"added", "name":"MISSING", "source":{"name":"MISSING", "timing":"BEFORE EACH ROW", "event":"INSERT", "enabled":true}}
            ]}
        ])).unwrap();
        let source = captured("T", "CREATE TABLE APP.T(ID NUMBER, CONSTRAINT FK FOREIGN KEY(ID) REFERENCES APP.T(ID));\nCREATE TRIGGER APP.A BEFORE INSERT ON APP.T FOR EACH ROW FOLLOWS APP.Z BEGIN :NEW.ID := 1; END;\nALTER TRIGGER APP.A DISABLE;\nCREATE TRIGGER APP.Z BEFORE INSERT ON APP.T FOR EACH ROW BEGIN EXECUTE IMMEDIATE q'[UPDATE APP.T SET ID=2]'; END;");
        let sources = OracleSchemaSyncDdlSources { forward: vec![source], ..Default::default() };
        let result = plan(&diffs, Some(&sources), false);
        assert_eq!(result.sync_sql.matches("CREATE TRIGGER").count(), 2);
        assert!(result.sync_sql.contains("TRIGGER \"DEST\".A BEFORE INSERT ON \"DEST\".\"T2\""));
        assert!(result.sync_sql.contains("FOLLOWS \"DEST\".Z"));
        assert!(result.sync_sql.contains("q'[UPDATE APP.T SET ID=2]'"));
        assert!(result.sync_sql.contains("ALTER TRIGGER \"DEST\".A DISABLE;"));
        assert!(result.sync_sql.find("ADD CONSTRAINT FK").unwrap() < result.sync_sql.find("CREATE TRIGGER").unwrap());
        assert!(
            result.sync_sql.find("TRIGGER \"DEST\".Z BEFORE").unwrap()
                < result.sync_sql.find("TRIGGER \"DEST\".A BEFORE").unwrap()
        );
        assert!(result.generation_issues.iter().any(|issue| issue.name == "MISSING"));
        assert!(!result.generation_issues.iter().any(|issue| issue.name == "A"));
    }

    #[test]
    fn mismatched_grant_marks_only_its_direction_incomplete_and_preserves_other_preview() {
        let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([
            {"type":"added", "name":"T"}, {"type":"added", "name":"OTHER"}
        ]))
        .unwrap();
        let sources = OracleSchemaSyncDdlSources {
            forward: vec![
                captured("T", "CREATE TABLE APP.T(ID NUMBER); GRANT SELECT ON APP.UNKNOWN TO APP;"),
                captured("OTHER", "CREATE TABLE APP.OTHER(ID NUMBER);"),
            ],
            ..Default::default()
        };
        let result = plan(&diffs, Some(&sources), true);
        assert_ne!(result.forward_completeness, RollbackCompleteness::Complete);
        assert!(result.generation_issues.iter().any(|issue| issue.reason.contains("Grant DDL")));
        assert!(
            result.sync_sql.contains("CREATE TABLE \"DEST\".OTHER"),
            "{} {:?}",
            result.sync_sql,
            result.generation_issues
        );
        assert!(!result.sync_sql.contains("GRANT SELECT ON APP.UNKNOWN"));
    }

    #[test]
    fn native_post_table_constraints_preserve_forward_and_rollback_dependency_order() {
        for rollback in [false, true] {
            let owner = if rollback { "DEST" } else { "APP" };
            let kind = if rollback { "removed" } else { "added" };
            let diffs: Vec<TableDiff> = serde_json::from_value(json!([
                {"type":kind, "name":"CHILD", "columns":[{"type":kind,"name":"ID"}]},
                {"type":kind, "name":"PARENT", "columns":[{"type":kind,"name":"ID"}]}
            ]))
            .unwrap();
            let mut child = captured("CHILD", &format!("CREATE TABLE {owner}.CHILD(ID NUMBER DEFAULT q'[a  b]')\nALTER TABLE {owner}.CHILD ADD CONSTRAINT FK_CHILD FOREIGN KEY(ID) REFERENCES {owner}.PARENT(ID) ENABLE;"));
            let mut parent = captured("PARENT", &format!("CREATE TABLE {owner}.PARENT(ID NUMBER)\nCREATE INDEX {owner}.IX_PARENT ON {owner}.PARENT(ID)\nALTER TABLE {owner}.PARENT ADD CONSTRAINT PK_PARENT PRIMARY KEY(ID) USING INDEX {owner}.IX_PARENT ENABLE;"));
            child.owner = owner.into();
            parent.owner = owner.into();
            parent.supporting_indexes.push(OracleSupportingIndexDdl {
                constraint_name: "PK_PARENT".into(),
                owner: owner.into(),
                name: "IX_PARENT".into(),
                ddl: format!("CREATE INDEX {owner}.IX_PARENT ON {owner}.PARENT(ID)"),
            });
            let sources = if rollback {
                OracleSchemaSyncDdlSources { rollback: vec![child, parent], ..Default::default() }
            } else {
                OracleSchemaSyncDdlSources { forward: vec![child, parent], ..Default::default() }
            };
            let result = plan(&diffs, Some(&sources), rollback);
            let (sql, completeness) = if rollback {
                (result.rollback_sync_sql.as_deref().unwrap(), &result.rollback_completeness)
            } else {
                (result.sync_sql.as_str(), &result.forward_completeness)
            };
            assert_eq!(*completeness, RollbackCompleteness::Complete, "{:?}", result.generation_issues);
            assert_eq!(sql.matches("CREATE TABLE").count(), 2, "{sql}");
            assert_eq!(sql.matches("CREATE INDEX").count(), 1, "{sql}");
            assert!(!sql.contains("CREATE UNIQUE INDEX"));
            assert!(
                sql.find("ADD CONSTRAINT PK_PARENT").unwrap() < sql.find("ADD CONSTRAINT FK_CHILD").unwrap(),
                "{sql}"
            );
            assert!(sql.contains("q'[a  b]'"));
        }
    }

    #[test]
    fn independent_plan_defers_cross_table_foreign_keys_until_all_tables_and_indexes_exist() {
        let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([
            {"type":"added", "name":"CHILD", "targetName":"CHILD2"}, {"type":"added", "name":"PARENT"}
        ]))
        .unwrap();
        let child = captured("CHILD", "CREATE TABLE APP.CHILD(ID NUMBER, CONSTRAINT FK FOREIGN KEY(ID) REFERENCES APP.PARENT(ID)); CREATE INDEX APP.IX_CHILD ON APP.CHILD(ID DESC) INVISIBLE; GRANT SELECT ON APP.CHILD TO APP WITH GRANT OPTION;");
        let mut parent = captured("PARENT", "CREATE TABLE APP.PARENT(ID NUMBER, CONSTRAINT PK PRIMARY KEY(ID));");
        parent.supporting_indexes.push(OracleSupportingIndexDdl {
            constraint_name: "PK".into(),
            owner: "APP".into(),
            name: "IX_PARENT".into(),
            ddl: "CREATE INDEX APP.IX_PARENT ON APP.PARENT(ID);".into(),
        });
        let sources = OracleSchemaSyncDdlSources { forward: vec![child, parent], ..Default::default() };
        let result = plan(&diffs, Some(&sources), false);
        assert_eq!(result.forward_completeness, RollbackCompleteness::Complete);
        let sql = result.sync_sql;
        let fk = sql.find("ADD CONSTRAINT FK").unwrap();
        assert!(sql.find("CREATE TABLE \"DEST\".PARENT").unwrap() < fk);
        assert!(sql.find("CREATE INDEX \"DEST\".IX_PARENT").unwrap() < fk);
        assert!(sql.find("ADD CONSTRAINT PK").unwrap() < fk);
        assert!(sql.contains("CREATE INDEX \"DEST\".IX_CHILD ON \"DEST\".\"CHILD2\"(ID DESC) INVISIBLE"));
        assert_eq!(sql.matches("CREATE INDEX").count(), 2);
        assert!(sql.contains("GRANT SELECT ON \"DEST\".\"CHILD2\" TO APP WITH GRANT OPTION"));
    }

    #[test]
    fn removed_table_rollback_prefers_captured_target_even_with_structured_columns() {
        let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([{"type":"removed", "objectType":"table", "name":"T", "columns":[{"type":"removed", "name":"ID"}], "targetDdl":"CREATE TABLE DEST.T(ID NUMBER);"}])).unwrap();
        let mut original = captured(
            "T",
            "CREATE TABLE DEST.T(ID NUMBER DEFAULT 42) PCTFREE 7; CREATE INDEX DEST.IX_T ON DEST.T(ID DESC) INVISIBLE; GRANT UPDATE (ID) ON DEST.T TO APP;",
        );
        original.owner = "DEST".into();
        let sources = OracleSchemaSyncDdlSources { rollback: vec![original], ..Default::default() };
        let result = plan(&diffs, Some(&sources), true);
        assert_eq!(result.rollback_completeness, RollbackCompleteness::Complete);
        let sql = result.rollback_sync_sql.unwrap();
        assert!(sql.contains("DEFAULT 42) PCTFREE 7"));
        assert!(sql.contains("CREATE INDEX DEST.IX_T ON DEST.T(ID DESC) INVISIBLE"));
        assert_eq!(sql.matches("CREATE TABLE").count(), 1);
        assert!(sql.contains("GRANT UPDATE (ID) ON DEST.T TO APP"));
    }

    #[test]
    fn removed_only_index_checks_protection_without_creating_or_rebuilding_the_table() {
        let diffs = serde_json::from_value::<Vec<TableDiff>>(
            json!([{"type":"modified", "name":"T", "indexes":[{"type":"removed", "name":"IX_T"}]}]),
        )
        .unwrap();
        let mut target = captured("T", "");
        target.table_ddl = None;
        target.protected_drop_indexes.push("IX_T".into());
        let mut sources = OracleSchemaSyncDdlSources { forward: vec![target], ..Default::default() };
        let blocked = plan(&diffs, Some(&sources), false);
        assert_eq!(blocked.forward_completeness, RollbackCompleteness::Incomplete);
        assert_eq!(blocked.generation_issues[0].direction, "forward");
        assert!(!blocked.sync_sql.contains("DROP INDEX"));
        assert!(!blocked.sync_sql.contains("CREATE TABLE"));
        sources.forward[0].protected_drop_indexes.clear();
        let allowed = plan(&diffs, Some(&sources), false);
        assert_eq!(allowed.forward_completeness, RollbackCompleteness::Complete);
        assert!(allowed.sync_sql.contains("DROP INDEX"));
        let default = plan(&diffs, None, false);
        assert_eq!(default.sync_sql, allowed.sync_sql);
        assert!(default.generation_issues.is_empty());
    }

    #[test]
    fn single_index_render_preserves_expression_direction_and_visibility() {
        let mut source = captured("T", "");
        source.indexes =
            oracle_index_ddl_sources("CREATE INDEX APP.IX ON APP.T(LOWER(VALUE) DESC) INVISIBLE LOCAL;", "APP")
                .unwrap();
        let sql = source.render_index("IX", "DEST", "T2").unwrap();
        assert_eq!(sql, "CREATE INDEX \"DEST\".IX ON \"DEST\".\"T2\"(LOWER(VALUE) DESC) INVISIBLE LOCAL;");
        assert!(!sql.contains("CREATE TABLE"));
        assert!(source.render_index("MISSING", "DEST", "T2").is_err());
    }

    #[test]
    fn modified_index_uses_directional_full_definitions_without_recreating_constraints() {
        let info = json!({"name":"IX", "columns":["VALUE"], "is_unique":false, "is_primary":false});
        let diffs = serde_json::from_value::<Vec<TableDiff>>(json!([{"type":"modified", "name":"T", "targetName":"T2", "indexes":[{"type":"modified", "name":"IX", "source":info, "target":info}]}])).unwrap();
        let mut forward = captured("T", "");
        forward.table_ddl = None;
        forward.indexes =
            oracle_index_ddl_sources("CREATE INDEX APP.IX ON APP.T(LOWER(VALUE) DESC) INVISIBLE;", "APP").unwrap();
        let mut rollback = captured("T", "");
        rollback.owner = "DEST".into();
        rollback.table = "T2".into();
        rollback.table_ddl = None;
        rollback.indexes =
            oracle_index_ddl_sources("CREATE INDEX DEST.IX ON DEST.T2(UPPER(VALUE)) VISIBLE;", "DEST").unwrap();
        let mut sources =
            OracleSchemaSyncDdlSources { forward: vec![forward], rollback: vec![rollback], ..Default::default() };
        let result = plan(&diffs, Some(&sources), true);
        assert_eq!(result.forward_completeness, RollbackCompleteness::Complete);
        assert_eq!(result.rollback_completeness, RollbackCompleteness::Complete);
        let forward = result.sync_sql;
        let rollback = result.rollback_sync_sql.unwrap();
        assert!(forward.contains("LOWER(VALUE) DESC) INVISIBLE"));
        assert!(!forward.contains("UPPER(VALUE)"));
        assert!(rollback.contains("UPPER(VALUE)) VISIBLE"));
        assert!(!rollback.contains("LOWER(VALUE)"));
        for sql in [&forward, &rollback] {
            assert!(sql.find("DROP INDEX").unwrap() < sql.find("CREATE INDEX").unwrap());
            assert!(!sql.contains("CREATE TABLE"));
            assert!(!sql.contains("ADD CONSTRAINT"));
        }
        sources.rollback[0].protected_drop_indexes.push("IX".into());
        let blocked = plan(&diffs, Some(&sources), true);
        assert_eq!(blocked.forward_completeness, RollbackCompleteness::Complete);
        assert_eq!(blocked.rollback_completeness, RollbackCompleteness::Incomplete);
        assert_eq!(blocked.generation_issues[0].direction, "rollback");
    }
}
