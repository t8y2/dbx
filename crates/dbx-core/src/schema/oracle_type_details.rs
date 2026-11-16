//! Oracle-family type dictionaries, shared by Agent and external JDBC query
//! transports. Keep dictionary completeness separate from source/DDL semantics.

use super::{is_oracle_external_driver_config, sql_string};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use db::{
    CustomTypeDetails, CustomTypeKind, CustomTypeProperties, OracleTypeAttribute, OracleTypeCollection,
    OracleTypeMetadata, OracleTypeMethod, OracleTypeMethodParameter, TypeMetadataRead, TypeMetadataState,
};
use serde_json::Value;
use std::future::Future;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Dialect {
    Oracle,
    OceanBase,
    Dameng,
}

pub(super) fn dialect(config: &ConnectionConfig) -> Option<Dialect> {
    match config.db_type {
        DatabaseType::Oracle => Some(Dialect::Oracle),
        DatabaseType::OceanbaseOracle => Some(Dialect::OceanBase),
        DatabaseType::Dameng => Some(Dialect::Dameng),
        DatabaseType::Jdbc
            if config
                .connection_string
                .as_deref()
                .is_some_and(|url| url.trim().to_ascii_lowercase().starts_with("jdbc:oceanbase:oracle://")) =>
        {
            Some(Dialect::OceanBase)
        }
        DatabaseType::Jdbc if is_oracle_external_driver_config(config) => Some(Dialect::Oracle),
        DatabaseType::Jdbc
            if config
                .connection_string
                .as_deref()
                .is_some_and(|url| url.trim().to_ascii_lowercase().starts_with("jdbc:dm:")) =>
        {
            Some(Dialect::Dameng)
        }
        _ => None,
    }
}

fn available() -> TypeMetadataRead {
    TypeMetadataRead { state: TypeMetadataState::Available, reason: None }
}

fn incomplete(read: &mut TypeMetadataRead, reason: impl Into<String>) {
    if read.state == TypeMetadataState::Unavailable || read.state == TypeMetadataState::Unsupported {
        return;
    }
    read.state = TypeMetadataState::Incomplete;
    let reason = reason.into();
    read.reason = Some(match read.reason.take() {
        Some(previous) => format!("{previous}; {reason}"),
        None => reason,
    });
}

struct Dictionary {
    result: Option<db::QueryResult>,
    read: TypeMetadataRead,
}

impl Dictionary {
    fn new(result: Result<db::QueryResult, String>, required: &[&str]) -> Self {
        match result {
            Err(error) => Self {
                result: None,
                read: TypeMetadataRead { state: TypeMetadataState::Unavailable, reason: Some(error) },
            },
            Ok(result) => {
                let mut read = available();
                if result.truncated || result.has_more {
                    incomplete(&mut read, "Dictionary rows were truncated");
                }
                let missing: Vec<_> = required
                    .iter()
                    .filter(|name| !result.columns.iter().any(|column| column.eq_ignore_ascii_case(name)))
                    .copied()
                    .collect();
                if !missing.is_empty() {
                    incomplete(&mut read, format!("Missing dictionary columns: {}", missing.join(", ")));
                }
                Self { result: Some(result), read }
            }
        }
    }

