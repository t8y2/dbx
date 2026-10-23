//! Target-side binding for the closed static draft grammar. Every successful
//! catalog read is retained for the dispatch-time check; an empty visible subset
//! is never used as proof that a higher-priority name does not exist.
use super::*;
use dbx_sql::object_source_sql::{
    OracleDraftIssue, OracleDraftReference, OracleDraftReferenceRole, OracleRoutineDraftAnalysis,
};
use std::collections::BTreeSet;

#[derive(Clone, Serialize)]
pub(super) struct CatalogReadProof {
    pub sql: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

impl CatalogReadProof {
    pub async fn verify(&self, catalog: &impl RoutineCatalog) -> Result<(), String> {
        let current = catalog.query(&self.sql).await?;
        current.flags.check()?;
        if current.columns != self.columns || current.rows != self.rows {
            return Err("Referenced object, name resolution, signature, columns or direct privileges changed; validate the draft again".into());
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(super) struct SelectedFinalDraft {
    pub identity: RoutineIdentity,
    // None denotes an explicitly selected deletion, not an unreadable signature.
    pub analysis: Option<OracleRoutineDraftAnalysis>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRoutineReference {
    pub owner: String,
    pub name: String,
    pub kind: String,
    pub member: Option<String>,
    pub selected_index: Option<usize>,
    pub line: u64,
    pub column: u64,
}

pub(super) struct DraftResolution {
    pub references: Vec<ResolvedRoutineReference>,
    pub selected_dependencies: BTreeSet<usize>,
    pub proofs: Vec<CatalogReadProof>,
    pub issues: Vec<OracleDraftIssue>,
}

#[derive(Clone)]
struct Object {
    owner: String,
    name: String,
    kind: String,
    object_id: String,
    status: String,
    selected: Option<usize>,
}

struct Resolver<'a, C> {
    catalog: &'a C,
    endpoint: &'a RoutineEndpoint,
    login: String,
    selected: &'a [SelectedFinalDraft],
    output: DraftResolution,
}

impl<C: RoutineCatalog> Resolver<'_, C> {
    async fn query(&mut self, sql: String) -> Result<CatalogReply, String> {
        let reply = self.catalog.query(&sql).await?;
        reply.flags.check()?;
        if reply.rows.len() > PAGE_SIZE {
            return Err("Dependency metadata exceeded its verified page size".into());
        }
        self.output.proofs.push(CatalogReadProof { sql, columns: reply.columns.clone(), rows: reply.rows.clone() });
        Ok(reply)
    }

    async fn rows(&mut self, projection: &str, from: &str, order: &str) -> Result<CatalogReply, String> {
        let mut columns = None;
        let mut rows = Vec::new();
        loop {
            let offset = rows.len();
            let reply = self
                .query(format!(
                    "SELECT * FROM (SELECT {projection}, ROW_NUMBER() OVER (ORDER BY {order}) RN FROM {from}) \
                 WHERE RN > {offset} AND RN <= {} ORDER BY RN",
                    offset + PAGE_SIZE,
                ))
                .await?;
            if columns.as_ref().is_some_and(|known| known != &reply.columns) {
                return Err("Dependency metadata columns changed between pages".into());
            }
            for (index, row) in reply.rows.iter().enumerate() {
                if reply.integer(row, "RN")? != (offset + index + 1) as u64 {
                    return Err("Dependency metadata pagination is incomplete".into());
                }
            }
            let finished = reply.rows.len() < PAGE_SIZE;
            columns = Some(reply.columns);
            rows.extend(reply.rows);
            if finished {
                return Ok(CatalogReply { columns: columns.unwrap(), rows, flags: ReadFlags::default() });
            }
        }
    }

    async fn namespace(&mut self, owner: &str, name: &str) -> Result<Option<Object>, String> {
        if let Some((index, selected)) = self
            .selected
            .iter()
            .enumerate()
            .find(|(_, draft)| draft.identity.owner == owner && draft.identity.name == name)
        {
            if selected.analysis.is_none() {
                return Err(format!("Reference {owner}.{name} is selected for deletion"));
            }
            return Ok(Some(Object {
                owner: owner.into(),
                name: name.into(),
                kind: kind_name(&selected.identity.kind).into(),
                object_id: String::new(),
                status: "VALID".into(),
                selected: Some(index),
            }));
        }
        let make_sql = |view: &str| {
            format!(
            "SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, STATUS, \
             TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD\"T\"HH24:MI:SS') LAST_DDL_TIME FROM {view} \
             WHERE OWNER = {} AND OBJECT_NAME = {} AND OBJECT_TYPE IN \
             ('TABLE','VIEW','SEQUENCE','PROCEDURE','FUNCTION','PACKAGE','MATERIALIZED VIEW','TYPE','SYNONYM') ORDER BY OBJECT_ID",
            literal(owner), literal(name),
        )
        };
        let mut reply = self.query(make_sql("ALL_OBJECTS")).await?;
        if reply.rows.is_empty() && owner != self.login && owner != "PUBLIC" {
            // A positive ALL_OBJECTS match is sufficient. Absence in another
            // owner's namespace needs complete visibility, not an ALL_* fallback.
            reply = self.query(make_sql("SYS.DBA_OBJECTS")).await?;
        }
        if reply.rows.is_empty() {
            return Ok(None);
        }
        if reply.rows.len() != 1 {
            return Err(format!("Namespace {owner}.{name} is ambiguous"));
        }
        let row = &reply.rows[0];
        if reply.text(row, "OWNER")? != owner || reply.text(row, "OBJECT_NAME")? != name {
            return Err("Dependency metadata returned another identity".into());
        }
        Ok(Some(Object {
            owner: owner.into(),
            name: name.into(),
            kind: reply.text(row, "OBJECT_TYPE")?,
            object_id: reply.integer(row, "OBJECT_ID")?.to_string(),
            status: reply.text(row, "STATUS")?,
            selected: None,
        }))
    }

    async fn object(&mut self, owner: &str, name: &str, public_fallback: bool) -> Result<Option<Object>, String> {
        let mut object = self.namespace(owner, name).await?;
        if object.is_none() && public_fallback {
            object = self.namespace("PUBLIC", name).await?;
        }
        let mut visited = BTreeSet::new();
        for _ in 0..16 {
            let Some(current) = object else {
                return Ok(None);
            };
            if current.kind != "SYNONYM" {
                return Ok(Some(current));
            }
            if !visited.insert((current.owner.clone(), current.name.clone())) {
                return Err("Synonym cycle prevents complete dependency resolution".into());
            }
            let reply = self
                .query(format!(
                    "SELECT OWNER, SYNONYM_NAME, TABLE_OWNER, TABLE_NAME, DB_LINK FROM ALL_SYNONYMS \
                 WHERE OWNER = {} AND SYNONYM_NAME = {} ORDER BY OWNER, SYNONYM_NAME",
                    literal(&current.owner),
                    literal(&current.name),
                ))
                .await?;
            if reply.rows.len() != 1 {
                return Err("Synonym target is unavailable or ambiguous".into());
            }
            let row = &reply.rows[0];
            if !matches!(reply.cell(row, "DB_LINK")?, Value::Null) && reply.cell(row, "DB_LINK")? != "" {
                return Err("A database-link dependency must be removed from this static deployment plan".into());
            }
            object = self.namespace(&reply.text(row, "TABLE_OWNER")?, &reply.text(row, "TABLE_NAME")?).await?;
        }
        Err("Synonym resolution exceeded its verified depth".into())
    }

    async fn accessible(&mut self, object: &Object, relation: bool) -> Result<(), String> {
        if object.status != "VALID" {
            return Err(format!("Dependency {}.{} is not VALID", object.owner, object.name));
        }
        if object.owner == self.endpoint.schema {
            return Ok(());
        }
        let privileges = if relation { "'SELECT','READ'" } else { "'EXECUTE'" };
        let grants = self.rows("GRANTEE, PRIVILEGE", &format!(
            "SYS.ALL_TAB_PRIVS WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND GRANTEE IN ({}, 'PUBLIC') AND PRIVILEGE IN ({privileges})",
            literal(&object.owner), literal(&object.name), literal(&self.endpoint.schema),
        ), "GRANTEE, PRIVILEGE").await?;
        if !grants.rows.is_empty() {
            return Ok(());
        }
        // Stored AUTHID DEFINER code cannot borrow enabled roles. Query only
        // direct system grants to the defining owner, never SESSION_PRIVS.
        if object.owner != "SYS" {
            let privilege = if relation { "'SELECT ANY TABLE','READ ANY TABLE'" } else { "'EXECUTE ANY PROCEDURE'" };
            let from = if self.login == self.endpoint.schema {
                format!("USER_SYS_PRIVS WHERE PRIVILEGE IN ({privilege})")
            } else {
                format!(
                    "SYS.DBA_SYS_PRIVS WHERE GRANTEE = {} AND PRIVILEGE IN ({privilege})",
                    literal(&self.endpoint.schema)
                )
            };
            if !self.rows("PRIVILEGE", &from, "PRIVILEGE").await?.rows.is_empty() {
                return Ok(());
            }
        }
        Err(format!("Direct or PUBLIC privilege for {}.{} is not proven for {}; grant the required privilege and validate again", object.owner, object.name, self.endpoint.schema))
    }

    async fn columns(&mut self, object: &Object) -> Result<BTreeSet<String>, String> {
        self.accessible(object, true).await?;
        let reply = self
            .rows(
                "COLUMN_ID, COLUMN_NAME",
                &format!(
                    "ALL_TAB_COLUMNS WHERE OWNER = {} AND TABLE_NAME = {}",
                    literal(&object.owner),
                    literal(&object.name),
                ),
                "COLUMN_ID, COLUMN_NAME",
            )
            .await?;
        if reply.rows.is_empty() {
            return Err("The relation's complete column list is unavailable".into());
        }
        reply.rows.iter().map(|row| reply.text(row, "COLUMN_NAME")).collect()
    }

    async fn call(
        &mut self,
        object: &Object,
        member: Option<&str>,
        reference: &OracleDraftReference,
    ) -> Result<(), String> {
        let expected = if reference.role == OracleDraftReferenceRole::Procedure { "PROCEDURE" } else { "FUNCTION" };
        if object.name == "DBMS_SQL" {
            return Err("DBMS_SQL execution cannot be proven by this static plan; use supported static SQL or deselect this object".into());
        }
        if let Some(index) = object.selected {
            if member.is_some() || object.kind != expected {
                return Err("Selected dependency has another routine kind".into());
            }
            let parameters =
                &self.selected[index].analysis.as_ref().ok_or("Selected dependency is deleted")?.parameters;
            return check_arguments(
                parameters.iter().map(|parameter| (parameter.mode.as_str(), parameter.has_default)),
                reference,
            );
        }
        if (member.is_some() && object.kind != "PACKAGE") || (member.is_none() && object.kind != expected) {
            return Err(format!("Dependency {}.{} is not an unambiguous {expected}", object.owner, object.name));
        }
        self.accessible(object, false).await?;
        let member_filter = member
            .map(|member| format!("PROCEDURE_NAME = {}", literal(member)))
            .unwrap_or_else(|| "PROCEDURE_NAME IS NULL".into());
        let procedures = self
            .rows(
                "OBJECT_ID, SUBPROGRAM_ID",
                &format!(
                    "ALL_PROCEDURES WHERE OWNER = {} AND OBJECT_ID = {} AND {member_filter}",
                    literal(&object.owner),
                    object.object_id,
                ),
                "SUBPROGRAM_ID",
            )
            .await?;
        if procedures.rows.len() != 1 {
            return Err(
                "Routine member is missing, overloaded or not fully visible; use an unambiguous supported call".into(),
            );
        }
        let subprogram = procedures.integer(&procedures.rows[0], "SUBPROGRAM_ID")?;
        let arguments = self
            .rows(
                "POSITION, SEQUENCE, IN_OUT, DATA_TYPE, TYPE_OWNER, TYPE_NAME, TYPE_SUBNAME, DEFAULTED",
                &format!(
            "ALL_ARGUMENTS WHERE OWNER = {} AND OBJECT_ID = {} AND SUBPROGRAM_ID = {subprogram} AND DATA_LEVEL = 0",
            literal(&object.owner), object.object_id,
        ),
                "POSITION, SEQUENCE",
            )
            .await?;
        let mut parameters = Vec::new();
        let mut function = false;
        for row in &arguments.rows {
            if !matches!(arguments.cell(row, "TYPE_NAME")?, Value::Null)
                || !matches!(arguments.cell(row, "TYPE_SUBNAME")?, Value::Null)
            {
                return Err("A user-defined argument type requires manual correction or a smaller selection".into());
            }
            let data_type = arguments.text(row, "DATA_TYPE")?;
            if !scalar_argument_type(&data_type) {
                return Err(format!("Argument type {data_type} is outside this static plan"));
            }
            let position = arguments.integer(row, "POSITION")?;
            if position == 0 {
                if function {
                    return Err("Routine return metadata is ambiguous".into());
                }
                function = true;
            } else {
                if position != parameters.len() as u64 + 1 {
                    return Err("Routine argument metadata has a gap".into());
                }
                parameters.push((arguments.text(row, "IN_OUT")?, arguments.text(row, "DEFAULTED")? == "Y"));
            }
        }
        if function != (expected == "FUNCTION") {
            return Err("Routine member kind could not be confirmed".into());
        }
        check_arguments(parameters.iter().map(|(mode, default)| (mode.as_str(), *default)), reference)
    }

    async fn resolve_call(&mut self, reference: &OracleDraftReference) -> Result<(Object, Option<String>), String> {
        let parts: Vec<&str> = reference.parts.iter().map(|name| name.value.as_str()).collect();
        let owner = self.endpoint.schema.clone();
        let (object, member) = match parts.as_slice() {
            [name] => (self.object(&owner, name, true).await?, None),
            [first, second] => {
                let prefix = self.object(&owner, first, true).await?;
                let qualified = self.object(first, second, false).await?;
                match (prefix, qualified) {
                    (Some(prefix), Some(_)) => return Err(format!("{}.{} has competing package/schema interpretations; qualify a package member with all three name parts", prefix.name, second)),
                    (Some(prefix), None) if prefix.kind == "PACKAGE" => (Some(prefix), Some((*second).into())),
                    (Some(_), None) => return Err("The first name is captured by a local object; qualify or rename this reference".into()),
                    (None, qualified) => (qualified, None),
                }
            }
            [schema, package, member] => {
                if self.object(&owner, schema, true).await?.is_some() {
                    return Err("The schema prefix is captured by a local object; use an unambiguous reference".into());
                }
                (self.object(schema, package, false).await?, Some((*member).into()))
            }
            _ => return Err("Reference needs one, two or three exact name parts".into()),
        };
        let object = object.ok_or("Referenced routine was not confirmed in the target namespace")?;
        self.call(&object, member.as_deref(), reference).await?;
        Ok((object, member))
    }
}

fn scalar_argument_type(value: &str) -> bool {
    matches!(
        value,
        "NUMBER"
            | "INTEGER"
            | "BINARY_INTEGER"
            | "PLS_INTEGER"
            | "BINARY_FLOAT"
            | "BINARY_DOUBLE"
            | "FLOAT"
            | "VARCHAR2"
            | "NVARCHAR2"
            | "CHAR"
            | "NCHAR"
            | "BOOLEAN"
            | "PL/SQL BOOLEAN"
            | "DATE"
            | "TIMESTAMP"
            | "RAW"
    )
}

fn check_arguments<'a>(
    parameters: impl Iterator<Item = (&'a str, bool)>,
    reference: &OracleDraftReference,
) -> Result<(), String> {
    let parameters: Vec<_> = parameters.collect();
    let supplied = reference.argument_writable.len();
    if supplied > parameters.len() || parameters.iter().skip(supplied).any(|(_, default)| !default) {
        return Err("Call argument count does not match the final signature/defaults".into());
    }
    for ((mode, _), writable) in parameters.iter().zip(&reference.argument_writable) {
        if !matches!(*mode, "IN" | "OUT" | "IN OUT" | "IN/OUT") || (*mode != "IN" && !writable) {
            return Err("OUT/IN OUT arguments must be writable local scalars".into());
        }
    }
    Ok(())
}

pub(super) async fn resolve_draft(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    selected: &[SelectedFinalDraft],
    index: usize,
) -> DraftResolution {
    let mut resolver = Resolver {
        catalog,
        endpoint,
        login: String::new(),
        selected,
        output: DraftResolution {
            references: Vec::new(),
            selected_dependencies: BTreeSet::new(),
            proofs: Vec::new(),
            issues: Vec::new(),
        },
    };
    let Some(analysis) = &selected[index].analysis else {
        return resolver.output;
    };
    if !analysis.complete {
        resolver.output.issues = analysis.issues.clone();
        return resolver.output;
    }
    let login = async {
        let reply = resolver.query("SELECT USER AS LOGIN_OWNER FROM DUAL".into()).await?;
        if reply.rows.len() != 1 {
            return Err("Target owner visibility is unknown".to_owned());
        }
        reply.text(&reply.rows[0], "LOGIN_OWNER")
    }
    .await;
    match login {
        Ok(login) => resolver.login = login,
        Err(error) => {
            resolver.output.issues.push(OracleDraftIssue {
                code: "target-visibility".into(),
                message: error,
                line: 1,
                column: 1,
            });
            return resolver.output;
        }
    }
    let mut relations: BTreeMap<usize, (Object, BTreeSet<String>)> = BTreeMap::new();
    for (reference_index, reference) in analysis.references.iter().enumerate() {
        let resolution: Result<Option<(Object, Option<String>)>, String> = async {
            if reference.role == OracleDraftReferenceRole::Relation {
                let parts: Vec<&str> = reference.parts.iter().map(|part| part.value.as_str()).collect();
                let object = match parts.as_slice() {
                    [name] => resolver.object(&endpoint.schema, name, true).await?,
                    [owner, name] => resolver.object(owner, name, false).await?,
                    _ => return Err("A relation needs an exact local or owner.table name".into()),
                }
                .ok_or("Target relation is not confirmed")?;
                if !matches!(object.kind.as_str(), "TABLE" | "VIEW" | "MATERIALIZED VIEW") {
                    return Err("FROM does not resolve to a table or view".into());
                }
                let columns = resolver.columns(&object).await?;
                relations.insert(reference_index, (object.clone(), columns));
                return Ok(Some((object, None)));
            }
            if let Some(query) = reference.query {
                let query = analysis.queries.get(query).ok_or("SQL reference has no verified query scope")?;
                let (relation, columns) =
                    relations.get(&query.relation_reference).ok_or("SQL relation/columns are not verified")?;
                let values: Vec<&str> = reference.parts.iter().map(|part| part.value.as_str()).collect();
                if reference.role == OracleDraftReferenceRole::Value {
                    match values.as_slice() {
                        [column] if columns.contains(*column) => return Ok(None),
                        [qualifier, column]
                            if query.alias.as_ref().map(|alias| alias.value.as_str()).unwrap_or(&relation.name)
                                == *qualifier =>
                        {
                            return if columns.contains(*column) {
                                Ok(None)
                            } else {
                                Err("The qualified SQL column is not present in the complete column list".into())
                            };
                        }
                        [_, _] if query.alias.as_ref().is_some_and(|alias| alias.value == reference.parts[0].value) => {
                            return Err("SQL alias cannot be used as a schema/routine prefix".into())
                        }
                        _ => {}
                    }
                } else if query.alias.as_ref().is_some_and(|alias| alias.value == reference.parts[0].value) {
                    return Err("SQL alias shadows this routine prefix".into());
                }
                if reference.local_binding.is_some() {
                    return if reference.role == OracleDraftReferenceRole::Value && reference.parts.len() == 1 {
                        Ok(None)
                    } else {
                        Err("A local scalar shadows this routine prefix; calls or member access are not supported on scalar bindings".into())
                    };
                }
            }
            resolver.resolve_call(reference).await.map(Some)
        }
        .await;
        match resolution {
            Ok(Some((object, member))) => {
                if let Some(dependency) = object.selected.filter(|dependency| *dependency != index) {
                    resolver.output.selected_dependencies.insert(dependency);
                }
                resolver.output.references.push(ResolvedRoutineReference {
                    owner: object.owner,
                    name: object.name,
                    kind: object.kind,
                    member,
                    selected_index: object.selected,
                    line: reference.line,
                    column: reference.column,
                });
            }
            Ok(None) => {}
            Err(message) => resolver.output.issues.push(OracleDraftIssue {
                code: "unresolved-reference".into(),
                message,
                line: reference.line,
                column: reference.column,
            }),
        }
    }
    resolver.output
}

#[cfg(test)]
mod tests;
