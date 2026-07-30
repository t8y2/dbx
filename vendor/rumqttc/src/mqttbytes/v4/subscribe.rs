use super::*;
use bytes::{Buf, Bytes};

/// Subscription packet
#[derive(Clone, PartialEq, Eq)]
pub struct Subscribe {
    pub pkid: u16,
    pub filters: Vec<SubscribeFilter>,
}

impl Subscribe {
    pub fn new<S: Into<String>>(path: S, qos: QoS) -> Subscribe {
        let filter = SubscribeFilter {
            path: path.into(),
            qos,
        };

        Subscribe {
            pkid: 0,
            filters: vec![filter],
        }
    }

    pub fn new_many<T>(topics: T) -> Subscribe
    where
        T: IntoIterator<Item = SubscribeFilter>,
    {
        let filters: Vec<SubscribeFilter> = topics.into_iter().collect();

        Subscribe { pkid: 0, filters }
    }

    pub fn add(&mut self, path: String, qos: QoS) -> &mut Self {
        let filter = SubscribeFilter { path, qos };

        self.filters.push(filter);
        self
    }

    fn len(&self) -> usize {
        // len of pkid + vec![subscribe filter len]
        2 + self.filters.iter().fold(0, |s, t| s + t.len())
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

        // variable header size = 2 (packet identifier)
        let mut filters = Vec::new();

        while bytes.has_remaining() {
            let path = read_mqtt_string(&mut bytes)?;
            let options = read_u8(&mut bytes)?;
            let requested_qos = options & 0b0000_0011;

            filters.push(SubscribeFilter {
                path,
                qos: qos(requested_qos)?,
            });
        }

        match filters.len() {
            0 => Err(Error::EmptySubscription),
            _ => Ok(Subscribe { pkid, filters }),
        }
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<usize, Error> {
        // write packet type
        buffer.put_u8(0x82);

        // write remaining length
        let remaining_len = self.len();
        let remaining_len_bytes = write_remaining_length(buffer, remaining_len)?;

        // write packet id
        buffer.put_u16(self.pkid);

        // write filters
        for filter in self.filters.iter() {
            filter.write(buffer);
        }

        Ok(1 + remaining_len_bytes + remaining_len)
    }
}

///  Subscription filter
#[derive(Clone, PartialEq, Eq)]
pub struct SubscribeFilter {
    pub path: String,
    pub qos: QoS,
}

impl SubscribeFilter {
    pub fn new(path: String, qos: QoS) -> SubscribeFilter {
        SubscribeFilter { path, qos }
    }

    fn len(&self) -> usize {
        // filter len + filter + options
        2 + self.path.len() + 1
    }

    fn write(&self, buffer: &mut BytesMut) {
        let mut options = 0;
        options |= self.qos as u8;

        write_mqtt_string(buffer, self.path.as_str());
        buffer.put_u8(options);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetainForwardRule {
    OnEverySubscribe,
    OnNewSubscribe,
    Never,
}

impl fmt::Debug for Subscribe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Filters = {:?}, Packet id = {:?}",
            self.filters, self.pkid
        )
    }
}

impl fmt::Debug for SubscribeFilter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Filter = {}, Qos = {:?}", self.path, self.qos)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use bytes::BytesMut;
    use pretty_assertions::assert_eq;

    #[test]
    fn subscribe_parsing_works() {
        let stream = &[
            0b1000_0010,
            20, // packet type, flags and remaining len
            0x01,
            0x04, // variable header. pkid = 260
            0x00,
            0x03,
            b'a',
            b'/',
            b'+', // payload. topic filter = 'a/+'
            0x00, // payload. qos = 0
            0x00,
            0x01,
            b'#', // payload. topic filter = '#'
            0x01, // payload. qos = 1
            0x00,
            0x05,
            b'a',
            b'/',
            b'b',
            b'/',
            b'c', // payload. topic filter = 'a/b/c'
            0x02, // payload. qos = 2
            0xDE,
            0xAD,
            0xBE,
            0xEF, // extra packets in the stream
        ];
        let mut stream = BytesMut::from(&stream[..]);
        let fixed_header = parse_fixed_header(stream.iter()).unwrap();
        let subscribe_bytes = stream.split_to(fixed_header.frame_length()).freeze();
        let packet = Subscribe::read(fixed_header, subscribe_bytes).unwrap();

        assert_eq!(
            packet,
            Subscribe {
                pkid: 260,
                filters: vec![
                    SubscribeFilter::new("a/+".to_owned(), QoS::AtMostOnce),
                    SubscribeFilter::new("#".to_owned(), QoS::AtLeastOnce),
                    SubscribeFilter::new("a/b/c".to_owned(), QoS::ExactlyOnce)
                ],
            }
        );
    }

    #[test]
    fn subscribe_encoding_works() {
        let subscribe = Subscribe {
            pkid: 260,
            filters: vec![
                SubscribeFilter::new("a/+".to_owned(), QoS::AtMostOnce),
                SubscribeFilter::new("#".to_owned(), QoS::AtLeastOnce),
                SubscribeFilter::new("a/b/c".to_owned(), QoS::ExactlyOnce),
            ],
        };

        let mut buf = BytesMut::new();
        subscribe.write(&mut buf).unwrap();
        assert_eq!(
            buf,
            vec![
                0b1000_0010,
                20,
                0x01,
                0x04, // pkid = 260
                0x00,
                0x03,
                b'a',
                b'/',
                b'+', // topic filter = 'a/+'
                0x00, // qos = 0
                0x00,
                0x01,
                b'#', // topic filter = '#'
                0x01, // qos = 1
                0x00,
                0x05,
                b'a',
                b'/',
                b'b',
                b'/',
                b'c', // topic filter = 'a/b/c'
                0x02  // qos = 2
            ]
        );
    }
}
