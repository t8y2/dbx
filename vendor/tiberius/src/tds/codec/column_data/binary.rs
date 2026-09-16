use std::borrow::Cow;

use crate::{sql_read_bytes::SqlReadBytes, ColumnData};

pub(crate) async fn decode<R>(src: &mut R, len: usize) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let data = super::plp::decode(src, len).await?.map(Cow::from);

    Ok(ColumnData::Binary(data))
}
