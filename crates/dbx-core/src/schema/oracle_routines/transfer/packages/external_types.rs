use super::super::super::references::{lossless_catalog_value, CatalogReadProof};
use super::*;

pub(super) fn manifest(proofs: &[CatalogReadProof]) -> Value {
    Value::Array(proofs.iter().map(|proof| match proof {
        CatalogReadProof::Query { sql, columns, rows } => serde_json::json!({
            "sql": sql, "columns": columns,
            "rows": rows.iter().map(|row| row.iter().map(lossless_catalog_value).collect::<Vec<_>>()).collect::<Vec<_>>()
        }),
        CatalogReadProof::Source { .. } => unreachable!("External table types retain only server catalog reads"),
    }).collect())
}

pub(super) async fn read(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    table: &FrozenTableDdl,
) -> Result<Vec<CatalogReadProof>, String> {
    let mut proofs = Vec::new();
    let types = table.external_types();
    for (owner, name) in &types {
        let result = read_type(catalog, endpoint, owner, name, &mut proofs).await;
        result.map_err(|error| format!("External column type {owner}.{name}: {error}"))?;
    }
    if !types.is_empty() && endpoint.database_type == DatabaseType::OceanbaseOracle {
        return Err("The target TYPE is visible, but SQL object-type columns are not verified for OceanBase Oracle (the available target rejects this CREATE TABLE form); retain the table draft and use a supported target column type. No TYPE is migrated automatically".into());
    }
    Ok(proofs)
}

