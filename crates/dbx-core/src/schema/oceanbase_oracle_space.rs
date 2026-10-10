//! OceanBase space is a Leader snapshot, never Oracle segment accounting.
//! See runtime/ob-parity-11412/O12b-delivery.md for the versioned dictionary contract.
use super::*;
use dbx_types::types::{ObjectSpaceStatistics, SpaceComponent};
use std::collections::HashMap;

const TABLE_SOURCE: &str = "SYS.DBA_OB_TABLE_SPACE_USAGE";
const TABLET_SOURCE: &str = "SYS.DBA_OB_TABLE_LOCATIONS + SYS.DBA_OB_TABLET_REPLICAS";

pub(super) async fn load_statistics(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    timeout: Option<Duration>,
) -> Result<Vec<db::ObjectStatistics>, String> {
    let resolved_schema;
    let schema = if schema.is_empty() {
        let mut connection = client.lock().await;
        let current = agent_object_statistics_query(
            &mut connection,
            database,
            schema,
            "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL",
            timeout,
        )
        .await?;
        resolved_schema = current
            .rows
            .first()
            .and_then(|row| query_result_cell_string(row, 0))
            .ok_or("OceanBase current schema unavailable")?;
        resolved_schema.as_str()
    } else {
        schema
    };
    let rows = oceanbase_oracle_statistics::load(client.clone(), database, schema, timeout).await;
    if let Err(error) = &rows {
        if cancelled(error) {
            return Err(error.clone());
        }
    }
    let row_error = rows.as_ref().err().cloned();
    let mut statistics = rows.unwrap_or_default();
    load(client, database, schema, timeout, &mut statistics).await?;
    if statistics.is_empty() {
        if let Some(error) = row_error {
            return Err(error);
        }
    } else {
        for stat in &mut statistics {
            if stat.rows_status.is_none() {
                stat.rows_status = Some(
                    row_error
                        .as_deref()
                        .map(|error| match error_status(error) {
                            "permission_denied" => "permission_denied",
                            "unsupported_or_denied" => "unknown",
                            _ => "error",
                        })
                        .unwrap_or("unknown")
                        .into(),
                );
                stat.rows_source = Some("SYS.ALL_TAB_STATISTICS (TABLE/global)".into());
            }
        }
    }
    Ok(statistics)
}

async fn load(
    client: Arc<db::agent_driver::PooledAgentClient>,
    database: &str,
    schema: &str,
    timeout: Option<Duration>,
    statistics: &mut Vec<db::ObjectStatistics>,
) -> Result<(), String> {
    collect(schema, statistics, |sql| {
        let client = client.clone();
        async move {
            let mut client = client.lock().await;
            agent_object_statistics_query(&mut client, database, schema, &sql, timeout).await
        }
    })
    .await
}

