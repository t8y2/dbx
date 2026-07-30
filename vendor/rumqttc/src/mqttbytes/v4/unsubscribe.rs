use super::*;
use bytes::{Buf, Bytes};

/// Unsubscribe packet
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsubscribe {
    pub pkid: u16,
    pub topics: Vec<String>,
}

impl Unsubscribe {
    pub fn new<S: Into<String>>(topic: S) -> Unsubscribe {
        Unsubscribe {
            pkid: 0,
            topics: vec![topic.into()],
        }
    }

    fn len(&self) -> usize {
        // len of pkid + vec![subscribe topics len]
        2 + self.topics.iter().fold(0, |s, t| s + t.len() + 2)
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
        let mut payload_bytes = fixed_header.remaining_len - 2;
        let mut topics = Vec::with_capacity(1);

        while payload_bytes > 0 {
            let topic_filter = read_mqtt_string(&mut bytes)?;
            payload_bytes -= topic_filter.len() + 2;
            topics.push(topic_filter);
        }

        let unsubscribe = Unsubscribe { pkid, topics };
        Ok(unsubscribe)
    }

    pub fn write(&self, payload: &mut BytesMut) -> Result<usize, Error> {
        let remaining_len = self.len();

        payload.put_u8(0xA2);
        let remaining_len_bytes = write_remaining_length(payload, remaining_len)?;
        payload.put_u16(self.pkid);

        for topic in self.topics.iter() {
            write_mqtt_string(payload, topic.as_str());
        }
        Ok(1 + remaining_len_bytes + remaining_len)
    }
}
