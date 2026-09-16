use super::*;
use bytes::{Buf, Bytes};

/// Connection packet initiated by the client
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connect {
    /// Mqtt keep alive time
    pub keep_alive: u16,
    /// Client Id
    pub client_id: String,
    /// Clean session. Asks the broker to clear previous state
    pub clean_start: bool,
    pub properties: Option<ConnectProperties>,
}

impl Connect {
    #[allow(clippy::type_complexity)]
    pub fn read(
        fixed_header: FixedHeader,
        mut bytes: Bytes,
    ) -> Result<(Connect, Option<LastWill>, Option<Login>), Error> {
        let variable_header_index = fixed_header.fixed_header_len;
        bytes.advance(variable_header_index);

        // Variable header
        let protocol_name = read_mqtt_string(&mut bytes)?;
        let protocol_level = read_u8(&mut bytes)?;
        if protocol_name != "MQTT" {
            return Err(Error::InvalidProtocol);
        }

        if protocol_level != 5 {
            return Err(Error::InvalidProtocolLevel(protocol_level));
        }

        let connect_flags = read_u8(&mut bytes)?;
        let clean_start = (connect_flags & 0b10) != 0;
        let keep_alive = read_u16(&mut bytes)?;

        let properties = ConnectProperties::read(&mut bytes)?;

        let client_id = read_mqtt_string(&mut bytes)?;
        let will = LastWill::read(connect_flags, &mut bytes)?;
        let login = Login::read(connect_flags, &mut bytes)?;

        let connect = Connect {
            keep_alive,
            client_id,
            clean_start,
            properties,
        };

        Ok((connect, will, login))
    }

    fn len(&self, will: &Option<LastWill>, l: &Option<Login>) -> usize {
        let mut len = 2 + "MQTT".len() // protocol name
                        + 1            // protocol version
                        + 1            // connect flags
                        + 2; // keep alive

        if let Some(p) = &self.properties {
            let properties_len = p.len();
            let properties_len_len = len_len(properties_len);
            len += properties_len_len + properties_len;
        } else {
            // just 1 byte representing 0 len
            len += 1;
        }

        len += 2 + self.client_id.len();

        // last will len
        if let Some(w) = will {
            len += w.len();
        }

        // username and password len
        if let Some(l) = l {
            len += l.len();
        }

        len
    }

