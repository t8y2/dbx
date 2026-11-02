use super::*;
use crate::schema::native_jobs::{details, service};
use dbx_sql::native_job_changes::native_job_dameng_identity_queries;

pub(in crate::schema::native_jobs::operations) struct Binding {
    pub binding: service::BoundContext,
    pub target: NativeJobRef,
    pub identity: NativeJobRow,
    pub old_name: String,
    pub new_name: String,
}

impl Binding {
    pub(in crate::schema::native_jobs::operations) async fn locate_session(
        &self,
        session: &mut impl NativeJobMutationSession,
    ) -> Result<NativeJobRef, &'static str> {
        for query in native_job_dameng_identity_queries(&self.target)? {
            let limit = query.limit;
            match session.query(query).await.and_then(|raw| {
                decode_catalog_rows(NativeJobEngine::Dameng, &self.target, NativeJobCatalogPart::Generation, raw, limit)
            }) {
                Ok(data) => return self.located(data),
                Err(error) if error.permits_fallback() => continue,
                _ => return Err("native_job_rename_identity_unavailable"),
            }
        }
        Err("native_job_rename_identity_unavailable")
    }
    pub(in crate::schema::native_jobs::operations) async fn locate<Q, F>(
        &self,
        mut query: Q,
    ) -> Result<NativeJobRef, &'static str>
    where
        Q: FnMut(NativeJobCatalogQuery) -> F,
        F: Future<Output = Result<Value, NativeJobCatalogFailure>>,
    {
        let section = read_catalog_candidates_with(
            native_job_dameng_identity_queries(&self.target)?,
            |raw, limit| {
                decode_catalog_rows(NativeJobEngine::Dameng, &self.target, NativeJobCatalogPart::Generation, raw, limit)
            },
            &mut query,
        )
        .await?;
        self.located(section.data)
    }

    fn located(&self, data: NativeJobMetadata<Vec<NativeJobRow>>) -> Result<NativeJobRef, &'static str> {
        let NativeJobMetadata::Available { value } = data else {
            return Err("native_job_rename_identity_unavailable");
        };
        let [row] = value.as_slice() else {
            return Err("native_job_rename_identity_unavailable");
        };
        if row.get("DBX_JOB_ID") != self.identity.get("DBX_JOB_ID")
            || row.get("DBX_CREATED_AT") != self.identity.get("DBX_CREATED_AT")
        {
            return Err("native_job_replaced");
        }
        let Some(name) =
            row.get("NAME").and_then(Value::as_str).filter(|name| *name == self.old_name || *name == self.new_name)
        else {
            return Err("native_job_rename_name_changed");
        };
        if matches!(self.target, NativeJobRef::Legacy { .. }) && details::integer(row.get("SYS_FLAG")) != Some(2) {
            return Err("native_job_identity_mismatch");
        }
        Ok(match &self.target {
            NativeJobRef::DamengNative { scope, job_id, .. } => {
                NativeJobRef::DamengNative { scope: scope.clone(), job_id: job_id.clone(), name: name.into() }
            }
            NativeJobRef::Legacy { .. } => self.target.clone(),
            _ => return Err("native_job_kind_invalid"),
        })
    }

    pub(in crate::schema::native_jobs::operations) fn verified(
        &self,
        target: &NativeJobRef,
        details: &NativeJobDetails,
    ) -> Result<NativeJobRow, &'static str> {
        let NativeJobMetadata::Available { value } = &details.native_identity else {
            return Err("native_job_identity_unverified");
        };
        if details.snapshot.job_ref != *target
            || !matches!(details.consistency, NativeJobMetadata::Available { .. })
            || value.get("DBX_JOB_ID") != self.identity.get("DBX_JOB_ID")
            || value.get("DBX_CREATED_AT") != self.identity.get("DBX_CREATED_AT")
        {
            return Err("native_job_replaced");
        }
        let definition = row(details).ok_or("native_job_definition_unavailable")?;
        let name = definition
            .get("NAME")
            .and_then(Value::as_str)
            .filter(|name| *name == self.old_name || *name == self.new_name)
            .ok_or("native_job_rename_name_changed")?;
        if matches!(target, NativeJobRef::DamengNative { name: target_name, .. } if name != target_name) {
            return Err("native_job_identity_mismatch");
        }
        let mut identity = value.clone();
        identity.insert("NAME".into(), Value::String(name.into()));
        Ok(identity)
    }
}

