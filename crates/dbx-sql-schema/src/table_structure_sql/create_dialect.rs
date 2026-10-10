//! CREATE-only extension points. Existing ALTER dialects and wire options stay unchanged.
use super::create_options::{CreateTableDialectOptions, StarRocksCreateOptions, StarRocksDistribution};
use super::dialect::StructureDialect;
use super::types::{EditableStructureColumn, TableStructureSqlOptions};
use super::util::{clean, quote_ident, quote_string};
use crate::models::connection::DatabaseType;

pub(super) trait CreateTableDialect {
    fn validate(
        &self,
        _options: &TableStructureSqlOptions,
        _columns: &[&EditableStructureColumn],
        _warnings: &mut Vec<String>,
    ) {
    }
    fn primary_key_columns_first(&self) -> bool {
        false
    }
    fn supports_column_charset(&self) -> bool {
        true
    }
    fn primary_key_in_column_list(&self) -> bool {
        true
    }
    fn explicit_primary_key_not_null(&self) -> bool {
        false
    }
    fn handles_table_comment(&self) -> bool {
        false
    }
    fn after_columns(&self, _options: &TableStructureSqlOptions, _primary_key: &str) -> String {
        String::new()
    }
    fn partition_clause(&self, _columns: &[&EditableStructureColumn]) -> String {
        String::new()
    }
    fn sort_clause(&self, _columns: &[&EditableStructureColumn]) -> String {
        String::new()
    }
    fn after_partition(&self, _columns: &[&EditableStructureColumn], _primary_key: &str) -> String {
        String::new()
    }
}

struct GenericCreateTable {
    unexpected_starrocks_options: bool,
}
impl CreateTableDialect for GenericCreateTable {
    fn validate(
        &self,
        _options: &TableStructureSqlOptions,
        _columns: &[&EditableStructureColumn],
        warnings: &mut Vec<String>,
    ) {
        if self.unexpected_starrocks_options {
            warnings.push("StarRocks physical options require a StarRocks connection.".into());
        }
    }
}

pub(super) fn create_table_dialect(
    options: &TableStructureSqlOptions,
    server_version: Option<&str>,
    dialect_options: CreateTableDialectOptions,
) -> Box<dyn CreateTableDialect> {
    if !options.is_gaussdb_m_mode
        && (options.database_type == Some(DatabaseType::StarRocks)
            || (options.database_type == Some(DatabaseType::Mysql)
                && options.driver_profile.as_deref().is_some_and(|profile| profile.eq_ignore_ascii_case("starrocks"))))
    {
        Box::new(StarRocksCreateTable {
            version: parse_version(server_version),
            settings: dialect_options.starrocks.unwrap_or_default(),
        })
    } else {
        Box::new(GenericCreateTable { unexpected_starrocks_options: dialect_options.starrocks.is_some() })
    }
}

pub(super) fn parse_version(raw: Option<&str>) -> Option<(u32, u32, u32)> {
    let normalized = raw?.trim().to_ascii_lowercase();
    let raw = normalized.as_str();
    let raw = raw
        .strip_prefix("starrocks version ")
        .or_else(|| raw.strip_prefix("starrocks "))
        .unwrap_or(raw)
        .trim_start_matches('v');
    let version = raw.split(|c: char| !c.is_ascii_digit() && c != '.').next()?;
    let mut parts = version.split('.');
    let result = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next().unwrap_or("0").parse().ok()?);
    // Old cached VERSION() values identify MySQL, not this product.
    (result != (5, 1, 0)).then_some(result)
}

struct StarRocksCreateTable {
    settings: StarRocksCreateOptions,
    version: Option<(u32, u32, u32)>,
}

impl StarRocksCreateTable {
    fn at_least(&self, version: (u32, u32, u32)) -> bool {
        self.version.is_some_and(|current| current >= version)
    }
}

