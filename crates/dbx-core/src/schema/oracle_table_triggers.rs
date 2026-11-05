use super::*;
use dbx_sql::object_source_sql::{
    oracle_trigger_ddl_sources, oracle_trigger_enabled, oracle_trigger_metadata_matches,
    oracle_trigger_source_with_create,
};

pub(super) async fn enrich(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    mut triggers: Vec<db::TriggerInfo>,
) -> Result<Vec<db::TriggerInfo>, String> {
    let Some(config) = connection_config(state, connection_id).await else { return Ok(triggers) };
    let oracle = matches!(config.db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
        || is_oracle_external_driver_config(&config)
        || crate::models::connection::jdbc_dialect_hint(&config)
            == Some(crate::models::connection::JdbcDialectHint::OceanbaseOracle);
    let incomplete = |trigger: &db::TriggerInfo| {
        trigger.enabled.is_none() || trigger.statement.as_deref().is_none_or(|source| source.trim().is_empty())
    };
    if !oracle || !triggers.iter().any(incomplete) {
        return Ok(triggers);
    }
    let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
    let sql = format!(
        "SELECT OWNER, TRIGGER_NAME, TABLE_OWNER, TABLE_NAME, STATUS FROM ALL_TRIGGERS WHERE TABLE_OWNER = {} AND TABLE_NAME = {}",
        quote(schema), quote(table)
    );
    let inventory = match oracle_ddl_indexes::index_metadata_query(state, connection_id, database, &sql).await {
        Ok(inventory) => inventory,
        Err(_) => {
            log::warn!("Trigger metadata remains incomplete for {schema}.{table}: status query failed");
            return Ok(triggers);
        }
    };
    for trigger in triggers.iter_mut().filter(|trigger| incomplete(trigger)) {
        // The listing admits triggers owned by other schemas (TABLE_OWNER
        // match), so rows are keyed by name here and the row's actual OWNER is
        // recorded instead of being required to equal the queried schema
        // (#13498 review).
        let mut rows = inventory
            .rows
            .iter()
            .filter(|row| row.get(1).and_then(serde_json::Value::as_str) == Some(trigger.name.as_str()));
        let row =
            rows.next().ok_or_else(|| format!("{schema}.{}: trigger identity changed; compare again", trigger.name))?;
        if rows.next().is_some() || row.get(3).and_then(serde_json::Value::as_str) != Some(table) {
            return Err(format!("{schema}.{}: trigger table identity changed; compare again", trigger.name));
        }
        let trigger_owner = row.first().and_then(serde_json::Value::as_str).unwrap_or(schema);
        let enabled = match row.get(4).and_then(serde_json::Value::as_str) {
            Some("ENABLED") => true,
            Some("DISABLED") => false,
            _ => {
                log::warn!(
                    "Trigger metadata remains incomplete for {schema}.{}: firing state unavailable",
                    trigger.name
                );
                continue;
            }
        };
        if trigger.enabled.is_some_and(|previous| previous != enabled) {
            return Err(format!("{schema}.{}: trigger firing state changed; compare again", trigger.name));
        }
        let missing_source = trigger.statement.as_deref().is_none_or(|source| source.trim().is_empty());
        // A cross-schema trigger's ALL_SOURCE rows live under its actual OWNER,
        // so both the source lookup and the identity check use trigger_owner
        // rather than the queried schema (#13498 review).
        let source = if missing_source {
            match get_object_source_core(
                state,
                connection_id,
                database,
                trigger_owner,
                &trigger.name,
                db::ObjectSourceKind::Trigger,
                None,
                Some(table),
            )
            .await
            {
                Ok(source) => source,
                Err(_) => {
                    log::warn!(
                        "Trigger metadata remains incomplete for {schema}.{}: source query failed",
                        trigger.name
                    );
                    continue;
                }
            }
        } else {
            db::ObjectSource {
                name: trigger.name.clone(),
                object_type: db::ObjectSourceKind::Trigger,
                schema: Some(schema.into()),
                source: trigger.statement.clone().unwrap(),
                editable: None,
                routine_parameters: None,
                trigger: None,
            }
        };
        if source.name != trigger.name
            || source.schema.as_deref() != Some(trigger_owner)
            || source.object_type != db::ObjectSourceKind::Trigger
        {
            return Err(format!("{schema}.{}: trigger source identity changed; compare again", trigger.name));
        }
        let full = match oracle_trigger_source_with_create(&source.source) {
            Ok(Some(full)) => full,
            _ => {
                log::warn!(
                    "Trigger metadata remains incomplete for {schema}.{}: complete declaration unavailable",
                    trigger.name
                );
                continue;
            }
        };
        let definitions = match oracle_trigger_ddl_sources(&full, schema) {
            Ok(definitions) => definitions,
            Err(_) => {
                log::warn!("Trigger metadata remains incomplete for {schema}.{}: invalid declaration", trigger.name);
                continue;
            }
        };
        if definitions.len() != 1
            || definitions[0].owner != schema
            || definitions[0].name != trigger.name
            || definitions[0].table_owner != schema
            || definitions[0].table != table
        {
            return Err(format!("{schema}.{}: trigger declaration identity changed; compare again", trigger.name));
        }
        let definition = &definitions[0];
        if !oracle_trigger_metadata_matches(
            definition,
            &trigger.event,
            &trigger.timing,
            trigger.level.as_deref(),
            trigger.condition.as_deref(),
        )? || (!definition.state_statements.is_empty() && oracle_trigger_enabled(definition)? != enabled)
        {
            return Err(format!("{schema}.{}: trigger definition or state changed; compare again", trigger.name));
        }
        if missing_source {
            trigger.statement = Some(full);
        }
        if trigger.enabled.is_none() {
            trigger.enabled = Some(enabled);
        }
    }
    Ok(triggers)
}