    pub fn write(
        &self,
        will: &Option<LastWill>,
        l: &Option<Login>,
        buffer: &mut BytesMut,
    ) -> Result<usize, Error> {
        let len = self.len(will, l);

        buffer.put_u8(0b0001_0000);
        let count = write_remaining_length(buffer, len)?;
        write_mqtt_string(buffer, "MQTT");

        buffer.put_u8(0x05);
        let flags_index = 1 + count + 2 + 4 + 1;

        let mut connect_flags = 0;
        if self.clean_start {
            connect_flags |= 0x02;
        }

        buffer.put_u8(connect_flags);
        buffer.put_u16(self.keep_alive);

        match &self.properties {
            Some(p) => p.write(buffer)?,
            None => {
                write_remaining_length(buffer, 0)?;
            }
        };

        write_mqtt_string(buffer, &self.client_id);

        if let Some(w) = will {
            connect_flags |= w.write(buffer)?;
        }

        if let Some(l) = l {
            connect_flags |= l.write(buffer);
        }

        // update connect flags
        buffer[flags_index] = connect_flags;
        Ok(1 + count + len)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectProperties {
    /// Expiry interval property after loosing connection
    pub session_expiry_interval: Option<u32>,
    /// Maximum simultaneous packets
    pub receive_maximum: Option<u16>,
    /// Maximum packet size
    pub max_packet_size: Option<u32>,
    /// Maximum mapping integer for a topic
    pub topic_alias_max: Option<u16>,
    pub request_response_info: Option<u8>,
    pub request_problem_info: Option<u8>,
    /// List of user properties
    pub user_properties: Vec<(String, String)>,
    /// Method of authentication
    pub authentication_method: Option<String>,
    /// Authentication data
    pub authentication_data: Option<Bytes>,
}

impl ConnectProperties {
    pub fn new() -> ConnectProperties {
        ConnectProperties {
            session_expiry_interval: None,
            receive_maximum: None,
            max_packet_size: None,
            topic_alias_max: None,
            request_response_info: None,
            request_problem_info: None,
            user_properties: Vec::new(),
            authentication_method: None,
            authentication_data: None,
        }
    }

    pub fn read(bytes: &mut Bytes) -> Result<Option<ConnectProperties>, Error> {
        let mut session_expiry_interval = None;
        let mut receive_maximum = None;
        let mut max_packet_size = None;
        let mut topic_alias_max = None;
        let mut request_response_info = None;
        let mut request_problem_info = None;
        let mut user_properties = Vec::new();
        let mut authentication_method = None;
        let mut authentication_data = None;

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
                PropertyType::SessionExpiryInterval => {
                    session_expiry_interval = Some(read_u32(bytes)?);
                    cursor += 4;
                }
                PropertyType::ReceiveMaximum => {
                    receive_maximum = Some(read_u16(bytes)?);
                    cursor += 2;
                }
                PropertyType::MaximumPacketSize => {
                    max_packet_size = Some(read_u32(bytes)?);
                    cursor += 4;
                }
                PropertyType::TopicAliasMaximum => {
                    topic_alias_max = Some(read_u16(bytes)?);
                    cursor += 2;
                }
                PropertyType::RequestResponseInformation => {
                    request_response_info = Some(read_u8(bytes)?);
                    cursor += 1;
                }
                PropertyType::RequestProblemInformation => {
                    request_problem_info = Some(read_u8(bytes)?);
                    cursor += 1;
                }
                PropertyType::UserProperty => {
                    let key = read_mqtt_string(bytes)?;
                    let value = read_mqtt_string(bytes)?;
                    cursor += 2 + key.len() + 2 + value.len();
                    user_properties.push((key, value));
                }
                PropertyType::AuthenticationMethod => {
                    let method = read_mqtt_string(bytes)?;
                    cursor += 2 + method.len();
                    authentication_method = Some(method);
                }
                PropertyType::AuthenticationData => {
                    let data = read_mqtt_bytes(bytes)?;
                    cursor += 2 + data.len();
                    authentication_data = Some(data);
                }
                _ => return Err(Error::InvalidPropertyType(prop)),
            }
        }

        Ok(Some(ConnectProperties {
            session_expiry_interval,
            receive_maximum,
            max_packet_size,
            topic_alias_max,
            request_response_info,
            request_problem_info,
            user_properties,
            authentication_method,
            authentication_data,
        }))
    }

