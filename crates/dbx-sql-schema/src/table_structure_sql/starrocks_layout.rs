//! Optional layout operations, kept separate from column schema-change jobs.
use super::{alter_dialect::StarRocksAlterOptions, dialect::StructureDialect, types::*, util::*};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarRocksLayoutChanges {
    pub distribution: Option<StarRocksDistributionChange>,
    #[serde(default)]
    pub partitions: Vec<StarRocksPartitionChange>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarRocksDistributionChange {
    pub method: String,
    #[serde(default)]
    pub columns: Vec<String>,
    pub buckets: Option<u32>,
    #[serde(default)]
    pub default_only: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StarRocksPartitionChange {
    AddRange { name: String, lower: Vec<String>, upper: Vec<String> },
    AddList { name: String, values: Vec<Vec<String>> },
    Drop { name: String },
    Replicas { name: String, replicas: u32 },
}
fn ident(name: &str) -> String {
    quote_ident(StructureDialect::Mysql, name)
}
fn tuple(values: &[String]) -> String {
    values.iter().map(|value| quote_string(&value.replace('\\', "\\\\"))).collect::<Vec<_>>().join(", ")
}
pub(super) fn build(
    options: &TableStructureSqlOptions,
    context: &StarRocksAlterOptions,
    warnings: &mut Vec<String>,
) -> Vec<String> {
    let Some(layout) = &context.layout else {
        return vec![];
    };
    if layout.distribution.is_none() && layout.partitions.is_empty() {
        return vec![];
    }
    let mut statements = vec![];
    let table = qualified_table(StructureDialect::Mysql, options.schema.as_deref(), &options.table_name);
    let version = super::create_dialect::parse_version(context.server_version.as_deref());
    if context.model.is_none() || context.colocated {
        warnings.push(
            "StarRocks layout editing requires confirmed OLAP table metadata and a table outside a colocation group."
                .into(),
        );
    }
    if let Some(distribution) = &layout.distribution {
        if context.automatic_bucket_scaling {
            warnings.push("This StarRocks table uses automatic bucket scaling (bucket_size > 0); changing distribution or bucket count through ALTER is not supported. Create a new table to change distribution.".into());
        }
        if !version.is_some_and(|v| v >= (3, 2, 0)) {
            warnings.push("Changing StarRocks distribution requires confirmed version 3.2 or newer.".into());
        }
        if !layout.partitions.is_empty() {
            warnings.push("Save StarRocks distribution and partition operations separately.".into());
        }
        if distribution.buckets.is_some_and(|n| n == 0 || n > i32::MAX as u32) {
            warnings.push("StarRocks bucket count must be a positive 32-bit integer.".into());
        }
        if distribution.default_only {
            if !version.is_some_and(|v| v >= (4, 0, 1) || ((3, 5, 8)..(4, 0, 0)).contains(&v)) {
                warnings.push("DEFAULT BUCKETS requires StarRocks 3.5.8 or 4.0.1 or newer.".into());
            }
            if distribution.method != "hash"
                || distribution.buckets.is_none()
                || context
                    .distribution
                    .as_ref()
                    .is_none_or(|old| old.method != "hash" || old.columns != distribution.columns)
            {
                warnings
                    .push("DEFAULT BUCKETS can only change the bucket count of the existing HASH distribution.".into());
            }
        }
        let method = match distribution.method.as_str() {
            "random" => {
                if context.model.as_deref() != Some("duplicate") {
                    warnings.push("Random distribution is only supported for StarRocks DUPLICATE tables.".into());
                }
                if !distribution.columns.is_empty() {
                    warnings.push("Random distribution cannot contain hash columns.".into());
                }
                "RANDOM".into()
            }
            "hash" => {
                if distribution.columns.is_empty() {
                    warnings.push("Select at least one StarRocks hash column.".into());
                }
                let mut seen = std::collections::HashSet::new();
                for name in &distribution.columns {
                    if !seen.insert(name.to_lowercase()) {
                        warnings.push("StarRocks hash columns must not repeat.".into());
                    }
                    match options
                        .columns
                        .iter()
                        .find(|column| !column.marked_for_drop && column.original.is_some() && column.name == *name)
                    {
                        None => warnings.push(format!(
                            "Hash column '{name}' is missing or newly added. Save column changes separately."
                        )),
                        Some(column) => {
                            let base = column.data_type.split('(').next().unwrap_or("").trim().to_lowercase();
                            if !matches!(
                                base.as_str(),
                                "tinyint"
                                    | "smallint"
                                    | "int"
                                    | "integer"
                                    | "bigint"
                                    | "largeint"
                                    | "date"
                                    | "datetime"
                                    | "char"
                                    | "varchar"
                                    | "string"
                            ) {
                                warnings.push(format!("Column '{name}' has an unsupported hash type."));
                            }
                            if context.model.as_deref() != Some("duplicate")
                                && !context.key_columns.iter().any(|key| key.eq_ignore_ascii_case(name))
                            {
                                warnings.push(
                                    "Hash columns must belong to the key for PRIMARY, UNIQUE and AGGREGATE tables."
                                        .into(),
                                );
                            }
                        }
                    }
                }
                format!("HASH({})", distribution.columns.iter().map(|name| ident(name)).collect::<Vec<_>>().join(", "))
            }
            _ => {
                warnings.push("Unknown StarRocks distribution method.".into());
                String::new()
            }
        };
        let count = distribution
            .buckets
            .map(|n| format!(" {}BUCKETS {n}", if distribution.default_only { "DEFAULT " } else { "" }))
            .unwrap_or_default();
        statements.push(format!("ALTER TABLE {table} DISTRIBUTED BY {method}{count};"));
    }
    for operation in &layout.partitions {
        let name = match operation {
            StarRocksPartitionChange::AddRange { name, .. }
            | StarRocksPartitionChange::AddList { name, .. }
            | StarRocksPartitionChange::Drop { name }
            | StarRocksPartitionChange::Replicas { name, .. } => name,
        };
        if name.trim().is_empty() || name.contains('\0') {
            warnings.push("Enter a valid StarRocks partition name.".into());
        }
        if context.partition_kind.is_none() && !matches!(operation, StarRocksPartitionChange::Replicas { .. }) {
            warnings.push("Partition operations require an existing partitioned StarRocks table.".into());
        }
        let arity = context.partition_columns.len();
        let valid_tuple = |values: &[String]| {
            !values.is_empty() && values.len() == arity && values.iter().all(|value| !value.contains('\0'))
        };
        let clause = match operation {
            StarRocksPartitionChange::AddRange { lower, upper, .. } => {
                if context.partition_kind.as_deref() != Some("range") || !valid_tuple(lower) || !valid_tuple(upper) {
                    warnings.push(
                        "Range partition values must match every column of an existing manual RANGE partition key."
                            .into(),
                    );
                }
                format!("ADD PARTITION {} VALUES [({}), ({}))", ident(name), tuple(lower), tuple(upper))
            }
            StarRocksPartitionChange::AddList { values, .. } => {
                if context.partition_kind.as_deref() != Some("list")
                    || values.is_empty()
                    || values.iter().any(|row| !valid_tuple(row))
                {
                    warnings.push(
                        "List partition tuples must match every column of an existing manual LIST partition key."
                            .into(),
                    );
                }
                let values = values
                    .iter()
                    .map(|row| if arity == 1 { tuple(row) } else { format!("({})", tuple(row)) })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("ADD PARTITION {} VALUES IN ({values})", ident(name))
            }
            StarRocksPartitionChange::Drop { .. } => format!("DROP PARTITION {}", ident(name)),
            StarRocksPartitionChange::Replicas { replicas, .. } => {
                if *replicas == 0 || *replicas > i16::MAX as u32 {
                    warnings.push("Replica count must be a positive integer no greater than 32767.".into());
                }
                format!(
                    "MODIFY PARTITION {} SET (\"replication_num\" = \"{replicas}\")",
                    if name == "*" { "(*)".into() } else { ident(name) }
                )
            }
        };
        statements.push(format!("ALTER TABLE {table} {clause};"));
    }
    statements
}
