//! Create / edit / drop orchestration for PostgreSQL-family user-defined types.
//!
//! The split of responsibilities is deliberate, and is what makes this feature
//! safe to expose in a UI:
//!
//! * [`dbx_sql::custom_type_sql`] is a pure function over a catalog snapshot and
//!   a desired end state. It decides *what* to run.
//! * This module owns everything that needs a database: reading the snapshot,
//!   resolving which operations the connection actually supports, hashing the
//!   plan into a revision, and executing it under a transaction policy.
//! * The frontend never sends SQL. It sends a draft plus the revision of the
//!   plan it was shown, and apply re-derives both before touching the server.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use dbx_sql::custom_type_sql::{self, CustomTypeSqlDialect};

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::DatabaseType;
use crate::query::{execute_multi_core_with_options, QueryExecutionOptions};
use crate::types::{
    ApplyCustomTypeChangeRequest, ApplyCustomTypeDropRequest, CustomTypeChangePreview, CustomTypeChangeRequest,
    CustomTypeChangeResult, CustomTypeDependency, CustomTypeDetails, CustomTypeDropPreview, CustomTypeDropRequest,
    CustomTypeIdentity, CustomTypeManagementCapabilities, CustomTypeOperation, CustomTypeOperationCapability,
    CustomTypePlanIssue, CustomTypePlanIssueSeverity, CustomTypeTransactionPolicy,
};

/// Lowest server version whose composite `ALTER ATTRIBUTE` forms are verified.
///
/// These are conservative floors, not exact "introduced in" values: refusing a
/// feature the server has costs a round of capability verification, while
/// offering one it lacks costs the user a failed save.
const PG_COMPOSITE_ALTER_MIN_VERSION: i32 = 90_100;
const PG_ENUM_RENAME_VALUE_MIN_VERSION: i32 = 100_000;
const PG_ENUM_ADD_VALUE_IN_TRANSACTION_MIN_VERSION: i32 = 120_000;
const PG_RANGE_MULTIRANGE_NAME_MIN_VERSION: i32 = 140_000;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/// A connection that cannot manage types at all, with one reason for every
/// operation so the UI never has to invent an explanation.
fn unsupported_capabilities(
    database_type: &DatabaseType,
    reason_code: &str,
    reason: &str,
) -> CustomTypeManagementCapabilities {
    let operations = CustomTypeOperation::ALL
        .iter()
        .map(|operation| (*operation, CustomTypeOperationCapability::unsupported(reason_code, reason)))
        .collect::<BTreeMap<_, _>>();
    capabilities_with_revision(format!("{database_type:?}"), None, None, operations)
}

fn capabilities_with_revision(
    database_type: String,
    product_version: Option<String>,
    compatibility_mode: Option<String>,
    operations: BTreeMap<CustomTypeOperation, CustomTypeOperationCapability>,
) -> CustomTypeManagementCapabilities {
    let mut capabilities = CustomTypeManagementCapabilities {
        database_type,
        product_version,
        compatibility_mode,
        operations,
        capability_revision: String::new(),
    };
    // The revision covers the resolved operation set, so a plan built before a
    // capability changed can never be applied afterwards.
    capabilities.capability_revision = hash_json(&serde_json::json!({
        "databaseType": capabilities.database_type,
        "productVersion": capabilities.product_version,
        "compatibilityMode": capabilities.compatibility_mode,
        "operations": capabilities.operations,
    }));
    capabilities
}

fn supported_operations(min_version: i32, version: i32) -> CustomTypeOperationCapability {
    if version >= min_version {
        CustomTypeOperationCapability::supported()
    } else {
        CustomTypeOperationCapability::unsupported(
            "server_version_too_old",
            format!(
                "This server version does not support the operation (requires server version {min_version} or later)."
            ),
        )
    }
}

/// Resolve the operation matrix for a native PostgreSQL server version.
fn postgres_capabilities(version: Option<i32>, product_version: Option<String>) -> CustomTypeManagementCapabilities {
    let Some(version) = version else {
        return unsupported_capabilities(
            &DatabaseType::Postgres,
            "server_version_unknown",
            "The server version could not be read, so type management stays read-only.",
        );
    };
    let mut builder = OperationMatrix::new(version);
    builder.enable_all(version >= PG_COMPOSITE_ALTER_MIN_VERSION);
    builder.set(
        CustomTypeOperation::CreateRangeMultirangeName,
        supported_operations(PG_RANGE_MULTIRANGE_NAME_MIN_VERSION, version),
    );
    builder.set(
        CustomTypeOperation::AlterEnumRenameValue,
        supported_operations(PG_ENUM_RENAME_VALUE_MIN_VERSION, version),
    );
    builder.set(
        CustomTypeOperation::AlterEnumAddValueInTransaction,
        supported_operations(PG_ENUM_ADD_VALUE_IN_TRANSACTION_MIN_VERSION, version),
    );
    let reason = format!(
        "Composite attribute alteration requires server version {PG_COMPOSITE_ALTER_MIN_VERSION} or later; this server reports {version}."
    );
    for operation in [
        CustomTypeOperation::AlterCompositeAddAttribute,
        CustomTypeOperation::AlterCompositeRenameAttribute,
        CustomTypeOperation::AlterCompositeAlterAttributeType,
        CustomTypeOperation::AlterCompositeDropAttribute,
    ] {
        builder.set(operation, supported_operations(PG_COMPOSITE_ALTER_MIN_VERSION, version));
        if !builder.supports(operation) {
            builder.override_reason(operation, "server_version_too_old", reason.clone());
        }
    }
    capabilities_with_revision("postgres".to_string(), product_version, None, builder.finish())
}

