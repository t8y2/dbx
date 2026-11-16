use super::*;

#[derive(Clone)]
pub struct Snapshot {
    identity: NativeJobMetadata<NativeJobRow>,
    consistent: bool,
    running: NativeJobMetadata<Vec<NativeJobRow>>,
    history: NativeJobMetadata<Vec<NativeJobRow>>,
    sources: BTreeMap<String, NativeJobCatalogSource>,
    owner: Option<String>,
}

impl Snapshot {
    pub fn from_details(details: &NativeJobDetails) -> Self {
        Self {
            identity: details.native_identity.clone(),
            consistent: matches!(details.consistency, NativeJobMetadata::Available { .. }),
            running: details.running.clone(),
            history: details.history.clone(),
            sources: details
                .sources
                .iter()
                .filter(|(key, _)| matches!(key.as_str(), "running" | "history" | "identity"))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
            owner: row(details)
                .and_then(|row| row.get("OWNER").or_else(|| row.get("LOG_USER")).or_else(|| row.get("USERNAME")))
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }
}

pub(super) struct Tracker {
    pub binding: super::super::service::BoundContext,
    pub target: NativeJobRef,
    pub stop: bool,
    pub baseline: Snapshot,
    pub running_keys: HashSet<String>,
}

impl Tracker {
    pub(super) fn record(&mut self, current: Snapshot) -> NativeJobExecutionObservation {
        if self.binding.context.engine == NativeJobEngine::Oracle
            && matches!(self.target, NativeJobRef::Scheduler { .. })
            && current.consistent
            && self.baseline.identity == current.identity
        {
            if let Ok(running) = keyed(&current.running, "LOG_ID") {
                self.running_keys.extend(running.into_keys());
            }
        }
        compare(
            self.binding.context.engine,
            &self.target,
            &self.binding.context.session_user,
            self.stop,
            &self.baseline,
            &self.running_keys,
            current,
        )
    }
}

pub(super) async fn read_core(
    state: &AppState,
    binding: &super::super::service::BoundContext,
    target: &NativeJobRef,
) -> Result<Snapshot, &'static str> {
    let scope = target.scope();
    if !state.connection_lifecycle_is_current(&scope.connection_id, &binding.lifecycle) {
        return Err("native_job_context_changed");
    }
    let timeout = super::super::super::agent_metadata_timeout(state.configs.read().await.get(&scope.connection_id));
    let (session, pool) = super::super::service::open_pool(state, scope).await?;
    let result = async {
        super::super::service::validate_runtime_context(state, binding, &pool).await?;
        let observed = tokio::select! {
            biased;
            _ = binding.lifecycle.cancellation().cancelled() => return Err("native_job_context_changed"),
            observed = read(binding.context.engine, target, |query| execute_catalog_query(binding.context.engine, &pool, &scope.database, query, timeout)) => observed?,
        };
        super::super::service::validate_runtime_context(state, binding, &pool).await?;
        Ok(observed)
    }.await;
    session.finish(state, &scope.connection_id, (!scope.database.is_empty()).then_some(scope.database.as_str())).await;
    result
}

pub(super) async fn read<Q, F>(
    engine: NativeJobEngine,
    target: &NativeJobRef,
    mut query: Q,
) -> Result<Snapshot, &'static str>
where
    Q: FnMut(NativeJobCatalogQuery) -> F,
    F: Future<Output = Result<Value, NativeJobCatalogFailure>>,
{
    let before =
        read_native_job_catalog_part_with(engine, target, NativeJobCatalogPart::Generation, &mut query).await?;
    let running = read_native_job_catalog_part_with(engine, target, NativeJobCatalogPart::Running, &mut query).await?;
    let history = read_native_job_catalog_part_with(engine, target, NativeJobCatalogPart::History, &mut query).await?;
    let after = read_native_job_catalog_part_with(engine, target, NativeJobCatalogPart::Generation, &mut query).await?;
    let consistent = matches!((&before.data, &after.data),
        (NativeJobMetadata::Available { value: before }, NativeJobMetadata::Available { value: after })
        if before.len() == 1 && before == after);
    let mut sources = BTreeMap::new();
    for (name, section) in [("running", &running), ("history", &history), ("identity", &after)] {
        sources.insert(
            name.into(),
            NativeJobCatalogSource { source: section.source.map(str::to_string), coverage: section.coverage },
        );
    }
    Ok(Snapshot {
        identity: super::super::details::map_metadata(after.data, |rows| rows.into_iter().next().unwrap_or_default()),
        consistent,
        running: running.data,
        history: history.data,
        sources,
        owner: None,
    })
}

