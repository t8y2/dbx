use sqlparser::ast::{CharLengthUnits, CharacterLength, DataType, ExactNumberInfo, TimezoneInfo};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LengthSemantics {
    Bytes,
    Characters,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "parameters", rename_all = "camelCase")]
pub(super) enum ColumnType {
    Number { precision: Option<u64>, scale: Option<i64> },
    Float(u64),
    Character { kind: String, length: u64, semantics: LengthSemantics },
    Raw(u64),
    Timestamp { precision: u64, with_time_zone: bool },
    Date,
    BinaryFloat,
    BinaryDouble,
    Clob,
    Nclob,
    Blob,
    External { owner: String, name: String },
}

pub(super) fn from_ast(data_type: &DataType, default_length: Option<LengthSemantics>) -> Result<ColumnType, String> {
    match data_type {
        DataType::Char(length) | DataType::Character(length) | DataType::Varchar(length) => {
            let (length, explicit) = match length {
                None => (1, None),
                Some(CharacterLength::IntegerLength { length, unit }) => (
                    *length,
                    match unit {
                        None => None,
                        Some(CharLengthUnits::Characters) => Some(LengthSemantics::Characters),
                        Some(CharLengthUnits::Octets) => Some(LengthSemantics::Bytes),
                    },
                ),
                _ => return Err("The character column length is not a bounded integer".into()),
            };
            if length == 0 {
                return Err("The character column length is invalid".into());
            }
            let semantics = explicit.or(default_length).ok_or("The target execution session's default character length semantics are not verified; retain the table draft")?;
            Ok(ColumnType::Character {
                kind: if matches!(data_type, DataType::Varchar(_)) { "VARCHAR2" } else { "CHAR" }.into(),
                length,
                semantics,
            })
        }
        DataType::Float(info) => match info {
            ExactNumberInfo::None => Ok(ColumnType::Float(126)),
            ExactNumberInfo::Precision(precision) if (1..=126).contains(precision) => Ok(ColumnType::Float(*precision)),
            _ => Err("The Oracle FLOAT binary precision is not verified".into()),
        },
        DataType::Clob(None) => Ok(ColumnType::Clob),
        DataType::Blob(None) => Ok(ColumnType::Blob),
        DataType::Timestamp(precision, zone) => {
            let precision = precision.unwrap_or(6);
            if precision > 9 || !matches!(zone, TimezoneInfo::None | TimezoneInfo::WithTimeZone) {
                return Err("The table timestamp precision or time-zone semantics are not verified".into());
            }
            Ok(ColumnType::Timestamp { precision, with_time_zone: *zone == TimezoneInfo::WithTimeZone })
        }
        DataType::Date => Ok(ColumnType::Date),
        DataType::Custom(name, parameters) => {
            if let [owner, name] = name.0.as_slice() {
                let effective = |part: &sqlparser::ast::ObjectNamePart| -> Result<String, String> {
                    let ident = part.as_ident().ok_or("The external type identity is not a plain identifier")?;
                    Ok(if ident.quote_style.is_some() { ident.value.clone() } else { ident.value.to_uppercase() })
                };
                if !parameters.is_empty() {
                    return Err("An external column type cannot have unverified parameters".into());
                }
                return Ok(ColumnType::External { owner: effective(owner)?, name: effective(name)? });
            }
            let [part] = name.0.as_slice() else {
                return Err("An external table-column type requires its exact target type evidence".into());
            };
            let identifier = part.as_ident().ok_or("The table-column type identity is not a plain identifier")?;
            if identifier.quote_style.is_some() {
                return Err("A quoted table-column type requires its exact target type evidence".into());
            }
            let kind = identifier.value.to_ascii_uppercase();
            match kind.as_str() {
                "NUMBER" => {
                    let (precision, scale) = match parameters.as_slice() {
                        [] => (None, None),
                        [precision] => (Some(positive(precision)?), Some(0)),
                        [precision, scale] => (
                            if precision == "*" { None } else { Some(positive(precision)?) },
                            Some(scale.parse::<i64>().map_err(|_| "The NUMBER scale is incomplete")?),
                        ),
                        _ => return Err("The NUMBER parameters are incomplete".into()),
                    };
                    number(precision, scale)
                }
                "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" => {
                    let (length, explicit) = match parameters.as_slice() {
                        [length] => (positive(length)?, None),
                        [length, unit] if unit.eq_ignore_ascii_case("BYTE") => {
                            (positive(length)?, Some(LengthSemantics::Bytes))
                        }
                        [length, unit] if unit.eq_ignore_ascii_case("CHAR") => {
                            (positive(length)?, Some(LengthSemantics::Characters))
                        }
                        _ => return Err("The character column length or unit is incomplete".into()),
                    };
                    let national = kind == "NCHAR" || kind == "NVARCHAR2";
                    if national && explicit == Some(LengthSemantics::Bytes) {
                        return Err("A national character column cannot use BYTE semantics".into());
                    }
                    let semantics = if national {
                        LengthSemantics::Characters
                    } else {
                        explicit.or(default_length).ok_or("The target execution session's default character length semantics are not verified; retain the table draft")?
                    };
                    Ok(ColumnType::Character { kind, length, semantics })
                }
                "RAW" if parameters.len() == 1 => Ok(ColumnType::Raw(positive(&parameters[0])?)),
                "BINARY_FLOAT" if parameters.is_empty() => Ok(ColumnType::BinaryFloat),
                "BINARY_DOUBLE" if parameters.is_empty() => Ok(ColumnType::BinaryDouble),
                "CLOB" if parameters.is_empty() => Ok(ColumnType::Clob),
                "NCLOB" if parameters.is_empty() => Ok(ColumnType::Nclob),
                "BLOB" if parameters.is_empty() => Ok(ColumnType::Blob),
                _ => Err(format!("Table-column type {kind} requires verified target type semantics")),
            }
        }
        _ => Err("The final table-column type requires verified Oracle type semantics".into()),
    }
}

