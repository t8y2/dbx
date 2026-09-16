use std::{
    borrow::{BorrowMut, Cow},
    fmt::Display,
};

use crate::{
    error::Error,
    tds::codec::{Encode, FixedLenType, TokenType, TypeInfo, VarLenType},
    Column, ColumnData, ColumnType, SqlReadBytes,
};
use asynchronous_codec::BytesMut;
use bytes::BufMut;
use enumflags2::{bitflags, BitFlags};

#[derive(Debug, Clone)]
pub struct TokenColMetaData<'a> {
    pub columns: Vec<MetaDataColumn<'a>>,
}

#[derive(Debug, Clone)]
pub struct MetaDataColumn<'a> {
    pub base: BaseMetaDataColumn,
    pub col_name: Cow<'a, str>,
}

impl<'a> Display for MetaDataColumn<'a> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ", self.col_name)?;

        match &self.base.ty {
            TypeInfo::FixedLen(fixed) => match fixed {
                FixedLenType::Int1 => write!(f, "tinyint")?,
                FixedLenType::Bit => write!(f, "bit")?,
                FixedLenType::Int2 => write!(f, "smallint")?,
                FixedLenType::Int4 => write!(f, "int")?,
                FixedLenType::Datetime4 => write!(f, "smalldatetime")?,
                FixedLenType::Float4 => write!(f, "real")?,
                FixedLenType::Money => write!(f, "money")?,
                FixedLenType::Datetime => write!(f, "datetime")?,
                FixedLenType::Float8 => write!(f, "float")?,
                FixedLenType::Money4 => write!(f, "smallmoney")?,
                FixedLenType::Int8 => write!(f, "bigint")?,
                FixedLenType::Null => unreachable!(),
            },
            TypeInfo::VarLenSized(ctx) => match ctx.r#type() {
                VarLenType::Bitn => write!(f, "bit")?,
                VarLenType::Guid => write!(f, "uniqueidentifier")?,
                #[cfg(feature = "tds73")]
                VarLenType::Daten => write!(f, "date")?,
                #[cfg(feature = "tds73")]
                VarLenType::Timen => write!(f, "time")?,
                #[cfg(feature = "tds73")]
                VarLenType::Datetime2 => write!(f, "datetime2({})", ctx.len())?,
                VarLenType::Datetimen => write!(f, "datetime")?,
                #[cfg(feature = "tds73")]
                VarLenType::DatetimeOffsetn => write!(f, "datetimeoffset")?,
                VarLenType::BigVarBin => {
                    if ctx.len() <= 8000 {
                        write!(f, "varbinary({})", ctx.len())?
                    } else {
                        write!(f, "varbinary(max)")?
                    }
                }
                VarLenType::BigVarChar => {
                    if ctx.len() <= 8000 {
                        write!(f, "varchar({})", ctx.len())?
                    } else {
                        write!(f, "varchar(max)")?
                    }
                }
                VarLenType::BigBinary => write!(f, "binary({})", ctx.len())?,
                VarLenType::BigChar => write!(f, "char({})", ctx.len())?,
                VarLenType::NVarchar => {
                    if ctx.len() <= 4000 {
                        write!(f, "nvarchar({})", ctx.len())?
                    } else {
                        write!(f, "nvarchar(max)")?
                    }
                }
                VarLenType::NChar => write!(f, "nchar({})", ctx.len())?,
                VarLenType::Text => write!(f, "text")?,
                VarLenType::Image => write!(f, "image")?,
                VarLenType::NText => write!(f, "ntext")?,
                VarLenType::Intn => match ctx.len() {
                    1 => write!(f, "tinyint")?,
                    2 => write!(f, "smallint")?,
                    4 => write!(f, "int")?,
                    8 => write!(f, "bigint")?,
                    _ => unreachable!(),
                },
                VarLenType::Floatn => match ctx.len() {
                    4 => write!(f, "real")?,
                    8 => write!(f, "float")?,
                    _ => unreachable!(),
                },
                _ => unreachable!(),
            },
            TypeInfo::VarLenSizedPrecision {
                ty,
                size: _,
                precision,
                scale,
            } => match ty {
                VarLenType::Decimaln => write!(f, "decimal({},{})", precision, scale)?,
                VarLenType::Numericn => write!(f, "numeric({},{})", precision, scale)?,
                _ => unreachable!(),
            },
            TypeInfo::Xml { .. } => write!(f, "xml")?,
        }

        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct BaseMetaDataColumn {
    pub flags: BitFlags<ColumnFlag>,
    pub ty: TypeInfo,
}

