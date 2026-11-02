//! Read-only inputs for the controlled Oracle-family TYPE manager.
//!
//! These readers deliberately preserve partial rows and report the completeness
//! of each dictionary independently. An empty vector is never a substitute for
//! a failed, truncated, or structurally incomplete read.

use super::sql_string;
use crate::db;
use crate::db::{
    OracleTypeManagementDependency, OracleTypeManagementError, OracleTypeManagementObject,
    OracleTypeManagementPrivilege, OracleTypeManagementReference, TypeMetadataRead, TypeMetadataState,
};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::future::Future;

const MAX_DEPENDENCY_OBJECTS: usize = 500;

/// QueryResult deliberately omits result-grid preview metadata. TYPE readers
/// must consume it before that shared model can discard a deferred cell flag.
#[derive(serde::Deserialize)]
#[serde(try_from = "Value")]
pub(super) struct QueryResponse {
    result: db::QueryResult,
    metadata: QueryResponseMetadata,
}

#[derive(serde::Deserialize)]
struct QueryResponseMetadata {
    #[serde(default, alias = "largeValueCells")]
    large_value_cells: Option<Vec<Value>>,
    #[serde(default, alias = "executionError")]
    execution_error: bool,
    #[serde(default, alias = "hasMore")]
    has_more: bool,
}

impl TryFrom<Value> for QueryResponse {
    type Error = serde_json::Error;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        // serde's flatten buffer cannot deserialize QueryResult's u128 timing.
        // Read the flags by reference, then decode the ordinary result unchanged.
        let metadata = <QueryResponseMetadata as serde::Deserialize>::deserialize(&value)?;
        Ok(Self { result: serde_json::from_value(value)?, metadata })
    }
}

impl QueryResponse {
    pub(super) fn into_result(self) -> Result<db::QueryResult, String> {
        if self.metadata.execution_error {
            return Err(
                "The TYPE query returned an execution error; no complete metadata or scalar values were accepted"
                    .into(),
            );
        }
        let mut result = self.result;
        result.has_more |= self.metadata.has_more;
        result.truncated |= self.metadata.large_value_cells.is_some_and(|cells| !cells.is_empty());
        Ok(result)
    }
}

pub(super) fn available() -> TypeMetadataRead {
    TypeMetadataRead { state: TypeMetadataState::Available, reason: None }
}

pub(super) fn unavailable(reason: impl Into<String>) -> TypeMetadataRead {
    TypeMetadataRead { state: TypeMetadataState::Unavailable, reason: Some(reason.into()) }
}

fn incomplete(read: &mut TypeMetadataRead, reason: impl Into<String>) {
    if matches!(read.state, TypeMetadataState::Unavailable | TypeMetadataState::Unsupported) {
        return;
    }
    read.state = TypeMetadataState::Incomplete;
    let reason = reason.into();
    read.reason = Some(match read.reason.take() {
        Some(previous) => format!("{previous}; {reason}"),
        None => reason,
    });
}

pub(super) struct Rows {
    pub(super) columns: Vec<String>,
    pub(super) rows: Vec<Vec<Value>>,
    pub(super) read: TypeMetadataRead,
}

impl Rows {
    pub(super) fn new(result: Result<db::QueryResult, String>, required: &[&str]) -> Self {
        match result {
            Err(error) => Self { columns: Vec::new(), rows: Vec::new(), read: unavailable(error) },
            Ok(result) => {
                let mut read = available();
                if result.truncated || result.has_more {
                    incomplete(&mut read, "Dictionary result was truncated or has more rows");
                }
                if result.messages.iter().any(|message| message.severity.eq_ignore_ascii_case("ERROR")) {
                    incomplete(&mut read, "Dictionary query returned an execution error message");
                }
                if result.rows.iter().any(|row| {
                    row.len() != result.columns.len() || row.iter().any(|cell| cell.is_array() || cell.is_object())
                }) {
                    incomplete(&mut read, "Dictionary cells are incomplete or contain unresolved large-value data");
                }
                let missing: Vec<_> = required
                    .iter()
                    .filter(|column| !result.columns.iter().any(|actual| actual.eq_ignore_ascii_case(column)))
                    .copied()
                    .collect();
                if !missing.is_empty() {
                    incomplete(&mut read, format!("Missing dictionary columns: {}", missing.join(", ")));
                }
                Self { columns: result.columns, rows: result.rows, read }
            }
        }
    }

    pub(super) fn value<'a>(&self, row: &'a [Value], column: &str) -> Option<&'a Value> {
        self.columns
            .iter()
            .position(|actual| actual.eq_ignore_ascii_case(column))
            .and_then(|index| row.get(index))
            .filter(|value| !value.is_null())
    }

    pub(super) fn text(&self, row: &[Value], column: &str) -> Option<String> {
        self.value(row, column).and_then(|value| match value {
            Value::String(text) if !text.is_empty() => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
    }

    pub(super) fn yes_no(&self, row: &[Value], column: &str) -> Option<bool> {
        match self.text(row, column)?.to_ascii_uppercase().as_str() {
            "YES" | "Y" | "TRUE" => Some(true),
            "NO" | "N" | "FALSE" => Some(false),
            _ => None,
        }
    }
}

pub(super) async fn acting_user<F, Fut>(mut run: F) -> (Option<String>, TypeMetadataRead)
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let rows = Rows::new(run("SELECT USER AS ACTING_USER FROM DUAL".into()).await, &["ACTING_USER"]);
    let mut read = rows.read.clone();
    let user = if rows.rows.len() == 1 { rows.text(&rows.rows[0], "ACTING_USER") } else { None };
    if user.is_none() {
        incomplete(&mut read, "The active grantor identity could not be verified");
    }
    (user, read)
}

