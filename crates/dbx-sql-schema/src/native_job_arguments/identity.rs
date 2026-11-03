use super::{AnydataColumn, NativeJobRow};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScalarType {
    Varchar2,
    Char,
    Nvarchar2,
    Nchar,
    Number,
    Date,
    Timestamp,
    TimestampTz,
    TimestampLtz,
    IntervalYm,
    IntervalDs,
    Raw,
    BinaryFloat,
    BinaryDouble,
    Urowid,
}

impl ScalarType {
    pub const ALL: [Self; 15] = [
        Self::Varchar2,
        Self::Char,
        Self::Nvarchar2,
        Self::Nchar,
        Self::Number,
        Self::Date,
        Self::Timestamp,
        Self::TimestampTz,
        Self::TimestampLtz,
        Self::IntervalYm,
        Self::IntervalDs,
        Self::Raw,
        Self::BinaryFloat,
        Self::BinaryDouble,
        Self::Urowid,
    ];

    pub fn token(self) -> &'static str {
        match self {
            Self::Varchar2 => "varchar2",
            Self::Char => "char",
            Self::Nvarchar2 => "nvarchar2",
            Self::Nchar => "nchar",
            Self::Number => "number",
            Self::Date => "date",
            Self::Timestamp => "timestamp",
            Self::TimestampTz => "timestamp-tz",
            Self::TimestampLtz => "timestamp-ltz",
            Self::IntervalYm => "interval-ym",
            Self::IntervalDs => "interval-ds",
            Self::Raw => "raw",
            Self::BinaryFloat => "binary-float",
            Self::BinaryDouble => "binary-double",
            Self::Urowid => "urowid",
        }
    }

    pub fn from_token(token: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.token() == token)
    }

    pub fn fixed_name(self) -> Option<&'static str> {
        Some(match self {
            Self::Varchar2 => "SYS.VARCHAR2",
            Self::Char => "SYS.CHAR",
            Self::Number => "SYS.NUMBER",
            Self::Date => "SYS.DATE",
            Self::Timestamp => "SYS.TIMESTAMP",
            Self::TimestampTz => "SYS.TIMESTAMPTZ",
            Self::TimestampLtz => "SYS.TIMESTAMPLTZ",
            Self::Raw => "SYS.RAW",
            _ => return None,
        })
    }

    pub fn from_fixed_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.fixed_name() == Some(name))
    }

    pub fn convert(self) -> &'static str {
        match self {
            Self::Varchar2 => "ConvertVarchar2",
            Self::Char => "ConvertChar",
            Self::Nvarchar2 => "ConvertNVarchar2",
            Self::Nchar => "ConvertNchar",
            Self::Number => "ConvertNumber",
            Self::Date => "ConvertDate",
            Self::Timestamp => "ConvertTimestamp",
            Self::TimestampTz => "ConvertTimestampTZ",
            Self::TimestampLtz => "ConvertTimestampLTZ",
            Self::IntervalYm => "ConvertIntervalYM",
            Self::IntervalDs => "ConvertIntervalDS",
            Self::Raw => "ConvertRaw",
            Self::BinaryFloat => "ConvertBFloat",
            Self::BinaryDouble => "ConvertBDouble",
            Self::Urowid => "ConvertURowid",
        }
    }

    pub fn access(self) -> &'static str {
        match self {
            Self::Varchar2 => "AccessVarchar2",
            Self::Char => "AccessChar",
            Self::Nvarchar2 => "AccessNVarchar2",
            Self::Nchar => "AccessNchar",
            Self::Number => "AccessNumber",
            Self::Date => "AccessDate",
            Self::Timestamp => "AccessTimestamp",
            Self::TimestampTz => "AccessTimestampTZ",
            Self::TimestampLtz => "AccessTimestampLTZ",
            Self::IntervalYm => "AccessIntervalYM",
            Self::IntervalDs => "AccessIntervalDS",
            Self::Raw => "AccessRaw",
            Self::BinaryFloat => "AccessBFloat",
            Self::BinaryDouble => "AccessBDouble",
            Self::Urowid => "AccessURowid",
        }
    }

    pub fn null_cast(self) -> &'static str {
        match self {
            Self::Varchar2 => "VARCHAR2(4000)",
            Self::Char => "CHAR(1)",
            Self::Nvarchar2 => "NVARCHAR2(1)",
            Self::Nchar => "NCHAR(1)",
            Self::Number => "NUMBER",
            Self::Date => "DATE",
            Self::Timestamp => "TIMESTAMP(9)",
            Self::TimestampTz => "TIMESTAMP(9) WITH TIME ZONE",
            Self::TimestampLtz => "TIMESTAMP(9) WITH LOCAL TIME ZONE",
            Self::IntervalYm => "INTERVAL YEAR(9) TO MONTH",
            Self::IntervalDs => "INTERVAL DAY(9) TO SECOND(9)",
            Self::Raw => "RAW(1)",
            Self::BinaryFloat => "BINARY_FLOAT",
            Self::BinaryDouble => "BINARY_DOUBLE",
            Self::Urowid => "UROWID",
        }
    }

    pub fn null_expression(self) -> String {
        format!("SYS.ANYDATA.{}(CAST(NULL AS {}))", self.convert(), self.null_cast())
    }
}

