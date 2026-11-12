use super::super::super::references::{CatalogReadProof, PlannedRelation};
use super::*;
use crate::data::transfer::{TransferObjectOutcome, TransferProgress, TransferStatus};

pub(crate) enum PackageTransfer<'a> {
    Approved(ApprovedPackageTransfer<'a>),
    AwaitingTables(Box<PendingClaim>),
}

pub(crate) struct PendingClaim {
    pub(super) preview: OraclePackageTransferPreview,
}

impl PackageTransfer<'_> {
    pub(crate) async fn run<F>(
        &self,
        state: &AppState,
        request: &TransferRequest,
        prerequisites_succeeded: bool,
        mut progress: F,
    ) -> (TransferObjectOutcome, bool, Option<String>)
    where
        F: FnMut(TransferProgress),
    {
        match self {
            Self::Approved(approved) => {
                let (outcome, cancelled) = approved.run(state, request, prerequisites_succeeded, progress).await;
                (outcome, cancelled, None)
            }
            Self::AwaitingTables(pending) => {
                let outcome = TransferObjectOutcome {
                    skipped: pending
                        .preview
                        .skipped
                        .iter()
                        .map(|identity| {
                            format!(
                                "{}:{}",
                                if identity.kind == db::ObjectSourceKind::Package { "Package" } else { "PackageBody" },
                                identity.name
                            )
                        })
                        .collect(),
                    ..Default::default()
                };
                if !prerequisites_succeeded {
                    return (outcome, false, None);
                }
                if crate::data::transfer::is_cancelled(&request.transfer_id).await {
                    return (outcome, true, None);
                }
                match pending.approve(state, request).await {
                    Ok((approved, preview)) => {
                        // approve() pins the whole batch before returning or emitting IDs.
                        progress(TransferProgress {
                            oracle_package_approval: Some(preview),
                            oracle_package_preflight: None,
                            oracle_routine_operation: None,
                            transfer_id: request.transfer_id.clone(),
                            table: "package objects".into(),
                            table_index: request.tables.len(),
                            total_tables: request.tables.len(),
                            rows_transferred: 0,
                            total_rows: None,
                            status: TransferStatus::Running,
                            error: None,
                            terminal: false,
                        });
                        let (outcome, cancelled) = approved.run(state, request, true, progress).await;
                        (outcome, cancelled, None)
                    }
                    Err(error) => {
                        if crate::data::transfer::is_cancelled(&request.transfer_id).await {
                            return (outcome, true, None);
                        }
                        let message = error.message.clone();
                        let mut event = error.into_progress(request);
                        event.terminal = false;
                        event.table_index = request.tables.len();
                        progress(event);
                        (outcome, false, Some(message))
                    }
                }
            }
        }
    }
}

impl PendingClaim {
    fn failure(&self, message: String) -> PackageTransferPreflightError {
        let mut preview = self.preview.clone();
        preview.plan.ready = false;
        for step in &mut preview.plan.steps {
            step.issues.push(dbx_sql::object_source_sql::OracleDraftIssue {
                code: "pending-table-readback".into(),
                message: message.clone(),
                line: 1,
                column: 1,
            });
        }
        PackageTransferPreflightError { message, preview: Some(Box::new(preview)) }
    }

    async fn approve<'a>(
        &self,
        state: &'a AppState,
        request: &TransferRequest,
    ) -> Result<(ApprovedPackageTransfer<'a>, OraclePackageTransferPreview), PackageTransferPreflightError> {
        let frozen =
            self.preview.pending_tables.as_ref().ok_or("The original pending table confirmation is unavailable")?;
        let input = &self.preview.input;
        let config =
            plan::checked_endpoint(state, &input.target.endpoint).await.map_err(|error| self.failure(error))?;
        let catalog = LiveCatalog { state, endpoint: &input.target.endpoint, config: &config };
        let mut proofs = Vec::new();
        let mut tables = Vec::new();
        for (index, table) in frozen.tables.iter().enumerate() {
            let type_proofs = external_types::read(&catalog, &input.target.endpoint, table)
                .await
                .map_err(|error| self.failure(error))?;
            if frozen.table_evidence.get(index).and_then(|value| value.get("externalTypeProofs"))
                != Some(&external_types::manifest(&type_proofs))
            {
                return Err(self.failure("External table-column type identity, shape or direct privileges changed; retain completed tables and refresh the package drafts".into()));
            }
            proofs.extend(type_proofs);
            proofs.extend(
                read_completed_table(&catalog, &input.target.endpoint, table)
                    .await
                    .map_err(|error| self.failure(error))?,
            );
            tables.push(PlannedRelation {
                owner: table.owner().into(),
                name: table.name().into(),
                columns: table.columns(),
            });
        }
        if crate::data::transfer::is_cancelled(&request.transfer_id).await {
            return Err(self.failure("Cancelled before package approval; no package statement was dispatched".into()));
        }
        let (plan, pins) = plan::prepare_completed_transfer(
            state,
            &request.transfer_id,
            input,
            &tables,
            &frozen.dependency_manifest,
            proofs,
        )
        .await
        .map_err(|error| self.failure(error))?;
        let preview = OraclePackageTransferPreview {
            input: input.clone(),
            plan,
            skipped: self.preview.skipped.clone(),
            pending_tables: None,
        };
        if !preview.plan.ready {
            return Err(PackageTransferPreflightError { message: "The completed table stage did not satisfy the original package preflight; retain completed tables and correct the drafts".into(), preview: Some(Box::new(preview)) });
        }
        let ids = preview
            .plan
            .steps
            .iter()
            .filter_map(|step| step.operation.as_ref().map(|operation| operation.operation_id.clone()))
            .collect::<Vec<_>>();
        let mut approved =
            claim_approvals(&state.routine_operations, input, &ids).map_err(|error| self.failure(error))?;
        approved.skipped = preview.skipped.clone();
        drop(pins);
        Ok((approved, preview))
    }
}

