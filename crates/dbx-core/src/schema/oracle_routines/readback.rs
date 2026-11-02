use super::*;
use dbx_sql::object_source_sql::{comparable_oracle_routine_definition, OracleRoutineDefinitionInput};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineCompilerMessage {
    pub attribute: String,
    pub line: u64,
    pub position: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RoutineReadbackState {
    Verified,
    Invalid,
    Missing,
    Present,
    DefinitionMismatch,
    ReadbackFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RoutineReadbackGoal {
    Definition { sql: String },
    Absent,
    Inspect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutineReadback {
    pub identity: RoutineIdentity,
    pub state: RoutineReadbackState,
    pub exists: Option<bool>,
    pub version: Option<RoutineVersion>,
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_origin: Option<SourceOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_companion: Option<Box<RoutineReadback>>,
    pub definition_matches: Option<bool>,
    pub compiler_messages: Vec<RoutineCompilerMessage>,
    pub issues: Vec<RoutineReadIssue>,
}

/// This reports only current object state. Callers must independently establish
/// the write request's terminal lifecycle before counting a verified deployment.
pub async fn read_oracle_routine_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    identity: RoutineIdentity,
    goal: RoutineReadbackGoal,
) -> Result<RoutineReadback, String> {
    if identity.owner.is_empty()
        || identity.name.is_empty()
        || !matches!(identity.kind, db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function)
    {
        return Err("Routine readback requires an exact standalone routine identity".into());
    }
    let config = connection_config(state, connection_id).await.ok_or("Connection not found")?;
    let (database_type, origin) = routine_source_origin(&config)?;
    let lifecycle = state.connection_lifecycle_snapshot(connection_id);
    let endpoint = RoutineEndpoint {
        connection_id: connection_id.into(),
        database: database.into(),
        schema: identity.owner.clone(),
        database_type,
        generation: lifecycle.generation(),
    };
    let catalog = LiveCatalog { state, endpoint: &endpoint, config: &config };
    let mut readback = readback(&catalog, &endpoint, identity, &goal, origin).await;
    if !state.connection_lifecycle_is_current(connection_id, &lifecycle) {
        readback.state = RoutineReadbackState::ReadbackFailed;
        readback.issues.push(issue("endpoint", "Connection changed during routine readback"));
    }
    Ok(readback)
}

pub(super) async fn read_namespace(
    catalog: &impl RoutineCatalog,
    identity: &RoutineIdentity,
    dba: bool,
) -> Result<CatalogReply, String> {
    let view = if dba { "SYS.DBA_OBJECTS" } else { "ALL_OBJECTS" };
    let body_kind = if matches!(identity.kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody) {
        ",'PACKAGE BODY'"
    } else {
        ""
    };
    let reply = catalog.query(&format!(
        "SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, STATUS, \
         TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD\"T\"HH24:MI:SS') LAST_DDL_TIME \
         FROM {view} WHERE OWNER = {} AND OBJECT_NAME = {} AND OBJECT_TYPE IN \
         ('TABLE','VIEW','SEQUENCE','PROCEDURE','FUNCTION','PACKAGE','MATERIALIZED VIEW','TYPE','SYNONYM'{body_kind}) ORDER BY OBJECT_ID",
        literal(&identity.owner), literal(&identity.name),
    )).await?;
    reply.flags.check()?;
    Ok(reply)
}

pub(super) fn exact_version(reply: &CatalogReply, identity: &RoutineIdentity) -> Result<RoutineVersion, String> {
    namespace_version(reply, identity)?
        .ok_or_else(|| "Routine namespace does not contain the requested object kind".into())
}

fn namespace_version(reply: &CatalogReply, identity: &RoutineIdentity) -> Result<Option<RoutineVersion>, String> {
    let counterpart = match identity.kind {
        db::ObjectSourceKind::Package => Some("PACKAGE BODY"),
        db::ObjectSourceKind::PackageBody => Some("PACKAGE"),
        _ => None,
    };
    let mut matched = None;
    let mut has_counterpart = false;
    for row in &reply.rows {
        if reply.text(row, "OWNER")? != identity.owner || reply.text(row, "OBJECT_NAME")? != identity.name {
            return Err("Routine namespace contains a different owner or name".into());
        }
        let kind = reply.text(row, "OBJECT_TYPE")?;
        if kind == kind_name(&identity.kind) {
            if matched.replace(row).is_some() {
                return Err("Routine namespace contains duplicate exact identities".into());
            }
        } else if counterpart == Some(kind.as_str()) && !has_counterpart {
            has_counterpart = true;
        } else {
            return Err("Routine namespace is ambiguous or has a different object kind".into());
        }
    }
    let Some(row) = matched else { return Ok(None) };
    Ok(Some(RoutineVersion {
        identity: identity.clone(),
        object_id: reply.integer(row, "OBJECT_ID")?.to_string(),
        status: reply.text(row, "STATUS")?,
        last_ddl_time: reply.text(row, "LAST_DDL_TIME")?,
    }))
}

async fn compiler_messages(
    catalog: &impl RoutineCatalog,
    identity: &RoutineIdentity,
    messages: &mut Vec<RoutineCompilerMessage>,
) -> Result<(), String> {
    let mut sequence = None;
    loop {
        // OceanBase's first diagnostic can be SEQUENCE=0. The first page has
        // no lower bound; subsequent pages advance past the last actual row.
        let after = sequence.map(|sequence| format!(" AND SEQUENCE > {sequence}")).unwrap_or_default();
        let reply = catalog
            .query(&format!(
                "SELECT * FROM (SELECT SEQUENCE, ATTRIBUTE, LINE, POSITION, TEXT FROM ALL_ERRORS \
             WHERE {}{after} ORDER BY SEQUENCE) WHERE ROWNUM <= {PAGE_SIZE}",
                identity_filter(identity),
            ))
            .await?;
        if reply.rows.len() > PAGE_SIZE {
            return Err("Routine compiler diagnostics exceeded their page size".into());
        }
        for row in &reply.rows {
            let next = reply.integer(row, "SEQUENCE")?;
            if sequence.is_some_and(|sequence| next <= sequence) {
                return Err("Routine compiler diagnostic pagination is inconsistent".into());
            }
            sequence = Some(next);
            let attribute = reply.text(row, "ATTRIBUTE")?;
            if !matches!(attribute.as_str(), "ERROR" | "WARNING") {
                return Err("Routine compiler diagnostic severity is unknown".into());
            }
            messages.push(RoutineCompilerMessage {
                attribute,
                line: reply.integer(row, "LINE")?,
                position: reply.integer(row, "POSITION")?,
                text: reply.text(row, "TEXT")?,
            });
        }
        reply.flags.check()?;
        if reply.rows.len() < PAGE_SIZE {
            return Ok(());
        }
    }
}

fn comparable(source: String, endpoint: &RoutineEndpoint, identity: &RoutineIdentity) -> Result<String, String> {
    comparable_oracle_routine_definition(OracleRoutineDefinitionInput {
        database_type: endpoint.database_type,
        object_type: identity.kind.clone(),
        source_owner: identity.owner.clone(),
        target_owner: identity.owner.clone(),
        name: identity.name.clone(),
        source,
        replace: true,
    })
}

pub(super) async fn readback(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    identity: RoutineIdentity,
    goal: &RoutineReadbackGoal,
    origin: SourceOrigin,
) -> RoutineReadback {
    let counterpart = match identity.kind {
        db::ObjectSourceKind::Package => Some(db::ObjectSourceKind::PackageBody),
        db::ObjectSourceKind::PackageBody => Some(db::ObjectSourceKind::Package),
        _ => None,
    };
    let mut result = readback_single(catalog, endpoint, identity.clone(), goal, origin).await;
    let Some(kind) = counterpart else {
        return result;
    };
    let companion_goal = if identity.kind == db::ObjectSourceKind::Package && *goal == RoutineReadbackGoal::Absent {
        RoutineReadbackGoal::Absent
    } else {
        RoutineReadbackGoal::Inspect
    };
    let companion =
        readback_single(catalog, endpoint, RoutineIdentity { kind, ..identity.clone() }, &companion_goal, origin).await;
    let check: Result<(), String> = async {
        if !result.issues.is_empty() || !companion.issues.is_empty() {
            return Err(format!(
                "Package pair readback is incomplete: {}",
                result
                    .issues
                    .iter()
                    .chain(&companion.issues)
                    .map(|issue| issue.message.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
        let login = catalog.query("SELECT USER AS LOGIN_OWNER FROM DUAL").await?;
        login.flags.check()?;
        if login.rows.len() != 1 {
            return Err("Package pair namespace visibility is unknown".into());
        }
        let other_owner = login.text(&login.rows[0], "LOGIN_OWNER")? != identity.owner;
        for before in [&result, &companion] {
            match before.exists {
                Some(true) => {
                    let source = catalog.source(&before.identity).await?;
                    source.flags.check()?;
                    if source.object.name != before.identity.name
                        || source.object.schema.as_deref() != Some(&before.identity.owner)
                        || source.object.object_type != before.identity.kind
                        || before.source.as_ref() != Some(&source.object.source)
                        || source.source_origin != before.source_origin
                    {
                        return Err("Package pair definition or actual source origin changed during collection".into());
                    }
                }
                Some(false) => {}
                None => return Err("Package pair existence is not fully observed".into()),
            }
        }
        for before in [&result, &companion] {
            let namespace =
                read_namespace(catalog, &before.identity, other_owner && before.exists == Some(false)).await?;
            let version = namespace_version(&namespace, &before.identity)?;
            if version != before.version || version.is_some() != (before.exists == Some(true)) {
                return Err("Package pair identity, status or namespace changed during collection".into());
            }
        }
        Ok(())
    }
    .await;
    if let Err(error) = check {
        result.state = RoutineReadbackState::ReadbackFailed;
        result.issues.push(issue("package-pair", error));
    } else if (identity.kind == db::ObjectSourceKind::Package
        && *goal == RoutineReadbackGoal::Absent
        && companion.exists != Some(false))
        || (identity.kind == db::ObjectSourceKind::PackageBody
            && matches!(goal, RoutineReadbackGoal::Definition { .. })
            && companion.state != RoutineReadbackState::Present
            && result.state == RoutineReadbackState::Verified)
    {
        result.state = RoutineReadbackState::DefinitionMismatch;
    }
    result.package_companion = Some(Box::new(companion));
    result
}

async fn readback_single(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    identity: RoutineIdentity,
    goal: &RoutineReadbackGoal,
    origin: SourceOrigin,
) -> RoutineReadback {
    let mut result = RoutineReadback {
        identity,
        state: RoutineReadbackState::ReadbackFailed,
        exists: None,
        version: None,
        source: None,
        source_origin: None,
        package_companion: None,
        definition_matches: None,
        compiler_messages: Vec::new(),
        issues: Vec::new(),
    };
    let read: Result<(), String> = async {
        let login = catalog.query("SELECT USER AS LOGIN_OWNER FROM DUAL").await?;
        login.flags.check()?;
        if login.rows.len() != 1 {
            return Err("Routine namespace visibility is unknown".into());
        }
        let other_owner = login.text(&login.rows[0], "LOGIN_OWNER")? != result.identity.owner;
        let mut dba = false;
        let mut namespace = read_namespace(catalog, &result.identity, false).await?;
        let mut version = namespace_version(&namespace, &result.identity)?;
        // A positive exact ALL_OBJECTS identity is useful evidence for ordinary
        // saves to another owner. Only inferring absence requires full scope.
        if version.is_none() && other_owner {
            dba = true;
            namespace = read_namespace(catalog, &result.identity, true).await?;
            version = namespace_version(&namespace, &result.identity)?;
        }
        result.exists = Some(version.is_some());
        let Some(version) = version else {
            result.state = if *goal == RoutineReadbackGoal::Absent {
                RoutineReadbackState::Verified
            } else {
                RoutineReadbackState::Missing
            };
            return Ok(());
        };
        result.version = Some(version.clone());
        let source = catalog.source(&result.identity).await?;
        result.source = Some(source.object.source.clone());
        result.source_origin = source.source_origin;
        check_source(catalog, endpoint, &result.identity, &source, origin).await?;
        compiler_messages(catalog, &result.identity, &mut result.compiler_messages).await?;
        let second = catalog.source(&result.identity).await?;
        second.flags.check()?;
        if second.object.name != source.object.name
            || second.object.schema != source.object.schema
            || second.object.object_type != source.object.object_type
            || second.source_origin != source.source_origin
            || second.object.source != source.object.source
        {
            return Err("Routine definition changed during readback".into());
        }
        let after = read_namespace(catalog, &result.identity, dba).await?;
        if exact_version(&after, &result.identity)? != version {
            return Err("Routine identity, status or DDL version changed during readback".into());
        }
        if let RoutineReadbackGoal::Definition { sql } = goal {
            result.definition_matches = Some(
                comparable(sql.clone(), endpoint, &result.identity)?
                    == comparable(source.object.source.clone(), endpoint, &result.identity)?,
            );
        }
        result.state = if version.status != "VALID"
            || result.compiler_messages.iter().any(|message| message.attribute == "ERROR")
        {
            RoutineReadbackState::Invalid
        } else if result.definition_matches == Some(false) || *goal == RoutineReadbackGoal::Absent {
            RoutineReadbackState::DefinitionMismatch
        } else if result.definition_matches == Some(true) {
            RoutineReadbackState::Verified
        } else {
            RoutineReadbackState::Present
        };
        Ok(())
    }
    .await;
    if let Err(error) = read {
        result.state = RoutineReadbackState::ReadbackFailed;
        result.issues.push(issue("readback", error));
    }
    result
}

#[cfg(test)]
mod package_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Catalog {
        login: &'static str,
        status: &'static str,
        messages: Vec<Vec<Value>>,
        exists: bool,
        fail: &'static str,
        wrong_kind: bool,
        source: String,
        incomplete_errors: bool,
        source_changes: bool,
        source_reads: AtomicUsize,
        namespace_rows: Option<Vec<Vec<Value>>>,
    }

    impl Default for Catalog {
        fn default() -> Self {
            Self {
                login: "OWNER",
                status: "VALID",
                messages: Vec::new(),
                exists: true,
                fail: "",
                wrong_kind: false,
                source: "CREATE OR REPLACE FUNCTION \"Read.Func\" RETURN NUMBER AS BEGIN RETURN 1; END".into(),
                incomplete_errors: false,
                source_changes: false,
                source_reads: AtomicUsize::new(0),
                namespace_rows: None,
            }
        }
    }

    fn reply(columns: &[&str], rows: Vec<Vec<Value>>) -> CatalogReply {
        serde_json::from_value(json!({"columns":columns,"rows":rows})).unwrap()
    }

    #[test]
    fn package_namespace_resolves_each_kind_without_treating_its_pair_as_a_conflict() {
        let mut reply = reply(
            &["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "STATUS", "LAST_DDL_TIME"],
            vec![
                vec![
                    json!("OWNER"),
                    json!("Pkg.With.Dot"),
                    json!("PACKAGE"),
                    json!(12),
                    json!("VALID"),
                    json!("2026-10-23T01:00:00"),
                ],
                vec![
                    json!("OWNER"),
                    json!("Pkg.With.Dot"),
                    json!("PACKAGE BODY"),
                    json!(13),
                    json!("VALID"),
                    json!("2026-10-23T01:00:00"),
                ],
            ],
        );
        let specification =
            RoutineIdentity { owner: "OWNER".into(), name: "Pkg.With.Dot".into(), kind: db::ObjectSourceKind::Package };
        let body = RoutineIdentity { kind: db::ObjectSourceKind::PackageBody, ..specification.clone() };
        assert!(exact_version(&reply, &specification).is_ok(), "the specification must be resolved by exact kind");
        assert!(exact_version(&reply, &body).is_ok(), "the body must be resolved by exact kind");
        assert_eq!(exact_version(&reply, &specification).unwrap().object_id, "12");
        assert_eq!(exact_version(&reply, &body).unwrap().object_id, "13");
        let standalone = RoutineIdentity { kind: db::ObjectSourceKind::Function, ..specification.clone() };
        assert!(exact_version(&reply, &standalone).is_err());
        reply.rows[0][0] = json!("ANOTHER_OWNER");
        assert!(exact_version(&reply, &body).is_err());
        reply.rows[0][0] = json!("OWNER");
        reply.rows.push(reply.rows[1].clone());
        assert!(exact_version(&reply, &body).is_err());
        reply.rows.remove(2);
        reply.rows.remove(0);
        assert_eq!(exact_version(&reply, &body).unwrap().object_id, "13");
        assert!(exact_version(&reply, &specification).is_err());
    }

    #[async_trait::async_trait]
    impl RoutineCatalog for Catalog {
        async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
            if !self.fail.is_empty() && sql.contains(self.fail) {
                return Err("ORA-01031: insufficient privileges".into());
            }
            if sql.contains("LOGIN_OWNER") {
                return Ok(reply(&["LOGIN_OWNER"], vec![vec![json!(self.login)]]));
            }
            if sql.contains("ALL_ERRORS") {
                let after = sql
                    .split_once("SEQUENCE > ")
                    .map(|(_, rest)| rest.split_whitespace().next().unwrap().parse::<u64>().unwrap());
                let rows = self
                    .messages
                    .iter()
                    .filter(|row| after.is_none_or(|sequence| row[0].as_u64().unwrap() > sequence))
                    .take(PAGE_SIZE)
                    .cloned()
                    .collect();
                let mut reply = reply(&["SEQUENCE", "ATTRIBUTE", "LINE", "POSITION", "TEXT"], rows);
                reply.flags.truncated = self.incomplete_errors;
                return Ok(reply);
            }
            if sql.contains("SOURCE_ROWS") {
                let body = self.source.strip_prefix("CREATE OR REPLACE ").unwrap();
                return Ok(reply(
                    &[
                        "SOURCE_ROWS",
                        "FIRST_LINE",
                        "LAST_LINE",
                        "SOURCE_CHARS",
                        "HEAD_TRIM",
                        "TAIL_TRIM",
                        "SOURCE_HEAD",
                    ],
                    vec![vec![
                        json!(1),
                        json!(1),
                        json!(1),
                        json!(body.chars().count()),
                        json!(0),
                        json!(0),
                        json!("FUNCTION"),
                    ]],
                ));
            }
            Ok(reply(
                &["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "STATUS", "LAST_DDL_TIME"],
                if let Some(rows) = &self.namespace_rows {
                    rows.clone()
                } else if self.exists {
                    vec![vec![
                        json!("OWNER"),
                        json!("Read.Func"),
                        json!(if self.wrong_kind { "PACKAGE" } else { "FUNCTION" }),
                        json!(12),
                        json!(self.status),
                        json!("2026-10-21T08:30:00"),
                    ]]
                } else {
                    vec![]
                },
            ))
        }
        async fn source(&self, identity: &RoutineIdentity) -> Result<SourceReply, String> {
            let calls = self.source_reads.fetch_add(1, Ordering::SeqCst);
            let text = if self.source_changes && calls > 0 {
                self.source.replace("RETURN 1", "RETURN 3")
            } else {
                self.source.clone()
            };
            Ok(serde_json::from_value(
                json!({"name":identity.name,"schema":identity.owner,"object_type":identity.kind,"source":text,"source_origin":matches!(identity.kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody).then_some("oceanbase-dictionary")}),
            )
            .unwrap())
        }
    }

    async fn run(catalog: &Catalog, goal: RoutineReadbackGoal) -> RoutineReadback {
        let endpoint = RoutineEndpoint {
            connection_id: "target".into(),
            database: "tenant".into(),
            schema: "OWNER".into(),
            database_type: DatabaseType::OceanbaseOracle,
            generation: 1,
        };
        readback(
            catalog,
            &endpoint,
            RoutineIdentity { owner: "OWNER".into(), name: "Read.Func".into(), kind: db::ObjectSourceKind::Function },
            &goal,
            SourceOrigin::OceanBaseDictionary,
        )
        .await
    }

    fn expected() -> RoutineReadbackGoal {
        RoutineReadbackGoal::Definition {
            sql: "CREATE OR REPLACE FUNCTION \"OWNER\".\"Read.Func\" RETURN NUMBER AS BEGIN RETURN 1; END;".into(),
        }
    }

    #[tokio::test]
    async fn valid_complete_definition_is_verified_and_warning_remains_visible() {
        let catalog = Catalog {
            messages: vec![vec![json!(1), json!("WARNING"), json!(1), json!(12), json!("compiler warning")]],
            ..Default::default()
        };
        let result = run(&catalog, expected()).await;
        assert_eq!(result.state, RoutineReadbackState::Verified);
        assert_eq!(result.definition_matches, Some(true));
        assert_eq!(result.compiler_messages[0].attribute, "WARNING");
    }

    #[tokio::test]
    async fn invalid_or_error_is_not_a_successful_definition_readback() {
        let invalid = Catalog { status: "INVALID", ..Default::default() };
        assert_eq!(run(&invalid, expected()).await.state, RoutineReadbackState::Invalid);
        let error = Catalog {
            messages: vec![vec![json!(1), json!("ERROR"), json!(1), json!(72), json!("missing identifier")]],
            ..Default::default()
        };
        let result = run(&error, expected()).await;
        assert_eq!(result.state, RoutineReadbackState::Invalid);
        assert_eq!(result.compiler_messages[0].position, 72);
    }

    #[tokio::test]
    async fn zero_based_first_error_or_warning_is_not_dropped() {
        for (attribute, expected_state) in
            [("ERROR", RoutineReadbackState::Invalid), ("WARNING", RoutineReadbackState::Verified)]
        {
            let catalog = Catalog {
                messages: vec![vec![json!(0), json!(attribute), json!(1), json!(63), json!("first diagnostic")]],
                ..Default::default()
            };
            let result = run(&catalog, expected()).await;
            assert_eq!(result.state, expected_state);
            assert_eq!(result.compiler_messages.len(), 1);
            assert_eq!(result.compiler_messages[0].attribute, attribute);
            assert_eq!(result.compiler_messages[0].position, 63);
        }
    }

    #[tokio::test]
    async fn zero_based_diagnostics_continue_after_a_full_first_page_without_loss_or_duplicates() {
        let catalog = Catalog {
            messages: (0..300)
                .map(|sequence| {
                    vec![json!(sequence), json!("WARNING"), json!(1), json!(sequence + 1), json!("warning")]
                })
                .collect(),
            ..Default::default()
        };
        let result = run(&catalog, expected()).await;
        assert_eq!(result.state, RoutineReadbackState::Verified);
        assert_eq!(result.compiler_messages.len(), 300);
        assert_eq!(result.compiler_messages[0].position, 1);
        assert_eq!(result.compiler_messages[299].position, 300);
    }

    #[tokio::test]
    async fn compiler_read_failure_retains_source_without_reporting_verified() {
        let catalog = Catalog { fail: "ALL_ERRORS", ..Default::default() };
        let result = run(&catalog, expected()).await;
        assert_eq!(result.state, RoutineReadbackState::ReadbackFailed);
        assert_eq!(result.source.as_deref(), Some(catalog.source.as_str()));
        assert_eq!(result.issues[0].code, "permission-denied");
    }

    #[tokio::test]
    async fn absence_is_verified_only_after_a_complete_namespace_read() {
        let catalog = Catalog { exists: false, ..Default::default() };
        assert_eq!(run(&catalog, RoutineReadbackGoal::Absent).await.state, RoutineReadbackState::Verified);
        assert_eq!(run(&catalog, expected()).await.state, RoutineReadbackState::Missing);
        let denied = Catalog { exists: false, fail: "ALL_OBJECTS", ..Default::default() };
        assert_eq!(run(&denied, RoutineReadbackGoal::Absent).await.state, RoutineReadbackState::ReadbackFailed);
    }

    #[tokio::test]
    async fn body_absence_is_kind_specific_and_requires_full_owner_visibility() {
        let rows = vec![vec![
            json!("OWNER"),
            json!("Read.Func"),
            json!("PACKAGE"),
            json!(12),
            json!("VALID"),
            json!("2026-10-23T01:00:00"),
        ]];
        let endpoint = RoutineEndpoint {
            connection_id: "target".into(),
            database: "tenant".into(),
            schema: "OWNER".into(),
            database_type: DatabaseType::OceanbaseOracle,
            generation: 1,
        };
        let identity = RoutineIdentity {
            owner: "OWNER".into(),
            name: "Read.Func".into(),
            kind: db::ObjectSourceKind::PackageBody,
        };
        let specification = "CREATE OR REPLACE PACKAGE \"Read.Func\" AS g NUMBER; END \"Read.Func\";";
        let catalog =
            Catalog { source: specification.into(), namespace_rows: Some(rows.clone()), ..Default::default() };
        let result = readback(
            &catalog,
            &endpoint,
            identity.clone(),
            &RoutineReadbackGoal::Absent,
            SourceOrigin::OceanBaseDictionary,
        )
        .await;
        assert_eq!(result.state, RoutineReadbackState::Verified);
        assert_eq!(result.exists, Some(false));
        assert_eq!(catalog.source_reads.load(Ordering::SeqCst), 3);
        assert_eq!(result.package_companion.as_ref().unwrap().source.as_deref(), Some(specification));
        let catalog = Catalog {
            source: specification.into(),
            login: "OTHER_LOGIN",
            fail: "SYS.DBA_OBJECTS",
            namespace_rows: Some(rows),
            ..Default::default()
        };
        let result =
            readback(&catalog, &endpoint, identity, &RoutineReadbackGoal::Absent, SourceOrigin::OceanBaseDictionary)
                .await;
        assert_eq!(result.state, RoutineReadbackState::ReadbackFailed);
        assert_eq!(result.exists, None);
    }

    #[tokio::test]
    async fn definition_mismatch_and_shared_namespace_collision_are_not_success() {
        let catalog =
            Catalog { source: Catalog::default().source.replace("RETURN 1", "RETURN 2"), ..Default::default() };
        assert_eq!(run(&catalog, expected()).await.state, RoutineReadbackState::DefinitionMismatch);
        let catalog = Catalog { wrong_kind: true, ..Default::default() };
        assert_eq!(run(&catalog, expected()).await.state, RoutineReadbackState::ReadbackFailed);
    }

    #[tokio::test]
    async fn incomplete_diagnostics_or_a_changed_readback_never_count_as_verified() {
        let catalog = Catalog { incomplete_errors: true, ..Default::default() };
        assert_eq!(run(&catalog, expected()).await.state, RoutineReadbackState::ReadbackFailed);
        let catalog = Catalog { source_changes: true, ..Default::default() };
        let result = run(&catalog, expected()).await;
        assert_eq!(result.state, RoutineReadbackState::ReadbackFailed);
        assert_eq!(result.source.as_deref(), Some(catalog.source.as_str()));
    }

    #[tokio::test]
    async fn positive_other_owner_readback_does_not_add_a_global_dictionary_permission() {
        let catalog = Catalog { login: "OTHER_LOGIN", fail: "SYS.DBA_OBJECTS", ..Default::default() };
        assert_eq!(run(&catalog, expected()).await.state, RoutineReadbackState::Verified);
        let catalog = Catalog { login: "OTHER_LOGIN", exists: false, fail: "SYS.DBA_OBJECTS", ..Default::default() };
        let result = run(&catalog, RoutineReadbackGoal::Absent).await;
        assert_eq!(result.state, RoutineReadbackState::ReadbackFailed);
        assert_eq!(result.exists, None);
    }
}
