//! Sequence metadata for agent-backed PostgreSQL-family engines.
//!
//! KingbaseES and Vastbase run through Agent pools instead of the native
//! PostgreSQL driver, so sequences need explicit agent-side queries. The
//! `sys_catalog`/`pg_catalog` spellings are tried in turn because KingbaseES
//! ships both while Vastbase only exposes the `pg_*` one, and older KingbaseES
//! releases predate the `pg_sequence` catalog and are served from
//! `information_schema.sequences` instead (t8y2/dbx#9016).

use crate::db;
use crate::query::{agent_execute_query_params, QueryExecutionOptions};
use std::sync::Arc;
use std::time::Duration;

use super::{pg_ident, query_result_cell_string, sql_string};

#[derive(Clone, Copy)]
enum PgCatalog {
    Sys,
    Pg,
}

impl PgCatalog {
    fn catalog_name(self) -> &'static str {
        match self {
            Self::Sys => "sys_catalog",
            Self::Pg => "pg_catalog",
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Sys => "sys",
            Self::Pg => "pg",
        }
    }

    fn user_by_id(self) -> &'static str {
        match self {
            Self::Sys => "sys_get_userbyid",
            Self::Pg => "pg_get_userbyid",
        }
    }
}

async fn query_result(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    sql: &str,
    max_rows: usize,
    timeout_duration: Option<Duration>,
) -> Result<db::QueryResult, String> {
    let params = agent_execute_query_params(
        sql,
        if database.is_empty() { None } else { Some(database) },
        None,
        QueryExecutionOptions { max_rows: Some(max_rows), ..Default::default() },
    );
    let mut client = client.lock().await;
    client.execute_query_with_timeout(params, timeout_duration).await
}

async fn query_result_with_catalog_fallback(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    sys_sql: String,
    pg_sql: String,
    max_rows: usize,
    timeout_duration: Option<Duration>,
) -> Result<db::QueryResult, String> {
    match query_result(client.clone(), database, &sys_sql, max_rows, timeout_duration).await {
        Ok(result) => Ok(result),
        Err(sys_error) => query_result(client, database, &pg_sql, max_rows, timeout_duration)
            .await
            .map_err(|pg_error| format!("{sys_error}; pg_catalog fallback failed: {pg_error}")),
    }
}

fn list_sequences_sql(schema: &str, catalog: PgCatalog) -> String {
    let catalog_name = catalog.catalog_name();
    let prefix = catalog.prefix();
    format!(
        "SELECT c.relname, \
                COALESCE(format_type(s.seqtypid, NULL), 'bigint') AS data_type, \
                COALESCE(s.seqstart::text, '1') AS start_value, \
                COALESCE(s.seqmin::text, '1') AS min_value, \
                COALESCE(s.seqmax::text, '9223372036854775807') AS max_value, \
                COALESCE(s.seqincrement::text, '1') AS increment, \
                CASE WHEN s.seqcycle THEN 'YES' ELSE 'NO' END AS cycle \
         FROM {catalog_name}.{prefix}_class c \
         JOIN {catalog_name}.{prefix}_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN {catalog_name}.{prefix}_sequence s ON s.seqrelid = c.oid \
         WHERE c.relkind = 'S' AND n.nspname = {} \
         ORDER BY c.relname",
        sql_string(schema),
    )
}

/// Portable sibling of `list_sequences_sql` for engines without the
/// `pg_sequence` catalog (mirrors the PostgreSQL driver's pre-PG10 tier).
fn list_sequences_compat_sql(schema: &str) -> String {
    format!(
        "SELECT sequence_name, \
                COALESCE(data_type::text, 'bigint') AS data_type, \
                COALESCE(start_value::text, '1') AS start_value, \
                COALESCE(minimum_value::text, '1') AS min_value, \
                COALESCE(maximum_value::text, '9223372036854775807') AS max_value, \
                COALESCE(increment::text, '1') AS increment, \
                COALESCE(cycle_option::text, 'NO') AS cycle \
         FROM information_schema.sequences \
         WHERE sequence_schema = {} \
         ORDER BY sequence_name",
        sql_string(schema),
    )
}

