use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{connection::AppState, db, models::connection::DatabaseType};

mod foreign_key;
pub use foreign_key::*;
mod check;
pub use check::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimaryKeyChange {
    pub schema: String,
    pub table_name: String,
    pub columns: Vec<String>,
    #[serde(default)]
    pub drop_previous_index: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySnapshot {
    pub name: String,
    pub columns: Vec<String>,
    pub enabled: bool,
    pub validated: bool,
    pub deferrable: bool,
    pub initially_deferred: bool,
    pub index_owner: Option<String>,
    pub index_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintChangePreview {
    pub statements: Vec<String>,
    pub revision: String,
    pub current_constraint: Option<KeySnapshot>,
    pub affected_objects: Vec<String>,
    pub recovery_statements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintChangeStep {
    pub sql: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintChangeResult {
    pub success: bool,
    pub steps: Vec<ConstraintChangeStep>,
    pub current_constraint: Option<KeySnapshot>,
    pub refresh_error: Option<String>,
    pub recovery_statements: Vec<String>,
}

#[async_trait]
trait ConstraintSession: Sync {
    fn engine(&self) -> Engine {
        Engine::Oracle
    }
    async fn query(&self, sql: &str) -> Result<db::QueryResult, String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
enum Engine {
    Oracle,
    OceanBaseOracle,
}

struct CoreSession<'a> {
    state: &'a AppState,
    connection_id: &'a str,
    database: &'a str,
    engine: Engine,
}

#[async_trait]
impl ConstraintSession for CoreSession<'_> {
    fn engine(&self) -> Engine {
        self.engine
    }
    async fn query(&self, sql: &str) -> Result<db::QueryResult, String> {
        crate::query::execute_sql_statement(self.state, self.connection_id, self.database, sql, None, None).await
    }
}

pub async fn preview_primary_key_change(
    state: &AppState,
    connection_id: &str,
    database: &str,
    change: PrimaryKeyChange,
) -> Result<ConstraintChangePreview, String> {
    let engine = require_engine(state, connection_id).await?;
    preview(&CoreSession { state, connection_id, database, engine }, &change).await
}

pub async fn apply_primary_key_change(
    state: &AppState,
    connection_id: &str,
    database: &str,
    change: PrimaryKeyChange,
    revision: &str,
) -> Result<ConstraintChangeResult, String> {
    let engine = require_engine(state, connection_id).await?;
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    crate::query::check_read_only_for_connection(state, &pool_key, "ALTER TABLE").await?;
    let result = apply(&CoreSession { state, connection_id, database, engine }, &change, revision).await;
    crate::object_cache::invalidate_connection_object_cache(&state.storage, connection_id).await;
    result
}

async fn require_engine(state: &AppState, connection_id: &str) -> Result<Engine, String> {
    let configs = state.configs.read().await;
    match configs.get(connection_id).map(|config| config.db_type) {
        Some(DatabaseType::Oracle) => Ok(Engine::Oracle),
        Some(DatabaseType::OceanBaseOracle) => Ok(Engine::OceanBaseOracle),
        _ => Err("This primary-key editor requires Oracle or OceanBase Oracle.".into()),
    }
}

fn identifier(value: &str) -> Result<String, String> {
    if value.is_empty() || value.contains('\0') {
        return Err("An identifier is empty or contains a NUL character.".into());
    }
    Ok(format!("\"{}\"", value.replace('"', "\"\"")))
}

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn table(change: &PrimaryKeyChange) -> Result<String, String> {
    Ok(format!("{}.{}", identifier(&change.schema)?, identifier(&change.table_name)?))
}

fn text(row: &[serde_json::Value], column: usize) -> Result<String, String> {
    row.get(column)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "The database returned incomplete constraint metadata.".into())
}

fn optional_text(row: &[serde_json::Value], column: usize) -> Result<Option<String>, String> {
    match row.get(column) {
        Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(value)) => Ok(Some(value.clone())),
        _ => Err("The database returned incomplete index metadata.".into()),
    }
}

fn flag(row: &[serde_json::Value], column: usize, yes: &str, no: &str) -> Result<bool, String> {
    match text(row, column)?.as_str() {
        value if value == yes => Ok(true),
        value if value == no => Ok(false),
        _ => Err("Constraint state is unknown; editing is not safe.".into()),
    }
}

async fn count(session: &impl ConstraintSession, sql: &str) -> Result<u64, String> {
    let result = read(session, sql).await?;
    let value =
        result.rows.first().and_then(|row| row.first()).ok_or("The metadata or data check returned no result.")?;
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        .ok_or_else(|| "The metadata or data check returned an invalid count.".into())
}

async fn read(session: &impl ConstraintSession, sql: &str) -> Result<db::QueryResult, String> {
    let result = session.query(sql).await?;
    if result.truncated || result.has_more {
        return Err("The metadata or preflight result is incomplete; no DDL was executed.".into());
    }
    Ok(result)
}

async fn read_key(session: &impl ConstraintSession, change: &PrimaryKeyChange) -> Result<Option<KeySnapshot>, String> {
    let sql = format!(
        "SELECT c.CONSTRAINT_NAME,c.STATUS,c.VALIDATED,c.DEFERRABLE,c.DEFERRED,c.INDEX_OWNER,c.INDEX_NAME,k.COLUMN_NAME \
         FROM ALL_CONSTRAINTS c LEFT JOIN ALL_CONS_COLUMNS k ON k.OWNER=c.OWNER AND k.CONSTRAINT_NAME=c.CONSTRAINT_NAME \
         AND k.TABLE_NAME=c.TABLE_NAME WHERE c.OWNER={} AND c.TABLE_NAME={} AND c.CONSTRAINT_TYPE='P' ORDER BY k.POSITION",
        literal(&change.schema), literal(&change.table_name)
    );
    let result = read(session, &sql).await?;
    let Some(first) = result.rows.first() else { return Ok(None) };
    let name = text(first, 0)?;
    let mut columns = Vec::new();
    for row in &result.rows {
        if text(row, 0)? != name {
            return Err("Multiple primary keys were returned.".into());
        }
        columns.push(text(row, 7)?);
    }
    Ok(Some(KeySnapshot {
        name,
        columns,
        enabled: flag(first, 1, "ENABLED", "DISABLED")?,
        validated: flag(first, 2, "VALIDATED", "NOT VALIDATED")?,
        deferrable: flag(first, 3, "DEFERRABLE", "NOT DEFERRABLE")?,
        initially_deferred: flag(first, 4, "DEFERRED", "IMMEDIATE")?,
        index_owner: optional_text(first, 5)?,
        index_name: optional_text(first, 6)?,
    }))
}

fn add_key_sql(change: &PrimaryKeyChange, key: &KeySnapshot) -> Result<String, String> {
    let columns = key.columns.iter().map(|column| identifier(column)).collect::<Result<Vec<_>, _>>()?.join(", ");
    let index = match (&key.index_owner, &key.index_name) {
        (Some(owner), Some(name)) => format!(" USING INDEX {}.{}", identifier(owner)?, identifier(name)?),
        (None, None) => String::new(),
        _ => return Err("The supporting index is only partially identified.".into()),
    };
    Ok(format!(
        "ALTER TABLE {} ADD CONSTRAINT {} PRIMARY KEY ({}) {} INITIALLY {}{} {} {}",
        table(change)?,
        identifier(&key.name)?,
        columns,
        if key.deferrable { "DEFERRABLE" } else { "NOT DEFERRABLE" },
        if key.initially_deferred { "DEFERRED" } else { "IMMEDIATE" },
        index,
        if key.enabled { "ENABLE" } else { "DISABLE" },
        if key.validated { "VALIDATE" } else { "NOVALIDATE" }
    ))
}

async fn preview(
    session: &impl ConstraintSession,
    change: &PrimaryKeyChange,
) -> Result<ConstraintChangePreview, String> {
    let oceanbase = session.engine() == Engine::OceanBaseOracle;
    if oceanbase && change.drop_previous_index {
        return Err("OceanBase manages primary-key storage through ALTER TABLE; removing an Oracle supporting index is not supported.".into());
    }
    let target = table(change)?;
    let owner = literal(&change.schema);
    let name = literal(&change.table_name);
    let mut distinct = std::collections::HashSet::new();
    for column in &change.columns {
        identifier(column)?;
        if !distinct.insert(column) {
            return Err("Primary-key columns must be distinct.".into());
        }
    }
    if count(
        session,
        &format!("SELECT COUNT(*) FROM ALL_TABLES WHERE OWNER={owner} AND TABLE_NAME={name} AND IOT_TYPE IS NULL"),
    )
    .await?
        != 1
    {
        return Err("The table is not visible or its primary key cannot be replaced (index-organized table).".into());
    }
    let current = read_key(session, change).await?;
    let mut affected = vec![target.clone()];
    let mut evidence = Vec::new();
    let mut index_restore = None;
    // Include every supporting-index change in the revision. A leftover index
    // from a partial attempt then invalidates the old plan and gets a new name
    // on a fresh preview instead of being overwritten or repeatedly recreated.
    for sql in [
        format!("SELECT OWNER,INDEX_NAME,INDEX_TYPE,UNIQUENESS,STATUS FROM ALL_INDEXES WHERE TABLE_OWNER={owner} AND TABLE_NAME={name} ORDER BY OWNER,INDEX_NAME"),
        format!("SELECT INDEX_OWNER,INDEX_NAME,COLUMN_NAME,COLUMN_POSITION,DESCEND FROM ALL_IND_COLUMNS WHERE TABLE_OWNER={owner} AND TABLE_NAME={name} ORDER BY INDEX_OWNER,INDEX_NAME,COLUMN_POSITION"),
    ] {
        evidence.push(serde_json::to_string(&read(session, &sql).await?.rows).map_err(|error| error.to_string())?);
    }
    if let Some(key) = &current {
        affected.push(format!("Constraint {}", key.name));
        // ALL_CONSTRAINTS is filtered by visibility and cannot prove there are no
        // cross-schema references. Failure to read the complete inventory blocks DDL.
        let referenced_keys = if oceanbase {
            format!("IN (SELECT CONSTRAINT_NAME FROM DBA_CONSTRAINTS WHERE OWNER={owner} AND TABLE_NAME={name} AND CONSTRAINT_TYPE IN ('P','U'))")
        } else {
            format!("={}", literal(&key.name))
        };
        let references = count(session, &format!(
            "SELECT COUNT(*) FROM DBA_CONSTRAINTS WHERE CONSTRAINT_TYPE='R' AND R_OWNER={owner} AND R_CONSTRAINT_NAME {referenced_keys}"
        )).await.map_err(|error| format!("Cannot confirm all referencing foreign keys; access to DBA_CONSTRAINTS is required. No DDL was executed. {error}"))?;
        if references != 0 {
            return Err(format!("{} foreign key(s) reference {}. Resolve these dependencies before changing the primary key; no constraints were dropped.", references, key.name));
        }
        if oceanbase {
            if key.index_owner.is_some() != key.index_name.is_some() {
                return Err("The OceanBase primary-key index metadata is incomplete.".into());
            }
            if !key.enabled || !key.validated || key.deferrable || key.initially_deferred {
                return Err(
                    "This OceanBase primary-key state cannot be preserved by MODIFY PRIMARY KEY; no DDL was executed."
                        .into(),
                );
            }
            affected.push(format!("OceanBase manages primary-key storage; dictionary index: {}.{}. Separate indexes are not explicitly removed.", key.index_owner.as_deref().unwrap_or("<none>"), key.index_name.as_deref().unwrap_or("<none>")));
        } else {
            match (&key.index_owner, &key.index_name) {
                (Some(index_owner), Some(index_name)) => {
                    let index = read(session, &format!(
                    "SELECT INDEX_TYPE,UNIQUENESS,STATUS,TABLE_OWNER,TABLE_NAME FROM ALL_INDEXES WHERE OWNER={} AND INDEX_NAME={}",
                    literal(index_owner), literal(index_name))).await?;
                    let row = index.rows.first().ok_or("The supporting index is not visible; no DDL was executed.")?;
                    if text(row, 3)? != change.schema || text(row, 4)? != change.table_name {
                        return Err("The supporting index does not belong to the selected table.".into());
                    }
                    evidence.push(serde_json::to_string(&index.rows).map_err(|error| error.to_string())?);
                    if change.drop_previous_index {
                        let other_users = count(session, &format!(
                        "SELECT COUNT(*) FROM DBA_CONSTRAINTS WHERE INDEX_OWNER={} AND INDEX_NAME={} AND NOT (OWNER={owner} AND CONSTRAINT_NAME={})",
                        literal(index_owner), literal(index_name), literal(&key.name))).await?;
                        if other_users != 0 {
                            return Err("The original index supports another constraint and cannot be removed.".into());
                        }
                        let ddl = read(
                            session,
                            &format!(
                                "SELECT DBMS_METADATA.GET_DDL('INDEX',{}, {}) FROM DUAL",
                                literal(index_name),
                                literal(index_owner)
                            ),
                        )
                        .await?;
                        let source = text(ddl.rows.first().ok_or("The original index definition is unavailable.")?, 0)?;
                        if source.trim().is_empty() {
                            return Err("The original index definition is empty.".into());
                        }
                        evidence.push(source.clone());
                        index_restore = Some(source);
                        affected.push(format!("Remove index {}.{} after replacing the key; the old index's uniqueness will no longer be enforced", index_owner, index_name));
                    } else {
                        affected.push(format!(
                            "Preserve index {}.{} (its uniqueness remains in effect)",
                            index_owner, index_name
                        ));
                    }
                }
                (None, None) if !key.enabled => {}
                _ => return Err("The supporting index metadata is incomplete.".into()),
            }
        }
    }
    if !change.columns.is_empty() {
        let names = change.columns.iter().map(|column| literal(column)).collect::<Vec<_>>().join(",");
        if count(session, &format!("SELECT COUNT(*) FROM ALL_TAB_COLUMNS WHERE OWNER={owner} AND TABLE_NAME={name} AND COLUMN_NAME IN ({names})")).await? != change.columns.len() as u64 {
            return Err("One or more candidate columns are not visible in the table.".into());
        }
        let columns = change.columns.iter().map(|column| identifier(column)).collect::<Result<Vec<_>, _>>()?;
        let nulls = columns.iter().map(|column| format!("{column} IS NULL")).collect::<Vec<_>>().join(" OR ");
        if count(session, &format!("SELECT COUNT(*) FROM {target} WHERE ({nulls}) AND ROWNUM=1")).await? != 0 {
            return Err("Candidate primary-key columns contain NULL; the original constraint was preserved.".into());
        }
        if count(
            session,
            &format!(
                "SELECT COUNT(*) FROM (SELECT {} FROM {target} GROUP BY {} HAVING COUNT(*)>1) WHERE ROWNUM=1",
                columns.join(","),
                columns.join(",")
            ),
        )
        .await?
            != 0
        {
            return Err(
                "Candidate primary-key columns contain duplicate keys; the original constraint was preserved.".into()
            );
        }
    }
    let ddl_stamp = read(session, &format!("SELECT OBJECT_ID,TO_CHAR(LAST_DDL_TIME,'YYYYMMDDHH24MISS') FROM ALL_OBJECTS WHERE OWNER={owner} AND OBJECT_NAME={name} AND OBJECT_TYPE='TABLE'")).await?;
    if ddl_stamp.rows.len() != 1 {
        return Err("Cannot identify the table revision.".into());
    }
    let revision = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(session.engine(), change, &current, &evidence, &ddl_stamp.rows))
                .map_err(|error| error.to_string())?
        )
    );
    let mut statements = Vec::new();
    let mut recovery_statements: Vec<String> = index_restore.into_iter().collect();
    recovery_statements.extend(
        current
            .as_ref()
            .map(|key| {
                if oceanbase {
                    oceanbase_add_key_sql(change, &key.name, &key.columns)
                } else {
                    add_key_sql(change, key)
                }
            })
            .transpose()?,
    );
    if current.as_ref().map(|key| key.columns.as_slice()).unwrap_or_default() == change.columns.as_slice() {
        return Ok(ConstraintChangePreview {
            statements,
            revision,
            current_constraint: current,
            affected_objects: affected,
            recovery_statements,
        });
    }
    if oceanbase {
        statements.push(if change.columns.is_empty() {
            format!("ALTER TABLE {target} DROP PRIMARY KEY")
        } else if current.is_some() {
            format!(
                "ALTER TABLE {target} MODIFY PRIMARY KEY ({})",
                change.columns.iter().map(|column| identifier(column)).collect::<Result<Vec<_>, _>>()?.join(", ")
            )
        } else {
            let constraint_name = format!("DBX_PK_{}", &revision[..22]);
            if count(
                session,
                &format!(
                    "SELECT COUNT(*) FROM ALL_CONSTRAINTS WHERE OWNER={owner} AND CONSTRAINT_NAME={}",
                    literal(&constraint_name)
                ),
            )
            .await?
                != 0
            {
                return Err("The planned primary-key name already exists. Refresh before retrying.".into());
            }
            oceanbase_add_key_sql(change, &constraint_name, &change.columns)?
        });
        return Ok(ConstraintChangePreview {
            statements,
            revision,
            current_constraint: current,
            affected_objects: affected,
            recovery_statements,
        });
    }
    let mut candidate = None;
    if !change.columns.is_empty() {
        let index_name = format!("DBX_PK_{}", &revision[..22]);
        if count(
            session,
            &format!("SELECT COUNT(*) FROM ALL_OBJECTS WHERE OWNER={owner} AND OBJECT_NAME={}", literal(&index_name)),
        )
        .await?
            != 0
        {
            return Err(
                "The planned supporting-index name already exists. Refresh the structure before retrying.".into()
            );
        }
        let key = KeySnapshot {
            name: current
                .as_ref()
                .map(|key| key.name.clone())
                .unwrap_or_else(|| format!("DBX_PK_{}", &revision[22..44])),
            columns: change.columns.clone(),
            enabled: current.as_ref().map(|key| key.enabled).unwrap_or(true),
            validated: current.as_ref().map(|key| key.validated).unwrap_or(true),
            deferrable: current.as_ref().is_some_and(|key| key.deferrable),
            initially_deferred: current.as_ref().is_some_and(|key| key.initially_deferred),
            index_owner: Some(change.schema.clone()),
            index_name: Some(index_name.clone()),
        };
        let columns = change.columns.iter().map(|column| identifier(column)).collect::<Result<Vec<_>, _>>()?.join(", ");
        // Build the replacement index before touching the original constraint.
        statements.push(format!(
            "CREATE {}INDEX {}.{} ON {target} ({columns})",
            if key.deferrable { "" } else { "UNIQUE " },
            identifier(&change.schema)?,
            identifier(&index_name)?
        ));
        affected.push(format!("Create supporting index {}.{}", change.schema, index_name));
        candidate = Some(key);
    }
    if let Some(key) = &current {
        statements.push(format!("ALTER TABLE {target} DROP CONSTRAINT {} KEEP INDEX", identifier(&key.name)?));
    }
    if let Some(key) = candidate {
        statements.push(add_key_sql(change, &key)?);
    }
    if change.drop_previous_index {
        if let Some(key) = &current {
            if let (Some(owner), Some(name)) = (&key.index_owner, &key.index_name) {
                statements.push(format!("DROP INDEX {}.{}", identifier(owner)?, identifier(name)?));
            }
        }
    }
    Ok(ConstraintChangePreview {
        statements,
        revision,
        current_constraint: current,
        affected_objects: affected,
        recovery_statements,
    })
}

