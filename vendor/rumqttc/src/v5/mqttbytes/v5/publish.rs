use super::*;
use bytes::{Buf, Bytes};

/// Publish packet
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Publish {
    pub dup: bool,
    pub qos: QoS,
    pub retain: bool,
    pub topic: Bytes,
    pub pkid: u16,
    pub payload: Bytes,
    pub properties: Option<PublishProperties>,
}

impl Publish {
    pub fn new<T: Into<String>, P: Into<Bytes>>(
        topic: T,
        qos: QoS,
        payload: P,
        properties: Option<PublishProperties>,
    ) -> Self {
        let topic = Bytes::copy_from_slice(topic.into().as_bytes());
        Self {
            qos,
            topic,
            payload: payload.into(),
            properties,
            ..Default::default()
        }
    }

    pub fn size(&self) -> usize {
        let len = self.len();
        let remaining_len_size = len_len(len);

        1 + remaining_len_size + len
    }

    fn len(&self) -> usize {
        let mut len = 2 + self.topic.len();
        if self.qos != QoS::AtMostOnce && self.pkid != 0 {
            len += 2;
        }

        if let Some(p) = &self.properties {
            let properties_len = p.len();
            let properties_len_len = len_len(properties_len);
            len += properties_len_len + properties_len;
        } else {
            // just 1 byte representing 0 len
            len += 1;
        }

        len += self.payload.len();
        len
    }

