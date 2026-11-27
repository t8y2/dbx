//! Optional CREATE-only dialect settings. Existing table/ALTER request options remain compatible.
use serde::{Deserialize, Serialize};

use super::mysql_table_charset::MysqlTableCharsetChange;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableDialectOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mysql_table_charset: Option<MysqlTableCharsetChange>,
    pub starrocks: Option<StarRocksCreateOptions>,
    pub postgres_foreign_table: Option<PostgresForeignTableCreateOptions>,
    pub paimon: Option<PaimonCreateOptions>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PaimonCreateOptions {
    pub partition_mode: String,
    pub partition_target: String,
    pub generate_partition: bool,
    pub partition_column_ids: Vec<String>,
    pub bucket_column_ids: Vec<String>,
    pub bucket_count: String,
    pub properties: String,
    pub property_rows: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresForeignTableCreateOptions {
    pub server: String,
    #[serde(default)]
    pub options: Vec<PostgresForeignTableOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresForeignTableOption {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarRocksCreateOptions {
    pub time_partition: Option<StarRocksTimePartition>,
    pub partition: Option<StarRocksPartitionOptions>,
    #[serde(default)]
    pub distribution: StarRocksDistribution,
    #[serde(default)]
    pub distribution_column_ids: Vec<String>,
    #[serde(default)]
    pub sort_column_ids: Vec<String>,
    pub bucket_count: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StarRocksDistribution {
    #[default]
    Auto,
    Hash,
    Random,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarRocksTimePartition {
    pub column_id: String,
    pub granularity: StarRocksTimeGranularity,
    pub interval: Option<u32>,
    #[serde(default)]
    pub additional_column_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StarRocksTimeGranularity {
    Year,
    Month,
    Day,
    Hour,
}

impl StarRocksTimeGranularity {
    pub(super) fn sql(self) -> &'static str {
        match self {
            Self::Year => "year",
            Self::Month => "month",
            Self::Day => "day",
            Self::Hour => "hour",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum StarRocksPartitionOptions {
    Values { column_ids: Vec<String> },
    Range { column_ids: Vec<String>, partitions: Vec<StarRocksRangePartition> },
    List { column_ids: Vec<String>, partitions: Vec<StarRocksListPartition> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarRocksRangePartition {
    pub name: String,
    pub lower: Vec<String>,
    pub upper: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarRocksListPartition {
    pub name: String,
    pub values: Vec<Vec<String>>,
}

pub(super) fn paimon_create_suffix(
    options: &PaimonCreateOptions,
    columns: &[&super::types::EditableStructureColumn],
    comment: Option<&str>,
    definitions: &mut Vec<String>,
) -> Result<String, String> {
    use super::dialect::StructureDialect;
    use super::util::{quote_ident, spark_string};

    let resolve = |ids: &[String]| -> Result<Vec<&str>, String> {
        ids.iter()
            .map(|id| {
                columns
                    .iter()
                    .find(|column| column.id == *id)
                    .map(|column| column.name.trim())
                    .ok_or_else(|| format!("Paimon column selection is no longer valid: {id}"))
            })
            .collect()
    };
    let mut partitions = resolve(&options.partition_column_ids)?;
    let mode = options.partition_mode.as_str();
    let derived = !matches!(mode, "" | "value" | "none");
    let target;
    if derived {
        let [source] = partitions.as_slice() else {
            return Err("Select exactly one source column for the Paimon partition rule.".into());
        };
        let source_column = columns.iter().find(|column| column.name.trim() == *source).unwrap();
        let source = quote_ident(StructureDialect::Spark, source);
        let generated = options.generate_partition && !matches!(mode, "group" | "range");
        let source_type = source_column.data_type.trim().to_ascii_uppercase();
        if !matches!(mode, "group" | "range") && source_type != "DATE" && !source_type.starts_with("TIMESTAMP") {
            return Err("Choose a DATE or TIMESTAMP source for time partitioning.".into());
        }
        if generated && source_type != "DATE" && source_type != "TIMESTAMP_NTZ" {
            return Err("Use DATE or TIMESTAMP_NTZ for a generated time partition, or compute it during writes.".into());
        }
        if mode == "range" && !matches!(source_type.as_str(), "INT" | "INTEGER" | "BIGINT" | "SMALLINT" | "TINYINT") {
            return Err("Select an integer source for range partitioning.".into());
        }
        let (kind, expression) = match mode {
            "day" => ("DATE", format!("CAST({source} AS DATE)")),
            "month" => ("DATE", format!("TRUNC(CAST({source} AS DATE), 'MONTH')")),
            "year" => ("INT", format!("YEAR({source})")),
            "group" | "range" => ("STRING", String::new()),
            _ => return Err("Unknown Paimon partition method.".into()),
        };
        target = match options.partition_target.trim() {
            "" => format!("p_{mode}"),
            name => name.to_owned(),
        };
        if target.contains(',') || columns.iter().any(|column| column.name.trim().eq_ignore_ascii_case(&target)) {
            return Err(format!("Choose a distinct partition column name without commas: {target}"));
        }
        let name = quote_ident(StructureDialect::Spark, &target);
        let mut definition = format!("{name} {kind}");
        if generated {
            definition.push_str(&format!(" GENERATED ALWAYS AS ({expression})"));
        } else if matches!(mode, "day" | "month" | "year") {
            let rule = format!("dbx:time-partition:{mode}:{}", source_column.name.trim());
            definition.push_str(&format!(" COMMENT {}", spark_string(&rule)));
        }
        definitions.push(definition);
        partitions = vec![target.as_str()];
    }
    let bucket_keys = resolve(&options.bucket_column_ids)?;
    if let Some(name) = bucket_keys.iter().find(|name| partitions.contains(name)) {
        return Err(format!("Paimon column '{name}' cannot be both a partition column and a bucket key."));
    }
    let mut primary_keys: Vec<_> =
        columns.iter().filter(|column| column.is_primary_key).map(|column| column.name.trim()).collect();
    if !primary_keys.is_empty() {
        for partition in &partitions {
            if !primary_keys.contains(partition) {
                primary_keys.push(*partition);
            }
        }
    }
    if primary_keys.iter().chain(&bucket_keys).any(|name| name.contains(',')) {
        return Err("Paimon primary-key and bucket-key column names cannot contain commas.".into());
    }

    let mut suffix = String::new();
    if !partitions.is_empty() {
        let names = partitions.iter().map(|name| quote_ident(StructureDialect::Spark, name)).collect::<Vec<_>>();
        suffix.push_str(&format!(" PARTITIONED BY ({})", names.join(", ")));
    }
    if let Some(comment) = comment.map(str::trim).filter(|comment| !comment.is_empty()) {
        suffix.push_str(&format!(" COMMENT {}", spark_string(comment)));
    }

    let mut properties = std::collections::BTreeMap::new();
    if !primary_keys.is_empty() {
        properties.insert("primary-key", primary_keys.join(","));
    }
    if !bucket_keys.is_empty() {
        properties.insert("bucket-key", bucket_keys.join(","));
    }
    let count = options.bucket_count.trim();
    if !count.is_empty() {
        let count = count
            .parse::<i32>()
            .ok()
            .filter(|count| *count >= -2 && *count != 0)
            .ok_or("Paimon bucket count must be positive, -1, or -2.")?;
        properties.insert("bucket", count.to_string());
    }
    let legacy_rows = options.properties.lines().map(str::trim).filter(|line| !line.is_empty()).map(|line| {
        line.split_once('=').ok_or("Enter one Paimon table property as key=value per line.")
    });
    let rows = options.property_rows.iter()
        .filter(|(key, value)| !key.trim().is_empty() || !value.trim().is_empty())
        .map(|(key, value)| Ok((key.as_str(), value.as_str())));
    for row in legacy_rows.chain(rows) {
        let (key, value) = row?;
        let key = key.trim();
        if key.is_empty() {
            return Err("Enter a key for each Paimon table property.".into());
        }
        if matches!(key.to_ascii_lowercase().as_str(), "primary-key" | "bucket-key" | "bucket" | "comment")
        {
            return Err(format!("Set Paimon property '{key}' using the corresponding table editor field."));
        }
        if properties.insert(key, value.trim().to_string()).is_some() {
            return Err(format!("Duplicate Paimon table property '{key}'."));
        }
    }
    if !properties.is_empty() {
        let pairs = properties
            .iter()
            .map(|(key, value)| format!("{} = {}", spark_string(key), spark_string(value)))
            .collect::<Vec<_>>();
        suffix.push_str(&format!(" TBLPROPERTIES ({})", pairs.join(", ")));
    }
    Ok(suffix)
}