async fn apply(
    session: &impl ConstraintSession,
    change: &PrimaryKeyChange,
    revision: &str,
) -> Result<ConstraintChangeResult, String> {
    let plan = preview(session, change).await?;
    if plan.revision != revision {
        return Err(
            "The table or constraint changed after preview. Refresh and review a new plan; no DDL was executed.".into(),
        );
    }
    let mut steps = Vec::new();
    for sql in &plan.statements {
        let guarded = guard_step(session, change, &plan, sql).await;
        let executed = match guarded {
            Ok(()) => session.query(sql).await.map(|_| ()),
            Err(error) => Err(error),
        };
        let success = executed.is_ok();
        steps.push(ConstraintChangeStep { sql: sql.clone(), success, error: executed.err() });
        if !success {
            break;
        }
    }
    // Oracle DDL commits implicitly. Return the actual readback even on failure;
    // never label a partially executed plan as rolled back or replay it blindly.
    let readback = async {
        if count(
            session,
            &format!(
                "SELECT COUNT(*) FROM ALL_TABLES WHERE OWNER={} AND TABLE_NAME={}",
                literal(&change.schema),
                literal(&change.table_name)
            ),
        )
        .await?
            != 1
        {
            return Err("The target table is no longer visible; its constraint state is unknown.".to_string());
        }
        read_key(session, change).await
    }
    .await;
    let (current, mut refresh_error) = match readback {
        Ok(current) => (current, None),
        Err(error) => (None, Some(error)),
    };
    let all_executed = steps.len() == plan.statements.len() && steps.iter().all(|step| step.success);
    let desired = current.as_ref().map(|key| key.columns.as_slice()).unwrap_or_default() == change.columns.as_slice()
        && current.as_ref().is_none_or(|key| {
            key.enabled == plan.current_constraint.as_ref().map(|old| old.enabled).unwrap_or(true)
                && key.validated == plan.current_constraint.as_ref().map(|old| old.validated).unwrap_or(true)
                && key.deferrable == plan.current_constraint.as_ref().is_some_and(|old| old.deferrable)
                && key.initially_deferred == plan.current_constraint.as_ref().is_some_and(|old| old.initially_deferred)
        });
    if all_executed && refresh_error.is_none() && !desired {
        refresh_error = Some("DDL finished but the dictionary does not match the requested primary key.".into());
    }
    let mut recovery = if refresh_error.is_none() && current.is_none() { plan.recovery_statements } else { Vec::new() };
    if recovery.len() > 1 {
        if let Some(key) = &plan.current_constraint {
            if let (Some(owner), Some(name)) = (&key.index_owner, &key.index_name) {
                match count(
                    session,
                    &format!(
                        "SELECT COUNT(*) FROM ALL_INDEXES WHERE OWNER={} AND INDEX_NAME={}",
                        literal(owner),
                        literal(name)
                    ),
                )
                .await
                {
                    Ok(1) => {
                        recovery.remove(0);
                    }
                    Ok(0) => {}
                    Ok(_) => {
                        refresh_error =
                            Some("The original index state is ambiguous; recovery must be reviewed.".into());
                        recovery.clear();
                    }
                    Err(error) => {
                        refresh_error = Some(format!("Cannot confirm the original index state for recovery: {error}"));
                        recovery.clear();
                    }
                }
            }
        }
    }
    Ok(ConstraintChangeResult {
        success: all_executed && desired && refresh_error.is_none(),
        steps,
        current_constraint: current,
        refresh_error,
        recovery_statements: recovery,
    })
}

