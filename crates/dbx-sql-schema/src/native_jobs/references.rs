use super::*;
use dbx_types::native_jobs::{NativeJobReferenceKind, NativeJobReferenceListRequest};

/// Reference browsing uses the same typed source fallback and authenticated scope as Job reads.
pub fn native_job_reference_queries(
    dialect: NativeJobCatalogDialect,
    request: &NativeJobReferenceListRequest,
) -> Result<Vec<NativeJobCatalogQuery>, &'static str> {
    let args = request.kind == NativeJobReferenceKind::ProgramArguments;
    let members = request.kind == NativeJobReferenceKind::DestinationGroupMembers;
    let inventory = args || members;
    if request.limit == 0
        || request.limit > if inventory { 10_000 } else { 500 }
        || request.schema.as_ref().is_some_and(|value| value.is_empty() || value.contains('\0'))
        || request.name.as_ref().is_some_and(|value| value.is_empty() || value.contains('\0'))
        || request.filter.contains('\0')
        || request.name.is_some() && request.schema.is_none()
        || inventory && request.name.is_none()
    {
        return Err("native_job_reference_input_invalid");
    }
    let end = request
        .offset
        .checked_add(request.limit)
        .and_then(|end| end.checked_add(1))
        .filter(|end| *end <= i32::MAX as usize)
        .ok_or("native_job_reference_input_invalid")?;
    let (catalog, name_column) = match request.kind {
        NativeJobReferenceKind::Program => ("SCHEDULER_PROGRAMS", "PROGRAM_NAME"),
        NativeJobReferenceKind::ProgramArguments => ("SCHEDULER_PROGRAM_ARGS", "PROGRAM_NAME"),
        NativeJobReferenceKind::Schedule => ("SCHEDULER_SCHEDULES", "SCHEDULE_NAME"),
        NativeJobReferenceKind::Chain => ("SCHEDULER_CHAINS", "CHAIN_NAME"),
        NativeJobReferenceKind::Credential => ("CREDENTIALS", "CREDENTIAL_NAME"),
        NativeJobReferenceKind::Destination => ("SCHEDULER_DESTS", "DESTINATION_NAME"),
        NativeJobReferenceKind::Window => ("SCHEDULER_WINDOWS", "WINDOW_NAME"),
        NativeJobReferenceKind::WindowGroup | NativeJobReferenceKind::DestinationGroup => {
            ("SCHEDULER_GROUPS", "GROUP_NAME")
        }
        NativeJobReferenceKind::FileWatcher => ("SCHEDULER_FILE_WATCHERS", "FILE_WATCHER_NAME"),
        NativeJobReferenceKind::DestinationGroupMembers => ("SCHEDULER_GROUP_MEMBERS", "GROUP_NAME"),
    };
    if dialect != NativeJobCatalogDialect::Oracle
        && matches!(
            request.kind,
            NativeJobReferenceKind::Window
                | NativeJobReferenceKind::WindowGroup
                | NativeJobReferenceKind::FileWatcher
                | NativeJobReferenceKind::DestinationGroup
                | NativeJobReferenceKind::DestinationGroupMembers
        )
    {
        return Ok(Vec::new());
    }
    // V4.2.5's documented Program argument views are compatibility placeholders (WHERE 1=0).
    if dialect == NativeJobCatalogDialect::OceanbaseOracle && args {
        return Ok(Vec::new());
    }
    // DM documents these job attributes as compatibility-only and does not implement CHAIN.
    if dialect == NativeJobCatalogDialect::Dameng
        && matches!(
            request.kind,
            NativeJobReferenceKind::Chain | NativeJobReferenceKind::Credential | NativeJobReferenceKind::Destination
        )
    {
        return Ok(Vec::new());
    }
    let sources = match (dialect, catalog) {
        (NativeJobCatalogDialect::Oracle, "SCHEDULER_PROGRAMS") => {
            vec!["SYS.DBA_SCHEDULER_PROGRAMS", "SYS.ALL_SCHEDULER_PROGRAMS", "SYS.USER_SCHEDULER_PROGRAMS"]
        }
        (NativeJobCatalogDialect::Oracle, "SCHEDULER_PROGRAM_ARGS") => {
            vec!["SYS.DBA_SCHEDULER_PROGRAM_ARGS", "SYS.ALL_SCHEDULER_PROGRAM_ARGS", "SYS.USER_SCHEDULER_PROGRAM_ARGS"]
        }
        (NativeJobCatalogDialect::Oracle, "SCHEDULER_SCHEDULES") => {
            vec!["SYS.DBA_SCHEDULER_SCHEDULES", "SYS.ALL_SCHEDULER_SCHEDULES", "SYS.USER_SCHEDULER_SCHEDULES"]
        }
        (NativeJobCatalogDialect::Oracle, "SCHEDULER_CHAINS") => {
            vec!["SYS.DBA_SCHEDULER_CHAINS", "SYS.ALL_SCHEDULER_CHAINS", "SYS.USER_SCHEDULER_CHAINS"]
        }
        (NativeJobCatalogDialect::Oracle, "CREDENTIALS") => vec![
            "SYS.DBA_CREDENTIALS",
            "SYS.ALL_CREDENTIALS",
            "SYS.USER_CREDENTIALS",
            "SYS.DBA_SCHEDULER_CREDENTIALS",
            "SYS.ALL_SCHEDULER_CREDENTIALS",
            "SYS.USER_SCHEDULER_CREDENTIALS",
        ],
        (NativeJobCatalogDialect::Oracle, "SCHEDULER_DESTS") => {
            vec!["SYS.DBA_SCHEDULER_DESTS", "SYS.ALL_SCHEDULER_DESTS", "SYS.USER_SCHEDULER_DESTS"]
        }
        (NativeJobCatalogDialect::Oracle, "SCHEDULER_WINDOWS") => {
            // Oracle documents DBA/ALL windows, not a USER_SCHEDULER_WINDOWS view.
            vec!["SYS.DBA_SCHEDULER_WINDOWS", "SYS.ALL_SCHEDULER_WINDOWS"]
        }
        (NativeJobCatalogDialect::Oracle, "SCHEDULER_GROUPS") => {
            vec!["SYS.DBA_SCHEDULER_GROUPS", "SYS.ALL_SCHEDULER_GROUPS", "SYS.USER_SCHEDULER_GROUPS"]
        }
        (NativeJobCatalogDialect::Oracle, "SCHEDULER_FILE_WATCHERS") => {
            vec![
                "SYS.DBA_SCHEDULER_FILE_WATCHERS",
                "SYS.ALL_SCHEDULER_FILE_WATCHERS",
                "SYS.USER_SCHEDULER_FILE_WATCHERS",
            ]
        }
        (NativeJobCatalogDialect::Oracle, "SCHEDULER_GROUP_MEMBERS") => vec![
            "SYS.DBA_SCHEDULER_GROUP_MEMBERS",
            "SYS.ALL_SCHEDULER_GROUP_MEMBERS",
            "SYS.USER_SCHEDULER_GROUP_MEMBERS",
        ],
        (NativeJobCatalogDialect::OceanbaseOracle, "SCHEDULER_PROGRAMS") => {
            vec!["SYS.DBA_SCHEDULER_PROGRAM"]
        }
        (NativeJobCatalogDialect::OceanbaseOracle, "SCHEDULER_SCHEDULES") => {
            vec!["SYS.DBA_SCHEDULER_SCHEDULES", "SYS.USER_SCHEDULER_SCHEDULES"]
        }
        (NativeJobCatalogDialect::OceanbaseOracle, "SCHEDULER_CHAINS") => {
            vec!["SYS.DBA_SCHEDULER_CHAINS", "SYS.USER_SCHEDULER_CHAINS"]
        }
        (NativeJobCatalogDialect::OceanbaseOracle, "CREDENTIALS") => {
            vec!["SYS.DBA_CREDENTIALS", "SYS.USER_CREDENTIALS"]
        }
        (NativeJobCatalogDialect::OceanbaseOracle, "SCHEDULER_DESTS") => {
            vec!["SYS.DBA_SCHEDULER_DESTS", "SYS.USER_SCHEDULER_DESTS"]
        }
        (NativeJobCatalogDialect::Dameng, "SCHEDULER_PROGRAMS") => {
            vec!["DBA_SCHEDULER_PROGRAMS", "USER_SCHEDULER_PROGRAMS"]
        }
        (NativeJobCatalogDialect::Dameng, "SCHEDULER_PROGRAM_ARGS") => {
            vec!["DBA_SCHEDULER_PROGRAM_ARGS", "USER_SCHEDULER_PROGRAM_ARGS"]
        }
        (NativeJobCatalogDialect::Dameng, "SCHEDULER_SCHEDULES") => {
            vec!["DBA_SCHEDULER_SCHEDULES", "USER_SCHEDULER_SCHEDULES"]
        }
        _ => unreachable!("closed reference kind"),
    };
    let search =
        quote_string_literal(&format!("%{}%", request.filter.replace('!', "!!").replace('%', "!%").replace('_', "!_")));
    let queries = sources.into_iter().map(|source| {
        let current = source.starts_with("SYS.USER_") || source.starts_with("USER_");
        let accessible = source.starts_with("SYS.ALL_");
        let owner = if current { "USER" } else { "J.OWNER" };
        let mut conditions = Vec::new();
        match request.kind {
            NativeJobReferenceKind::WindowGroup => conditions.push("J.GROUP_TYPE = 'WINDOW'".into()),
            NativeJobReferenceKind::DestinationGroup => conditions.push("J.GROUP_TYPE IN ('DB_DEST', 'EXTERNAL_DEST')".into()),
            _ => {}
        }
        if let Some(schema) = &request.schema {
            conditions.push(format!("{owner} = {}", quote_string_literal(schema)));
        }
        if let Some(name) = &request.name {
            conditions.push(format!("J.{name_column} = {}", quote_string_literal(name)));
        }
        if !request.filter.is_empty() {
            conditions.push(format!("(UPPER(J.{name_column}) LIKE UPPER({search}) ESCAPE '!' OR UPPER({owner}) LIKE UPPER({search}) ESCAPE '!')"));
        }
        let condition = if conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conditions.join(" AND "))
        };
        let raw = if args && dialect == NativeJobCatalogDialect::Oracle {
            format!("J.*, {}, ", crate::native_job_arguments::anydata_projection(crate::native_job_arguments::AnydataColumn::ProgramDefault))
        } else if request.kind == NativeJobReferenceKind::Credential { String::new() } else if members { "J.MEMBER_NAME, ".into() } else { "J.*, ".into() };
        let order = format!("{owner}, J.{name_column}{}", if args { ", J.ARGUMENT_POSITION" } else if members { ", J.MEMBER_NAME" } else { "" });
        let (prefix, join) = if args && dialect == NativeJobCatalogDialect::Oracle {
            (crate::native_job_arguments::anydata_query_prefix(), crate::native_job_arguments::anydata_join(crate::native_job_arguments::AnydataColumn::ProgramDefault))
        } else { (String::new(), String::new()) };
        let coverage = if current {
            NativeJobCatalogCoverage::CurrentUser
        } else if accessible {
            NativeJobCatalogCoverage::Accessible
        } else {
            NativeJobCatalogCoverage::Database
        };
        NativeJobCatalogQuery {
            source,
            coverage,
            limit: request.limit,
            sql: format!("{prefix}SELECT * FROM (SELECT {raw}{owner} AS DBX_OWNER, J.{name_column} AS DBX_NAME, ROW_NUMBER() OVER (ORDER BY {order}) AS DBX_ROW_NUM FROM {source} J{join}{condition}) WHERE DBX_ROW_NUM > {} AND DBX_ROW_NUM <= {end} ORDER BY DBX_ROW_NUM", request.offset),
        }
    }).collect();
    Ok(queries)
}