/// Small helper so the version matrix above reads as a list of decisions rather
/// than a wall of `BTreeMap::insert` calls.
struct OperationMatrix {
    version: i32,
    operations: BTreeMap<CustomTypeOperation, CustomTypeOperationCapability>,
}

impl OperationMatrix {
    fn new(version: i32) -> Self {
        Self { version, operations: BTreeMap::new() }
    }

    fn set(&mut self, operation: CustomTypeOperation, capability: CustomTypeOperationCapability) {
        self.operations.insert(operation, capability);
    }

    /// Everything that is available on every supported server version.
    fn enable_all(&mut self, supported: bool) {
        let reason = "This server version does not support the operation.";
        for operation in CustomTypeOperation::ALL {
            let capability = if supported {
                CustomTypeOperationCapability::supported()
            } else {
                CustomTypeOperationCapability::unsupported("server_version_too_old", reason)
            };
            self.operations.insert(operation, capability);
        }
    }

    fn supports(&self, operation: CustomTypeOperation) -> bool {
        self.operations.get(&operation).is_some_and(|capability| capability.supported)
    }

    fn override_reason(&mut self, operation: CustomTypeOperation, code: &str, reason: String) {
        self.operations.insert(operation, CustomTypeOperationCapability::unsupported(code, reason));
    }

    fn finish(self) -> BTreeMap<CustomTypeOperation, CustomTypeOperationCapability> {
        let _ = self.version;
        self.operations
    }
}

/// Map a connection to the SQL dialect that can plan its type changes.
///
/// Only engines with a planner implementation and live verification appear
/// here. A PostgreSQL-family engine that is *not* listed keeps its read-only
/// type browser instead of inheriting PostgreSQL's DDL by association.
fn custom_type_dialect(database_type: DatabaseType) -> Option<CustomTypeSqlDialect> {
    match database_type {
        DatabaseType::Postgres => Some(CustomTypeSqlDialect::Postgres),
        _ => None,
    }
}

fn unsupported_dialect_reason(database_type: DatabaseType) -> (&'static str, &'static str) {
    match database_type {
        DatabaseType::Kingbase | DatabaseType::Vastbase | DatabaseType::OpenGauss | DatabaseType::Gaussdb => (
            "not_verified_for_database",
            "Type management is not verified for this engine yet, so types stay read-only here.",
        ),
        _ => ("unsupported_database", "This connection does not support user-defined type management."),
    }
}

/// Normalize a caller-supplied database for pool lookup.
///
/// An empty string means "the connection's own database": passing it through
/// verbatim would ask the pool layer for a database literally named `""`, and a
/// connection whose database is only resolved at connect time starts out empty.
fn pool_database(database: &str) -> Option<&str> {
    let database = database.trim();
    (!database.is_empty()).then_some(database)
}

/// Read the server version of a connection that is served by the native
/// PostgreSQL driver.
async fn native_postgres_version(state: &AppState, connection_id: &str, database: &str) -> Result<Option<i32>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, pool_database(database), None).await?;
    let pool = match state.pool_handle(&pool_key).await {
        Some(PoolKind::Postgres(pool)) => pool.clone(),
        Some(_) => return Err("type management requires a native PostgreSQL connection".to_string()),
        None => return Err("connection pool not found".to_string()),
    };
    db::postgres::get_server_version_num(&pool).await
}