impl BaseMetaDataColumn {
    pub(crate) fn null_value(&self) -> ColumnData<'static> {
        match &self.ty {
            TypeInfo::FixedLen(ty) => match ty {
                FixedLenType::Null => ColumnData::I32(None),
                FixedLenType::Int1 => ColumnData::U8(None),
                FixedLenType::Bit => ColumnData::Bit(None),
                FixedLenType::Int2 => ColumnData::I16(None),
                FixedLenType::Int4 => ColumnData::I32(None),
                FixedLenType::Datetime4 => ColumnData::SmallDateTime(None),
                FixedLenType::Float4 => ColumnData::F32(None),
                FixedLenType::Money => ColumnData::F64(None),
                FixedLenType::Datetime => ColumnData::DateTime(None),
                FixedLenType::Float8 => ColumnData::F64(None),
                FixedLenType::Money4 => ColumnData::F32(None),
                FixedLenType::Int8 => ColumnData::I64(None),
            },
            TypeInfo::VarLenSized(cx) => match cx.r#type() {
                VarLenType::Guid => ColumnData::Guid(None),
                VarLenType::Intn => match cx.len() {
                    1 => ColumnData::U8(None),
                    2 => ColumnData::I16(None),
                    4 => ColumnData::I32(None),
                    _ => ColumnData::I64(None),
                },
                VarLenType::Bitn => ColumnData::Bit(None),
                VarLenType::Decimaln => ColumnData::Numeric(None),
                VarLenType::Numericn => ColumnData::Numeric(None),
                VarLenType::Floatn => match cx.len() {
                    4 => ColumnData::F32(None),
                    _ => ColumnData::F64(None),
                },
                VarLenType::Money => ColumnData::F64(None),
                VarLenType::Datetimen => ColumnData::DateTime(None),
                #[cfg(feature = "tds73")]
                VarLenType::Daten => ColumnData::Date(None),
                #[cfg(feature = "tds73")]
                VarLenType::Timen => ColumnData::Time(None),
                #[cfg(feature = "tds73")]
                VarLenType::Datetime2 => ColumnData::DateTime2(None),
                #[cfg(feature = "tds73")]
                VarLenType::DatetimeOffsetn => ColumnData::DateTimeOffset(None),
                VarLenType::BigVarBin => ColumnData::Binary(None),
                VarLenType::BigVarChar => ColumnData::String(None),
                VarLenType::BigBinary => ColumnData::Binary(None),
                VarLenType::BigChar => ColumnData::String(None),
                VarLenType::NVarchar => ColumnData::String(None),
                VarLenType::NChar => ColumnData::String(None),
                VarLenType::Xml => ColumnData::Xml(None),
                VarLenType::Udt => todo!("User-defined types not supported"),
                VarLenType::Text => ColumnData::String(None),
                VarLenType::Image => ColumnData::Binary(None),
                VarLenType::NText => ColumnData::String(None),
                VarLenType::SSVariant => todo!(),
            },
            TypeInfo::VarLenSizedPrecision { ty, .. } => match ty {
                VarLenType::Guid => ColumnData::Guid(None),
                VarLenType::Intn => ColumnData::I32(None),
                VarLenType::Bitn => ColumnData::Bit(None),
                VarLenType::Decimaln => ColumnData::Numeric(None),
                VarLenType::Numericn => ColumnData::Numeric(None),
                VarLenType::Floatn => ColumnData::F32(None),
                VarLenType::Money => ColumnData::F64(None),
                VarLenType::Datetimen => ColumnData::DateTime(None),
                #[cfg(feature = "tds73")]
                VarLenType::Daten => ColumnData::Date(None),
                #[cfg(feature = "tds73")]
                VarLenType::Timen => ColumnData::Time(None),
                #[cfg(feature = "tds73")]
                VarLenType::Datetime2 => ColumnData::DateTime2(None),
                #[cfg(feature = "tds73")]
                VarLenType::DatetimeOffsetn => ColumnData::DateTimeOffset(None),
                VarLenType::BigVarBin => ColumnData::Binary(None),
                VarLenType::BigVarChar => ColumnData::String(None),
                VarLenType::BigBinary => ColumnData::Binary(None),
                VarLenType::BigChar => ColumnData::String(None),
                VarLenType::NVarchar => ColumnData::String(None),
                VarLenType::NChar => ColumnData::String(None),
                VarLenType::Xml => ColumnData::Xml(None),
                VarLenType::Udt => todo!("User-defined types not supported"),
                VarLenType::Text => ColumnData::String(None),
                VarLenType::Image => ColumnData::Binary(None),
                VarLenType::NText => ColumnData::String(None),
                VarLenType::SSVariant => todo!(),
            },
            TypeInfo::Xml { .. } => ColumnData::Xml(None),
        }
    }
}

