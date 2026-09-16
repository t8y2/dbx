use super::*;
use bytes::{Buf, BufMut, Bytes, BytesMut};

/// Acknowledgement to subscribe
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubAck {
    pub pkid: u16,
    pub return_codes: Vec<SubscribeReasonCode>,
    pub properties: Option<SubAckProperties>,
}

impl SubAck {
    fn len(&self) -> usize {
        let mut len = 2 + self.return_codes.len();

        if let Some(p) = &self.properties {
            let properties_len = p.len();
            let properties_len_len = len_len(properties_len);
            len += properties_len_len + properties_len;
        } else {
            // just 1 byte representing 0 len
            len += 1;
        }

        len
    }

    pub fn size(&self) -> usize {
        let len = self.len();
        let remaining_len_size = len_len(len);

        1 + remaining_len_size + len
    }

    pub fn read(fixed_header: FixedHeader, mut bytes: Bytes) -> Result<SubAck, Error> {
        let variable_header_index = fixed_header.fixed_header_len;
        bytes.advance(variable_header_index);

        let pkid = read_u16(&mut bytes)?;
        let properties = SubAckProperties::read(&mut bytes)?;

        if !bytes.has_remaining() {
            return Err(Error::MalformedPacket);
        }

        let mut return_codes = Vec::new();
        while bytes.has_remaining() {
            let return_code = read_u8(&mut bytes)?;
            return_codes.push(reason(return_code)?);
        }

        let suback = SubAck {
            pkid,
            return_codes,
            properties,
        };

        Ok(suback)
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<usize, Error> {
        buffer.put_u8(0x90);
        let remaining_len = self.len();
        let remaining_len_bytes = write_remaining_length(buffer, remaining_len)?;

        buffer.put_u16(self.pkid);

        if let Some(p) = &self.properties {
            p.write(buffer)?;
        } else {
            write_remaining_length(buffer, 0)?;
        }

        let p: Vec<u8> = self.return_codes.iter().map(|&c| code(c)).collect();

        buffer.extend_from_slice(&p);
        Ok(1 + remaining_len_bytes + remaining_len)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscribeReasonCode {
    Success(QoS),
    Failure,
    Unspecified,
    ImplementationSpecific,
    NotAuthorized,
    TopicFilterInvalid,
    PkidInUse,
    QuotaExceeded,
    SharedSubscriptionsNotSupported,
    SubscriptionIdNotSupported,
    WildcardSubscriptionsNotSupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubAckProperties {
    pub reason_string: Option<String>,
    pub user_properties: Vec<(String, String)>,
}

impl SubAckProperties {
    fn len(&self) -> usize {
        let mut len = 0;

        if let Some(reason) = &self.reason_string {
            len += 1 + 2 + reason.len();
        }

        for (key, value) in self.user_properties.iter() {
            len += 1 + 2 + key.len() + 2 + value.len();
        }

        len
    }

    pub fn read(bytes: &mut Bytes) -> Result<Option<SubAckProperties>, Error> {
        let mut reason_string = None;
        let mut user_properties = Vec::new();

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
                PropertyType::ReasonString => {
                    let reason = read_mqtt_string(bytes)?;
                    cursor += 2 + reason.len();
                    reason_string = Some(reason);
                }
                PropertyType::UserProperty => {
                    let key = read_mqtt_string(bytes)?;
                    let value = read_mqtt_string(bytes)?;
                    cursor += 2 + key.len() + 2 + value.len();
                    user_properties.push((key, value));
                }
                _ => return Err(Error::InvalidPropertyType(prop)),
            }
        }

        Ok(Some(SubAckProperties {
            reason_string,
            user_properties,
        }))
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<(), Error> {
        let len = self.len();
        write_remaining_length(buffer, len)?;

        if let Some(reason) = &self.reason_string {
            buffer.put_u8(PropertyType::ReasonString as u8);
            write_mqtt_string(buffer, reason);
        }

        for (key, value) in self.user_properties.iter() {
            buffer.put_u8(PropertyType::UserProperty as u8);
            write_mqtt_string(buffer, key);
            write_mqtt_string(buffer, value);
        }

        Ok(())
    }
}

fn reason(code: u8) -> Result<SubscribeReasonCode, Error> {
    let v = match code {
        0 => SubscribeReasonCode::Success(QoS::AtMostOnce),
        1 => SubscribeReasonCode::Success(QoS::AtLeastOnce),
        2 => SubscribeReasonCode::Success(QoS::ExactlyOnce),
        128 => SubscribeReasonCode::Unspecified,
        131 => SubscribeReasonCode::ImplementationSpecific,
        135 => SubscribeReasonCode::NotAuthorized,
        143 => SubscribeReasonCode::TopicFilterInvalid,
        145 => SubscribeReasonCode::PkidInUse,
        151 => SubscribeReasonCode::QuotaExceeded,
        158 => SubscribeReasonCode::SharedSubscriptionsNotSupported,
        161 => SubscribeReasonCode::SubscriptionIdNotSupported,
        162 => SubscribeReasonCode::WildcardSubscriptionsNotSupported,
        v => return Err(Error::InvalidSubscribeReasonCode(v)),
    };

    Ok(v)
}

fn code(value: SubscribeReasonCode) -> u8 {
    match value {
        SubscribeReasonCode::Success(qos) => qos as u8,
        SubscribeReasonCode::Failure => 0x80,
        SubscribeReasonCode::Unspecified => 128,
        SubscribeReasonCode::ImplementationSpecific => 131,
        SubscribeReasonCode::NotAuthorized => 135,
        SubscribeReasonCode::TopicFilterInvalid => 143,
        SubscribeReasonCode::PkidInUse => 145,
        SubscribeReasonCode::QuotaExceeded => 151,
        SubscribeReasonCode::SharedSubscriptionsNotSupported => 158,
        SubscribeReasonCode::SubscriptionIdNotSupported => 161,
        SubscribeReasonCode::WildcardSubscriptionsNotSupported => 162,
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
        let suback_props = SubAckProperties {
            reason_string: None,
            user_properties: vec![(USER_PROP_KEY.into(), USER_PROP_VAL.into())],
        };

        let suback_pkt = SubAck {
            pkid: 1,
            return_codes: vec![SubscribeReasonCode::Success(QoS::ExactlyOnce)],
            properties: Some(suback_props),
        };

        let size_from_size = suback_pkt.size();
        let size_from_write = suback_pkt.write(&mut dummy_bytes).unwrap();
        let size_from_bytes = dummy_bytes.len();

        assert_eq!(size_from_write, size_from_bytes);
        assert_eq!(size_from_size, size_from_bytes);
    }
}
