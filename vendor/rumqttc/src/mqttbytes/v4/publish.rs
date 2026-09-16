use super::*;
use bytes::{Buf, Bytes};

/// Publish packet
#[derive(Clone, PartialEq, Eq)]
pub struct Publish {
    pub dup: bool,
    pub qos: QoS,
    pub retain: bool,
    pub topic: String,
    pub pkid: u16,
    pub payload: Bytes,
}

impl Publish {
    pub fn new<S: Into<String>, P: Into<Vec<u8>>>(topic: S, qos: QoS, payload: P) -> Publish {
        Publish {
            dup: false,
            qos,
            retain: false,
            pkid: 0,
            topic: topic.into(),
            payload: Bytes::from(payload.into()),
        }
    }

    pub fn from_bytes<S: Into<String>>(topic: S, qos: QoS, payload: Bytes) -> Publish {
        Publish {
            dup: false,
            qos,
            retain: false,
            pkid: 0,
            topic: topic.into(),
            payload,
        }
    }

    fn len(&self) -> usize {
        let len = 2 + self.topic.len() + self.payload.len();
        if self.qos != QoS::AtMostOnce && self.pkid != 0 {
            len + 2
        } else {
            len
        }
    }

    pub fn size(&self) -> usize {
        let len = self.len();
        let remaining_len_size = len_len(len);

        1 + remaining_len_size + len
    }

    pub fn read(fixed_header: FixedHeader, mut bytes: Bytes) -> Result<Self, Error> {
        let qos = qos((fixed_header.byte1 & 0b0110) >> 1)?;
        let dup = (fixed_header.byte1 & 0b1000) != 0;
        let retain = (fixed_header.byte1 & 0b0001) != 0;

        let variable_header_index = fixed_header.fixed_header_len;
        bytes.advance(variable_header_index);
        let topic = read_mqtt_string(&mut bytes)?;

        // Packet identifier exists where QoS > 0
        let pkid = match qos {
            QoS::AtMostOnce => 0,
            QoS::AtLeastOnce | QoS::ExactlyOnce => read_u16(&mut bytes)?,
        };

        if qos != QoS::AtMostOnce && pkid == 0 {
            return Err(Error::PacketIdZero);
        }

        let publish = Publish {
            dup,
            retain,
            qos,
            pkid,
            topic,
            payload: bytes,
        };

        Ok(publish)
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<usize, Error> {
        let len = self.len();

        let dup = self.dup as u8;
        let qos = self.qos as u8;
        let retain = self.retain as u8;
        buffer.put_u8(0b0011_0000 | retain | qos << 1 | dup << 3);

        let count = write_remaining_length(buffer, len)?;
        write_mqtt_string(buffer, self.topic.as_str());

        if self.qos != QoS::AtMostOnce {
            let pkid = self.pkid;
            if pkid == 0 {
                return Err(Error::PacketIdZero);
            }

            buffer.put_u16(pkid);
        }

        buffer.extend_from_slice(&self.payload);

        // TODO: Returned length is wrong in other packets. Fix it
        Ok(1 + count + len)
    }
}

impl fmt::Debug for Publish {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Topic = {}, Qos = {:?}, Retain = {}, Pkid = {:?}, Payload Size = {}",
            self.topic,
            self.qos,
            self.retain,
            self.pkid,
            self.payload.len()
        )
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use bytes::{Bytes, BytesMut};
    use pretty_assertions::assert_eq;

    #[test]
    fn qos1_publish_parsing_works() {
        let stream = &[
            0b0011_0010,
            11, // packet type, flags and remaining len
            0x00,
            0x03,
            b'a',
            b'/',
            b'b', // variable header. topic name = 'a/b'
            0x00,
            0x0a, // variable header. pkid = 10
            0xF1,
            0xF2,
            0xF3,
            0xF4, // publish payload
            0xDE,
            0xAD,
            0xBE,
            0xEF, // extra packets in the stream
        ];

        let mut stream = BytesMut::from(&stream[..]);
        let fixed_header = parse_fixed_header(stream.iter()).unwrap();
        let publish_bytes = stream.split_to(fixed_header.frame_length()).freeze();
        let packet = Publish::read(fixed_header, publish_bytes).unwrap();

        let payload = &[0xF1, 0xF2, 0xF3, 0xF4];
        assert_eq!(
            packet,
            Publish {
                dup: false,
                qos: QoS::AtLeastOnce,
                retain: false,
                topic: "a/b".to_owned(),
                pkid: 10,
                payload: Bytes::from(&payload[..]),
            }
        );
    }

    #[test]
    fn qos0_publish_parsing_works() {
        let stream = &[
            0b0011_0000,
            7, // packet type, flags and remaining len
            0x00,
            0x03,
            b'a',
            b'/',
            b'b', // variable header. topic name = 'a/b'
            0x01,
            0x02, // payload
            0xDE,
            0xAD,
            0xBE,
            0xEF, // extra packets in the stream
        ];

        let mut stream = BytesMut::from(&stream[..]);
        let fixed_header = parse_fixed_header(stream.iter()).unwrap();
        let publish_bytes = stream.split_to(fixed_header.frame_length()).freeze();
        let packet = Publish::read(fixed_header, publish_bytes).unwrap();

        assert_eq!(
            packet,
            Publish {
                dup: false,
                qos: QoS::AtMostOnce,
                retain: false,
                topic: "a/b".to_owned(),
                pkid: 0,
                payload: Bytes::from(&[0x01, 0x02][..]),
            }
        );
    }

    #[test]
    fn qos1_publish_encoding_works() {
        let publish = Publish {
            dup: false,
            qos: QoS::AtLeastOnce,
            retain: false,
            topic: "a/b".to_owned(),
            pkid: 10,
            payload: Bytes::from(vec![0xF1, 0xF2, 0xF3, 0xF4]),
        };

        let mut buf = BytesMut::new();
        publish.write(&mut buf).unwrap();

        assert_eq!(
            buf,
            vec![
                0b0011_0010,
                11,
                0x00,
                0x03,
                b'a',
                b'/',
                b'b',
                0x00,
                0x0a,
                0xF1,
                0xF2,
                0xF3,
                0xF4
            ]
        );
    }

    #[test]
    fn qos0_publish_encoding_works() {
        let publish = Publish {
            dup: false,
            qos: QoS::AtMostOnce,
            retain: false,
            topic: "a/b".to_owned(),
            pkid: 0,
            payload: Bytes::from(vec![0xE1, 0xE2, 0xE3, 0xE4]),
        };

        let mut buf = BytesMut::new();
        publish.write(&mut buf).unwrap();

        assert_eq!(
            buf,
            vec![
                0b0011_0000,
                9,
                0x00,
                0x03,
                b'a',
                b'/',
                b'b',
                0xE1,
                0xE2,
                0xE3,
                0xE4
            ]
        );
    }
}
