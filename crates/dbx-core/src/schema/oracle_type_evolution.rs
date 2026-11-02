//! Oracle 19c native evolution. The database performs the in-place conversion;
//! this reader proves the finite change, restrictions, phase and stable targets.
use super::{
    oracle_type_data::{checked, raw_metadata},
    oracle_type_management::Rows,
    sql_string,
};
use crate::db::{
    self, OracleTypeEvolutionManifest, OracleTypeEvolutionRequest, OracleTypeManagementSnapshot, TypeMetadataState,
};
use dbx_sql::oracle_type_migration_sql::{build_type_evolution_sql, EvolutionDataType, EvolutionShape};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashSet},
    future::Future,
};

pub(super) async fn read<F, Fut>(
    input: OracleTypeEvolutionRequest,
    snapshot: OracleTypeManagementSnapshot,
    mut run: F,
) -> Result<OracleTypeEvolutionManifest, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    if snapshot.target != input.target
        || snapshot.acting_user.as_deref() != Some(&input.target.owner)
        || [
            &snapshot.acting_user_read,
            &snapshot.dependencies_read,
            &snapshot.persistent_references_read,
            &snapshot.privileges_read,
        ]
        .iter()
        .any(|read| read.state != TypeMetadataState::Available)
        || snapshot.dependencies.iter().any(|edge| edge.referenced_link.is_some())
    {
        return Err("Native evolution requires the exact owner session and complete visible local dependencies, references and grants".into());
    }
    let target = &input.target;
    let plan = build_type_evolution_sql(&target.owner, &target.name, &input.source_before, &input.source_after)?;
    if plan.steps.is_empty() {
        return Err("The specification contains no supported native structural change; keep the current definition or revise the structural draft".into());
    }
    let statements: Vec<_> = plan.steps.iter().map(|step| step.sql.clone()).collect();
    if let Some(previous) = &input.manifest {
        if previous.target != *target
            || previous.source_before != input.source_before
            || previous.source_after != input.source_after
            || previous.statements != statements
            || previous.phase > statements.len()
        {
            return Err("The original native evolution target, definitions or phase record changed".into());
        }
    }
    let version = Rows::new(
        run("SELECT VERSION FROM PRODUCT_COMPONENT_VERSION WHERE PRODUCT LIKE 'Oracle Database%'".into()).await,
        &["VERSION"],
    );
    checked(&version)?;
    if version.rows.len() != 1 || !text(&version, &version.rows[0], "VERSION")?.starts_with("19.") {
        return Err("This bounded native evolution route requires verified Oracle Database 19c metadata".into());
    }
    let root = snapshot
        .objects
        .iter()
        .find(|object| object.owner == target.owner && object.name == target.name && object.object_type == "TYPE")
        .ok_or("The original TYPE identity is missing")?;
    if root.exists != Some(true)
        || root.status.as_deref() != Some("VALID")
        || !root.errors.is_empty()
        || [&root.status_read, &root.source_read, &root.errors_read]
            .iter()
            .any(|read| read.state != TypeMetadataState::Available)
    {
        return Err(
            "Read back the complete valid TYPE specification and compilation state before native evolution".into()
        );
    }
    let actual_source = root.source.as_deref().ok_or("The complete current TYPE source is missing")?;
    // Native DDL may leave a previous source rendering. Both the immutable
    // signature and any rendered structural changes must still be approved;
    // the current stage itself is proved by the actual attribute dictionary.
    let rendered = build_type_evolution_sql(&target.owner, &target.name, &input.source_before, actual_source)?;
    if rendered.steps.iter().any(|step| !statements.contains(&step.sql)) {
        return Err("The live TYPE source contains a structural change outside the approved native phases".into());
    }
    let mut types: BTreeSet<_> = snapshot
        .objects
        .iter()
        .filter(|object| object.object_type == "TYPE" && object.exists == Some(true))
        .map(|object| (object.owner.clone(), object.name.clone()))
        .collect();
    types.insert((target.owner.clone(), target.name.clone()));
    let mut metadata = vec![raw_metadata(&version)];
    let mut phase = None;
    let mut varray_types = BTreeSet::new();
    for (owner, name) in &types {
        if owner != &target.owner {
            return Err("A cross-owner dependent TYPE needs its own verified evolution plan".into());
        }
        let is_root = name == &target.name;
        let state = type_state(owner, name, &mut run).await?;
        if state
            .collection
            .as_ref()
            .is_some_and(|rows| rows.text(&rows.rows[0], "COLL_TYPE").as_deref() == Some("VARYING ARRAY"))
        {
            varray_types.insert((owner.clone(), name.clone()));
        }
        if is_root {
            for (index, shape) in
                std::iter::once(&plan.before).chain(plan.steps.iter().map(|step| &step.after)).enumerate()
            {
                if state.matches(shape)? && phase.replace(index).is_some() {
                    return Err("The native evolution phase is ambiguous".into());
                }
            }
        }
        metadata.push(json!([owner, name, state.fixed(is_root)]));
    }
    let phase = phase.ok_or("The actual TYPE dictionary does not match an approved native evolution phase")?;
    if input.manifest.is_none() && phase != 0 {
        return Err(
            "Register native guards before the first structural change; do not adopt a new original baseline".into()
        );
    }
    if phase == 0 {
        use dbx_sql::object_source_sql::{build_oracle_type_management_source, EditableObjectSourceSqlInput};
        let fingerprint = |source: &str| {
            build_oracle_type_management_source(EditableObjectSourceSqlInput {
                database_type: super::DatabaseType::Oracle,
                object_type: db::ObjectSourceKind::Type,
                schema: Some(target.owner.clone()),
                name: target.name.clone(),
                source: source.into(),
            })
            .map(|(_, fingerprint)| fingerprint)
        };
        if fingerprint(actual_source)? != fingerprint(&input.source_before)? {
            return Err("The original native TYPE definition changed before dispatch".into());
        }
    }
    let mut tables: BTreeSet<_> =
        snapshot.persistent_references.iter().map(|r| (r.owner.clone(), r.table_name.clone())).collect();
    tables.extend(
        snapshot
            .dependencies
            .iter()
            .filter(|edge| edge.object_type == "TABLE")
            .map(|edge| (edge.owner.clone(), edge.name.clone())),
    );
    for (owner, name) in tables {
        if owner != target.owner {
            return Err("A cross-owner stored table needs its own verified preparation plan".into());
        }
        metadata.push(table_guard(&owner, &name, &varray_types, &snapshot, &mut run).await?);
    }
    let mut edges: Vec<_> = snapshot
        .dependencies
        .iter()
        .filter(|edge| ["TYPE", "TABLE"].contains(&edge.object_type.as_str()))
        .map(|edge| serde_json::to_string(edge).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    edges.sort();
    metadata.push(json!(edges));
    let mut refs: Vec<_> = snapshot
        .persistent_references
        .iter()
        .map(|r| serde_json::to_string(r).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    refs.sort();
    metadata.push(json!(refs));
    let mut type_grants = Vec::new();
    for object in snapshot.objects.iter().filter(|object| object.object_type == "TYPE" && object.exists == Some(true)) {
        if object.privileges_read.state != TypeMetadataState::Available {
            return Err("Read the complete direct TYPE grants before native evolution".into());
        }
        let mut grants: Vec<_> = object
            .direct_privileges
            .iter()
            .map(|g| serde_json::to_string(g).map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?;
        grants.sort();
        type_grants.push(json!([object.owner, object.name, grants]));
    }
    type_grants.sort_by_key(Value::to_string);
    metadata.push(json!(type_grants));
    let metadata = serde_json::to_string(&metadata).map_err(|e| e.to_string())?;
    if input.manifest.as_ref().is_some_and(|original| original.metadata != metadata) {
        return Err("The native evolution table identity, row count, grants or restrictions changed. Keep the original guards and reconcile the actual objects".into());
    }
    Ok(OracleTypeEvolutionManifest {
        target: input.target,
        source_before: input.source_before,
        source_after: input.source_after,
        statements,
        metadata,
        phase,
    })
}

fn text(rows: &Rows, row: &[Value], name: &str) -> Result<String, String> {
    rows.text(row, name).ok_or_else(|| format!("Native evolution cannot verify {name}"))
}
fn dimension(rows: &Rows, row: &[Value], name: &str) -> Result<Option<i32>, String> {
    rows.value(row, name)
        .map(|_| text(rows, row, name)?.parse::<i32>().map_err(|_| format!("Native evolution has unknown {name}")))
        .transpose()
}
fn exact_type(rows: &Rows, row: &[Value], prefix: &str, expected: &EvolutionDataType) -> Result<bool, String> {
    if rows.value(row, &format!("{prefix}_TYPE_MOD")).is_some() {
        return Ok(false);
    }
    let owner = rows.text(row, &format!("{prefix}_TYPE_OWNER"));
    let name = text(rows, row, &format!("{prefix}_TYPE_NAME"))?;
    Ok(match expected {
        EvolutionDataType::Named { owner: expected_owner, name: expected_name } => {
            owner.as_ref() == Some(expected_owner) && name == *expected_name
        }
        EvolutionDataType::Scalar(ty) if owner.is_none() && name == ty.name => match ty.name.as_str() {
            "NUMBER" => dimension(rows, row, "PRECISION")? == ty.size && dimension(rows, row, "SCALE")? == ty.scale,
            "VARCHAR2" => {
                rows.text(row, "CHAR_USED").as_deref() == Some("B")
                    && ty.semantics.as_deref().is_none_or(|s| s == "BYTE")
                    && dimension(rows, row, "LENGTH")? == ty.size
            }
            "RAW" => dimension(rows, row, "LENGTH")? == ty.size,
            "DATE" => true,
            _ => false,
        },
        _ => false,
    })
}
struct TypeState {
    identity: Rows,
    properties: Rows,
    attributes: Rows,
    collection: Option<Rows>,
    methods: Rows,
    parameters: Rows,
    results: Rows,
}
impl TypeState {
    fn matches(&self, shape: &EvolutionShape) -> Result<bool, String> {
        if let Some((limit, element)) = &shape.varray {
            let Some(collection) = &self.collection else { return Ok(false) };
            return Ok(collection.rows.len() == 1
                && collection.text(&collection.rows[0], "COLL_TYPE").as_deref() == Some("VARYING ARRAY")
                && dimension(collection, &collection.rows[0], "UPPER_BOUND")? == Some(*limit)
                && exact_type(collection, &collection.rows[0], "ELEM", element)?);
        }
        if self.collection.is_some() || self.attributes.rows.len() != shape.attributes.len() {
            return Ok(false);
        }
        for (index, ((name, ty), row)) in shape.attributes.iter().zip(&self.attributes.rows).enumerate() {
            if self.attributes.text(row, "ATTR_NAME").as_deref() != Some(name)
                || dimension(&self.attributes, row, "ATTR_NO")? != Some(index as i32 + 1)
                || self.attributes.yes_no(row, "INHERITED") != Some(false)
                || !exact_type(&self.attributes, row, "ATTR", ty)?
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
    fn fixed(&self, root: bool) -> Value {
        let properties: Vec<_> = self
            .properties
            .columns
            .iter()
            .enumerate()
            .filter(|(_, name)| !root || !name.eq_ignore_ascii_case("ATTRIBUTES"))
            .map(|(index, name)| (name, self.properties.rows[0][index].clone()))
            .collect();
        json!([
            raw_metadata(&self.identity),
            properties,
            if root { Value::Null } else { raw_metadata(&self.attributes) },
            if root { Value::Null } else { self.collection.as_ref().map(raw_metadata).unwrap_or(Value::Null) },
            raw_metadata(&self.methods),
            raw_metadata(&self.parameters),
            raw_metadata(&self.results)
        ])
    }
}
async fn type_state<F, Fut>(owner: &str, name: &str, run: &mut F) -> Result<TypeState, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let predicate = format!("OWNER={} AND TYPE_NAME={}", sql_string(owner), sql_string(name));
    let identity = object_identity(owner, name, "TYPE", run).await?;
    let properties=Rows::new(run(format!("SELECT TYPECODE, ATTRIBUTES, METHODS, FINAL, INSTANTIABLE, PREDEFINED, INCOMPLETE, SUPERTYPE_OWNER, SUPERTYPE_NAME FROM ALL_TYPES WHERE {predicate}")).await,&["TYPECODE","ATTRIBUTES","METHODS","FINAL","INSTANTIABLE","PREDEFINED","INCOMPLETE","SUPERTYPE_OWNER","SUPERTYPE_NAME"]);
    checked(&properties)?;
    if properties.rows.len() != 1 {
        return Err("The complete native TYPE identity could not be read".into());
    }
    let row = &properties.rows[0];
    let kind = text(&properties, row, "TYPECODE")?;
    if !["OBJECT", "COLLECTION"].contains(&kind.as_str())
        || properties.yes_no(row, "PREDEFINED") != Some(false)
        || properties.yes_no(row, "INCOMPLETE") != Some(false)
        || properties.value(row, "SUPERTYPE_OWNER").is_some()
        || properties.value(row, "SUPERTYPE_NAME").is_some()
        || (kind == "OBJECT"
            && (properties.yes_no(row, "FINAL") != Some(true) || properties.yes_no(row, "INSTANTIABLE") != Some(true)))
    {
        return Err("Native evolution needs complete final non-inherited user types; inheritance or unknown type properties require preparation".into());
    }
    let attributes=Rows::new(run(format!("SELECT ATTR_NAME, ATTR_NO, ATTR_TYPE_MOD, ATTR_TYPE_OWNER, ATTR_TYPE_NAME, LENGTH, PRECISION, SCALE, CHAR_USED, INHERITED FROM ALL_TYPE_ATTRS WHERE {predicate} ORDER BY ATTR_NO")).await,&["ATTR_NAME","ATTR_NO","ATTR_TYPE_MOD","ATTR_TYPE_OWNER","ATTR_TYPE_NAME","LENGTH","PRECISION","SCALE","CHAR_USED","INHERITED"]);
    checked(&attributes)?;
    if dimension(&properties, row, "ATTRIBUTES")? != Some(attributes.rows.len() as i32) {
        return Err("The native attribute dictionary is incomplete".into());
    }
    let collection = if kind == "COLLECTION" {
        let rows=Rows::new(run(format!("SELECT COLL_TYPE, UPPER_BOUND, ELEM_TYPE_MOD, ELEM_TYPE_OWNER, ELEM_TYPE_NAME, LENGTH, PRECISION, SCALE, CHAR_USED FROM ALL_COLL_TYPES WHERE {predicate}")).await,&["COLL_TYPE","UPPER_BOUND","ELEM_TYPE_MOD","ELEM_TYPE_OWNER","ELEM_TYPE_NAME","LENGTH","PRECISION","SCALE","CHAR_USED"]);
        checked(&rows)?;
        if rows.rows.len() != 1 {
            return Err("The complete collection definition is unknown".into());
        }
        Some(rows)
    } else {
        None
    };
    let methods = Rows::new(
        run(format!("SELECT * FROM ALL_TYPE_METHODS WHERE {predicate}")).await,
        &[
            "METHOD_NAME",
            "METHOD_NO",
            "METHOD_TYPE",
            "PARAMETERS",
            "RESULTS",
            "FINAL",
            "INSTANTIABLE",
            "OVERRIDING",
            "INHERITED",
        ],
    );
    checked(&methods)?;
    let parameters = Rows::new(
        run(format!("SELECT * FROM ALL_METHOD_PARAMS WHERE {predicate}")).await,
        &["METHOD_NAME", "METHOD_NO", "PARAM_NAME", "PARAM_NO", "PARAM_MODE", "PARAM_TYPE_OWNER", "PARAM_TYPE_NAME"],
    );
    checked(&parameters)?;
    let results = Rows::new(
        run(format!("SELECT * FROM ALL_METHOD_RESULTS WHERE {predicate}")).await,
        &["METHOD_NAME", "METHOD_NO", "RESULT_TYPE_OWNER", "RESULT_TYPE_NAME"],
    );
    checked(&results)?;
    if dimension(&properties, row, "METHODS")? != Some(methods.rows.len() as i32) {
        return Err("The native method dictionary is incomplete".into());
    }
    let method_key = |rows: &Rows, row: &[Value]| -> Result<_, String> {
        Ok((text(rows, row, "METHOD_NAME")?, dimension(rows, row, "METHOD_NO")?.ok_or("Unknown method number")?))
    };
    let mut method_keys = HashSet::new();
    for row in &methods.rows {
        let key = method_key(&methods, row)?;
        if !method_keys.insert(key.clone()) {
            return Err("The native method identity is ambiguous".into());
        }
        for (rows, column) in [(&parameters, "PARAMETERS"), (&results, "RESULTS")] {
            let count = rows.rows.iter().filter(|row| method_key(rows, row).as_ref() == Ok(&key)).count();
            if dimension(&methods, row, column)? != Some(count as i32) {
                return Err("The complete native method signatures could not be verified".into());
            }
        }
    }
    let mut parameters_seen = HashSet::new();
    let mut results_seen = HashSet::new();
    for row in &parameters.rows {
        let key = method_key(&parameters, row)?;
        if !method_keys.contains(&key)
            || !parameters_seen
                .insert((key, dimension(&parameters, row, "PARAM_NO")?.ok_or("Unknown parameter position")?))
        {
            return Err("The native parameter list has an unknown or repeated identity".into());
        }
        text(&parameters, row, "PARAM_MODE")?;
        text(&parameters, row, "PARAM_TYPE_NAME")?;
    }
    for row in &results.rows {
        let key = method_key(&results, row)?;
        if !method_keys.contains(&key) || !results_seen.insert(key) {
            return Err("The native result signature has an unknown or repeated identity".into());
        }
        text(&results, row, "RESULT_TYPE_NAME")?;
    }
    Ok(TypeState { identity, properties, attributes, collection, methods, parameters, results })
}
async fn object_identity<F, Fut>(owner: &str, name: &str, kind: &str, run: &mut F) -> Result<Rows, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let rows=Rows::new(run(format!("SELECT TO_CHAR(OBJECT_ID) AS OBJECT_ID, EDITION_NAME, ORACLE_MAINTAINED FROM ALL_OBJECTS WHERE OWNER={} AND OBJECT_NAME={} AND OBJECT_TYPE={} AND SUBOBJECT_NAME IS NULL",sql_string(owner),sql_string(name),sql_string(kind))).await,&["OBJECT_ID","EDITION_NAME","ORACLE_MAINTAINED"]);
    checked(&rows)?;
    if rows.rows.len() != 1
        || rows.value(&rows.rows[0], "OBJECT_ID").is_none()
        || rows.value(&rows.rows[0], "EDITION_NAME").is_some()
        || rows.yes_no(&rows.rows[0], "ORACLE_MAINTAINED") != Some(false)
    {
        return Err("The exact non-editioned, non-system object identity is not verified".into());
    }
    Ok(rows)
}
async fn table_guard<F, Fut>(
    owner: &str,
    name: &str,
    varray_types: &BTreeSet<(String, String)>,
    snapshot: &OracleTypeManagementSnapshot,
    run: &mut F,
) -> Result<Value, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let predicate = format!("OWNER={} AND TABLE_NAME={}", sql_string(owner), sql_string(name));
    let identity = object_identity(owner, name, "TABLE", run).await?;
    let tables=Rows::new(run(format!("SELECT TABLE_NAME, TEMPORARY, NESTED, IOT_TYPE, CLUSTER_NAME, PARTITIONED, READ_ONLY, STATUS, TABLESPACE_NAME FROM ALL_TABLES WHERE {predicate}")).await,&["TABLE_NAME","TEMPORARY","NESTED","IOT_TYPE","CLUSTER_NAME","PARTITIONED","READ_ONLY","STATUS","TABLESPACE_NAME"]);
    checked(&tables)?;
    if tables.rows.len() != 1 {
        return Err("The stored table identity is unknown".into());
    }
    let row = &tables.rows[0];
    if tables.yes_no(row, "TEMPORARY") != Some(false)
        || tables.yes_no(row, "NESTED") != Some(false)
        || tables.yes_no(row, "PARTITIONED") != Some(false)
        || tables.yes_no(row, "READ_ONLY") != Some(false)
        || tables.value(row, "IOT_TYPE").is_some()
        || tables.value(row, "CLUSTER_NAME").is_some()
        || tables.text(row, "STATUS").as_deref() != Some("VALID")
    {
        return Err(format!("{owner}.{name}: partitioned, clustered, IOT, nested, temporary, read-only or unknown tables need explicit preparation"));
    }
    for catalogue in ["ALL_EXTERNAL_TABLES", "ALL_OBJECT_TABLES"] {
        let rows =
            Rows::new(run(format!("SELECT TABLE_NAME FROM {catalogue} WHERE {predicate}")).await, &["TABLE_NAME"]);
        checked(&rows)?;
        if !rows.rows.is_empty() {
            return Err("External and object tables need explicit verified preparation".into());
        }
    }
    let columns = Rows::new(
        run(format!("SELECT * FROM ALL_TAB_COLS WHERE {predicate} ORDER BY COLUMN_ID")).await,
        &[
            "COLUMN_NAME",
            "COLUMN_ID",
            "DATA_TYPE_OWNER",
            "DATA_TYPE",
            "DATA_LENGTH",
            "DATA_PRECISION",
            "DATA_SCALE",
            "CHAR_USED",
            "CHAR_LENGTH",
            "NULLABLE",
            "HIDDEN_COLUMN",
            "USER_GENERATED",
            "VIRTUAL_COLUMN",
        ],
    );
    checked(&columns)?;
    let mut user_columns = Vec::new();
    let mut names = HashSet::new();
    for row in &columns.rows {
        if columns.yes_no(row, "HIDDEN_COLUMN") == Some(true) && columns.yes_no(row, "USER_GENERATED") == Some(false) {
            continue;
        }
        if columns.yes_no(row, "HIDDEN_COLUMN").is_none()
            || columns.yes_no(row, "USER_GENERATED") != Some(true)
            || columns.yes_no(row, "VIRTUAL_COLUMN") != Some(false)
        {
            return Err("Unknown or virtual stored columns need explicit preparation".into());
        }
        let name = text(&columns, row, "COLUMN_NAME")?;
        if !names.insert(name.clone()) {
            return Err("The stored column identity is ambiguous".into());
        }
        let user_type = columns.value(row, "DATA_TYPE_OWNER").is_some();
        let definition: Vec<_> = columns
            .columns
            .iter()
            .enumerate()
            .filter(|(_, name)| {
                [
                    "COLUMN_NAME",
                    "COLUMN_ID",
                    "DATA_TYPE_OWNER",
                    "DATA_TYPE",
                    "NULLABLE",
                    "HIDDEN_COLUMN",
                    "USER_GENERATED",
                    "VIRTUAL_COLUMN",
                    "DATA_DEFAULT",
                    "DEFAULT_ON_NULL",
                    "IDENTITY_COLUMN",
                    "COLLATION",
                ]
                .iter()
                .any(|wanted| name.eq_ignore_ascii_case(wanted))
                    || (!user_type
                        && ["DATA_LENGTH", "DATA_PRECISION", "DATA_SCALE", "CHAR_USED", "CHAR_LENGTH"]
                            .iter()
                            .any(|wanted| name.eq_ignore_ascii_case(wanted)))
            })
            .map(|(index, name)| (name, row[index].clone()))
            .collect();
        user_columns.push(json!(definition));
    }
    if user_columns.is_empty() {
        return Err("The complete stored-column definition is missing".into());
    }
    for reference in snapshot.persistent_references.iter().filter(|r| r.owner == owner && r.table_name == name) {
        let column = reference.column_name.as_deref().ok_or("The exact stored UDT column is unknown")?;
        if !columns.rows.iter().any(|row| {
            columns.text(row, "COLUMN_NAME").as_deref() == Some(column)
                && columns.text(row, "DATA_TYPE_OWNER") == reference.data_type_owner
                && columns.text(row, "DATA_TYPE") == reference.data_type
        }) {
            return Err("The registered stored UDT reference changed".into());
        }
    }
    let indexes = Rows::new(
        run(format!(
            "SELECT INDEX_NAME, INDEX_TYPE, STATUS FROM ALL_INDEXES WHERE TABLE_OWNER={} AND TABLE_NAME={}",
            sql_string(owner),
            sql_string(name)
        ))
        .await,
        &["INDEX_NAME", "INDEX_TYPE", "STATUS"],
    );
    checked(&indexes)?;
    for row in &indexes.rows {
        if !matches!(indexes.text(row, "INDEX_TYPE").as_deref(), Some("NORMAL" | "NORMAL/REV" | "BITMAP" | "LOB"))
            || indexes.text(row, "STATUS").as_deref() != Some("VALID")
        {
            return Err(
                "A function/domain, unusable or unknown attribute index requires a separate verified plan".into()
            );
        }
    }
    let indexed_columns=Rows::new(run(format!("SELECT INDEX_NAME, COLUMN_NAME, COLUMN_POSITION FROM ALL_IND_COLUMNS WHERE TABLE_OWNER={} AND TABLE_NAME={}",sql_string(owner),sql_string(name))).await,&["INDEX_NAME","COLUMN_NAME","COLUMN_POSITION"]);
    checked(&indexed_columns)?;
    let varrays = Rows::new(
        run(format!(
            "SELECT TYPE_OWNER, TYPE_NAME, LOB_NAME FROM ALL_VARRAYS WHERE OWNER={} AND PARENT_TABLE_NAME={}",
            sql_string(owner),
            sql_string(name)
        ))
        .await,
        &["TYPE_OWNER", "TYPE_NAME", "LOB_NAME"],
    );
    checked(&varrays)?;
    let mut needed_varrays = BTreeSet::new();
    let mut seen = HashSet::new();
    let mut pending: Vec<_> = snapshot
        .persistent_references
        .iter()
        .filter(|r| r.owner == owner && r.table_name == name)
        .filter_map(|r| Some((r.data_type_owner.clone()?, r.data_type.clone()?)))
        .collect();
    while let Some(key) = pending.pop() {
        if !seen.insert(key.clone()) {
            continue;
        }
        if varray_types.contains(&key) {
            needed_varrays.insert(key.clone());
        }
        pending.extend(
            snapshot
                .dependencies
                .iter()
                .filter(|edge| {
                    edge.object_type == "TYPE"
                        && edge.owner == key.0
                        && edge.name == key.1
                        && edge.referenced_type == "TYPE"
                })
                .map(|edge| (edge.referenced_owner.clone(), edge.referenced_name.clone())),
        );
    }
    for key in &needed_varrays {
        if !varrays.rows.iter().any(|row| {
            varrays.text(row, "TYPE_OWNER").as_ref() == Some(&key.0)
                && varrays.text(row, "TYPE_NAME").as_ref() == Some(&key.1)
        }) {
            return Err("The complete affected VARRAY storage definition is unavailable".into());
        }
    }
    for row in &varrays.rows {
        if needed_varrays.contains(&(text(&varrays, row, "TYPE_OWNER")?, text(&varrays, row, "TYPE_NAME")?))
            && varrays.value(row, "LOB_NAME").is_none()
        {
            return Err("An inline VARRAY may require a physical LOB storage transition; prepare that storage explicitly before native evolution".into());
        }
    }
    let lobs = Rows::new(
        run(format!("SELECT SEGMENT_NAME, TABLESPACE_NAME, COLUMN_NAME FROM ALL_LOBS WHERE {predicate}")).await,
        &["SEGMENT_NAME", "TABLESPACE_NAME", "COLUMN_NAME"],
    );
    checked(&lobs)?;
    for row in &varrays.rows {
        if needed_varrays.contains(&(text(&varrays, row, "TYPE_OWNER")?, text(&varrays, row, "TYPE_NAME")?))
            && !lobs.rows.iter().any(|lob| lobs.text(lob, "SEGMENT_NAME") == varrays.text(row, "LOB_NAME"))
        {
            return Err("The affected VARRAY LOB and its tablespace could not be verified".into());
        }
    }
    let mut spaces = BTreeSet::from([text(&tables, &tables.rows[0], "TABLESPACE_NAME")?]);
    for row in &lobs.rows {
        spaces.insert(text(&lobs, row, "TABLESPACE_NAME")?);
    }
    let spaces = Rows::new(
        run(format!(
            "SELECT TABLESPACE_NAME, STATUS FROM USER_TABLESPACES WHERE TABLESPACE_NAME IN ({})",
            spaces.iter().map(|name| sql_string(name)).collect::<Vec<_>>().join(", ")
        ))
        .await,
        &["TABLESPACE_NAME", "STATUS"],
    );
    checked(&spaces)?;
    if spaces.rows.is_empty() || spaces.rows.iter().any(|row| spaces.text(row, "STATUS").as_deref() != Some("ONLINE")) {
        return Err("Every data/LOB tablespace must have a verified read/write ONLINE state".into());
    }
    let required_spaces: BTreeSet<_> = std::iter::once(text(&tables, &tables.rows[0], "TABLESPACE_NAME")?)
        .chain(lobs.rows.iter().map(|row| text(&lobs, row, "TABLESPACE_NAME")).collect::<Result<Vec<_>, _>>()?)
        .collect();
    let observed_spaces: BTreeSet<_> =
        spaces.rows.iter().map(|row| text(&spaces, row, "TABLESPACE_NAME")).collect::<Result<_, _>>()?;
    if required_spaces != observed_spaces || spaces.rows.len() != required_spaces.len() {
        return Err("A required data/LOB tablespace state is missing or ambiguous".into());
    }
    let count = Rows::new(
        run(format!(
            "SELECT TO_CHAR(COUNT(*)) AS ROW_COUNT FROM \"{}\".\"{}\"",
            owner.replace('"', "\"\""),
            name.replace('"', "\"\"")
        ))
        .await,
        &["ROW_COUNT"],
    );
    checked(&count)?;
    if count.rows.len() != 1 || !text(&count, &count.rows[0], "ROW_COUNT")?.bytes().all(|b| b.is_ascii_digit()) {
        return Err("The complete native table row count is unknown".into());
    }
    let grants = Rows::new(
        run(format!(
            "SELECT * FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA={} AND TABLE_NAME={}",
            sql_string(owner),
            sql_string(name)
        ))
        .await,
        &["TABLE_NAME", "GRANTEE", "GRANTOR", "PRIVILEGE", "GRANTABLE"],
    );
    checked(&grants)?;
    Ok(json!([
        owner,
        name,
        raw_metadata(&identity),
        raw_metadata(&tables),
        user_columns,
        raw_metadata(&indexes),
        raw_metadata(&indexed_columns),
        raw_metadata(&varrays),
        raw_metadata(&lobs),
        raw_metadata(&spaces),
        raw_metadata(&count),
        raw_metadata(&grants)
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};
    const BEFORE: &str = "CREATE OR REPLACE TYPE APP.ROOT AS OBJECT (ID NUMBER(8,0));";
    const AFTER: &str = "CREATE OR REPLACE TYPE APP.ROOT AS OBJECT (ID NUMBER(10,0), EXTRA RAW(16));";

    #[derive(Default)]
    struct Fixture {
        phase: usize,
        forbidden: Option<&'static str>,
        table_id: &'static str,
        rows: u32,
        varray: bool,
    }
    fn result(columns: &[&str], rows: Vec<Vec<Value>>) -> Result<db::QueryResult, String> {
        Ok(serde_json::from_value(json!({"columns":columns,"rows":rows,"affected_rows":0,"execution_time_ms":0}))
            .unwrap())
    }
    fn request(manifest: Option<OracleTypeEvolutionManifest>) -> OracleTypeEvolutionRequest {
        OracleTypeEvolutionRequest {
            target: db::OracleTypeManagementTarget {
                connection_id: "native".into(),
                database: "db".into(),
                owner: "APP".into(),
                name: "ROOT".into(),
            },
            source_before: BEFORE.into(),
            source_after: AFTER.into(),
            manifest,
        }
    }
    fn snapshot() -> OracleTypeManagementSnapshot {
        serde_json::from_value(json!({"target":request(None).target,"visibilityScope":"current-user-visible-dictionaries","actingUser":"APP","actingUserRead":{"state":"available"},"detailsRead":{"state":"available"},"typeSourceRead":{"state":"available"},"bodySourceRead":{"state":"available"},"objects":[{"owner":"APP","name":"ROOT","objectType":"TYPE","exists":true,"objectId":"11","status":"VALID","statusRead":{"state":"available"},"source":BEFORE,"sourceRead":{"state":"available"},"errors":[],"errorsRead":{"state":"available"},"directPrivileges":[],"privilegesRead":{"state":"available"}}],"dependencies":[{"owner":"APP","name":"DATA","objectType":"TABLE","referencedOwner":"APP","referencedName":"ROOT","referencedType":"TYPE","referencedLink":null}],"dependenciesRead":{"state":"available"},"persistentReferences":[{"owner":"APP","tableName":"DATA","columnName":"VALUE","dataTypeOwner":"APP","dataType":"ROOT","tableStatus":"VALID","tableReadOnly":false}],"persistentReferencesRead":{"state":"available"},"directPrivileges":[],"privilegesRead":{"state":"available"}})).unwrap()
    }
    fn query(f: &Fixture, sql: &str) -> Result<db::QueryResult, String> {
        assert!(!sql.contains("DBA_") && !sql.starts_with("ALTER") && !sql.starts_with("DROP"));
        if f.forbidden == Some("truncated") && sql.contains("ALL_TYPES") {
            let mut value = result(&["TYPECODE"], vec![])?;
            value.truncated = true;
            return Ok(value);
        }
        if sql.contains("PRODUCT_COMPONENT_VERSION") {
            return result(
                &["VERSION"],
                vec![vec![json!(if f.forbidden == Some("version") { "12.1.0.2" } else { "19.0.0.0.0" })]],
            );
        }
        if sql.contains("ALL_OBJECTS") {
            let id = if sql.contains("OBJECT_TYPE='TABLE'") {
                if f.table_id.is_empty() {
                    "22"
                } else {
                    f.table_id
                }
            } else {
                "11"
            };
            return result(
                &["OBJECT_ID", "EDITION_NAME", "ORACLE_MAINTAINED"],
                vec![vec![
                    json!(id),
                    if f.forbidden == Some("edition") { json!("EDITION_X") } else { Value::Null },
                    json!("N"),
                ]],
            );
        }
        if sql.contains("ALL_TYPES") {
            return result(
                &[
                    "TYPECODE",
                    "ATTRIBUTES",
                    "METHODS",
                    "FINAL",
                    "INSTANTIABLE",
                    "PREDEFINED",
                    "INCOMPLETE",
                    "SUPERTYPE_OWNER",
                    "SUPERTYPE_NAME",
                ],
                vec![vec![
                    json!(if f.varray { "COLLECTION" } else { "OBJECT" }),
                    json!(if f.varray {
                        0
                    } else if f.phase == 2 {
                        2
                    } else {
                        1
                    }),
                    json!(0),
                    json!(if f.forbidden == Some("inheritance") { "NO" } else { "YES" }),
                    json!("YES"),
                    json!("NO"),
                    json!("NO"),
                    Value::Null,
                    Value::Null,
                ]],
            );
        }
        if sql.contains("ALL_TYPE_ATTRS") {
            let mut rows = vec![vec![
                json!("ID"),
                json!(1),
                Value::Null,
                Value::Null,
                json!("NUMBER"),
                Value::Null,
                json!(if f.phase > 0 { 10 } else { 8 }),
                json!(0),
                Value::Null,
                json!("NO"),
            ]];
            if f.phase == 2 {
                rows.push(vec![
                    json!("EXTRA"),
                    json!(2),
                    Value::Null,
                    Value::Null,
                    json!("RAW"),
                    json!(16),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    json!("NO"),
                ]);
            }
            return result(
                &[
                    "ATTR_NAME",
                    "ATTR_NO",
                    "ATTR_TYPE_MOD",
                    "ATTR_TYPE_OWNER",
                    "ATTR_TYPE_NAME",
                    "LENGTH",
                    "PRECISION",
                    "SCALE",
                    "CHAR_USED",
                    "INHERITED",
                ],
                if f.varray { vec![] } else { rows },
            );
        }
        if sql.contains("ALL_COLL_TYPES") {
            return result(
                &[
                    "COLL_TYPE",
                    "UPPER_BOUND",
                    "ELEM_TYPE_MOD",
                    "ELEM_TYPE_OWNER",
                    "ELEM_TYPE_NAME",
                    "LENGTH",
                    "PRECISION",
                    "SCALE",
                    "CHAR_USED",
                ],
                vec![vec![
                    json!("VARYING ARRAY"),
                    json!(if f.phase == 0 { 10 } else { 30 }),
                    Value::Null,
                    Value::Null,
                    json!("NUMBER"),
                    Value::Null,
                    json!(8),
                    json!(0),
                    Value::Null,
                ]],
            );
        }
        if sql.contains("ALL_TYPE_METHODS") {
            return result(
                &[
                    "METHOD_NAME",
                    "METHOD_NO",
                    "METHOD_TYPE",
                    "PARAMETERS",
                    "RESULTS",
                    "FINAL",
                    "INSTANTIABLE",
                    "OVERRIDING",
                    "INHERITED",
                ],
                vec![],
            );
        }
        if sql.contains("ALL_METHOD_PARAMS") {
            return result(
                &[
                    "METHOD_NAME",
                    "METHOD_NO",
                    "PARAM_NAME",
                    "PARAM_NO",
                    "PARAM_MODE",
                    "PARAM_TYPE_OWNER",
                    "PARAM_TYPE_NAME",
                ],
                vec![],
            );
        }
        if sql.contains("ALL_METHOD_RESULTS") {
            return result(&["METHOD_NAME", "METHOD_NO", "RESULT_TYPE_OWNER", "RESULT_TYPE_NAME"], vec![]);
        }
        if sql.contains("ALL_TABLES") {
            return result(
                &[
                    "TABLE_NAME",
                    "TEMPORARY",
                    "NESTED",
                    "IOT_TYPE",
                    "CLUSTER_NAME",
                    "PARTITIONED",
                    "READ_ONLY",
                    "STATUS",
                    "TABLESPACE_NAME",
                ],
                vec![vec![
                    json!("DATA"),
                    json!("N"),
                    json!("NO"),
                    Value::Null,
                    if f.forbidden == Some("cluster") { json!("C") } else { Value::Null },
                    json!(if f.forbidden == Some("partition") { "YES" } else { "NO" }),
                    json!("NO"),
                    json!("VALID"),
                    json!("USERS"),
                ]],
            );
        }
        if sql.contains("ALL_EXTERNAL_TABLES") || sql.contains("ALL_OBJECT_TABLES") {
            return result(&["TABLE_NAME"], vec![]);
        }
        if sql.contains("ALL_TAB_COLS") {
            return result(
                &[
                    "COLUMN_NAME",
                    "COLUMN_ID",
                    "DATA_TYPE_OWNER",
                    "DATA_TYPE",
                    "DATA_LENGTH",
                    "DATA_PRECISION",
                    "DATA_SCALE",
                    "CHAR_USED",
                    "CHAR_LENGTH",
                    "NULLABLE",
                    "HIDDEN_COLUMN",
                    "USER_GENERATED",
                    "VIRTUAL_COLUMN",
                ],
                vec![vec![
                    json!("VALUE"),
                    json!(1),
                    json!("APP"),
                    json!("ROOT"),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    json!("Y"),
                    json!("NO"),
                    json!("YES"),
                    json!("NO"),
                ]],
            );
        }
        if sql.contains("ALL_INDEXES") {
            return result(
                &["INDEX_NAME", "INDEX_TYPE", "STATUS"],
                if f.forbidden == Some("index") {
                    vec![vec![json!("FX"), json!("FUNCTION-BASED NORMAL"), json!("VALID")]]
                } else {
                    vec![]
                },
            );
        }
        if sql.contains("ALL_IND_COLUMNS") {
            return result(&["INDEX_NAME", "COLUMN_NAME", "COLUMN_POSITION"], vec![]);
        }
        if sql.contains("ALL_VARRAYS") {
            return result(
                &["TYPE_OWNER", "TYPE_NAME", "LOB_NAME"],
                if f.varray {
                    vec![vec![
                        json!("APP"),
                        json!("ROOT"),
                        if f.forbidden == Some("inline") { Value::Null } else { json!("LOB_DATA") },
                    ]]
                } else {
                    vec![]
                },
            );
        }
        if sql.contains("ALL_LOBS") {
            return result(
                &["SEGMENT_NAME", "TABLESPACE_NAME", "COLUMN_NAME"],
                if f.varray && f.forbidden != Some("missing-lob") {
                    vec![vec![json!("LOB_DATA"), json!("USERS"), json!("VALUE")]]
                } else {
                    vec![]
                },
            );
        }
        if sql.contains("ALL_TAB_PRIVS") {
            return result(&["TABLE_NAME", "GRANTEE", "GRANTOR", "PRIVILEGE", "GRANTABLE"], vec![]);
        }
        if sql.contains("USER_TABLESPACES") {
            return result(
                &["TABLESPACE_NAME", "STATUS"],
                vec![vec![
                    json!("USERS"),
                    json!(if f.forbidden == Some("tablespace") { "READ ONLY" } else { "ONLINE" }),
                ]],
            );
        }
        if sql.contains("COUNT(*)") {
            return result(&["ROW_COUNT"], vec![vec![json!(f.rows.to_string())]]);
        }
        Err(format!("Unscripted native metadata query: {sql}"))
    }
    async fn run(
        f: Rc<RefCell<Fixture>>,
        input: OracleTypeEvolutionRequest,
    ) -> Result<OracleTypeEvolutionManifest, String> {
        let mut snapshot = snapshot();
        snapshot.objects[0].source = Some(input.source_before.clone());
        read(input, snapshot, move |sql| std::future::ready(query(&f.borrow(), &sql))).await
    }
    #[tokio::test]
    async fn native_varray_limit_requires_verified_existing_lob_storage_and_keeps_the_original_guards() {
        let f = Rc::new(RefCell::new(Fixture { varray: true, rows: 3, ..Default::default() }));
        let mut input = request(None);
        input.source_before = "CREATE TYPE APP.ROOT AS VARRAY(10) OF NUMBER(8,0);".into();
        input.source_after = "CREATE TYPE APP.ROOT AS VARRAY(30) OF NUMBER(8,0);".into();
        let original = run(f.clone(), input.clone()).await.unwrap();
        assert_eq!(original.statements.len(), 1);
        input.manifest = Some(original.clone());
        f.borrow_mut().phase = 1;
        let observed = run(f.clone(), input.clone()).await.unwrap();
        assert_eq!(observed.phase, 1);
        assert_eq!(observed.metadata, original.metadata);
        for reason in ["inline", "missing-lob"] {
            f.borrow_mut().forbidden = Some(reason);
            assert!(run(f.clone(), input.clone()).await.is_err(), "{reason}");
        }
    }
    #[tokio::test]
    async fn native_metadata_proves_each_phase_without_manual_baselines_or_udt_transport() {
        let f = Rc::new(RefCell::new(Fixture { rows: 3, ..Default::default() }));
        let original = run(f.clone(), request(None)).await.unwrap();
        assert_eq!(original.phase, 0);
        assert_eq!(original.statements.len(), 2);
        for phase in [1, 2] {
            f.borrow_mut().phase = phase;
            let actual = run(f.clone(), request(Some(original.clone()))).await.unwrap();
            assert_eq!(actual.phase, phase);
            assert_eq!(actual.metadata, original.metadata);
        }
    }
    #[tokio::test]
    async fn native_metadata_rejects_restrictions_unknowns_and_changed_original_identity_or_counts() {
        let f = Rc::new(RefCell::new(Fixture { rows: 3, ..Default::default() }));
        let original = run(f.clone(), request(None)).await.unwrap();
        for reason in ["version", "edition", "inheritance", "cluster", "partition", "index", "tablespace", "truncated"]
        {
            f.borrow_mut().forbidden = Some(reason);
            assert!(run(f.clone(), request(Some(original.clone()))).await.is_err(), "{reason}");
        }
        f.borrow_mut().forbidden = None;
        f.borrow_mut().table_id = "replaced-table";
        assert!(run(f.clone(), request(Some(original.clone()))).await.is_err());
        f.borrow_mut().table_id = "";
        f.borrow_mut().rows = 4;
        assert!(run(f.clone(), request(Some(original))).await.is_err());
    }
}