impl<'a> Encode<BytesMut> for TokenColMetaData<'a> {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        dst.put_u8(TokenType::ColMetaData as u8);
        dst.put_u16_le(self.columns.len() as u16);

        for col in self.columns.into_iter() {
            col.encode(dst)?;
        }

        Ok(())
    }
}

impl<'a> Encode<BytesMut> for MetaDataColumn<'a> {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        dst.put_u32_le(0);
        self.base.encode(dst)?;

        let len_pos = dst.len();
        let mut length = 0u8;

        dst.put_u8(length);

        for chr in self.col_name.encode_utf16() {
            length += 1;
            dst.put_u16_le(chr);
        }

        let dst: &mut [u8] = dst.borrow_mut();
        dst[len_pos] = length;

        Ok(())
    }
}

impl Encode<BytesMut> for BaseMetaDataColumn {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        dst.put_u16_le(BitFlags::bits(self.flags));
        self.ty.encode(dst)?;

        Ok(())
    }
}

/// A setting a column can hold.
#[bitflags]
#[repr(u16)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnFlag {
    /// The column can be null.
    Nullable = 1 << 0,
    /// Set for string columns with binary collation and always for the XML data
    /// type.
    CaseSensitive = 1 << 1,
    /// If column is writeable.
    Updateable = 1 << 3,
    /// Column modification status unknown.
    UpdateableUnknown = 1 << 4,
    /// Column is an identity.
    Identity = 1 << 5,
    /// Coulumn is computed.
    Computed = 1 << 7,
    /// Column is a fixed-length common language runtime user-defined type (CLR
    /// UDT).
    FixedLenClrType = 1 << 10,
    /// Column is the special XML column for the sparse column set.
    SparseColumnSet = 1 << 11,
    /// Column is encrypted transparently and has to be decrypted to view the
    /// plaintext value. This flag is valid when the column encryption feature
    /// is negotiated between client and server and is turned on.
    Encrypted = 1 << 12,
    /// Column is part of a hidden primary key created to support a T-SQL SELECT
    /// statement containing FOR BROWSE.
    Hidden = 1 << 13,
    /// Column is part of a primary key for the row and the T-SQL SELECT
    /// statement contains FOR BROWSE.
    Key = 1 << 14,
    /// It is unknown whether the column might be nullable.
    NullableUnknown = 1 << 15,
}

impl TokenColMetaData<'static> {
    pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let column_count = src.read_u16_le().await?;
        let mut columns = Vec::with_capacity(column_count as usize);

        if column_count > 0 && column_count < 0xffff {
            for _ in 0..column_count {
                let base = BaseMetaDataColumn::decode(src).await?;
                let col_name = Cow::from(src.read_b_varchar().await?);

                columns.push(MetaDataColumn { base, col_name });
            }
        }

        Ok(TokenColMetaData { columns })
    }
}

impl<'a> TokenColMetaData<'a> {
    pub(crate) fn columns(&self) -> impl Iterator<Item = Column> + '_ {
        self.columns.iter().map(|x| Column {
            name: x.col_name.to_string(),
            column_type: ColumnType::from(&x.base.ty),
        })
    }
}

impl BaseMetaDataColumn {
    pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        use VarLenType::*;

        let _user_ty = src.read_u32_le().await?;

        let flags = BitFlags::from_bits(src.read_u16_le().await?)
            .map_err(|_| Error::Protocol("column metadata: invalid flags".into()))?;

        let ty = TypeInfo::decode(src).await?;

        if let TypeInfo::VarLenSized(cx) = ty {
            if let Text | NText | Image = cx.r#type() {
                let num_of_parts = src.read_u8().await?;

                // table name
                for _ in 0..num_of_parts {
                    src.read_us_varchar().await?;
                }
            };
        };

        Ok(BaseMetaDataColumn { flags, ty })
    }
}