/// Resolve which type-management operations this connection supports.
///
/// `database` should be the database the caller is looking at, because that is
/// the pool the preview/apply calls will use; an empty value falls back to the
/// connection's own database.
pub async fn get_custom_type_management_capabilities_core(
    state: &AppState,
    connection_id: &str,
    database: Option<&str>,
) -> Result<CustomTypeManagementCapabilities, String> {
    let config = state
        .configs
        .read()
        .await
        .get(connection_id)
        .cloned()
        .ok_or_else(|| format!("Connection config not found: {connection_id}"))?;
    let database = database
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| config.database.clone())
        .unwrap_or_default();
    if custom_type_dialect(config.db_type).is_none() {
        let (code, reason) = unsupported_dialect_reason(config.db_type);
        return Ok(unsupported_capabilities(&config.db_type, code, reason));
    }
    // The transport matters as much as the engine: an Agent connection runs the
    // statements through a different implementation, and that path is verified
    // separately.
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database.as_str()), None).await?;
    if !matches!(state.pool_handle(&pool_key).await, Some(PoolKind::Postgres(_))) {
        return Ok(unsupported_capabilities(
            &config.db_type,
            "unsupported_connection_transport",
            "Type management is only verified over the native PostgreSQL connection.",
        ));
    }
    let product_version = config.database_info.as_ref().and_then(|info| info.product_version.clone());
    match native_postgres_version(state, connection_id, &database).await {
        Ok(version) => Ok(postgres_capabilities(version, product_version)),
        Err(error) => {
            log::debug!("[custom-types] capability probe failed: {error}");
            Ok(unsupported_capabilities(
                &config.db_type,
                "server_version_unknown",
                "The server version could not be read, so type management stays read-only.",
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Snapshots, revisions and planning
// ---------------------------------------------------------------------------

async fn connection_context(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<(DatabaseType, CustomTypeSqlDialect, CustomTypeManagementCapabilities), String> {
    let database_type = {
        let configs = state.configs.read().await;
        configs.get(connection_id).map(|config| config.db_type)
    }
    .ok_or_else(|| format!("Connection config not found: {connection_id}"))?;
    let Some(dialect) = custom_type_dialect(database_type) else {
        let (_, reason) = unsupported_dialect_reason(database_type);
        return Err(reason.to_string());
    };
    let capabilities = get_custom_type_management_capabilities_core(state, connection_id, Some(database)).await?;
    Ok((database_type, dialect, capabilities))
}

/// Read the live object the draft is being compared against.
///
/// A missing target is an error rather than an empty snapshot: applying an edit
/// to a type that no longer exists must fail loudly, not degrade into a create.
async fn load_snapshot(
    state: &AppState,
    connection_id: &str,
    database: &str,
    target: Option<&CustomTypeIdentity>,
) -> Result<Option<CustomTypeDetails>, String> {
    let Some(target) = target else {
        return Ok(None);
    };
    crate::schema::get_custom_type_details_core(state, connection_id, database, &target.schema, &target.name)
        .await
        .map(Some)
}

fn hash_json(value: &serde_json::Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(value).unwrap_or_default());
    format!("{:x}", hasher.finalize())
}

/// Exclude derived DDL and the revision itself; hash the catalog fields used by
/// the planner, including OID so drop/recreate also invalidates an open editor.
pub(super) fn snapshot_revision(snapshot: &CustomTypeDetails) -> String {
    hash_json(&serde_json::json!({
        "catalogId": snapshot.catalog_id,
        "schema": snapshot.schema,
        "name": snapshot.name,
        "kind": snapshot.kind,
        "owner": snapshot.owner,
        "comment": snapshot.comment,
        "members": snapshot.members,
        "properties": snapshot.properties,
    }))
}

fn check_edit_baseline(request: &CustomTypeChangeRequest, snapshot: Option<&CustomTypeDetails>) -> Result<(), String> {
    if request.target.is_none() {
        return Ok(());
    }
    let expected = request
        .expected_snapshot_revision
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or("The editing snapshot is missing. Refresh the type before editing.")?;
    if snapshot.map(snapshot_revision).as_deref() != Some(expected) {
        return Err("The type changed on the server since editing began. Refresh the type and reapply your changes."
            .to_string());
    }
    Ok(())
}

/// Hash everything a plan depends on, so apply can tell whether the world moved
/// between the preview the user saw and the batch it is about to run.
fn change_plan_revision(
    snapshot: Option<&CustomTypeDetails>,
    request: &CustomTypeChangeRequest,
    capabilities: &CustomTypeManagementCapabilities,
    plan: &custom_type_sql::CustomTypePlan,
) -> String {
    hash_json(&serde_json::json!({
        "snapshot": snapshot,
        "request": request,
        "capabilityRevision": capabilities.capability_revision,
        "statements": plan.statements,
        "transactionPolicy": plan.transaction_policy,
    }))
}

/// Revision for a drop plan.
///
/// Covers the live target and the dependency set, not just the statement text:
/// a `DROP ... CASCADE` is destructive precisely *because* of its dependents, so
/// a dependency that appeared between preview and apply has to invalidate the
/// plan even though the statement is byte-identical. Same for the target being
/// dropped and recreated under the same name while the user was reading the
/// confirmation.
fn drop_plan_revision(
    request: &CustomTypeDropRequest,
    capabilities: &CustomTypeManagementCapabilities,
    statement: &str,
    snapshot: Option<&CustomTypeDetails>,
    dependencies: &[CustomTypeDependency],
    dependencies_complete: bool,
) -> String {
    hash_json(&serde_json::json!({
        "target": request.target,
        "cascade": request.cascade,
        "capabilityRevision": capabilities.capability_revision,
        "statement": statement,
        "targetSnapshot": snapshot,
        // Keep the identity explicitly visible even if a future DTO serializer
        // filters optional fields. The complete snapshot above is the primary
        // guard; catalogId distinguishes delete/recreate under one name.
        "targetCatalogId": snapshot.and_then(|details| details.catalog_id.clone()),
        "targetKind": snapshot.map(|details| details.kind),
        "targetOwner": snapshot.and_then(|details| details.owner.clone()),
        // Sorted and reduced to the identity of each dependent so an unstable
        // catalog ordering cannot make two identical sets hash differently.
        "dependencies": normalized_dependency_keys(dependencies),
        "dependenciesComplete": dependencies_complete,
    }))
}

/// Order-independent identity of a dependency set.
fn normalized_dependency_keys(dependencies: &[CustomTypeDependency]) -> Vec<String> {
    let mut keys = dependencies
        .iter()
        .map(|dependency| {
            serde_json::json!([
                dependency.catalog_id,
                dependency.kind,
                dependency.schema,
                dependency.parent,
                dependency.name,
                dependency.dependency_type,
                dependency.requires_cascade,
            ])
            .to_string()
        })
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    keys
}

fn blocking_issue(code: &str, message: impl Into<String>) -> CustomTypePlanIssue {
    CustomTypePlanIssue {
        code: code.to_string(),
        message: message.into(),
        path: None,
        severity: CustomTypePlanIssueSeverity::Blocking,
    }
}

fn drop_dependency_warning(dependencies: &[CustomTypeDependency], cascade: bool) -> Option<CustomTypePlanIssue> {
    let count = dependencies.iter().filter(|dependency| cascade || dependency.requires_cascade != Some(false)).count();
    if count == 0 {
        return None;
    }
    let (code, message) = if cascade {
        ("drop.cascade_dependents", format!("{count} dependent object(s) will be dropped as well."))
    } else {
        (
            "drop.restrict_dependents",
            format!("{count} object(s) depend on this type; a RESTRICT drop will be refused by the server. Enable CASCADE to drop them together."),
        )
    };
    Some(CustomTypePlanIssue {
        code: code.to_string(),
        message,
        path: None,
        severity: CustomTypePlanIssueSeverity::Destructive,
    })
}

/// Whether a name is already taken in the target namespace.
///
/// Only checked for creates: the planner cannot know this (the catalog is not
/// part of the snapshot), and finding out at apply time through a server error
/// would be a much worse experience than a blocked plan.
async fn name_conflict(
    state: &AppState,
    connection_id: &str,
    database: &str,
    request: &CustomTypeChangeRequest,
) -> Result<Option<String>, String> {
    if request.target.is_some() {
        return Ok(None);
    }
    let schema = request.draft.schema.as_str();
    let name = request.draft.name.as_str();
    if schema.is_empty() || name.is_empty() {
        return Ok(None);
    }
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, pool_database(database), None).await?;
    let pool = match state.pool_handle(&pool_key).await {
        Some(PoolKind::Postgres(pool)) => pool.clone(),
        _ => return Ok(None),
    };
    let exists = db::postgres::custom_type_name_exists(&pool, schema, name).await?;
    Ok(exists.then(|| format!("A type named {schema}.{name} already exists.")))
}

async fn build_change_preview(
    state: &AppState,
    connection_id: &str,
    database: &str,
    request: &CustomTypeChangeRequest,
) -> Result<(CustomTypeChangePreview, CustomTypeManagementCapabilities), String> {
    let (_, dialect, capabilities) = connection_context(state, connection_id, database).await?;
    let snapshot = load_snapshot(state, connection_id, database, request.target.as_ref()).await?;
    if request.target.is_some() && snapshot.is_none() {
        return Err("The type no longer exists. Refresh the object list and try again.".to_string());
    }
    check_edit_baseline(request, snapshot.as_ref())?;
    let mut plan = custom_type_sql::plan_custom_type_change(dialect, snapshot.as_ref(), request, &capabilities);
    if let Some(message) = name_conflict(state, connection_id, database, request).await? {
        plan.blocked_changes.push(blocking_issue("identity.name_taken", message));
    }
    let plan_revision = change_plan_revision(snapshot.as_ref(), request, &capabilities, &plan);
    Ok((custom_type_sql::preview_from_plan(plan, plan_revision), capabilities))
}

// ---------------------------------------------------------------------------
// Preview / apply
// ---------------------------------------------------------------------------

pub async fn preview_custom_type_change_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    request: CustomTypeChangeRequest,
) -> Result<CustomTypeChangePreview, String> {
    build_change_preview(state, connection_id, database, &request).await.map(|(preview, _)| preview)
}

pub async fn apply_custom_type_change_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    apply: ApplyCustomTypeChangeRequest,
) -> Result<CustomTypeChangeResult, String> {
    // Re-derive the plan from the live catalog. The revision the caller sends is
    // only proof of *what the user approved*; it is never the thing that gets
    // executed.
    let (preview, _) = build_change_preview(state, connection_id, database, &apply.change).await?;
    // The revision check comes first on purpose. A draft built against a stale
    // snapshot re-derives into *different* blocking issues (typically "value X
    // no longer exists" plus the follow-on "Y cannot be removed"), which
    // describes the symptom rather than the cause. Telling the user the object
    // moved under them is the actionable message.
    if preview.plan_revision != apply.expected_plan_revision {
        return Err("The type changed on the server after this plan was previewed. Review the change and save again."
            .to_string());
    }
    if !preview.blocked_changes.is_empty() {
        return Err(blocked_message("The change cannot be applied", &preview.blocked_changes));
    }
    if preview.statements.is_empty() {
        return Err("There is nothing to change.".to_string());
    }
    let affected_rows = execute_plan(
        state,
        connection_id,
        database,
        &preview.statements,
        preview.transaction_policy,
        Some(preview.resulting_identity.schema.clone()),
    )
    .await?;
    Ok(CustomTypeChangeResult { identity: preview.resulting_identity, statements: preview.statements, affected_rows })
}

/// Run a plan's statements with the atomicity its policy demands.
///
/// Goes through the shared batch executor so read-only protection, statement
/// splitting, Agent routing and metadata-cache invalidation all behave exactly
/// as they do for a user-run script.
async fn execute_plan(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
    policy: CustomTypeTransactionPolicy,
    schema: Option<String>,
) -> Result<u64, String> {
    // Defence in depth for the fragment boundary: the planner validates every
    // embedded expression, but this is the last point before text becomes
    // executed SQL, so prove that the batch the executor will see still contains
    // exactly the statements that were planned. A statement that re-splits into
    // more than one means a fragment smuggled in a terminator, which would also
    // have bypassed the planner's statement-count and transaction decisions.
    assert_plan_splits_into_itself(statements)?;

    let script = statements
        .iter()
        .map(|statement| statement.trim().trim_end_matches(';'))
        .filter(|statement| !statement.is_empty())
        .collect::<Vec<_>>()
        .join(";\n");
    let options = QueryExecutionOptions {
        use_transaction: (policy == CustomTypeTransactionPolicy::Required).then_some(true),
        ..Default::default()
    };
    let results =
        execute_multi_core_with_options(state, connection_id, database, &script, schema.as_deref(), None, options)
            .await?;
    Ok(results.iter().map(|result| result.affected_rows).sum())
}

/// Refuse a plan whose script the executor would split differently.
///
/// Uses the executor's own splitter (`query_execution_plan_with_compatibility`)
/// rather than a private approximation, so this cannot drift from what actually
/// runs.
fn assert_plan_splits_into_itself(statements: &[String]) -> Result<(), String> {
    let script = statements
        .iter()
        .map(|statement| statement.trim().trim_end_matches(';'))
        .filter(|statement| !statement.is_empty())
        .collect::<Vec<_>>()
        .join(";\n");
    let plan =
        crate::query::query_execution_plan_with_compatibility(&script, Some(DatabaseType::Postgres), false, None);
    let split = plan.statements.iter().map(|statement| statement.trim()).collect::<Vec<_>>();
    let expected = statements
        .iter()
        .map(|statement| statement.trim().trim_end_matches(';'))
        .filter(|statement| !statement.is_empty())
        .collect::<Vec<_>>();
    if split.len() != expected.len() || split.iter().zip(expected.iter()).any(|(left, right)| left != right) {
        // The message deliberately names no field: reaching this means the
        // planner missed a fragment check, so it is a bug in DBX rather than
        // something the user typed wrong.
        return Err(
            "The generated type change was refused because the statement batch did not match the reviewed plan. Please report this as a bug."
                .to_string(),
        );
    }
    Ok(())
}

fn blocked_message(prefix: &str, issues: &[CustomTypePlanIssue]) -> String {
    let details = issues.iter().map(|issue| issue.message.clone()).collect::<Vec<_>>().join("\n");
    format!("{prefix}:\n{details}")
}

pub async fn list_custom_type_dependencies_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    name: &str,
) -> Result<Vec<CustomTypeDependency>, String> {
    connection_context(state, connection_id, database).await?;
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, pool_database(database), None).await?;
    let pool = match state.pool_handle(&pool_key).await {
        Some(PoolKind::Postgres(pool)) => pool.clone(),
        _ => return Ok(Vec::new()),
    };
    db::postgres::custom_type_dependencies(&pool, schema, name).await
}

