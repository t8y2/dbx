use crate::Error;

use crate::{sql_read_bytes::SqlReadBytes, time::Date, ColumnData};

pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let len = src.read_u8().await?;

    let res = match len {
        0 => ColumnData::Date(None),
        3 => ColumnData::Date(Some(Date::decode(src).await?)),
        _ => {
            return Err(Error::Protocol(
                format!("daten: length of {} is invalid", len).into(),
            ))
        }
    };

    Ok(res)
}