async fn read_type(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    owner: &str,
    name: &str,
    proofs: &mut Vec<CatalogReadProof>,
) -> Result<(), String> {
    let namespace_sql = format!("SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, STATUS, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD\"T\"HH24:MI:SS') LAST_DDL_TIME FROM ALL_OBJECTS WHERE OWNER = {} AND OBJECT_NAME = {} AND OBJECT_TYPE IN ('TABLE','VIEW','SEQUENCE','PROCEDURE','FUNCTION','PACKAGE','MATERIALIZED VIEW','TYPE','SYNONYM') ORDER BY OBJECT_ID", literal(owner), literal(name));
    let before = pending::observed(catalog, namespace_sql.clone(), proofs).await?;
    if before.rows.len() != 1 {
        return Err("the exact target TYPE is not uniquely visible; create or expose the required type and validate again (it is not migrated automatically)".into());
    }
    let row = &before.rows[0];
    if before.text(row, "OWNER")? != owner
        || before.text(row, "OBJECT_NAME")? != name
        || before.text(row, "OBJECT_TYPE")? != "TYPE"
        || before.text(row, "STATUS")? != "VALID"
    {
        return Err("the target namespace is not the exact VALID TYPE".into());
    }
    before.integer(row, "OBJECT_ID")?;
    before.text(row, "LAST_DDL_TIME")?;
    let definition = pending::observed(
        catalog,
        format!("SELECT * FROM ALL_TYPES WHERE OWNER = {} AND TYPE_NAME = {}", literal(owner), literal(name)),
        proofs,
    )
    .await?;
    if definition.rows.len() != 1 {
        return Err("the complete target type definition is not visible".into());
    }
    let row = &definition.rows[0];
    if definition.text(row, "OWNER")? != owner
        || definition.text(row, "TYPE_NAME")? != name
        || definition.text(row, "TYPECODE")? != "OBJECT"
        || definition.text(row, "INCOMPLETE")? != "NO"
        || definition.text(row, "INSTANTIABLE")? != "YES"
        || definition.integer(row, "METHODS")? != 0
        || !definition.cell(row, "SUPERTYPE_OWNER")?.is_null()
        || !definition.cell(row, "SUPERTYPE_NAME")?.is_null()
    {
        return Err("only complete, instantiable object types without methods or inheritance have a verified table-column contract; retain the draft for manual correction".into());
    }
    let expected = definition.integer(row, "ATTRIBUTES")?;
    if expected == 0 {
        return Err("the object type has no complete attribute list".into());
    }
    let mut count = 0u64;
    let mut names = HashSet::new();
    loop {
        let attributes = pending::observed(catalog, format!("SELECT * FROM (SELECT A.*, ROW_NUMBER() OVER (ORDER BY ATTR_NO, ATTR_NAME) RN FROM ALL_TYPE_ATTRS A WHERE OWNER = {} AND TYPE_NAME = {}) WHERE RN > {count} AND RN <= {} ORDER BY RN", literal(owner), literal(name), count + PAGE_SIZE as u64), proofs).await?;
        if attributes.rows.len() > PAGE_SIZE {
            return Err("the type attribute page is incomplete".into());
        }
        for row in &attributes.rows {
            count += 1;
            if count > expected
                || attributes.integer(row, "RN")? != count
                || attributes.integer(row, "ATTR_NO")? != count
                || attributes.text(row, "OWNER")? != owner
                || attributes.text(row, "TYPE_NAME")? != name
                || !names.insert(attributes.text(row, "ATTR_NAME")?)
                || !attributes.cell(row, "ATTR_TYPE_OWNER")?.is_null()
                || attributes.text(row, "INHERITED")? != "NO"
                || !attributes.cell(row, "ATTR_TYPE_MOD")?.is_null()
                || !matches!(
                    attributes.text(row, "ATTR_TYPE_NAME")?.as_str(),
                    "NUMBER"
                        | "FLOAT"
                        | "VARCHAR2"
                        | "CHAR"
                        | "NVARCHAR2"
                        | "NCHAR"
                        | "RAW"
                        | "DATE"
                        | "BINARY_FLOAT"
                        | "BINARY_DOUBLE"
                        | "CLOB"
                        | "NCLOB"
                        | "BLOB"
                )
            {
                return Err(
                    "the ordered scalar type attributes are incomplete or contain an unverified nested type".into()
                );
            }
        }
        if attributes.rows.len() < PAGE_SIZE {
            break;
        }
    }
    if count != expected {
        return Err("the complete type attribute count does not match ALL_TYPES".into());
    }
    if owner != endpoint.schema {
        let grants = pending::observed(catalog, format!("SELECT GRANTEE, PRIVILEGE FROM SYS.ALL_TAB_PRIVS WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND GRANTEE IN ({}, 'PUBLIC') AND PRIVILEGE = 'EXECUTE' ORDER BY GRANTEE, PRIVILEGE", literal(owner), literal(name), literal(&endpoint.schema)), proofs).await?;
        if grants.rows.is_empty() {
            if owner == "SYS" {
                return Err("a direct or PUBLIC EXECUTE grant is required for a SYS type".into());
            }
            let login = pending::observed(catalog, "SELECT USER AS LOGIN_OWNER FROM DUAL".into(), proofs).await?;
            if login.rows.len() != 1 {
                return Err("the defining owner's direct system grants are unknown".into());
            }
            let from = if login.text(&login.rows[0], "LOGIN_OWNER")? == endpoint.schema {
                "USER_SYS_PRIVS WHERE PRIVILEGE = 'EXECUTE ANY TYPE'".into()
            } else {
                format!(
                    "SYS.DBA_SYS_PRIVS WHERE GRANTEE = {} AND PRIVILEGE = 'EXECUTE ANY TYPE'",
                    literal(&endpoint.schema)
                )
            };
            let system =
                pending::observed(catalog, format!("SELECT PRIVILEGE FROM {from} ORDER BY PRIVILEGE"), proofs).await?;
            if system.rows.is_empty() {
                return Err("a direct or PUBLIC EXECUTE grant, or direct EXECUTE ANY TYPE, is required; enabled roles and EXECUTE ANY PROCEDURE do not authorize a column TYPE".into());
            }
        }
    }
    let after = pending::observed(catalog, namespace_sql, proofs).await?;
    if before.columns != after.columns || before.rows != after.rows {
        return Err("the target type changed while its definition was read".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Catalog(std::sync::Mutex<std::collections::VecDeque<(&'static str, Value)>>);
    #[async_trait::async_trait]
    impl RoutineCatalog for Catalog {
        async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
            let (expected, value) = self.0.lock().unwrap().pop_front().expect("unexpected type query");
            assert!(sql.contains(expected), "{sql}");
            serde_json::from_value(value).map_err(|error| error.to_string())
        }
        async fn source(&self, _: &RoutineIdentity) -> Result<SourceReply, String> {
            panic!("Type verification must not invoke or fetch a user routine")
        }
    }
    fn fixture(owner: &str, direct: bool) -> (Catalog, RoutineEndpoint, FrozenTableDdl) {
        let namespace = json!({"columns":["OWNER","OBJECT_NAME","OBJECT_TYPE","OBJECT_ID","STATUS","LAST_DDL_TIME"],"rows":[[owner,"SHAPE","TYPE",9007199254740993u64,"VALID","2026-10-23T00:00:00"]]});
        let mut replies = std::collections::VecDeque::from([
            ("FROM ALL_OBJECTS", namespace.clone()),
            (
                "FROM ALL_TYPES",
                json!({"columns":["OWNER","TYPE_NAME","TYPECODE","INCOMPLETE","INSTANTIABLE","METHODS","SUPERTYPE_OWNER","SUPERTYPE_NAME","ATTRIBUTES"],"rows":[[owner,"SHAPE","OBJECT","NO","YES",0,null,null,1]]}),
            ),
            (
                "FROM ALL_TYPE_ATTRS",
                json!({"columns":["OWNER","TYPE_NAME","ATTR_NAME","ATTR_TYPE_MOD","ATTR_TYPE_OWNER","ATTR_TYPE_NAME","ATTR_NO","INHERITED","RN","LENGTH","NUMBER_PRECISION","SCALE"],"rows":[[owner,"SHAPE","N",null,null,"NUMBER",1,"NO",1,22,12,3]]}),
            ),
        ]);
        if owner != "T" {
            replies.push_back(("SYS.ALL_TAB_PRIVS", json!({"columns":["GRANTEE","PRIVILEGE"],"rows":if direct {vec![json!(["T","EXECUTE"])]} else {vec![]}})));
            if !direct && owner != "SYS" {
                replies.push_back(("LOGIN_OWNER", json!({"columns":["LOGIN_OWNER"],"rows":[["T"]]})));
                replies.push_back((
                    "USER_SYS_PRIVS WHERE PRIVILEGE = 'EXECUTE ANY TYPE'",
                    json!({"columns":["PRIVILEGE"],"rows":[["EXECUTE ANY TYPE"]]}),
                ));
            }
        }
        replies.push_back(("FROM ALL_OBJECTS", namespace));
        let endpoint = RoutineEndpoint {
            connection_id: "target".into(),
            database: "tenant".into(),
            schema: "T".into(),
            database_type: DatabaseType::Oracle,
            generation: 1,
        };
        let table = FrozenTableDdl::from_server_plan(
            "SOURCE",
            "T",
            "FINAL",
            &format!("CREATE TABLE FINAL (V \"{owner}\".SHAPE)"),
            json!({}),
            None,
        )
        .unwrap();
        (Catalog(std::sync::Mutex::new(replies)), endpoint, table)
    }
    #[tokio::test]
    async fn exact_owned_direct_and_any_type_grants_retain_complete_lossless_read_proofs() {
        for (owner, direct, count) in [("T", true, 4), ("EXT", true, 5), ("EXT", false, 7), ("SYS", true, 5)] {
            let (catalog, endpoint, table) = fixture(owner, direct);
            let proofs = read(&catalog, &endpoint, &table).await.unwrap();
            assert_eq!(proofs.len(), count);
            assert!(catalog.0.lock().unwrap().is_empty());
            let encoded = serde_json::to_string(&manifest(&proofs)).unwrap();
            assert!(encoded.contains("9007199254740993"));
            assert!(!encoded.contains("9007199254740992"));
        }
    }
    #[tokio::test]
    async fn visible_ob_type_does_not_prove_sql_object_column_support() {
        let (catalog, mut endpoint, table) = fixture("EXT", true);
        endpoint.database_type = DatabaseType::OceanbaseOracle;
        let error = read(&catalog, &endpoint, &table).await.err().unwrap();
        assert!(error.contains("SQL object-type columns"));
        assert!(catalog.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn absent_invalid_partial_nested_changed_or_unauthorized_types_block_without_writes() {
        for case in [
            "absent",
            "invalid",
            "methods",
            "incomplete",
            "nested",
            "missing",
            "order",
            "truncated",
            "concurrent",
            "sys-grant",
            "any-procedure",
        ] {
            let owner = if case == "sys-grant" { "SYS" } else { "EXT" };
            let (catalog, endpoint, table) = fixture(owner, false);
            {
                let mut replies = catalog.0.lock().unwrap();
                match case {
                    "absent" => replies[0].1["rows"] = json!([]),
                    "invalid" => replies[0].1["rows"][0][4] = json!("INVALID"),
                    "methods" => replies[1].1["rows"][0][5] = json!(1),
                    "incomplete" => replies[1].1["rows"][0][3] = json!("YES"),
                    "nested" => replies[2].1["rows"][0][4] = json!("EXT"),
                    "missing" => replies[2].1["rows"] = json!([]),
                    "order" => replies[2].1["rows"][0][8] = json!(2),
                    "truncated" => replies[2].1["truncated"] = json!(true),
                    "concurrent" => replies.back_mut().unwrap().1["rows"][0][3] = json!(77),
                    "any-procedure" => replies[5].1["rows"] = json!([]),
                    _ => (),
                }
            }
            assert!(read(&catalog, &endpoint, &table).await.is_err(), "{case}");
        }
    }
}
