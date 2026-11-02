use super::*;
use crate::data::transfer::{oracle_object_source_query, rewrite_oracle_schema_qualifier, TransferObjectKind};
use dbx_sql::object_source_sql::{prepare_oracle_routine_definition, OracleRoutineDefinitionInput};

mod packages;
pub(crate) use packages::{claim_transfer_packages, prepare_transfer_packages, PackageTransferPreflightError};
pub use packages::{OraclePackageTransferPreview, OraclePackageTransferRequest};

pub(crate) struct RoutineTransferInput {
    pub source_connection_id: String,
    pub source_database: String,
    pub identity: RoutineIdentity,
    pub target_connection_id: String,
    pub target_database: String,
    pub target_owner: String,
}

pub(crate) struct RoutineTransferContext {
    source_config: ConnectionConfig,
    target_config: ConnectionConfig,
    source_generation: u64,
    target_generation: u64,
}

pub(crate) async fn capture_routine_transfer_context(
    state: &AppState,
    source_id: &str,
    target_id: &str,
) -> Result<Option<RoutineTransferContext>, String> {
    let source_generation = state.connection_lifecycle_snapshot(source_id).generation();
    let target_generation = state.connection_lifecycle_snapshot(target_id).generation();
    let configs = state.configs.read().await;
    let source_config = configs.get(source_id).ok_or("Source connection not found")?.clone();
    let target_config = configs.get(target_id).ok_or("Target connection not found")?.clone();
    if routine_source_origin(&source_config).is_err() || routine_source_origin(&target_config).is_err() {
        return Ok(None);
    }
    Ok(Some(RoutineTransferContext { source_config, target_config, source_generation, target_generation }))
}

/// Keep the transfer's existing GET_DDL and schema adaptation contracts. The
/// length proof is for that CLOB, not for the different ordinary-source getter.
async fn transfer_definition(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    identity: &RoutineIdentity,
) -> Result<String, String> {
    let kind = match identity.kind {
        db::ObjectSourceKind::Function => TransferObjectKind::Function,
        db::ObjectSourceKind::Procedure => TransferObjectKind::Procedure,
        _ => return Err("Routine transfer requires a standalone function or procedure".into()),
    };
    let before = readback::exact_version(&readback::read_namespace(catalog, identity, false).await?, identity)?;
    let original_query = oracle_object_source_query(&kind, &identity.owner, &identity.name)?;
    let query = format!("WITH ROUTINE_DEFINITION(SOURCE_DDL) AS ({original_query}) SELECT SOURCE_DDL, LENGTH(SOURCE_DDL) SOURCE_CHARS FROM ROUTINE_DEFINITION");
    let read = |reply: CatalogReply| -> Result<String, String> {
        reply.flags.check()?;
        if reply.rows.len() != 1 {
            return Err("Routine transfer source is not a unique complete definition".into());
        }
        let source = reply.text(&reply.rows[0], "SOURCE_DDL")?;
        let length = reply.integer(&reply.rows[0], "SOURCE_CHARS")?;
        let actual = if endpoint.database_type == DatabaseType::OceanbaseOracle {
            source.chars().count()
        } else {
            source.encode_utf16().count()
        };
        if actual as u64 != length {
            return Err("Routine GET_DDL CLOB is incomplete; transfer has not been dispatched".into());
        }
        validate_oracle_executable_object_source(OracleObjectSourceValidationInput {
            database_type: endpoint.database_type,
            object_type: identity.kind.clone(),
            schema: Some(identity.owner.clone()),
            name: identity.name.clone(),
            source: source.clone(),
        })?;
        Ok(source)
    };
    let source = read(catalog.query(&query).await?)?;
    let second = read(catalog.query(&query).await?)?;
    let after = readback::exact_version(&readback::read_namespace(catalog, identity, false).await?, identity)?;
    if source != second || before != after {
        return Err("Routine transfer source changed during its read; refresh before continuing".into());
    }
    Ok(source)
}

