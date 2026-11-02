use crate::SqlReadBytes;

#[allow(dead_code)] // we might want to debug the values
#[derive(Debug)]
pub struct TokenInfo {
    /// info number
    pub(crate) number: u32,
    /// error state
    pub(crate) state: u8,
    /// severity (<10: Info)
    pub(crate) class: u8,
    pub(crate) message: String,
    pub(crate) server: String,
    pub(crate) procedure: String,
    pub(crate) line: u32,
}

impl TokenInfo {
    pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let length = src.read_u16_le().await? as usize;

        let number = src.read_u32_le().await?;
        let state = src.read_u8().await?;
        let class = src.read_u8().await?;
        let message = src.read_us_varchar().await?;
        let server = src.read_b_varchar().await?;
        let procedure = src.read_b_varchar().await?;
        // INFO can precede LOGINACK, so the negotiated dialect is not yet
        // available. Its declared length disambiguates 7.1 and 7.2+ safely.
        let width = super::message_line_number_bytes(length, &message, &server, &procedure)?;
        let line = if width == 2 { src.read_u16_le().await? as u32 } else { src.read_u32_le().await? };

        Ok(TokenInfo {
            number,
            state,
            class,
            message,
            server,
            procedure,
            line,
        })
    }
}
