use dbx_sql_core::value_literals::quote_string_literal;
pub use dbx_types::native_jobs::{NativeJobCatalogCoverage, NativeJobEngine as NativeJobCatalogDialect};
use dbx_types::native_jobs::{NativeJobKind, NativeJobRef};

mod references;
pub use references::native_job_reference_queries;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeJobCatalogPart {
    Definition,
    Generation,
    NativeAttributes,
    Arguments,
    Steps,
    Schedules,
    Running,
    History,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeJobCatalogQuery {
    pub source: &'static str,
    pub coverage: NativeJobCatalogCoverage,
    pub sql: String,
    pub limit: usize,
}

fn scheduler_sources(
    dialect: NativeJobCatalogDialect,
    part: NativeJobCatalogPart,
) -> Vec<(&'static str, NativeJobCatalogCoverage)> {
    use NativeJobCatalogCoverage::{Accessible, CurrentUser, Database};
    use NativeJobCatalogPart::{Arguments, Definition, Generation, History, Running};
    // OB documents these compatibility views as always empty, even for jobs with actual arguments.
    // An empty placeholder is not evidence of an unset argument or permission to overwrite it.
    if dialect == NativeJobCatalogDialect::OceanbaseOracle && part == Arguments {
        return Vec::new();
    }
    let sources = match part {
        Definition => ["SYS.DBA_SCHEDULER_JOBS", "SYS.ALL_SCHEDULER_JOBS", "SYS.USER_SCHEDULER_JOBS"],
        Arguments => ["SYS.DBA_SCHEDULER_JOB_ARGS", "SYS.ALL_SCHEDULER_JOB_ARGS", "SYS.USER_SCHEDULER_JOB_ARGS"],
        Running => {
            ["SYS.DBA_SCHEDULER_RUNNING_JOBS", "SYS.ALL_SCHEDULER_RUNNING_JOBS", "SYS.USER_SCHEDULER_RUNNING_JOBS"]
        }
        History => [
            "SYS.DBA_SCHEDULER_JOB_RUN_DETAILS",
            "SYS.ALL_SCHEDULER_JOB_RUN_DETAILS",
            "SYS.USER_SCHEDULER_JOB_RUN_DETAILS",
        ],
        Generation => ["SYS.DBA_OBJECTS", "SYS.ALL_OBJECTS", "SYS.USER_OBJECTS"],
        _ => return Vec::new(),
    };
    match dialect {
        NativeJobCatalogDialect::Oracle => {
            vec![(sources[0], Database), (sources[1], Accessible), (sources[2], CurrentUser)]
        }
        NativeJobCatalogDialect::OceanbaseOracle => vec![(sources[0], Database), (sources[2], CurrentUser)],
        NativeJobCatalogDialect::Dameng => vec![
            (sources[0].strip_prefix("SYS.").unwrap(), Database),
            (sources[2].strip_prefix("SYS.").unwrap(), CurrentUser),
        ],
    }
}

fn dameng_native_sources() -> Vec<(&'static str, NativeJobCatalogCoverage)> {
    vec![
        ("SYSJOB.SYSJOBS", NativeJobCatalogCoverage::Database),
        ("SYSJOB.USER_JOBS_VIEW", NativeJobCatalogCoverage::CurrentUser),
    ]
}

/// Alternative catalog sources, not a license to reinterpret an empty or failed read.
pub fn native_job_definition_queries(
    dialect: NativeJobCatalogDialect,
    target: &NativeJobRef,
) -> Result<Vec<NativeJobCatalogQuery>, &'static str> {
    native_job_catalog_queries(dialect, target, NativeJobCatalogPart::Definition)
}

