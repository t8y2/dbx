//! Durable scalar evidence for manual TYPE migrations. A complete bounded read
//! is sorted by its exact byte encoding in Rust, never by database collation or
//! unstable row numbers. Duplicate rows are deliberately retained.
use super::{oracle_type_details::Dialect, oracle_type_management::Rows, sql_string};
use crate::db::{
    self, OracleTypeDataBaseline, OracleTypeDataManifest, OracleTypeDataMappingInput, OracleTypeDataProjection,
    OracleTypeDataRelation, OracleTypeDataRelationKey, OracleTypeDataRequest, OracleTypeDataResult, TypeMetadataState,
};
use dbx_sql::oracle_type_migration_sql::{
    oceanbase_scalar_insert_columns, oceanbase_table_read_only_from_ddl, validate_scalar_insert, ScalarColumn,
    ScalarType,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::future::Future;

const MAX_ROWS: usize = 10_000;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_FIELDS: usize = 128;
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
fn qualified(key: &OracleTypeDataRelationKey) -> String {
    format!("{}.{}", quote(&key.owner), quote(&key.name))
}
fn predicate(key: &OracleTypeDataRelationKey) -> String {
    format!("OWNER={} AND TABLE_NAME={}", sql_string(&key.owner), sql_string(&key.name))
}
pub(super) fn checked(rows: &Rows) -> Result<(), String> {
    if rows.read.state == TypeMetadataState::Available {
        Ok(())
    } else {
        Err(rows.read.reason.clone().unwrap_or_else(|| "A complete data/metadata read is required".into()))
    }
}
pub(super) fn raw_metadata(rows: &Rows) -> Value {
    let mut values: Vec<_> = rows
        .rows
        .iter()
        .map(|row| {
            let mut fields: Vec<_> =
                rows.columns.iter().enumerate().map(|(i, name)| (name.to_uppercase(), row[i].clone())).collect();
            fields.sort_by(|a, b| a.0.cmp(&b.0));
            fields
        })
        .collect();
    values.sort_by_key(|value| serde_json::to_string(value).unwrap_or_default());
    json!(values)
}
fn required_text(rows: &Rows, row: &[Value], key: &str) -> Result<String, String> {
    rows.text(row, key)
        .ok_or_else(|| format!("Cannot verify {key}; prepare a supported scalar projection in the SQL editor"))
}
fn scalar_type(rows: &Rows, row: &[Value], prefix: &str) -> Result<ScalarType, String> {
    let name = required_text(rows, row, &format!("{prefix}TYPE"))?.to_uppercase();
    let dimension = |key: &str| rows.text(row, key).and_then(|s| s.parse::<i32>().ok());
    let declaration = match name.as_str() {
        "NUMBER" | "DECIMAL" | "NUMERIC" => match dimension("DATA_PRECISION") {
            Some(p) => format!("NUMBER({p},{})", dimension("DATA_SCALE").ok_or("Numeric scale is unknown")?),
            None if rows.value(row, "DATA_SCALE").is_none() => "NUMBER".into(),
            _ => return Err("An unconstrained numeric projection with a fixed/unknown scale needs explicit scalar preparation".into()),
        },
        "VARCHAR2" | "CHAR" => {
            let semantics = match rows.text(row, "CHAR_USED").as_deref() { Some("B") => "BYTE", Some("C") => "CHAR", _ => return Err("Character length semantics are unknown".into()) };
            let size = dimension(if semantics == "CHAR" { "CHAR_LENGTH" } else { "DATA_LENGTH" }).ok_or("Character length is unknown")?;
            format!("{name}({size} {semantics})")
        }
        "NVARCHAR2" | "NCHAR" => format!("{name}({})", dimension("CHAR_LENGTH").ok_or("National-character length is unknown")?),
        "RAW" => format!("RAW({})", dimension("DATA_LENGTH").ok_or("RAW length is unknown")?),
        "DATE" => "DATE".into(),
        ty if ty == "TIMESTAMP" || (ty.starts_with("TIMESTAMP(") && ty.ends_with(')')) => format!("TIMESTAMP({})", dimension("DATA_SCALE").ok_or("Timestamp precision is unknown")?),
        _ => return Err(format!("{name} is not a supported lossless scalar projection; LOB, floating, collection and zoned values need preparation in the SQL editor")),
    };
    ScalarType::parse(&declaration)
}

async fn oceanbase_table_definition<F, Fut>(key: &OracleTypeDataRelationKey, run: &mut F) -> Result<String, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let definition = Rows::new(
        run(format!(
            "SELECT DBMS_METADATA.GET_DDL('TABLE', {}, {}) AS TABLE_DDL FROM DUAL",
            sql_string(&key.name),
            sql_string(&key.owner)
        ))
        .await,
        &["TABLE_DDL"],
    );
    checked(&definition)?;
    if definition.rows.len() != 1 {
        return Err("The complete exact native table definition is unavailable".into());
    }
    definition
        .value(&definition.rows[0], "TABLE_DDL")
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| "The complete native table definition must be a string".into())
}

