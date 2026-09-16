use crate::{sql_read_bytes::SqlReadBytes, ColumnData, FixedLenType};

pub(crate) async fn decode<R>(
    src: &mut R,
    r#type: &FixedLenType,
) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let data = match r#type {
        FixedLenType::Null => ColumnData::Bit(None),
        FixedLenType::Bit => ColumnData::Bit(Some(src.read_u8().await? != 0)),
        FixedLenType::Int1 => ColumnData::U8(Some(src.read_u8().await?)),
        FixedLenType::Int2 => ColumnData::I16(Some(src.read_i16_le().await?)),
        FixedLenType::Int4 => ColumnData::I32(Some(src.read_i32_le().await?)),
        FixedLenType::Int8 => ColumnData::I64(Some(src.read_i64_le().await?)),
        FixedLenType::Float4 => ColumnData::F32(Some(src.read_f32_le().await?)),
        FixedLenType::Float8 => ColumnData::F64(Some(src.read_f64_le().await?)),
        FixedLenType::Datetime => super::datetimen::decode(src, 8, 8).await?,
        FixedLenType::Datetime4 => super::datetimen::decode(src, 4, 8).await?,
        FixedLenType::Money4 => super::money::decode(src, 4).await?,
        FixedLenType::Money => super::money::decode(src, 8).await?,
    };

    Ok(data)
}
