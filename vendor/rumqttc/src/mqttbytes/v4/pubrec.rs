use super::*;
use bytes::{Buf, BufMut, Bytes, BytesMut};

/// Acknowledgement to QoS2 publish
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PubRec {
    pub pkid: u16,
}

impl PubRec {
    pub fn new(pkid: u16) -> PubRec {
        PubRec { pkid }
    }

    fn len(&self) -> usize {
        // pkid
        2
    }

    pub fn size(&self) -> usize {
        let len = self.len();
        let remaining_len_size = len_len(len);

        1 + remaining_len_size + len
    }

    pub fn read(fixed_header: FixedHeader, mut bytes: Bytes) -> Result<Self, Error> {
        let variable_header_index = fixed_header.fixed_header_len;
        bytes.advance(variable_header_index);
        let pkid = read_u16(&mut bytes)?;
        if fixed_header.remaining_len == 2 {
            return Ok(PubRec { pkid });
        }

        if fixed_header.remaining_len < 4 {
            return Ok(PubRec { pkid });
        }

        let puback = PubRec { pkid };

        Ok(puback)
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<usize, Error> {
        let len = self.len();
        buffer.put_u8(0x50);
        let count = write_remaining_length(buffer, len)?;
        buffer.put_u16(self.pkid);
        Ok(1 + count + len)
    }
}
