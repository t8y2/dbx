use super::*;
use crate::connection::AppState;
use dbx_sql::native_jobs::native_job_reference_queries;
use dbx_types::native_jobs::{
    NativeJobCatalogSource, NativeJobReferenceCatalog, NativeJobReferenceKind, NativeJobReferenceListRequest,
};

pub(super) async fn read_references_with<Q, F>(
    engine: NativeJobCatalogDialect,
    request: &NativeJobReferenceListRequest,
    session_user: Option<&str>,
    query: &mut Q,
) -> Result<NativeJobReferenceCatalog, &'static str>
where
    Q: FnMut(NativeJobCatalogQuery) -> F,
    F: Future<Output = Result<Value, NativeJobCatalogFailure>>,
{
    let mut queries = native_job_reference_queries(engine, request)?;
    if request.schema.as_deref().zip(session_user).is_some_and(|(owner, user)| owner != user) {
        // A USER view cannot establish another owner's inventory, including a genuinely empty one.
        queries.retain(|query| query.coverage != NativeJobCatalogCoverage::CurrentUser);
    }
    let section = read_catalog_candidates_with(
        queries,
        |raw, limit| {
            let mut rows = rows_from_result(decode_query_result(engine, raw)?, limit, |row| {
                let owner = row.get("DBX_OWNER").and_then(Value::as_str).filter(|value| !value.is_empty());
                let name = row.get("DBX_NAME").and_then(Value::as_str).filter(|value| !value.is_empty());
                if owner.is_none()
                    || name.is_none()
                    || request.schema.as_deref().is_some_and(|expected| Some(expected) != owner)
                    || request.name.as_deref().is_some_and(|expected| Some(expected) != name)
                {
                    return Err(NativeJobCatalogFailure::IdentityMismatch);
                }
                let group_type = row.get("GROUP_TYPE").and_then(Value::as_str);
                if match request.kind {
                    NativeJobReferenceKind::WindowGroup => group_type != Some("WINDOW"),
                    NativeJobReferenceKind::DestinationGroup => {
                        !matches!(group_type, Some("DB_DEST" | "EXTERNAL_DEST"))
                    }
                    _ => false,
                } {
                    return Err(NativeJobCatalogFailure::InvalidResponse);
                }
                Ok(())
            })?;
            if let NativeJobMetadata::Available { value } | NativeJobMetadata::Truncated { value, .. } = &rows {
                let mut seen = HashSet::new();
                for row in value {
                    let discriminator = if request.kind == NativeJobReferenceKind::ProgramArguments {
                        super::details::integer(row.get("ARGUMENT_POSITION"))
                            .filter(|value| *value > 0)
                            .ok_or(NativeJobCatalogFailure::InvalidResponse)?
                            .to_string()
                    } else if request.kind == NativeJobReferenceKind::DestinationGroupMembers {
                        row.get("MEMBER_NAME")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty() && !value.contains('\0'))
                            .ok_or(NativeJobCatalogFailure::InvalidResponse)?
                            .to_string()
                    } else {
                        String::new()
                    };
                    if !seen.insert((
                        row["DBX_OWNER"].as_str().unwrap(),
                        row["DBX_NAME"].as_str().unwrap(),
                        discriminator,
                    )) {
                        return Err(NativeJobCatalogFailure::AmbiguousIdentity);
                    }
                }
            }
            if request.kind == NativeJobReferenceKind::ProgramArguments {
                if let NativeJobMetadata::Available { value } | NativeJobMetadata::Truncated { value, .. } = &mut rows {
                    for row in value {
                        let default = super::details::program_default(engine, Some(row), None);
                        row.insert(
                            "DBX_ARGUMENT_DEFAULT".into(),
                            serde_json::to_value(default).expect("JSON metadata"),
                        );
                    }
                }
            }
            Ok(rows)
        },
        query,
    )
    .await?;
    Ok(NativeJobReferenceCatalog {
        objects: section.data,
        source: NativeJobCatalogSource { source: section.source.map(str::to_string), coverage: section.coverage },
        offset: request.offset,
        limit: request.limit,
    })
}

pub async fn native_job_references_with<Q, F>(
    state: &AppState,
    request: &NativeJobReferenceListRequest,
    mut query: Q,
) -> Result<NativeJobReferenceCatalog, &'static str>
where
    Q: FnMut(NativeJobCatalogQuery) -> F,
    F: Future<Output = Result<Value, NativeJobCatalogFailure>>,
{
    request.scope.validate()?;
    let bound = state.native_jobs.context(state, &request.scope)?;
    let result = tokio::select! {
        biased;
        _=bound.lifecycle.cancellation().cancelled()=>return Err("native_job_context_changed"),
        result=read_references_with(bound.context.engine,request,Some(&bound.context.session_user),&mut query)=>result?,
    };
    state.native_jobs.context(state, &request.scope)?;
    Ok(result)
}

pub async fn native_job_references_core(
    state: &AppState,
    request: &NativeJobReferenceListRequest,
) -> Result<NativeJobReferenceCatalog, String> {
    let scope = &request.scope;
    scope.validate().map_err(str::to_string)?;
    let bound = state.native_jobs.context(state, scope).map_err(str::to_string)?;
    let timeout = super::super::agent_metadata_timeout(state.configs.read().await.get(&scope.connection_id));
    let (session, pool) = super::service::open_pool(state, scope).await.map_err(str::to_string)?;
    let result = async {
        super::service::validate_runtime_context(state, &bound, &pool).await?;
        native_job_references_with(state, request, |query| {
            execute_catalog_query(bound.context.engine, &pool, &scope.database, query, timeout)
        })
        .await
    }
    .await
    .map_err(str::to_string);
    session.finish(state, &scope.connection_id, (!scope.database.is_empty()).then_some(scope.database.as_str())).await;
    result
}