impl CreateTableDialect for StarRocksCreateTable {
    fn validate(
        &self,
        options: &TableStructureSqlOptions,
        columns: &[&EditableStructureColumn],
        warnings: &mut Vec<String>,
    ) {
        let has_primary_key = columns.iter().any(|column| column.is_primary_key);
        if !self.settings.sort_column_ids.is_empty() {
            let minimum = if has_primary_key { (3, 0, 0) } else { (3, 3, 0) };
            if !self.at_least(minimum) {
                warnings.push(format!("StarRocks custom sort columns require a confirmed server version of {}.{} or newer for this table model.", minimum.0, minimum.1));
            }
            let mut seen = std::collections::HashSet::new();
            for id in &self.settings.sort_column_ids {
                if !seen.insert(id) {
                    warnings.push("StarRocks sort columns must be unique.".into());
                }
                match columns.iter().find(|column| &column.id == id) {
                    None => warnings.push("A StarRocks sort column was removed. Select an existing column.".into()),
                    Some(column) if has_primary_key => {
                        let base = column.data_type.split('(').next().unwrap_or("").trim().to_ascii_lowercase();
                        if !matches!(base.as_str(), "boolean" | "tinyint" | "smallint" | "int" | "integer" | "bigint" | "largeint" | "varchar" | "string" | "date" | "datetime") {
                            warnings.push(format!("StarRocks primary key table sort column '{}' must use boolean, integer, varchar, date or datetime.", column.name));
                        }
                    }
                    _ => {}
                }
            }
        }
        super::starrocks_partition::validate(&self.settings, columns, self.version, warnings);
        if self.settings.distribution == StarRocksDistribution::Random {
            if has_primary_key {
                warnings.push("StarRocks primary key tables require hash distribution.".into());
            }
            if !self.at_least((3, 1, 0)) {
                warnings
                    .push("StarRocks random distribution requires a confirmed server version of 3.1 or newer.".into());
            }
        }
        if self.settings.distribution == StarRocksDistribution::Hash {
            if self.settings.distribution_column_ids.is_empty() {
                warnings.push("Select at least one StarRocks hash distribution column.".into());
            }
            let mut seen = std::collections::HashSet::new();
            for id in &self.settings.distribution_column_ids {
                if !seen.insert(id) {
                    warnings.push("StarRocks hash distribution columns must be unique.".into());
                }
                match columns.iter().find(|column| &column.id == id) {
                    None => warnings
                        .push("A StarRocks hash distribution column was removed. Select an existing column.".into()),
                    Some(column) => {
                        let base = column.data_type.split('(').next().unwrap_or("").trim().to_ascii_lowercase();
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
                            warnings.push(format!(
                                "StarRocks hash distribution column '{}' must use an integer, date or string type.",
                                column.name
                            ));
                        }
                        if has_primary_key && !column.is_primary_key {
                            warnings.push(
                                "StarRocks hash distribution columns must be included in the primary key.".into(),
                            );
                        }
                    }
                }
            }
        } else if !self.settings.distribution_column_ids.is_empty() {
            warnings.push("Explicit distribution columns require hash distribution.".into());
        }
        if self.settings.bucket_count.is_some_and(|count| count == 0 || count > i32::MAX as u32) {
            warnings.push("StarRocks bucket count must be a positive integer no greater than 2147483647.".into());
        }
        if options.mysql_engine.is_some() {
            warnings.push("StarRocks tables do not accept MySQL storage engine options.".to_string());
        }
        if options.foreign_keys.iter().any(|key| !key.marked_for_drop)
            || options.triggers.iter().any(|trigger| !trigger.marked_for_drop)
            || options.indexes.iter().any(|index| !index.marked_for_drop && !index.is_primary)
        {
            warnings.push("StarRocks CREATE TABLE does not support MySQL foreign keys, triggers or secondary index definitions from this editor.".to_string());
        }
        for column in columns {
            if column.extra.as_ref().is_some_and(|extra| extra.on_update_current_timestamp == Some(true)) {
                warnings.push(format!("StarRocks column '{}' does not support MySQL ON UPDATE clauses.", column.name));
            }
        }
    }
    fn primary_key_columns_first(&self) -> bool {
        true
    }
    fn supports_column_charset(&self) -> bool {
        false
    }
    fn primary_key_in_column_list(&self) -> bool {
        false
    }
    fn explicit_primary_key_not_null(&self) -> bool {
        true
    }
    fn handles_table_comment(&self) -> bool {
        true
    }
    fn after_columns(&self, options: &TableStructureSqlOptions, primary_key: &str) -> String {
        let mut suffix = String::new();
        if !primary_key.is_empty() {
            suffix.push_str(&format!(" PRIMARY KEY ({primary_key})"));
        }
        let comment = clean(options.table_comment.as_deref().unwrap_or(""));
        if !comment.is_empty() {
            suffix.push_str(&format!(" COMMENT {}", quote_string(&comment)));
        }
        suffix
    }
    fn partition_clause(&self, columns: &[&EditableStructureColumn]) -> String {
        super::starrocks_partition::render(&self.settings, columns)
    }
    fn sort_clause(&self, columns: &[&EditableStructureColumn]) -> String {
        if self.settings.sort_column_ids.is_empty() { return String::new(); }
        let keys = self.settings.sort_column_ids.iter()
            .filter_map(|id| columns.iter().find(|column| &column.id == id))
            .map(|column| quote_ident(StructureDialect::Mysql, &column.name))
            .collect::<Vec<_>>().join(", ");
        format!(" ORDER BY ({keys})")
    }
    fn after_partition(&self, columns: &[&EditableStructureColumn], primary_key: &str) -> String {
        let distribution = if self.settings.distribution == StarRocksDistribution::Hash {
            let keys = self
                .settings
                .distribution_column_ids
                .iter()
                .filter_map(|id| columns.iter().find(|column| &column.id == id))
                .map(|column| quote_ident(StructureDialect::Mysql, &column.name))
                .collect::<Vec<_>>()
                .join(", ");
            format!(" DISTRIBUTED BY HASH ({keys})")
        } else if self.settings.distribution == StarRocksDistribution::Random {
            " DISTRIBUTED BY RANDOM".into()
        } else if !primary_key.is_empty() {
            format!(" DISTRIBUTED BY HASH ({primary_key})")
        } else if self.at_least((3, 1, 0)) {
            " DISTRIBUTED BY RANDOM".to_string()
        } else {
            format!(" DISTRIBUTED BY HASH ({})", quote_ident(StructureDialect::Mysql, &columns[0].name))
        };
        // Automatic bucket counts are supported from 2.5.7 onward.
        if let Some(count) = self.settings.bucket_count {
            format!("{distribution} BUCKETS {count}")
        } else if self.at_least((2, 5, 7)) {
            distribution
        } else {
            format!("{distribution} BUCKETS 10")
        }
    }
}
