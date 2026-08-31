use crate::{sql_read_bytes::SqlReadBytes, ColumnData};

pub(crate) async fn decode<R>(src: &mut R, type_len: usize) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let recv_len = src.read_u8().await? as usize;

    let res = match (recv_len, type_len) {
        (0, 1) => ColumnData::U8(None),
        (0, 2) => ColumnData::I16(None),
        (0, 4) => ColumnData::I32(None),
        (0, _) => ColumnData::I64(None),
        (1, _) => ColumnData::U8(Some(src.read_u8().await?)),
        (2, _) => ColumnData::I16(Some(src.read_i16_le().await?)),
        (4, _) => ColumnData::I32(Some(src.read_i32_le().await?)),
        (8, _) => ColumnData::I64(Some(src.read_i64_le().await?)),
        _ => unimplemented!(),
    };

    Ok(res)
}