/// Full user-visible projection, including invisible user columns and an atomic
/// null flag for each object value (an all-null object is not an atomic NULL).
pub(super) async fn describe<F, Fut>(
    dialect: Dialect,
    key: &OracleTypeDataRelationKey,
    run: &mut F,
) -> Result<OracleTypeDataRelation, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    if key.owner.is_empty() || key.name.is_empty() {
        return Err("Supply the exact owner and table name".into());
    }
    let objects = Rows::new(run(format!("SELECT TO_CHAR(OBJECT_ID) AS OBJECT_ID, OBJECT_TYPE, TEMPORARY FROM ALL_OBJECTS WHERE OWNER={} AND OBJECT_NAME={} AND SUBOBJECT_NAME IS NULL", sql_string(&key.owner), sql_string(&key.name))).await, &["OBJECT_ID", "OBJECT_TYPE", "TEMPORARY"]);
    checked(&objects)?;
    if objects.rows.len() != 1
        || objects.text(&objects.rows[0], "OBJECT_TYPE").as_deref() != Some("TABLE")
        || objects.yes_no(&objects.rows[0], "TEMPORARY") != Some(false)
    {
        return Err(
            "The relation must be one exact permanent ordinary table, not a view, synonym or temporary relation".into(),
        );
    }
    let object_id = required_text(&objects, &objects.rows[0], "OBJECT_ID")?;
    let tables = Rows::new(
        run(format!("SELECT * FROM ALL_TABLES WHERE {}", predicate(key))).await,
        &["OWNER", "TABLE_NAME", "TEMPORARY", "NESTED", "IOT_TYPE", "CLUSTER_NAME", "STATUS"],
    );
    checked(&tables)?;
    if tables.rows.len() != 1 {
        return Err("The ordinary table identity could not be verified".into());
    }
    let table = &tables.rows[0];
    if tables.yes_no(table, "TEMPORARY") != Some(false)
        || tables.yes_no(table, "NESTED") != Some(false)
        || tables.value(table, "IOT_TYPE").is_some()
        || tables.value(table, "CLUSTER_NAME").is_some()
        || tables.text(table, "STATUS").as_deref() != Some("VALID")
    {
        return Err("Temporary, nested, clustered, index-organized or unusable tables need external preparation".into());
    }
    let mut read_only = tables.yes_no(table, "READ_ONLY");
    let native_definition = if dialect == Dialect::OceanBase {
        if tables.yes_no(table, "EXTERNAL") != Some(false) {
            return Err("The native table must have a verified non-external state".into());
        }
        // OB does not expose ALL_EXTERNAL_TABLES/ALL_OBJECT_TABLES. Its exact
        // ordinary CREATE TABLE definition, not a failed/empty catalogue read,
        // supplies the second proof and the compatibility READ_ONLY value.
        let ddl = oceanbase_table_definition(key, run).await?;
        let native_read_only = oceanbase_table_read_only_from_ddl(&key.owner, &key.name, &ddl)?;
        if read_only.is_some_and(|known| known != native_read_only)
            || read_only.is_none() && tables.value(table, "READ_ONLY").is_some()
        {
            return Err("The native and dictionary read-only states are inconsistent".into());
        }
        read_only = Some(native_read_only);
        Some(ddl)
    } else {
        for catalogue in ["ALL_EXTERNAL_TABLES", "ALL_OBJECT_TABLES"] {
            let rows = Rows::new(
                run(format!("SELECT TABLE_NAME FROM {catalogue} WHERE {}", predicate(key))).await,
                &["TABLE_NAME"],
            );
            checked(&rows)?;
            if !rows.rows.is_empty() {
                return Err("External and object tables need a supported ordinary-table projection".into());
            }
        }
        None
    };
    let columns = Rows::new(
        run(format!("SELECT * FROM ALL_TAB_COLS WHERE {} ORDER BY COLUMN_ID", predicate(key))).await,
        &[
            "COLUMN_NAME",
            "COLUMN_ID",
            "DATA_TYPE",
            "DATA_TYPE_OWNER",
            "DATA_LENGTH",
            "DATA_PRECISION",
            "DATA_SCALE",
            "CHAR_USED",
            "CHAR_LENGTH",
            "HIDDEN_COLUMN",
            "USER_GENERATED",
            "VIRTUAL_COLUMN",
        ],
    );
    checked(&columns)?;
    let mut projection = Vec::new();
    let mut pending = VecDeque::new();
    for row in &columns.rows {
        if columns.yes_no(row, "HIDDEN_COLUMN") == Some(true) && columns.yes_no(row, "USER_GENERATED") == Some(false) {
            continue;
        }
        if columns.yes_no(row, "HIDDEN_COLUMN").is_none()
            || columns.yes_no(row, "USER_GENERATED").is_none()
            || columns.yes_no(row, "VIRTUAL_COLUMN") != Some(false)
        {
            return Err("Column visibility, generation or virtual-column state is not verifiable".into());
        }
        let path = vec![required_text(&columns, row, "COLUMN_NAME")?];
        if let Some(owner) = columns.text(row, "DATA_TYPE_OWNER") {
            pending.push_back((
                path,
                owner,
                required_text(&columns, row, "DATA_TYPE")?,
                Vec::<(String, String)>::new(),
            ));
        } else {
            projection.push(OracleTypeDataProjection {
                path,
                object_null: false,
                data_type: scalar_type(&columns, row, "DATA_")?.sql(),
            });
        }
    }
    let mut type_metadata = Vec::new();
    while let Some((path, owner, name, mut ancestors)) = pending.pop_front() {
        if path.len() > 4 || ancestors.contains(&(owner.clone(), name.clone())) {
            return Err("Recursive or deeply nested UDT values need explicit external scalar preparation".into());
        }
        ancestors.push((owner.clone(), name.clone()));
        let types = Rows::new(run(format!("SELECT TYPECODE, ATTRIBUTES, FINAL, INCOMPLETE, SUPERTYPE_NAME FROM ALL_TYPES WHERE OWNER={} AND TYPE_NAME={}", sql_string(&owner), sql_string(&name))).await, &["TYPECODE", "ATTRIBUTES", "FINAL", "INCOMPLETE", "SUPERTYPE_NAME"]);
        checked(&types)?;
        if types.rows.len() != 1
            || types.text(&types.rows[0], "TYPECODE").as_deref() != Some("OBJECT")
            || types.yes_no(&types.rows[0], "FINAL") != Some(true)
            || types.yes_no(&types.rows[0], "INCOMPLETE") != Some(false)
            || types.value(&types.rows[0], "SUPERTYPE_NAME").is_some()
        {
            return Err(
                "Only complete final, non-inherited object attributes have a deterministic protected scalar projection"
                    .into(),
            );
        }
        let attrs = Rows::new(run(format!("SELECT ATTR_NAME, ATTR_NO, ATTR_TYPE_MOD, ATTR_TYPE_OWNER AS DATA_TYPE_OWNER, ATTR_TYPE_NAME AS DATA_TYPE, LENGTH AS DATA_LENGTH, PRECISION AS DATA_PRECISION, SCALE AS DATA_SCALE, CHAR_USED, LENGTH AS CHAR_LENGTH FROM ALL_TYPE_ATTRS WHERE OWNER={} AND TYPE_NAME={} ORDER BY ATTR_NO", sql_string(&owner), sql_string(&name))).await, &["ATTR_NAME", "ATTR_NO", "ATTR_TYPE_MOD", "DATA_TYPE_OWNER", "DATA_TYPE", "DATA_LENGTH", "DATA_PRECISION", "DATA_SCALE", "CHAR_USED", "CHAR_LENGTH"]);
        checked(&attrs)?;
        if types.text(&types.rows[0], "ATTRIBUTES").and_then(|s| s.parse::<usize>().ok()) != Some(attrs.rows.len())
            || attrs.rows.is_empty()
        {
            return Err("The complete object attribute list could not be verified".into());
        }
        projection.push(OracleTypeDataProjection {
            path: path.clone(),
            object_null: true,
            data_type: "NUMBER(1,0)".into(),
        });
        for (index, row) in attrs.rows.iter().enumerate() {
            if attrs.value(row, "ATTR_TYPE_MOD").is_some()
                || attrs.text(row, "ATTR_NO").and_then(|s| s.parse::<usize>().ok()) != Some(index + 1)
            {
                return Err("REF, pointer or unordered object attributes need external preparation".into());
            }
            let mut field_path = path.clone();
            field_path.push(required_text(&attrs, row, "ATTR_NAME")?);
            if let Some(attr_owner) = attrs.text(row, "DATA_TYPE_OWNER") {
                pending.push_back((
                    field_path,
                    attr_owner,
                    required_text(&attrs, row, "DATA_TYPE")?,
                    ancestors.clone(),
                ));
            } else {
                if attrs.text(row, "CHAR_USED").as_deref() == Some("C") {
                    return Err("Object character-length metadata needs an explicit verified scalar preparation".into());
                }
                projection.push(OracleTypeDataProjection {
                    path: field_path,
                    object_null: false,
                    data_type: scalar_type(&attrs, row, "DATA_")?.sql(),
                });
            }
        }
        type_metadata.push(json!([owner, name, raw_metadata(&types), raw_metadata(&attrs)]));
        if projection.len() + pending.len() > MAX_FIELDS {
            return Err("The protected projection exceeds 128 scalar fields".into());
        }
    }
    if projection.is_empty() || projection.len() > MAX_FIELDS || projection.iter().any(|field| field.path.len() > 4) {
        return Err("A complete protected scalar projection of 1–128 fields is required".into());
    }
    let grants = Rows::new(
        run(format!(
            "SELECT * FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA={} AND TABLE_NAME={}",
            sql_string(&key.owner),
            sql_string(&key.name)
        ))
        .await,
        &["TABLE_NAME", "GRANTEE", "PRIVILEGE", "GRANTOR", "GRANTABLE"],
    );
    checked(&grants)?;
    // Do not serialize statistics such as NUM_ROWS/LAST_ANALYZED into identity.
    let table_identity =
        ["TEMPORARY", "NESTED", "IOT_TYPE", "CLUSTER_NAME", "STATUS", "READ_ONLY", "PARTITIONED", "TABLESPACE_NAME"]
            .map(|name| (name, tables.value(table, name).cloned()));
    let column_identity: Vec<_> = columns
        .rows
        .iter()
        .map(|row| {
            [
                "COLUMN_NAME",
                "COLUMN_ID",
                "DATA_TYPE",
                "DATA_TYPE_OWNER",
                "DATA_LENGTH",
                "DATA_PRECISION",
                "DATA_SCALE",
                "CHAR_USED",
                "CHAR_LENGTH",
                "HIDDEN_COLUMN",
                "USER_GENERATED",
                "VIRTUAL_COLUMN",
                "NULLABLE",
                "DATA_DEFAULT",
                "DEFAULT_ON_NULL",
                "IDENTITY_COLUMN",
                "COLLATION",
            ]
            .map(|name| (name, columns.value(row, name).cloned()))
        })
        .collect();
    let mut structure =
        vec![json!(table_identity), json!(column_identity), raw_metadata(&grants), json!(type_metadata)];
    if let Some(ddl) = native_definition {
        structure.push(json!(["oceanbase_native_table_definition", ddl]));
    }
    let structure = serde_json::to_string(&structure).map_err(|e| e.to_string())?;
    Ok(OracleTypeDataRelation { relation: key.clone(), object_id, read_only, structure, projection })
}

struct DataSet {
    baseline: OracleTypeDataBaseline,
    values: Vec<Vec<Option<String>>>,
    types: Vec<ScalarType>,
}
fn frame(output: &mut Vec<u8>, bytes: &[u8]) {
    output.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
    output.extend_from_slice(bytes);
}
fn encode_row(values: &[Option<String>], types: &[ScalarType]) -> Vec<u8> {
    let mut output = Vec::new();
    for (value, ty) in values.iter().zip(types) {
        frame(&mut output, ty.family().as_bytes());
        match value {
            None => output.push(0),
            Some(value) => {
                output.push(1);
                frame(&mut output, value.as_bytes());
            }
        }
    }
    output
}
fn digest(mut rows: Vec<Vec<u8>>, types: &[ScalarType], include_dimensions: bool) -> String {
    rows.sort();
    let mut hasher = Sha256::new();
    hasher.update(b"DBX-TYPE-SCALAR-MULTISET-v1");
    for ty in types {
        let tag = if include_dimensions { ty.sql() } else { ty.family().into() };
        hasher.update((tag.len() as u64).to_be_bytes());
        hasher.update(tag.as_bytes());
    }
    hasher.update((rows.len() as u64).to_be_bytes());
    for row in rows {
        hasher.update((row.len() as u64).to_be_bytes());
        hasher.update(row);
    }
    format!("{:x}", hasher.finalize())
}

