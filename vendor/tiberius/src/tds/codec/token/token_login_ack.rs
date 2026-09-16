use crate::{Error, FeatureLevel, SqlReadBytes};
use std::convert::TryFrom;

#[allow(dead_code)] // we might want to debug the values
#[derive(Debug)]
pub struct TokenLoginAck {
    /// The type of interface with which the server will accept client requests
    /// 0: SQL_DFLT (server confirms that whatever is sent by the client is acceptable. If the client
    ///    requested SQL_DFLT, SQL_TSQL will be used)
    /// 1: SQL_TSQL (TSQL is accepted)
    pub(crate) interface: u8,
    pub(crate) tds_version: FeatureLevel,
    pub(crate) prog_name: String,
    /// major.minor.buildhigh.buildlow
    pub(crate) version: u32,
}

impl TokenLoginAck {
    pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let _length = src.read_u16_le().await?;

        let interface = src.read_u8().await?;

        let tds_version = FeatureLevel::try_from(src.read_u32().await?)
            .map_err(|_| Error::Protocol("Login ACK: Invalid TDS version".into()))?;

        let prog_name = src.read_b_varchar().await?;
        let version = src.read_u32_le().await?;

        Ok(TokenLoginAck {
            interface,
            tds_version,
            prog_name,
            version,
        })
    }
}
