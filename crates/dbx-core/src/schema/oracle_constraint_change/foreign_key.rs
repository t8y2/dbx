use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDefinition {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_schema: String,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    pub delete_rule: DeleteRule,
    pub enabled: bool,
    pub validated: bool,
    pub deferrable: bool,
    pub initially_deferred: bool,
    pub rely: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeleteRule {
    #[serde(rename = "NO ACTION")]
    NoAction,
    #[serde(rename = "CASCADE")]
    Cascade,
    #[serde(rename = "SET NULL")]
    SetNull,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyChange {
    pub schema: String,
    pub table_name: String,
    pub original_name: Option<String>,
    pub desired: Option<ForeignKeyDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyChangePreview {
    pub statements: Vec<String>,
    pub revision: String,
    pub current_constraint: Option<ForeignKeyDefinition>,
    pub affected_objects: Vec<String>,
    pub recovery_statements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyChangeResult {
    pub success: bool,
    pub steps: Vec<ConstraintChangeStep>,
    pub current_constraint: Option<ForeignKeyDefinition>,
    pub original_constraint: Option<ForeignKeyDefinition>,
    pub refresh_error: Option<String>,
    pub recovery_statements: Vec<String>,
}

pub async fn preview_foreign_key_change(
    state: &AppState,
    connection_id: &str,
    database: &str,
    change: ForeignKeyChange,
) -> Result<ForeignKeyChangePreview, String> {
    let engine = require_engine(state, connection_id).await?;
    preview_foreign_key(&CoreSession { state, connection_id, database, engine }, &change).await
}

pub async fn apply_foreign_key_change(
    state: &AppState,
    connection_id: &str,
    database: &str,
    change: ForeignKeyChange,
    revision: &str,
) -> Result<ForeignKeyChangeResult, String> {
    let engine = require_engine(state, connection_id).await?;
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    crate::query::check_read_only_for_connection(state, &pool_key, "ALTER TABLE").await?;
    let result = apply_foreign_key(&CoreSession { state, connection_id, database, engine }, &change, revision).await;
    crate::object_cache::invalidate_connection_object_cache(&state.storage, connection_id).await;
    result
}

pub(super) fn qualified(owner: &str, name: &str) -> Result<String, String> {
    Ok(format!("{}.{}", identifier(owner)?, identifier(name)?))
}
pub(super) fn column_list(columns: &[String]) -> Result<String, String> {
    let mut seen = std::collections::HashSet::new();
    if columns.is_empty() || columns.iter().any(|column| !seen.insert(column)) {
        return Err("Constraint columns must be nonempty and distinct.".into());
    }
    Ok(columns.iter().map(|column| identifier(column)).collect::<Result<Vec<_>, _>>()?.join(", "))
}

async fn read_foreign_key(
    session: &impl ConstraintSession,
    change: &ForeignKeyChange,
    name: &str,
) -> Result<Option<ForeignKeyDefinition>, String> {
    let result = read(session, &format!(
        "SELECT c.CONSTRAINT_NAME,c.STATUS,c.VALIDATED,c.DEFERRABLE,c.DEFERRED,c.DELETE_RULE,c.R_OWNER,p.TABLE_NAME,k.COLUMN_NAME,r.COLUMN_NAME,COALESCE(c.RELY,'NORELY') \
         FROM ALL_CONSTRAINTS c LEFT JOIN ALL_CONSTRAINTS p ON p.OWNER=c.R_OWNER AND p.CONSTRAINT_NAME=c.R_CONSTRAINT_NAME \
         LEFT JOIN ALL_CONS_COLUMNS k ON k.OWNER=c.OWNER AND k.CONSTRAINT_NAME=c.CONSTRAINT_NAME AND k.TABLE_NAME=c.TABLE_NAME \
         LEFT JOIN ALL_CONS_COLUMNS r ON r.OWNER=p.OWNER AND r.CONSTRAINT_NAME=p.CONSTRAINT_NAME AND r.TABLE_NAME=p.TABLE_NAME AND r.POSITION=k.POSITION \
         WHERE c.OWNER={} AND c.TABLE_NAME={} AND c.CONSTRAINT_NAME={} AND c.CONSTRAINT_TYPE='R' ORDER BY k.POSITION",
        literal(&change.schema), literal(&change.table_name), literal(name))).await?;
    let Some(first) = result.rows.first() else { return Ok(None) };
    let delete_rule = match text(first, 5)?.as_str() {
        "NO ACTION" => DeleteRule::NoAction,
        "CASCADE" => DeleteRule::Cascade,
        "SET NULL" => DeleteRule::SetNull,
        _ => return Err("Unknown foreign-key delete rule.".into()),
    };
    let definition = ForeignKeyDefinition {
        name: text(first, 0)?,
        columns: result.rows.iter().map(|row| text(row, 8)).collect::<Result<_, _>>()?,
        referenced_schema: text(first, 6)?,
        referenced_table: text(first, 7)?,
        referenced_columns: result.rows.iter().map(|row| text(row, 9)).collect::<Result<_, _>>()?,
        delete_rule,
        enabled: flag(first, 1, "ENABLED", "DISABLED")?,
        validated: flag(first, 2, "VALIDATED", "NOT VALIDATED")?,
        deferrable: flag(first, 3, "DEFERRABLE", "NOT DEFERRABLE")?,
        initially_deferred: flag(first, 4, "DEFERRED", "IMMEDIATE")?,
        rely: flag(first, 10, "RELY", "NORELY")?,
    };
    column_list(&definition.columns)?;
    column_list(&definition.referenced_columns)?;
    Ok(Some(definition))
}

fn foreign_key_sql(engine: Engine, change: &ForeignKeyChange, key: &ForeignKeyDefinition) -> Result<String, String> {
    if key.columns.len() != key.referenced_columns.len() {
        return Err("Source and referenced column counts differ.".into());
    }
    if key.initially_deferred && !key.deferrable {
        return Err("An initially deferred constraint must be deferrable.".into());
    }
    if engine == Engine::OceanBaseOracle && (key.deferrable || key.initially_deferred) {
        return Err("OceanBase Oracle does not support deferred foreign keys.".into());
    }
    let deferred = if engine == Engine::Oracle {
        format!(
            " {} INITIALLY {}",
            if key.deferrable { "DEFERRABLE" } else { "NOT DEFERRABLE" },
            if key.initially_deferred { "DEFERRED" } else { "IMMEDIATE" }
        )
    } else {
        String::new()
    };
    let deferred = format!("{deferred}{}", if key.rely { " RELY" } else { "" });
    let delete = match key.delete_rule {
        DeleteRule::NoAction => "",
        DeleteRule::Cascade => " ON DELETE CASCADE",
        DeleteRule::SetNull => " ON DELETE SET NULL",
    };
    Ok(format!(
        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}){delete}{deferred} {} {}",
        qualified(&change.schema, &change.table_name)?,
        identifier(&key.name)?,
        column_list(&key.columns)?,
        qualified(&key.referenced_schema, &key.referenced_table)?,
        column_list(&key.referenced_columns)?,
        if key.enabled { "ENABLE" } else { "DISABLE" },
        if key.validated { "VALIDATE" } else { "NOVALIDATE" }
    ))
}

pub(super) async fn require_table(
    session: &impl ConstraintSession,
    owner: &str,
    name: &str,
) -> Result<Vec<Vec<serde_json::Value>>, String> {
    if count(
        session,
        &format!("SELECT COUNT(*) FROM ALL_TABLES WHERE OWNER={} AND TABLE_NAME={}", literal(owner), literal(name)),
    )
    .await?
        != 1
    {
        return Err("A source or referenced table is not visible.".into());
    }
    let result = read(session, &format!("SELECT OBJECT_ID,TO_CHAR(LAST_DDL_TIME,'YYYYMMDDHH24MISS') FROM ALL_OBJECTS WHERE OWNER={} AND OBJECT_NAME={} AND OBJECT_TYPE='TABLE'", literal(owner), literal(name))).await?;
    if result.rows.len() != 1 {
        return Err("A table revision is unavailable.".into());
    }
    Ok(result.rows)
}

pub(super) async fn require_alter(
    session: &impl ConstraintSession,
    owner: &str,
    table_name: &str,
    user: &str,
) -> Result<(), String> {
    if owner == user {
        return Ok(());
    }
    if count(session, "SELECT COUNT(*) FROM SESSION_PRIVS WHERE PRIVILEGE='ALTER ANY TABLE'").await? > 0 {
        return Ok(());
    }
    if count(session, &format!("SELECT COUNT(*) FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA={} AND TABLE_NAME={} AND PRIVILEGE='ALTER' AND (GRANTEE IN ({},'PUBLIC') OR GRANTEE IN (SELECT ROLE FROM SESSION_ROLES))", literal(owner), literal(table_name), literal(user))).await? == 0 { return Err("Cannot confirm ALTER privilege on the source table.".into()); }
    Ok(())
}

async fn check_reference(
    session: &impl ConstraintSession,
    change: &ForeignKeyChange,
    key: &ForeignKeyDefinition,
    user: &str,
    check_data: bool,
) -> Result<Vec<Vec<serde_json::Value>>, String> {
    let mut evidence = require_table(session, &key.referenced_schema, &key.referenced_table).await?;
    let mut column_types = Vec::new();
    for (owner, name, columns) in [
        (&change.schema, &change.table_name, &key.columns),
        (&key.referenced_schema, &key.referenced_table, &key.referenced_columns),
    ] {
        column_list(columns)?;
        let names = columns.iter().map(|column| literal(column)).collect::<Vec<_>>().join(",");
        if count(
            session,
            &format!(
                "SELECT COUNT(*) FROM ALL_TAB_COLUMNS WHERE OWNER={} AND TABLE_NAME={} AND COLUMN_NAME IN ({names})",
                literal(owner),
                literal(name)
            ),
        )
        .await?
            != columns.len() as u64
        {
            return Err("A source or referenced column is not visible.".into());
        }
        let metadata = read(session, &format!("SELECT COLUMN_NAME,DATA_TYPE,DATA_TYPE_OWNER,CHARACTER_SET_NAME FROM ALL_TAB_COLUMNS WHERE OWNER={} AND TABLE_NAME={} AND COLUMN_NAME IN ({names}) ORDER BY COLUMN_ID", literal(owner), literal(name))).await?;
        let mut types = std::collections::BTreeMap::new();
        for row in &metadata.rows {
            types.insert(text(row, 0)?, (text(row, 1)?, optional_text(row, 2)?, optional_text(row, 3)?));
        }
        column_types.push(
            columns
                .iter()
                .map(|column| {
                    types.get(column).cloned().ok_or_else(|| "Column type metadata is incomplete.".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?,
        );
        evidence.extend(metadata.rows);
    }
    if column_types[0] != column_types[1] {
        return Err("Source and referenced column types or character sets differ; compatibility cannot be confirmed before changing the foreign key.".into());
    }
    let keys = read(session, &format!("SELECT c.CONSTRAINT_NAME,c.STATUS,c.DEFERRABLE,k.COLUMN_NAME FROM ALL_CONSTRAINTS c JOIN ALL_CONS_COLUMNS k ON k.OWNER=c.OWNER AND k.CONSTRAINT_NAME=c.CONSTRAINT_NAME AND k.TABLE_NAME=c.TABLE_NAME WHERE c.OWNER={} AND c.TABLE_NAME={} AND c.CONSTRAINT_TYPE IN ('P','U') ORDER BY c.CONSTRAINT_NAME,k.POSITION", literal(&key.referenced_schema), literal(&key.referenced_table))).await?;
    let mut candidates: std::collections::BTreeMap<String, (bool, Vec<String>)> = std::collections::BTreeMap::new();
    for row in &keys.rows {
        let eligible = text(row, 1)? == "ENABLED" && text(row, 2)? == "NOT DEFERRABLE";
        let entry = candidates.entry(text(row, 0)?).or_insert((eligible, Vec::new()));
        entry.0 &= eligible;
        entry.1.push(text(row, 3)?);
    }
    if !candidates.values().any(|(eligible, columns)| *eligible && columns == &key.referenced_columns) {
        return Err("The referenced columns do not match a visible enabled nondeferrable primary or unique constraint in order.".into());
    }
    evidence.extend(keys.rows);
    if key.referenced_schema != user {
        let grants = count(session, &format!("SELECT COUNT(*) FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA={} AND TABLE_NAME={} AND PRIVILEGE='REFERENCES' AND GRANTEE IN ({},'PUBLIC')", literal(&key.referenced_schema), literal(&key.referenced_table), literal(user))).await?;
        if grants == 0 {
            for column in &key.referenced_columns {
                if count(session, &format!("SELECT COUNT(*) FROM ALL_COL_PRIVS WHERE TABLE_SCHEMA={} AND TABLE_NAME={} AND COLUMN_NAME={} AND PRIVILEGE='REFERENCES' AND GRANTEE IN ({},'PUBLIC')", literal(&key.referenced_schema), literal(&key.referenced_table), literal(column), literal(user))).await? == 0 { return Err("Cannot confirm a direct REFERENCES grant on every referenced column.".into()); }
            }
        }
    }
    if check_data && key.validated {
        let not_null = key
            .columns
            .iter()
            .map(|column| identifier(column).map(|column| format!("s.{column} IS NOT NULL")))
            .collect::<Result<Vec<_>, _>>()?
            .join(" AND ");
        let equality = key
            .columns
            .iter()
            .zip(&key.referenced_columns)
            .map(|(source, target)| Ok(format!("s.{}=p.{}", identifier(source)?, identifier(target)?)))
            .collect::<Result<Vec<_>, String>>()?
            .join(" AND ");
        if count(session, &format!("SELECT COUNT(*) FROM {} s WHERE {not_null} AND NOT EXISTS (SELECT 1 FROM {} p WHERE {equality}) AND ROWNUM=1", qualified(&change.schema, &change.table_name)?, qualified(&key.referenced_schema, &key.referenced_table)?)).await? != 0 { return Err("Existing rows violate the proposed foreign key; no DDL was executed.".into()); }
    }
    Ok(evidence)
}

async fn preview_foreign_key(
    session: &impl ConstraintSession,
    change: &ForeignKeyChange,
) -> Result<ForeignKeyChangePreview, String> {
    let target = qualified(&change.schema, &change.table_name)?;
    if change.original_name.is_none() && change.desired.is_none() {
        return Err("No foreign-key change was requested.".into());
    }
    let mut evidence = require_table(session, &change.schema, &change.table_name).await?;
    let identity = read(session, "SELECT USER FROM DUAL").await?;
    let user = text(identity.rows.first().ok_or("Current database user is unavailable.")?, 0)?;
    require_alter(session, &change.schema, &change.table_name, &user).await?;
    let current = match &change.original_name {
        Some(name) => Some(
            read_foreign_key(session, change, name).await?.ok_or("The original foreign key is no longer visible.")?,
        ),
        None => None,
    };
    let mut affected = vec![target.clone()];
    let mut recovery = Vec::new();
    if let Some(old) = &current {
        recovery.push(foreign_key_sql(session.engine(), change, old)?);
        evidence.extend(check_reference(session, change, old, &user, false).await?);
        affected.push(format!(
            "Original relation: {} ({}) -> {} ({})",
            target,
            column_list(&old.columns)?,
            qualified(&old.referenced_schema, &old.referenced_table)?,
            column_list(&old.referenced_columns)?
        ));
    }
    let mut statements = Vec::new();
    if let Some(desired) = &change.desired {
        let sql = foreign_key_sql(session.engine(), change, desired)?;
        let collision = count(
            session,
            &format!(
                "SELECT COUNT(*) FROM ALL_CONSTRAINTS WHERE OWNER={} AND CONSTRAINT_NAME={}",
                literal(&change.schema),
                literal(&desired.name)
            ),
        )
        .await?;
        let expected = u64::from(current.as_ref().is_some_and(|old| old.name == desired.name));
        if collision != expected {
            return Err("The requested constraint name is already used or its visibility changed.".into());
        }
        evidence.extend(check_reference(session, change, desired, &user, true).await?);
        affected.push(format!(
            "Requested relation: {} ({}) -> {} ({})",
            target,
            column_list(&desired.columns)?,
            qualified(&desired.referenced_schema, &desired.referenced_table)?,
            column_list(&desired.referenced_columns)?
        ));
        statements.push(sql);
    }
    if current != change.desired {
        let state_only = current.as_ref().zip(change.desired.as_ref()).is_some_and(|(old, desired)| {
            let mut state = old.clone();
            state.enabled = desired.enabled;
            state.validated = desired.validated;
            state == *desired
        });
        if state_only {
            let desired = change.desired.as_ref().unwrap();
            statements = vec![format!(
                "ALTER TABLE {target} {} {} CONSTRAINT {}",
                if desired.enabled { "ENABLE" } else { "DISABLE" },
                if desired.validated { "VALIDATE" } else { "NOVALIDATE" },
                identifier(&desired.name)?
            )];
        } else if let Some(old) = &current {
            statements.insert(0, format!("ALTER TABLE {target} DROP CONSTRAINT {}", identifier(&old.name)?));
        }
    } else {
        statements.clear();
    }
    let revision = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(session.engine(), change, &current, evidence)).map_err(|error| error.to_string())?
        )
    );
    Ok(ForeignKeyChangePreview {
        statements,
        revision,
        current_constraint: current,
        affected_objects: affected,
        recovery_statements: recovery,
    })
}

async fn apply_foreign_key(
    session: &impl ConstraintSession,
    change: &ForeignKeyChange,
    revision: &str,
) -> Result<ForeignKeyChangeResult, String> {
    let plan = preview_foreign_key(session, change).await?;
    if plan.revision != revision {
        return Err("The foreign key or referenced metadata changed after preview; no DDL was executed.".into());
    }
    let mut steps = Vec::new();
    for (index, sql) in plan.statements.iter().enumerate() {
        let executed = async {
            if index == 0 {
                if let Some(old) = &plan.current_constraint {
                    if read_foreign_key(session, change, &old.name).await?.as_ref() != Some(old) {
                        return Err("The original foreign key changed during execution.".to_string());
                    }
                }
            }
            session.query(sql).await.map(|_| ())
        }
        .await;
        let success = executed.is_ok();
        steps.push(ConstraintChangeStep { sql: sql.clone(), success, error: executed.err() });
        if !success {
            break;
        }
    }
    let readback = async {
        require_table(session, &change.schema, &change.table_name).await?;
        let original = match &change.original_name {
            Some(name) => read_foreign_key(session, change, name).await?,
            None => None,
        };
        let current = match &change.desired {
            Some(desired) if Some(&desired.name) == change.original_name.as_ref() => original.clone(),
            Some(desired) => read_foreign_key(session, change, &desired.name).await?,
            None => original.clone(),
        };
        Ok::<_, String>((original, current))
    }
    .await;
    let ((original, current), mut refresh_error) = match readback {
        Ok(value) => (value, None),
        Err(error) => ((None, None), Some(error)),
    };
    let complete = steps.len() == plan.statements.len() && steps.iter().all(|step| step.success);
    let desired = current == change.desired
        && (change.desired.as_ref().map(|key| &key.name) == change.original_name.as_ref() || original.is_none());
    if complete && refresh_error.is_none() && !desired {
        refresh_error =
            Some("DDL finished but the foreign-key dictionary does not match the requested definition.".into());
    }
    let recovery = if refresh_error.is_none() && original.is_none() && current.is_none() {
        plan.recovery_statements
    } else {
        Vec::new()
    };
    Ok(ForeignKeyChangeResult {
        success: complete && desired && refresh_error.is_none(),
        steps,
        current_constraint: current,
        original_constraint: original,
        refresh_error,
        recovery_statements: recovery,
    })
}

#[cfg(test)]
mod tests;