/// Canonical arbitrary-precision decimal, without a floating-point roundtrip.
fn decimal(text: &str) -> Result<String, String> {
    let text = text.trim();
    let (negative, text) = if let Some(value) = text.strip_prefix('-') {
        (true, value)
    } else {
        (false, text.strip_prefix('+').unwrap_or(text))
    };
    let (mantissa, exponent) = text
        .split_once(['E', 'e'])
        .map_or(Ok((text, 0)), |(m, e)| e.parse::<i32>().map(|e| (m, e)).map_err(|_| "Invalid decimal exponent"))?;
    let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if integer.is_empty() && fraction.is_empty()
        || !integer.bytes().chain(fraction.bytes()).all(|c| c.is_ascii_digit())
        || exponent.unsigned_abs() > 256
    {
        return Err("A numeric value was not read as a complete exact decimal string".into());
    }
    let combined = format!("{integer}{fraction}");
    let significant = combined.trim_start_matches('0');
    if significant.is_empty() {
        return Ok("0".into());
    }
    let trimmed = significant.trim_end_matches('0');
    let power = exponent - fraction.len() as i32 + (significant.len() - trimmed.len()) as i32;
    Ok(format!("{}{trimmed}e{power}", if negative { "-" } else { "" }))
}

async fn read_data<F, Fut>(dialect: Dialect, relation: OracleTypeDataRelation, run: &mut F) -> Result<DataSet, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let types: Vec<_> =
        relation.projection.iter().map(|field| ScalarType::parse(&field.data_type)).collect::<Result<_, _>>()?;
    let expression = |field: &OracleTypeDataProjection, ty: &ScalarType| {
        let path = format!("T.{}", field.path.iter().map(|p| quote(p)).collect::<Vec<_>>().join("."));
        if field.object_null {
            return format!("CASE WHEN {path} IS NULL THEN 1 ELSE 0 END");
        }
        match ty.family() {
            "decimal" if dialect == Dialect::OceanBase => {
                format!("TO_CHAR({path}, 'TM9', 'NLS_NUMERIC_CHARACTERS=.,')")
            }
            "decimal" if dialect != Dialect::Dameng => {
                format!("TO_CHAR({path}, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')")
            }
            "decimal" => format!("TO_CHAR({path})"),
            "date" if dialect == Dialect::Dameng => format!("TO_CHAR({path}, 'SYYYY-MM-DD\"T\"HH24:MI:SS')"),
            "timestamp" if dialect == Dialect::Dameng => format!("TO_CHAR({path}, 'SYYYY-MM-DD\"T\"HH24:MI:SS.FF9')"),
            "date" => format!("TO_CHAR({path}, 'SYYYY-MM-DD\"T\"HH24:MI:SS', 'NLS_CALENDAR=GREGORIAN')"),
            "timestamp" => format!("TO_CHAR({path}, 'SYYYY-MM-DD\"T\"HH24:MI:SS.FF9', 'NLS_CALENDAR=GREGORIAN')"),
            "raw" => format!("RAWTOHEX({path})"),
            _ => path,
        }
    };
    let selected = relation
        .projection
        .iter()
        .zip(&types)
        .enumerate()
        .map(|(i, (field, ty))| format!("{} AS \"C{i}\"", expression(field, ty)))
        .collect::<Vec<_>>()
        .join(", ");
    let count_sql = format!("SELECT TO_CHAR(COUNT(*)) AS ROW_COUNT FROM {}", qualified(&relation.relation));
    let count = |rows: &Rows| -> Result<usize, String> {
        checked(rows)?;
        if rows.rows.len() != 1 {
            return Err("The full relation count is unavailable".into());
        }
        required_text(rows, &rows.rows[0], "ROW_COUNT")?
            .parse()
            .map_err(|_| "The relation count is not an exact integer".into())
    };
    let before_count = count(&Rows::new(run(count_sql.clone()).await, &["ROW_COUNT"]))?;
    if before_count > MAX_ROWS {
        return Err("The complete projection exceeds the 10000-row verification budget; partition the migration before registering its baseline".into());
    }
    let row_capacity: usize = types
        .iter()
        .zip(&relation.projection)
        .map(|(ty, field)| {
            let value_bytes = if field.object_null {
                1
            } else {
                match ty.family() {
                    "text" => ty.size.unwrap_or(32767) as usize * 4,
                    "raw" => ty.size.unwrap_or(32767) as usize * 2,
                    "decimal" => 256,
                    _ => 64,
                }
            };
            value_bytes + 64
        })
        .sum();
    // Bound transport allocation before fetching, including one sentinel row if
    // a concurrent insert occurs after COUNT. No lossy paging is needed.
    if row_capacity.saturating_mul(before_count + 1) > MAX_BYTES {
        return Err("Declared scalar widths and row count exceed the safe 8 MiB read budget. Reduce the migration scope before registering a complete baseline".into());
    }
    let aliases: Vec<_> = (0..types.len()).map(|i| format!("C{i}")).collect();
    let required: Vec<_> = aliases.iter().map(String::as_str).collect();
    let rows = Rows::new(
        run(format!("SELECT {selected} FROM {} T WHERE ROWNUM <= {}", qualified(&relation.relation), before_count + 1))
            .await,
        &required,
    );
    checked(&rows)?;
    if rows.rows.len() != before_count || count(&Rows::new(run(count_sql).await, &["ROW_COUNT"]))? != before_count {
        return Err("The relation changed or the driver did not return the complete projection".into());
    }
    let mut values = Vec::new();
    let mut bytes = 0;
    for row in &rows.rows {
        let mut encoded = Vec::new();
        for (i, ty) in types.iter().enumerate() {
            let value = match rows.value(row, &aliases[i]) {
                None => None,
                Some(Value::String(value)) => {
                    Some(if ty.family() == "decimal" { decimal(value)? } else { value.clone() })
                }
                // Only our object-null CASE is allowed to cross a numeric driver cell.
                Some(Value::Number(n))
                    if relation.projection[i].object_null && (n.as_u64() == Some(0) || n.as_u64() == Some(1)) =>
                {
                    Some(decimal(&n.to_string())?)
                }
                _ => return Err("A value was not transported as a complete lossless scalar string".into()),
            };
            bytes += value.as_ref().map_or(1, |value| value.len() + 16);
            if bytes > MAX_BYTES {
                return Err("The complete projection exceeds the 8 MiB verification budget; no complete fingerprint was created".into());
            }
            encoded.push(value);
        }
        values.push(encoded);
    }
    let encoded: Vec<_> = values.iter().map(|row| encode_row(row, &types)).collect();
    let fingerprint = digest(encoded, &types, true);
    if describe(dialect, &relation.relation, run).await? != relation {
        return Err(
            "The relation identity, definition, grants or read-only state changed during the complete read".into()
        );
    }
    Ok(DataSet {
        baseline: OracleTypeDataBaseline { relation, row_count: values.len() as u32, fingerprint },
        values,
        types,
    })
}