/// State, identity and diagnostics remain separate: INVALID with no errors is
/// still INVALID, and an empty successful catalogue is distinct from a failed read.
pub(super) async fn object_metadata<F, Fut>(
    dialect: super::oracle_type_details::Dialect,
    owner: &str,
    name: &str,
    object_type: &str,
    mut run: F,
) -> OracleTypeManagementObject
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let query = if dialect == super::oracle_type_details::Dialect::Dameng && !object_type.ends_with(" BODY") {
        let subtypes = match object_type {
            "TYPE" => "('TYPE','CLASS','CLLT')",
            "PROCEDURE" | "FUNCTION" => "('PROC')",
            "PACKAGE" => "('PKG')",
            "VIEW" | "MATERIALIZED VIEW" => "('VIEW')",
            "TABLE" => "('UTAB')",
            "TRIGGER" => "('TRIG')",
            "SYNONYM" => "('SYNOM')",
            _ => "('')",
        };
        format!(
            "SELECT O.ID AS OBJECT_ID, O.VALID AS STATUS FROM SYSOBJECTS O JOIN SYSOBJECTS S ON S.ID=O.SCHID AND S.TYPE$='SCH' WHERE S.NAME={} AND O.NAME={} AND O.TYPE$='SCHOBJ' AND O.SUBTYPE$ IN {subtypes}",
            sql_string(owner), sql_string(name),
        )
    } else {
        format!(
            "SELECT OBJECT_ID, STATUS FROM ALL_OBJECTS WHERE OWNER={} AND OBJECT_NAME={} AND OBJECT_TYPE={}",
            sql_string(owner),
            sql_string(name),
            sql_string(object_type),
        )
    };
    let rows = Rows::new(run(query).await, &["OBJECT_ID", "STATUS"]);
    let mut status_read = rows.read.clone();
    let mut exists = None;
    let mut object_id = None;
    let mut status = None;
    if status_read.state == TypeMetadataState::Available {
        match rows.rows.as_slice() {
            [] => exists = Some(false),
            [row] => {
                exists = Some(true);
                object_id = rows.text(row, "OBJECT_ID");
                status = rows.text(row, "STATUS").and_then(|value| match value.to_ascii_uppercase().as_str() {
                    "Y" | "VALID" => Some("VALID".into()),
                    "N" | "INVALID" => Some("INVALID".into()),
                    _ => None,
                });
                if object_id.is_none() || status.is_none() {
                    incomplete(&mut status_read, "Object identity or compilation state is unknown");
                }
            }
            _ => incomplete(&mut status_read, "Object identity is ambiguous"),
        }
    }
    let (errors, errors_read) = if exists == Some(true) && object_type != "TABLE" {
        compilation_errors(dialect, owner, name, object_type, &mut run).await
    } else if exists == Some(false) {
        (Vec::new(), available())
    } else {
        (Vec::new(), unavailable("Compilation diagnostics are not available for this object state"))
    };
    let (trigger_enabled, trigger_enabled_read) = if object_type == "TRIGGER" && exists == Some(true) {
        let rows = Rows::new(
            run(format!(
                "SELECT STATUS FROM ALL_TRIGGERS WHERE OWNER={} AND TRIGGER_NAME={}",
                sql_string(owner),
                sql_string(name)
            ))
            .await,
            &["STATUS"],
        );
        let mut read = rows.read.clone();
        let enabled = if rows.rows.len() == 1 {
            match rows.text(&rows.rows[0], "STATUS").as_deref() {
                Some("ENABLED") => Some(true),
                Some("DISABLED") => Some(false),
                Some("Y") if dialect == super::oracle_type_details::Dialect::Dameng => Some(true),
                Some("N") if dialect == super::oracle_type_details::Dialect::Dameng => Some(false),
                _ => None,
            }
        } else {
            None
        };
        if enabled.is_none() {
            incomplete(&mut read, "The exact trigger ENABLED/DISABLED state is unknown");
        }
        (enabled, Some(read))
    } else {
        (None, None)
    };
    OracleTypeManagementObject {
        owner: owner.into(),
        name: name.into(),
        object_type: object_type.into(),
        exists,
        object_id,
        status,
        status_read,
        trigger_enabled,
        trigger_enabled_read,
        source: None,
        source_read: unavailable("Source has not been read"),
        source_fingerprint: None,
        errors,
        errors_read,
        direct_privileges: Vec::new(),
        privileges_read: unavailable("Direct grants have not been read"),
    }
}

pub(super) async fn compilation_errors<F, Fut>(
    dialect: super::oracle_type_details::Dialect,
    owner: &str,
    name: &str,
    object_type: &str,
    mut run: F,
) -> (Vec<OracleTypeManagementError>, TypeMetadataRead)
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let typed = dialect == super::oracle_type_details::Dialect::Oracle;
    let attribute = if typed { ", ATTRIBUTE" } else { "" };
    let required =
        if typed { &["LINE", "POSITION", "TEXT", "ATTRIBUTE"][..] } else { &["LINE", "POSITION", "TEXT"][..] };
    let rows = Rows::new(
        run(format!(
            "SELECT LINE, POSITION, TEXT{attribute} FROM ALL_ERRORS WHERE OWNER={} AND NAME={} AND TYPE={} ORDER BY SEQUENCE",
            sql_string(owner),
            sql_string(name),
            sql_string(object_type),
        ))
        .await,
        required,
    );
    let mut read = rows.read.clone();
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    for row in &rows.rows {
        match (
            rows.text(row, "LINE").and_then(|value| value.parse::<u32>().ok()),
            rows.text(row, "POSITION").and_then(|value| value.parse::<u32>().ok()),
            rows.text(row, "TEXT"),
        ) {
            (Some(line), Some(position), Some(text)) => {
                match if typed { rows.text(row, "ATTRIBUTE") } else { Some("ERROR".into()) }.as_deref() {
                    Some("ERROR") => errors.push(OracleTypeManagementError { line, position, text }),
                    Some("WARNING") => warnings.push(format!("{line}:{position} {text}")),
                    _ => incomplete(&mut read, "The compilation diagnostic severity is unknown"),
                }
            }
            _ => incomplete(&mut read, "A compilation diagnostic has an unreadable position or message"),
        }
    }
    if !warnings.is_empty() {
        let warning = format!("Compilation warnings:\n{}", warnings.join("\n"));
        read.reason = Some(match read.reason.take() {
            Some(reason) => format!("{reason}; {warning}"),
            None => warning,
        });
    }
    (errors, read)
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ObjectKey {
    owner: String,
    name: String,
    object_type: String,
}

fn dependency_query(key: &ObjectKey) -> String {
    format!(
        "SELECT OWNER, NAME, TYPE, REFERENCED_OWNER, REFERENCED_NAME, REFERENCED_TYPE, REFERENCED_LINK_NAME FROM ALL_DEPENDENCIES WHERE REFERENCED_OWNER = {} AND REFERENCED_NAME = {} AND REFERENCED_TYPE = {}",
        sql_string(&key.owner),
        sql_string(&key.name),
        sql_string(&key.object_type),
    )
}

