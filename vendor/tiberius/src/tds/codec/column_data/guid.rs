use uuid::Uuid;

use crate::{error::Error, sql_read_bytes::SqlReadBytes, tds::codec::guid, ColumnData};

pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let len = src.read_u8().await? as usize;

    let res = match len {
        0 => ColumnData::Guid(None),
        16 => {
            let mut data = [0u8; 16];

            for item in &mut data {
                *item = src.read_u8().await?;
            }

            guid::reorder_bytes(&mut data);
            ColumnData::Guid(Some(Uuid::from_bytes(data)))
        }
        _ => {
            return Err(Error::Protocol(
                format!("guid: length of {} is invalid", len).into(),
            ))
        }
    };

    Ok(res)
}
