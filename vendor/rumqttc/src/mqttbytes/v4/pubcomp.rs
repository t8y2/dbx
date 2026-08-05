use super::*;
use bytes::{Buf, BufMut, Bytes, BytesMut};

/// QoS2 Assured publish complete, in response to PUBREL packet
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PubComp {
    pub pkid: u16,
}

impl PubComp {
    pub fn new(pkid: u16) -> PubComp {
        PubComp { pkid }
    }

    pub fn size(&self) -> usize {
        let len = self.len();
        let remaining_len_size = len_len(len);
        1 + remaining_len_size + len
    }

    fn len(&self) -> usize {
        // pkid
        2
    }

    pub fn read(fixed_header: FixedHeader, mut bytes: Bytes) -> Result<Self, Error> {
        let variable_header_index = fixed_header.fixed_header_len;
        bytes.advance(variable_header_index);
        let pkid = read_u16(&mut bytes)?;

        if fixed_header.remaining_len == 2 {
            return Ok(PubComp { pkid });
        }

        if fixed_header.remaining_len < 4 {
            return Ok(PubComp { pkid });
        }

        let puback = PubComp { pkid };

        Ok(puback)
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<usize, Error> {
        let len = self.len();
        buffer.put_u8(0x70);
        let count = write_remaining_length(buffer, len)?;
        buffer.put_u16(self.pkid);
        Ok(1 + count + len)
    }
}
