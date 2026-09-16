use crate::SqlReadBytes;

#[allow(dead_code)] // we might want to debug the values
#[derive(Debug)]
pub struct TokenOrder {
    pub(crate) column_indexes: Vec<u16>,
}

impl TokenOrder {
    pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let len = src.read_u16_le().await? / 2;

        let mut column_indexes = Vec::with_capacity(len as usize);

        for _ in 0..len {
            column_indexes.push(src.read_u16_le().await?);
        }

        Ok(TokenOrder { column_indexes })
    }
}