    fn len(&self) -> usize {
        let mut len = 0;

        if self.session_expiry_interval.is_some() {
            len += 1 + 4;
        }

        if self.receive_maximum.is_some() {
            len += 1 + 2;
        }

        if self.max_packet_size.is_some() {
            len += 1 + 4;
        }

        if self.topic_alias_max.is_some() {
            len += 1 + 2;
        }

        if self.request_response_info.is_some() {
            len += 1 + 1;
        }

        if self.request_problem_info.is_some() {
            len += 1 + 1;
        }

        for (key, value) in self.user_properties.iter() {
            len += 1 + 2 + key.len() + 2 + value.len();
        }

        if let Some(authentication_method) = &self.authentication_method {
            len += 1 + 2 + authentication_method.len();
        }

        if let Some(authentication_data) = &self.authentication_data {
            len += 1 + 2 + authentication_data.len();
        }

        len
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<(), Error> {
        let len = self.len();
        write_remaining_length(buffer, len)?;

        if let Some(session_expiry_interval) = self.session_expiry_interval {
            buffer.put_u8(PropertyType::SessionExpiryInterval as u8);
            buffer.put_u32(session_expiry_interval);
        }

        if let Some(receive_maximum) = self.receive_maximum {
            buffer.put_u8(PropertyType::ReceiveMaximum as u8);
            buffer.put_u16(receive_maximum);
        }

        if let Some(max_packet_size) = self.max_packet_size {
            buffer.put_u8(PropertyType::MaximumPacketSize as u8);
            buffer.put_u32(max_packet_size);
        }

        if let Some(topic_alias_max) = self.topic_alias_max {
            buffer.put_u8(PropertyType::TopicAliasMaximum as u8);
            buffer.put_u16(topic_alias_max);
        }

        if let Some(request_response_info) = self.request_response_info {
            buffer.put_u8(PropertyType::RequestResponseInformation as u8);
            buffer.put_u8(request_response_info);
        }

        if let Some(request_problem_info) = self.request_problem_info {
            buffer.put_u8(PropertyType::RequestProblemInformation as u8);
            buffer.put_u8(request_problem_info);
        }

        for (key, value) in self.user_properties.iter() {
            buffer.put_u8(PropertyType::UserProperty as u8);
            write_mqtt_string(buffer, key);
            write_mqtt_string(buffer, value);
        }

        if let Some(authentication_method) = &self.authentication_method {
            buffer.put_u8(PropertyType::AuthenticationMethod as u8);
            write_mqtt_string(buffer, authentication_method);
        }

        if let Some(authentication_data) = &self.authentication_data {
            buffer.put_u8(PropertyType::AuthenticationData as u8);
            write_mqtt_bytes(buffer, authentication_data);
        }

        Ok(())
    }
}

impl Default for ConnectProperties {
    fn default() -> Self {
        Self::new()
    }
}

/// LastWill that broker forwards on behalf of the client
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastWill {
    pub topic: Bytes,
    pub message: Bytes,
    pub qos: QoS,
    pub retain: bool,
    pub properties: Option<LastWillProperties>,
}

impl LastWill {
    pub fn new(
        topic: impl Into<String>,
        payload: impl Into<Vec<u8>>,
        qos: QoS,
        retain: bool,
        properties: Option<LastWillProperties>,
    ) -> LastWill {
        let topic = Bytes::copy_from_slice(topic.into().as_bytes());
        LastWill {
            topic,
            message: Bytes::from(payload.into()),
            qos,
            retain,
            properties,
        }
    }

    fn len(&self) -> usize {
        let mut len = 0;

        if let Some(p) = &self.properties {
            let properties_len = p.len();
            let properties_len_len = len_len(properties_len);
            len += properties_len_len + properties_len;
        } else {
            // just 1 byte representing 0 len
            len += 1;
        }

        len += 2 + self.topic.len() + 2 + self.message.len();
        len
    }