pub fn native_job_catalog_queries(
    dialect: NativeJobCatalogDialect,
    target: &NativeJobRef,
    part: NativeJobCatalogPart,
) -> Result<Vec<NativeJobCatalogQuery>, &'static str> {
    target.validate()?;
    let limit = match part {
        NativeJobCatalogPart::Definition
        | NativeJobCatalogPart::Generation
        | NativeJobCatalogPart::NativeAttributes => 1,
        NativeJobCatalogPart::Running => 1_000,
        NativeJobCatalogPart::History => 200,
        _ => 10_000,
    };
    match target {
        NativeJobRef::Scheduler { owner, name, .. }
            if part == NativeJobCatalogPart::Generation && dialect == NativeJobCatalogDialect::OceanbaseOracle =>
        {
            Ok(vec![NativeJobCatalogQuery {
                source: "SYS.ALL_VIRTUAL_TENANT_SCHEDULER_JOB_REAL_AGENT",
                coverage: NativeJobCatalogCoverage::Accessible,
                sql: format!(
                    "SELECT DISTINCT TO_CHAR(JOB) AS DBX_JOB_ID, TO_CHAR(GMT_CREATE, 'YYYY-MM-DD HH24:MI:SS.FF6') AS DBX_CREATED_AT FROM SYS.ALL_VIRTUAL_TENANT_SCHEDULER_JOB_REAL_AGENT WHERE POWNER = {} AND JOB_NAME = {} AND JOB > 0",
                    quote_string_literal(owner), quote_string_literal(name)
                ),
                limit,
            }])
        }
        NativeJobRef::Scheduler { owner, name, .. }
            if part == NativeJobCatalogPart::NativeAttributes && dialect == NativeJobCatalogDialect::OceanbaseOracle =>
        {
            Ok(vec![NativeJobCatalogQuery {
                source: "SYS.ALL_VIRTUAL_TENANT_SCHEDULER_JOB_REAL_AGENT",
                coverage: NativeJobCatalogCoverage::Accessible,
                sql: format!(
                    "SELECT DISTINCT TO_CHAR(JOB) AS DBX_JOB_ID, TO_CHAR(GMT_CREATE, 'YYYY-MM-DD HH24:MI:SS.FF6') AS DBX_CREATED_AT, POWNER AS DBX_OWNER, JOB_NAME, MAX_FAILURES FROM SYS.ALL_VIRTUAL_TENANT_SCHEDULER_JOB_REAL_AGENT WHERE POWNER = {} AND JOB_NAME = {} AND JOB > 0",
                    quote_string_literal(owner), quote_string_literal(name)
                ),
                limit,
            }])
        }
        NativeJobRef::Scheduler { owner, name, .. } => Ok(scheduler_sources(dialect, part)
            .into_iter()
            .map(|(source, coverage)| {
                let current_user = coverage == NativeJobCatalogCoverage::CurrentUser;
                let owner_column = if current_user { "USER" } else { "J.OWNER" };
                let extra = if current_user { ", USER AS DBX_OWNER" } else { "" };
                let (projection, name_column, filter) = if part == NativeJobCatalogPart::Generation {
                    ("TO_CHAR(J.OBJECT_ID) AS DBX_JOB_ID, TO_CHAR(J.CREATED, 'YYYY-MM-DD HH24:MI:SS') AS DBX_CREATED_AT".to_string(), "J.OBJECT_NAME", " AND J.OBJECT_TYPE = 'JOB'")
                } else if part == NativeJobCatalogPart::Arguments && dialect == NativeJobCatalogDialect::Oracle {
                    let evidence = crate::native_job_arguments::anydata_projection(crate::native_job_arguments::AnydataColumn::JobArgument);
                    (format!("J.*, {evidence}"), "J.JOB_NAME", "")
                } else {
                    ("J.*".to_string(), "J.JOB_NAME", "")
                };
                let order = match part {
                    NativeJobCatalogPart::History => " ORDER BY J.LOG_DATE DESC, J.LOG_ID DESC",
                    _ => "",
                };
                let (prefix, join) = if part == NativeJobCatalogPart::Arguments && dialect == NativeJobCatalogDialect::Oracle {
                    (crate::native_job_arguments::anydata_query_prefix(), crate::native_job_arguments::anydata_join(crate::native_job_arguments::AnydataColumn::JobArgument))
                } else { (String::new(), String::new()) };
                NativeJobCatalogQuery {
                    source,
                    coverage,
                    sql: format!(
                        "{prefix}SELECT {projection}{extra} FROM {source} J{join} WHERE {owner_column} = {} AND {name_column} = {}{filter}{order}",
                        quote_string_literal(owner),
                        quote_string_literal(name)
                    ),
                    limit,
                }
            })
            .collect()),
        NativeJobRef::Legacy { job_id, .. } if dialect != NativeJobCatalogDialect::Dameng => {
            let sources = match part {
                NativeJobCatalogPart::Definition | NativeJobCatalogPart::Generation => vec![
                    ("SYS.DBA_JOBS", NativeJobCatalogCoverage::Database),
                    ("SYS.USER_JOBS", NativeJobCatalogCoverage::CurrentUser),
                ],
                NativeJobCatalogPart::Running => vec![("SYS.DBA_JOBS_RUNNING", NativeJobCatalogCoverage::Database)],
                _ => Vec::new(),
            };
            Ok(sources.into_iter().map(|(source, coverage)| {
                let projection = if part == NativeJobCatalogPart::Generation { "TO_CHAR(J.JOB) AS DBX_JOB_ID" } else { "J.*, TO_CHAR(J.JOB) AS DBX_JOB_ID" };
                NativeJobCatalogQuery { source, coverage, sql: format!("SELECT {projection} FROM {source} J WHERE J.JOB = {job_id}"), limit }
            }).collect())
        }
        NativeJobRef::Legacy { job_id, .. } | NativeJobRef::DamengNative { job_id, .. }
            if dialect == NativeJobCatalogDialect::Dameng =>
        {
            let identity_filter = match target {
                NativeJobRef::DamengNative { name, .. } => format!(" AND J.NAME = {}", quote_string_literal(name)),
                _ => " AND J.SYS_FLAG = 2".into(),
            };
            let (sources, projection, predicate, order) = match part {
                NativeJobCatalogPart::Definition => (dameng_native_sources(), "J.*, CAST(J.ID AS VARCHAR(40)) AS DBX_JOB_ID", format!("J.ID = {job_id}{identity_filter}"), ""),
                NativeJobCatalogPart::Generation => (dameng_native_sources(), "CAST(J.ID AS VARCHAR(40)) AS DBX_JOB_ID, J.CREATETIME AS DBX_CREATED_AT", format!("J.ID = {job_id}{identity_filter}"), ""),
                NativeJobCatalogPart::Steps => (vec![("SYSJOB.SYSJOBSTEPS", NativeJobCatalogCoverage::Database), ("SYSJOB.USER_JOBSTEPS_VIEW", NativeJobCatalogCoverage::CurrentUser)], "J.*, CAST(J.ID AS VARCHAR(40)) AS DBX_CHILD_ID", format!("J.JOBID = {job_id}"), " ORDER BY J.SEQNO, J.NAME"),
                NativeJobCatalogPart::Schedules => (vec![("SYSJOB.SYSJOBSCHEDULES", NativeJobCatalogCoverage::Database), ("SYSJOB.USER_JOBSCHEDULES_VIEW", NativeJobCatalogCoverage::CurrentUser)], "J.*, CAST(J.ID AS VARCHAR(40)) AS DBX_CHILD_ID", format!("J.JOBID = {job_id}"), " ORDER BY J.NAME"),
                NativeJobCatalogPart::Running => (vec![("SYSJOB.DBA_JOBS_RUNNING", NativeJobCatalogCoverage::Database)], "J.*", format!("J.JOB = {job_id}"), ""),
                NativeJobCatalogPart::History => (vec![("SYSJOB.SYSJOBHISTORIES2", NativeJobCatalogCoverage::Database), ("SYSJOB.USER_JOBHISTORIES_VIEW", NativeJobCatalogCoverage::CurrentUser)], "J.*", format!("J.JOBID = {job_id}"), " ORDER BY J.EXEC_ID DESC"),
                NativeJobCatalogPart::NativeAttributes if matches!(target, NativeJobRef::Legacy { .. }) => (
                    vec![("SYSJOB.DBA_JOBS", NativeJobCatalogCoverage::Database), ("SYSJOB.USER_JOBS", NativeJobCatalogCoverage::CurrentUser)],
                    "J.*, CAST(J.JOB AS VARCHAR(40)) AS DBX_JOB_ID", format!("J.JOB = {job_id}"), ""
                ),
                NativeJobCatalogPart::Arguments | NativeJobCatalogPart::NativeAttributes => return Ok(Vec::new()),
            };
            Ok(sources.into_iter().map(|(source, coverage)| NativeJobCatalogQuery {
                source, coverage, sql: format!("SELECT {projection} FROM {source} J WHERE {predicate}{order}"), limit
            }).collect())
        }
        _ => Err("native_job_kind_invalid"),
    }
}

