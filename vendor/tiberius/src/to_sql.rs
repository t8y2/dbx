use crate::{
    tds::{codec::ColumnData, Numeric},
    xml::XmlData,
};
use std::borrow::Cow;
use uuid::Uuid;

/// A conversion trait to a TDS type.
///
/// A `ToSql` implementation for a Rust type is needed for using it as a
/// parameter in the [`Client#query`] or [`Client#execute`] methods. The
/// following Rust types are already implemented to match the given server
/// types:
///
/// |Rust type|Server type|
/// |--------|--------|
/// |`u8`|`tinyint`|
/// |`i16`|`smallint`|
/// |`i32`|`int`|
/// |`i64`|`bigint`|
/// |`f32`|`float(24)`|
/// |`f64`|`float(53)`|
/// |`bool`|`bit`|
/// |`String`/`&str` (< 4000 characters)|`nvarchar(4000)`|
/// |`String`/`&str`|`nvarchar(max)`|
/// |`Vec<u8>`/`&[u8]` (< 8000 bytes)|`varbinary(8000)`|
/// |`Vec<u8>`/`&[u8]`|`varbinary(max)`|
/// |[`Uuid`]|`uniqueidentifier`|
/// |[`Numeric`]|`numeric`/`decimal`|
/// |[`Decimal`] (with feature flag `rust_decimal`)|`numeric`/`decimal`|
/// |[`BigDecimal`] (with feature flag `bigdecimal`)|`numeric`/`decimal`|
/// |[`XmlData`]|`xml`|
/// |[`NaiveDate`] (with `chrono` feature, TDS 7.3 >)|`date`|
/// |[`NaiveTime`] (with `chrono` feature, TDS 7.3 >)|`time`|
/// |[`DateTime`] (with `chrono` feature, TDS 7.3 >)|`datetimeoffset`|
/// |[`NaiveDateTime`] (with `chrono` feature, TDS 7.3 >)|`datetime2`|
/// |[`NaiveDateTime`] (with `chrono` feature, TDS 7.2)|`datetime`|
///
/// It is possible to use some of the types to write into columns that are not
/// of the same type. For example on systems following the TDS 7.3 standard (SQL
/// Server 2008 and later), the chrono type `NaiveDateTime` can also be used to
/// write to `datetime`, `datetime2` and `smalldatetime` columns. All string
/// types can also be used with `ntext`, `text`, `varchar`, `nchar` and `char`
/// columns. All binary types can also be used with `binary` and `image`
/// columns.
///
/// See the [`time`] module for more information about the date and time structs.
///
/// [`Client#query`]: struct.Client.html#method.query
/// [`Client#execute`]: struct.Client.html#method.execute
/// [`time`]: time/index.html
/// [`Uuid`]: struct.Uuid.html
/// [`Numeric`]: numeric/struct.Numeric.html
/// [`Decimal`]: numeric/struct.Decimal.html
/// [`BigDecimal`]: numeric/struct.BigDecimal.html
/// [`XmlData`]: xml/struct.XmlData.html
/// [`NaiveDateTime`]: time/chrono/struct.NaiveDateTime.html
/// [`NaiveDate`]: time/chrono/struct.NaiveDate.html
/// [`NaiveTime`]: time/chrono/struct.NaiveTime.html
/// [`DateTime`]: time/chrono/struct.DateTime.html
pub trait ToSql: Send + Sync {
    /// Convert to a value understood by the SQL Server. Conversion
    /// by-reference.
    fn to_sql(&self) -> ColumnData<'_>;
}

/// A by-value conversion trait to a TDS type.
pub trait IntoSql<'a>: Send + Sync {
    /// Convert to a value understood by the SQL Server. Conversion by-value.
    fn into_sql(self) -> ColumnData<'a>;
}

impl<'a> IntoSql<'a> for &'a str {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::String(Some(Cow::Borrowed(self)))
    }
}

impl<'a> IntoSql<'a> for Option<&'a str> {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::String(self.map(Cow::Borrowed))
    }
}

impl<'a> IntoSql<'a> for &'a String {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::String(Some(Cow::Borrowed(self)))
    }
}

impl<'a> IntoSql<'a> for Option<&'a String> {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::String(self.map(Cow::from))
    }
}

impl<'a> IntoSql<'a> for &'a [u8] {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::Binary(Some(Cow::Borrowed(self)))
    }
}

impl<'a> IntoSql<'a> for Option<&'a [u8]> {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::Binary(self.map(Cow::Borrowed))
    }
}

impl<'a> IntoSql<'a> for &'a Vec<u8> {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::Binary(Some(Cow::from(self)))
    }
}

impl<'a> IntoSql<'a> for Option<&'a Vec<u8>> {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::Binary(self.map(Cow::from))
    }
}

impl<'a> IntoSql<'a> for Cow<'a, str> {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::String(Some(self))
    }
}

impl<'a> IntoSql<'a> for Option<Cow<'a, str>> {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::String(self)
    }
}

impl<'a> IntoSql<'a> for Cow<'a, [u8]> {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::Binary(Some(self))
    }
}

impl<'a> IntoSql<'a> for Option<Cow<'a, [u8]>> {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::Binary(self)
    }
}

impl<'a> IntoSql<'a> for &'a XmlData {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::Xml(Some(Cow::Borrowed(self)))
    }
}

impl<'a> IntoSql<'a> for Option<&'a XmlData> {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::Xml(self.map(Cow::Borrowed))
    }
}

impl<'a> IntoSql<'a> for &'a Uuid {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::Guid(Some(*self))
    }
}

impl<'a> IntoSql<'a> for Option<&'a Uuid> {
    fn into_sql(self) -> ColumnData<'a> {
        ColumnData::Guid(self.copied())
    }
}

into_sql!(self_,
          String: (ColumnData::String, Cow::from(self_));
          Vec<u8>: (ColumnData::Binary, Cow::from(self_));
          Numeric: (ColumnData::Numeric, self_);
          XmlData: (ColumnData::Xml, Cow::Owned(self_));
          Uuid: (ColumnData::Guid, self_);
          bool: (ColumnData::Bit, self_);
          u8: (ColumnData::U8, self_);
          i16: (ColumnData::I16, self_);
          i32: (ColumnData::I32, self_);
          i64: (ColumnData::I64, self_);
          f32: (ColumnData::F32, self_);
          f64: (ColumnData::F64, self_);
);

to_sql!(self_,
        bool: (ColumnData::Bit, *self_);
        u8: (ColumnData::U8, *self_);
        i16: (ColumnData::I16, *self_);
        i32: (ColumnData::I32, *self_);
        i64: (ColumnData::I64, *self_);
        f32: (ColumnData::F32, *self_);
        f64: (ColumnData::F64, *self_);
        &str: (ColumnData::String, Cow::from(*self_));
        String: (ColumnData::String, Cow::from(self_));
        Cow<'_, str>: (ColumnData::String, self_.clone());
        &[u8]: (ColumnData::Binary, Cow::from(*self_));
        Cow<'_, [u8]>: (ColumnData::Binary, self_.clone());
        Vec<u8>: (ColumnData::Binary, Cow::from(self_));
        Numeric: (ColumnData::Numeric, *self_);
        XmlData: (ColumnData::Xml, Cow::Borrowed(self_));
        Uuid: (ColumnData::Guid, *self_);
);
