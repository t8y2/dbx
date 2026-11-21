use super::*;
use dbx_sql::object_source_sql::{
    analyze_oracle_package_body_draft, comparable_oracle_routine_definition, OracleDraftPackageMemberKind,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackageBodySource {
    Source,
    Target,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackageContractChoice {
    Source,
    Target,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageGrant {
    pub grantor: String,
    pub grantee: String,
    pub privilege: String,
    pub grantable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageGrantSnapshot {
    pub grants: Vec<PackageGrant>,
    pub complete: bool,
    pub issue: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePlanImpact {
    pub companion: RoutineIdentity,
    pub companion_action: Option<RoutinePlanAction>,
    pub implicit_companion_delete: bool,
    pub retains_target_body: bool,
    pub body_pending: bool,
    pub may_initialize: bool,
    pub grants: Option<PackageGrantSnapshot>,
}

#[derive(Clone, Serialize)]
pub(in super::super) struct ExpectedPackagePair {
    pub specification: ExpectedRoutine,
    pub body: ExpectedRoutine,
}

#[derive(Clone, Serialize)]
pub(in super::super) struct PackagePreflight {
    pub pair: ExpectedPackagePair,
    pub grants: Option<PackageGrantSnapshot>,
    pub require_valid_specification: bool,
}

pub(super) struct RoutineBaseline {
    pub selected: ExpectedRoutine,
    pub companion: Option<ExpectedRoutine>,
}

pub(super) fn is_package(kind: &db::ObjectSourceKind) -> bool {
    matches!(kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody)
}

pub(super) fn counterpart(identity: &RoutineIdentity) -> RoutineIdentity {
    RoutineIdentity {
        kind: if identity.kind == db::ObjectSourceKind::Package {
            db::ObjectSourceKind::PackageBody
        } else {
            db::ObjectSourceKind::Package
        },
        ..identity.clone()
    }
}

impl ExpectedPackagePair {
    pub fn from_readback(readback: &RoutineReadback) -> Result<Self, String> {
        let companion =
            readback.package_companion.as_deref().ok_or("The complete recorded package pair is unavailable")?;
        if companion.identity != counterpart(&readback.identity) {
            return Err("The recorded package companion has a different identity".into());
        }
        let selected = observation_baseline(readback)?;
        let companion = observation_baseline(companion)?;
        Ok(if readback.identity.kind == db::ObjectSourceKind::Package {
            Self { specification: selected, body: companion }
        } else {
            Self { specification: companion, body: selected }
        })
    }

    fn get(&self, kind: &db::ObjectSourceKind) -> &ExpectedRoutine {
        if *kind == db::ObjectSourceKind::Package {
            &self.specification
        } else {
            &self.body
        }
    }
    pub fn from_snapshot(snapshot: &RoutineSnapshot, name: &str) -> Result<Self, String> {
        let expected =
            |kind| -> Result<ExpectedRoutine, String> {
                match snapshot_object(snapshot, name, &kind)? {
            Some(object) if object.source_complete && object.source.is_some() && object.source_origin.is_some() => {
                Ok(ExpectedRoutine::Present(object))
            }
            Some(_) => {
                Err("Both package definitions and their actual source origins must be completely read before approval"
                    .into())
            }
            None if snapshot.enumeration_complete => Ok(ExpectedRoutine::Absent(RoutineIdentity {
                owner: snapshot.endpoint.schema.clone(),
                name: name.into(),
                kind,
            })),
            None => Err("Both package kinds require complete namespace visibility before absence can be used".into()),
        }
            };
        Ok(Self {
            specification: expected(db::ObjectSourceKind::Package)?,
            body: expected(db::ObjectSourceKind::PackageBody)?,
        })
    }

    pub fn set(&mut self, expected: ExpectedRoutine) {
        if expected.identity().kind == db::ObjectSourceKind::Package {
            self.specification = expected;
        } else {
            self.body = expected;
        }
    }
}

pub(in super::super) async fn package_save_preflight(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    identity: &RoutineIdentity,
    origin: SourceOrigin,
) -> Result<ComparePreflight, String> {
    let current = readback::readback(catalog, endpoint, identity.clone(), &RoutineReadbackGoal::Inspect, origin).await;
    let pair = ExpectedPackagePair::from_readback(&current)?;
    Ok(ComparePreflight {
        source: None,
        target: pair.get(&identity.kind).clone(),
        proofs: Vec::new(),
        incoming: None,
        selected: vec![identity.clone()],
        package: Some(PackagePreflight { pair, grants: None, require_valid_specification: false }),
    })
}

pub(super) fn definition_identity_matches(expected: &ExpectedRoutine, observed: &RoutineReadback) -> bool {
    if expected.identity() != &observed.identity || !observed.issues.is_empty() {
        return false;
    }
    match expected {
        ExpectedRoutine::Absent(_) => {
            observed.exists == Some(false) && observed.version.is_none() && observed.source.is_none()
        }
        ExpectedRoutine::Present(before) => {
            observed.exists == Some(true)
                && before.source_complete
                && before.source == observed.source
                && before.source_origin == observed.source_origin
                && observed.version.as_ref().is_some_and(|version| {
                    version.identity == before.version.identity && version.object_id == before.version.object_id
                })
        }
    }
}

fn same_namespace(left: &RoutineIdentity, right: &RoutineIdentity) -> bool {
    is_package(&left.kind) && is_package(&right.kind) && left.owner == right.owner && left.name == right.name
}

pub(in super::super) fn effective_preflight(
    binding: &RoutineWriteBinding,
    effects: &[(RoutineWriteBinding, RoutineReadback)],
) -> Result<Option<ComparePreflight>, String> {
    let Some(mut compare) = binding.compare.clone() else {
        return Ok(None);
    };
    if let Some(package) = &mut compare.package {
        for (_, post) in effects.iter().filter(|(effect, _)| {
            same_namespace(&effect.identity, &binding.identity) && effect.identity.kind != binding.identity.kind
        }) {
            let companion = post
                .package_companion
                .as_ref()
                .ok_or("The verified package step has no complete companion post-state")?;
            if !definition_identity_matches(package.pair.get(&binding.identity.kind), companion) {
                return Err("The completed package step cannot explain a changed companion definition, identity or source origin; refresh the remaining draft".into());
            }
            package.pair.set(observation_baseline(post)?);
            package.pair.set(observation_baseline(companion)?);
        }
        compare.target = package.pair.get(&binding.identity.kind).clone();
    }
    Ok(Some(compare))
}

pub(in super::super) fn observed_body_preflight(
    binding: &RoutineWriteBinding,
    effects: &[(RoutineWriteBinding, RoutineReadback)],
) -> Result<Option<ComparePreflight>, String> {
    let Some(mut compare) = binding.compare.clone() else {
        return Ok(None);
    };
    if let Some(package) = &mut compare.package {
        for (_, post) in effects.iter().filter(|(effect, _)| {
            same_namespace(&effect.identity, &binding.identity) && effect.identity.kind == db::ObjectSourceKind::Package
        }) {
            package.pair.specification = observation_baseline(post)?;
        }
    }
    Ok(Some(compare))
}

pub(in super::super) fn effective_prerequisite(
    binding: &RoutineWriteBinding,
    before: &RoutineReadback,
    effects: &[(RoutineWriteBinding, RoutineReadback)],
) -> Result<RoutineReadback, String> {
    let mut expected = before.clone();
    if !is_package(&binding.identity.kind) {
        return Ok(expected);
    }
    for (_, post) in effects.iter().filter(|(effect, _)| {
        same_namespace(&effect.identity, &binding.identity) && effect.identity.kind != binding.identity.kind
    }) {
        let companion =
            post.package_companion.as_ref().ok_or("The related verified package result has no companion")?;
        let previous = observation_baseline(&expected)?;
        if !definition_identity_matches(&previous, companion) {
            return Err("The related package step changed the prerequisite definition, identity or origin; validate the remaining draft".into());
        }
        let mut peer = post.clone();
        peer.package_companion = None;
        let original_state = expected.state.clone();
        let original_match = expected.definition_matches;
        expected = companion.as_ref().clone();
        expected.state = original_state;
        expected.definition_matches = original_match;
        expected.package_companion = Some(Box::new(peer));
    }
    Ok(expected)
}

pub(in super::super) fn same_observation(left: &RoutineReadback, right: &RoutineReadback) -> bool {
    left.identity == right.identity
        && left.exists == right.exists
        && left.version == right.version
        && left.source == right.source
        && left.source_origin == right.source_origin
        && left.compiler_messages == right.compiler_messages
        && left.issues == right.issues
        && match (&left.package_companion, &right.package_companion) {
            (None, None) => true,
            (Some(left), Some(right)) => same_observation(left, right),
            _ => false,
        }
}

pub(in super::super) fn validate_post_state(
    binding: &RoutineWriteBinding,
    compare: Option<&ComparePreflight>,
    current: &mut RoutineReadback,
) {
    if !is_package(&binding.identity.kind) {
        return;
    }
    let check: Result<(), String> = (|| {
        let pair = &compare
            .and_then(|compare| compare.package.as_ref())
            .ok_or("The package write has no frozen pair preflight")?
            .pair;
        let companion =
            current.package_companion.as_ref().ok_or("The package write returned no complete companion observation")?;
        if binding.identity.kind == db::ObjectSourceKind::Package && binding.goal == RoutineReadbackGoal::Absent {
            return Ok(());
        }
        let expected = pair.get(&counterpart(&binding.identity).kind);
        if !definition_identity_matches(expected, companion) {
            return Err(
                "The package write's companion definition, identity or actual origin changed unexpectedly".into()
            );
        }
        if binding.identity.kind == db::ObjectSourceKind::PackageBody {
            if let ExpectedRoutine::Present(before) = expected {
                if companion.version.as_ref() != Some(&before.version) {
                    return Err(
                        "The package body write unexpectedly changed its specification status or DDL version".into()
                    );
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = check {
        current.state = RoutineReadbackState::ReadbackFailed;
        current.issues.push(issue("package-post-state", error));
    }
}

pub(super) fn normalize_input(mut input: OracleRoutinePlanInput) -> Result<OracleRoutinePlanInput, String> {
    for draft in &input.drafts {
        if !matches!(
            draft.identity.kind,
            db::ObjectSourceKind::Procedure
                | db::ObjectSourceKind::Function
                | db::ObjectSourceKind::Package
                | db::ObjectSourceKind::PackageBody
        ) {
            return Err("Program plans require exact supported procedure, function, package or body identities".into());
        }
        if draft.identity.kind != db::ObjectSourceKind::PackageBody
            && (draft.package_body_source.is_some() || draft.package_contract.is_some())
        {
            return Err("Body source and specification choices apply only to PACKAGE_BODY steps".into());
        }
        if !is_package(&draft.identity.kind) && draft.confirm_package_pair {
            return Err("Package pair confirmation cannot change standalone routine semantics".into());
        }
        if draft.identity.kind == db::ObjectSourceKind::Package && draft.action == RoutinePlanAction::Delete {
            for body in input.drafts.iter().filter(|body| body.identity == counterpart(&draft.identity)) {
                if body.action != RoutinePlanAction::Delete {
                    return Err("A whole-package deletion cannot be combined with a body write".into());
                }
                if body.source_name.as_ref().is_some_and(|name| name != &body.identity.name)
                    || body.sql.as_ref().is_some_and(|sql| sql.trim() != drop_sql(&body.identity))
                {
                    return Err("The implicit body deletion must retain its exact identity and DROP statement".into());
                }
                if !input.source.enumeration_complete
                    || snapshot_object(&input.source, &body.identity.name, &body.identity.kind)?.is_some()
                {
                    return Err(
                        "An explicitly selected body deletion requires its confirmed absence in the source".into()
                    );
                }
            }
        }
    }
    let drops = input
        .drafts
        .iter()
        .filter(|draft| {
            draft.identity.kind == db::ObjectSourceKind::Package && draft.action == RoutinePlanAction::Delete
        })
        .map(|draft| counterpart(&draft.identity))
        .collect::<Vec<_>>();
    input.drafts.retain(|draft| !drops.contains(&draft.identity));
    Ok(input)
}

pub(super) async fn verify_pair(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    pair: &ExpectedPackagePair,
    origin: SourceOrigin,
) -> Result<RoutineReadback, String> {
    let current = readback::readback(
        catalog,
        endpoint,
        pair.specification.identity().clone(),
        &RoutineReadbackGoal::Inspect,
        origin,
    )
    .await;
    verify_observation(catalog, &pair.specification, &current).await?;
    let body = current.package_companion.as_ref().ok_or("The package pair observation is incomplete")?;
    verify_observation(catalog, &pair.body, body).await?;
    Ok(current)
}

fn complete_specification(expected: &ExpectedRoutine) -> Result<&RoutineObjectSnapshot, String> {
    match expected {
        ExpectedRoutine::Present(object) if object.source_complete && object.source.is_some() && object.source_origin.is_some() => Ok(object),
        _ => Err("The final package body needs its completely read specification; retain the draft and refresh or select the specification".into()),
    }
}

fn comparable_specification(endpoint: &RoutineEndpoint, object: &RoutineObjectSnapshot) -> Result<String, String> {
    comparable_oracle_routine_definition(OracleRoutineDefinitionInput {
        database_type: endpoint.database_type,
        object_type: db::ObjectSourceKind::Package,
        source_owner: object.version.identity.owner.clone(),
        target_owner: endpoint.schema.clone(),
        name: object.version.identity.name.clone(),
        source: object.source.clone().ok_or("Complete package specification is unavailable")?,
        replace: true,
    })
}

pub(super) async fn prepare_package_drafts(
    target: &impl RoutineCatalog,
    input: &OracleRoutinePlanInput,
    plan: &mut OracleRoutinePlan,
    selected: &mut [SelectedFinalDraft],
    preflights: &mut [Option<ComparePreflight>],
    source_pairs: &[Option<ExpectedPackagePair>],
    origin: SourceOrigin,
) {
    for index in 0..plan.steps.len() {
        if plan.steps[index].identity.kind != db::ObjectSourceKind::PackageBody
            || plan.steps[index].action == RoutinePlanAction::Delete
            || !plan.steps[index].issues.is_empty()
        {
            continue;
        }
        let prepared: Result<(), String> = async {
            let specification_identity = counterpart(&plan.steps[index].identity);
            let selected_specification = plan.steps.iter().position(|step| step.identity == specification_identity);
            let specification = if let Some(specification) = selected_specification {
                if input.drafts[index].package_contract.is_some() { return Err("A BODY-only contract choice cannot override the selected final specification draft".into()); }
                if plan.steps[specification].action == RoutinePlanAction::Delete || !plan.steps[specification].issues.is_empty() { return Err("The selected body requires a valid final specification draft, not a deletion or unreadable draft".into()); }
                plan.steps[specification].sql.clone()
            } else {
                let target_pair = &preflights[index].as_ref().and_then(|preflight| preflight.package.as_ref()).ok_or("The target package pair is unavailable")?.pair;
                let target_specification = complete_specification(&target_pair.specification)?;
                if target_specification.version.status != "VALID" { return Err("BODY-only approval requires a VALID target specification; correct and select that specification first".into()); }
                let current = verify_pair(target, &input.target.endpoint, target_pair, origin).await?;
                if current.state != RoutineReadbackState::Present { return Err("BODY-only approval requires a complete VALID specification without compiler errors".into()); }
                if input.drafts[index].package_contract != Some(PackageContractChoice::Target) {
                    let source_specification = complete_specification(&source_pairs[index].as_ref().ok_or("The source package pair is unavailable")?.specification)?;
                    if comparable_specification(&input.target.endpoint, source_specification)? != comparable_specification(&input.target.endpoint, target_specification)? {
                        return Err("The complete source and target specifications differ; select the specification or explicitly use the target specification as the body contract and validate this draft again".into());
                    }
                }
                adapted(
                    &input.target.endpoint,
                    &specification_identity,
                    &target_specification.version.identity.owner,
                    target_specification.source.as_deref().unwrap(),
                    true,
                )?
            };
            let analysis = analyze_oracle_package_body_draft(
                ddl_input(&input.target.endpoint, &plan.steps[index].identity, plan.steps[index].sql.clone()),
                ddl_input(&input.target.endpoint, &specification_identity, specification),
            );
            plan.steps[index].issues.extend(analysis.issues.clone());
            selected[index].analysis = Some(analysis);
            Ok(())
        }.await;
        if let Err(error) = prepared {
            plan.steps[index].issues.push(problem(error));
        }
    }
    for index in 0..plan.steps.len() {
        if !is_package(&plan.steps[index].identity.kind) || !plan.steps[index].issues.is_empty() {
            continue;
        }
        let prepared: Result<(), String> = async {
            let pair = preflights[index].as_ref().and_then(|preflight| preflight.package.as_ref()).ok_or("The original target pair is unavailable")?.pair.clone();
            let companion = counterpart(&plan.steps[index].identity);
            let companion_index = plan.steps.iter().position(|step| step.identity == companion);
            let mut impact = PackagePlanImpact { companion:companion.clone(), companion_action:companion_index.map(|index| plan.steps[index].action), implicit_companion_delete:false,
                retains_target_body:input.drafts[index].package_body_source == Some(PackageBodySource::Target), body_pending:false,
                may_initialize:selected[index].analysis.as_ref().is_some_and(|analysis| analysis.has_package_initialization)
                    || companion_index.and_then(|index| selected[index].analysis.as_ref()).is_some_and(|analysis| analysis.has_package_initialization), grants:None };
            if plan.steps[index].identity.kind == db::ObjectSourceKind::Package {
                let source_has_body = source_pairs[index].as_ref().is_some_and(|pair| matches!(&pair.body, ExpectedRoutine::Present(_)));
                let needs_body = selected[index].analysis.as_ref().is_some_and(|analysis| analysis.package_members.iter().any(|member| matches!(member.kind, OracleDraftPackageMemberKind::Function | OracleDraftPackageMemberKind::Procedure)));
                impact.body_pending = plan.steps[index].action != RoutinePlanAction::Delete && companion_index.is_none_or(|index| plan.steps[index].action == RoutinePlanAction::Delete) && (source_has_body || needs_body);
                if plan.steps[index].action == RoutinePlanAction::Delete {
                    impact.implicit_companion_delete = matches!(&pair.body, ExpectedRoutine::Present(_));
                    if impact.implicit_companion_delete && !input.drafts[index].confirm_package_pair { plan.steps[index].issues.push(problem("DROP PACKAGE also deletes its existing body; confirm this complete pair impact before approval")); }
                } else if matches!(&pair.body, ExpectedRoutine::Present(_)) {
                    if companion_index.is_none() { plan.steps[index].issues.push(problem("Replacing or creating this specification requires an explicit source body, retained target body rebuild, or body deletion step; its old VALID state does not prove compatibility")); }
                    if !input.drafts[index].confirm_package_pair { plan.steps[index].issues.push(problem("Confirm the specification and existing body impact before approval")); }
                } else if companion_index.is_none() && impact.body_pending && !input.drafts[index].confirm_package_pair {
                    plan.steps[index].issues.push(problem("This is specification-only: the source body or callable implementations are not transferred; confirm that incomplete package scope before approval"));
                }
                if plan.steps[index].action != RoutinePlanAction::Create {
                    let (grants, proofs) = read_grants(target, &plan.steps[index].identity).await;
                    plan.steps[index].recovery_complete &= grants.complete;
                    if !grants.complete && !input.drafts[index].confirm_package_pair { plan.steps[index].issues.push(problem("The original package grants cannot be completely backed up; review and confirm the recovery limitation before approval")); }
                    preflights[index].as_mut().unwrap().proofs.extend(proofs);
                    preflights[index].as_mut().unwrap().package.as_mut().unwrap().grants = Some(grants.clone());
                    impact.grants = Some(grants);
                }
            } else if input.drafts[index].package_body_source == Some(PackageBodySource::Target) && plan.steps[index].action != RoutinePlanAction::Replace {
                return Err("Retaining the target body requires an explicit replace/rebuild of an existing body".into());
            }
            plan.steps[index].package_impact = Some(impact);
            Ok(())
        }.await;
        if let Err(error) = prepared {
            plan.steps[index].issues.push(problem(error));
        }
    }
}

pub(super) async fn read_grants(
    catalog: &impl RoutineCatalog,
    identity: &RoutineIdentity,
) -> (PackageGrantSnapshot, Vec<CatalogReadProof>) {
    let mut snapshot = PackageGrantSnapshot { grants: Vec::new(), complete: false, issue: None };
    let mut proofs = Vec::new();
    let read: Result<(), String> = async {
        let login_sql = "SELECT USER AS LOGIN_OWNER FROM DUAL".to_string();
        let login = catalog.query(&login_sql).await?;
        login.flags.check()?;
        if login.rows.len() != 1 { return Err("Package grant visibility is unknown".into()); }
        let owner_visible = login.text(&login.rows[0], "LOGIN_OWNER")? == identity.owner;
        proofs.push(CatalogReadProof::Query {sql:login_sql,columns:login.columns,rows:login.rows});
        loop {
            let offset = snapshot.grants.len();
            let sql = format!("SELECT * FROM (SELECT GRANTOR, GRANTEE, PRIVILEGE, GRANTABLE, ROW_NUMBER() OVER (ORDER BY GRANTOR, GRANTEE, PRIVILEGE, GRANTABLE) RN FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}) WHERE RN > {offset} AND RN <= {} ORDER BY RN", literal(&identity.owner), literal(&identity.name), offset + PAGE_SIZE);
            let reply = catalog.query(&sql).await?;
            reply.flags.check()?;
            if reply.rows.len() > PAGE_SIZE { return Err("Package grants exceeded the verified page size".into()); }
            for (index, row) in reply.rows.iter().enumerate() {
                if reply.integer(row,"RN")? != (offset+index+1) as u64 { return Err("Package grant pagination is incomplete".into()); }
                let grantable = reply.text(row,"GRANTABLE")?;
                if !matches!(grantable.as_str(),"YES"|"NO") { return Err("Package grant option is unknown".into()); }
                snapshot.grants.push(PackageGrant {grantor:reply.text(row,"GRANTOR")?,grantee:reply.text(row,"GRANTEE")?,privilege:reply.text(row,"PRIVILEGE")?,grantable:grantable=="YES"});
            }
            let finished = reply.rows.len() < PAGE_SIZE;
            proofs.push(CatalogReadProof::Query {sql,columns:reply.columns,rows:reply.rows});
            if finished { break; }
        }
        let unique = snapshot.grants.iter().collect::<BTreeSet<_>>();
        if unique.len() != snapshot.grants.len() { return Err("Package grants contain duplicate identities".into()); }
        if !owner_visible { return Err("Visible grants for another owner are not proof of a complete original grant backup".into()); }
        snapshot.complete = true;
        Ok(())
    }.await;
    if let Err(error) = read {
        snapshot.issue = Some(error);
    }
    (snapshot, proofs)
}

pub(super) fn observation_baseline(readback: &RoutineReadback) -> Result<ExpectedRoutine, String> {
    if !readback.issues.is_empty() {
        return Err("The package pair's recorded post-state is incomplete; observe the original operation again".into());
    }
    match (&readback.version, &readback.source, readback.exists) {
        (None, None, Some(false)) => Ok(ExpectedRoutine::Absent(readback.identity.clone())),
        (Some(version), Some(source), Some(true)) if readback.source_origin.is_some() => {
            Ok(ExpectedRoutine::Present(RoutineObjectSnapshot {
                version: version.clone(),
                source: Some(source.clone()),
                source_origin: readback.source_origin,
                source_complete: true,
                dependencies: Vec::new(),
                dependencies_complete: false,
                issues: Vec::new(),
            }))
        }
        _ => Err("The package pair has no complete exact-kind post-state for correction".into()),
    }
}
