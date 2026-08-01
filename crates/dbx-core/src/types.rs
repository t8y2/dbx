use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseInfo {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseStorageInfo {
    pub name: String,
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub name: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkedServerInfo {
    pub name: String,
    pub product: Option<String>,
    pub provider: Option<String>,
    pub data_source: Option<String>,
}

/// A catalog exposed by a multi-catalog engine (e.g. Doris / StarRocks).
/// `internal` is the engine's native catalog; other entries are external
/// catalogs (iceberg, hive, jdbc, ...) federated through the same connection.
///
/// Note: the built-in catalog is named `internal` in Doris (Type=`internal`)
/// but `default_catalog` in StarRocks (Type=`Internal`). The `catalog_type`
/// column is the cross-engine signal, so `is_internal()` matches it
/// case-insensitively and falls back to the canonical Doris name when the
/// column is absent (very old / proxied deployments).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogInfo {
    pub name: String,
    pub catalog_type: String,
    pub is_current: bool,
    pub comment: Option<String>,
}

impl CatalogInfo {
    /// Whether this is the engine's built-in (non-federated) catalog.
    pub fn is_internal(&self) -> bool {
        if !self.catalog_type.trim().is_empty() {
            self.catalog_type.eq_ignore_ascii_case("internal")
        } else {
            self.name == "internal"
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub table_type: String, // "TABLE" or "VIEW"
    pub comment: Option<String>,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectInfo {
    pub name: String,
    pub object_type: String,
    pub schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    pub comment: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionInfo {
    pub name: String,
    pub version: String,
    pub comment: Option<String>,
    pub schema: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectStatistics {
    pub name: String,
    pub schema: Option<String>,
    pub estimated_rows: Option<i64>,
    pub total_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ObjectSourceKind {
    View,
    MaterializedView,
    Procedure,
    Function,
    Trigger,
    Sequence,
    Synonym,
    Package,
    PackageBody,
    Type,
    TypeBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectSource {
    pub name: String,
    pub object_type: ObjectSourceKind,
    pub schema: Option<String>,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
    pub extra: Option<String>,
    pub comment: Option<String>,
    pub numeric_precision: Option<i32>,
    pub numeric_scale: Option<i32>,
    pub character_maximum_length: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_set: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionAssistantObjectKind {
    Database,
    Schema,
    Table,
    View,
    Routine,
    Procedure,
    Function,
    Column,
}

impl CompletionAssistantObjectKind {
    pub fn is_table_like(&self) -> bool {
        matches!(self, Self::Table | Self::View)
    }

    pub fn is_routine_like(&self) -> bool {
        matches!(self, Self::Routine | Self::Procedure | Self::Function)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionAssistantCandidateKind {
    Database,
    Schema,
    Table,
    View,
    Procedure,
    Function,
    Column,
    Object,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionAssistantMatchMode {
    Prefix,
    Contains,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionAssistantRequest {
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
    #[serde(default)]
    pub object_kinds: Vec<CompletionAssistantObjectKind>,
    #[serde(default)]
    pub mask: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub global_search: bool,
    pub max_results: Option<usize>,
    #[serde(default)]
    pub search_in_comments: bool,
    #[serde(default)]
    pub search_in_definitions: bool,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
    pub match_mode: Option<CompletionAssistantMatchMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionAssistantCandidate {
    pub name: String,
    pub kind: CompletionAssistantCandidateKind,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
    pub comment: Option<String>,
    pub data_type: Option<String>,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionAssistantResponse {
    pub candidates: Vec<CompletionAssistantCandidate>,
    pub incomplete: bool,
    pub fallback_used: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpatialColumn {
    /// Zero-based index into `QueryResult.columns`.
    pub column_index: usize,
    /// SRID shared by the column's geometry cells. `None` when unknown/absent
    /// (or SRID 0). A column reports the first non-null SRID it observes.
    pub srid: Option<u32>,
}

#[derive(Debug, Default)]
pub(crate) struct SpatialColumnBuilder {
    // column_index -> first non-null srid seen (sticky once set)
    columns: std::collections::BTreeMap<usize, Option<u32>>,
}

impl SpatialColumnBuilder {
    pub(crate) fn new(column_indices: impl IntoIterator<Item = usize>) -> Self {
        let mut builder = Self::default();
        for column_index in column_indices {
            builder.columns.entry(column_index).or_insert(None);
        }
        builder
    }

    /// Record a geometry cell's SRID. The first non-null (and non-zero) value
    /// wins; later observations for the same column are ignored.
    pub(crate) fn observe(&mut self, column_index: usize, srid: Option<u32>) {
        let entry = self.columns.entry(column_index).or_insert(None);
        if entry.is_none() {
            if let Some(value) = srid.filter(|value| *value != 0) {
                *entry = Some(value);
            }
        }
    }

    pub(crate) fn finish(self) -> Vec<SpatialColumn> {
        self.columns.into_iter().map(|(column_index, srid)| SpatialColumn { column_index, srid }).collect()
    }

    pub(crate) fn finish_with_values(
        self,
        spatial_values: Vec<Vec<Option<u32>>>,
    ) -> (Vec<SpatialColumn>, Vec<Vec<Option<u32>>>) {
        let spatial_columns = self.finish();
        let spatial_values = if spatial_columns.is_empty() { Vec::new() } else { spatial_values };
        (spatial_columns, spatial_values)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    /// Database type name for each column, parallel to `columns`. May be empty
    /// when a driver cannot supply types (e.g. schemaless stores or fallback
    /// query paths); consumers must tolerate a shorter/empty vector.
    #[serde(default)]
    pub column_types: Vec<String>,
    /// Sortable for each column. Parallel to `columns`. Optional and may
    /// be shorter/empty when a driver cannot supply sortable information.
    #[serde(default)]
    pub column_sortables: Vec<bool>,
    /// Spatial reference metadata for geometry/geography cells. Kept outside
    /// `rows` so displayed, copied, exported, and edited values remain WKT.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spatial_columns: Vec<SpatialColumn>,
    /// Per-cell SRID metadata, parallel to `rows`: `spatial_values[row][column]`
    /// is the SRID of that cell's geometry value (`None` for non-spatial cells
    /// or unknown SRID). Unlike `spatial_columns` (a column-level hint), every
    /// geometry value keeps its own SRID so mixed-SRID results stay correct.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spatial_values: Vec<Vec<Option<u32>>>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub execution_time_ms: u128,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub has_more: bool,
    /// For Elasticsearch REST search results parsed into a table from _source,
    /// this carries the raw HTTP response body so the UI can offer a toggle
    /// between the tabular view and the original JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elasticsearch_raw_body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub is_primary: bool,
    pub filter: Option<String>,
    pub index_type: Option<String>,
    pub included_columns: Option<Vec<String>>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub column: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_column: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_update: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerInfo {
    pub name: String,
    pub event: String,
    pub timing: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statement: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConstraintInfo {
    pub name: String,
    pub constraint_type: String,
    pub definition: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_table: Option<String>,
    #[serde(default)]
    pub ref_columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_update: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_delete: Option<String>,
    #[serde(default)]
    pub deferrable: bool,
    #[serde(default)]
    pub initially_deferred: bool,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartitionInfo {
    pub name: String,
    pub position: i32,
    pub value: String,
    pub partition_type: String,
    pub partition_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_partition_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_partition_span: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubpartitionInfo {
    pub name: String,
    pub position: i32,
    pub value: String,
    pub partition_type: String,
    pub partition_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    pub name: String,
    pub function_type: String,
    pub data_type: String,
    pub definition: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceInfo {
    pub name: String,
    pub data_type: String,
    pub start_value: String,
    pub min_value: String,
    pub max_value: String,
    pub increment: String,
    pub cycle: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleInfo {
    pub name: String,
    pub table_name: String,
    pub definition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerInfo {
    pub object_name: String,
    pub object_type: String,
    pub owner: String,
}

#[cfg(test)]
mod tests {
    use super::{ObjectInfo, ObjectSourceKind, SpatialColumn, SpatialColumnBuilder};

    #[test]
    fn list_objects_payload_preserves_optional_validity() {
        let objects: Vec<ObjectInfo> =
            serde_json::from_str(r#"[{"name":"TRG_AUDIT","object_type":"TRIGGER","schema":"APP","valid":false}]"#)
                .unwrap();

        assert_eq!(objects[0].valid, Some(false));
        assert_eq!(objects[0].object_type, "TRIGGER");
    }

    #[test]
    fn spatial_builder_reports_first_non_null_srid_per_column() {
        let mut builder = SpatialColumnBuilder::new([3]);
        builder.observe(3, None);
        builder.observe(1, Some(4326));
        builder.observe(3, Some(3857));
        builder.observe(3, Some(4490)); // ignored: column 3 already set
        builder.observe(1, None); // ignored: column 1 already set

        assert_eq!(
            builder.finish(),
            vec![
                SpatialColumn { column_index: 1, srid: Some(4326) },
                SpatialColumn { column_index: 3, srid: Some(3857) },
            ]
        );
    }

    #[test]
    fn spatial_builder_normalizes_zero_and_all_null() {
        let mut builder = SpatialColumnBuilder::new([0]);
        builder.observe(0, Some(0)); // SRID 0 -> unknown
        assert_eq!(builder.finish(), vec![SpatialColumn { column_index: 0, srid: None }]);
        assert!(SpatialColumnBuilder::default().finish().is_empty());
    }

    #[test]
    fn spatial_builder_omits_values_without_spatial_columns() {
        let values = vec![vec![None, None]];
        let (columns, values) = SpatialColumnBuilder::default().finish_with_values(values);
        assert!(columns.is_empty());
        assert!(values.is_empty());

        let expected_values = vec![vec![None, None]];
        let (columns, values) = SpatialColumnBuilder::new([0]).finish_with_values(expected_values.clone());
        assert_eq!(columns, vec![SpatialColumn { column_index: 0, srid: None }]);
        assert_eq!(values, expected_values);
    }

    #[test]
    fn object_source_kind_accepts_synonym_wire_value() {
        let kind: ObjectSourceKind = serde_json::from_str("\"SYNONYM\"").unwrap();

        assert_eq!(kind, ObjectSourceKind::Synonym);
        assert_eq!(serde_json::to_string(&kind).unwrap(), "\"SYNONYM\"");
    }
}
