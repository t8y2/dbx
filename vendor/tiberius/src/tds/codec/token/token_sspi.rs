use crate::{sql_read_bytes::SqlReadBytes, tds::codec::Encode};
use bytes::BytesMut;
use futures_util::io::AsyncReadExt;

#[derive(Debug)]
pub struct TokenSspi(Vec<u8>);

impl AsRef<[u8]> for TokenSspi {
    fn as_ref(&self) -> &[u8] {
        self.0.as_ref()
    }
}

impl TokenSspi {
    #[cfg(any(windows, all(unix, feature = "integrated-auth-gssapi")))]
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub(crate) async fn decode_async<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let len = src.read_u16_le().await? as usize;
        let mut bytes = vec![0; len];
        src.read_exact(&mut bytes[0..len]).await?;

        Ok(Self(bytes))
    }
}

impl Encode<BytesMut> for TokenSspi {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        dst.extend(self.0);
        Ok(())
    }
}