// Two schema-scoped sources, paged in batches rather than queried per table.
// A successful query is the capability probe; no server version string enables a view.
async fn collect<F, Fut>(schema: &str, statistics: &mut Vec<db::ObjectStatistics>, mut query: F) -> Result<(), String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<db::QueryResult, String>>,
{
    let modern = snapshot(&mut query, "", format!(
        "SELECT TABLE_NAME, DATABASE_NAME, OCCUPY_SIZE, REQUIRED_SIZE FROM SYS.DBA_OB_TABLE_SPACE_USAGE WHERE DATABASE_NAME = {}",
        sql_string(schema)
    ), &[(0, "TABLE_NAME")]).await;
    if let Err(error) = &modern {
        if cancelled(error) {
            return Err(error.clone());
        }
    }
    let (component_ctes, component_select) = component_sql(schema);
    let components =
        snapshot(&mut query, &component_ctes, component_select, &[(0, "TABLE_NAME"), (2, "TABLE_TYPE")]).await;
    if let Err(error) = &components {
        if cancelled(error) {
            return Err(error.clone());
        }
    }
    let mut by_name = HashMap::<String, ObjectSpaceStatistics>::new();
    if let Ok(result) = &modern {
        for row in &result.rows {
            if query_result_cell_string(row, 1).as_deref() != Some(schema) {
                continue;
            }
            let Some(name) = query_result_cell_string(row, 0) else {
                continue;
            };
            let data = bytes(row, 2);
            let allocated = bytes(row, 3);
            by_name.insert(
                name,
                ObjectSpaceStatistics {
                    status: if data.is_some() && allocated.is_some() { "available" } else { "unknown" }.into(),
                    source: TABLE_SOURCE.into(),
                    replica_scope: "leader".into(),
                    data_bytes: data,
                    allocated_bytes: allocated,
                    components_status: "unknown".into(),
                    components: vec![],
                },
            );
        }
    }
    let component_status = match &components {
        Ok(_) => "available",
        Err(error) => error_status(error),
    };
    if let Ok(result) = &components {
        for row in &result.rows {
            if query_result_cell_string(row, 1).as_deref() != Some(schema) {
                continue;
            }
            let Some(name) = query_result_cell_string(row, 0) else {
                continue;
            };
            let Some(kind) = query_result_cell_string(row, 2) else {
                continue;
            };
            if !matches!(kind.as_str(), "USER TABLE" | "INDEX" | "LOB AUX TABLE") {
                continue;
            }
            let data = bytes(row, 3);
            let allocated = bytes(row, 4);
            let entry = by_name.entry(name).or_insert_with(|| ObjectSpaceStatistics {
                status: "unknown".into(),
                source: TABLET_SOURCE.into(),
                replica_scope: "leader".into(),
                components_status: "available".into(),
                ..Default::default()
            });
            // The modern table metric and tablet components are independent snapshots.
            // Do not add them together or imply that either is a full tenant disk total.
            if entry.source == TABLET_SOURCE && kind == "USER TABLE" {
                entry.data_bytes = data;
                entry.allocated_bytes = allocated;
                entry.status = if data.is_some() && allocated.is_some() { "available" } else { "unknown" }.into();
            }
            entry.components.push(SpaceComponent { kind, data_bytes: data, allocated_bytes: allocated });
        }
    }
    for stat in statistics.iter_mut().filter(|stat| stat.schema.as_deref() == Some(schema)) {
        let mut space = by_name.remove(&stat.name).unwrap_or_else(|| ObjectSpaceStatistics {
            status: match (&modern, &components) {
                (Err(a), Err(b))
                    if error_status(a) == "permission_denied" || error_status(b) == "permission_denied" =>
                {
                    "permission_denied"
                }
                (Err(a), Err(b))
                    if error_status(a) == "unsupported_or_denied" && error_status(b) == "unsupported_or_denied" =>
                {
                    "unsupported_or_denied"
                }
                (Err(_), Err(_)) => "error",
                _ => "unknown",
            }
            .into(),
            source: if modern.is_ok() { TABLE_SOURCE } else { TABLET_SOURCE }.into(),
            replica_scope: "leader".into(),
            ..Default::default()
        });
        space.components_status = component_status.into();
        // total_bytes intentionally stays unknown: source table bytes have no
        // proven equivalence to the existing table+index+LOB total contract.
        stat.space = Some(space);
    }
    // Space dictionaries may expose a table with no global optimizer statistics.
    // These names come from the server, never from a fabricated placeholder row.
    for (name, mut space) in by_name {
        space.components_status = component_status.into();
        statistics.push(db::ObjectStatistics {
            name,
            schema: Some(schema.into()),
            space: Some(space),
            ..Default::default()
        });
    }
    Ok(())
}

fn bytes(row: &[serde_json::Value], index: usize) -> Option<i64> {
    let value = row.get(index)?;
    // Do not round floating point, overflow, negative or unknown dictionary values.
    value.as_i64().or_else(|| value.as_str()?.parse().ok()).filter(|value| *value >= 0)
}

