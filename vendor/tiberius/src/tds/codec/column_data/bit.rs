use crate::{error::Error, sql_read_bytes::SqlReadBytes, ColumnData};

pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let recv_len = src.read_u8().await? as usize;

    let res = match recv_len {
        0 => ColumnData::Bit(None),
        1 => ColumnData::Bit(Some(src.read_u8().await? > 0)),
        v => {
            return Err(Error::Protocol(
                format!("bitn: length of {} is invalid", v).into(),
            ))
        }
    };

    Ok(res)
}
