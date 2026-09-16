use crate::{sql_read_bytes::SqlReadBytes, time::DateTime2, ColumnData};

pub(crate) async fn decode<R>(src: &mut R, len: usize) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let rlen = src.read_u8().await?;

    let date = match rlen {
        0 => ColumnData::DateTime2(None),
        rlen => {
            let dt = DateTime2::decode(src, len, rlen as usize - 3).await?;
            ColumnData::DateTime2(Some(dt))
        }
    };

    Ok(date)
}
