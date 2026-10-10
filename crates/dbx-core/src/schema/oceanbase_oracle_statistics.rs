use super::*;

// ALL_TAB_STATISTICS has existed since OB 3.2.1. Probe its documented columns
// through the read itself: an absent view/column must not become a zero estimate.
// Only TABLE rows represent global statistics; never add partition estimates.
fn sql(schema: &str, after: Option<&str>) -> String {
    let owner =
        if schema.is_empty() { "SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')".to_string() } else { sql_string(schema) };
    let cursor = after.map(|name| format!(" AND TABLE_NAME > {}", sql_string(name))).unwrap_or_default();
    format!(
        "SELECT * FROM (SELECT TABLE_NAME, OWNER, NUM_ROWS, \
         TO_CHAR(LAST_ANALYZED, 'YYYY-MM-DD HH24:MI:SS'), STALE_STATS \
         FROM SYS.ALL_TAB_STATISTICS WHERE OWNER = {owner} AND OBJECT_TYPE = 'TABLE' \
         AND PARTITION_NAME IS NULL AND SUBPARTITION_NAME IS NULL{cursor} ORDER BY TABLE_NAME) WHERE ROWNUM <= 1000"
    )
}

pub(super) async fn load(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    timeout_duration: Option<Duration>,
) -> Result<Vec<db::ObjectStatistics>, String> {
    let mut client = client.lock().await;
    let mut rows = Vec::new();
    let mut after = None;
    loop {
        let result = agent_object_statistics_query(
            &mut client,
            database,
            schema,
            &sql(schema, after.as_deref()),
            timeout_duration,
        )
        .await?;
        if result.truncated || result.has_more {
            return Err("OceanBase statistics response was truncated".into());
        }
        let full = result.rows.len() == 1000;
        let next = result.rows.last().and_then(|row| query_result_cell_string(row, 0));
        rows.extend(result.rows);
        if !full {
            break;
        }
        if next.is_none() || next == after {
            return Err("OceanBase statistics cursor did not advance".into());
        }
        after = next;
    }
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let name = query_result_cell_string(&row, 0)?;
            let estimated_rows = query_result_cell_i64(&row, 2).filter(|rows| *rows >= 0);
            let last_analyzed = query_result_cell_string(&row, 3).filter(|value| !value.is_empty());
            let status = if estimated_rows.is_some() {
                "available"
            } else if last_analyzed.is_none() {
                "not_collected"
            } else {
                "unknown"
            };
            Some(db::ObjectStatistics {
                name,
                schema: query_result_cell_string(&row, 1),
                estimated_rows,
                rows_status: Some(status.into()),
                rows_source: Some("SYS.ALL_TAB_STATISTICS (TABLE/global)".into()),
                rows_last_analyzed: last_analyzed,
                rows_stale: match query_result_cell_string(&row, 4).as_deref() {
                    Some("YES") => Some(true),
                    Some("NO") => Some(false),
                    _ => None,
                },
                ..Default::default()
            })
        })
        .collect())
}