fn sequence_last_values_sql(schema: &str, catalog: PgCatalog) -> String {
    let catalog_name = catalog.catalog_name();
    let prefix = catalog.prefix();
    format!(
        "SELECT c.relname, {catalog_name}.{prefix}_sequence_last_value(c.oid)::text \
         FROM {catalog_name}.{prefix}_class c \
         JOIN {catalog_name}.{prefix}_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind = 'S' AND n.nspname = {}",
        sql_string(schema),
    )
}

/// Sequence DDL for the object-source view. The property values come from the
/// portable `information_schema.sequences` view, while owner and owned-by
/// references keep the catalog spelling of the other queries.
///
/// The dependency join filters on `'pg_class'::regclass` even for the `sys`
/// catalog: KingbaseES stores the `pg_class` oid in `sys_depend.classid`, so
/// `'sys_class'::regclass` (the compatibility view's own oid) never matches and
/// the `owned by` clause would be dropped.
fn sequence_source_sql(schema: &str, name: &str, catalog: PgCatalog) -> String {
    let catalog_name = catalog.catalog_name();
    let prefix = catalog.prefix();
    let user_by_id = catalog.user_by_id();
    format!(
        "SELECT concat_ws(E'\\n\\n', \
           '-- auto-generated definition' || E'\\n' || \
           'create sequence ' || quote_ident(c.relname) || E'\\n' || \
           '    increment by ' || COALESCE(s.increment::text, '1') || E'\\n' || \
           '    minvalue ' || COALESCE(s.minimum_value::text, '1') || E'\\n' || \
           '    maxvalue ' || COALESCE(s.maximum_value::text, '9223372036854775807') || E'\\n' || \
           '    start with ' || COALESCE(s.start_value::text, '1') || E'\\n' || \
           CASE WHEN upper(COALESCE(s.cycle_option::text, 'NO')) = 'YES' \
             THEN '    cycle;' ELSE '    no cycle;' END, \
           'alter sequence ' || quote_ident(c.relname) || ' owner to ' || quote_ident({user_by_id}(c.relowner)) || ';', \
           CASE WHEN owned.relname IS NOT NULL AND a.attname IS NOT NULL \
             THEN 'alter sequence ' || quote_ident(c.relname) || ' owned by ' || quote_ident(owned.relname) || '.' || quote_ident(a.attname) || ';' \
           END \
         ) \
         FROM {catalog_name}.{prefix}_class c \
         JOIN {catalog_name}.{prefix}_namespace n ON n.oid = c.relnamespace \
         JOIN information_schema.sequences s \
           ON s.sequence_schema = n.nspname AND s.sequence_name = c.relname \
         LEFT JOIN {catalog_name}.{prefix}_depend d \
           ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'a' \
         LEFT JOIN {catalog_name}.{prefix}_class owned ON owned.oid = d.refobjid \
         LEFT JOIN {catalog_name}.{prefix}_attribute a \
           ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
         WHERE n.nspname = {} AND c.relname = {} AND c.relkind = 'S' \
         ORDER BY c.oid LIMIT 1",
        sql_string(schema),
        sql_string(name),
    )
}

fn sequence_infos_from_query_result(result: db::QueryResult) -> Vec<db::SequenceInfo> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = query_result_cell_string(&row, 0)?;
            Some(db::SequenceInfo {
                name,
                data_type: query_result_cell_string(&row, 1).unwrap_or_else(|| "bigint".to_string()),
                start_value: query_result_cell_string(&row, 2).unwrap_or_else(|| "1".to_string()),
                min_value: query_result_cell_string(&row, 3).unwrap_or_else(|| "1".to_string()),
                max_value: query_result_cell_string(&row, 4).unwrap_or_else(|| "9223372036854775807".to_string()),
                increment: query_result_cell_string(&row, 5).unwrap_or_else(|| "1".to_string()),
                cycle: query_result_cell_string(&row, 6).is_some_and(|value| value.eq_ignore_ascii_case("YES")),
                last_value: None,
            })
        })
        .collect()
}

fn apply_sequence_last_values(sequences: &mut [db::SequenceInfo], result: db::QueryResult) {
    for row in result.rows {
        let Some(name) = query_result_cell_string(&row, 0) else {
            continue;
        };
        let Some(last_value) = query_result_cell_string(&row, 1) else {
            continue;
        };
        if let Some(sequence) = sequences.iter_mut().find(|sequence| sequence.name == name) {
            sequence.last_value = Some(last_value);
        }
    }
}

