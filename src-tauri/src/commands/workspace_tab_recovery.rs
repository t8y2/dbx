use serde_json::{json, Value};

const RECOVERED_RESULT_FIELDS: &[&str] = &[
    "lastExecutedSql",
    "resultBaseSql",
    "resultSortedSql",
    "resultSortColumn",
    "resultSortColumnIndex",
    "resultSortDirection",
    "resultSortMode",
    "resultPageLimit",
    "resultPageOffset",
    "resultExecutedPageLimit",
    "resultExecutedPageOffset",
    "orderByInput",
    "structuredOrderByInput",
    "whereInput",
    "resultEvicted",
    "resultCacheKey",
    "resultRuns",
    "activeResultRunId",
    "tableMeta",
];

fn sql_revision(tab: &Value) -> i64 {
    tab.get("sqlUpdatedAt").and_then(Value::as_i64).unwrap_or_default()
}

fn latest_result_marker(tab: &Value) -> (i64, i64) {
    tab.get("resultRuns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|run| {
            (
                run.get("createdAt").and_then(Value::as_i64).unwrap_or_default(),
                run.get("sequence").and_then(Value::as_i64).unwrap_or_default(),
            )
        })
        .max()
        .unwrap_or_default()
}

fn merge_result_fields(main: &mut Value, child: &Value) {
    let Some(main) = main.as_object_mut() else {
        return;
    };
    for field in RECOVERED_RESULT_FIELDS {
        if let Some(value) = child.get(*field) {
            main.insert((*field).to_string(), value.clone());
        } else {
            main.remove(*field);
        }
    }
}

/// Merge tabs from closed workspace snapshots without discarding newer SQL or query results.
pub fn merge_recovered_tabs(main: &mut Value, child: &Value) {
    let Some(child_tabs) = child.get("tabs").and_then(Value::as_array) else {
        return;
    };
    if !main.is_object() {
        *main = json!({ "tabs": [], "activeTabId": null });
    }
    if !main.get("tabs").is_some_and(Value::is_array) {
        main["tabs"] = json!([]);
    }
    let tabs = main["tabs"].as_array_mut().unwrap();
    for child_tab in child_tabs {
        let Some(id) = child_tab.get("id").and_then(Value::as_str) else {
            continue;
        };
        if let Some(index) = tabs.iter().position(|tab| tab.get("id").and_then(Value::as_str) == Some(id)) {
            let main_tab = &mut tabs[index];
            match sql_revision(child_tab).cmp(&sql_revision(main_tab)) {
                std::cmp::Ordering::Greater => *main_tab = child_tab.clone(),
                std::cmp::Ordering::Equal if latest_result_marker(child_tab) > latest_result_marker(main_tab) => {
                    merge_result_fields(main_tab, child_tab);
                }
                _ => {}
            }
        } else {
            tabs.push(child_tab.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::merge_recovered_tabs;
    use serde_json::json;

    #[test]
    fn newer_sql_revision_recovers_the_child_tab_without_replacing_main_layout() {
        let mut main =
            json!({ "tabs": [{ "id": "a", "sql": "old", "sqlUpdatedAt": 10 }], "groups": [{ "id": "main" }] });
        merge_recovered_tabs(
            &mut main,
            &json!({ "tabs": [{ "id": "a", "sql": "new", "sqlUpdatedAt": 20 }, { "id": "b" }] }),
        );

        assert_eq!(main["tabs"].as_array().unwrap().len(), 2);
        assert_eq!(main["tabs"][0]["sql"], "new");
        assert_eq!(main["groups"][0]["id"], "main");
    }

    #[test]
    fn newer_child_result_run_is_recovered_when_sql_is_unchanged() {
        let mut main = json!({ "tabs": [{
            "id": "a", "title": "Main title", "sql": "SELECT 1", "sqlUpdatedAt": 10,
            "resultRuns": [{ "id": "old-run", "sequence": 1, "createdAt": 100 }],
            "activeResultRunId": "old-run", "resultCacheKey": "old-cache", "lastExecutedSql": "SELECT 1"
        }] });
        merge_recovered_tabs(
            &mut main,
            &json!({ "tabs": [{
            "id": "a", "title": "Stale child title", "sql": "SELECT 1", "sqlUpdatedAt": 10,
            "resultRuns": [{ "id": "new-run", "sequence": 2, "createdAt": 200 }],
            "activeResultRunId": "new-run", "resultCacheKey": "new-cache", "lastExecutedSql": "SELECT 1"
        }] }),
        );

        assert_eq!(main["tabs"][0]["title"], "Main title");
        assert_eq!(main["tabs"][0]["activeResultRunId"], "new-run");
        assert_eq!(main["tabs"][0]["resultRuns"][0]["id"], "new-run");
        assert_eq!(main["tabs"][0]["resultCacheKey"], "new-cache");
    }

    #[test]
    fn stale_child_sql_does_not_replace_newer_main_or_its_result() {
        let mut main = json!({ "tabs": [{
            "id": "a", "sql": "new SQL", "sqlUpdatedAt": 20,
            "resultRuns": [{ "id": "main-run", "sequence": 1, "createdAt": 100 }],
            "activeResultRunId": "main-run"
        }] });
        merge_recovered_tabs(
            &mut main,
            &json!({ "tabs": [{
            "id": "a", "sql": "stale SQL", "sqlUpdatedAt": 10,
            "resultRuns": [{ "id": "child-run", "sequence": 9, "createdAt": 900 }],
            "activeResultRunId": "child-run"
        }] }),
        );

        assert_eq!(main["tabs"][0]["sql"], "new SQL");
        assert_eq!(main["tabs"][0]["activeResultRunId"], "main-run");
    }
}