    fn value<'a>(&self, row: &'a [Value], column: &str) -> Option<&'a Value> {
        self.result
            .as_ref()?
            .columns
            .iter()
            .position(|name| name.eq_ignore_ascii_case(column))
            .and_then(|index| row.get(index))
            .filter(|value| !value.is_null())
    }

    fn has_column(&self, column: &str) -> bool {
        self.result.as_ref().is_some_and(|result| result.columns.iter().any(|name| name.eq_ignore_ascii_case(column)))
    }

    fn text(&self, row: &[Value], column: &str) -> Option<String> {
        self.value(row, column).and_then(|value| match value {
            Value::String(text) if !text.is_empty() => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
    }

    fn integer(&self, row: &[Value], column: &str) -> Option<i64> {
        self.value(row, column).and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
    }

    fn small_integer(&self, row: &[Value], column: &str) -> Option<i32> {
        self.integer(row, column).and_then(|value| value.try_into().ok())
    }

    fn count(&self, row: &[Value], column: &str) -> Option<u32> {
        self.integer(row, column).and_then(|value| value.try_into().ok())
    }

    fn yes_no(&self, row: &[Value], column: &str) -> Option<bool> {
        match self.text(row, column)?.to_ascii_uppercase().as_str() {
            "YES" => Some(true),
            "NO" => Some(false),
            _ => None,
        }
    }

    fn target_rows(&self, owner: &str, name: &str, name_column: &str) -> Vec<&[Value]> {
        self.result
            .iter()
            .flat_map(|result| result.rows.iter())
            .filter(|row| {
                self.text(row, "OWNER").as_deref() == Some(owner)
                    && self.text(row, name_column).as_deref() == Some(name)
            })
            .map(Vec::as_slice)
            .collect()
    }
}

fn check_count(read: &mut TypeMetadataRead, expected: Option<u32>, actual: usize) {
    match expected {
        Some(expected) if expected as usize != actual => {
            incomplete(read, format!("Dictionary count is {expected}, but {actual} rows were read"));
        }
        None => incomplete(read, "Dictionary count is unknown"),
        _ => {}
    }
}

fn precision(dictionary: &Dictionary, row: &[Value], dialect: Dialect) -> Option<i32> {
    // OceanBase 4.2.5.7 exposes NUMBER_PRECISION, while Oracle uses PRECISION.
    let columns = if dialect == Dialect::OceanBase {
        ["NUMBER_PRECISION", "PRECISION"]
    } else {
        ["PRECISION", "NUMBER_PRECISION"]
    };
    columns.iter().find_map(|column| dictionary.small_integer(row, column))
}

struct TypeDimensions {
    length: Option<i64>,
    precision: Option<i32>,
    scale: Option<i32>,
}

fn type_dimensions(dictionary: &Dictionary, row: &[Value], type_column: &str, dialect: Dialect) -> TypeDimensions {
    let mut dimensions = TypeDimensions {
        length: dictionary.integer(row, "LENGTH"),
        precision: precision(dictionary, row, dialect),
        scale: dictionary.small_integer(row, "SCALE"),
    };
    if dialect == Dialect::OceanBase {
        // OB 4.2.5 exposes internal accuracy sentinels (-1 / -85), and even
        // VARCHAR2 rows have NUMBER_PRECISION=2, SCALE=-1. These are not SQL
        // type dimensions. Preserve valid negative NUMBER scales, e.g. -2.
        let type_name = dictionary.text(row, type_column).unwrap_or_default().to_ascii_uppercase();
        let decimal = matches!(type_name.as_str(), "NUMBER" | "DECIMAL" | "NUMERIC" | "DEC");
        dimensions.length = dimensions.length.filter(|value| *value >= 0);
        dimensions.precision = dimensions.precision.filter(|value| (decimal || type_name == "FLOAT") && *value > 0);
        dimensions.scale = dimensions.scale.filter(|value| decimal && *value != -85);
    }
    dimensions
}

fn check_precision_column(dictionary: &Dictionary, read: &mut TypeMetadataRead) {
    if !dictionary.has_column("PRECISION") && !dictionary.has_column("NUMBER_PRECISION") {
        incomplete(read, "Missing dictionary precision column");
    }
}

fn method_rows<'a>(dictionary: &'a Dictionary, owner: &str, name: &str, method: &OracleTypeMethod) -> Vec<&'a [Value]> {
    // METHOD_NO is required to distinguish overloads; never attach a same-name
    // parameter from a different overload when that identity is unavailable.
    let Some(number) = method.number else { return Vec::new() };
    dictionary
        .target_rows(owner, name, "TYPE_NAME")
        .into_iter()
        .filter(|row| {
            dictionary.text(row, "METHOD_NAME").as_deref() == Some(&method.name)
                && dictionary.small_integer(row, "METHOD_NO") == Some(number)
        })
        .collect()
}

