use super::*;
use bytes::{Buf, BufMut, Bytes, BytesMut};

/// Acknowledgement to QoS1 publish
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PubAck {
    pub pkid: u16,
}

impl PubAck {
    pub fn new(pkid: u16) -> PubAck {
        PubAck { pkid }
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

        // No reason code or properties if remaining length == 2
        if fixed_header.remaining_len == 2 {
            return Ok(PubAck { pkid });
        }

        // No properties len or properties if remaining len > 2 but < 4
        if fixed_header.remaining_len < 4 {
            return Ok(PubAck { pkid });
        }

        let puback = PubAck { pkid };

        Ok(puback)
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<usize, Error> {
        let len = self.len();
        buffer.put_u8(0x40);
        let count = write_remaining_length(buffer, len)?;
        buffer.put_u16(self.pkid);
        Ok(1 + count + len)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use bytes::BytesMut;
    use pretty_assertions::assert_eq;

    #[test]
    fn puback_encoding_works() {
        let stream = &[
            0b0100_0000,
            0x02, // packet type, flags and remaining len
            0x00,
            0x0A, // fixed header. packet identifier = 10
            0xDE,
            0xAD,
            0xBE,
            0xEF, // extra packets in the stream
        ];
        let mut stream = BytesMut::from(&stream[..]);
        let fixed_header = parse_fixed_header(stream.iter()).unwrap();
        let ack_bytes = stream.split_to(fixed_header.frame_length()).freeze();
        let packet = PubAck::read(fixed_header, ack_bytes).unwrap();

        assert_eq!(packet, PubAck { pkid: 10 });
    }
}