fn rows(metadata: &NativeJobMetadata<Vec<NativeJobRow>>) -> Option<&[NativeJobRow]> {
    match metadata {
        NativeJobMetadata::Available { value } => Some(value),
        NativeJobMetadata::Empty => Some(&[]),
        _ => None,
    }
}

fn key(row: &NativeJobRow, column: &str) -> Option<String> {
    let value = row.get(column)?;
    let number = match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => {
            value.as_i64().map(|value| value.to_string()).or_else(|| value.as_u64().map(|value| value.to_string()))?
        }
        _ => return None,
    };
    let digits = number.strip_prefix('-').unwrap_or(&number);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let normalized = digits.trim_start_matches('0');
    Some(if normalized.is_empty() {
        "0".into()
    } else if number.starts_with('-') {
        format!("-{normalized}")
    } else {
        normalized.into()
    })
}

fn keyed(
    metadata: &NativeJobMetadata<Vec<NativeJobRow>>,
    column: &str,
) -> Result<BTreeMap<String, NativeJobRow>, &'static str> {
    let mut result = BTreeMap::new();
    for row in rows(metadata).ok_or("native_job_observation_incomplete")? {
        let key = key(row, column).ok_or("native_job_observation_key_unavailable")?;
        if result.insert(key, row.clone()).is_some() {
            return Err("native_job_observation_key_ambiguous");
        }
    }
    Ok(result)
}

fn wire_ids(row: &mut NativeJobRow) {
    for column in ["LOG_ID", "EXEC_ID", "JOBID", "JOB", "SID", "SESSION_ID", "INSTANCE_ID", "DEST_ID"] {
        if let Some(id) = key(row, column) {
            row.insert(column.into(), Value::String(id));
        }
    }
}

fn wire_partition(metadata: &mut NativeJobMetadata<Vec<NativeJobRow>>) {
    if let NativeJobMetadata::Available { value } | NativeJobMetadata::Truncated { value, .. } = metadata {
        for row in value {
            wire_ids(row);
        }
    }
}

pub(super) fn unavailable(reason: &str) -> NativeJobExecutionObservation {
    NativeJobExecutionObservation {
        observed_at: chrono::Utc::now().to_rfc3339(),
        association: "unavailable".into(),
        reason: reason.into(),
        running: NativeJobMetadata::Unknown { reason: reason.into() },
        history: NativeJobMetadata::Unknown { reason: reason.into() },
        sources: BTreeMap::new(),
        candidates: Vec::new(),
    }
}