    pub fn read(fixed_header: FixedHeader, mut bytes: Bytes) -> Result<Publish, Error> {
        let qos_num = (fixed_header.byte1 & 0b0110) >> 1;
        let qos = qos(qos_num).ok_or(Error::InvalidQoS(qos_num))?;
        let dup = (fixed_header.byte1 & 0b1000) != 0;
        let retain = (fixed_header.byte1 & 0b0001) != 0;

        let variable_header_index = fixed_header.fixed_header_len;
        bytes.advance(variable_header_index);
        let topic = read_mqtt_bytes(&mut bytes)?;

        // Packet identifier exists where QoS > 0
        let pkid = match qos {
            QoS::AtMostOnce => 0,
            QoS::AtLeastOnce | QoS::ExactlyOnce => read_u16(&mut bytes)?,
        };

        if qos != QoS::AtMostOnce && pkid == 0 {
            return Err(Error::PacketIdZero);
        }

        let properties = PublishProperties::read(&mut bytes)?;
        let publish = Publish {
            dup,
            retain,
            qos,
            pkid,
            topic,
            payload: bytes,
            properties,
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
        write_mqtt_bytes(buffer, &self.topic);

        if self.qos != QoS::AtMostOnce {
            let pkid = self.pkid;
            if pkid == 0 {
                return Err(Error::PacketIdZero);
            }

            buffer.put_u16(pkid);
        }

        if let Some(p) = &self.properties {
            p.write(buffer)?;
        } else {
            write_remaining_length(buffer, 0)?;
        }

        buffer.extend_from_slice(&self.payload);

        Ok(1 + count + len)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PublishProperties {
    pub payload_format_indicator: Option<u8>,
    pub message_expiry_interval: Option<u32>,
    pub topic_alias: Option<u16>,
    pub response_topic: Option<String>,
    pub correlation_data: Option<Bytes>,
    pub user_properties: Vec<(String, String)>,
    pub subscription_identifiers: Vec<usize>,
    pub content_type: Option<String>,
}

impl PublishProperties {
    fn len(&self) -> usize {
        let mut len = 0;

        if self.payload_format_indicator.is_some() {
            len += 1 + 1;
        }

        if self.message_expiry_interval.is_some() {
            len += 1 + 4;
        }

        if self.topic_alias.is_some() {
            len += 1 + 2;
        }

        if let Some(topic) = &self.response_topic {
            len += 1 + 2 + topic.len()
        }

        if let Some(data) = &self.correlation_data {
            len += 1 + 2 + data.len()
        }

        for (key, value) in self.user_properties.iter() {
            len += 1 + 2 + key.len() + 2 + value.len();
        }

        for id in self.subscription_identifiers.iter() {
            len += 1 + len_len(*id);
        }

        if let Some(typ) = &self.content_type {
            len += 1 + 2 + typ.len()
        }

        len
    }

    pub fn read(bytes: &mut Bytes) -> Result<Option<PublishProperties>, Error> {
        let mut payload_format_indicator = None;
        let mut message_expiry_interval = None;
        let mut topic_alias = None;
        let mut response_topic = None;
        let mut correlation_data = None;
        let mut user_properties = Vec::new();
        let mut subscription_identifiers = Vec::new();
        let mut content_type = None;

        let (properties_len_len, properties_len) = length(bytes.iter())?;
        bytes.advance(properties_len_len);
        if properties_len == 0 {
            return Ok(None);
        }

        let mut cursor = 0;
        // read until cursor reaches property length. properties_len = 0 will skip this loop
        while cursor < properties_len {
            let prop = read_u8(bytes)?;
            cursor += 1;

            match property(prop)? {
                PropertyType::PayloadFormatIndicator => {
                    payload_format_indicator = Some(read_u8(bytes)?);
                    cursor += 1;
                }
                PropertyType::MessageExpiryInterval => {
                    message_expiry_interval = Some(read_u32(bytes)?);
                    cursor += 4;
                }
                PropertyType::TopicAlias => {
                    topic_alias = Some(read_u16(bytes)?);
                    cursor += 2;
                }
                PropertyType::ResponseTopic => {
                    let topic = read_mqtt_string(bytes)?;
                    cursor += 2 + topic.len();
                    response_topic = Some(topic);
                }
                PropertyType::CorrelationData => {
                    let data = read_mqtt_bytes(bytes)?;
                    cursor += 2 + data.len();
                    correlation_data = Some(data);
                }
                PropertyType::UserProperty => {
                    let key = read_mqtt_string(bytes)?;
                    let value = read_mqtt_string(bytes)?;
                    cursor += 2 + key.len() + 2 + value.len();
                    user_properties.push((key, value));
                }
                PropertyType::SubscriptionIdentifier => {
                    let (id_len, id) = length(bytes.iter())?;
                    cursor += 1 + id_len;
                    bytes.advance(id_len);
                    subscription_identifiers.push(id);
                }
                PropertyType::ContentType => {
                    let typ = read_mqtt_string(bytes)?;
                    cursor += 2 + typ.len();
                    content_type = Some(typ);
                }
                _ => return Err(Error::InvalidPropertyType(prop)),
            }
        }

        Ok(Some(PublishProperties {
            payload_format_indicator,
            message_expiry_interval,
            topic_alias,
            response_topic,
            correlation_data,
            user_properties,
            subscription_identifiers,
            content_type,
        }))
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<(), Error> {
        let len = self.len();
        write_remaining_length(buffer, len)?;

        if let Some(payload_format_indicator) = self.payload_format_indicator {
            buffer.put_u8(PropertyType::PayloadFormatIndicator as u8);
            buffer.put_u8(payload_format_indicator);
        }

        if let Some(message_expiry_interval) = self.message_expiry_interval {
            buffer.put_u8(PropertyType::MessageExpiryInterval as u8);
            buffer.put_u32(message_expiry_interval);
        }

        if let Some(topic_alias) = self.topic_alias {
            buffer.put_u8(PropertyType::TopicAlias as u8);
            buffer.put_u16(topic_alias);
        }

        if let Some(topic) = &self.response_topic {
            buffer.put_u8(PropertyType::ResponseTopic as u8);
            write_mqtt_string(buffer, topic);
        }

        if let Some(data) = &self.correlation_data {
            buffer.put_u8(PropertyType::CorrelationData as u8);
            write_mqtt_bytes(buffer, data);
        }

        for (key, value) in self.user_properties.iter() {
            buffer.put_u8(PropertyType::UserProperty as u8);
            write_mqtt_string(buffer, key);
            write_mqtt_string(buffer, value);
        }

        for id in self.subscription_identifiers.iter() {
            buffer.put_u8(PropertyType::SubscriptionIdentifier as u8);
            write_remaining_length(buffer, *id)?;
        }

        if let Some(typ) = &self.content_type {
            buffer.put_u8(PropertyType::ContentType as u8);
            write_mqtt_string(buffer, typ);
        }

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::super::test::{USER_PROP_KEY, USER_PROP_VAL};
    use super::*;
    use bytes::BytesMut;
    use pretty_assertions::assert_eq;

    #[test]
    fn length_calculation() {
        let mut dummy_bytes = BytesMut::new();
        // Use user_properties to pad the size to exceed ~128 bytes to make the
        // remaining_length field in the packet be 2 bytes long.
        let publish_props = PublishProperties {
            payload_format_indicator: None,
            message_expiry_interval: None,
            topic_alias: None,
            response_topic: None,
            correlation_data: None,
            user_properties: vec![(USER_PROP_KEY.into(), USER_PROP_VAL.into())],
            subscription_identifiers: vec![1],
            content_type: None,
        };

        let publish_pkt = Publish::new(
            "hello/world",
            QoS::AtMostOnce,
            vec![1; 10],
            Some(publish_props),
        );

        let size_from_size = publish_pkt.size();
        let size_from_write = publish_pkt.write(&mut dummy_bytes).unwrap();
        let size_from_bytes = dummy_bytes.len();

        assert_eq!(size_from_write, size_from_bytes);
        assert_eq!(size_from_size, size_from_bytes);
    }
}
