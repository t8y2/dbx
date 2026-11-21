use super::{AllHeaderTy, Encode, ALL_HEADERS_LEN_TX};
use bytes::{BufMut, BytesMut};
use std::borrow::Cow;

pub struct BatchRequest<'a> {
    queries: Cow<'a, str>,
    transaction_descriptor: [u8; 8],
    tds_version: crate::FeatureLevel,
}

impl<'a> BatchRequest<'a> {
    pub fn new(queries: impl Into<Cow<'a, str>>, transaction_descriptor: [u8; 8]) -> Self {
        Self {
            queries: queries.into(),
            transaction_descriptor,
            tds_version: crate::FeatureLevel::default(),
        }
    }

    pub fn with_tds_version(mut self, version: crate::FeatureLevel) -> Self {
        self.tds_version = version;
        self
    }
}

impl<'a> Encode<BytesMut> for BatchRequest<'a> {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        if self.tds_version >= crate::FeatureLevel::SqlServer2005 {
            dst.put_u32_le(ALL_HEADERS_LEN_TX as u32);
            dst.put_u32_le(ALL_HEADERS_LEN_TX as u32 - 4);
            dst.put_u16_le(AllHeaderTy::TransactionDescriptor as u16);
            dst.put_slice(&self.transaction_descriptor);
            dst.put_u32_le(1);
        }

        for c in self.queries.encode_utf16() {
            dst.put_u16_le(c);
        }

        Ok(())
    }
}