    pub fn read(connect_flags: u8, bytes: &mut Bytes) -> Result<Option<LastWill>, Error> {
        let o = match connect_flags & 0b100 {
            0 if (connect_flags & 0b0011_1000) != 0 => {
                return Err(Error::IncorrectPacketFormat);
            }
            0 => None,
            _ => {
                // Properties in variable header
                let properties = LastWillProperties::read(bytes)?;

                let will_topic = read_mqtt_bytes(bytes)?;
                let will_message = read_mqtt_bytes(bytes)?;
                let qos_num = (connect_flags & 0b11000) >> 3;
                let will_qos = qos(qos_num).ok_or(Error::InvalidQoS(qos_num))?;
                Some(LastWill {
                    topic: will_topic,
                    message: will_message,
                    qos: will_qos,
                    retain: (connect_flags & 0b0010_0000) != 0,
                    properties,
                })
            }
        };

        Ok(o)
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<u8, Error> {
        let mut connect_flags = 0;

        connect_flags |= 0x04 | (self.qos as u8) << 3;
        if self.retain {
            connect_flags |= 0x20;
        }

        if let Some(p) = &self.properties {
            p.write(buffer)?;
        } else {
            write_remaining_length(buffer, 0)?;
        }

        write_mqtt_bytes(buffer, &self.topic);
        write_mqtt_bytes(buffer, &self.message);
        Ok(connect_flags)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastWillProperties {
    pub delay_interval: Option<u32>,
    pub payload_format_indicator: Option<u8>,
    pub message_expiry_interval: Option<u32>,
    pub content_type: Option<String>,
    pub response_topic: Option<String>,
    pub correlation_data: Option<Bytes>,
    pub user_properties: Vec<(String, String)>,
}

impl LastWillProperties {
    fn len(&self) -> usize {
        let mut len = 0;

        if self.delay_interval.is_some() {
            len += 1 + 4;
        }

        if self.payload_format_indicator.is_some() {
            len += 1 + 1;
        }

        if self.message_expiry_interval.is_some() {
            len += 1 + 4;
        }

        if let Some(typ) = &self.content_type {
            len += 1 + 2 + typ.len()
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

        len
    }

    pub fn read(bytes: &mut Bytes) -> Result<Option<LastWillProperties>, Error> {
        let mut delay_interval = None;
        let mut payload_format_indicator = None;
        let mut message_expiry_interval = None;
        let mut content_type = None;
        let mut response_topic = None;
        let mut correlation_data = None;
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
                PropertyType::WillDelayInterval => {
                    delay_interval = Some(read_u32(bytes)?);
                    cursor += 4;
                }
                PropertyType::PayloadFormatIndicator => {
                    payload_format_indicator = Some(read_u8(bytes)?);
                    cursor += 1;
                }
                PropertyType::MessageExpiryInterval => {
                    message_expiry_interval = Some(read_u32(bytes)?);
                    cursor += 4;
                }
                PropertyType::ContentType => {
                    let typ = read_mqtt_string(bytes)?;
                    cursor += 2 + typ.len();
                    content_type = Some(typ);
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
                _ => return Err(Error::InvalidPropertyType(prop)),
            }
        }

        Ok(Some(LastWillProperties {
            delay_interval,
            payload_format_indicator,
            message_expiry_interval,
            content_type,
            response_topic,
            correlation_data,
            user_properties,
        }))
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<(), Error> {
        let len = self.len();
        write_remaining_length(buffer, len)?;

        if let Some(delay_interval) = self.delay_interval {
            buffer.put_u8(PropertyType::WillDelayInterval as u8);
            buffer.put_u32(delay_interval);
        }

        if let Some(payload_format_indicator) = self.payload_format_indicator {
            buffer.put_u8(PropertyType::PayloadFormatIndicator as u8);
            buffer.put_u8(payload_format_indicator);
        }

        if let Some(message_expiry_interval) = self.message_expiry_interval {
            buffer.put_u8(PropertyType::MessageExpiryInterval as u8);
            buffer.put_u32(message_expiry_interval);
        }

        if let Some(typ) = &self.content_type {
            buffer.put_u8(PropertyType::ContentType as u8);
            write_mqtt_string(buffer, typ);
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

        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Login {
    pub username: String,
    pub password: String,
}

impl Login {
    pub fn new<U: Into<String>, P: Into<String>>(u: U, p: P) -> Login {
        Login {
            username: u.into(),
            password: p.into(),
        }
    }

    pub fn read(connect_flags: u8, bytes: &mut Bytes) -> Result<Option<Login>, Error> {
        let username = match connect_flags & 0b1000_0000 {
            0 => String::new(),
            _ => read_mqtt_string(bytes)?,
        };

        let password = match connect_flags & 0b0100_0000 {
            0 => String::new(),
            _ => read_mqtt_string(bytes)?,
        };

        if username.is_empty() && password.is_empty() {
            Ok(None)
        } else {
            Ok(Some(Login { username, password }))
        }
    }

    fn len(&self) -> usize {
        let mut len = 0;

        if !self.username.is_empty() {
            len += 2 + self.username.len();
        }

        if !self.password.is_empty() {
            len += 2 + self.password.len();
        }

        len
    }

    pub fn write(&self, buffer: &mut BytesMut) -> u8 {
        let mut connect_flags = 0;
        if !self.username.is_empty() {
            connect_flags |= 0x80;
            write_mqtt_string(buffer, &self.username);
        }

        if !self.password.is_empty() {
            connect_flags |= 0x40;
            write_mqtt_string(buffer, &self.password);
        }

        connect_flags
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
        let mut connect_props = ConnectProperties::new();
        // Use user_properties to pad the size to exceed ~128 bytes to make the
        // remaining_length field in the packet be 2 bytes long.
        connect_props.user_properties = vec![(USER_PROP_KEY.into(), USER_PROP_VAL.into())];
        let connect_pkt = Connect {
            keep_alive: 5,
            client_id: "client".into(),
            clean_start: true,
            properties: Some(connect_props),
        };

        let reported_size = connect_pkt.write(&None, &None, &mut dummy_bytes).unwrap();
        let size_from_bytes = dummy_bytes.len();

        assert_eq!(reported_size, size_from_bytes);
    }
}