pub(super) async fn observed(
    catalog: &impl RoutineCatalog,
    sql: String,
    proofs: &mut Vec<CatalogReadProof>,
) -> Result<CatalogReply, String> {
    let reply = catalog.query(&sql).await?;
    reply.flags.check()?;
    proofs.push(CatalogReadProof::Query { sql, columns: reply.columns.clone(), rows: reply.rows.clone() });
    Ok(reply)
}

async fn read_completed_table(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    table: &FrozenTableDdl,
) -> Result<Vec<CatalogReadProof>, String> {
    use crate::data::transfer::oracle_table_contract::CatalogTableColumn;
    let mut proofs = Vec::new();
    let login = observed(catalog, "SELECT USER AS LOGIN_OWNER FROM DUAL".into(), &mut proofs).await?;
    if login.rows.len() != 1 {
        return Err("The completed table owner visibility is unknown".into());
    }
    let view =
        if login.text(&login.rows[0], "LOGIN_OWNER")? == endpoint.schema { "ALL_OBJECTS" } else { "SYS.DBA_OBJECTS" };
    let namespace_sql = format!("SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, STATUS, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD\"T\"HH24:MI:SS') LAST_DDL_TIME FROM {view} WHERE OWNER = {} AND OBJECT_NAME = {} AND OBJECT_TYPE IN ('TABLE','VIEW','SEQUENCE','PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','MATERIALIZED VIEW','TYPE','SYNONYM') ORDER BY OBJECT_ID", literal(table.owner()), literal(table.name()));
    let before = observed(catalog, namespace_sql.clone(), &mut proofs).await?;
    if before.rows.len() != 1 {
        return Err("The completed table namespace is missing or ambiguous".into());
    }
    let row = &before.rows[0];
    if before.text(row, "OWNER")? != table.owner()
        || before.text(row, "OBJECT_NAME")? != table.name()
        || before.text(row, "OBJECT_TYPE")? != "TABLE"
        || before.text(row, "STATUS")? != "VALID"
    {
        return Err("The completed dependency is not the exact VALID target table".into());
    }
    before.integer(row, "OBJECT_ID")?;
    before.text(row, "LAST_DDL_TIME")?;
    let mut columns = Vec::new();
    loop {
        let offset = columns.len();
        let sql = format!("SELECT * FROM (SELECT OWNER, TABLE_NAME, COLUMN_ID, COLUMN_NAME, DATA_TYPE, DATA_TYPE_OWNER, DATA_LENGTH, CHAR_LENGTH, CHAR_USED, DATA_PRECISION, DATA_SCALE, ROW_NUMBER() OVER (ORDER BY COLUMN_ID, COLUMN_NAME) RN FROM ALL_TAB_COLUMNS WHERE OWNER = {} AND TABLE_NAME = {}) WHERE RN > {offset} AND RN <= {} ORDER BY RN", literal(table.owner()), literal(table.name()), offset + PAGE_SIZE);
        let reply = observed(catalog, sql, &mut proofs).await?;
        if reply.rows.len() > PAGE_SIZE {
            return Err("Completed table columns exceeded the verified page size".into());
        }
        for row in &reply.rows {
            if reply.integer(row, "RN")? != columns.len() as u64 + 1
                || reply.text(row, "OWNER")? != table.owner()
                || reply.text(row, "TABLE_NAME")? != table.name()
            {
                return Err("Completed table column pagination or identity is incomplete".into());
            }
            let optional_text = |name: &str| -> Result<Option<String>, String> {
                match reply.cell(row, name)? {
                    Value::Null => Ok(None),
                    _ => reply.text(row, name).map(Some),
                }
            };
            let precision = optional_text("DATA_PRECISION")?
                .map(|value| value.parse::<u64>().map_err(|_| "The catalog precision is invalid"))
                .transpose()?;
            let scale = optional_text("DATA_SCALE")?
                .map(|value| value.parse::<i64>().map_err(|_| "The catalog scale is invalid"))
                .transpose()?;
            columns.push(CatalogTableColumn {
                id: reply.integer(row, "COLUMN_ID")?,
                name: reply.text(row, "COLUMN_NAME")?,
                data_type: reply.text(row, "DATA_TYPE")?,
                data_type_owner: optional_text("DATA_TYPE_OWNER")?,
                data_length: reply.integer(row, "DATA_LENGTH")?,
                char_length: reply.integer(row, "CHAR_LENGTH")?,
                char_used: optional_text("CHAR_USED")?,
                precision,
                scale,
            });
        }
        if reply.rows.len() < PAGE_SIZE {
            break;
        }
    }
    table.verify_catalog_columns(&columns)?;
    let after = observed(catalog, namespace_sql, &mut proofs).await?;
    if before.columns != after.columns || before.rows != after.rows {
        return Err("The table changed while its complete typed structure was read".into());
    }
    Ok(proofs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Catalog {
        replies: std::sync::Mutex<std::collections::VecDeque<(&'static str, Value)>>,
    }
    #[async_trait::async_trait]
    impl RoutineCatalog for Catalog {
        async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
            let (expected, reply) = self.replies.lock().unwrap().pop_front().expect("Unexpected metadata read");
            assert!(sql.contains(expected), "{sql}");
            serde_json::from_value(reply).map_err(|error| error.to_string())
        }
        async fn source(&self, _: &RoutineIdentity) -> Result<SourceReply, String> {
            panic!("No package invocation/source probe is needed for typed table readback")
        }
    }

    fn fixture() -> (Catalog, RoutineEndpoint, FrozenTableDdl) {
        let namespace = json!({"columns":["OWNER","OBJECT_NAME","OBJECT_TYPE","OBJECT_ID","STATUS","LAST_DDL_TIME"],
            "rows":[["T","FINAL","TABLE",99,"VALID","2026-10-23T00:00:00"]]});
        let columns = json!({"columns":["OWNER","TABLE_NAME","COLUMN_ID","COLUMN_NAME","DATA_TYPE","DATA_TYPE_OWNER","DATA_LENGTH","CHAR_LENGTH","CHAR_USED","DATA_PRECISION","DATA_SCALE","RN"],
            "rows":[["T","FINAL",16,"V","VARCHAR2",null,80,20,"C",null,null,1],
                ["T","FINAL",17,"N","NUMBER",null,22,0,null,12,3,2]]});
        let catalog = Catalog {
            replies: std::sync::Mutex::new(std::collections::VecDeque::from([
                ("LOGIN_OWNER", json!({"columns":["LOGIN_OWNER"],"rows":[["T"]]})),
                ("FROM ALL_OBJECTS", namespace.clone()),
                ("FROM ALL_TAB_COLUMNS", columns),
                ("FROM ALL_OBJECTS", namespace),
            ])),
        };
        let endpoint = RoutineEndpoint {
            connection_id: "T".into(),
            database: "tenant".into(),
            schema: "T".into(),
            database_type: DatabaseType::OceanbaseOracle,
            generation: 1,
        };
        let table = FrozenTableDdl::from_server_plan(
            "SOURCE",
            "T",
            "FINAL",
            "CREATE TABLE FINAL(V VARCHAR2(20 CHAR), N NUMBER(12,3))",
            json!({}),
            None,
        )
        .unwrap();
        (catalog, endpoint, table)
    }

    #[tokio::test]
    async fn completed_table_retains_real_typed_proofs_with_nonconsecutive_origin_ids() {
        let (catalog, endpoint, table) = fixture();
        let proofs = read_completed_table(&catalog, &endpoint, &table).await.unwrap();
        assert_eq!(proofs.len(), 4);
        assert!(catalog.replies.lock().unwrap().is_empty());
        assert!(proofs.iter().any(|proof| matches!(proof, CatalogReadProof::Query { sql, rows, .. }
            if sql.contains("DATA_PRECISION") && rows.len() == 2)));
    }

    #[tokio::test]
    async fn completed_table_rejects_partial_wrong_changed_and_incompatible_directory_facts() {
        for case in [
            "truncated",
            "wrong-owner",
            "wrong-kind",
            "missing-column",
            "extra-column",
            "type",
            "unit",
            "order",
            "page",
            "concurrent",
        ] {
            let (catalog, endpoint, table) = fixture();
            {
                let mut replies = catalog.replies.lock().unwrap();
                match case {
                    "truncated" => replies[2].1["truncated"] = json!(true),
                    "wrong-owner" => replies[2].1["rows"][0][0] = json!("OTHER"),
                    "wrong-kind" => replies[1].1["rows"][0][2] = json!("VIEW"),
                    "missing-column" => {
                        replies[2].1["rows"].as_array_mut().unwrap().pop();
                    }
                    "extra-column" => {
                        replies[2].1["rows"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!(["T", "FINAL", 18, "EXTRA", "NUMBER", null, 22, 0, null, null, null, 3]));
                    }
                    "type" => replies[2].1["rows"][1][10] = json!(2),
                    "unit" => replies[2].1["rows"][0][8] = json!("B"),
                    "order" => replies[2].1["rows"][1][2] = json!(16),
                    "page" => replies[2].1["rows"][1][11] = json!(3),
                    _ => replies[3].1["rows"][0][3] = json!(100),
                }
            }
            assert!(read_completed_table(&catalog, &endpoint, &table).await.is_err(), "{case}");
        }
    }
}
