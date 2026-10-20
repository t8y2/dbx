use crate::RowChange;
use mysql_common::collations::{Collation, CollationId};
use mysql_common::{binlog::row::BinlogRow, constants::ColumnFlags};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaManifest {
    pub version: u32,
    pub binlog_sha256: String,
    pub valid_from: u64,
    pub valid_to: u64,
    pub provenance: String,
    pub historical: bool,
    pub tables: Vec<TableSchema>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TableSchema {
    pub database: String,
    pub table: String,
    pub engine: String,
    pub no_triggers_or_foreign_keys: bool,
    pub columns: Vec<ColumnSchema>,
    pub primary_key: Vec<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ColumnSchema {
    pub name: String,
    pub wire_type: u8,
    pub wire_metadata: Vec<u8>,
    pub unsigned: bool,
    pub nullable: bool,
    pub generated: bool,
    pub kind: ValueKind,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ValueKind {
    Integer,
    Binary,
    Text { charset: String },
    Decimal { precision: u8, scale: u8 },
    Json,
    DateTime { precision: u8 },
    Timestamp { precision: u8 },
    Time { precision: u8 },
}

pub(crate) fn valid_identifier(name: &str) -> bool {
    !name.is_empty() && !name.contains('\0') && name.chars().count() <= 64
}

impl TableSchema {
    pub(crate) fn validate(&self, change: &RowChange) -> Result<(), String> {
        if !self.engine.eq_ignore_ascii_case("InnoDB") || !self.no_triggers_or_foreign_keys {
            return Err("only attested InnoDB tables without triggers/FKs are supported".into());
        }
        if !valid_identifier(&self.database) || !valid_identifier(&self.table) {
            return Err("invalid table identifier".into());
        }
        let count = self.columns.len();
        if count == 0 || change.wire_columns.len() != count || !change.full_image || !change.has_column_names {
            return Err("FULL images and historical column names are required".into());
        }
        let mut names = HashSet::new();
        for (column, wire) in self.columns.iter().zip(&change.wire_columns) {
            if !valid_identifier(&column.name) || !names.insert(column.name.to_lowercase()) || column.generated {
                return Err("invalid/duplicate/generated historical column".into());
            }
            if column.wire_type != wire.type_code
                || column.wire_metadata != wire.metadata
                || column.nullable != wire.nullable
            {
                return Err("historical column wire metadata mismatch".into());
            }
            let valid_kind = match &column.kind {
                ValueKind::Integer => matches!(wire.type_code, 1 | 2 | 3 | 8 | 9) && wire.metadata.is_empty(),
                ValueKind::Binary | ValueKind::Text { .. } => {
                    !column.unsigned
                        && match wire.type_code {
                            15 => wire.metadata.len() == 2 && wire.metadata != [0, 0],
                            252 => matches!(wire.metadata.as_slice(), [1..=4]),
                            _ => false,
                        }
                }
                ValueKind::Decimal { precision, scale } => {
                    wire.type_code == 246
                        && *precision > 0
                        && *precision <= 65
                        && *scale <= 30
                        && scale <= precision
                        && wire.metadata == [*precision, *scale]
                }
                ValueKind::Json => wire.type_code == 245 && wire.metadata == [4] && !column.unsigned,
                ValueKind::DateTime { precision }
                | ValueKind::Timestamp { precision }
                | ValueKind::Time { precision } => {
                    let expected = match column.kind {
                        ValueKind::DateTime { .. } => 18,
                        ValueKind::Timestamp { .. } => 17,
                        _ => 19,
                    };
                    *precision <= 6 && wire.type_code == expected && wire.metadata == [*precision] && !column.unsigned
                }
            };
            if !valid_kind {
                return Err("unsupported or mismatched historical column type".into());
            }
            if matches!(column.kind, ValueKind::Integer | ValueKind::Decimal { .. }) && !change.has_signedness {
                return Err("numeric signedness metadata is required".into());
            }
        }
        let mut keys = HashSet::new();
        if self.primary_key.is_empty()
            || self.primary_key.iter().any(|&i| i >= count || self.columns[i].nullable || !keys.insert(i))
        {
            return Err("a non-null unique primary key is required".into());
        }
        for (image, ordinals) in [(&change.before, &change.before_columns), (&change.after, &change.after_columns)] {
            if let Some(image) = image {
                if image.len() != count || ordinals.iter().copied().ne(0..count) {
                    return Err("incomplete row image".into());
                }
                self.validate_image_metadata(image)?;
            }
        }
        Ok(())
    }

    fn validate_image_metadata(&self, row: &BinlogRow) -> Result<(), String> {
        for (i, (column, wire)) in self.columns.iter().zip(row.columns_ref()).enumerate() {
            if column.name.as_bytes() != wire.name_ref()
                || column.unsigned != wire.flags().contains(ColumnFlags::UNSIGNED_FLAG)
                || self.primary_key.contains(&i) != wire.flags().contains(ColumnFlags::PRI_KEY_FLAG)
            {
                return Err("historical name/signedness/primary key metadata mismatch".into());
            }
            if wire.character_set() != 0 {
                let collation = Collation::resolve(CollationId::from(wire.character_set()));
                let expected = match &column.kind {
                    ValueKind::Text { charset } => Some(if charset == "utf8" { "utf8mb3" } else { charset.as_str() }),
                    ValueKind::Binary => Some("binary"),
                    _ => None,
                };
                if expected.is_some_and(|expected| expected != collation.charset()) {
                    return Err("historical character set metadata mismatch".into());
                }
            }
        }
        Ok(())
    }
}
