//! Optional CREATE-only dialect settings. Existing table/ALTER request options remain compatible.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableDialectOptions {
    pub starrocks: Option<StarRocksCreateOptions>,
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