pub(super) async fn read<F, Fut>(
    dialect: Dialect,
    schema: &str,
    name: &str,
    mut run: F,
) -> Result<CustomTypeDetails, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<db::QueryResult, String>>,
{
    if schema.is_empty() || name.is_empty() {
        return Err("schema and type name are required".to_string());
    }
    let owner = sql_string(schema);
    let type_name = sql_string(name);
    let predicate = format!("OWNER = {owner} AND TYPE_NAME = {type_name}");
    let objects = Dictionary::new(
        run(format!("SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, STATUS FROM ALL_OBJECTS WHERE OWNER = {owner} AND OBJECT_NAME = {type_name} AND OBJECT_TYPE IN ('TYPE', 'TYPE BODY')")).await,
        &["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "STATUS"],
    );
    // SELECT * tolerates vendor/version column differences without requiring a
    // wider catalog privilege or silently substituting invented field values.
    let types = Dictionary::new(
        run(format!("SELECT * FROM ALL_TYPES WHERE {predicate}")).await,
        &[
            "OWNER",
            "TYPE_NAME",
            "TYPECODE",
            "ATTRIBUTES",
            "METHODS",
            "FINAL",
            "INSTANTIABLE",
            "SUPERTYPE_OWNER",
            "SUPERTYPE_NAME",
        ],
    );
    let object_rows = objects.target_rows(schema, name, "OBJECT_NAME");
    let type_row = object_rows.iter().copied().find(|row| objects.text(row, "OBJECT_TYPE").as_deref() == Some("TYPE"));
    let body_row =
        object_rows.iter().copied().find(|row| objects.text(row, "OBJECT_TYPE").as_deref() == Some("TYPE BODY"));
    let general_rows = types.target_rows(schema, name, "TYPE_NAME");
    let general = general_rows.first().copied();
    if type_row.is_none() && general.is_none() {
        let reasons: Vec<_> = [&objects.read.reason, &types.read.reason].into_iter().flatten().cloned().collect();
        return Err(format!(
            "Type {schema}.{name} was not found or is not visible{}",
            if reasons.is_empty() { String::new() } else { format!(": {}", reasons.join("; ")) }
        ));
    }

    let type_code = general.and_then(|row| types.text(row, "TYPECODE"));
    let kind = match type_code.as_deref().map(str::to_ascii_uppercase).as_deref() {
        Some("OBJECT") => CustomTypeKind::Object,
        Some("COLLECTION") => CustomTypeKind::Collection,
        _ => CustomTypeKind::Other,
    };
    let attribute_count = general.and_then(|row| types.count(row, "ATTRIBUTES"));
    let method_count = general.and_then(|row| types.count(row, "METHODS"));
    let mut properties_read = types.read.clone();
    if general.is_none() || type_code.is_none() {
        incomplete(&mut properties_read, "Type properties are not visible");
    }
    if objects.read.state != TypeMetadataState::Available
        || type_row.and_then(|row| objects.text(row, "STATUS")).is_none()
    {
        incomplete(
            &mut properties_read,
            objects.read.reason.clone().unwrap_or_else(|| "Type status is unknown".to_string()),
        );
    }
    let mut body_read = objects.read.clone();
    if body_row.is_some_and(|row| objects.text(row, "STATUS").is_none()) {
        incomplete(&mut body_read, "Type body status is unknown");
    }

    let attrs = Dictionary::new(
        run(format!("SELECT * FROM ALL_TYPE_ATTRS WHERE {predicate}")).await,
        &["OWNER", "TYPE_NAME", "ATTR_NAME", "ATTR_NO", "ATTR_TYPE_OWNER", "ATTR_TYPE_NAME", "LENGTH", "SCALE"],
    );
    let mut attributes_read = attrs.read.clone();
    check_precision_column(&attrs, &mut attributes_read);
    let mut attributes = Vec::new();
    for row in attrs.target_rows(schema, name, "TYPE_NAME") {
        let Some(attr_name) = attrs.text(row, "ATTR_NAME") else {
            incomplete(&mut attributes_read, "An attribute name is missing");
            continue;
        };
        let dimensions = type_dimensions(&attrs, row, "ATTR_TYPE_NAME", dialect);
        let attribute = OracleTypeAttribute {
            name: attr_name,
            ordinal: attrs.small_integer(row, "ATTR_NO"),
            type_owner: attrs.text(row, "ATTR_TYPE_OWNER"),
            type_name: attrs.text(row, "ATTR_TYPE_NAME"),
            type_modifier: attrs.text(row, "ATTR_TYPE_MOD"),
            length: dimensions.length,
            precision: dimensions.precision,
            scale: dimensions.scale,
        };
        if attribute.ordinal.is_none() || attribute.type_name.is_none() {
            incomplete(&mut attributes_read, "Attribute order or type is unknown");
        }
        attributes.push(attribute);
    }
    attributes.sort_by_key(|attribute| attribute.ordinal.unwrap_or(i32::MAX));
    check_count(&mut attributes_read, attribute_count, attributes.len());

    let method_dictionary = Dictionary::new(
        run(format!("SELECT * FROM ALL_TYPE_METHODS WHERE {predicate}")).await,
        &["OWNER", "TYPE_NAME", "METHOD_NAME", "METHOD_NO", "METHOD_TYPE", "PARAMETERS", "RESULTS"],
    );
    let mut methods_read = method_dictionary.read.clone();
    let mut methods = Vec::new();
    for row in method_dictionary.target_rows(schema, name, "TYPE_NAME") {
        let Some(method_name) = method_dictionary.text(row, "METHOD_NAME") else {
            incomplete(&mut methods_read, "A method name is missing");
            continue;
        };
        let number = method_dictionary.small_integer(row, "METHOD_NO");
        if number.is_none() || method_dictionary.text(row, "METHOD_TYPE").is_none() {
            incomplete(&mut methods_read, "A method overload number or kind is unknown");
        }
        methods.push(OracleTypeMethod {
            name: method_name,
            number,
            kind: method_dictionary.text(row, "METHOD_TYPE"),
            parameter_count: method_dictionary.count(row, "PARAMETERS"),
            result_count: method_dictionary.count(row, "RESULTS"),
            parameters: Vec::new(),
            results: Vec::new(),
            parameters_read: available(),
            results_read: available(),
        });
    }
    methods.sort_by_key(|method| method.number.unwrap_or(i32::MAX));
    check_count(&mut methods_read, method_count, methods.len());
    if !methods.is_empty() {
        let params = Dictionary::new(
            run(format!("SELECT * FROM ALL_METHOD_PARAMS WHERE {predicate}")).await,
            &[
                "OWNER",
                "TYPE_NAME",
                "METHOD_NAME",
                "METHOD_NO",
                "PARAM_NAME",
                "PARAM_NO",
                "PARAM_MODE",
                "PARAM_TYPE_OWNER",
                "PARAM_TYPE_NAME",
            ],
        );
        let results = Dictionary::new(
            run(format!("SELECT * FROM ALL_METHOD_RESULTS WHERE {predicate}")).await,
            &["OWNER", "TYPE_NAME", "METHOD_NAME", "METHOD_NO", "RESULT_TYPE_OWNER", "RESULT_TYPE_NAME"],
        );
        for method in &mut methods {
            method.parameters_read = params.read.clone();
            method.results_read = results.read.clone();
            for row in method_rows(&params, schema, name, method) {
                method.parameters.push(OracleTypeMethodParameter {
                    name: params.text(row, "PARAM_NAME"),
                    ordinal: params.small_integer(row, "PARAM_NO"),
                    mode: params.text(row, "PARAM_MODE"),
                    type_owner: params.text(row, "PARAM_TYPE_OWNER"),
                    type_name: params.text(row, "PARAM_TYPE_NAME"),
                    type_modifier: params.text(row, "PARAM_TYPE_MOD"),
                });
            }
            method.parameters.sort_by_key(|parameter| parameter.ordinal.unwrap_or(i32::MAX));
            for row in method_rows(&results, schema, name, method) {
                method.results.push(OracleTypeMethodParameter {
                    name: None,
                    ordinal: None,
                    mode: None,
                    type_owner: results.text(row, "RESULT_TYPE_OWNER"),
                    type_name: results.text(row, "RESULT_TYPE_NAME"),
                    type_modifier: results.text(row, "RESULT_TYPE_MOD"),
                });
            }
            check_count(&mut method.parameters_read, method.parameter_count, method.parameters.len());
            check_count(&mut method.results_read, method.result_count, method.results.len());
            if method.parameters.iter().any(|parameter| parameter.ordinal.is_none() || parameter.type_name.is_none()) {
                incomplete(&mut method.parameters_read, "Parameter order or type is unknown");
            }
            if method.results.iter().any(|result| result.type_name.is_none()) {
                incomplete(&mut method.results_read, "Result type is unknown");
            }
            if method.parameters_read.state != TypeMetadataState::Available
                || method.results_read.state != TypeMetadataState::Available
            {
                incomplete(
                    &mut methods_read,
                    format!("Method {} has incomplete parameter or result metadata", method.name),
                );
            }
        }
    }

    let collections = Dictionary::new(
        run(format!("SELECT * FROM ALL_COLL_TYPES WHERE {predicate}")).await,
        &["OWNER", "TYPE_NAME", "COLL_TYPE", "ELEM_TYPE_OWNER", "ELEM_TYPE_NAME", "LENGTH", "SCALE"],
    );
    let mut collection_read = collections.read.clone();
    check_precision_column(&collections, &mut collection_read);
    let collection_rows = collections.target_rows(schema, name, "TYPE_NAME");
    let collection = collection_rows.first().map(|row| {
        let dimensions = type_dimensions(&collections, row, "ELEM_TYPE_NAME", dialect);
        let upper_bound = collections.integer(row, "UPPER_BOUND").filter(|value| *value > 0);
        let raw_kind = collections.text(row, "COLL_TYPE");
        // OB 4.2.5 reports TABLE for both SQL collection kinds. A positive
        // UPPER_BOUND is documented only for varrays; -1 means unbounded.
        let collection_kind =
            if dialect == Dialect::OceanBase && raw_kind.as_deref() == Some("TABLE") && upper_bound.is_some() {
                Some("VARRAY".to_string())
            } else {
                raw_kind
            };
        if dialect == Dialect::OceanBase && !collections.has_column("UPPER_BOUND") {
            incomplete(&mut collection_read, "Collection upper bound column is missing");
        }
        OracleTypeCollection {
            kind: collection_kind,
            upper_bound,
            element_owner: collections.text(row, "ELEM_TYPE_OWNER"),
            element_name: collections.text(row, "ELEM_TYPE_NAME"),
            element_modifier: collections.text(row, "ELEM_TYPE_MOD"),
            length: dimensions.length,
            precision: dimensions.precision,
            scale: dimensions.scale,
        }
    });
    if kind == CustomTypeKind::Collection && collection.is_none() {
        incomplete(&mut collection_read, "Collection details are not visible");
    }
    if let Some(collection) = &collection {
        if collection.kind.is_none() || collection.element_name.is_none() {
            incomplete(&mut collection_read, "Collection kind or element type is unknown");
        }
        if collection.kind.as_deref().is_some_and(|kind| kind.to_ascii_uppercase().contains("ARRAY"))
            && collection.upper_bound.is_none()
        {
            incomplete(&mut collection_read, "Collection upper bound is unknown");
        }
    }
    Ok(CustomTypeDetails {
        name: name.to_string(),
        schema: schema.to_string(),
        kind,
        comment: None,
        members: Vec::new(),
        properties: CustomTypeProperties::default(),
        ddl: None,
        oracle_metadata: Some(OracleTypeMetadata {
            status: type_row.and_then(|row| objects.text(row, "STATUS")),
            type_code,
            is_final: general.and_then(|row| types.yes_no(row, "FINAL")),
            instantiable: general.and_then(|row| types.yes_no(row, "INSTANTIABLE")),
            supertype_owner: general.and_then(|row| types.text(row, "SUPERTYPE_OWNER")),
            supertype_name: general.and_then(|row| types.text(row, "SUPERTYPE_NAME")),
            attribute_count,
            method_count,
            body_visible: if body_row.is_some() {
                Some(true)
            } else if objects.read.state == TypeMetadataState::Available {
                Some(false)
            } else {
                None
            },
            body_status: body_row.and_then(|row| objects.text(row, "STATUS")),
            properties_read,
            body_read,
            attributes_read,
            methods_read,
            collection_read,
            attributes,
            methods,
            collection,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn explicit_oceanbase_oracle_jdbc_mode_selects_only_the_oceanbase_type_dialect() {
        let mut config: ConnectionConfig = serde_json::from_value(json!({
            "id": "ob-jdbc", "name": "OB JDBC", "db_type": "jdbc", "host": "localhost", "port": 2881,
            "username": "APP", "password": "", "database": "APP", "jdbc_driver_class": "com.oceanbase.jdbc.Driver"
        }))
        .unwrap();
        for (url, expected) in [
            (" JDBC:OceanBase:Oracle://localhost:2881/APP ", Some(Dialect::OceanBase)),
            ("jdbc:oceanbase://localhost:2881/APP", None),
            ("jdbc:oceanbase:mysql://localhost:2881/APP", None),
            ("jdbc:mysql://localhost:2881/APP", None),
        ] {
            config.connection_string = Some(url.into());
            assert_eq!(dialect(&config), expected, "{url}");
            assert!(!is_oracle_external_driver_config(&config), "OB must not change the generic Oracle predicate");
        }
    }

    fn query_result(columns: &[&str], rows: Vec<Vec<Value>>) -> db::QueryResult {
        serde_json::from_value(json!({
            "columns": columns, "rows": rows, "affected_rows": 0, "execution_time_ms": 0,
        }))
        .unwrap()
    }

    struct Fixture {
        schema: String,
        name: String,
        results: HashMap<&'static str, Result<db::QueryResult, String>>,
    }

    impl Fixture {
        fn new(code: &str, attributes: Value, methods: Value) -> Self {
            let schema = "Exact O'wner".to_string();
            let name = "Mixed Type".to_string();
            let mut results = HashMap::new();
            results.insert(
                "ALL_OBJECTS",
                Ok(query_result(
                    &["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "STATUS"],
                    vec![
                        vec![json!(schema), json!(name), json!("TYPE"), json!("VALID")],
                        vec![json!(schema), json!(name), json!("TYPE BODY"), json!("INVALID")],
                    ],
                )),
            );
            results.insert(
                "ALL_TYPES",
                Ok(query_result(
                    &[
                        "OWNER",
                        "TYPE_NAME",
                        "TYPECODE",
                        "ATTRIBUTES",
                        "METHODS",
                        "FINAL",
                        "INSTANTIABLE",
                        "SUPERTYPE_OWNER",
                        "SUPERTYPE_NAME",
                    ],
                    vec![vec![
                        json!(schema),
                        json!(name),
                        json!(code),
                        attributes,
                        methods,
                        json!("NO"),
                        json!("YES"),
                        Value::Null,
                        Value::Null,
                    ]],
                )),
            );
            results.insert(
                "ALL_TYPE_ATTRS",
                Ok(query_result(
                    &[
                        "OWNER",
                        "TYPE_NAME",
                        "ATTR_NAME",
                        "ATTR_NO",
                        "ATTR_TYPE_OWNER",
                        "ATTR_TYPE_NAME",
                        "LENGTH",
                        "PRECISION",
                        "SCALE",
                    ],
                    vec![],
                )),
            );
            results.insert(
                "ALL_TYPE_METHODS",
                Ok(query_result(
                    &["OWNER", "TYPE_NAME", "METHOD_NAME", "METHOD_NO", "METHOD_TYPE", "PARAMETERS", "RESULTS"],
                    vec![],
                )),
            );
            results.insert(
                "ALL_COLL_TYPES",
                Ok(query_result(
                    &[
                        "OWNER",
                        "TYPE_NAME",
                        "COLL_TYPE",
                        "ELEM_TYPE_OWNER",
                        "ELEM_TYPE_NAME",
                        "LENGTH",
                        "PRECISION",
                        "SCALE",
                    ],
                    vec![],
                )),
            );
            Self { schema, name, results }
        }

        async fn read(mut self, dialect: Dialect) -> Result<CustomTypeDetails, String> {
            let mut calls = Vec::new();
            let details = read(dialect, &self.schema, &self.name, |sql| {
                assert!(sql.contains("OWNER = 'Exact O''wner'"), "{sql}");
                assert!(sql.contains("= 'Mixed Type'"), "{sql}");
                assert!(!sql.contains("CURRENT_SCHEMA"));
                let view = sql.split(" FROM ").nth(1).unwrap().split_whitespace().next().unwrap();
                calls.push(view.to_string());
                std::future::ready(self.results.remove(view).unwrap_or_else(|| panic!("Unexpected query: {sql}")))
            })
            .await;
            assert_eq!(
                calls.len(),
                calls.iter().collect::<std::collections::HashSet<_>>().len(),
                "no repeated fallback to another identity"
            );
            details
        }
    }

    #[tokio::test]
    async fn object_attributes_preserve_exact_identity_order_and_oceanbase_precision() {
        let mut fixture = Fixture::new("OBJECT", json!(2), json!(1));
        fixture.results.insert(
            "ALL_TYPE_ATTRS",
            Ok(query_result(
                &[
                    "OWNER",
                    "TYPE_NAME",
                    "ATTR_NAME",
                    "ATTR_NO",
                    "ATTR_TYPE_OWNER",
                    "ATTR_TYPE_NAME",
                    "NUMBER_PRECISION",
                    "SCALE",
                    "LENGTH",
                ],
                vec![
                    vec![
                        json!(fixture.schema),
                        json!(fixture.name),
                        json!("LABEL"),
                        json!("2"),
                        Value::Null,
                        json!("VARCHAR2"),
                        Value::Null,
                        Value::Null,
                        json!(40),
                    ],
                    vec![
                        json!("Other owner"),
                        json!(fixture.name),
                        json!("DO_NOT_LEAK"),
                        json!(1),
                        Value::Null,
                        json!("NUMBER"),
                        json!(99),
                        json!(0),
                        Value::Null,
                    ],
                    vec![
                        json!(fixture.schema),
                        json!(fixture.name),
                        json!("ID"),
                        json!(1),
                        Value::Null,
                        json!("NUMBER"),
                        json!(12),
                        json!(2),
                        Value::Null,
                    ],
                ],
            )),
        );
        let details = fixture.read(Dialect::OceanBase).await.unwrap();
        assert_eq!(details.kind, CustomTypeKind::Object);
        assert!(details.ddl.is_none(), "source completeness must not redefine PG executable DDL");
        let serialized = serde_json::to_value(details).unwrap();
        assert_eq!(serialized["oracleMetadata"]["typeCode"], "OBJECT");
        assert_eq!(serialized["oracleMetadata"]["attributes"][0]["precision"], 12);
        assert_eq!(serialized["oracleMetadata"]["methodsRead"]["state"], "incomplete");
        let restored: CustomTypeDetails = serde_json::from_value(serialized).unwrap();
        let metadata = restored.oracle_metadata.unwrap();
        assert_eq!(metadata.body_visible, Some(true));
        assert_eq!(metadata.body_status.as_deref(), Some("INVALID"));
        assert_eq!(metadata.attributes[0].name, "ID");
        assert_eq!(metadata.attributes[0].precision, Some(12));
        assert_eq!(metadata.attributes[0].scale, Some(2));
        assert_eq!(metadata.attributes[1].length, Some(40));
        assert_eq!(metadata.attributes_read.state, TypeMetadataState::Available);
        assert!(metadata.methods.is_empty());
        assert_eq!(metadata.methods_read.state, TypeMetadataState::Incomplete);
        let reason = metadata.methods_read.reason.unwrap();
        assert!(reason.contains("count is 1") && reason.contains("0 rows"), "{reason}");
    }

    #[tokio::test]
    async fn oceanbase_internal_accuracy_values_are_not_type_dimensions() {
        let mut fixture = Fixture::new("OBJECT", json!(4), json!(0));
        let rows = [
            ("UNBOUNDED", "NUMBER", -1, -1, -85),
            ("ROUNDED", "NUMBER", -1, 12, -2),
            ("LABEL", "VARCHAR2", 40, 2, -1),
            ("BINARY_PRECISION", "FLOAT", -1, 126, -1),
        ];
        fixture.results.insert(
            "ALL_TYPE_ATTRS",
            Ok(query_result(
                &[
                    "OWNER",
                    "TYPE_NAME",
                    "ATTR_NAME",
                    "ATTR_NO",
                    "ATTR_TYPE_OWNER",
                    "ATTR_TYPE_NAME",
                    "LENGTH",
                    "NUMBER_PRECISION",
                    "SCALE",
                ],
                rows.into_iter()
                    .enumerate()
                    .map(|(index, (name, type_name, length, precision, scale))| {
                        vec![
                            json!(fixture.schema),
                            json!(fixture.name),
                            json!(name),
                            json!(index + 1),
                            Value::Null,
                            json!(type_name),
                            json!(length),
                            json!(precision),
                            json!(scale),
                        ]
                    })
                    .collect(),
            )),
        );
        let metadata = fixture.read(Dialect::OceanBase).await.unwrap().oracle_metadata.unwrap();
        let attributes = metadata.attributes;
        assert_eq!((attributes[0].length, attributes[0].precision, attributes[0].scale), (None, None, None));
        assert_eq!((attributes[1].precision, attributes[1].scale), (Some(12), Some(-2)));
        assert_eq!((attributes[2].length, attributes[2].precision, attributes[2].scale), (Some(40), None, None));
        assert_eq!((attributes[3].precision, attributes[3].scale), (Some(126), None));
        assert_eq!(metadata.attributes_read.state, TypeMetadataState::Available);
    }

    #[tokio::test]
    async fn oceanbase_collection_bound_distinguishes_varray_from_unbounded_table() {
        for (bound, element, length, precision, scale, expected_kind, expected_bound) in
            [(-1, "VARCHAR2", 30, 2, -1, "TABLE", None), (10, "NUMBER", -1, -1, -85, "VARRAY", Some(10))]
        {
            let mut fixture = Fixture::new("COLLECTION", json!(0), json!(0));
            fixture.results.insert(
                "ALL_COLL_TYPES",
                Ok(query_result(
                    &[
                        "OWNER",
                        "TYPE_NAME",
                        "COLL_TYPE",
                        "UPPER_BOUND",
                        "ELEM_TYPE_OWNER",
                        "ELEM_TYPE_NAME",
                        "LENGTH",
                        "NUMBER_PRECISION",
                        "SCALE",
                    ],
                    vec![vec![
                        json!(fixture.schema),
                        json!(fixture.name),
                        json!("TABLE"),
                        json!(bound),
                        Value::Null,
                        json!(element),
                        json!(length),
                        json!(precision),
                        json!(scale),
                    ]],
                )),
            );
            let metadata = fixture.read(Dialect::OceanBase).await.unwrap().oracle_metadata.unwrap();
            let collection = metadata.collection.unwrap();
            assert_eq!(collection.kind.as_deref(), Some(expected_kind));
            assert_eq!(collection.upper_bound, expected_bound);
            assert_eq!(collection.precision, None);
            assert_eq!(collection.scale, None);
            assert_eq!(collection.length, if element == "VARCHAR2" { Some(30) } else { None });
            assert_eq!(metadata.collection_read.state, TypeMetadataState::Available);
        }
    }

    #[tokio::test]
    async fn partial_permission_failure_preserves_other_sections_and_the_reason() {
        let mut fixture = Fixture::new("COLLECTION", json!(0), json!(0));
        fixture.results.insert("ALL_TYPE_ATTRS", Err("ORA-01031: insufficient privileges".to_string()));
        fixture.results.insert(
            "ALL_COLL_TYPES",
            Ok(query_result(
                &[
                    "OWNER",
                    "TYPE_NAME",
                    "COLL_TYPE",
                    "ELEM_TYPE_NAME",
                    "UPPER_BOUND",
                    "PRECISION",
                    "SCALE",
                    "ELEM_TYPE_OWNER",
                    "LENGTH",
                ],
                vec![vec![
                    json!(fixture.schema),
                    json!(fixture.name),
                    json!("VARYING ARRAY"),
                    json!("NUMBER"),
                    json!(10),
                    json!(8),
                    json!(2),
                    Value::Null,
                    Value::Null,
                ]],
            )),
        );
        let metadata = fixture.read(Dialect::Oracle).await.unwrap().oracle_metadata.unwrap();
        assert_eq!(metadata.attributes_read.state, TypeMetadataState::Unavailable);
        assert!(metadata.attributes_read.reason.unwrap().contains("ORA-01031"));
        assert_eq!(metadata.properties_read.state, TypeMetadataState::Available);
        assert_eq!(metadata.collection_read.state, TypeMetadataState::Available);
        let collection = metadata.collection.unwrap();
        assert_eq!(collection.upper_bound, Some(10));
        assert_eq!(collection.precision, Some(8));
        assert_eq!(metadata.methods_read.state, TypeMetadataState::Available);
    }

    #[tokio::test]
    async fn missing_dm_columns_and_unknown_counts_are_not_complete_empty_metadata() {
        let mut fixture = Fixture::new("RECORD", Value::Null, Value::Null);
        fixture.results.insert("ALL_TYPE_ATTRS", Ok(query_result(&["OWNER", "TYPE_NAME", "ATTR_NAME"], vec![])));
        let details = fixture.read(Dialect::Dameng).await.unwrap();
        assert_eq!(details.kind, CustomTypeKind::Other);
        let metadata = details.oracle_metadata.unwrap();
        assert_eq!(metadata.type_code.as_deref(), Some("RECORD"));
        assert_eq!(metadata.attribute_count, None);
        assert_eq!(metadata.attributes_read.state, TypeMetadataState::Incomplete);
        let reason = metadata.attributes_read.reason.unwrap();
        assert!(reason.contains("ATTR_NO") && reason.contains("unknown"), "{reason}");
        assert_eq!(metadata.methods_read.state, TypeMetadataState::Incomplete);
    }

    #[tokio::test]
    async fn truncated_rows_are_retained_but_never_declared_complete() {
        let mut fixture = Fixture::new("OBJECT", json!(0), json!(0));
        let mut result = query_result(
            &["OWNER", "TYPE_NAME", "ATTR_NAME", "ATTR_NO", "ATTR_TYPE_NAME"],
            vec![vec![json!(fixture.schema), json!(fixture.name), json!("ID"), json!(1), json!("NUMBER")]],
        );
        result.has_more = true;
        fixture.results.insert("ALL_TYPE_ATTRS", Ok(result));
        let metadata = fixture.read(Dialect::Oracle).await.unwrap().oracle_metadata.unwrap();
        assert_eq!(metadata.attributes.len(), 1);
        assert_eq!(metadata.attributes_read.state, TypeMetadataState::Incomplete);
        assert!(metadata.attributes_read.reason.unwrap().contains("truncated"));
    }

    #[tokio::test]
    async fn a_body_only_identity_cannot_be_returned_as_a_type() {
        let mut fixture = Fixture::new("OBJECT", json!(0), json!(0));
        fixture.results.get_mut("ALL_OBJECTS").unwrap().as_mut().unwrap().rows.remove(0);
        fixture.results.get_mut("ALL_TYPES").unwrap().as_mut().unwrap().rows.clear();
        let error = fixture.read(Dialect::Oracle).await.unwrap_err();
        assert!(error.contains("not found or is not visible"));
    }

    #[tokio::test]
    async fn inaccessible_pairing_is_unknown_not_no_body() {
        let mut fixture = Fixture::new("OBJECT", json!(0), json!(0));
        fixture.results.insert("ALL_OBJECTS", Err("catalog read failed".into()));
        let metadata = fixture.read(Dialect::Oracle).await.unwrap().oracle_metadata.unwrap();
        assert_eq!(metadata.body_visible, None);
        assert_eq!(metadata.body_read.state, TypeMetadataState::Unavailable);
        assert_eq!(metadata.status, None);
        assert_eq!(metadata.properties_read.state, TypeMetadataState::Incomplete);
    }

    #[tokio::test]
    async fn methods_attach_parameters_and_results_by_overload_and_check_counts() {
        let mut fixture = Fixture::new("OBJECT", json!(0), json!(2));
        fixture.results.insert(
            "ALL_TYPE_METHODS",
            Ok(query_result(
                &["OWNER", "TYPE_NAME", "METHOD_NAME", "METHOD_NO", "METHOD_TYPE", "PARAMETERS", "RESULTS"],
                vec![
                    vec![
                        json!(fixture.schema),
                        json!(fixture.name),
                        json!("GET"),
                        json!(1),
                        json!("PUBLIC"),
                        json!(1),
                        json!(1),
                    ],
                    vec![
                        json!(fixture.schema),
                        json!(fixture.name),
                        json!("GET"),
                        json!(2),
                        json!("PUBLIC"),
                        json!(2),
                        json!(0),
                    ],
                ],
            )),
        );
        fixture.results.insert(
            "ALL_METHOD_PARAMS",
            Ok(query_result(
                &[
                    "OWNER",
                    "TYPE_NAME",
                    "METHOD_NAME",
                    "METHOD_NO",
                    "PARAM_NAME",
                    "PARAM_NO",
                    "PARAM_MODE",
                    "PARAM_TYPE_NAME",
                    "PARAM_TYPE_OWNER",
                ],
                vec![vec![
                    json!(fixture.schema),
                    json!(fixture.name),
                    json!("GET"),
                    json!(1),
                    json!("VALUE"),
                    json!(1),
                    json!("IN"),
                    json!("NUMBER"),
                    Value::Null,
                ]],
            )),
        );
        fixture.results.insert(
            "ALL_METHOD_RESULTS",
            Ok(query_result(
                &["OWNER", "TYPE_NAME", "METHOD_NAME", "METHOD_NO", "RESULT_TYPE_NAME", "RESULT_TYPE_OWNER"],
                vec![vec![
                    json!(fixture.schema),
                    json!(fixture.name),
                    json!("GET"),
                    json!(1),
                    json!("NUMBER"),
                    Value::Null,
                ]],
            )),
        );
        let metadata = fixture.read(Dialect::Oracle).await.unwrap().oracle_metadata.unwrap();
        assert_eq!(metadata.methods.len(), 2);
        assert_eq!(metadata.methods[0].parameters[0].name.as_deref(), Some("VALUE"));
        assert_eq!(metadata.methods[0].results[0].type_name.as_deref(), Some("NUMBER"));
        assert_eq!(metadata.methods[0].parameters_read.state, TypeMetadataState::Available);
        assert!(metadata.methods[1].parameters.is_empty());
        assert_eq!(metadata.methods[1].parameters_read.state, TypeMetadataState::Incomplete);
        assert_eq!(metadata.methods_read.state, TypeMetadataState::Incomplete);
    }
}
