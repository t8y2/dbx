use crate::{error::Error, sql_read_bytes::SqlReadBytes, ColumnData};

pub(crate) async fn decode<R>(src: &mut R, len: u8) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let res = match len {
        0 => ColumnData::F64(None),
        4 => ColumnData::F64(Some(src.read_i32_le().await? as f64 / 1e4)),
        8 => ColumnData::F64(Some({
            let high = src.read_i32_le().await? as i64;
            let low = src.read_u32_le().await? as f64;

            ((high << 32) as f64 + low) / 1e4
        })),
        _ => {
            return Err(Error::Protocol(
                format!("money: length of {} is invalid", len).into(),
            ))
        }
    };

    Ok(res)
}