/// Lightweight, deterministically ordered pages. Selected definitions are fetched separately.
pub fn native_job_list_queries(
    dialect: NativeJobCatalogDialect,
    kind: NativeJobKind,
    schema: Option<&str>,
    filter: &str,
    offset: usize,
    limit: usize,
) -> Result<Vec<NativeJobCatalogQuery>, &'static str> {
    if limit == 0
        || limit > 500
        || schema.is_some_and(|schema| schema.is_empty() || schema.contains('\0'))
        || filter.contains('\0')
    {
        return Err("native_job_list_input_invalid");
    }
    let end = offset
        .checked_add(limit)
        .and_then(|end| end.checked_add(1))
        .filter(|end| *end <= i32::MAX as usize)
        .ok_or("native_job_list_input_invalid")?;
    let scheduler = kind == NativeJobKind::Scheduler;
    let dm_native = dialect == NativeJobCatalogDialect::Dameng && !scheduler;
    let sources = match kind {
        NativeJobKind::Scheduler => scheduler_sources(dialect, NativeJobCatalogPart::Definition),
        NativeJobKind::Legacy if !dm_native => vec![
            ("SYS.DBA_JOBS", NativeJobCatalogCoverage::Database),
            ("SYS.USER_JOBS", NativeJobCatalogCoverage::CurrentUser),
        ],
        NativeJobKind::Legacy | NativeJobKind::DamengNative if dm_native => dameng_native_sources(),
        _ => return Err("native_job_kind_invalid"),
    };
    let search =
        quote_string_literal(&format!("%{}%", filter.replace('!', "!!").replace('%', "!%").replace('_', "!_")));
    Ok(sources.into_iter().map(|(source, coverage)| {
        let owner = if coverage == NativeJobCatalogCoverage::CurrentUser { "USER" } else { "J.OWNER" };
        let (projection, name, schema_column, order) = if scheduler {
            (format!("J.JOB_NAME, {owner} AS DBX_OWNER, J.JOB_TYPE, J.ENABLED, J.STATE, J.NEXT_RUN_DATE, J.COMMENTS"), "J.JOB_NAME", owner, format!("{owner}, J.JOB_NAME"))
        } else if dm_native {
            ("CAST(J.ID AS VARCHAR(40)) AS DBX_JOB_ID, J.NAME, J.ENABLE, J.USERNAME, J.DESCRIBE, J.SYS_FLAG".into(), "J.NAME", "J.USERNAME", "J.NAME, J.ID".into())
        } else {
            ("TO_CHAR(J.JOB) AS DBX_JOB_ID, J.LOG_USER, J.PRIV_USER, J.SCHEMA_USER, J.BROKEN, J.NEXT_DATE, J.FAILURES".into(), "TO_CHAR(J.JOB)", "J.SCHEMA_USER", "J.JOB".into())
        };
        let mut predicates = Vec::new();
        if let Some(schema) = schema { predicates.push(format!("{schema_column} = {}", quote_string_literal(schema))); }
        if !filter.is_empty() {
            let columns = if dm_native {vec![name, "J.USERNAME", "J.DESCRIBE"]} else {vec![name]};
            let matches = columns.into_iter().map(|column| format!("UPPER({column}) LIKE UPPER({search}) ESCAPE '!'")).collect::<Vec<_>>().join(" OR ");
            predicates.push(if dm_native {format!("({matches})")} else {matches});
        }
        if dm_native && kind == NativeJobKind::Legacy { predicates.push("J.SYS_FLAG = 2".into()); }
        let condition = if predicates.is_empty() { String::new() } else { format!(" WHERE {}", predicates.join(" AND ")) };
        NativeJobCatalogQuery {
            source, coverage, limit,
            sql: format!("SELECT * FROM (SELECT {projection}, ROW_NUMBER() OVER (ORDER BY {order}) AS DBX_ROW_NUM FROM {source} J{condition}) WHERE DBX_ROW_NUM > {offset} AND DBX_ROW_NUM <= {end} ORDER BY DBX_ROW_NUM"),
        }
    }).collect())
}