fn projected_digest(data: &DataSet, indexes: &[usize]) -> String {
    let types: Vec<_> = indexes.iter().map(|&i| data.types[i].clone()).collect();
    digest(
        data.values
            .iter()
            .map(|row| encode_row(&indexes.iter().map(|&i| row[i].clone()).collect::<Vec<_>>(), &types))
            .collect(),
        &types,
        false,
    )
}
fn projection_indexes(data: &DataSet, paths: &[(Vec<String>, bool)], require_all: bool) -> Result<Vec<usize>, String> {
    let indexes: Vec<_> = paths
        .iter()
        .map(|(path, object_null)| {
            data.baseline
                .relation
                .projection
                .iter()
                .position(|field| &field.path == path && field.object_null == *object_null)
                .ok_or("A mapped field is absent from the complete protected projection")
        })
        .collect::<Result<_, _>>()?;
    if indexes.iter().collect::<HashSet<_>>().len() != indexes.len() || require_all && indexes.len() != data.types.len()
    {
        return Err("Map every protected field exactly once; fields cannot be omitted or duplicated".into());
    }
    Ok(indexes)
}
fn compare(left: &DataSet, li: &[usize], right: &DataSet, ri: &[usize]) -> Result<(), String> {
    if left.baseline.row_count != right.baseline.row_count || projected_digest(left, li) != projected_digest(right, ri)
    {
        return Err("The full typed values, NULLs or duplicate-row multiplicities do not match".into());
    }
    Ok(())
}
fn scalar_relation(relation: &OracleTypeDataRelation) -> Result<(), String> {
    if relation.projection.iter().any(|field| field.object_null || field.path.len() != 1) {
        Err("OLD and EXPECTED must contain only ordinary scalar columns".into())
    } else {
        Ok(())
    }
}
fn same_baseline(expected: &OracleTypeDataBaseline, actual: &OracleTypeDataBaseline) -> Result<(), String> {
    if expected != actual {
        Err("A registered baseline changed identity, structure, grants, read-only state, values or multiplicities. Keep the original manifest; do not replace its baseline".into())
    } else {
        Ok(())
    }
}
fn validate_mapping(mapping: &OracleTypeDataMappingInput) -> Result<(), String> {
    if mapping.id.is_empty()
        || mapping.fields.is_empty()
        || mapping.fields.len() > MAX_FIELDS
        || mapping.old == mapping.expected
        || [mapping.source.clone(), mapping.target.clone()]
            .iter()
            .any(|key| *key == mapping.old || *key == mapping.expected)
    {
        return Err("Register distinct permanent OLD/EXPECTED tables and a complete bounded field mapping".into());
    }
    Ok(())
}
async fn baselines<F, Fut>(
    dialect: Dialect,
    mapping: &OracleTypeDataMappingInput,
    run: &mut F,
) -> Result<(DataSet, DataSet), String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    validate_mapping(mapping)?;
    let mut read = Vec::new();
    for key in [&mapping.old, &mapping.expected] {
        let relation = describe(dialect, key, run).await?;
        scalar_relation(&relation)?;
        if relation.read_only != Some(true) {
            return Err(format!("{} must have a verified native READ ONLY state. Commit and protect it in the SQL editor, then reread; an unknown adapter state is not read-only", qualified(key)));
        }
        read.push(read_data(dialect, relation, run).await?);
    }
    let expected = read.pop().unwrap();
    let old = read.pop().unwrap();
    let old_indexes = projection_indexes(
        &old,
        &mapping.fields.iter().map(|f| (vec![f.old_column.clone()], false)).collect::<Vec<_>>(),
        true,
    )?;
    let expected_indexes = projection_indexes(
        &expected,
        &mapping.fields.iter().map(|f| (vec![f.expected_column.clone()], false)).collect::<Vec<_>>(),
        true,
    )?;
    if old.baseline.row_count != expected.baseline.row_count {
        return Err("OLD to EXPECTED must retain the full row count/multiplicity; aggregation and row deletion are not part of this migration".into());
    }
    let unchanged: Vec<_> = mapping.fields.iter().enumerate().filter_map(|(i, f)| f.unchanged.then_some(i)).collect();
    compare(
        &old,
        &unchanged.iter().map(|&i| old_indexes[i]).collect::<Vec<_>>(),
        &expected,
        &unchanged.iter().map(|&i| expected_indexes[i]).collect::<Vec<_>>(),
    )?;
    Ok((old, expected))
}

pub(super) async fn read<F, Fut>(
    dialect: Dialect,
    input: OracleTypeDataRequest,
    mut run: F,
) -> Result<OracleTypeDataResult, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    let mut result = OracleTypeDataResult { relation: None, manifest: None, insert_sql: None };
    if input.action == "describe" {
        result.relation =
            Some(describe(dialect, &input.relation.ok_or("Relation identity is required")?, &mut run).await?);
        return Ok(result);
    }
    if input.action == "register" {
        let mapping = input.mapping.ok_or("The permanent mapping is required")?;
        let (old, expected) = baselines(dialect, &mapping, &mut run).await?;
        let relation = describe(dialect, &mapping.source, &mut run).await?;
        let original = read_data(dialect, relation, &mut run).await?;
        let source_indexes = projection_indexes(
            &original,
            &mapping.fields.iter().map(|f| (f.source_path.clone(), f.object_null)).collect::<Vec<_>>(),
            true,
        )?;
        let old_indexes = projection_indexes(
            &old,
            &mapping.fields.iter().map(|f| (vec![f.old_column.clone()], false)).collect::<Vec<_>>(),
            true,
        )?;
        compare(&original, &source_indexes, &old, &old_indexes)?;
        result.manifest = Some(OracleTypeDataManifest {
            mapping,
            original: original.baseline,
            old: old.baseline,
            expected: expected.baseline,
            prepared_target: None,
            verified_target: None,
        });
        return Ok(result);
    }
    let mut manifest = input.manifest.ok_or("The original persisted data manifest is required")?;
    let mapping = &manifest.mapping;
    let (old, expected) = baselines(dialect, mapping, &mut run).await?;
    same_baseline(&manifest.old, &old.baseline)?;
    same_baseline(&manifest.expected, &expected.baseline)?;
    if manifest.original.row_count != old.baseline.row_count {
        return Err("The original baseline count is inconsistent".into());
    }
    let relation = describe(dialect, &mapping.target, &mut run).await?;
    if input.action == "validate_insert" {
        scalar_relation(&relation)?;
        let actual = read_data(dialect, relation.clone(), &mut run).await?;
        if actual.baseline.row_count != 0 || manifest.verified_target.is_some() {
            return Err(
                "INSERT is only available for the registered, still-empty scalar target before any verified insertion"
                    .into(),
            );
        }
        if let Some(prepared) = &manifest.prepared_target {
            same_baseline(prepared, &actual.baseline)?;
        }
        validate_insert_target(dialect, &relation, &mut run).await?;
        let columns = |relation: &OracleTypeDataRelation| -> Result<Vec<ScalarColumn>, String> {
            relation
                .projection
                .iter()
                .map(|field| {
                    Ok(ScalarColumn { name: field.path[0].clone(), data_type: ScalarType::parse(&field.data_type)? })
                })
                .collect()
        };
        result.insert_sql = Some(validate_scalar_insert(
            &input.sql.ok_or("Supply the single bounded INSERT SELECT")?,
            (&mapping.target.owner, &mapping.target.name),
            (&mapping.expected.owner, &mapping.expected.name),
            &columns(&relation)?,
            &columns(&expected.baseline.relation)?,
        )?);
        manifest.prepared_target = Some(actual.baseline);
    } else if input.action == "verify" {
        let actual = read_data(dialect, relation, &mut run).await?;
        let target_indexes = projection_indexes(
            &actual,
            &mapping.fields.iter().map(|f| (f.target_path.clone(), f.target_object_null)).collect::<Vec<_>>(),
            true,
        )?;
        let expected_indexes = projection_indexes(
            &expected,
            &mapping.fields.iter().map(|f| (vec![f.expected_column.clone()], false)).collect::<Vec<_>>(),
            true,
        )?;
        compare(&actual, &target_indexes, &expected, &expected_indexes)?;
        if let Some(prepared) = &manifest.prepared_target {
            if prepared.relation != actual.baseline.relation {
                return Err("The prepared INSERT target changed identity or structure".into());
            }
        }
        if let Some(verified) = &manifest.verified_target {
            same_baseline(verified, &actual.baseline)?;
        }
        manifest.verified_target = Some(actual.baseline);
    } else {
        return Err("Unknown TYPE data verification action".into());
    }
    result.manifest = Some(manifest);
    Ok(result)
}