pub(in crate::schema::native_jobs::operations) async fn observe_core(
    state: &AppState,
    tracker: &Binding,
) -> Result<(NativeJobRef, NativeJobRow), &'static str> {
    let binding = &tracker.binding;
    let scope = tracker.target.scope();
    if !state.connection_lifecycle_is_current(&scope.connection_id, &binding.lifecycle) {
        return Err("native_job_context_changed");
    }
    let timeout = crate::schema::agent_metadata_timeout(state.configs.read().await.get(&scope.connection_id));
    let (session, pool) = service::open_pool(state, scope).await?;
    let result = async {
        service::validate_runtime_context(state, binding, &pool).await?;
        let observed = tokio::select! {
            biased;
            _ = binding.lifecycle.cancellation().cancelled() => return Err("native_job_context_changed"),
            observed = async {
                let target = tracker.locate(|query| execute_catalog_query(NativeJobEngine::Dameng, &pool, &scope.database, query, timeout)).await?;
                let details = read_native_job_details_with(NativeJobEngine::Dameng, &target, |query| execute_catalog_query(NativeJobEngine::Dameng, &pool, &scope.database, query, timeout)).await?;
                Ok::<_, &'static str>((target.clone(), tracker.verified(&target, &details)?))
            } => observed?,
        };
        service::validate_runtime_context(state, binding, &pool).await?;
        Ok(observed)
    }.await;
    session.finish(state, &scope.connection_id, (!scope.database.is_empty()).then_some(scope.database.as_str())).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn tracker() -> (tempfile::TempDir, AppState, Binding) {
        let dir = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&dir.path().join("state.db")).await.unwrap();
        let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            dir.path().join("plugins"),
            dir.path().join("agents"),
            "0.0.0",
        );
        state.configs.write().await.insert("c".into(), serde_json::from_value(json!({"id":"c","name":"test","db_type":"dameng","host":"127.0.0.1","port":1,"username":"Owner","password":""})).unwrap());
        let context = crate::schema::native_jobs::native_job_open_context_with(&state, "c", "", |_| {
            std::future::ready(Ok(crate::schema::native_jobs::NativeJobRuntimeIdentity {
                database_info: None,
                session_user: "Owner".into(),
            }))
        })
        .await
        .unwrap();
        let binding = state.native_jobs.context(&state, &context.scope).unwrap();
        let tracker = Binding {
            binding,
            target: NativeJobRef::DamengNative {
                scope: context.scope,
                job_id: "900719925474099312345".into(),
                name: "Old Job".into(),
            },
            identity: serde_json::from_value(json!({"DBX_JOB_ID":"900719925474099312345","DBX_CREATED_AT":"creation"}))
                .unwrap(),
            old_name: "Old Job".into(),
            new_name: "New Job".into(),
        };
        (dir, state, tracker)
    }

    fn rows(name: &str, created: &str, flag: i64) -> Value {
        json!({"columns":["DBX_JOB_ID","DBX_CREATED_AT","NAME","USERNAME","SYS_FLAG"],"rows":[["900719925474099312345",created,name,"Owner",flag]],"affected_rows":0,"execution_time_ms":0})
    }

    #[tokio::test]
    async fn identity_observation_follows_only_the_frozen_generation_and_old_or_new_name() {
        let (_dir, _state, tracker) = tracker().await;
        for name in ["Old Job", "New Job", "Third Job"] {
            let observed = tracker.locate(|_| std::future::ready(Ok(rows(name, "creation", 0)))).await;
            if name == "Third Job" {
                assert_eq!(observed.err(), Some("native_job_rename_name_changed"));
            } else {
                assert!(matches!(observed.unwrap(), NativeJobRef::DamengNative { name: actual, .. } if actual == name));
            }
        }
        assert_eq!(
            tracker.locate(|_| std::future::ready(Ok(rows("New Job", "replacement", 0)))).await.err(),
            Some("native_job_replaced")
        );
    }

    #[tokio::test]
    async fn identity_observation_preserves_legacy_classification_and_requires_full_readback() {
        let (_dir, _state, mut tracker) = tracker().await;
        tracker.target =
            NativeJobRef::Legacy { scope: tracker.target.scope().clone(), job_id: "900719925474099312345".into() };
        assert_eq!(
            tracker.locate(|_| std::future::ready(Ok(rows("New Job", "creation", 0)))).await.err(),
            Some("native_job_identity_mismatch")
        );
        assert!(matches!(
            tracker.locate(|_| std::future::ready(Ok(rows("New Job", "creation", 2)))).await.unwrap(),
            NativeJobRef::Legacy { .. }
        ));
        let mut details: NativeJobDetails = serde_json::from_value(json!({"snapshot":{"ref":tracker.target,"revision":"read","definition":{"status":"available","value":{"NAME":"New Job","ENABLE":1}},"arguments":{"status":"empty"}},"nativeIdentity":{"status":"available","value":tracker.identity},"consistency":{"status":"available","value":null},"parameterMetadata":{"status":"empty"},"steps":{"status":"empty"},"schedules":{"status":"empty"},"running":{"status":"empty"},"history":{"status":"empty"},"sources":{}})).unwrap();
        assert_eq!(tracker.verified(&tracker.target, &details).unwrap()["NAME"], json!("New Job"));
        details.consistency = NativeJobMetadata::Unknown { reason: "changed".into() };
        assert_eq!(tracker.verified(&tracker.target, &details).err(), Some("native_job_replaced"));
    }
}