fn complete(result: db::QueryResult) -> Result<db::QueryResult, String> {
    if result.truncated || result.has_more {
        Err("Space statistics snapshot was truncated".into())
    } else {
        Ok(result)
    }
}

async fn snapshot<F, Fut>(
    query: &mut F,
    prefix: &str,
    sql: String,
    keys: &[(usize, &str)],
) -> Result<db::QueryResult, String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<db::QueryResult, String>>,
{
    let mut after: Option<Vec<String>> = None;
    let mut output: Option<db::QueryResult> = None;
    loop {
        let predicate = after
            .as_ref()
            .map(|values| {
                (0..keys.len())
                    .map(|i| {
                        let mut terms =
                            (0..i).map(|j| format!("{} = {}", keys[j].1, sql_string(&values[j]))).collect::<Vec<_>>();
                        terms.push(format!("{} > {}", keys[i].1, sql_string(&values[i])));
                        format!("({})", terms.join(" AND "))
                    })
                    .collect::<Vec<_>>()
                    .join(" OR ")
            })
            .unwrap_or_else(|| "1 = 1".into());
        let order = keys.iter().map(|(_, name)| *name).collect::<Vec<_>>().join(", ");
        let page_sql = format!(
            "{prefix}SELECT * FROM (SELECT s.* FROM ({sql}) s WHERE {predicate} ORDER BY {order}) WHERE ROWNUM <= 1000"
        );
        let mut page = complete(query(page_sql).await?)?;
        let count = page.rows.len();
        if count == 1000 {
            let last = page.rows.last().unwrap();
            let next = keys
                .iter()
                .map(|(i, _)| {
                    query_result_cell_string(last, *i).ok_or_else(|| "Missing space statistics paging key".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            if after.as_ref() == Some(&next) {
                return Err("Space statistics paging did not advance".into());
            }
            after = Some(next);
        }
        if let Some(output) = output.as_mut() {
            output.rows.append(&mut page.rows);
        } else {
            output = Some(page);
        }
        if count < 1000 {
            return Ok(output.unwrap());
        }
    }
}

fn cancelled(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("cancel") || error.contains("ora-01013")
}

fn error_status(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if error.contains("ora-01031") || error.contains("permission") || error.contains("privilege") {
        "permission_denied"
    } else if error.contains("ora-00942")
        || error.contains("ora-00904")
        || error.contains("does not exist")
        || error.contains("unknown column")
    {
        // Oracle deliberately conceals inaccessible objects as missing objects.
        "unsupported_or_denied"
    } else {
        "error"
    }
}

fn component_sql(schema: &str) -> (String, String) {
    let ctes = format!(
        r#"WITH loc AS (
 SELECT DISTINCT DATABASE_NAME, TABLE_NAME, TABLE_ID, TABLE_TYPE, DATA_TABLE_ID,
                 TABLET_ID, LS_ID, SVR_IP, SVR_PORT, ROLE
 FROM SYS.DBA_OB_TABLE_LOCATIONS WHERE DATABASE_NAME = {owner}
), objects AS (
 SELECT DISTINCT DATABASE_NAME, TABLE_NAME, TABLE_ID, TABLE_TYPE, DATA_TABLE_ID FROM loc
), tablets AS (
 SELECT DISTINCT TABLE_ID, TABLET_ID FROM loc
), leaders AS (
 SELECT l.TABLE_ID, l.TABLET_ID, r.DATA_SIZE, r.REQUIRED_SIZE
 FROM loc l LEFT JOIN SYS.DBA_OB_TABLET_REPLICAS r
 ON r.TABLET_ID = l.TABLET_ID AND r.LS_ID = l.LS_ID
 AND r.SVR_IP = l.SVR_IP AND r.SVR_PORT = l.SVR_PORT
 WHERE l.ROLE = 'LEADER'
)
"#,
        owner = sql_string(schema)
    );
    let select = r#"SELECT root.TABLE_NAME, root.DATABASE_NAME, o.TABLE_TYPE,
 CASE WHEN COUNT(*) = COUNT(DISTINCT t.TABLET_ID) AND COUNT(l.DATA_SIZE) = COUNT(*) THEN SUM(l.DATA_SIZE) END AS DATA_BYTES,
 CASE WHEN COUNT(*) = COUNT(DISTINCT t.TABLET_ID) AND COUNT(l.REQUIRED_SIZE) = COUNT(*) THEN SUM(l.REQUIRED_SIZE) END AS ALLOCATED_BYTES
FROM objects o JOIN tablets t ON t.TABLE_ID = o.TABLE_ID
LEFT JOIN objects parent ON parent.TABLE_ID = o.DATA_TABLE_ID
JOIN objects root ON root.TABLE_ID = CASE
 WHEN o.TABLE_TYPE = 'USER TABLE' THEN o.TABLE_ID
 WHEN parent.TABLE_TYPE = 'USER TABLE' THEN parent.TABLE_ID ELSE parent.DATA_TABLE_ID END
 AND root.TABLE_TYPE = 'USER TABLE'
LEFT JOIN leaders l ON l.TABLE_ID = t.TABLE_ID AND l.TABLET_ID = t.TABLET_ID
WHERE o.TABLE_TYPE IN ('USER TABLE', 'INDEX', 'LOB AUX TABLE')
GROUP BY root.TABLE_NAME, root.DATABASE_NAME, o.TABLE_TYPE"#;
    (ctes, select.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;

    fn result(rows: Vec<Vec<serde_json::Value>>) -> db::QueryResult {
        serde_json::from_value(json!({"columns": [], "rows": rows, "affected_rows": 0, "execution_time_ms": 0}))
            .unwrap()
    }

    fn tables() -> Vec<db::ObjectStatistics> {
        vec![
            db::ObjectStatistics {
                name: "T".into(),
                schema: Some("A".into()),
                estimated_rows: Some(8),
                ..Default::default()
            },
            db::ObjectStatistics { name: "T".into(), schema: Some("B".into()), ..Default::default() },
        ]
    }

    #[test]
    fn component_cte_ends_with_sql_whitespace_instead_of_a_literal_escape() {
        let (ctes, _) = component_sql("APP");
        assert!(ctes.ends_with(")\n"));
        assert!(!ctes.contains(r"\n"));
    }

    #[tokio::test]
    async fn modern_table_and_components_remain_separate_and_preserve_rows() {
        let mut stats = tables();
        let mut replies = VecDeque::from([
            Ok(result(vec![vec![json!("T"), json!("A"), json!("100"), json!("8192")]])),
            Ok(result(vec![vec![json!("T"), json!("A"), json!("INDEX"), json!(20), json!(4096)]])),
        ]);
        let mut calls = 0;
        collect("A", &mut stats, |_| {
            calls += 1;
            std::future::ready(replies.pop_front().unwrap())
        })
        .await
        .unwrap();
        let space = stats[0].space.as_ref().unwrap();
        assert_eq!(calls, 2);
        assert_eq!(space.allocated_bytes, Some(8192));
        assert_eq!(space.components[0].allocated_bytes, Some(4096));
        assert_eq!(stats[0].estimated_rows, Some(8));
        assert_eq!(stats[0].total_bytes, None);
        assert!(stats[1].space.is_none());
    }

    #[tokio::test]
    async fn missing_modern_view_uses_legacy_real_zero_without_faking_missing_lob() {
        let mut stats = tables();
        let mut replies = VecDeque::from([
            Err("ORA-00942".into()),
            Ok(result(vec![
                vec![json!("T"), json!("A"), json!("USER TABLE"), json!(0), json!(0)],
                vec![json!("T"), json!("A"), json!("INDEX"), json!(null), json!(null)],
            ])),
        ]);
        collect("A", &mut stats, |_| std::future::ready(replies.pop_front().unwrap())).await.unwrap();
        let space = stats[0].space.as_ref().unwrap();
        assert_eq!(space.source, TABLET_SOURCE);
        assert_eq!(space.data_bytes, Some(0));
        assert_eq!(space.status, "available");
        assert_eq!(space.components[1].data_bytes, None);
        assert_eq!(space.components.len(), 2);
    }

    #[tokio::test]
    async fn access_errors_do_not_fail_table_statistics_or_report_zero() {
        let mut stats = tables();
        collect("A", &mut stats, |_| std::future::ready(Err("ORA-01031 insufficient privileges".into())))
            .await
            .unwrap();
        let space = stats[0].space.as_ref().unwrap();
        assert_eq!(space.status, "permission_denied");
        assert_eq!(space.data_bytes, None);
        assert_eq!(stats[0].estimated_rows, Some(8));
    }

    #[tokio::test]
    async fn space_can_supply_names_when_optimizer_dictionary_is_unavailable() {
        let mut stats = vec![];
        let mut replies = VecDeque::from([
            Ok(result(vec![vec![json!("T"), json!("A"), json!(1), json!(8192)]])),
            Err("ORA-01031".into()),
        ]);
        collect("A", &mut stats, |_| std::future::ready(replies.pop_front().unwrap())).await.unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].name, "T");
        assert_eq!(stats[0].estimated_rows, None);
        assert_eq!(stats[0].space.as_ref().unwrap().components_status, "permission_denied");
    }

    #[tokio::test]
    async fn cancellation_does_not_probe_another_source_or_publish_partial_data() {
        let mut stats = tables();
        let mut calls = 0;
        let error = collect("A", &mut stats, |_| {
            calls += 1;
            std::future::ready(Err("ORA-01013 cancelled".into()))
        })
        .await
        .unwrap_err();
        assert!(error.contains("ORA-01013"));
        assert_eq!(calls, 1);
        assert!(stats[0].space.is_none());
    }

    #[tokio::test]
    async fn refresh_replaces_deleted_or_invalid_statistics_with_unknown() {
        let mut stats = tables();
        collect("A", &mut stats, |_| std::future::ready(Ok(result(vec![])))).await.unwrap();
        assert_eq!(stats[0].space.as_ref().unwrap().status, "unknown");
        assert_eq!(stats[0].space.as_ref().unwrap().allocated_bytes, None);
    }

    #[tokio::test]
    async fn large_schema_reads_bounded_pages_and_does_not_drop_tail_tables() {
        let mut stats =
            vec![db::ObjectStatistics { name: "T1000".into(), schema: Some("A".into()), ..Default::default() }];
        let first = (0..1000).map(|i| vec![json!(format!("T{i:04}")), json!("A"), json!(1), json!(8192)]).collect();
        let mut replies = VecDeque::from([
            Ok(result(first)),
            Ok(result(vec![vec![json!("T1000"), json!("A"), json!(2), json!(8192)]])),
            Ok(result(vec![])),
        ]);
        let mut calls = 0;
        collect("A", &mut stats, |_| {
            calls += 1;
            std::future::ready(replies.pop_front().unwrap())
        })
        .await
        .unwrap();
        assert_eq!(calls, 3);
        assert_eq!(stats[0].space.as_ref().unwrap().data_bytes, Some(2));
    }

    #[tokio::test]
    async fn truncated_or_unrepresentable_values_are_not_published_as_complete_bytes() {
        let mut stats = tables();
        let mut truncated = result(vec![vec![json!("T"), json!("A"), json!(20), json!(8192)]]);
        truncated.truncated = true;
        let mut replies = VecDeque::from([
            Ok(truncated),
            Ok(result(vec![vec![
                json!("T"),
                json!("A"),
                json!("USER TABLE"),
                json!("999999999999999999999"),
                json!(-1),
            ]])),
        ]);
        collect("A", &mut stats, |_| std::future::ready(replies.pop_front().unwrap())).await.unwrap();
        let space = stats[0].space.as_ref().unwrap();
        assert_eq!(space.status, "unknown");
        assert_eq!(space.data_bytes, None);
        assert_eq!(space.allocated_bytes, None);
    }
}