pub(crate) async fn transfer_oracle_routine_core(
    state: &AppState,
    context: &RoutineTransferContext,
    input: RoutineTransferInput,
) -> Result<RoutineOperationRecord, String> {
    let (source_type, _) = routine_source_origin(&context.source_config)?;
    let (target_type, _) = routine_source_origin(&context.target_config)?;
    let source_endpoint = RoutineEndpoint {
        connection_id: input.source_connection_id,
        database: input.source_database,
        schema: input.identity.owner.clone(),
        database_type: source_type,
        generation: context.source_generation,
    };
    let target_endpoint = RoutineEndpoint {
        connection_id: input.target_connection_id.clone(),
        database: input.target_database.clone(),
        schema: input.target_owner.clone(),
        database_type: target_type,
        generation: context.target_generation,
    };
    LiveCatalog { state, endpoint: &target_endpoint, config: &context.target_config }.check_endpoint().await?;
    let catalog = LiveCatalog { state, endpoint: &source_endpoint, config: &context.source_config };
    let source = transfer_definition(&catalog, &source_endpoint, &input.identity).await?;
    catalog.check_endpoint().await?;
    // Existing transfer rewrites schema-qualified code, including body refs,
    // unlike the comparison path's declaration-only adaptation.
    let adapted = rewrite_oracle_schema_qualifier(&source, &input.identity.owner, &input.target_owner);
    let sql = prepare_oracle_routine_definition(OracleRoutineDefinitionInput {
        database_type: target_type,
        object_type: input.identity.kind.clone(),
        source_owner: input.target_owner.clone(),
        target_owner: input.target_owner.clone(),
        name: input.identity.name.clone(),
        source: adapted,
        replace: false,
    })?;
    let (prepared, _transfer_pin) = execution::prepare_bound_definition_pinned(
        state,
        OracleRoutineSaveInput {
            connection_id: input.target_connection_id,
            database: input.target_database,
            identity: RoutineIdentity { owner: input.target_owner, ..input.identity },
            sql: sql.clone(),
            require_absent: false,
            prerequisite_operation_id: None,
            supersedes_operation_id: None,
        },
        context.target_config.clone(),
        context.target_generation,
        false,
    )?;
    // CREATE itself protects the race without adding global dictionary grants
    // to the old transfer entry. The existing skip check remains with its caller.
    execution::execute_prepared_inline(state, &prepared.operation_id, &sql).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Catalog {
        database_type: DatabaseType,
        incomplete: bool,
        changed: bool,
        reads: AtomicUsize,
    }
    const SOURCE: &str =
        "CREATE OR REPLACE FUNCTION \"OWNER\".\"Mixed.Func\" RETURN VARCHAR2 AS BEGIN RETURN '🙂 OWNER.Table'; END";
    #[async_trait::async_trait]
    impl RoutineCatalog for Catalog {
        async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
            if sql.contains("SOURCE_DDL") {
                let call = self.reads.fetch_add(1, Ordering::SeqCst);
                let source =
                    if self.changed && call > 0 { SOURCE.replace("OWNER.Table", "OTHER.Table") } else { SOURCE.into() };
                let length = if self.database_type == DatabaseType::OceanbaseOracle {
                    source.chars().count()
                } else {
                    source.encode_utf16().count()
                };
                Ok(serde_json::from_value(json!({"columns":["SOURCE_DDL","SOURCE_CHARS"],"rows":[[source,length]],"truncated":self.incomplete})).unwrap())
            } else {
                Ok(serde_json::from_value(json!({"columns":["OWNER","OBJECT_NAME","OBJECT_TYPE","OBJECT_ID","STATUS","LAST_DDL_TIME"],"rows":[["OWNER","Mixed.Func","FUNCTION",12,"VALID","2026-10-21T08:30:00"]]})).unwrap())
            }
        }
        async fn source(&self, _: &RoutineIdentity) -> Result<SourceReply, String> {
            panic!("transfer keeps its metadata source, not the ordinary getter")
        }
    }
    fn endpoint(database_type: DatabaseType) -> RoutineEndpoint {
        RoutineEndpoint {
            connection_id: "source".into(),
            database: "tenant".into(),
            schema: "OWNER".into(),
            database_type,
            generation: 0,
        }
    }
    fn identity() -> RoutineIdentity {
        RoutineIdentity { owner: "OWNER".into(), name: "Mixed.Func".into(), kind: db::ObjectSourceKind::Function }
    }
    #[tokio::test]
    async fn complete_metadata_uses_product_specific_clob_units_and_keeps_literals() {
        for database_type in [DatabaseType::Oracle, DatabaseType::OceanbaseOracle] {
            let catalog = Catalog { database_type, incomplete: false, changed: false, reads: AtomicUsize::new(0) };
            let source = transfer_definition(&catalog, &endpoint(database_type), &identity()).await.unwrap();
            assert_eq!(source, SOURCE);
            let adapted = rewrite_oracle_schema_qualifier(&source, "OWNER", "TARGET");
            assert!(adapted.contains("'🙂 OWNER.Table'"));
            assert!(adapted.contains("\"TARGET\".\"Mixed.Func\""));
        }
    }
    #[tokio::test]
    async fn incomplete_or_changed_metadata_never_reaches_a_transfer_write() {
        for (incomplete, changed) in [(true, false), (false, true)] {
            let catalog = Catalog {
                database_type: DatabaseType::OceanbaseOracle,
                incomplete,
                changed,
                reads: AtomicUsize::new(0),
            };
            assert!(transfer_definition(&catalog, &endpoint(DatabaseType::OceanbaseOracle), &identity())
                .await
                .is_err());
        }
    }
}