pub async fn preview_custom_type_drop_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    request: CustomTypeDropRequest,
) -> Result<CustomTypeDropPreview, String> {
    let (_, dialect, capabilities) = connection_context(state, connection_id, database).await?;
    let mut preview = custom_type_sql::plan_custom_type_drop(dialect, &request, &capabilities);
    // Read the target first: dropping something that is already gone (or was
    // recreated by someone else) must not resolve to a plan the user can apply.
    //
    // The failure is reported with one stable phrase rather than the driver's
    // error text, which differs per backend ("does not exist" / "not found" /
    // table-read failures). The original error is appended for diagnosis.
    let snapshot = match load_snapshot(state, connection_id, database, Some(&request.target)).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let target = &request.target;
            return Err(format!(
                "{}.{} no longer exists or could not be read, so it cannot be dropped. Refresh the object list and try again. ({error})",
                target.schema, target.name
            ));
        }
    };
    if snapshot.is_none() && preview.blocked_changes.is_empty() {
        let target = &request.target;
        return Err(format!(
            "{}.{} no longer exists or could not be read, so it cannot be dropped. Refresh the object list and try again.",
            target.schema, target.name
        ));
    }
    // Dependency listing is best effort, but an incomplete answer must never be
    // presented as "nothing depends on this".
    match list_custom_type_dependencies_core(
        state,
        connection_id,
        database,
        &request.target.schema,
        &request.target.name,
    )
    .await
    {
        Ok(dependencies) => {
            if let Some(warning) = drop_dependency_warning(&dependencies, request.cascade) {
                preview.warnings.push(warning);
            }
            preview.dependencies = dependencies;
        }
        Err(error) => {
            log::debug!("[custom-types] dependency listing failed: {error}");
            preview.dependencies_complete = false;
            preview.warnings.push(CustomTypePlanIssue {
                code: "drop.dependencies_unknown".to_string(),
                message: format!("The dependent-object list could not be read, so the impact is unknown: {error}"),
                path: None,
                severity: CustomTypePlanIssueSeverity::Warning,
            });
        }
    }
    preview.plan_revision = drop_plan_revision(
        &request,
        &capabilities,
        &preview.statement,
        snapshot.as_ref(),
        &preview.dependencies,
        preview.dependencies_complete,
    );
    Ok(preview)
}

