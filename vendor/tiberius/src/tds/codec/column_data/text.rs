use crate::{error::Error, sql_read_bytes::SqlReadBytes, tds::Collation, ColumnData};

pub(crate) async fn decode<R>(
    src: &mut R,
    collation: Option<Collation>,
) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let ptr_len = src.read_u8().await? as usize;

    if ptr_len == 0 {
        return Ok(ColumnData::String(None));
    }

    for _ in 0..ptr_len {
        src.read_u8().await?;
    }

    src.read_i32_le().await?; // days
    src.read_u32_le().await?; // second fractions

    let text = match collation {
        // TEXT
        Some(collation) => {
            let encoder = collation.encoding()?;
            let text_len = src.read_u32_le().await? as usize;
            let mut buf = Vec::with_capacity(text_len);

            for _ in 0..text_len {
                buf.push(src.read_u8().await?);
            }

            encoder
                .decode_without_bom_handling_and_without_replacement(buf.as_ref())
                .ok_or_else(|| Error::Encoding("invalid sequence".into()))?
                .to_string()
        }
        // NTEXT
        None => {
            let text_len = src.read_u32_le().await? as usize;
            if text_len % 2 != 0 {
                return Err(Error::Protocol("ntext: invalid length".into()));
            }

            let text_len = text_len / 2;
            let mut buf = Vec::with_capacity(text_len);

            for _ in 0..text_len {
                buf.push(src.read_u16_le().await?);
            }

            String::from_utf16_lossy(&buf[..])
        }
    };

    Ok(ColumnData::String(Some(text.into())))
}