fn positive(text: &str) -> Result<u64, String> {
    text.parse::<u64>().ok().filter(|value| *value > 0).ok_or_else(|| "The type length or precision is invalid".into())
}

fn number(precision: Option<u64>, scale: Option<i64>) -> Result<ColumnType, String> {
    if precision.is_some_and(|precision| !(1..=38).contains(&precision))
        || scale.is_some_and(|scale| !(-84..=127).contains(&scale))
    {
        return Err("The NUMBER precision or scale is outside the verified Oracle range".into());
    }
    Ok(ColumnType::Number { precision, scale })
}

pub(super) struct CatalogColumnType<'a> {
    pub data_type: &'a str,
    pub data_type_owner: Option<&'a str>,
    pub data_length: u64,
    pub char_length: u64,
    pub char_used: Option<&'a str>,
    pub precision: Option<u64>,
    pub scale: Option<i64>,
}

pub(super) fn from_catalog(column: CatalogColumnType<'_>) -> Result<ColumnType, String> {
    if let Some(owner) = column.data_type_owner {
        if owner.is_empty() || column.data_type.is_empty() {
            return Err("The external catalog type identity is incomplete".into());
        }
        return Ok(ColumnType::External { owner: owner.into(), name: column.data_type.into() });
    }
    match column.data_type {
        "NUMBER" => number(column.precision, column.scale),
        "FLOAT" if column.scale.is_none() => match column.precision {
            Some(precision) if (1..=126).contains(&precision) => Ok(ColumnType::Float(precision)),
            _ => Err("The catalog FLOAT binary precision is incomplete".into()),
        },
        "VARCHAR2" | "CHAR" | "NVARCHAR2" | "NCHAR" => {
            let semantics = match column.char_used {
                Some("B") => LengthSemantics::Bytes,
                Some("C") => LengthSemantics::Characters,
                _ => return Err("The catalog character length semantics are incomplete".into()),
            };
            let length = if semantics == LengthSemantics::Bytes { column.data_length } else { column.char_length };
            if matches!(column.data_type, "NCHAR" | "NVARCHAR2") && semantics != LengthSemantics::Characters {
                return Err("The national character column has inconsistent length semantics".into());
            }
            if length == 0 {
                return Err("The catalog character length is incomplete".into());
            }
            Ok(ColumnType::Character { kind: column.data_type.into(), length, semantics })
        }
        "RAW" if column.data_length > 0 => Ok(ColumnType::Raw(column.data_length)),
        "DATE" => Ok(ColumnType::Date),
        "BINARY_FLOAT" => Ok(ColumnType::BinaryFloat),
        "BINARY_DOUBLE" => Ok(ColumnType::BinaryDouble),
        "CLOB" => Ok(ColumnType::Clob),
        "NCLOB" => Ok(ColumnType::Nclob),
        "BLOB" => Ok(ColumnType::Blob),
        data_type if data_type.starts_with("TIMESTAMP") => {
            let dialect = sqlparser::dialect::OracleDialect {};
            let mut parser =
                sqlparser::parser::Parser::new(&dialect).try_with_sql(data_type).map_err(|error| error.to_string())?;
            let data_type = parser.parse_data_type().map_err(|error| error.to_string())?;
            if parser.peek_token().token != sqlparser::tokenizer::Token::EOF {
                return Err("The catalog timestamp type has unverified trailing text".into());
            }
            let result = from_ast(&data_type, None)?;
            if !matches!(&result, ColumnType::Timestamp { precision, .. } if Some(*precision as i64) == column.scale) {
                return Err("The catalog timestamp precision fields disagree".into());
            }
            Ok(result)
        }
        _ => Err("The catalog table-column type is not completely verified".into()),
    }
}