impl AnydataColumn {
    pub(super) fn sql(self) -> &'static str {
        match self {
            Self::JobArgument => "J.ANYDATA_VALUE",
            Self::ProgramDefault => "J.DEFAULT_ANYDATA_VALUE",
        }
    }
}

pub fn anydata_query_prefix() -> String {
    let prototypes = ScalarType::ALL
        .into_iter()
        .enumerate()
        .filter(|(_, kind)| kind.fixed_name().is_none())
        .map(|(index, kind)| format!("{} AS T{index}", kind.null_expression()))
        .collect::<Vec<_>>()
        .join(", ");
    let names = ScalarType::ALL.into_iter().enumerate().map(|(index, kind)| {
        if let Some(name) = kind.fixed_name() {
            format!("SELECT '{}' AS CODEC, '{name}' AS TYPE_NAME FROM DUAL", kind.token())
        } else {
            format!("SELECT '{}' AS CODEC, CASE WHEN P0.T{index} IS NOT NULL THEN P0.T{index}.GetTypeName() END AS TYPE_NAME FROM DBX_ANYDATA_PROTOTYPES P0", kind.token())
        }
    }).collect::<Vec<_>>().join(" UNION ALL ");
    format!("WITH DBX_ANYDATA_PROTOTYPES AS (SELECT {prototypes} FROM DUAL), DBX_ANYDATA_TYPES AS ({names}), DBX_ANYDATA_UNIQUE AS (SELECT MIN(CODEC) AS CODEC, MIN(TYPE_NAME) AS TYPE_NAME FROM DBX_ANYDATA_TYPES WHERE TYPE_NAME IS NOT NULL GROUP BY SYS.UTL_RAW.CAST_TO_RAW(TYPE_NAME) HAVING COUNT(*) = 1) ")
}

pub fn anydata_join(column: AnydataColumn) -> String {
    let column = column.sql();
    format!(" LEFT JOIN DBX_ANYDATA_UNIQUE DBX_AT ON SYS.UTL_RAW.CAST_TO_RAW(CASE WHEN {column} IS NOT NULL THEN {column}.GetTypeName() END) = SYS.UTL_RAW.CAST_TO_RAW(DBX_AT.TYPE_NAME)")
}

pub(super) fn proven_type(row: &NativeJobRow, type_name: &str) -> Option<ScalarType> {
    if row.contains_key("DBX_ANYDATA_CODEC") || row.contains_key("DBX_ANYDATA_CONSTRUCTOR_TYPE") {
        let kind = ScalarType::from_token(row.get("DBX_ANYDATA_CODEC")?.as_str()?)?;
        if row.get("DBX_ANYDATA_CONSTRUCTOR_TYPE").and_then(Value::as_str) != Some(type_name)
            || kind.fixed_name().is_some_and(|name| name != type_name)
        {
            return None;
        }
        Some(kind)
    } else {
        // Existing proven fixed-type projections remain readable without a new global prerequisite.
        ScalarType::from_fixed_name(type_name)
    }
}