fn dameng_dependency_query(key: &ObjectKey) -> String {
    let object_types = match key.object_type.as_str() {
        "TYPE" => "('TYPE','CLASS')".to_string(),
        other => format!("({})", sql_string(other)),
    };
    format!(
        "SELECT DS.NAME AS OWNER, DOBJ.NAME AS NAME, D.TYPE$ AS TYPE, RS.NAME AS REFERENCED_OWNER, ROBJ.NAME AS REFERENCED_NAME, D.REFED_TYPE$ AS REFERENCED_TYPE, CAST(NULL AS VARCHAR(128)) AS REFERENCED_LINK_NAME FROM SYSDEPENDENCIES D LEFT JOIN SYSOBJECTS DOBJ ON DOBJ.ID = D.ID JOIN SYSOBJECTS ROBJ ON ROBJ.ID = D.REFED_ID LEFT JOIN SYSOBJECTS DS ON DS.ID = DOBJ.SCHID AND DS.TYPE$ = 'SCH' LEFT JOIN SYSOBJECTS RS ON RS.ID = ROBJ.SCHID AND RS.TYPE$ = 'SCH' WHERE RS.NAME = {} AND ROBJ.NAME = {} AND D.REFED_TYPE$ IN {object_types}",
        sql_string(&key.owner),
        sql_string(&key.name),
    )
}

fn canonical_object_type(value: &str) -> String {
    match value.to_ascii_uppercase().as_str() {
        "CLASS" | "CLLT" => "TYPE".into(),
        "CLASS_BODY" | "TYPE_BODY" => "TYPE BODY".into(),
        "PACKAGE_BODY" => "PACKAGE BODY".into(),
        other => other.into(),
    }
}

pub(super) async fn dependencies<F, Fut>(
    dialect: super::oracle_type_details::Dialect,
    owner: &str,
    name: &str,
    mut run: F,
) -> (Vec<OracleTypeManagementDependency>, TypeMetadataRead)
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let mut output = Vec::new();
    let mut read = available();
    let mut pending = VecDeque::from([
        ObjectKey { owner: owner.to_string(), name: name.to_string(), object_type: "TYPE".to_string() },
        ObjectKey { owner: owner.to_string(), name: name.to_string(), object_type: "TYPE BODY".to_string() },
    ]);
    let mut queried = HashSet::new();
    let mut seen = HashSet::<(String, String, String, String, String, String, Option<String>)>::new();
    while let Some(key) = pending.pop_front() {
        if !queried.insert(key.clone()) {
            continue;
        }
        // DM explicitly excludes body kinds from REFED_TYPE$; their outgoing
        // edges are still returned when the corresponding specification is read.
        if dialect == super::oracle_type_details::Dialect::Dameng && key.object_type.ends_with(" BODY") {
            continue;
        }
        let query = if dialect == super::oracle_type_details::Dialect::Dameng {
            dameng_dependency_query(&key)
        } else {
            dependency_query(&key)
        };
        let rows = Rows::new(
            run(query).await,
            &[
                "OWNER",
                "NAME",
                "TYPE",
                "REFERENCED_OWNER",
                "REFERENCED_NAME",
                "REFERENCED_TYPE",
                "REFERENCED_LINK_NAME",
            ],
        );
        if rows.read.state != TypeMetadataState::Available {
            incomplete(&mut read, rows.read.reason.clone().unwrap_or_else(|| "Dependency read is incomplete".into()));
        }
        for row in &rows.rows {
            let Some(dep_owner) = rows.text(row, "OWNER") else {
                incomplete(&mut read, "A dependency owner is missing");
                continue;
            };
            let Some(dep_name) = rows.text(row, "NAME") else {
                incomplete(&mut read, "A dependency name is missing");
                continue;
            };
            let Some(dep_type) = rows.text(row, "TYPE").map(|value| canonical_object_type(&value)) else {
                incomplete(&mut read, "A dependency object type is missing");
                continue;
            };
            let Some(referenced_owner) = rows.text(row, "REFERENCED_OWNER") else {
                incomplete(&mut read, "A referenced owner is missing");
                continue;
            };
            let Some(referenced_name) = rows.text(row, "REFERENCED_NAME") else {
                incomplete(&mut read, "A referenced name is missing");
                continue;
            };
            let Some(referenced_type) = rows.text(row, "REFERENCED_TYPE").map(|value| canonical_object_type(&value))
            else {
                incomplete(&mut read, "A referenced object type is missing");
                continue;
            };
            let referenced_link = rows.text(row, "REFERENCED_LINK_NAME");
            let dependency = OracleTypeManagementDependency {
                owner: dep_owner.clone(),
                name: dep_name.clone(),
                object_type: dep_type.clone(),
                referenced_owner,
                referenced_name,
                referenced_type,
                referenced_link: referenced_link.clone(),
            };
            if seen.insert((
                dependency.owner.clone(),
                dependency.name.clone(),
                dependency.object_type.clone(),
                dependency.referenced_owner.clone(),
                dependency.referenced_name.clone(),
                dependency.referenced_type.clone(),
                dependency.referenced_link.clone(),
            )) {
                output.push(dependency);
            }
            if referenced_link.is_some() {
                incomplete(&mut read, "A dependency crosses a database link and cannot be traversed");
            } else if queried.len() + pending.len() < MAX_DEPENDENCY_OBJECTS {
                pending.push_back(ObjectKey { owner: dep_owner, name: dep_name, object_type: dep_type });
            } else {
                incomplete(&mut read, "Dependency closure exceeded the 500-object read limit");
            }
        }
    }
    (output, read)
}

