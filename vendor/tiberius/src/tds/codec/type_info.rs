use asynchronous_codec::BytesMut;
use bytes::BufMut;

use crate::{tds::Collation, xml::XmlSchema, Error, SqlReadBytes};
use std::{convert::TryFrom, sync::Arc, usize};

use super::Encode;

/// A length of a column in bytes or characters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeLength {
    /// The number of bytes (or characters) reserved in the column.
    Limited(u16),
    /// Unlimited, stored in the heap outside of the row.
    Max,
}

/// Describes a type of a column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeInfo {
    FixedLen(FixedLenType),
    VarLenSized(VarLenContext),
    VarLenSizedPrecision {
        ty: VarLenType,
        size: usize,
        precision: u8,
        scale: u8,
    },
    Xml {
        schema: Option<Arc<XmlSchema>>,
        size: usize,
    },
}

#[derive(Clone, Debug, Copy, PartialEq, Eq)]
pub struct VarLenContext {
    r#type: VarLenType,
    len: usize,
    collation: Option<Collation>,
}

impl VarLenContext {
    pub fn new(r#type: VarLenType, len: usize, collation: Option<Collation>) -> Self {
        Self {
            r#type,
            len,
            collation,
        }
    }

    /// Get the var len context's r#type.
    pub fn r#type(&self) -> VarLenType {
        self.r#type
    }

    /// Get the var len context's len.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Get the var len context's collation.
    pub fn collation(&self) -> Option<Collation> {
        self.collation
    }
}

impl Encode<BytesMut> for VarLenContext {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        dst.put_u8(self.r#type() as u8);

        // length
        match self.r#type {
            #[cfg(feature = "tds73")]
            VarLenType::Daten
            | VarLenType::Timen
            | VarLenType::DatetimeOffsetn
            | VarLenType::Datetime2 => {
                dst.put_u8(self.len() as u8);
            }
            VarLenType::Bitn
            | VarLenType::Intn
            | VarLenType::Floatn
            | VarLenType::Decimaln
            | VarLenType::Numericn
            | VarLenType::Guid
            | VarLenType::Money
            | VarLenType::Datetimen => {
                dst.put_u8(self.len() as u8);
            }
            VarLenType::NChar
            | VarLenType::BigChar
            | VarLenType::NVarchar
            | VarLenType::BigVarChar
            | VarLenType::BigBinary
            | VarLenType::BigVarBin => {
                dst.put_u16_le(self.len() as u16);
            }
            VarLenType::Image | VarLenType::Text | VarLenType::NText => {
                dst.put_u32_le(self.len() as u32);
            }
            VarLenType::Xml => (),
            typ => todo!("encoding {:?} is not supported yet", typ),
        }

        if let Some(collation) = self.collation() {
            dst.put_u32_le(collation.info());
            dst.put_u8(collation.sort_id());
        }

        Ok(())
    }
}

uint_enum! {
    #[repr(u8)]
    pub enum FixedLenType {
        Null = 0x1F,
        Int1 = 0x30,
        Bit = 0x32,
        Int2 = 0x34,
        Int4 = 0x38,
        Datetime4 = 0x3A,
        Float4 = 0x3B,
        Money = 0x3C,
        Datetime = 0x3D,
        Float8 = 0x3E,
        Money4 = 0x7A,
        Int8 = 0x7F,
    }
}

#[cfg(not(feature = "tds73"))]
uint_enum! {
    /// 2.2.5.4.2
    #[repr(u8)]
    pub enum VarLenType {
        Guid = 0x24,
        Intn = 0x26,
        Bitn = 0x68,
        Decimaln = 0x6A,
        Numericn = 0x6C,
        Floatn = 0x6D,
        Money = 0x6E,
        Datetimen = 0x6F,
        BigVarBin = 0xA5,
        BigVarChar = 0xA7,
        BigBinary = 0xAD,
        BigChar = 0xAF,
        NVarchar = 0xE7,
        NChar = 0xEF,
        Xml = 0xF1,
        // not supported yet
        Udt = 0xF0,
        Text = 0x23,
        Image = 0x22,
        NText = 0x63,
        // not supported yet
        SSVariant = 0x62, // legacy types (not supported since post-7.2):
                          // Char = 0x2F,
                          // Binary = 0x2D,
                          // VarBinary = 0x25,
                          // VarChar = 0x27,
                          // Numeric = 0x3F,
                          // Decimal = 0x37
    }
}

#[cfg(feature = "tds73")]
uint_enum! {
    /// 2.2.5.4.2
    #[repr(u8)]
    pub enum VarLenType {
        Guid = 0x24,
        Intn = 0x26,
        Bitn = 0x68,
        Decimaln = 0x6A,
        Numericn = 0x6C,
        Floatn = 0x6D,
        Money = 0x6E,
        Datetimen = 0x6F,
        Daten = 0x28,
        Timen = 0x29,
        Datetime2 = 0x2A,
        DatetimeOffsetn = 0x2B,
        BigVarBin = 0xA5,
        BigVarChar = 0xA7,
        BigBinary = 0xAD,
        BigChar = 0xAF,
        NVarchar = 0xE7,
        NChar = 0xEF,
        Xml = 0xF1,
        // not supported yet
        Udt = 0xF0,
        Text = 0x23,
        Image = 0x22,
        NText = 0x63,
        // not supported yet
        SSVariant = 0x62, // legacy types (not supported since post-7.2):
                          // Char = 0x2F,
                          // Binary = 0x2D,
                          // VarBinary = 0x25,
                          // VarChar = 0x27,
                          // Numeric = 0x3F,
                          // Decimal = 0x37
    }
}

