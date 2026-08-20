use crate::{error::Error, sql_read_bytes::SqlReadBytes, ColumnData};

pub(crate) async fn decode<R>(src: &mut R, type_len: usize) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let len = src.read_u8().await? as usize;

    let res = match (len, type_len) {
        (0, 4) => ColumnData::F32(None),
        (0, _) => ColumnData::F64(None),
        (4, _) => ColumnData::F32(Some(src.read_f32_le().await?)),
        (8, _) => ColumnData::F64(Some(src.read_f64_le().await?)),
        _ => {
            return Err(Error::Protocol(
                format!("floatn: length of {} is invalid", len).into(),
            ))
        }
    };

    Ok(res)
}
