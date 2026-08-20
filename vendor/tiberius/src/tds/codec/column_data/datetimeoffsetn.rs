use crate::{sql_read_bytes::SqlReadBytes, time::DateTimeOffset, ColumnData};

pub(crate) async fn decode<R>(src: &mut R, len: usize) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let rlen = src.read_u8().await?;

    let dto = match rlen {
        0 => ColumnData::DateTimeOffset(None),
        _ => {
            let dto = DateTimeOffset::decode(src, len, rlen - 5).await?;
            ColumnData::DateTimeOffset(Some(dto))
        }
    };

    Ok(dto)
}
