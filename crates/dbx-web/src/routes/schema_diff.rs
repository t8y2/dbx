use crate::error::AppError;
use crate::state::WebState;
use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSchemaSyncSqlRequest {
    pub diffs: Vec<dbx_core::schema_diff::TableDiff>,
    pub function_diffs: Option<Vec<dbx_core::schema_diff::FunctionDiff>>,
    pub sequence_diffs: Option<Vec<dbx_core::schema_diff::SequenceDiff>>,
    pub rule_diffs: Option<Vec<dbx_core::schema_diff::RuleDiff>>,
    pub owner_diffs: Option<Vec<dbx_core::schema_diff::OwnerDiff>>,
    pub database_type: dbx_core::models::connection::DatabaseType,
    pub target_schema: Option<String>,
    pub cascade_delete: Option<bool>,
    pub source_dialect: Option<String>,
    pub field_mappings: Option<Vec<dbx_core::schema_diff::FieldMapping>>,
    pub enable_rollback: Option<bool>,
    /// Wrap the generated forward and rollback scripts in MySQL's
    /// FOREIGN_KEY_CHECKS toggle. Ignored for targets that are not MySQL.
    pub ignore_foreign_key_checks: Option<bool>,
    pub oracle_ddl: Option<dbx_core::schema_diff::OracleSchemaSyncDdlOptions>,
}

pub async fn generate_schema_sync_plan(
    State(state): State<Arc<WebState>>,
    Json(req): Json<GenerateSchemaSyncSqlRequest>,
) -> Result<Json<dbx_core::schema_diff::SchemaSyncSqlPlan>, AppError> {
    let oracle_ddl = if let Some(options) = req.oracle_ddl.as_ref().filter(|options| options.separate_indexes) {
        if options.target.as_ref().is_none_or(|target| Some(target.schema.as_str()) != req.target_schema.as_deref())
            || !matches!(
                req.database_type,
                dbx_core::models::connection::DatabaseType::Oracle
                    | dbx_core::models::connection::DatabaseType::OceanbaseOracle
            )
        {
            return Err(AppError::from("Independent indexes require the fixed Oracle target schema".to_string()));
        }
        Some(
            dbx_core::schema::prepare_schema_sync_oracle_ddl_core(
                &state.app,
                &req.diffs,
                req.enable_rollback.unwrap_or(false),
                options,
            )
            .await,
        )
    } else {
        None
    };
    Ok(Json(dbx_core::schema_diff::generate_schema_sync_sql_plan_with_oracle_ddl(
        &req.diffs,
        req.function_diffs.as_deref().unwrap_or_default(),
        req.sequence_diffs.as_deref().unwrap_or_default(),
        req.rule_diffs.as_deref().unwrap_or_default(),
        req.owner_diffs.as_deref().unwrap_or_default(),
        req.database_type,
        req.target_schema.as_deref(),
        req.cascade_delete.unwrap_or(false),
        req.source_dialect.as_deref().and_then(dbx_core::sql_dialect::descriptor::DialectKind::from_label),
        req.field_mappings.as_deref().unwrap_or(&[]),
        req.enable_rollback.unwrap_or(false),
        req.ignore_foreign_key_checks.unwrap_or(false),
        oracle_ddl.as_ref(),
    )))
}

pub async fn prepare_schema_diff(
    Json(options): Json<dbx_core::schema_diff::SchemaDiffPreparationOptions>,
) -> Json<dbx_core::schema_diff::SchemaDiffPreparation> {
    Json(dbx_core::schema_diff::prepare_schema_diff(options))
}

pub async fn generate_schema_sync_sql(Json(req): Json<GenerateSchemaSyncSqlRequest>) -> Json<String> {
    Json(dbx_core::schema_diff::generate_schema_sync_sql(
        &req.diffs,
        req.function_diffs.as_deref().unwrap_or_default(),
        req.sequence_diffs.as_deref().unwrap_or_default(),
        req.rule_diffs.as_deref().unwrap_or_default(),
        req.owner_diffs.as_deref().unwrap_or_default(),
        req.database_type,
        req.target_schema.as_deref(),
        req.cascade_delete.unwrap_or(false),
        req.source_dialect.as_deref().and_then(dbx_core::sql_dialect::descriptor::DialectKind::from_label),
        req.field_mappings.as_deref().unwrap_or(&[]),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn state(directory: &std::path::Path) -> Arc<WebState> {
        let storage = dbx_core::persistence::test_storage::open(&directory.join("dbx.db")).await.unwrap();
        Arc::new(WebState::for_tests(Arc::new(dbx_core::connection::AppState::new(storage)), directory.into()))
    }

    #[tokio::test]
    async fn default_plan_needs_no_connections_and_preserves_pure_generator_output() {
        let directory = tempfile::tempdir().unwrap();
        let state = state(directory.path()).await;
        let request: GenerateSchemaSyncSqlRequest = serde_json::from_value(json!({
            "diffs":[{"type":"removed", "name":"T"}], "databaseType":"oracle", "targetSchema":"APP"
        }))
        .unwrap();
        let expected = dbx_core::schema_diff::generate_schema_sync_sql_plan(
            &request.diffs,
            &[],
            &[],
            &[],
            &[],
            request.database_type,
            Some("APP"),
            false,
            None,
            &[],
            false,
            false,
        );
        let Json(plan) = generate_schema_sync_plan(State(state), Json(request)).await.unwrap();
        assert_eq!(plan.sync_sql, expected.sync_sql);
        assert_eq!(plan.forward_completeness, dbx_core::schema_diff::RollbackCompleteness::Complete);
        assert!(plan.generation_issues.is_empty());
    }

    #[tokio::test]
    async fn independent_plan_passes_captured_failures_through_shared_core() {
        let directory = tempfile::tempdir().unwrap();
        let state = state(directory.path()).await;
        let request = serde_json::from_value(json!({
            "diffs":[{"type":"added", "name":"T", "ddl":"CREATE TABLE SRC.T(ID NUMBER);"}],
            "databaseType":"oracle", "targetSchema":"DEST", "sourceDialect":"oracle",
            "oracleDdl": {"separateIndexes":true, "source":{"connectionId":"missing-source", "database":"db", "schema":"SRC"}, "target":{"connectionId":"missing-target", "database":"db", "schema":"DEST"}}
        })).unwrap();
        let Json(plan) = generate_schema_sync_plan(State(state), Json(request)).await.unwrap();
        assert_eq!(plan.forward_completeness, dbx_core::schema_diff::RollbackCompleteness::Incomplete);
        assert!(plan
            .generation_issues
            .iter()
            .any(|issue| issue.direction == "forward" && issue.reason.contains("connection not found")));
        assert!(!plan.sync_sql.is_empty());
    }

    #[tokio::test]
    async fn independent_plan_rejects_mismatched_fixed_target_schema() {
        let directory = tempfile::tempdir().unwrap();
        let state = state(directory.path()).await;
        let request = serde_json::from_value(json!({
            "diffs":[], "databaseType":"oracle", "targetSchema":"OTHER",
            "oracleDdl":{"separateIndexes":true, "target":{"connectionId":"missing-target", "database":"db", "schema":"DEST"}}
        })).unwrap();
        assert!(generate_schema_sync_plan(State(state), Json(request)).await.is_err());
    }
}