async fn guard_step(
    session: &impl ConstraintSession,
    change: &PrimaryKeyChange,
    plan: &ConstraintChangePreview,
    sql: &str,
) -> Result<(), String> {
    let Some(original) = &plan.current_constraint else { return Ok(()) };
    if session.engine() == Engine::OceanBaseOracle
        || sql == format!("ALTER TABLE {} DROP CONSTRAINT {} KEEP INDEX", table(change)?, identifier(&original.name)?)
    {
        if read_key(session, change).await?.as_ref() != Some(original) {
            return Err("The original constraint changed during execution. Remaining DDL was stopped.".into());
        }
    }
    if let (Some(owner), Some(name)) = (&original.index_owner, &original.index_name) {
        if sql == format!("DROP INDEX {}.{}", identifier(owner)?, identifier(name)?) {
            if count(
                session,
                &format!(
                    "SELECT COUNT(*) FROM DBA_CONSTRAINTS WHERE INDEX_OWNER={} AND INDEX_NAME={}",
                    literal(owner),
                    literal(name)
                ),
            )
            .await?
                != 0
            {
                return Err("The original index is now used by a constraint. It was not removed.".into());
            }
            let ddl = read(
                session,
                &format!("SELECT DBMS_METADATA.GET_DDL('INDEX',{}, {}) FROM DUAL", literal(name), literal(owner)),
            )
            .await?;
            let actual = text(ddl.rows.first().ok_or("The original index is no longer visible.")?, 0)?;
            if plan.recovery_statements.first() != Some(&actual) {
                return Err("The original index changed during execution. It was not removed.".into());
            }
        }
    }
    Ok(())
}

fn oceanbase_add_key_sql(change: &PrimaryKeyChange, name: &str, columns: &[String]) -> Result<String, String> {
    Ok(format!(
        "ALTER TABLE {} ADD CONSTRAINT {} PRIMARY KEY ({})",
        table(change)?,
        identifier(name)?,
        columns.iter().map(|column| identifier(column)).collect::<Result<Vec<_>, _>>()?.join(", ")
    ))
}

#[cfg(test)]
mod tests;