pub async fn apply_custom_type_drop_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    apply: ApplyCustomTypeDropRequest,
) -> Result<CustomTypeChangeResult, String> {
    let preview = preview_custom_type_drop_core(state, connection_id, database, apply.request.clone()).await?;
    // Same ordering as apply: a stale plan explains itself better than the
    // blocking issues its stale draft re-derives into.
    if preview.plan_revision != apply.expected_plan_revision {
        return Err("The type changed on the server after this plan was previewed. Review the deletion and try again."
            .to_string());
    }
    if !preview.blocked_changes.is_empty() {
        return Err(blocked_message("The type cannot be dropped", &preview.blocked_changes));
    }
    let statements = vec![preview.statement.clone()];
    let affected_rows = execute_plan(
        state,
        connection_id,
        database,
        &statements,
        CustomTypeTransactionPolicy::Autocommit,
        Some(apply.request.target.schema.clone()),
    )
    .await?;
    Ok(CustomTypeChangeResult { identity: apply.request.target, statements, affected_rows })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CustomTypeDraftDefinition;
    use crate::types::CustomTypeEnumValueDraft;
    use crate::types::{
        CustomTypeChangeRequest, CustomTypeDraft, CustomTypeDropRequest, CustomTypeIdentity, CustomTypeKind,
    };

    fn create_request() -> CustomTypeChangeRequest {
        CustomTypeChangeRequest {
            expected_snapshot_revision: None,
            target: None,
            draft: CustomTypeDraft {
                schema: "app".to_string(),
                name: "status".to_string(),
                owner: None,
                comment: None,
                definition: CustomTypeDraftDefinition::Enum {
                    values: vec![CustomTypeEnumValueDraft { value: "draft".to_string(), original_value: None }],
                },
            },
        }
    }

    #[test]
    fn editing_baseline_rejects_missing_and_changed_snapshots() {
        let mut snapshot: CustomTypeDetails = serde_json::from_value(serde_json::json!({
            "name": "d", "schema": "app", "kind": "domain", "catalogId": "42",
            "comment": null, "owner": "test", "properties": {"baseType": "integer", "default": "1"}
        }))
        .unwrap();
        let mut request = create_request();
        request.target =
            Some(CustomTypeIdentity { schema: "app".into(), name: "d".into(), kind: CustomTypeKind::Domain });
        assert!(check_edit_baseline(&request, Some(&snapshot)).is_err());
        request.expected_snapshot_revision = Some(snapshot_revision(&snapshot));
        assert!(check_edit_baseline(&request, Some(&snapshot)).is_ok());
        snapshot.snapshot_revision = Some("derived field is not hashed".into());
        assert!(check_edit_baseline(&request, Some(&snapshot)).is_ok());
        snapshot.properties.default = Some("2".into());
        assert!(check_edit_baseline(&request, Some(&snapshot)).unwrap_err().contains("since editing began"));
        snapshot.properties.default = Some("1".into());
        snapshot.catalog_id = Some("43".into());
        assert!(check_edit_baseline(&request, Some(&snapshot)).is_err());
    }

    #[test]
    fn postgres_capabilities_gate_operations_by_server_version() {
        let modern = postgres_capabilities(Some(160_000), None);
        assert!(modern.supports(CustomTypeOperation::CreateEnum));
        assert!(modern.supports(CustomTypeOperation::AlterEnumRenameValue));
        assert!(modern.supports(CustomTypeOperation::AlterEnumAddValueInTransaction));
        assert!(modern.supports(CustomTypeOperation::CreateRangeMultirangeName));
        assert!(modern.supports(CustomTypeOperation::TransactionalDdl));

        let pg11 = postgres_capabilities(Some(110_000), None);
        assert!(pg11.supports(CustomTypeOperation::AlterEnumRenameValue));
        assert!(!pg11.supports(CustomTypeOperation::AlterEnumAddValueInTransaction));
        assert!(!pg11.supports(CustomTypeOperation::CreateRangeMultirangeName));
        assert!(pg11.supports(CustomTypeOperation::AlterCompositeAddAttribute));

        let pg96 = postgres_capabilities(Some(90_600), None);
        assert!(pg96.supports(CustomTypeOperation::CreateEnum));
        assert!(pg96.supports(CustomTypeOperation::AlterCompositeRenameAttribute));
        // RENAME VALUE arrived in PostgreSQL 10, so 9.6 must not offer it.
        assert!(!pg96.supports(CustomTypeOperation::AlterEnumRenameValue));

        // Below the composite-alteration floor the editor is read-only rather
        // than offering statements the server would reject.
        let pg90 = postgres_capabilities(Some(90_000), None);
        assert!(!pg90.can_create_any());
        assert!(!pg90.supports(CustomTypeOperation::AlterCompositeRenameAttribute));

        let unknown = postgres_capabilities(None, None);
        assert!(!unknown.supports(CustomTypeOperation::CreateEnum));
        assert!(!unknown.can_create_any());
    }

    #[test]
    fn capability_revision_changes_with_the_resolved_matrix() {
        let pg16 = postgres_capabilities(Some(160_000), None);
        let pg11 = postgres_capabilities(Some(110_000), None);
        assert_ne!(pg16.capability_revision, pg11.capability_revision);
        assert_eq!(postgres_capabilities(Some(160_000), None).capability_revision, pg16.capability_revision);
    }

    #[test]
    fn unsupported_engines_report_one_reason_for_every_operation() {
        let capabilities = unsupported_capabilities(&DatabaseType::Kingbase, "not_verified_for_database", "no");
        assert_eq!(capabilities.operations.len(), CustomTypeOperation::ALL.len());
        assert!(!capabilities.can_create_any());
        assert!(capabilities
            .operations
            .values()
            .all(|capability| capability.reason_code.as_deref() == Some("not_verified_for_database")));
    }

    #[test]
    fn only_postgres_maps_to_a_custom_type_dialect() {
        assert_eq!(custom_type_dialect(DatabaseType::Postgres), Some(CustomTypeSqlDialect::Postgres));
        for database_type in [
            DatabaseType::Kingbase,
            DatabaseType::Vastbase,
            DatabaseType::OpenGauss,
            DatabaseType::Gaussdb,
            DatabaseType::Mysql,
        ] {
            assert_eq!(custom_type_dialect(database_type), None, "{database_type:?}");
        }
    }

    fn dependency(kind: &str, name: &str) -> CustomTypeDependency {
        dependency_with_parent(kind, name, None)
    }

    fn dependency_with_parent(kind: &str, name: &str, parent: Option<&str>) -> CustomTypeDependency {
        CustomTypeDependency {
            catalog_id: None,
            kind: kind.to_string(),
            schema: Some("app".to_string()),
            name: name.to_string(),
            parent: parent.map(str::to_string),
            description: format!("{kind} app.{}.{name}", parent.unwrap_or("")),
            dependency_type: Some("n".to_string()),
            requires_cascade: None,
        }
    }

    #[test]
    fn restrict_warning_only_counts_dependencies_that_need_cascade() {
        let mut own_check = dependency("constraint", "positive_check");
        own_check.requires_cascade = Some(false);
        // The dependency code alone is insufficient: a constraint can have both
        // automatic ownership and normal expression references to its domain.
        own_check.dependency_type = Some("n".into());
        assert!(drop_dependency_warning(&[own_check.clone()], false).is_none());
        let mut column = dependency("column", "amount");
        column.requires_cascade = Some(true);
        let dependencies = [own_check, column];
        let warning = drop_dependency_warning(&dependencies, false).unwrap();
        assert_eq!(warning.code, "drop.restrict_dependents");
        assert!(warning.message.starts_with("1 object(s)"));
        assert!(drop_dependency_warning(&dependencies, true).unwrap().message.starts_with("2 dependent"));
        // Preserve the conservative warning for older/unclassified responses.
        assert!(drop_dependency_warning(&[dependency("column", "unknown")], false).is_some());
    }

    #[test]
    fn dependency_mode_round_trips_and_changes_the_revision_key() {
        let mut dependent = dependency("constraint", "positive_check");
        let before = normalized_dependency_keys(&[dependent.clone()]);
        dependent.requires_cascade = Some(false);
        assert_ne!(before, normalized_dependency_keys(&[dependent.clone()]));
        let json = serde_json::to_value(&dependent).unwrap();
        assert_eq!(json["requiresCascade"], false);
        assert_eq!(serde_json::from_value::<CustomTypeDependency>(json).unwrap(), dependent);
    }

    #[test]
    fn drop_revision_changes_when_a_dependency_appears() {
        let capabilities = postgres_capabilities(Some(160_000), None);
        let request = CustomTypeDropRequest {
            target: CustomTypeIdentity {
                schema: "app".to_string(),
                name: "status".to_string(),
                kind: CustomTypeKind::Enum,
            },
            cascade: true,
        };
        let statement = "DROP TYPE \"app\".\"status\" CASCADE;";
        let before = drop_plan_revision(&request, &capabilities, statement, None, &[], true);
        // A dependency that appeared after the user reviewed the confirmation
        // must invalidate the plan even though the statement is unchanged.
        let after =
            drop_plan_revision(&request, &capabilities, statement, None, &[dependency("column", "state")], true);
        assert_ne!(before, after);
    }

    #[test]
    fn drop_revision_ignores_dependency_ordering_but_not_identity() {
        let capabilities = postgres_capabilities(Some(160_000), None);
        let request = CustomTypeDropRequest {
            target: CustomTypeIdentity {
                schema: "app".to_string(),
                name: "status".to_string(),
                kind: CustomTypeKind::Enum,
            },
            cascade: false,
        };
        let statement = "DROP TYPE \"app\".\"status\" RESTRICT;";
        let first = vec![dependency("column", "state"), dependency("routine", "f")];
        let reordered = vec![dependency("routine", "f"), dependency("column", "state")];
        assert_eq!(
            drop_plan_revision(&request, &capabilities, statement, None, &first, true),
            drop_plan_revision(&request, &capabilities, statement, None, &reordered, true),
        );
        let different = vec![dependency("column", "other")];
        assert_ne!(
            drop_plan_revision(&request, &capabilities, statement, None, &first, true),
            drop_plan_revision(&request, &capabilities, statement, None, &different, true),
        );
    }

    #[test]
    fn dependency_identity_includes_the_parent_object() {
        let capabilities = postgres_capabilities(Some(160_000), None);
        let request = CustomTypeDropRequest {
            target: CustomTypeIdentity {
                schema: "app".to_string(),
                name: "status".to_string(),
                kind: CustomTypeKind::Enum,
            },
            cascade: true,
        };
        let statement = "DROP TYPE \"app\".\"status\" CASCADE;";
        let orders = vec![dependency_with_parent("column", "state", Some("orders"))];
        let invoices = vec![dependency_with_parent("column", "state", Some("invoices"))];
        assert_ne!(
            drop_plan_revision(&request, &capabilities, statement, None, &orders, true),
            drop_plan_revision(&request, &capabilities, statement, None, &invoices, true),
            "same-schema columns with the same name but different parent tables are different dependencies",
        );
    }

    #[test]
    fn dependency_identity_distinguishes_overloads_recreation_and_delimiters() {
        let mut first = dependency("routine", "f");
        first.catalog_id = Some("1255:100:0".to_string());
        let mut overload = first.clone();
        overload.catalog_id = Some("1255:101:0".to_string());
        assert_ne!(normalized_dependency_keys(&[first]), normalized_dependency_keys(&[overload]));

        let left = dependency_with_parent("column", "c", Some("a|b"));
        let right = dependency_with_parent("column", "b|c", Some("a"));
        assert_ne!(normalized_dependency_keys(&[left]), normalized_dependency_keys(&[right]));
    }

    #[test]
    fn drop_revision_tracks_whether_the_dependency_list_was_complete() {
        let capabilities = postgres_capabilities(Some(160_000), None);
        let request = CustomTypeDropRequest {
            target: CustomTypeIdentity {
                schema: "app".to_string(),
                name: "status".to_string(),
                kind: CustomTypeKind::Enum,
            },
            cascade: true,
        };
        let statement = "DROP TYPE \"app\".\"status\" CASCADE;";
        // "Could not read the dependents" must not hash like "there are none".
        assert_ne!(
            drop_plan_revision(&request, &capabilities, statement, None, &[], true),
            drop_plan_revision(&request, &capabilities, statement, None, &[], false),
        );
    }

    #[test]
    fn drop_revision_changes_when_the_target_was_recreated() {
        let capabilities = postgres_capabilities(Some(160_000), None);
        let request = CustomTypeDropRequest {
            target: CustomTypeIdentity {
                schema: "app".to_string(),
                name: "status".to_string(),
                kind: CustomTypeKind::Enum,
            },
            cascade: false,
        };
        let statement = "DROP TYPE \"app\".\"status\" RESTRICT;";
        let mut original = crate::types::CustomTypeDetails {
            snapshot_revision: None,
            name: "status".to_string(),
            schema: "app".to_string(),
            kind: CustomTypeKind::Enum,
            catalog_id: Some("100".to_string()),
            comment: None,
            members: Vec::new(),
            properties: Default::default(),
            ddl: None,
            owner: Some("owner_a".to_string()),
        };
        let before = drop_plan_revision(&request, &capabilities, statement, Some(&original), &[], true);

        // Same name, same kind and same owner, but a different OID means the
        // original was dropped and recreated after preview.
        original.catalog_id = Some("101".to_string());
        let recreated = drop_plan_revision(&request, &capabilities, statement, Some(&original), &[], true);
        assert_ne!(before, recreated);

        // Complete snapshot coverage also catches ordinary definition changes.
        original.catalog_id = Some("100".to_string());
        original.comment = Some("changed after preview".to_string());
        let altered = drop_plan_revision(&request, &capabilities, statement, Some(&original), &[], true);
        assert_ne!(before, altered);
    }

    #[test]
    fn a_planned_batch_still_splits_into_the_same_statements() {
        let statements = vec![
            "ALTER TYPE \"app\".\"status\" RENAME VALUE 'draft' TO 'pending';".to_string(),
            "ALTER TYPE \"app\".\"status\" ADD VALUE 'archived' AFTER 'published';".to_string(),
        ];
        assert_eq!(assert_plan_splits_into_itself(&statements), Ok(()));
    }

    #[test]
    fn generated_escape_literals_preserve_statement_boundaries() {
        let mut request = create_request();
        request.draft.definition = CustomTypeDraftDefinition::Enum {
            values: [r"a\b", r"\'; SELECT 1; --", r"ends\"]
                .into_iter()
                .map(|value| CustomTypeEnumValueDraft { value: value.into(), original_value: None })
                .collect(),
        };
        request.draft.comment = Some(r"comment \'; SELECT 2; --".into());
        let plan = custom_type_sql::plan_custom_type_change(
            CustomTypeSqlDialect::Postgres,
            None,
            &request,
            &postgres_capabilities(Some(160_000), None),
        );
        assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
        assert_eq!(plan.statements.len(), 2);
        assert_eq!(assert_plan_splits_into_itself(&plan.statements), Ok(()));
    }

    #[test]
    fn generated_escape_string_fragments_preserve_statement_boundaries() {
        let mut request = create_request();
        request.draft.definition = CustomTypeDraftDefinition::Domain {
            base_type: "text".into(),
            collation: None,
            default: Some(r"E'it\'s; --'".into()),
            not_null: false,
            constraints: vec![crate::types::CustomTypeDomainConstraintDraft {
                name: "check_quote".into(),
                original_name: None,
                expression: r"CHECK (VALUE <> e'it\'s)  (; --')".into(),
                validated: Some(false),
            }],
        };
        let plan = custom_type_sql::plan_custom_type_change(
            CustomTypeSqlDialect::Postgres,
            None,
            &request,
            &postgres_capabilities(Some(160_000), None),
        );
        assert!(plan.blocked_changes.is_empty(), "{:?}", plan.blocked_changes);
        assert_eq!(plan.statements.len(), 2);
        assert_eq!(assert_plan_splits_into_itself(&plan.statements), Ok(()));
    }

    #[test]
    fn a_statement_carrying_a_smuggled_terminator_is_refused_at_execution_time() {
        // Simulates a planner regression: even if a fragment check were missed,
        // the executor boundary must refuse the batch rather than run two
        // statements where the plan declared one.
        let statements = vec!["ALTER DOMAIN \"app\".\"email\" SET DEFAULT 0; DROP TABLE app.orders;".to_string()];
        let error = assert_plan_splits_into_itself(&statements).expect_err("should be refused");
        assert!(error.contains("did not match the reviewed plan"), "{error}");
    }

    #[test]
    fn change_revision_covers_the_snapshot_draft_and_capabilities() {
        let capabilities = postgres_capabilities(Some(160_000), None);
        let request = create_request();
        let plan =
            custom_type_sql::plan_custom_type_change(CustomTypeSqlDialect::Postgres, None, &request, &capabilities);
        let base = change_plan_revision(None, &request, &capabilities, &plan);

        let mut changed_draft = request.clone();
        changed_draft.draft.name = "other".to_string();
        let changed_plan = custom_type_sql::plan_custom_type_change(
            CustomTypeSqlDialect::Postgres,
            None,
            &changed_draft,
            &capabilities,
        );
        assert_ne!(base, change_plan_revision(None, &changed_draft, &capabilities, &changed_plan));

        let older = postgres_capabilities(Some(110_000), None);
        let older_plan =
            custom_type_sql::plan_custom_type_change(CustomTypeSqlDialect::Postgres, None, &request, &older);
        assert_ne!(base, change_plan_revision(None, &request, &older, &older_plan));
    }
}