impl Encode<BytesMut> for TypeInfo {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        match self {
            TypeInfo::FixedLen(ty) => {
                dst.put_u8(ty as u8);
            }
            TypeInfo::VarLenSized(ctx) => ctx.encode(dst)?,
            TypeInfo::VarLenSizedPrecision {
                ty,
                size,
                precision,
                scale,
            } => {
                dst.put_u8(ty as u8);
                dst.put_u8(size as u8);
                dst.put_u8(precision);
                dst.put_u8(scale);
            }
            TypeInfo::Xml { schema, .. } => {
                dst.put_u8(VarLenType::Xml as u8);

                if let Some(xs) = schema {
                    dst.put_u8(1);

                    let db_name_encoded: Vec<u16> = xs.db_name().encode_utf16().collect();
                    dst.put_u8(db_name_encoded.len() as u8);
                    for chr in db_name_encoded {
                        dst.put_u16_le(chr);
                    }

                    let owner_encoded: Vec<u16> = xs.owner().encode_utf16().collect();
                    dst.put_u8(owner_encoded.len() as u8);
                    for chr in owner_encoded {
                        dst.put_u16_le(chr);
                    }

                    let collection_encoded: Vec<u16> = xs.collection().encode_utf16().collect();
                    dst.put_u16_le(collection_encoded.len() as u16);
                    for chr in collection_encoded {
                        dst.put_u16_le(chr);
                    }
                } else {
                    dst.put_u8(0);
                }
            }
        }

        Ok(())
    }
}

impl TypeInfo {
    pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let ty = src.read_u8().await?;

        if let Ok(ty) = FixedLenType::try_from(ty) {
            return Ok(TypeInfo::FixedLen(ty));
        }

        match VarLenType::try_from(ty) {
            Err(()) => Err(Error::Protocol(
                format!("invalid or unsupported column type: {:?}", ty).into(),
            )),
            Ok(VarLenType::Xml) => {
                let has_schema = src.read_u8().await?;

                let schema = if has_schema == 1 {
                    let db_name = src.read_b_varchar().await?;
                    let owner = src.read_b_varchar().await?;
                    let collection = src.read_us_varchar().await?;

                    Some(Arc::new(XmlSchema::new(db_name, owner, collection)))
                } else {
                    None
                };

                Ok(TypeInfo::Xml {
                    schema,
                    size: 0xfffffffffffffffe_usize,
                })
            }
            Ok(ty) => {
                let len = match ty {
                    #[cfg(feature = "tds73")]
                    VarLenType::Timen | VarLenType::DatetimeOffsetn | VarLenType::Datetime2 => {
                        src.read_u8().await? as usize
                    }
                    #[cfg(feature = "tds73")]
                    VarLenType::Daten => 3,
                    VarLenType::Bitn
                    | VarLenType::Intn
                    | VarLenType::Floatn
                    | VarLenType::Decimaln
                    | VarLenType::Numericn
                    | VarLenType::Guid
                    | VarLenType::Money
                    | VarLenType::Datetimen => src.read_u8().await? as usize,
                    VarLenType::NChar
                    | VarLenType::BigChar
                    | VarLenType::NVarchar
                    | VarLenType::BigVarChar
                    | VarLenType::BigBinary
                    | VarLenType::BigVarBin => src.read_u16_le().await? as usize,
                    VarLenType::Image | VarLenType::Text | VarLenType::NText => {
                        src.read_u32_le().await? as usize
                    }
                    _ => todo!("not yet implemented for {:?}", ty),
                };

                let collation = match ty {
                    VarLenType::NText
                    | VarLenType::Text
                    | VarLenType::BigChar
                    | VarLenType::NChar
                    | VarLenType::NVarchar
                    | VarLenType::BigVarChar => {
                        let info = src.read_u32_le().await?;
                        let sort_id = src.read_u8().await?;

                        Some(Collation::new(info, sort_id))
                    }
                    _ => None,
                };

                let vty = match ty {
                    VarLenType::Decimaln | VarLenType::Numericn => {
                        let precision = src.read_u8().await?;
                        let scale = src.read_u8().await?;

                        TypeInfo::VarLenSizedPrecision {
                            size: len,
                            ty,
                            precision,
                            scale,
                        }
                    }
                    _ => {
                        let cx = VarLenContext::new(ty, len, collation);
                        TypeInfo::VarLenSized(cx)
                    }
                };

                Ok(vty)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_read_bytes::test_utils::IntoSqlReadBytes;

    #[tokio::test]
    async fn round_trip() {
        let types = vec![
            TypeInfo::Xml {
                schema: Some(
                    XmlSchema::new("fake-db-name", "fake-owner", "fake-collection").into(),
                ),
                size: 0xfffffffffffffffe_usize,
            },
            TypeInfo::Xml {
                schema: None,
                size: 0xfffffffffffffffe_usize,
            },
            TypeInfo::FixedLen(FixedLenType::Int4),
            TypeInfo::VarLenSized(VarLenContext::new(
                VarLenType::NChar,
                40,
                Some(Collation::new(13632521, 52)),
            )),
        ];

        for ti in types {
            let mut buf = BytesMut::new();

            ti.clone()
                .encode(&mut buf)
                .expect("encode should be successful");

            let nti = TypeInfo::decode(&mut buf.into_sql_read_bytes())
                .await
                .expect("decode must succeed");

            assert_eq!(nti, ti)
        }
    }
}
