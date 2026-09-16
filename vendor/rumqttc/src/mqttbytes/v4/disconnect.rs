use super::*;
use bytes::{BufMut, BytesMut};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Disconnect;

impl Disconnect {
    pub fn size(&self) -> usize {
        2
    }

    pub fn write(&self, payload: &mut BytesMut) -> Result<usize, Error> {
        payload.put_slice(&[0xE0, 0x00]);
        Ok(2)
    }
}