/// Lists sequences over an agent connection, degrading from the `sys`/`pg`
/// sequence catalogs to `information_schema.sequences` for engines that ship
/// neither (t8y2/dbx#9016).
pub(super) async fn list_sequences(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    with_last_values: bool,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::SequenceInfo>, String> {
    let (result, catalog) = match query_result(
        client.clone(),
        database,
        &list_sequences_sql(schema, PgCatalog::Sys),
        10_000,
        timeout_duration,
    )
    .await
    {
        Ok(result) => (result, Some(PgCatalog::Sys)),
        Err(sys_error) => match query_result(
            client.clone(),
            database,
            &list_sequences_sql(schema, PgCatalog::Pg),
            10_000,
            timeout_duration,
        )
        .await
        {
            Ok(result) => (result, Some(PgCatalog::Pg)),
            Err(pg_error) => {
                let compat = query_result(
                    client.clone(),
                    database,
                    &list_sequences_compat_sql(schema),
                    10_000,
                    timeout_duration,
                )
                .await
                .map_err(|compat_error| {
                    format!(
                        "{sys_error}; pg_catalog fallback failed: {pg_error}; information_schema fallback failed: {compat_error}"
                    )
                })?;
                (compat, None)
            }
        },
    };

    let mut sequences = sequence_infos_from_query_result(result);
    if !with_last_values || sequences.is_empty() {
        return Ok(sequences);
    }

    match catalog {
        Some(catalog) => {
            let sql = sequence_last_values_sql(schema, catalog);
            if let Ok(result) = query_result(client, database, &sql, 10_000, timeout_duration).await {
                apply_sequence_last_values(&mut sequences, result);
            }
        }
        None => {
            // Pre-PG10 servers cannot read an arbitrary sequence value from the
            // catalog, so read each sequence relation directly.
            for sequence in sequences.iter_mut() {
                let sql = format!("SELECT last_value::text FROM {}.{}", pg_ident(schema), pg_ident(&sequence.name));
                if let Ok(result) = query_result(client.clone(), database, &sql, 1, timeout_duration).await {
                    sequence.last_value = result.rows.first().and_then(|row| query_result_cell_string(row, 0));
                }
            }
        }
    }

    Ok(sequences)
}

/// `CREATE SEQUENCE`/`ALTER SEQUENCE` source for the object-source view.
pub(super) async fn sequence_source(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    name: &str,
    timeout_duration: Option<Duration>,
) -> Result<Option<String>, String> {
    let result = query_result_with_catalog_fallback(
        client,
        database,
        sequence_source_sql(schema, name, PgCatalog::Sys),
        sequence_source_sql(schema, name, PgCatalog::Pg),
        1,
        timeout_duration,
    )
    .await?;
    Ok(result.rows.first().and_then(|row| query_result_cell_string(row, 0)).filter(|source| !source.trim().is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_sequences_sql_uses_native_catalog_and_escapes_schema() {
        let sql = list_sequences_sql("core's", PgCatalog::Sys);

        assert!(sql.contains("sys_catalog.sys_class"));
        assert!(sql.contains("sys_catalog.sys_namespace"));
        assert!(sql.contains("sys_catalog.sys_sequence"));
        assert!(sql.contains("c.relkind = 'S'"));
        assert!(sql.contains("n.nspname = 'core''s'"));
        assert!(!sql.contains("pg_catalog"));
    }

    #[test]
    fn list_sequences_sql_pg_catalog_variant_uses_pg_prefix() {
        let sql = list_sequences_sql("public", PgCatalog::Pg);

        assert!(sql.contains("pg_catalog.pg_class"));
        assert!(sql.contains("pg_catalog.pg_sequence"));
        assert!(sql.contains("n.nspname = 'public'"));
    }

    #[test]
    fn list_sequences_compat_sql_avoids_sequence_catalogs() {
        let sql = list_sequences_compat_sql("core's");

        assert!(sql.contains("information_schema.sequences"));
        assert!(sql.contains("sequence_schema = 'core''s'"));
        assert!(!sql.contains("_sequence s ON"));
        assert!(!sql.contains("pg_class"));
    }

    #[test]
    fn sequence_last_values_sql_targets_catalog_function() {
        assert!(sequence_last_values_sql("public", PgCatalog::Sys).contains("sys_catalog.sys_sequence_last_value"));
        assert!(sequence_last_values_sql("public", PgCatalog::Pg).contains("pg_catalog.pg_sequence_last_value"));
    }

    #[test]
    fn sequence_source_sql_escapes_schema_and_name_per_catalog() {
        let sql = sequence_source_sql("core's", "seq's", PgCatalog::Sys);

        assert!(sql.contains("sys_catalog.sys_class"));
        assert!(sql.contains("'pg_class'::regclass"));
        assert!(!sql.contains("'sys_class'::regclass"));
        assert!(sql.contains("sys_get_userbyid(c.relowner)"));
        assert!(sql.contains("n.nspname = 'core''s'"));
        assert!(sql.contains("c.relname = 'seq''s'"));
        assert!(sql.contains("information_schema.sequences"));

        let pg_sql = sequence_source_sql("public", "orders_seq", PgCatalog::Pg);
        assert!(pg_sql.contains("pg_catalog.pg_class"));
        assert!(pg_sql.contains("'pg_class'::regclass"));
        assert!(pg_sql.contains("pg_get_userbyid(c.relowner)"));
    }

    fn sequence_query_result(rows: Vec<Vec<serde_json::Value>>) -> db::QueryResult {
        db::QueryResult {
            columns: vec![
                "relname".to_string(),
                "data_type".to_string(),
                "start_value".to_string(),
                "min_value".to_string(),
                "max_value".to_string(),
                "increment".to_string(),
                "cycle".to_string(),
            ],
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: vec![],
            spatial_values: vec![],
            rows,
            affected_rows: 0,
            execution_time_ms: 0,
            server_execute_time_us: None,
            query_timings_ms: None,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        }
    }

    #[test]
    fn sequence_infos_map_catalog_rows_and_cycle_flag() {
        let result = sequence_query_result(vec![
            vec![
                serde_json::json!("dbx_seq"),
                serde_json::json!("bigint"),
                serde_json::json!("5"),
                serde_json::json!("1"),
                serde_json::json!("9223372036854775807"),
                serde_json::json!("2"),
                serde_json::json!("NO"),
            ],
            vec![
                serde_json::json!("cyc_seq"),
                serde_json::json!("integer"),
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::json!("YES"),
            ],
        ]);

        let sequences = sequence_infos_from_query_result(result);

        assert_eq!(sequences.len(), 2);
        assert_eq!(sequences[0].name, "dbx_seq");
        assert_eq!(sequences[0].data_type, "bigint");
        assert_eq!(sequences[0].start_value, "5");
        assert_eq!(sequences[0].increment, "2");
        assert!(!sequences[0].cycle);
        assert!(sequences[0].last_value.is_none());
        assert_eq!(sequences[1].data_type, "integer");
        assert_eq!(sequences[1].start_value, "1");
        assert_eq!(sequences[1].min_value, "1");
        assert_eq!(sequences[1].increment, "1");
        assert!(sequences[1].cycle);
    }

    #[test]
    fn apply_sequence_last_values_matches_by_name_and_ignores_nulls() {
        let mut sequences = sequence_infos_from_query_result(sequence_query_result(vec![
            vec![
                serde_json::json!("dbx_seq"),
                serde_json::json!("bigint"),
                serde_json::json!("5"),
                serde_json::json!("1"),
                serde_json::json!("9223372036854775807"),
                serde_json::json!("2"),
                serde_json::json!("NO"),
            ],
            vec![
                serde_json::json!("other_seq"),
                serde_json::json!("bigint"),
                serde_json::json!("1"),
                serde_json::json!("1"),
                serde_json::json!("9223372036854775807"),
                serde_json::json!("1"),
                serde_json::json!("NO"),
            ],
        ]));

        let last_values = db::QueryResult {
            columns: vec!["relname".to_string(), "last_value".to_string()],
            rows: vec![
                vec![serde_json::json!("dbx_seq"), serde_json::json!("5")],
                vec![serde_json::json!("other_seq"), serde_json::Value::Null],
            ],
            ..sequence_query_result(vec![])
        };
        apply_sequence_last_values(&mut sequences, last_values);

        assert_eq!(sequences[0].last_value.as_deref(), Some("5"));
        assert!(sequences[1].last_value.is_none());
    }
}
