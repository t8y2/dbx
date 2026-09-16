use crate::{
    error::Error,
    sql_read_bytes::SqlReadBytes,
    time::{DateTime, SmallDateTime},
    ColumnData,
};

pub(crate) async fn decode<R>(src: &mut R, rlen: u8, len: u8) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let datetime = match (rlen, len) {
        (0, 4) => ColumnData::SmallDateTime(None),
        (0, 8) => ColumnData::DateTime(None),
        (4, _) => ColumnData::SmallDateTime(Some(SmallDateTime::decode(src).await?)),
        (8, _) => ColumnData::DateTime(Some(DateTime::decode(src).await?)),
        _ => {
            return Err(Error::Protocol(
                format!("datetimen: length of {} is invalid", len).into(),
            ))
        }
    };

    Ok(datetime)
}
