//! Overwrite pre-pass for target tables linked by foreign keys inside the transfer.
//!
//! `transfer_table` clears each overwrite target right before copying into it, and the
//! transfer loop visits tables parents first. That order cannot clear a referenced table:
//! SQL Server (4712), MySQL (1701) and PostgreSQL refuse to `TRUNCATE` a table another
//! table's foreign key points at, even when the referencing table is already empty, and a
//! parent cannot lose its rows while a child still references them. This pass empties the
//! linked tables children first before the loop starts, and the loop then skips the
//! per-table clear for them.

use super::*;

/// Empty the overwrite targets that are linked to each other by foreign keys, children first.
///
/// Tables referenced by another selected table are cleared with `DELETE`, the rest with the
/// usual per-database clear statement. Returns the source names of the tables that were
/// cleared; the caller passes `target_cleared = true` to `transfer_table_with_result` for
/// those so they are not cleared a second time.
///
/// Returns an empty set, leaving every table to the per-table clear, when the request is not
/// an overwrite, when no selected target references another, when the foreign key metadata
/// cannot be read, or when a table outside the selection references one of the linked
/// tables: a `DELETE` there could cascade into rows the transfer never selected.
pub async fn clear_foreign_key_linked_overwrite_targets(
    state: &Arc<AppState>,
    request: &TransferRequest,
    tables: &[String],
    target_db_type: DatabaseType,
    target_pool_key: &str,
) -> Result<HashSet<String>, String> {
    if request.mode != TransferMode::Overwrite
        || request.drop_target_before_create
        || tables.len() < 2
        || is_mongodb_transfer_type(&target_db_type)
    {
        return Ok(HashSet::new());
    }

    let mut targets: Vec<(String, String)> = Vec::new();
    for table in tables {
        let ResolvedTransferTargetTable { name, preexisting } = resolve_transfer_target_table_name(
            state,
            request,
            table,
            target_pool_key,
            &target_db_type,
            request.source_catalog.as_deref(),
            request.target_catalog.as_deref(),
        )
        .await;
        if preexisting {
            targets.push((table.clone(), name));
        }
    }

    let mut edges: Vec<(String, String)> = Vec::new();
    for (_, target_table) in &targets {
        let foreign_keys = match crate::schema::list_foreign_keys_core(
            state,
            &request.target_connection_id,
            &request.target_database,
            &request.target_schema,
            target_table,
        )
        .await
        {
            Ok(foreign_keys) => foreign_keys,
            Err(error) => {
                log::warn!(
                    "[transfer] overwrite pre-pass skipped: cannot read foreign keys of {target_table}: {error}"
                );
                return Ok(HashSet::new());
            }
        };
        for foreign_key in foreign_keys {
            let referenced_in_target_schema = foreign_key.ref_schema.as_deref().is_none_or(|schema| {
                schema.is_empty()
                    || schema.eq_ignore_ascii_case(&request.target_schema)
                    || schema.eq_ignore_ascii_case(&request.target_database)
            });
            if referenced_in_target_schema
                && foreign_key.ref_table != *target_table
                && targets.iter().any(|(_, name)| *name == foreign_key.ref_table)
            {
                edges.push((target_table.clone(), foreign_key.ref_table));
            }
        }
    }
    edges.sort();
    edges.dedup();
    if edges.is_empty() {
        return Ok(HashSet::new());
    }

    let linked: Vec<String> = targets
        .iter()
        .map(|(_, name)| name.clone())
        .filter(|name| edges.iter().any(|(child, parent)| child == name || parent == name))
        .collect();
    match crate::transfer_rebuild::detect_external_incoming_foreign_keys(
        state,
        target_pool_key,
        &request.target_database,
        &request.target_schema,
        &linked,
        target_db_type,
    )
    .await
    {
        Ok(external) if external.is_empty() => {}
        Ok(external) => {
            log::warn!(
                "[transfer] overwrite pre-pass skipped: {} foreign key(s) from outside the transfer reference the target tables",
                external.len()
            );
            return Ok(HashSet::new());
        }
        Err(error) => {
            log::warn!("[transfer] overwrite pre-pass skipped: cannot check incoming foreign keys: {error}");
            return Ok(HashSet::new());
        }
    }

    let mut cleared = HashSet::new();
    for target_table in sort_table_names_by_dependencies(&linked, &edges, false) {
        let referenced = edges.iter().any(|(_, parent)| *parent == target_table);
        let sql = overwrite_pre_pass_clear_sql(
            &target_table,
            &request.target_schema,
            &target_db_type,
            request.target_catalog.as_deref(),
            referenced,
        );
        execute_on_pool(state, target_pool_key, &sql)
            .await
            .map_err(|error| format!("Failed to clear target table '{target_table}' before overwrite: {error}"))?;
        if let Some((source_table, _)) = targets.iter().find(|(_, name)| *name == target_table) {
            cleared.insert(source_table.clone());
        }
    }
    Ok(cleared)
}

pub(super) fn overwrite_pre_pass_clear_sql(
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    catalog: Option<&str>,
    referenced: bool,
) -> String {
    if referenced {
        format!("DELETE FROM {}", qualified_table(table, schema, db_type, catalog))
    } else {
        transfer_clear_table_sql(table, schema, db_type, catalog)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn referenced_targets_are_deleted_instead_of_truncated() {
        assert_eq!(
            overwrite_pre_pass_clear_sql("QRTZ_JOB_DETAILS", "dbo", &DatabaseType::SqlServer, None, true),
            "DELETE FROM [dbo].[QRTZ_JOB_DETAILS]"
        );
        assert_eq!(
            overwrite_pre_pass_clear_sql("QRTZ_TRIGGERS", "dbo", &DatabaseType::SqlServer, None, false),
            "TRUNCATE TABLE [dbo].[QRTZ_TRIGGERS]"
        );
        assert_eq!(
            overwrite_pre_pass_clear_sql("EVENTS", "APP", &DatabaseType::Db2, None, false),
            "TRUNCATE TABLE \"APP\".\"EVENTS\" IMMEDIATE"
        );
    }
}