pub(super) async fn persistent_references<F, Fut>(
    dialect: super::oracle_type_details::Dialect,
    owner: &str,
    name: &str,
    mut run: F,
) -> (Vec<OracleTypeManagementReference>, TypeMetadataRead)
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let result = if dialect == super::oracle_type_details::Dialect::Dameng {
        run(format!(
            "SELECT DISTINCT S.NAME AS OWNER, O.NAME AS TABLE_NAME, CAST(NULL AS VARCHAR(128)) AS COLUMN_NAME, {} AS DATA_TYPE_OWNER, {} AS DATA_TYPE, CAST(NULL AS VARCHAR(5)) AS READ_ONLY FROM SYSDEPENDENCIES D JOIN SYSOBJECTS O ON O.ID = D.ID AND O.TYPE$ = 'SCHOBJ' AND O.SUBTYPE$ = 'UTAB' JOIN SYSOBJECTS S ON S.ID = O.SCHID AND S.TYPE$ = 'SCH' WHERE D.REFED_ID IN (SELECT T.ID FROM SYSOBJECTS T JOIN SYSOBJECTS TS ON TS.ID = T.SCHID AND TS.TYPE$ = 'SCH' WHERE TS.NAME = {} AND T.NAME = {} AND T.TYPE$ = 'SCHOBJ' AND T.SUBTYPE$ IN ('TYPE', 'CLASS', 'CLLT')) AND D.REFED_TYPE$ IN ('TYPE','CLASS')",
            sql_string(owner), sql_string(name), sql_string(owner), sql_string(name)
        )).await
    } else {
        run(format!(
            "SELECT C.OWNER, C.TABLE_NAME, C.COLUMN_NAME, C.DATA_TYPE_OWNER, C.DATA_TYPE, T.READ_ONLY FROM ALL_TAB_COLUMNS C LEFT JOIN ALL_TABLES T ON T.OWNER = C.OWNER AND T.TABLE_NAME = C.TABLE_NAME WHERE C.DATA_TYPE_OWNER = {} AND C.DATA_TYPE = {}",
            sql_string(owner),
            sql_string(name),
        )).await
    };
    let rows = Rows::new(result, &["OWNER", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE_OWNER", "DATA_TYPE", "READ_ONLY"]);
    let mut read = rows.read.clone();
    let mut references = Vec::new();
    for row in &rows.rows {
        let (Some(owner), Some(table_name)) = (rows.text(row, "OWNER"), rows.text(row, "TABLE_NAME")) else {
            incomplete(&mut read, "A persistent type reference has incomplete identity");
            continue;
        };
        let column_name = rows.text(row, "COLUMN_NAME");
        if column_name.is_none() {
            incomplete(&mut read, format!("The exact persistent column must be verified for {owner}.{table_name}"));
        }
        let table_read_only = rows.yes_no(row, "READ_ONLY");
        if table_read_only.is_none() {
            incomplete(&mut read, format!("Read-only state is unknown for {owner}.{table_name}"));
        }
        references.push(OracleTypeManagementReference {
            owner,
            table_name,
            column_name,
            data_type_owner: rows.text(row, "DATA_TYPE_OWNER"),
            data_type: rows.text(row, "DATA_TYPE"),
            table_status: None,
            table_read_only,
        });
    }
    (references, read)
}

pub(super) async fn direct_privileges<F, Fut>(
    dialect: super::oracle_type_details::Dialect,
    owner: &str,
    name: &str,
    mut run: F,
) -> (Vec<OracleTypeManagementPrivilege>, TypeMetadataRead)
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let (result, required) = if dialect == super::oracle_type_details::Dialect::Dameng {
        (
            run(format!(
                "SELECT G.URID, G.OBJID, G.COLID, G.PRIVID, G.GRANTOR, G.GRANTABLE, U.NAME AS GRANTEE, GU.NAME AS GRANTOR_NAME, A.NAME AS PRIVILEGE, A.TYPE AS PRIVILEGE_TYPE FROM SYSOBJECTS O JOIN SYSOBJECTS S ON S.ID = O.SCHID AND S.TYPE$ = 'SCH' JOIN SYSGRANTS G ON G.OBJID = O.ID LEFT JOIN SYSOBJECTS U ON U.ID = G.URID AND U.TYPE$ = 'UR' LEFT JOIN SYSOBJECTS GU ON GU.ID = G.GRANTOR AND GU.TYPE$ = 'UR' LEFT JOIN V$AUTHORITIES A ON A.ID = G.PRIVID WHERE S.NAME = {} AND O.NAME = {} AND O.TYPE$ = 'SCHOBJ' AND O.SUBTYPE$ IN ('CLASS', 'TYPE', 'CLLT')",
                sql_string(owner),
                sql_string(name),
            ))
            .await,
            &["URID", "OBJID", "COLID", "PRIVID", "GRANTOR", "GRANTOR_NAME", "GRANTABLE", "GRANTEE", "PRIVILEGE", "PRIVILEGE_TYPE"][..],
        )
    } else {
        (
            run(format!(
                "SELECT GRANTOR, GRANTEE, PRIVILEGE, GRANTABLE, HIERARCHY FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
                sql_string(owner),
                sql_string(name),
            ))
            .await,
            &["GRANTOR", "GRANTEE", "PRIVILEGE", "GRANTABLE", "HIERARCHY"][..],
        )
    };
    let rows = Rows::new(result, required);
    let mut privileges = Vec::new();
    let mut read = rows.read.clone();
    for row in &rows.rows {
        let grantee = rows.text(row, "GRANTEE").or_else(|| rows.text(row, "URID").map(|id| format!("ID:{id}")));
        let privilege = rows.text(row, "PRIVILEGE").or_else(|| rows.text(row, "PRIVID").map(|id| format!("ID:{id}")));
        match (grantee, privilege) {
            (Some(grantee), Some(privilege)) => {
                let grantor = if dialect == super::oracle_type_details::Dialect::Dameng {
                    let name = rows.text(row, "GRANTOR_NAME");
                    if name.is_none() {
                        incomplete(&mut read, "A DM grantor identifier could not be resolved to its name");
                    }
                    name.or_else(|| rows.text(row, "GRANTOR"))
                } else {
                    rows.text(row, "GRANTOR")
                };
                if rows.value(row, "PRIVILEGE").is_none() || rows.value(row, "GRANTEE").is_none() {
                    incomplete(&mut read, "A direct privilege identifier could not be resolved to its name");
                }
                if dialect == super::oracle_type_details::Dialect::Dameng && rows.value(row, "PRIVILEGE_TYPE").is_none()
                {
                    incomplete(&mut read, "A DM privilege type could not be resolved");
                }
                if dialect == super::oracle_type_details::Dialect::Dameng
                    && rows.text(row, "PRIVILEGE_TYPE").as_deref().is_some_and(|kind| kind != "2")
                {
                    incomplete(&mut read, "A DM grant row is not a recognized object privilege");
                }
                privileges.push(OracleTypeManagementPrivilege {
                    grantee,
                    privilege,
                    grantable: rows.yes_no(row, "GRANTABLE"),
                    hierarchy: if dialect == super::oracle_type_details::Dialect::Dameng {
                        Some(false)
                    } else {
                        rows.yes_no(row, "HIERARCHY")
                    },
                    grantor,
                    privilege_id: rows.text(row, "PRIVID"),
                    privilege_type: rows.text(row, "PRIVILEGE_TYPE"),
                    column_id: rows.text(row, "COLID"),
                });
            }
            _ => incomplete(&mut read, "A direct privilege row has incomplete identity"),
        }
    }
    (privileges, read)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_large_cell_flags_cannot_be_discarded_before_completeness_checks() {
        for key in ["large_value_cells", "largeValueCells"] {
            let mut payload = json!({"columns":["TEXT"],"rows":[["preview"]],"affected_rows":0,"execution_time_ms":0});
            payload[key] = json!([{"row_index":0,"column_index":0,"original_bytes":4096}]);
            let response: QueryResponse = serde_json::from_value(payload).unwrap();
            let rows = Rows::new(response.into_result(), &["TEXT"]);
            assert_eq!(rows.read.state, TypeMetadataState::Incomplete);
            assert_eq!(rows.rows[0][0], "preview");
        }
    }
    #[test]
    fn transport_more_rows_flags_remain_incomplete_in_both_wire_spellings() {
        for key in ["has_more", "hasMore"] {
            let mut payload = json!({"columns":["VALUE"],"rows":[["1"]],"affected_rows":0,"execution_time_ms":0});
            payload[key] = json!(true);
            let response: QueryResponse = serde_json::from_value(payload).unwrap();
            assert_eq!(Rows::new(response.into_result(), &["VALUE"]).read.state, TypeMetadataState::Incomplete);
        }
    }
    #[test]
    fn transport_execution_errors_cannot_become_an_empty_successful_relation() {
        for key in ["execution_error", "executionError"] {
            let mut payload = json!({"columns":["VALUE"],"rows":[],"affected_rows":0,"execution_time_ms":0});
            payload[key] = json!(true);
            let response: QueryResponse = serde_json::from_value(payload).unwrap();
            assert!(response.into_result().is_err());
        }
    }
    use serde_json::json;
    use std::collections::HashMap;

    fn result(columns: &[&str], rows: Vec<Vec<Value>>) -> db::QueryResult {
        serde_json::from_value(json!({"columns": columns, "rows": rows, "affected_rows": 0, "execution_time_ms": 0}))
            .unwrap()
    }

    #[tokio::test]
    async fn dependency_walk_is_recursive_exact_and_preserves_db_links_and_partial_rows() {
        let mut scripted = HashMap::<String, Result<db::QueryResult, String>>::new();
        let root = ObjectKey { owner: "APP".into(), name: "ROOT".into(), object_type: "TYPE".into() };
        let coll = ObjectKey { owner: "APP".into(), name: "COLL".into(), object_type: "TYPE".into() };
        scripted.insert(
            dependency_query(&root),
            Ok(result(
                &[
                    "OWNER",
                    "NAME",
                    "TYPE",
                    "REFERENCED_OWNER",
                    "REFERENCED_NAME",
                    "REFERENCED_TYPE",
                    "REFERENCED_LINK_NAME",
                ],
                vec![vec![
                    json!("APP"),
                    json!("COLL"),
                    json!("TYPE"),
                    json!("APP"),
                    json!("ROOT"),
                    json!("TYPE"),
                    Value::Null,
                ]],
            )),
        );
        scripted.insert(
            dependency_query(&coll),
            Ok(result(
                &[
                    "OWNER",
                    "NAME",
                    "TYPE",
                    "REFERENCED_OWNER",
                    "REFERENCED_NAME",
                    "REFERENCED_TYPE",
                    "REFERENCED_LINK_NAME",
                ],
                vec![
                    vec![
                        json!("APP"),
                        json!("DEEP"),
                        json!("TYPE"),
                        json!("APP"),
                        json!("COLL"),
                        json!("TYPE"),
                        Value::Null,
                    ],
                    vec![
                        json!("REMOTE"),
                        json!("PROC"),
                        json!("PROCEDURE"),
                        json!("APP"),
                        json!("COLL"),
                        json!("TYPE"),
                        json!("REMOTE_DB"),
                    ],
                ],
            )),
        );
        let (dependencies, read) =
            dependencies(super::super::oracle_type_details::Dialect::Oracle, "APP", "ROOT", |sql| {
                std::future::ready(scripted.remove(&sql).unwrap_or_else(|| {
                    Ok(result(
                        &[
                            "OWNER",
                            "NAME",
                            "TYPE",
                            "REFERENCED_OWNER",
                            "REFERENCED_NAME",
                            "REFERENCED_TYPE",
                            "REFERENCED_LINK_NAME",
                        ],
                        vec![],
                    ))
                }))
            })
            .await;
        assert_eq!(dependencies.len(), 3);
        assert_eq!(read.state, TypeMetadataState::Incomplete);
        assert!(read.reason.unwrap().contains("database link"));
        assert!(dependencies.iter().any(|dependency| dependency.name == "DEEP"));
        assert!(dependencies.iter().any(|dependency| dependency.referenced_link.as_deref() == Some("REMOTE_DB")));
    }

    #[tokio::test]
    async fn dameng_dependency_walk_uses_documented_object_ids_and_schema_ids() {
        let mut queries = Vec::new();
        let (dependencies, read) =
            dependencies(super::super::oracle_type_details::Dialect::Dameng, "APP", "ROOT", |sql| {
                queries.push(sql);
                std::future::ready(Ok(result(
                    &[
                        "OWNER",
                        "NAME",
                        "TYPE",
                        "REFERENCED_OWNER",
                        "REFERENCED_NAME",
                        "REFERENCED_TYPE",
                        "REFERENCED_LINK_NAME",
                    ],
                    vec![vec![
                        json!("APP"),
                        json!("COLL"),
                        json!("TYPE"),
                        json!("APP"),
                        json!("ROOT"),
                        json!("TYPE"),
                        Value::Null,
                    ]],
                )))
            })
            .await;
        assert_eq!(dependencies.len(), 1);
        assert_eq!(read.state, TypeMetadataState::Available);
        assert_eq!(queries.len(), 2, "DM has no body reference kind; root and discovered dependent TYPE are walked");
        assert!(queries.iter().all(|sql| sql.contains("FROM SYSDEPENDENCIES D")));
        assert!(queries.iter().all(|sql| sql.contains("DOBJ.SCHID") && sql.contains("RS.ID = ROBJ.SCHID")));
        assert!(queries.iter().all(|sql| !sql.contains("ALL_DEPENDENCIES")));
    }

    #[tokio::test]
    async fn persisted_reference_unknown_read_only_state_is_not_treated_as_writable() {
        let (references, read) =
            persistent_references(super::super::oracle_type_details::Dialect::Oracle, "APP", "ROOT", |_| {
                std::future::ready(Ok(result(
                    &["OWNER", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE_OWNER", "DATA_TYPE", "READ_ONLY"],
                    vec![vec![json!("APP"), json!("DATA"), json!("VALUE"), json!("APP"), json!("ROOT"), Value::Null]],
                )))
            })
            .await;
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].table_read_only, None);
        assert_eq!(read.state, TypeMetadataState::Incomplete);
    }

    #[tokio::test]
    async fn dameng_persistent_references_use_dependency_ids_and_keep_read_only_unknown() {
        let (references, read) =
            persistent_references(super::super::oracle_type_details::Dialect::Dameng, "APP", "ROOT", |sql| {
                assert!(sql.contains("FROM SYSDEPENDENCIES D"));
                assert!(sql.contains("D.REFED_ID IN (SELECT T.ID"));
                assert!(
                    !sql.contains("C.TYPE$ ="),
                    "An unverified type-name encoding must not hide table dependencies"
                );
                assert!(!sql.contains("ALL_TAB_COLUMNS"));
                std::future::ready(Ok(result(
                    &["OWNER", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE_OWNER", "DATA_TYPE", "READ_ONLY"],
                    vec![vec![json!("APP"), json!("DATA"), Value::Null, json!("APP"), json!("ROOT"), Value::Null]],
                )))
            })
            .await;
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].column_name, None);
        assert_eq!(references[0].table_read_only, None);
        assert_eq!(read.state, TypeMetadataState::Incomplete);
    }

    #[tokio::test]
    async fn direct_privileges_use_table_schema_and_failures_do_not_become_empty_available() {
        let (privileges, read) =
            direct_privileges(super::super::oracle_type_details::Dialect::OceanBase, "APP", "ROOT", |sql| {
                assert!(sql.contains("TABLE_SCHEMA = 'APP'"));
                assert!(!sql.contains("OWNER ="));
                std::future::ready(Err("insufficient privilege".into()))
            })
            .await;
        assert!(privileges.is_empty());
        assert_eq!(read.state, TypeMetadataState::Unavailable);
    }

    #[tokio::test]
    async fn dameng_grants_preserve_unresolved_authority_rows_as_incomplete() {
        let (privileges, read) =
            direct_privileges(super::super::oracle_type_details::Dialect::Dameng, "APP", "ROOT", |sql| {
                assert!(sql.contains("JOIN SYSGRANTS G ON G.OBJID = O.ID"));
                assert!(sql.contains("LEFT JOIN V$AUTHORITIES A ON A.ID = G.PRIVID"));
                assert!(sql.contains("G.GRANTABLE"));
                assert!(!sql.contains("HIERARCHY"));
                std::future::ready(Ok(result(
                    &[
                        "URID",
                        "OBJID",
                        "COLID",
                        "PRIVID",
                        "GRANTOR",
                        "GRANTABLE",
                        "GRANTEE",
                        "PRIVILEGE",
                        "PRIVILEGE_TYPE",
                    ],
                    vec![vec![
                        json!(7),
                        json!(11),
                        json!(-1),
                        json!(9001),
                        json!(5),
                        json!("Y"),
                        Value::Null,
                        Value::Null,
                        Value::Null,
                    ]],
                )))
            })
            .await;
        assert_eq!(privileges.len(), 1);
        assert_eq!(privileges[0].grantee, "ID:7");
        assert_eq!(privileges[0].privilege, "ID:9001");
        assert_eq!(privileges[0].grantable, Some(true));
        assert_eq!(privileges[0].grantor.as_deref(), Some("5"));
        assert_eq!(privileges[0].column_id.as_deref(), Some("-1"));
        assert_eq!(read.state, TypeMetadataState::Incomplete);
    }

    #[test]
    fn type_sql_plan_api_builds_only_exact_typed_operations() {
        use crate::db::{OracleTypeManagementSqlInput as Input, OracleTypeManagementSqlOperation as Op};
        use crate::models::connection::DatabaseType;
        let source = "CREATE OR REPLACE TYPE \"APP\".\"Mixed Type\" AS OBJECT (ID NUMBER);".to_string();
        let result = super::super::build_oracle_type_management_sql(Input {
            database_type: DatabaseType::OceanbaseOracle,
            operation: Op::SaveSpec,
            owner: "APP".into(),
            name: "Mixed Type".into(),
            source: Some(source.clone()),
            grantee: None,
            grantable: false,
            object_type: None,
            privilege: None,
            trigger_enabled: None,
        })
        .unwrap();
        assert_eq!(result.statements, vec![source]);

        let result = super::super::build_oracle_type_management_sql(Input {
            database_type: DatabaseType::Dameng,
            operation: Op::DropBody,
            owner: "APP".into(),
            name: "Mixed Type".into(),
            source: None,
            grantee: None,
            grantable: false,
            object_type: None,
            privilege: None,
            trigger_enabled: None,
        })
        .unwrap();
        assert_eq!(result.statements, vec!["DROP TYPE BODY \"APP\".\"Mixed Type\" RESTRICT;"]);

        assert!(super::super::build_oracle_type_management_sql(Input {
            database_type: DatabaseType::Oracle,
            operation: Op::SaveBody,
            owner: "APP".into(),
            name: "Mixed Type".into(),
            source: Some("CREATE TYPE \"APP\".\"Mixed Type\" AS OBJECT (ID NUMBER);".into()),
            grantee: None,
            grantable: false,
            object_type: None,
            privilege: None,
            trigger_enabled: None,
        })
        .is_err());

        for database_type in [DatabaseType::Oracle, DatabaseType::OceanbaseOracle, DatabaseType::Dameng] {
            let compiled = super::super::build_oracle_type_management_sql(Input {
                database_type,
                operation: Op::CompileSpec,
                owner: "APP".into(),
                name: "Quoted\" Type".into(),
                source: Some("CREATE TYPE APP.\"Quoted\"\" Type\" AS OBJECT (ID NUMBER);".into()),
                grantee: None,
                grantable: false,
                object_type: None,
                privilege: None,
                trigger_enabled: None,
            });
            if database_type == DatabaseType::Oracle {
                let compiled = compiled.unwrap();
                assert_eq!(compiled.statements, vec!["ALTER TYPE \"APP\".\"Quoted\"\" Type\" COMPILE SPECIFICATION;"]);
                assert!(compiled.source_fingerprint.is_some());
            } else {
                assert!(
                    compiled.is_err(),
                    "Do not generate the ALTER/COMPILE rejected by the OB probe or guess DM syntax"
                );
            }
        }
    }

    #[tokio::test]
    async fn type_management_trigger_state_is_independent_from_compilation_and_source() {
        for state in [Some("ENABLED"), Some("DISABLED"), Some("UNKNOWN"), None] {
            let object = object_metadata(
                super::super::oracle_type_details::Dialect::OceanBase,
                "APP",
                "TRG",
                "TRIGGER",
                |sql| {
                    std::future::ready(Ok(if sql.contains("FROM ALL_OBJECTS") {
                        result(&["OBJECT_ID", "STATUS"], vec![vec![json!(1), json!("VALID")]])
                    } else if sql.contains("FROM ALL_TRIGGERS") {
                        result(&["STATUS"], vec![vec![state.map_or(Value::Null, |s| json!(s))]])
                    } else {
                        result(&["LINE", "POSITION", "TEXT"], vec![])
                    }))
                },
            )
            .await;
            let value = serde_json::to_value(object).unwrap();
            assert_eq!(
                value["triggerEnabled"],
                match state {
                    Some("ENABLED") => json!(true),
                    Some("DISABLED") => json!(false),
                    _ => Value::Null,
                }
            );
            assert_eq!(
                value["triggerEnabledRead"]["state"],
                if matches!(state, Some("ENABLED" | "DISABLED")) { "available" } else { "incomplete" }
            );
        }
    }

    #[test]
    fn type_management_trigger_api_preserves_state_without_an_enable_disable_window() {
        use crate::models::connection::DatabaseType;
        let source = "CREATE OR REPLACE TRIGGER APP.TRG BEFORE INSERT ON APP.DATA BEGIN NULL; END;";
        for database_type in [DatabaseType::Oracle, DatabaseType::OceanbaseOracle, DatabaseType::Dameng] {
            for enabled in [false, true] {
                let input = |operation| {
                    serde_json::from_value(json!({"databaseType": database_type, "operation":operation, "owner":"APP", "name":"TRG", "objectType":"TRIGGER", "source":source, "triggerEnabled":enabled})).unwrap()
                };
                let compiled = super::super::build_oracle_type_management_sql(input("compile_trigger")).unwrap();
                assert_eq!(compiled.statements, vec!["ALTER TRIGGER \"APP\".\"TRG\" COMPILE;"]);
                let rebuilt = super::super::build_oracle_type_management_sql(input("rebuild_source"));
                if database_type == DatabaseType::Dameng && !enabled {
                    assert!(rebuilt.is_err());
                } else {
                    let rebuilt = rebuilt.unwrap();
                    assert_eq!(rebuilt.statements.len(), 1);
                    assert!(rebuilt.source_fingerprint.is_some());
                    if !enabled {
                        assert!(rebuilt.statements[0].contains("DISABLE BEGIN"));
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn type_management_dameng_trigger_state_uses_the_existing_y_n_semantics() {
        for (state, expected) in [("Y", Some(true)), ("N", Some(false)), ("?", None)] {
            let object =
                object_metadata(super::super::oracle_type_details::Dialect::Dameng, "APP", "TRG", "TRIGGER", |sql| {
                    std::future::ready(Ok(if sql.contains("FROM SYSOBJECTS") {
                        result(&["OBJECT_ID", "STATUS"], vec![vec![json!(1), json!("Y")]])
                    } else if sql.contains("FROM ALL_TRIGGERS") {
                        result(&["STATUS"], vec![vec![json!(state)]])
                    } else {
                        result(&["LINE", "POSITION", "TEXT"], vec![])
                    }))
                })
                .await;
            assert_eq!(object.trigger_enabled, expected);
            assert_eq!(
                object.trigger_enabled_read.unwrap().state,
                if expected.is_some() { TypeMetadataState::Available } else { TypeMetadataState::Incomplete }
            );
        }
    }

    #[tokio::test]
    async fn type_management_native_oracle_warnings_are_not_blocking_compilation_errors() {
        for invalid in [false, true] {
            let object =
                object_metadata(super::super::oracle_type_details::Dialect::Oracle, "APP", "ROOT", "TYPE", |sql| {
                    let response = if sql.contains("FROM ALL_OBJECTS") {
                        result(
                            &["OBJECT_ID", "STATUS"],
                            vec![vec![json!(1), json!(if invalid { "INVALID" } else { "VALID" })]],
                        )
                    } else {
                        let typed = sql.contains("TEXT, ATTRIBUTE");
                        let mut warning = vec![json!(1), json!(1), json!("PLW-06009: compiler warning")];
                        if typed {
                            warning.push(json!("WARNING"));
                        }
                        let mut rows = vec![warning];
                        if invalid {
                            let mut error = vec![json!(2), json!(3), json!("PLS-00201: invalid reference")];
                            if typed {
                                error.push(json!("ERROR"));
                            }
                            rows.push(error);
                        }
                        result(
                            if typed {
                                &["LINE", "POSITION", "TEXT", "ATTRIBUTE"]
                            } else {
                                &["LINE", "POSITION", "TEXT"]
                            },
                            rows,
                        )
                    };
                    std::future::ready(Ok(response))
                })
                .await;
            assert_eq!(object.errors.len(), usize::from(invalid));
            assert_eq!(object.errors_read.state, TypeMetadataState::Available);
            assert!(object.errors_read.reason.as_deref().unwrap_or_default().contains("PLW-06009"));
        }
    }

    #[tokio::test]
    async fn type_management_native_oracle_unknown_diagnostic_severity_remains_incomplete() {
        let object =
            object_metadata(super::super::oracle_type_details::Dialect::Oracle, "APP", "ROOT", "TYPE", |sql| {
                std::future::ready(Ok(if sql.contains("FROM ALL_OBJECTS") {
                    result(&["OBJECT_ID", "STATUS"], vec![vec![json!(1), json!("VALID")]])
                } else {
                    result(
                        &["LINE", "POSITION", "TEXT", "ATTRIBUTE"],
                        vec![vec![json!(1), json!(2), json!("Unclassified diagnostic"), Value::Null]],
                    )
                }))
            })
            .await;
        assert_eq!(object.errors_read.state, TypeMetadataState::Incomplete);
    }

    #[tokio::test]
    async fn actor_identity_is_exact_and_an_unavailable_actor_cannot_restore_grants() {
        let (user, read) = acting_user(|sql| {
            assert_eq!(sql, "SELECT USER AS ACTING_USER FROM DUAL");
            std::future::ready(Ok(result(&["ACTING_USER"], vec![vec![json!("Mixed User")]])))
        })
        .await;
        assert_eq!(user.as_deref(), Some("Mixed User"));
        assert_eq!(read.state, TypeMetadataState::Available);
        let (user, read) = acting_user(|_| std::future::ready(Err("session unknown".into()))).await;
        assert_eq!(user, None);
        assert_eq!(read.state, TypeMetadataState::Unavailable);
    }

    #[tokio::test]
    async fn dameng_grants_resolve_the_original_grantor_without_guessing_numeric_ids() {
        let (grants, read) =
            direct_privileges(super::super::oracle_type_details::Dialect::Dameng, "APP", "ROOT", |sql| {
                assert!(sql.contains("GU.ID = G.GRANTOR"));
                std::future::ready(Ok(result(
                    &[
                        "URID",
                        "OBJID",
                        "COLID",
                        "PRIVID",
                        "GRANTOR",
                        "GRANTOR_NAME",
                        "GRANTABLE",
                        "GRANTEE",
                        "PRIVILEGE",
                        "PRIVILEGE_TYPE",
                    ],
                    vec![vec![
                        json!(7),
                        json!(11),
                        json!(-1),
                        json!(9001),
                        json!(5),
                        json!("APP"),
                        json!("Y"),
                        json!("ROLE_A"),
                        json!("EXECUTE"),
                        json!(2),
                    ]],
                )))
            })
            .await;
        assert_eq!(read.state, TypeMetadataState::Available);
        assert_eq!(grants[0].grantor.as_deref(), Some("APP"));
        assert_eq!(grants[0].grantable, Some(true));
    }

    #[tokio::test]
    async fn object_state_keeps_invalid_even_when_error_dictionary_is_empty() {
        let object =
            object_metadata(super::super::oracle_type_details::Dialect::OceanBase, "APP", "ROOT", "TYPE BODY", |sql| {
                let value = if sql.contains("FROM ALL_OBJECTS") {
                    result(&["OBJECT_ID", "STATUS"], vec![vec![json!(9007199254740993u64), json!("INVALID")]])
                } else {
                    result(&["LINE", "POSITION", "TEXT"], vec![])
                };
                std::future::ready(Ok(value))
            })
            .await;
        assert_eq!(object.exists, Some(true));
        assert_eq!(object.object_id.as_deref(), Some("9007199254740993"));
        assert_eq!(object.status.as_deref(), Some("INVALID"));
        assert!(object.errors.is_empty());
        assert_eq!(object.errors_read.state, TypeMetadataState::Available);
    }

    #[tokio::test]
    async fn object_state_reads_exact_body_errors_without_merging_the_specification() {
        let object = object_metadata(
            super::super::oracle_type_details::Dialect::Oracle,
            "O'wner",
            "Mixed Type",
            "TYPE BODY",
            |sql| {
                assert!(sql.contains("'O''wner'"));
                let value = if sql.contains("FROM ALL_OBJECTS") {
                    result(&["OBJECT_ID", "STATUS"], vec![vec![json!(8), json!("INVALID")]])
                } else {
                    assert!(sql.contains("TYPE='TYPE BODY'"));
                    result(
                        &["LINE", "POSITION", "TEXT", "ATTRIBUTE"],
                        vec![vec![json!(2), json!(74), json!("Identifier was not declared"), json!("ERROR")]],
                    )
                };
                std::future::ready(Ok(value))
            },
        )
        .await;
        assert_eq!(
            object.errors,
            vec![OracleTypeManagementError { line: 2, position: 74, text: "Identifier was not declared".into() }]
        );
    }

    #[tokio::test]
    async fn object_state_distinguishes_verified_absence_unknown_and_duplicate_identity() {
        for (value, expected_exists, expected_state) in [
            (Ok(result(&["OBJECT_ID", "STATUS"], vec![])), Some(false), TypeMetadataState::Available),
            (Err("No catalogue permission".to_string()), None, TypeMetadataState::Unavailable),
            (
                Ok(result(
                    &["OBJECT_ID", "STATUS"],
                    vec![vec![json!(1), json!("VALID")], vec![json!(2), json!("VALID")]],
                )),
                None,
                TypeMetadataState::Incomplete,
            ),
        ] {
            let mut calls = 0;
            let object =
                object_metadata(super::super::oracle_type_details::Dialect::Oracle, "APP", "ROOT", "TYPE", |_| {
                    calls += 1;
                    std::future::ready(value.clone())
                })
                .await;
            assert_eq!(object.exists, expected_exists);
            assert_eq!(object.status_read.state, expected_state);
            assert_eq!(calls, 1);
        }
    }

    #[tokio::test]
    async fn incomplete_dictionary_cells_or_pages_cannot_prove_an_object_state() {
        for (truncated, has_more, id) in
            [(true, false, json!(1)), (false, true, json!(1)), (false, false, json!({"preview":"1","truncated":true}))]
        {
            let mut value = result(&["OBJECT_ID", "STATUS"], vec![vec![id, json!("VALID")]]);
            value.truncated = truncated;
            value.has_more = has_more;
            let object =
                object_metadata(super::super::oracle_type_details::Dialect::Oracle, "APP", "ROOT", "TYPE", |_| {
                    std::future::ready(Ok(value.clone()))
                })
                .await;
            assert_eq!(object.exists, None);
            assert_eq!(object.status_read.state, TypeMetadataState::Incomplete);
        }
    }
}
