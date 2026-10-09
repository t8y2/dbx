use super::foreign_key::{column_list, qualified, require_alter, require_table};
use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueDefinition {
    pub name: String,
    pub columns: Vec<String>,
    pub enabled: bool,
    pub validated: bool,
    pub deferrable: bool,
    pub initially_deferred: bool,
    pub rely: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueSnapshot {
    #[serde(flatten)]
    pub definition: UniqueDefinition,
    pub index_owner: Option<String>,
    pub index_name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueChange {
    pub schema: String,
    pub table_name: String,
    pub original_name: Option<String>,
    pub desired: Option<UniqueDefinition>,
    #[serde(default)]
    pub drop_previous_index: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueChangePreview {
    pub statements: Vec<String>,
    pub revision: String,
    pub current_constraint: Option<UniqueSnapshot>,
    pub affected_objects: Vec<String>,
    pub recovery_statements: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueChangeResult {
    pub success: bool,
    pub steps: Vec<ConstraintChangeStep>,
    pub current_constraint: Option<UniqueSnapshot>,
    pub original_constraint: Option<UniqueSnapshot>,
    pub refresh_error: Option<String>,
    pub recovery_statements: Vec<String>,
}

pub async fn preview_unique_change(
    state: &AppState,
    connection_id: &str,
    database: &str,
    change: UniqueChange,
) -> Result<UniqueChangePreview, String> {
    let engine = require_engine(state, connection_id).await?;
    preview_unique(&CoreSession { state, connection_id, database, engine }, &change).await
}
pub async fn apply_unique_change(
    state: &AppState,
    connection_id: &str,
    database: &str,
    change: UniqueChange,
    revision: &str,
) -> Result<UniqueChangeResult, String> {
    let engine = require_engine(state, connection_id).await?;
    let pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    crate::query::check_read_only_for_connection(state, &pool_key, "ALTER TABLE").await?;
    let result = apply_unique(&CoreSession { state, connection_id, database, engine }, &change, revision).await;
    crate::object_cache::invalidate_connection_object_cache(&state.storage, connection_id).await;
    result
}

async fn read_unique(
    session: &impl ConstraintSession,
    change: &UniqueChange,
    name: &str,
) -> Result<Option<UniqueSnapshot>, String> {
    let result=read(session,&format!("SELECT c.CONSTRAINT_NAME,c.STATUS,c.VALIDATED,c.DEFERRABLE,c.DEFERRED,c.INDEX_OWNER,c.INDEX_NAME,k.COLUMN_NAME,COALESCE(c.RELY,'NORELY') FROM ALL_CONSTRAINTS c LEFT JOIN ALL_CONS_COLUMNS k ON k.OWNER=c.OWNER AND k.CONSTRAINT_NAME=c.CONSTRAINT_NAME AND k.TABLE_NAME=c.TABLE_NAME WHERE c.OWNER={} AND c.TABLE_NAME={} AND c.CONSTRAINT_NAME={} AND c.CONSTRAINT_TYPE='U' ORDER BY k.POSITION",literal(&change.schema),literal(&change.table_name),literal(name))).await?;
    let Some(first) = result.rows.first() else { return Ok(None) };
    let definition = UniqueDefinition {
        name: text(first, 0)?,
        columns: result.rows.iter().map(|row| text(row, 7)).collect::<Result<_, _>>()?,
        enabled: flag(first, 1, "ENABLED", "DISABLED")?,
        validated: flag(first, 2, "VALIDATED", "NOT VALIDATED")?,
        deferrable: flag(first, 3, "DEFERRABLE", "NOT DEFERRABLE")?,
        initially_deferred: flag(first, 4, "DEFERRED", "IMMEDIATE")?,
        rely: flag(first, 8, "RELY", "NORELY")?,
    };
    column_list(&definition.columns)?;
    Ok(Some(UniqueSnapshot { definition, index_owner: optional_text(first, 5)?, index_name: optional_text(first, 6)? }))
}

fn unique_sql(
    engine: Engine,
    change: &UniqueChange,
    key: &UniqueDefinition,
    index: Option<(&str, &str)>,
) -> Result<String, String> {
    if key.initially_deferred && !key.deferrable {
        return Err("An initially deferred UNIQUE must be deferrable.".into());
    }
    let base = format!(
        "ALTER TABLE {} ADD CONSTRAINT {} UNIQUE ({})",
        qualified(&change.schema, &change.table_name)?,
        identifier(&key.name)?,
        column_list(&key.columns)?
    );
    if engine == Engine::OceanBaseOracle {
        if !key.enabled || !key.validated || key.deferrable || key.initially_deferred || key.rely {
            return Err(
                "OceanBase UNIQUE state changes and deferred constraints are not supported by this editor.".into()
            );
        }
        return Ok(base);
    }
    let using = match index {
        Some((owner, name)) => format!(" USING INDEX {}", qualified(owner, name)?),
        None => String::new(),
    };
    Ok(format!(
        "{base} {} INITIALLY {}{}{using} {} {}",
        if key.deferrable { "DEFERRABLE" } else { "NOT DEFERRABLE" },
        if key.initially_deferred { "DEFERRED" } else { "IMMEDIATE" },
        if key.rely { " RELY" } else { "" },
        if key.enabled { "ENABLE" } else { "DISABLE" },
        if key.validated { "VALIDATE" } else { "NOVALIDATE" }
    ))
}

async fn index_definition(session: &impl ConstraintSession, owner: &str, name: &str) -> Result<String, String> {
    let result = read(
        session,
        &format!("SELECT DBMS_METADATA.GET_DDL('INDEX',{}, {}) FROM DUAL", literal(name), literal(owner)),
    )
    .await?;
    let ddl = text(result.rows.first().ok_or("The supporting index definition is unavailable.")?, 0)?;
    if ddl.trim().is_empty() {
        return Err("The supporting index definition is empty.".into());
    }
    Ok(ddl)
}

async fn preview_unique(
    session: &impl ConstraintSession,
    change: &UniqueChange,
) -> Result<UniqueChangePreview, String> {
    let engine = session.engine();
    let oceanbase = engine == Engine::OceanBaseOracle;
    if oceanbase && change.drop_previous_index {
        return Err("OceanBase UNIQUE and its backing unique index share an identity; Oracle index-removal options are unavailable.".into());
    }
    let target = qualified(&change.schema, &change.table_name)?;
    let owner = literal(&change.schema);
    let name = literal(&change.table_name);
    if change.original_name.is_none() && change.desired.is_none() {
        return Err("No UNIQUE change was requested.".into());
    }
    if let Some(desired) = &change.desired {
        unique_sql(engine, change, desired, None)?;
    }
    let stamp = require_table(session, &change.schema, &change.table_name).await?;
    let identity = read(session, "SELECT USER FROM DUAL").await?;
    let user = text(identity.rows.first().ok_or("Current database user is unavailable.")?, 0)?;
    require_alter(session, &change.schema, &change.table_name, &user).await?;
    let current = match &change.original_name {
        Some(name) => Some(
            read_unique(session, change, name)
                .await?
                .ok_or("The selected object is not a visible UNIQUE constraint.")?,
        ),
        None => None,
    };
    let mut evidence = Vec::new();
    let mut affected = vec![target.clone()];
    let mut recovery = Vec::new();
    let mut original_index = None;
    let indexes=read(session,&format!("SELECT OWNER,INDEX_NAME,INDEX_TYPE,UNIQUENESS,STATUS FROM ALL_INDEXES WHERE TABLE_OWNER={owner} AND TABLE_NAME={name} ORDER BY OWNER,INDEX_NAME")).await?;
    let index_columns=read(session,&format!("SELECT INDEX_OWNER,INDEX_NAME,COLUMN_NAME,COLUMN_POSITION,DESCEND FROM ALL_IND_COLUMNS WHERE TABLE_OWNER={owner} AND TABLE_NAME={name} ORDER BY INDEX_OWNER,INDEX_NAME,COLUMN_POSITION")).await?;
    evidence.push(serde_json::to_string(&indexes.rows).map_err(|error| error.to_string())?);
    evidence.push(serde_json::to_string(&index_columns.rows).map_err(|error| error.to_string())?);
    if let Some(old) = &current {
        if count(
            session,
            &format!(
                "SELECT COUNT(*) FROM ALL_CONSTRAINTS WHERE OWNER={owner} AND CONSTRAINT_NAME={}",
                literal(&old.definition.name)
            ),
        )
        .await?
            != 1
        {
            return Err(
                "The constraint name identifies more than one dictionary object; UNIQUE editing is unsafe.".into()
            );
        }
        unique_sql(engine, change, &old.definition, None)?;
        if count(session,&format!("SELECT COUNT(*) FROM DBA_CONSTRAINTS WHERE CONSTRAINT_TYPE='R' AND R_OWNER={owner} AND R_CONSTRAINT_NAME={}",literal(&old.definition.name))).await.map_err(|error|format!("Cannot confirm all referencing foreign keys; no DDL was executed. {error}"))? !=0{return Err("Foreign keys reference this UNIQUE constraint. Resolve dependencies before editing; no cascade is performed.".into());}
        match (&old.index_owner, &old.index_name) {
            (Some(index_owner), Some(index_name)) => {
                let result=read(session,&format!("SELECT INDEX_TYPE,UNIQUENESS,STATUS,TABLE_OWNER,TABLE_NAME FROM ALL_INDEXES WHERE OWNER={} AND INDEX_NAME={}",literal(index_owner),literal(index_name))).await?;
                let row = result.rows.first().ok_or("The backing index is not visible.")?;
                if result.rows.len() != 1 || text(row, 3)? != change.schema || text(row, 4)? != change.table_name {
                    return Err("The backing index identity is ambiguous.".into());
                }
                evidence.push(serde_json::to_string(&result.rows).map_err(|error| error.to_string())?);
                if oceanbase && (old.definition.name != *index_name || text(row, 1) != "UNIQUE") {
                    return Err("The OceanBase UNIQUE/index mapping cannot be confirmed; no DDL was executed.".into());
                }
                if oceanbase || change.drop_previous_index {
                    if count(session,&format!("SELECT COUNT(*) FROM DBA_CONSTRAINTS WHERE INDEX_OWNER={} AND INDEX_NAME={} AND NOT (OWNER={owner} AND CONSTRAINT_NAME={} AND CONSTRAINT_TYPE='U')",literal(index_owner),literal(index_name),literal(&old.definition.name))).await? !=0{return Err("The backing index is used by another constraint and cannot be removed.".into());}
                    let ddl = index_definition(session, index_owner, index_name).await?;
                    evidence.push(ddl.clone());
                    recovery.push(ddl);
                    affected.push(format!(
                        "Remove backing index {}.{}; its original definition is retained for recovery",
                        index_owner, index_name
                    ));
                } else {
                    affected.push(format!(
                        "Preserve backing index {}.{}; any uniqueness enforced by that index remains active",
                        index_owner, index_name
                    ));
                }
                original_index = Some((index_owner.clone(), index_name.clone()));
            }
            (None, None) if !old.definition.enabled && !oceanbase => {}
            _ => return Err("The backing index metadata is incomplete.".into()),
        }
        if !oceanbase {
            recovery.push(unique_sql(
                engine,
                change,
                &old.definition,
                original_index.as_ref().map(|(owner, name)| (owner.as_str(), name.as_str())),
            )?);
        }
    }
    if let Some(desired) = &change.desired {
        let collision = count(
            session,
            &format!(
                "SELECT COUNT(*) FROM ALL_CONSTRAINTS WHERE OWNER={owner} AND CONSTRAINT_NAME={}",
                literal(&desired.name)
            ),
        )
        .await?;
        if collision != u64::from(current.as_ref().is_some_and(|old| old.definition.name == desired.name)) {
            return Err("The UNIQUE constraint name already exists or its visibility changed.".into());
        }
        if oceanbase {
            let index_collision = count(
                session,
                &format!(
                    "SELECT COUNT(*) FROM ALL_INDEXES WHERE OWNER={owner} AND INDEX_NAME={}",
                    literal(&desired.name)
                ),
            )
            .await?;
            let expected = u64::from(
                original_index.as_ref().is_some_and(|(owner, name)| owner == &change.schema && name == &desired.name),
            );
            if index_collision != expected {
                return Err("The OceanBase backing index name is already used or its visibility changed.".into());
            }
        }
        let names = desired.columns.iter().map(|column| literal(column)).collect::<Vec<_>>().join(",");
        if count(session,&format!("SELECT COUNT(*) FROM ALL_TAB_COLUMNS WHERE OWNER={owner} AND TABLE_NAME={name} AND COLUMN_NAME IN ({names})")).await? !=desired.columns.len() as u64{return Err("A UNIQUE column is not visible.".into());}
        if desired.validated {
            let columns = column_list(&desired.columns)?;
            let nonnull = desired
                .columns
                .iter()
                .map(|column| identifier(column).map(|column| format!("{column} IS NOT NULL")))
                .collect::<Result<Vec<_>, _>>()?
                .join(" OR ");
            if count(session,&format!("SELECT COUNT(*) FROM (SELECT {columns} FROM {target} WHERE ({nonnull}) GROUP BY {columns} HAVING COUNT(*)>1) WHERE ROWNUM=1")).await? !=0{return Err("Duplicate UNIQUE keys exist; all-NULL keys are excluded. No DDL was executed.".into());}
        }
    }
    let mut reusable_index = None;
    if !oceanbase {
        if let Some(desired) = change.desired.as_ref().filter(|key| key.enabled) {
            for row in &indexes.rows {
                let index_owner = text(row, 0)?;
                let index_name = text(row, 1)?;
                if text(row, 2) != "NORMAL"
                    || text(row, 4) != "VALID"
                    || (desired.deferrable && text(row, 3) != "NONUNIQUE")
                {
                    continue;
                }
                if change.drop_previous_index
                    && original_index.as_ref() == Some(&(index_owner.clone(), index_name.clone()))
                {
                    continue;
                }
                let mut columns = Vec::new();
                let mut ascending = true;
                for column in &index_columns.rows {
                    if text(column, 0)? == index_owner && text(column, 1)? == index_name {
                        columns.push(text(column, 2)?);
                        ascending &= text(column, 4)? == "ASC";
                    }
                }
                if !ascending || columns != desired.columns {
                    continue;
                }
                let exclude = current
                    .as_ref()
                    .map(|key| {
                        format!(
                            " AND NOT (OWNER={owner} AND CONSTRAINT_NAME={} AND CONSTRAINT_TYPE='U')",
                            literal(&key.definition.name)
                        )
                    })
                    .unwrap_or_default();
                if count(
                    session,
                    &format!(
                        "SELECT COUNT(*) FROM DBA_CONSTRAINTS WHERE INDEX_OWNER={} AND INDEX_NAME={}{exclude}",
                        literal(&index_owner),
                        literal(&index_name)
                    ),
                )
                .await?
                    != 0
                {
                    continue;
                }
                affected.push(format!("Reuse backing index {}.{} without replacing it", index_owner, index_name));
                reusable_index = Some((index_owner, index_name));
                break;
            }
        }
    }
    let revision = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(engine, change, &current, evidence, stamp, &reusable_index))
                .map_err(|error| error.to_string())?
        )
    );
    let mut statements = Vec::new();
    let same = current.as_ref().map(|key| &key.definition) == change.desired.as_ref();
    if !same {
        let state_only = current.as_ref().zip(change.desired.as_ref()).is_some_and(|(old, desired)| {
            let mut old = old.definition.clone();
            old.enabled = desired.enabled;
            old.validated = desired.validated;
            old == *desired
        });
        let rename_only = current.as_ref().zip(change.desired.as_ref()).is_some_and(|(old, desired)| {
            let mut old = old.definition.clone();
            old.name = desired.name.clone();
            old == *desired
        });
        if rename_only && !oceanbase && !change.drop_previous_index {
            statements.push(format!(
                "ALTER TABLE {target} RENAME CONSTRAINT {} TO {}",
                identifier(&current.as_ref().unwrap().definition.name)?,
                identifier(&change.desired.as_ref().unwrap().name)?
            ));
        } else if state_only && !oceanbase && !change.drop_previous_index {
            let desired = change.desired.as_ref().unwrap();
            statements.push(format!(
                "ALTER TABLE {target} {} {} CONSTRAINT {}{}",
                if desired.enabled { "ENABLE" } else { "DISABLE" },
                if desired.validated { "VALIDATE" } else { "NOVALIDATE" },
                identifier(&desired.name)?,
                if desired.enabled { "" } else { " KEEP INDEX" }
            ));
        } else {
            let candidate_index =
                if !oceanbase && reusable_index.is_none() && change.desired.as_ref().is_some_and(|key| key.enabled) {
                    Some(format!("DBX_UQ_{}", &revision[..22]))
                } else {
                    None
                };
            if let Some(index) = &candidate_index {
                if count(
                    session,
                    &format!("SELECT COUNT(*) FROM ALL_OBJECTS WHERE OWNER={owner} AND OBJECT_NAME={}", literal(index)),
                )
                .await?
                    != 0
                {
                    return Err("The planned backing index name already exists. Refresh before retrying.".into());
                }
                statements.push(format!(
                    "CREATE INDEX {} ON {target} ({})",
                    qualified(&change.schema, index)?,
                    column_list(&change.desired.as_ref().unwrap().columns)?
                ));
            }
            if let Some(old) = &current {
                statements.push(if oceanbase {
                    let (owner, name) = original_index.as_ref().ok_or("Missing OceanBase backing index.")?;
                    format!("DROP INDEX {}", qualified(owner, name)?)
                } else {
                    format!("ALTER TABLE {target} DROP CONSTRAINT {} KEEP INDEX", identifier(&old.definition.name)?)
                });
            }
            if let Some(desired) = &change.desired {
                statements.push(unique_sql(
                    engine,
                    change,
                    desired,
                    reusable_index
                        .as_ref()
                        .map(|(owner, name)| (owner.as_str(), name.as_str()))
                        .or_else(|| candidate_index.as_ref().map(|name| (change.schema.as_str(), name.as_str()))),
                )?);
            }
            if !oceanbase && change.drop_previous_index {
                if let Some((owner, name)) = &original_index {
                    statements.push(format!("DROP INDEX {}", qualified(owner, name)?));
                }
            }
        }
    }
    Ok(UniqueChangePreview {
        statements,
        revision,
        current_constraint: current,
        affected_objects: affected,
        recovery_statements: recovery,
    })
}

async fn apply_unique(
    session: &impl ConstraintSession,
    change: &UniqueChange,
    revision: &str,
) -> Result<UniqueChangeResult, String> {
    let plan = preview_unique(session, change).await?;
    if plan.revision != revision {
        return Err("The UNIQUE constraint or indexes changed after preview; no DDL was executed.".into());
    }
    let mut steps = Vec::new();
    for sql in &plan.statements {
        let executed = async {
            if let Some(old) = &plan.current_constraint {
                let original_drop = if session.engine() == Engine::Oracle {
                    sql.contains(" DROP CONSTRAINT ")
                } else {
                    sql.starts_with("DROP INDEX ")
                };
                if original_drop && read_unique(session, change, &old.definition.name).await?.as_ref() != Some(old) {
                    return Err("The original UNIQUE definition changed during execution.".into());
                }
                if sql.starts_with("DROP INDEX ") {
                    let (Some(owner), Some(name)) = (&old.index_owner, &old.index_name) else {
                        return Err("Missing original index identity.".into());
                    };
                    let remaining = count(
                        session,
                        &format!(
                            "SELECT COUNT(*) FROM DBA_CONSTRAINTS WHERE INDEX_OWNER={} AND INDEX_NAME={}{}",
                            literal(owner),
                            literal(name),
                            if session.engine() == Engine::OceanBaseOracle {
                                format!(
                                    " AND NOT (OWNER={} AND CONSTRAINT_NAME={} AND CONSTRAINT_TYPE='U')",
                                    literal(&change.schema),
                                    literal(&old.definition.name)
                                )
                            } else {
                                String::new()
                            }
                        ),
                    )
                    .await?;
                    if remaining != 0 {
                        return Err("The original index is now shared and was not removed.".into());
                    }
                    if plan.recovery_statements.first() != Some(&index_definition(session, owner, name).await?) {
                        return Err("The original index definition changed and was not removed.".into());
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
            Some(name) => read_unique(session, change, name).await?,
            None => None,
        };
        let current = match &change.desired {
            Some(key) if Some(&key.name) == change.original_name.as_ref() => original.clone(),
            Some(key) => read_unique(session, change, &key.name).await?,
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
    let desired = current.as_ref().map(|key| &key.definition) == change.desired.as_ref()
        && (change.desired.as_ref().map(|key| &key.name) == change.original_name.as_ref() || original.is_none());
    if complete && refresh_error.is_none() && !desired {
        refresh_error = Some("DDL finished but the actual UNIQUE definition or state differs from the request.".into());
    }
    let mut recovery = if refresh_error.is_none() && original.is_none() && current.is_none() {
        plan.recovery_statements
    } else {
        Vec::new()
    };
    if recovery.len() > 1 {
        if let Some(old) = &plan.current_constraint {
            if let (Some(owner), Some(name)) = (&old.index_owner, &old.index_name) {
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
                    _ => {
                        recovery.clear();
                        refresh_error = Some("The original index state is unknown; recovery must be reviewed.".into());
                    }
                }
            }
        }
    }
    Ok(UniqueChangeResult {
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