async fn validate_insert_target<F, Fut>(
    dialect: Dialect,
    relation: &OracleTypeDataRelation,
    run: &mut F,
) -> Result<(), String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    if relation.read_only != Some(false) {
        return Err("The scalar INSERT target must have a verified READ WRITE state".into());
    }
    let key = &relation.relation;
    let native_plain_columns = if dialect == Dialect::OceanBase {
        let ddl = oceanbase_table_definition(key, run).await?;
        let columns = oceanbase_scalar_insert_columns(&key.owner, &key.name, &ddl)?;
        if columns != relation.projection.iter().map(|field| field.path[0].clone()).collect::<Vec<_>>() {
            return Err("The complete native scalar columns differ from the registered projection".into());
        }
        true
    } else {
        false
    };
    let columns = Rows::new(run(format!("SELECT COLUMN_NAME, DATA_DEFAULT, VIRTUAL_COLUMN, HIDDEN_COLUMN, IDENTITY_COLUMN, DEFAULT_ON_NULL FROM ALL_TAB_COLS WHERE {}", predicate(key))).await, &["COLUMN_NAME", "DATA_DEFAULT", "VIRTUAL_COLUMN", "HIDDEN_COLUMN", "IDENTITY_COLUMN", "DEFAULT_ON_NULL"]);
    checked(&columns)?;
    if columns.rows.len() != relation.projection.len()
        || columns.rows.iter().any(|row| {
            columns.value(row, "DATA_DEFAULT").is_some()
                || ["VIRTUAL_COLUMN", "HIDDEN_COLUMN"].iter().any(|flag| columns.yes_no(row, flag) != Some(false))
                || ["IDENTITY_COLUMN", "DEFAULT_ON_NULL"].iter().any(|flag| match columns.yes_no(row, flag) {
                    Some(false) => false,
                    None if native_plain_columns && columns.value(row, flag).is_none() => false,
                    _ => true,
                })
        })
    {
        return Err("The target has default, virtual, hidden or identity execution semantics; prepare it in the SQL editor instead".into());
    }
    for (sql, required, label) in [
        (
            format!(
                "SELECT TRIGGER_NAME FROM ALL_TRIGGERS WHERE TABLE_OWNER={} AND TABLE_NAME={}",
                sql_string(&key.owner),
                sql_string(&key.name)
            ),
            "TRIGGER_NAME",
            "triggers",
        ),
        (
            format!(
                "SELECT POLICY_NAME FROM ALL_POLICIES WHERE OBJECT_OWNER={} AND OBJECT_NAME={}",
                sql_string(&key.owner),
                sql_string(&key.name)
            ),
            "POLICY_NAME",
            "row-security policies",
        ),
    ] {
        let rows = Rows::new(run(sql).await, &[required]);
        checked(&rows)?;
        if !rows.rows.is_empty() {
            return Err(format!("The target has {label}; use the SQL editor and return for verification"));
        }
    }
    let indexes = Rows::new(
        run(format!(
            "SELECT INDEX_TYPE FROM ALL_INDEXES WHERE TABLE_OWNER={} AND TABLE_NAME={}",
            sql_string(&key.owner),
            sql_string(&key.name)
        ))
        .await,
        &["INDEX_TYPE"],
    );
    checked(&indexes)?;
    if indexes
        .rows
        .iter()
        .any(|row| !matches!(indexes.text(row, "INDEX_TYPE").as_deref(), Some("NORMAL" | "NORMAL/REV" | "BITMAP")))
    {
        return Err("The target has an unknown, function-based or domain index".into());
    }
    let condition =
        if dialect == Dialect::OceanBase { "SEARCH_CONDITION AS SEARCH_CONDITION_VC" } else { "SEARCH_CONDITION_VC" };
    let constraints = Rows::new(
        run(format!("SELECT CONSTRAINT_TYPE, {condition} FROM ALL_CONSTRAINTS WHERE {}", predicate(key))).await,
        &["CONSTRAINT_TYPE", "SEARCH_CONDITION_VC"],
    );
    checked(&constraints)?;
    for row in &constraints.rows {
        match constraints.text(row, "CONSTRAINT_TYPE").as_deref() {
            Some("P" | "U" | "R") => (),
            Some("C")
                if relation.projection.iter().any(|field| {
                    constraints.text(row, "SEARCH_CONDITION_VC").as_deref()
                        == Some(format!("{} IS NOT NULL", quote(&field.path[0])).as_str())
                }) => {}
            _ => return Err("A target constraint is not a verified key or simple NOT NULL check".into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[derive(Clone)]
    struct Table {
        id: String,
        readonly: Option<bool>,
        rows: Vec<Vec<Value>>,
    }
    #[derive(Clone)]
    struct Fixture {
        tables: BTreeMap<String, Table>,
        fault: Option<&'static str>,
    }
    fn answer(columns: &[&str], rows: Vec<Vec<Value>>) -> db::QueryResult {
        serde_json::from_value(json!({ "columns": columns, "rows": rows, "affected_rows": 0, "execution_time_ms": 0 }))
            .unwrap()
    }
    impl Fixture {
        fn new() -> Self {
            let rows = vec![
                vec![json!("90071992547409931234567890.1200"), json!("A ")],
                vec![json!("90071992547409931234567890.1200"), json!("A ")],
                vec![Value::Null, Value::Null],
            ];
            Self {
                tables: ["SRC", "OLD", "EXPECTED", "RESULT"]
                    .into_iter()
                    .enumerate()
                    .map(|(i, name)| {
                        (
                            name.into(),
                            Table {
                                id: format!("900719925474099{}", i + 3),
                                readonly: Some(name == "OLD" || name == "EXPECTED"),
                                rows: if name == "RESULT" { vec![] } else { rows.clone() },
                            },
                        )
                    })
                    .collect(),
                fault: None,
            }
        }
        fn query(&self, sql: String) -> Result<db::QueryResult, String> {
            let name = ["SRC", "OLD", "EXPECTED", "RESULT"]
                .into_iter()
                .find(|name| sql.contains(&format!("'{name}'")) || sql.contains(&format!("\"APP\".\"{name}\"")))
                .ok_or_else(|| format!("Unexpected fixture query: {sql}"))?;
            let table = self.tables.get(name).ok_or("Missing table")?;
            if sql.contains("FROM ALL_OBJECTS") {
                return Ok(answer(
                    &["OBJECT_ID", "OBJECT_TYPE", "TEMPORARY"],
                    vec![vec![json!(table.id), json!("TABLE"), json!("N")]],
                ));
            }
            if sql.contains("FROM ALL_TABLES") {
                return Ok(answer(
                    &[
                        "OWNER",
                        "TABLE_NAME",
                        "TEMPORARY",
                        "NESTED",
                        "IOT_TYPE",
                        "CLUSTER_NAME",
                        "STATUS",
                        "READ_ONLY",
                        "PARTITIONED",
                        "TABLESPACE_NAME",
                        "EXTERNAL",
                    ],
                    vec![vec![
                        json!("APP"),
                        json!(name),
                        json!("N"),
                        json!("NO"),
                        Value::Null,
                        Value::Null,
                        json!("VALID"),
                        table.readonly.map(|b| json!(if b { "YES" } else { "NO" })).unwrap_or(Value::Null),
                        json!("NO"),
                        json!("USERS"),
                        json!("NO"),
                    ]],
                ));
            }
            if sql.contains("FROM ALL_EXTERNAL_TABLES") || sql.contains("FROM ALL_OBJECT_TABLES") {
                return Ok(answer(&["TABLE_NAME"], vec![]));
            }
            if sql.contains("FROM ALL_TAB_COLS") {
                let columns = [
                    "COLUMN_NAME",
                    "COLUMN_ID",
                    "DATA_TYPE",
                    "DATA_TYPE_OWNER",
                    "DATA_LENGTH",
                    "DATA_PRECISION",
                    "DATA_SCALE",
                    "CHAR_USED",
                    "CHAR_LENGTH",
                    "HIDDEN_COLUMN",
                    "USER_GENERATED",
                    "VIRTUAL_COLUMN",
                    "IDENTITY_COLUMN",
                    "DEFAULT_ON_NULL",
                    "DATA_DEFAULT",
                    "NULLABLE",
                ];
                return Ok(answer(
                    &columns,
                    vec![
                        vec![
                            json!("ID"),
                            json!(1),
                            json!("NUMBER"),
                            Value::Null,
                            json!(22),
                            json!(38),
                            json!(4),
                            Value::Null,
                            json!(0),
                            json!("NO"),
                            json!("YES"),
                            json!("NO"),
                            json!("NO"),
                            json!("NO"),
                            Value::Null,
                            json!("Y"),
                        ],
                        vec![
                            json!("LABEL"),
                            json!(2),
                            json!("VARCHAR2"),
                            Value::Null,
                            json!(80),
                            Value::Null,
                            Value::Null,
                            json!("B"),
                            json!(80),
                            json!("NO"),
                            json!("YES"),
                            json!("NO"),
                            json!("NO"),
                            json!("NO"),
                            Value::Null,
                            json!("Y"),
                        ],
                    ],
                ));
            }
            if sql.contains("FROM ALL_TAB_PRIVS") {
                return Ok(answer(&["TABLE_NAME", "GRANTEE", "PRIVILEGE", "GRANTOR", "GRANTABLE"], vec![]));
            }
            if sql.contains("FROM ALL_TRIGGERS") {
                return Ok(answer(
                    &["TRIGGER_NAME"],
                    if self.fault == Some("trigger") && name == "RESULT" {
                        vec![vec![json!("HIDDEN_WRITE")]]
                    } else {
                        vec![]
                    },
                ));
            }
            if sql.contains("FROM ALL_POLICIES") {
                return Ok(answer(&["POLICY_NAME"], vec![]));
            }
            if sql.contains("FROM ALL_INDEXES") {
                return Ok(answer(
                    &["INDEX_TYPE"],
                    if self.fault == Some("function-index") {
                        vec![vec![json!("FUNCTION-BASED NORMAL")]]
                    } else {
                        vec![]
                    },
                ));
            }
            if sql.contains("FROM ALL_CONSTRAINTS") {
                return Ok(answer(&["CONSTRAINT_TYPE", "SEARCH_CONDITION_VC"], vec![]));
            }
            if sql.starts_with("SELECT TO_CHAR(COUNT(*))") {
                return Ok(answer(&["ROW_COUNT"], vec![vec![json!(table.rows.len().to_string())]]));
            }
            if sql.starts_with("SELECT TO_CHAR(T.") {
                let mut rows = answer(&["C0", "C1"], table.rows.clone());
                if self.fault == Some("truncated") {
                    rows.truncated = true;
                }
                if self.fault == Some("has-more") {
                    rows.has_more = true;
                }
                if self.fault == Some("lossy-number") {
                    rows.rows[0][0] = json!(9007199254740992_u64);
                }
                if self.fault == Some("large-cell") {
                    rows.rows[0][1] = json!({"type":"large-value", "preview":"A"});
                }
                if self.fault == Some("silent-limit") {
                    rows.rows.pop();
                }
                return Ok(rows);
            }
            Err(format!("Unexpected fixture query: {sql}"))
        }
        async fn call(
            &self,
            action: &str,
            manifest: Option<OracleTypeDataManifest>,
            sql: Option<&str>,
        ) -> Result<OracleTypeDataResult, String> {
            let request = OracleTypeDataRequest {
                target: db::OracleTypeManagementTarget {
                    connection_id: "test".into(),
                    database: "db".into(),
                    owner: "APP".into(),
                    name: "ROOT".into(),
                },
                action: action.into(),
                relation: None,
                mapping: Some(mapping()),
                manifest,
                sql: sql.map(String::from),
            };
            read(Dialect::Oracle, request, |sql| std::future::ready(self.query(sql))).await
        }
    }
    fn mapping() -> OracleTypeDataMappingInput {
        let relation = |name: &str| OracleTypeDataRelationKey { owner: "APP".into(), name: name.into() };
        OracleTypeDataMappingInput {
            id: "mapping-original".into(),
            source: relation("SRC"),
            old: relation("OLD"),
            expected: relation("EXPECTED"),
            target: relation("RESULT"),
            fields: ["ID", "LABEL"]
                .map(|name| db::OracleTypeDataField {
                    source_path: vec![name.into()],
                    object_null: false,
                    old_column: name.into(),
                    expected_column: name.into(),
                    target_path: vec![name.into()],
                    target_object_null: false,
                    unchanged: true,
                })
                .into(),
        }
    }

    fn oceanbase_query(fixture: &Fixture, sql: String) -> Result<db::QueryResult, String> {
        if sql.contains("NLS_NUMERIC_CHARACTERS=''.,''") {
            return Err("OB 4.2.5.7: invalid NLS parameter string (12702)".into());
        }
        if sql.contains("ALL_EXTERNAL_TABLES") || sql.contains("ALL_OBJECT_TABLES") {
            return Err("OB 4.2.5.7: catalogue does not exist (942)".into());
        }
        if sql.contains("FROM ALL_CONSTRAINTS") && !sql.contains("SEARCH_CONDITION AS SEARCH_CONDITION_VC") {
            return Err("OB 4.2.5.7: SEARCH_CONDITION_VC does not exist (904)".into());
        }
        if sql.contains("DBMS_METADATA.GET_DDL") {
            let name = ["SRC", "OLD", "EXPECTED", "RESULT"]
                .into_iter()
                .find(|name| sql.contains(&format!("'{name}'")))
                .unwrap();
            assert_eq!(sql, format!("SELECT DBMS_METADATA.GET_DDL('TABLE', '{name}', 'APP') AS TABLE_DDL FROM DUAL"));
            let read_only = fixture.tables[name].readonly.unwrap_or(name == "OLD" || name == "EXPECTED");
            return Ok(answer(&["TABLE_DDL"], vec![vec![json!(format!("CREATE TABLE \"{name}\" (\"ID\" NUMBER(38,4), \"LABEL\" VARCHAR2(80 BYTE), PRIMARY KEY (\"ID\")) COMPRESS FOR ARCHIVE REPLICA_NUM = 1 BLOCK_SIZE = 16384 USE_BLOOM_FILTER = FALSE TABLET_SIZE = 134217728 PCTFREE = 0{}", if read_only { " READ ONLY" } else { "" }))]]));
        }
        let mut response = fixture.query(sql.clone())?;
        if sql.contains("FROM ALL_TAB_COLS") {
            for flag in ["IDENTITY_COLUMN", "DEFAULT_ON_NULL"] {
                let index = response.columns.iter().position(|name| name == flag).unwrap();
                for row in &mut response.rows {
                    row[index] = Value::Null;
                }
            }
        }
        Ok(response)
    }

    #[tokio::test]
    async fn oceanbase_null_dictionary_readonly_uses_complete_bound_native_ddl() {
        let mut fixture = Fixture::new();
        for table in fixture.tables.values_mut() {
            table.readonly = None;
        }
        let input = OracleTypeDataRequest {
            target: db::OracleTypeManagementTarget {
                connection_id: "test".into(),
                database: "db".into(),
                owner: "APP".into(),
                name: "ROOT".into(),
            },
            action: "register".into(),
            relation: None,
            mapping: Some(mapping()),
            manifest: None,
            sql: None,
        };
        let run = |sql: String| oceanbase_query(&fixture, sql);
        let result = read(Dialect::OceanBase, input, |sql| std::future::ready(run(sql))).await;
        assert!(result.is_ok(), "The bound native READ ONLY definition must be usable: {result:?}");
        let manifest = result.unwrap().manifest.unwrap();
        assert_eq!(manifest.old.relation.read_only, Some(true));
        assert_eq!(manifest.expected.relation.read_only, Some(true));
        assert_eq!(manifest.original.relation.read_only, Some(false));
        let insert = OracleTypeDataRequest {
            target: db::OracleTypeManagementTarget {
                connection_id: "test".into(),
                database: "db".into(),
                owner: "APP".into(),
                name: "ROOT".into(),
            },
            action: "validate_insert".into(),
            relation: None,
            mapping: None,
            manifest: Some(manifest.clone()),
            sql: Some("INSERT INTO APP.RESULT(ID,LABEL) SELECT ID,LABEL FROM APP.EXPECTED".into()),
        };
        let result = read(Dialect::OceanBase, insert, |sql| std::future::ready(run(sql))).await.unwrap();
        assert!(result.insert_sql.unwrap().starts_with("INSERT INTO \"APP\".\"RESULT\""));
        let mut blocked = fixture.clone();
        blocked.tables.get_mut("RESULT").unwrap().readonly = Some(true);
        let relation = describe(Dialect::OceanBase, &manifest.mapping.target, &mut |sql| {
            std::future::ready(oceanbase_query(&blocked, sql))
        })
        .await
        .unwrap();
        let error = validate_insert_target(Dialect::OceanBase, &relation, &mut |sql| {
            std::future::ready(oceanbase_query(&blocked, sql))
        })
        .await
        .unwrap_err();
        assert!(error.contains("READ WRITE"));
    }

    #[tokio::test]
    async fn oceanbase_readonly_fallback_rejects_incomplete_or_unbound_ddl() {
        let mut fixture = Fixture::new();
        fixture.tables.get_mut("OLD").unwrap().readonly = None;
        let key = OracleTypeDataRelationKey { owner: "APP".into(), name: "OLD".into() };
        for fault in [
            "truncated",
            "has-more",
            "large-cell",
            "missing",
            "multirow",
            "wrong-name",
            "wrong-owner",
            "partial",
            "denied",
        ] {
            let mut run = |sql: String| {
                let result = if sql.contains("DBMS_METADATA.GET_DDL") {
                    if fault == "denied" {
                        Err("Metadata permission denied".into())
                    } else {
                        oceanbase_query(&fixture, sql).map(|mut result| {
                            match fault {
                                "truncated" => result.truncated = true,
                                "has-more" => result.has_more = true,
                                "large-cell" => {
                                    result.rows[0][0] = json!({"preview":"CREATE TABLE OLD", "truncated":true})
                                }
                                "missing" => result.rows.clear(),
                                "multirow" => result.rows.push(result.rows[0].clone()),
                                "wrong-name" => {
                                    result.rows[0][0] =
                                        json!(result.rows[0][0].as_str().unwrap().replace("\"OLD\"", "\"OTHER\""))
                                }
                                "wrong-owner" => {
                                    result.rows[0][0] = json!(result.rows[0][0]
                                        .as_str()
                                        .unwrap()
                                        .replace("\"OLD\"", "\"OTHER\".\"OLD\""))
                                }
                                "partial" => result.rows[0][0] = json!("CREATE TABLE OLD (ID NUMBER) READ ONLY"),
                                _ => unreachable!(),
                            }
                            result
                        })
                    }
                } else {
                    fixture.query(sql)
                };
                std::future::ready(result)
            };
            assert!(describe(Dialect::OceanBase, &key, &mut run).await.is_err(), "{fault}");
        }
        for dialect in [Dialect::Oracle, Dialect::Dameng] {
            let relation = describe(dialect, &key, &mut |sql| std::future::ready(fixture.query(sql))).await.unwrap();
            assert_eq!(relation.read_only, None);
        }
        fixture.tables.get_mut("OLD").unwrap().readonly = Some(true);
        let relation =
            describe(Dialect::OceanBase, &key, &mut |sql| std::future::ready(oceanbase_query(&fixture, sql)))
                .await
                .unwrap();
        assert_eq!(relation.read_only, Some(true));
    }

    #[tokio::test]
    async fn oceanbase_native_definition_cannot_hide_implicit_insert_execution() {
        let mut fixture = Fixture::new();
        fixture.tables.get_mut("RESULT").unwrap().readonly = None;
        let key = OracleTypeDataRelationKey { owner: "APP".into(), name: "RESULT".into() };
        let relation =
            describe(Dialect::OceanBase, &key, &mut |sql| std::future::ready(oceanbase_query(&fixture, sql)))
                .await
                .unwrap();
        for fault in [
            "default",
            "identity",
            "generated",
            "inline-check",
            "wrong-column",
            "metadata-identity",
            "metadata-on-null",
            "metadata-unknown",
            "hidden",
            "virtual",
        ] {
            let mut run = |sql: String| {
                let result = oceanbase_query(&fixture, sql.clone()).map(|mut response| {
                    if sql.contains("DBMS_METADATA.GET_DDL") {
                        let ddl = response.rows[0][0].as_str().unwrap();
                        response.rows[0][0] = json!(match fault {
                            "default" => ddl.replace("NUMBER(38,4)", "NUMBER(38,4) DEFAULT APP.F()"),
                            "identity" => ddl.replace("NUMBER(38,4)", "NUMBER(38,4) GENERATED BY DEFAULT AS IDENTITY"),
                            "generated" => ddl.replace("NUMBER(38,4)", "NUMBER(38,4) GENERATED ALWAYS AS (1) VIRTUAL"),
                            "inline-check" => ddl.replace("NUMBER(38,4)", "NUMBER(38,4) CHECK (APP.F(ID)=1)"),
                            "wrong-column" => ddl.replace("\"LABEL\"", "\"OTHER\""),
                            _ => ddl.into(),
                        });
                    }
                    if sql.contains("FROM ALL_TAB_COLS") {
                        let flag = match fault {
                            "metadata-identity" | "metadata-unknown" => Some("IDENTITY_COLUMN"),
                            "metadata-on-null" => Some("DEFAULT_ON_NULL"),
                            "hidden" => Some("HIDDEN_COLUMN"),
                            "virtual" => Some("VIRTUAL_COLUMN"),
                            _ => None,
                        };
                        if let Some(flag) = flag {
                            let index = response.columns.iter().position(|name| name == flag).unwrap();
                            response.rows[0][index] =
                                json!(if fault == "metadata-unknown" { "UNKNOWN" } else { "YES" });
                        }
                    }
                    response
                });
                std::future::ready(result)
            };
            assert!(validate_insert_target(Dialect::OceanBase, &relation, &mut run).await.is_err(), "{fault}");
        }
        for fault in ["external", "unknown-external", "object-table"] {
            let mut run = |sql: String| {
                let result = oceanbase_query(&fixture, sql.clone()).map(|mut response| {
                    if sql.contains("FROM ALL_TABLES") {
                        let external = response.columns.iter().position(|name| name == "EXTERNAL").unwrap();
                        response.rows[0][external] = match fault {
                            "external" => json!("YES"),
                            "unknown-external" => Value::Null,
                            _ => json!("NO"),
                        };
                    }
                    if fault == "object-table" && sql.contains("DBMS_METADATA.GET_DDL") {
                        response.rows[0][0] = json!("CREATE TABLE RESULT OF APP.OBJECT_TYPE");
                    }
                    response
                });
                std::future::ready(result)
            };
            assert!(describe(Dialect::OceanBase, &key, &mut run).await.is_err(), "{fault}");
        }
    }

    #[tokio::test]
    async fn oceanbase_native_readonly_change_during_full_read_is_rejected() {
        let mut fixture = Fixture::new();
        fixture.tables.get_mut("OLD").unwrap().readonly = None;
        let calls = std::cell::Cell::new(0);
        let mut run = |sql: String| {
            let is_ddl = sql.contains("DBMS_METADATA.GET_DDL");
            let result = oceanbase_query(&fixture, sql).map(|mut response| {
                if is_ddl {
                    calls.set(calls.get() + 1);
                    if calls.get() > 1 {
                        response.rows[0][0] = json!(response.rows[0][0].as_str().unwrap().replace(" READ ONLY", ""));
                    }
                }
                response
            });
            std::future::ready(result)
        };
        let key = OracleTypeDataRelationKey { owner: "APP".into(), name: "OLD".into() };
        let relation = describe(Dialect::OceanBase, &key, &mut run).await.unwrap();
        let error = match read_data(Dialect::OceanBase, relation, &mut run).await {
            Err(error) => error,
            Ok(_) => panic!("A READ ONLY baseline that changed must not be accepted"),
        };
        assert!(error.contains("read-only state changed"), "{error}");
    }
    #[tokio::test]
    async fn full_temporal_values_keep_bc_and_ad_distinct_in_the_actual_reader() {
        let fixture = Fixture::new();
        for dialect in [Dialect::Oracle, Dialect::OceanBase, Dialect::Dameng] {
            let query = |sql: String, bc: bool| -> Result<db::QueryResult, String> {
                if sql.starts_with("SELECT TO_CHAR(T.") {
                    // The database's unsigned YYYY format loses the era. SYYYY
                    // returns the signed year, including for TIMESTAMP(9).
                    let year = if bc && sql.contains("SYYYY") { "-0001" } else { " 0001" };
                    return Ok(answer(
                        &["C0", "C1"],
                        vec![
                            vec![
                                json!(format!("{year}-01-02T03:04:05")),
                                json!(format!("{year}-01-02T03:04:05.123456789")),
                            ];
                            3
                        ],
                    ));
                }
                let mut response = if dialect == Dialect::OceanBase {
                    oceanbase_query(&fixture, sql.clone())?
                } else {
                    fixture.query(sql.clone())?
                };
                if sql.contains("FROM ALL_TAB_COLS") {
                    let kind = response.columns.iter().position(|name| name == "DATA_TYPE").unwrap();
                    response.rows[0][kind] = json!("DATE");
                    response.rows[1][kind] = json!("TIMESTAMP(9)");
                    let scale = response.columns.iter().position(|name| name == "DATA_SCALE").unwrap();
                    response.rows[1][scale] = json!(9);
                }
                Ok(response)
            };
            let key = OracleTypeDataRelationKey { owner: "APP".into(), name: "OLD".into() };
            let mut run = |sql| std::future::ready(query(sql, false));
            let relation = describe(dialect, &key, &mut run).await.unwrap();
            let ad = read_data(dialect, relation.clone(), &mut run).await.unwrap();
            let bc = read_data(dialect, relation, &mut |sql| std::future::ready(query(sql, true))).await.unwrap();
            assert_ne!(ad.baseline.fingerprint, bc.baseline.fingerprint, "{dialect:?}");
        }
    }
    #[tokio::test]
    async fn declared_width_budget_is_checked_before_any_business_rows_are_fetched() {
        let mut fixture = Fixture::new();
        fixture.tables.get_mut("OLD").unwrap().rows = vec![vec![Value::Null, Value::Null]; 100];
        let fetched = std::cell::Cell::new(false);
        let mut run = |sql: String| {
            let result = if sql.starts_with("SELECT TO_CHAR(T.") {
                fetched.set(true);
                Err("Unexpected data fetch".into())
            } else {
                fixture.query(sql.clone()).map(|mut response| {
                    if sql.contains("FROM ALL_TAB_COLS") {
                        for name in ["DATA_LENGTH", "CHAR_LENGTH"] {
                            let i = response.columns.iter().position(|column| column == name).unwrap();
                            response.rows[1][i] = json!(32767);
                        }
                    }
                    response
                })
            };
            std::future::ready(result)
        };
        let key = OracleTypeDataRelationKey { owner: "APP".into(), name: "OLD".into() };
        let relation = describe(Dialect::Oracle, &key, &mut run).await.unwrap();
        let error = match read_data(Dialect::Oracle, relation, &mut run).await {
            Ok(_) => panic!("Oversized metadata must not be fetched"),
            Err(error) => error,
        };
        assert!(error.contains("8 MiB"));
        assert!(!fetched.get());
    }
    #[tokio::test]
    async fn full_object_projection_keeps_atomic_null_distinct_from_an_all_null_object() {
        let fixture = Fixture::new();
        let query = |sql: String, atomic_null: bool| -> Result<db::QueryResult, String> {
            if sql.contains("FROM ALL_TYPES") {
                return Ok(answer(
                    &["TYPECODE", "ATTRIBUTES", "FINAL", "INCOMPLETE", "SUPERTYPE_NAME"],
                    vec![vec![json!("OBJECT"), json!(1), json!("YES"), json!("NO"), Value::Null]],
                ));
            }
            if sql.contains("FROM ALL_TYPE_ATTRS") {
                return Ok(answer(
                    &[
                        "ATTR_NAME",
                        "ATTR_NO",
                        "ATTR_TYPE_MOD",
                        "DATA_TYPE_OWNER",
                        "DATA_TYPE",
                        "DATA_LENGTH",
                        "DATA_PRECISION",
                        "DATA_SCALE",
                        "CHAR_USED",
                        "CHAR_LENGTH",
                    ],
                    vec![vec![
                        json!("ID"),
                        json!(1),
                        Value::Null,
                        Value::Null,
                        json!("NUMBER"),
                        json!(22),
                        json!(18),
                        json!(0),
                        Value::Null,
                        json!(0),
                    ]],
                ));
            }
            if sql.starts_with("SELECT TO_CHAR(T.") {
                return Ok(answer(
                    &["C0", "C1", "C2"],
                    vec![vec![json!("1"), json!(u8::from(atomic_null)), Value::Null]; 3],
                ));
            }
            let mut response = fixture.query(sql.clone())?;
            if sql.contains("FROM ALL_TAB_COLS") {
                let mut assign = |column: &str, value: Value| {
                    let index = response.columns.iter().position(|name| name == column).unwrap();
                    response.rows[1][index] = value;
                };
                assign("COLUMN_NAME", json!("VALUE"));
                assign("DATA_TYPE", json!("ROOT"));
                assign("DATA_TYPE_OWNER", json!("APP"));
            }
            Ok(response)
        };
        let key = OracleTypeDataRelationKey { owner: "APP".into(), name: "SRC".into() };
        let mut run = |sql| std::future::ready(query(sql, false));
        let relation = describe(Dialect::Oracle, &key, &mut run).await.unwrap();
        assert_eq!(
            relation.projection.iter().map(|p| (p.path.clone(), p.object_null)).collect::<Vec<_>>(),
            vec![(vec!["ID".into()], false), (vec!["VALUE".into()], true), (vec!["VALUE".into(), "ID".into()], false)]
        );
        let all_null = read_data(Dialect::Oracle, relation.clone(), &mut run).await.unwrap();
        let atomic_null =
            read_data(Dialect::Oracle, relation, &mut |sql| std::future::ready(query(sql, true))).await.unwrap();
        assert_ne!(all_null.baseline.fingerprint, atomic_null.baseline.fingerprint);
        assert_eq!(all_null.baseline.row_count, 3);
    }
    #[tokio::test]
    async fn actual_registration_and_cross_session_verification_preserve_full_duplicate_null_and_large_values() {
        let fixture = Fixture::new();
        let original = fixture.call("register", None, None).await.unwrap().manifest.unwrap();
        assert_eq!(original.original.row_count, 3);
        assert!(original.verified_target.is_none());
        let persisted = serde_json::to_string(&original).unwrap();
        assert!(!persisted.contains("90071992547409931234567890.1200"));
        let mut other_session = fixture.clone();
        other_session.tables.get_mut("RESULT").unwrap().rows =
            other_session.tables["EXPECTED"].rows.iter().rev().cloned().collect();
        other_session.tables.remove("SRC"); // external preparation removed the original TYPE reference
        let result = other_session
            .call("verify", Some(serde_json::from_str(&persisted).unwrap()), None)
            .await
            .unwrap()
            .manifest
            .unwrap();
        assert_eq!(result.verified_target.unwrap().row_count, 3);
        assert_eq!(result.old, original.old);
    }
    #[tokio::test]
    async fn baseline_identity_readonly_values_and_multiplicities_cannot_be_replaced_on_resume() {
        let fixture = Fixture::new();
        let original = fixture.call("register", None, None).await.unwrap().manifest.unwrap();
        for change in ["id", "readonly", "values", "duplicates"] {
            let mut changed = fixture.clone();
            match change {
                "id" => changed.tables.get_mut("OLD").unwrap().id = "new-id".into(),
                "readonly" => changed.tables.get_mut("OLD").unwrap().readonly = None,
                "values" => changed.tables.get_mut("OLD").unwrap().rows[0][1] = json!("changed"),
                _ => {
                    changed.tables.get_mut("OLD").unwrap().rows.pop();
                }
            }
            assert!(changed.call("verify", Some(original.clone()), None).await.is_err(), "{change}");
        }
    }
    #[tokio::test]
    async fn missing_or_lossy_complete_reads_never_create_an_integrity_fingerprint() {
        for fault in ["truncated", "has-more", "lossy-number", "large-cell", "silent-limit"] {
            let mut fixture = Fixture::new();
            fixture.fault = Some(fault);
            assert!(fixture.call("register", None, None).await.is_err(), "{fault}");
        }
        let mut fixture = Fixture::new();
        fixture.tables.get_mut("OLD").unwrap().rows[1][0] = json!("90071992547409931234567890.1201");
        assert!(fixture.call("register", None, None).await.is_err());
    }
    #[tokio::test]
    async fn bounded_insert_requires_the_same_empty_scalar_target_without_implicit_execution() {
        let fixture = Fixture::new();
        let manifest = fixture.call("register", None, None).await.unwrap().manifest.unwrap();
        let sql = "INSERT INTO APP.RESULT(ID,LABEL) SELECT ID,LABEL FROM APP.EXPECTED";
        let preview = fixture.call("validate_insert", Some(manifest.clone()), Some(sql)).await.unwrap();
        assert!(preview.insert_sql.unwrap().starts_with("INSERT INTO \"APP\".\"RESULT\""));
        let mut replaced = fixture.clone();
        replaced.tables.get_mut("RESULT").unwrap().id = "replacement".into();
        assert!(replaced.call("validate_insert", preview.manifest, Some(sql)).await.is_err());
        for fault in ["trigger", "function-index"] {
            let mut blocked = fixture.clone();
            blocked.fault = Some(fault);
            assert!(blocked.call("validate_insert", Some(manifest.clone()), Some(sql)).await.is_err(), "{fault}");
        }
        let mut nonempty = fixture.clone();
        nonempty.tables.get_mut("RESULT").unwrap().rows.push(vec![json!("1"), json!("x")]);
        assert!(nonempty.call("validate_insert", Some(manifest), Some(sql)).await.is_err());
    }
    #[test]
    fn exact_decimal_canonicalization_never_uses_a_float() {
        assert_eq!(
            decimal("900719925474099312345678901234567890.12000").unwrap(),
            "90071992547409931234567890123456789012e-2"
        );
        assert_eq!(decimal("1.2000E+2").unwrap(), decimal("120").unwrap());
        assert_eq!(decimal("-0.000").unwrap(), "0");
        for value in ["NaN", "1,2", "1.2.3", "", "1E9999"] {
            assert!(decimal(value).is_err());
        }
    }
    #[test]
    fn binary_multisets_preserve_duplicates_nulls_and_exact_text() {
        let ty = vec![ScalarType::parse("VARCHAR2(80 BYTE)").unwrap()];
        let encode = |rows: Vec<Option<&str>>| {
            digest(rows.into_iter().map(|s| encode_row(&[s.map(String::from)], &ty)).collect(), &ty, false)
        };
        assert_eq!(encode(vec![Some("A"), None, Some("A")]), encode(vec![None, Some("A"), Some("A")]));
        assert_ne!(encode(vec![Some("A"), None, Some("A")]), encode(vec![None, Some("A")]));
        assert_ne!(encode(vec![Some("A")]), encode(vec![Some("a")]));
        assert_ne!(encode(vec![Some("A ")]), encode(vec![Some("A")]));
        assert_ne!(encode(vec![None]), encode(vec![Some("")]));
    }
}
