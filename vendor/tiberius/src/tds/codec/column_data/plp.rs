use crate::sql_read_bytes::SqlReadBytes;

// Decode a partially length-prefixed type.
pub(crate) async fn decode<R>(src: &mut R, len: usize) -> crate::Result<Option<Vec<u8>>>
where
    R: SqlReadBytes + Unpin,
{
    match len {
        // Fixed size
        len if len < 0xffff => {
            let len = src.read_u16_le().await? as u64;

            match len {
                // NULL
                0xffff => Ok(None),
                _ => {
                    let mut data = Vec::with_capacity(len as usize);

                    for _ in 0..len {
                        data.push(src.read_u8().await?);
                    }

                    Ok(Some(data))
                }
            }
        }
        // Unknown size, length-prefixed blobs
        _ => {
            let len = src.read_u64_le().await?;

            let mut data = match len {
                // NULL
                0xffffffffffffffff => return Ok(None),
                // Unknown size
                0xfffffffffffffffe => Vec::new(),
                // Known size
                _ => Vec::with_capacity(len as usize),
            };

            let mut chunk_data_left = 0;

            loop {
                if chunk_data_left == 0 {
                    // We have no chunk. Start a new one.
                    let chunk_size = src.read_u32_le().await? as usize;

                    if chunk_size == 0 {
                        break; // found a sentinel, we're done
                    } else {
                        chunk_data_left = chunk_size
                    }
                } else {
                    // Just read a byte
                    let byte = src.read_u8().await?;
                    chunk_data_left -= 1;

                    data.push(byte);
                }
            }

            Ok(Some(data))
        }
    }
}