fn compare(
    engine: NativeJobEngine,
    target: &NativeJobRef,
    session_user: &str,
    stop: bool,
    baseline: &Snapshot,
    seen_running: &HashSet<String>,
    current: Snapshot,
) -> NativeJobExecutionObservation {
    if !baseline.consistent
        || !current.consistent
        || !matches!(baseline.identity, NativeJobMetadata::Available { .. })
        || baseline.identity != current.identity
    {
        return unavailable("native_job_observation_generation_changed");
    }
    let mut result = NativeJobExecutionObservation {
        observed_at: chrono::Utc::now().to_rfc3339(),
        association: "uncertain".into(),
        reason: "native_job_observation_request_uncertain".into(),
        running: current.running.clone(),
        history: current.history.clone(),
        sources: current.sources.clone(),
        candidates: Vec::new(),
    };
    let mut partial = None;
    let candidates = (|| -> Result<Vec<NativeJobExecutionCandidate>, &'static str> {
        let coverage = |snapshot: &Snapshot, partition: &str| -> Result<(), &'static str> {
            let owner = match target {
                NativeJobRef::Scheduler { owner, .. } => Some(owner.as_str()),
                _ => baseline.owner.as_deref(),
            };
            match snapshot.sources.get(partition).and_then(|source| source.coverage) {
                Some(NativeJobCatalogCoverage::Database | NativeJobCatalogCoverage::Accessible) => {}
                Some(NativeJobCatalogCoverage::CurrentUser) if owner == Some(session_user) => {}
                _ => return Err("native_job_observation_coverage_incomplete"),
            }
            Ok(())
        };
        if engine == NativeJobEngine::Oracle && matches!(target, NativeJobRef::Scheduler { .. }) {
            let old_running = coverage(baseline, "running").and_then(|_| keyed(&baseline.running, "LOG_ID"));
            if stop {
                old_running.as_ref().map_err(|reason| *reason)?;
            }
            let old_history = if stop {
                Ok(BTreeMap::new())
            } else {
                coverage(baseline, "history").and_then(|_| keyed(&baseline.history, "LOG_ID"))
            };
            let baseline_complete = old_running.is_ok() && old_history.is_ok();
            let running = coverage(&current, "running").and_then(|_| keyed(&current.running, "LOG_ID"));
            let history = coverage(&current, "history").and_then(|_| keyed(&current.history, "LOG_ID"));
            let current_complete = running.is_ok() && history.is_ok();
            let mut available = |value: Result<BTreeMap<String, NativeJobRow>, &'static str>| match value {
                Ok(value) => value,
                Err(reason) => {
                    partial = Some(reason);
                    BTreeMap::new()
                }
            };
            let old_running = available(old_running);
            let old_history = available(old_history);
            let running = available(running);
            let history = available(history);
            let mut selected = BTreeMap::new();
            for (id, row) in &running {
                if (stop && old_running.contains_key(id))
                    || (!stop
                        && !old_running.contains_key(id)
                        && !old_history.contains_key(id)
                        && (baseline_complete || seen_running.contains(id)))
                {
                    selected.insert(
                        id.clone(),
                        NativeJobExecutionCandidate {
                            native_key: id.clone(),
                            phase: "running".into(),
                            evidence: "running-log-id".into(),
                            row: row.clone(),
                        },
                    );
                }
            }
            for (id, row) in &history {
                if (stop && old_running.contains_key(id))
                    || (!stop
                        && !old_running.contains_key(id)
                        && !old_history.contains_key(id)
                        && (baseline_complete || seen_running.contains(id)))
                {
                    selected.insert(
                        id.clone(),
                        NativeJobExecutionCandidate {
                            native_key: id.clone(),
                            phase: "history".into(),
                            evidence: if old_running.contains_key(id)
                                || running.contains_key(id)
                                || seen_running.contains(id)
                            {
                                "running-log-id"
                            } else {
                                "new-history"
                            }
                            .into(),
                            row: row.clone(),
                        },
                    );
                }
            }
            if current_complete && stop {
                for id in old_running.keys().filter(|id| !running.contains_key(*id) && !history.contains_key(*id)) {
                    selected.insert(
                        id.clone(),
                        NativeJobExecutionCandidate {
                            native_key: id.clone(),
                            phase: "not-observed".into(),
                            evidence: "running-log-id".into(),
                            row: NativeJobRow::new(),
                        },
                    );
                }
            } else if current_complete {
                for id in seen_running.iter().filter(|id| {
                    !old_running.contains_key(*id)
                        && !old_history.contains_key(*id)
                        && !running.contains_key(*id)
                        && !history.contains_key(*id)
                }) {
                    selected.insert(
                        id.clone(),
                        NativeJobExecutionCandidate {
                            native_key: id.clone(),
                            phase: "not-observed".into(),
                            evidence: "running-log-id".into(),
                            row: NativeJobRow::new(),
                        },
                    );
                }
            }
            return Ok(selected.into_values().collect());
        }
        if engine == NativeJobEngine::Dameng && !stop {
            coverage(baseline, "history")?;
            coverage(&current, "history")?;
            let column = if matches!(target, NativeJobRef::Scheduler { .. }) { "LOG_ID" } else { "EXEC_ID" };
            let baseline = keyed(&baseline.history, column)?;
            return Ok(keyed(&current.history, column)?
                .into_iter()
                .filter(|(id, _)| !baseline.contains_key(id))
                .map(|(id, row)| NativeJobExecutionCandidate {
                    native_key: id,
                    phase: "history".into(),
                    evidence: "new-history".into(),
                    row,
                })
                .collect());
        }
        Err("native_job_observation_mapping_unverified")
    })();
    match candidates {
        Ok(candidates) => {
            result.candidates = candidates;
            if let Some(reason) = partial {
                result.reason = reason.into();
                if result.candidates.is_empty() {
                    result.association = "unavailable".into();
                }
            }
        }
        Err(reason) => {
            result.reason = reason.into();
            result.association = "unavailable".into();
        }
    }
    wire_partition(&mut result.running);
    wire_partition(&mut result.history);
    for candidate in &mut result.candidates {
        wire_ids(&mut candidate.row);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target() -> NativeJobRef {
        NativeJobRef::Scheduler {
            scope: NativeJobScope { connection_id: "c".into(), database: "".into(), context_id: "ctx".into() },
            owner: "Owner".into(),
            name: "Job".into(),
        }
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            identity: NativeJobMetadata::Available {
                value: serde_json::from_value(json!({"DBX_JOB_ID":"42","DBX_CREATED_AT":"creation"})).unwrap(),
            },
            consistent: true,
            running: NativeJobMetadata::Empty,
            history: NativeJobMetadata::Empty,
            sources: ["running", "history"]
                .into_iter()
                .map(|part| {
                    (
                        part.into(),
                        NativeJobCatalogSource {
                            source: Some("fixture".into()),
                            coverage: Some(NativeJobCatalogCoverage::Database),
                        },
                    )
                })
                .collect(),
            owner: Some("Owner".into()),
        }
    }
    fn data(value: Value) -> NativeJobMetadata<Vec<NativeJobRow>> {
        NativeJobMetadata::Available { value: serde_json::from_value(value).unwrap() }
    }
    fn oracle(stop: bool, before: &Snapshot, after: Snapshot) -> NativeJobExecutionObservation {
        compare(NativeJobEngine::Oracle, &target(), "Owner", stop, before, &HashSet::new(), after)
    }

    #[test]
    fn one_fast_history_failure_is_only_a_newly_observed_candidate() {
        let before = snapshot();
        let mut after = before.clone();
        after.history = data(json!([{"LOG_ID":"900719925474099312345","STATUS":"FAILED","ERROR#":20001}]));
        let result = oracle(false, &before, after);
        assert_eq!(result.association, "uncertain");
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].native_key, "900719925474099312345");
        assert_eq!(result.candidates[0].row["STATUS"], "FAILED");
        assert_eq!(result.candidates[0].evidence, "new-history");
    }

    #[test]
    fn oracle_baseline_running_and_history_share_one_instance_key_space() {
        let mut before = snapshot();
        before.running = data(json!([{"LOG_ID":9007199254740993_u64}]));
        before.history = data(json!([{"LOG_ID":"8"}]));
        let mut after = snapshot();
        after.history = data(json!([{"LOG_ID":"09007199254740993","STATUS":"SUCCEEDED"},{"LOG_ID":8}]));
        assert!(oracle(false, &before, after).candidates.is_empty());
    }

    #[test]
    fn a_previously_observed_running_key_can_be_followed_into_history_without_a_request_claim() {
        let before = snapshot();
        let seen = HashSet::from(["9007199254740993".into()]);
        let mut after = snapshot();
        after.history = data(json!([{"LOG_ID":9007199254740993_u64,"STATUS":"SUCCEEDED"}]));
        let result = compare(NativeJobEngine::Oracle, &target(), "Owner", false, &before, &seen, after);
        assert_eq!(result.association, "uncertain");
        assert_eq!(result.candidates[0].evidence, "running-log-id");
        assert_eq!(result.candidates[0].row["LOG_ID"], "9007199254740993");
        let NativeJobMetadata::Available { value } = result.history else { panic!("history retained") };
        assert_eq!(value[0]["LOG_ID"], "9007199254740993");
        let absent = compare(NativeJobEngine::Oracle, &target(), "Owner", false, &before, &seen, snapshot());
        assert_eq!(absent.candidates[0].phase, "not-observed");
    }

    #[test]
    fn newly_observed_keys_are_not_assumed_to_be_monotonically_increasing() {
        let mut before = snapshot();
        before.history = data(json!([{"LOG_ID":99}]));
        let mut after = snapshot();
        after.history = data(json!([{"LOG_ID":99},{"LOG_ID":1}]));
        assert_eq!(oracle(false, &before, after).candidates[0].native_key, "1");
    }

    #[test]
    fn stop_tracks_its_baseline_instance_without_attributing_the_terminal_state() {
        let mut before = snapshot();
        before.running = data(json!([{"LOG_ID":"7"}]));
        let mut after = snapshot();
        after.history = data(json!([{"LOG_ID":7,"STATUS":"STOPPED"},{"LOG_ID":8,"STATUS":"SUCCEEDED"}]));
        let result = oracle(true, &before, after);
        assert_eq!(result.association, "uncertain");
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].native_key, "7");
        assert_eq!(result.candidates[0].phase, "history");
        assert_eq!(result.candidates[0].evidence, "running-log-id");
        let gone = oracle(true, &before, snapshot());
        assert_eq!(gone.candidates[0].phase, "not-observed");
        assert_eq!(gone.association, "uncertain");
    }

    #[test]
    fn stop_does_not_require_baseline_history_or_an_unrelated_current_partition() {
        let mut before = snapshot();
        before.running = data(json!([{"LOG_ID":7}]));
        before.history = NativeJobMetadata::Denied { reason: "baseline history denied".into() };
        before.sources.remove("history");
        for readable in ["history", "running", "neither"] {
            let mut after = snapshot();
            after.running = if readable == "running" {
                data(json!([{"LOG_ID":7}]))
            } else {
                NativeJobMetadata::Denied { reason: "running denied".into() }
            };
            after.history = if readable == "history" {
                data(json!([{"LOG_ID":7,"STATUS":"STOPPED"}]))
            } else {
                NativeJobMetadata::Denied { reason: "history denied".into() }
            };
            let result = oracle(true, &before, after);
            if readable == "neither" {
                assert_eq!(result.association, "unavailable");
                assert!(result.candidates.is_empty());
            } else {
                assert_eq!(result.association, "uncertain");
                assert_eq!(result.candidates.len(), 1);
                assert_eq!(result.candidates[0].phase, readable);
                assert_eq!(result.candidates[0].native_key, "7");
            }
        }
    }

    #[test]
    fn a_captured_oracle_instance_remains_observable_when_the_request_baseline_was_incomplete() {
        let mut before = snapshot();
        before.history = NativeJobMetadata::Denied { reason: "baseline history denied".into() };
        let mut after = snapshot();
        after.running = NativeJobMetadata::Denied { reason: "running denied".into() };
        after.history = data(json!([{"LOG_ID":7,"STATUS":"FAILED"},{"LOG_ID":8,"STATUS":"SUCCEEDED"}]));
        let result =
            compare(NativeJobEngine::Oracle, &target(), "Owner", false, &before, &HashSet::from(["7".into()]), after);
        assert_eq!(result.association, "uncertain");
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].native_key, "7");
        assert_eq!(result.candidates[0].evidence, "running-log-id");
    }

    #[test]
    fn multiple_new_instances_are_retained_without_choosing_the_latest() {
        let before = snapshot();
        let mut after = snapshot();
        after.running = data(json!([{"LOG_ID":2,"JOB_SUBNAME":"child"}]));
        after.history = data(json!([{"LOG_ID":1,"STATUS":"SUCCEEDED","DESTINATION":"remote"}]));
        let result = oracle(false, &before, after);
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(result.association, "uncertain");
        assert_eq!(result.candidates[0].row["DESTINATION"], "remote");
        assert_eq!(result.candidates[1].row["JOB_SUBNAME"], "child");
    }

    #[test]
    fn ambiguous_missing_fractional_or_truncated_keys_do_not_create_candidates() {
        for history in [
            data(json!([{"LOG_ID":1},{"LOG_ID":"1"}])),
            data(json!([{"LOG_ID":1.5}])),
            data(json!([{"SESSION_ID":1}])),
            NativeJobMetadata::Truncated { value: vec![], limit: 200 },
            NativeJobMetadata::Denied { reason: "denied".into() },
        ] {
            let before = snapshot();
            let mut after = snapshot();
            after.history = history;
            let result = oracle(false, &before, after);
            assert_eq!(result.association, "unavailable");
            assert!(result.candidates.is_empty());
        }
    }

    #[test]
    fn user_only_coverage_does_not_prove_a_different_owners_history() {
        let mut before = snapshot();
        before.sources.get_mut("history").unwrap().coverage = Some(NativeJobCatalogCoverage::CurrentUser);
        let result = compare(NativeJobEngine::Oracle, &target(), "Other", false, &before, &HashSet::new(), snapshot());
        assert_eq!(result.reason, "native_job_observation_coverage_incomplete");
        assert!(result.candidates.is_empty());
    }

    #[test]
    fn generation_change_or_inconsistent_read_never_attaches_a_rebuilt_job() {
        for inconsistent in [false, true] {
            let before = snapshot();
            let mut after = snapshot();
            if inconsistent {
                after.consistent = false;
            } else {
                after.identity = NativeJobMetadata::Empty;
            }
            after.history = data(json!([{"LOG_ID":1,"STATUS":"SUCCEEDED"}]));
            let result = oracle(false, &before, after);
            assert_eq!(result.reason, "native_job_observation_generation_changed");
            assert!(result.candidates.is_empty());
        }
    }

    #[test]
    fn dm_running_compatibility_log_id_is_not_used_to_join_history() {
        let mut before = snapshot();
        before.running = data(json!([{"LOG_ID":1,"SESSION_ID":3}]));
        let mut after = snapshot();
        after.history = data(json!([{"LOG_ID":1,"STATUS":"FAILED","SESSION_ID":3}]));
        let result = compare(NativeJobEngine::Dameng, &target(), "Owner", false, &before, &HashSet::new(), after);
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].evidence, "new-history");
        assert_eq!(result.association, "uncertain");
        assert!(compare(NativeJobEngine::Dameng, &target(), "Owner", true, &before, &HashSet::new(), snapshot())
            .candidates
            .is_empty());
    }

    #[test]
    fn dm_native_execution_ids_are_lossless_and_ob_does_not_borrow_them() {
        let before = snapshot();
        let mut after = snapshot();
        after.history = data(json!([{"EXEC_ID":"9223372036854775807","STATUS":"FAILED"}]));
        let target =
            NativeJobRef::DamengNative { scope: target().scope().clone(), job_id: "42".into(), name: "Job".into() };
        let result = compare(NativeJobEngine::Dameng, &target, "Owner", false, &before, &HashSet::new(), after.clone());
        assert_eq!(result.candidates[0].native_key, "9223372036854775807");
        assert_eq!(
            compare(NativeJobEngine::OceanbaseOracle, &target, "Owner", false, &before, &HashSet::new(), after).reason,
            "native_job_observation_mapping_unverified"
        );
    }

    #[tokio::test]
    async fn narrow_reader_queries_history_even_when_running_is_empty() {
        let mut queries = Vec::new();
        let observed = read(NativeJobEngine::Oracle, &target(), |query| {
            queries.push(query.source);
            let (columns, rows) = if query.source.ends_with("_OBJECTS") {
                (json!(["DBX_JOB_ID", "DBX_CREATED_AT"]), json!([["42", "creation"]]))
            } else if query.source.ends_with("_RUN_DETAILS") {
                (json!(["LOG_ID", "STATUS"]), json!([["99", "FAILED"]]))
            } else {
                (json!(["LOG_ID"]), json!([]))
            };
            std::future::ready(Ok(json!({"columns":columns,"rows":rows,"affected_rows":0,"execution_time_ms":0})))
        })
        .await
        .unwrap();
        assert!(observed.consistent);
        assert_eq!(queries.len(), 4);
        assert!(queries[0].ends_with("_OBJECTS") && queries[3].ends_with("_OBJECTS"));
        assert!(queries[1].ends_with("_RUNNING_JOBS"));
        assert!(queries[2].ends_with("_RUN_DETAILS"));
        assert_eq!(rows(&observed.history).unwrap()[0]["STATUS"], "FAILED");
    }
}
