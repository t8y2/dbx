use std::convert::{TryFrom, TryInto};

use bytes::{BufMut, Bytes, BytesMut};

use super::*;

use super::{property, PropertyType};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum DisconnectReasonCode {
    /// Close the connection normally. Do not send the Will Message.
    NormalDisconnection = 0x00,
    /// The Client wishes to disconnect but requires that the Server also publishes its Will Message.
    DisconnectWithWillMessage = 0x04,
    /// The Connection is closed but the sender either does not wish to reveal the reason, or none of the other Reason Codes apply.
    UnspecifiedError = 0x80,
    /// The received packet does not conform to this specification.
    MalformedPacket = 0x81,
    /// An unexpected or out of order packet was received.
    ProtocolError = 0x82,
    /// The packet received is valid but cannot be processed by this implementation.
    ImplementationSpecificError = 0x83,
    /// The request is not authorized.
    NotAuthorized = 0x87,
    /// The Server is busy and cannot continue processing requests from this Client.
    ServerBusy = 0x89,
    /// The Server is shutting down.
    ServerShuttingDown = 0x8B,
    /// The Connection is closed because no packet has been received for 1.5 times the Keepalive time.
    KeepAliveTimeout = 0x8D,
    /// Another Connection using the same ClientID has connected causing this Connection to be closed.
    SessionTakenOver = 0x8E,
    /// The Topic Filter is correctly formed, but is not accepted by this Sever.
    TopicFilterInvalid = 0x8F,
    /// The Topic Name is correctly formed, but is not accepted by this Client or Server.
    TopicNameInvalid = 0x90,
    /// The Client or Server has received more than Receive Maximum publication for which it has not sent PUBACK or PUBCOMP.
    ReceiveMaximumExceeded = 0x93,
    /// The Client or Server has received a PUBLISH packet containing a Topic Alias which is greater than the Maximum Topic Alias it sent in the CONNECT or CONNACK packet.
    TopicAliasInvalid = 0x94,
    /// The packet size is greater than Maximum Packet Size for this Client or Server.
    PacketTooLarge = 0x95,
    /// The received data rate is too high.
    MessageRateTooHigh = 0x96,
    /// An implementation or administrative imposed limit has been exceeded.
    QuotaExceeded = 0x97,
    /// The Connection is closed due to an administrative action.
    AdministrativeAction = 0x98,
    /// The payload format does not match the one specified by the Payload Format Indicator.
    PayloadFormatInvalid = 0x99,
    /// The Server has does not support retained messages.
    RetainNotSupported = 0x9A,
    /// The Client specified a QoS greater than the QoS specified in a Maximum QoS in the CONNACK.
    QoSNotSupported = 0x9B,
    /// The Client should temporarily change its Server.
    UseAnotherServer = 0x9C,
    /// The Server is moved and the Client should permanently change its server location.
    ServerMoved = 0x9D,
    /// The Server does not support Shared Subscriptions.
    SharedSubscriptionNotSupported = 0x9E,
    /// This connection is closed because the connection rate is too high.
    ConnectionRateExceeded = 0x9F,
    /// The maximum connection time authorized for this connection has been exceeded.
    MaximumConnectTime = 0xA0,
    /// The Server does not support Subscription Identifiers; the subscription is not accepted.
    SubscriptionIdentifiersNotSupported = 0xA1,
    /// The Server does not support Wildcard subscription; the subscription is not accepted.
    WildcardSubscriptionsNotSupported = 0xA2,
}

impl TryFrom<u8> for DisconnectReasonCode {
    type Error = Error;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        let rc = match value {
            0x00 => Self::NormalDisconnection,
            0x04 => Self::DisconnectWithWillMessage,
            0x80 => Self::UnspecifiedError,
            0x81 => Self::MalformedPacket,
            0x82 => Self::ProtocolError,
            0x83 => Self::ImplementationSpecificError,
            0x87 => Self::NotAuthorized,
            0x89 => Self::ServerBusy,
            0x8B => Self::ServerShuttingDown,
            0x8D => Self::KeepAliveTimeout,
            0x8E => Self::SessionTakenOver,
            0x8F => Self::TopicFilterInvalid,
            0x90 => Self::TopicNameInvalid,
            0x93 => Self::ReceiveMaximumExceeded,
            0x94 => Self::TopicAliasInvalid,
            0x95 => Self::PacketTooLarge,
            0x96 => Self::MessageRateTooHigh,
            0x97 => Self::QuotaExceeded,
            0x98 => Self::AdministrativeAction,
            0x99 => Self::PayloadFormatInvalid,
            0x9A => Self::RetainNotSupported,
            0x9B => Self::QoSNotSupported,
            0x9C => Self::UseAnotherServer,
            0x9D => Self::ServerMoved,
            0x9E => Self::SharedSubscriptionNotSupported,
            0x9F => Self::ConnectionRateExceeded,
            0xA0 => Self::MaximumConnectTime,
            0xA1 => Self::SubscriptionIdentifiersNotSupported,
            0xA2 => Self::WildcardSubscriptionsNotSupported,
            other => return Err(Error::InvalidConnectReturnCode(other)),
        };

        Ok(rc)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisconnectProperties {
    /// Session Expiry Interval in seconds
    pub session_expiry_interval: Option<u32>,

    /// Human readable reason for the disconnect
    pub reason_string: Option<String>,

    /// List of user properties
    pub user_properties: Vec<(String, String)>,

    /// String which can be used by the Client to identify another Server to use.
    pub server_reference: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Disconnect {
    /// Disconnect Reason Code
    pub reason_code: DisconnectReasonCode,

    /// Disconnect Properties
    pub properties: Option<DisconnectProperties>,
}

impl DisconnectProperties {
    // pub fn new() -> Self {
    //     Self {
    //         session_expiry_interval: None,
    //         reason_string: None,
    //         user_properties: Vec::new(),
    //         server_reference: None,
    //     }
    // }

    fn len(&self) -> usize {
        let mut length = 0;

        if self.session_expiry_interval.is_some() {
            length += 1 + 4;
        }

        if let Some(reason) = &self.reason_string {
            length += 1 + 2 + reason.len();
        }

        for (key, value) in self.user_properties.iter() {
            length += 1 + 2 + key.len() + 2 + value.len();
        }

        if let Some(server_reference) = &self.server_reference {
            length += 1 + 2 + server_reference.len();
        }

        length
    }

    pub fn extract(bytes: &mut Bytes) -> Result<Option<Self>, Error> {
        let (properties_len_len, properties_len) = length(bytes.iter())?;

        bytes.advance(properties_len_len);

        if properties_len == 0 {
            return Ok(None);
        }

        let mut session_expiry_interval = None;
        let mut reason_string = None;
        let mut user_properties = Vec::new();
        let mut server_reference = None;

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
                PropertyType::ServerReference => {
                    let reference = read_mqtt_string(bytes)?;
                    cursor += 2 + reference.len();
                    server_reference = Some(reference);
                }
                _ => return Err(Error::InvalidPropertyType(prop)),
            }
        }

        let properties = Self {
            session_expiry_interval,
            reason_string,
            user_properties,
            server_reference,
        };

        Ok(Some(properties))
    }

    fn write(&self, buffer: &mut BytesMut) -> Result<(), Error> {
        let length = self.len();
        write_remaining_length(buffer, length)?;

        if let Some(session_expiry_interval) = self.session_expiry_interval {
            buffer.put_u8(PropertyType::SessionExpiryInterval as u8);
            buffer.put_u32(session_expiry_interval);
        }

        if let Some(reason) = &self.reason_string {
            buffer.put_u8(PropertyType::ReasonString as u8);
            write_mqtt_string(buffer, reason);
        }

        for (key, value) in self.user_properties.iter() {
            buffer.put_u8(PropertyType::UserProperty as u8);
            write_mqtt_string(buffer, key);
            write_mqtt_string(buffer, value);
        }

        if let Some(reference) = &self.server_reference {
            buffer.put_u8(PropertyType::ServerReference as u8);
            write_mqtt_string(buffer, reference);
        }

        Ok(())
    }
}

impl Disconnect {
    pub fn new(reason: DisconnectReasonCode) -> Self {
        Self {
            reason_code: reason,
            properties: None,
        }
    }

    fn len(&self) -> usize {
        if self.reason_code == DisconnectReasonCode::NormalDisconnection
            && self.properties.is_none()
        {
            return 2; // Packet type + 0x00
        }

        let mut length = 0;

        if let Some(properties) = &self.properties {
            length += 1; // Disconnect Reason Code

            let properties_len = properties.len();
            let properties_len_len = len_len(properties_len);
            length += properties_len_len + properties_len;
        } else {
            length += 1;
        }

        length
    }

    pub fn size(&self) -> usize {
        let len = self.len();
        if len == 2 {
            return len;
        }

        let remaining_len_size = len_len(len);

        1 + remaining_len_size + len
    }

    pub fn read(fixed_header: FixedHeader, mut bytes: Bytes) -> Result<Self, Error> {
        let packet_type = fixed_header.byte1 >> 4;
        let flags = fixed_header.byte1 & 0b0000_1111;

        bytes.advance(fixed_header.fixed_header_len);

        if packet_type != PacketType::Disconnect as u8 {
            return Err(Error::InvalidPacketType(packet_type));
        };

        if flags != 0x00 {
            return Err(Error::MalformedPacket);
        };

        if fixed_header.remaining_len == 0 {
            return Ok(Self::new(DisconnectReasonCode::NormalDisconnection));
        }

        let reason_code = read_u8(&mut bytes)?;

        let disconnect = Self {
            reason_code: reason_code.try_into()?,
            properties: DisconnectProperties::extract(&mut bytes)?,
        };

        Ok(disconnect)
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<usize, Error> {
        buffer.put_u8(0xE0);

        let length = self.len();

        if length == 2 {
            buffer.put_u8(0x00);
            return Ok(length);
        }

        let len_len = write_remaining_length(buffer, length)?;

        buffer.put_u8(self.reason_code as u8);

        if let Some(properties) = &self.properties {
            properties.write(buffer)?;
        } else {
            write_remaining_length(buffer, 0)?;
        }

        Ok(1 + len_len + length)
    }
}

#[cfg(test)]
mod test {
    use bytes::BytesMut;

    use super::parse_fixed_header;

    use super::{Disconnect, DisconnectProperties, DisconnectReasonCode};

    #[test]
    fn disconnect1_parsing_works() {
        let mut buffer = bytes::BytesMut::new();
        let packet_bytes = [
            0xE0, // Packet type
            0x00, // Remaining length
        ];
        let expected = Disconnect::new(DisconnectReasonCode::NormalDisconnection);

        buffer.extend_from_slice(&packet_bytes[..]);

        let fixed_header = parse_fixed_header(buffer.iter()).unwrap();
        let disconnect_bytes = buffer.split_to(fixed_header.frame_length()).freeze();
        let disconnect = Disconnect::read(fixed_header, disconnect_bytes).unwrap();

        assert_eq!(disconnect, expected);
    }

    #[test]
    fn disconnect1_encoding_works() {
        let mut buffer = BytesMut::new();
        let disconnect = Disconnect::new(DisconnectReasonCode::NormalDisconnection);
        let expected = [
            0xE0, // Packet type
            0x00, // Remaining length
        ];

        disconnect.write(&mut buffer).unwrap();

        assert_eq!(&buffer[..], &expected);
    }

    fn sample2() -> Disconnect {
        let properties = DisconnectProperties {
            // TODO: change to 2137 xD
            session_expiry_interval: Some(1234),
            reason_string: Some("test".to_owned()),
            user_properties: vec![("test".to_owned(), "test".to_owned())],
            server_reference: Some("test".to_owned()),
        };

        Disconnect {
            reason_code: DisconnectReasonCode::UnspecifiedError,
            properties: Some(properties),
        }
    }

    fn sample_bytes2() -> Vec<u8> {
        vec![
            0xE0, // Packet type
            0x22, // Remaining length
            0x80, // Disconnect Reason Code
            0x20, // Properties length
            0x11, 0x00, 0x00, 0x04, 0xd2, // Session expiry interval
            0x1F, 0x00, 0x04, 0x74, 0x65, 0x73, 0x74, // Reason string
            0x26, 0x00, 0x04, 0x74, 0x65, 0x73, 0x74, 0x00, 0x04, 0x74, 0x65, 0x73,
            0x74, // User properties
            0x1C, 0x00, 0x04, 0x74, 0x65, 0x73, 0x74, // server reference
        ]
    }

    #[test]
    fn disconnect2_parsing_works() {
        let mut buffer = bytes::BytesMut::new();
        let packet_bytes = sample_bytes2();
        let expected = sample2();

        buffer.extend_from_slice(&packet_bytes[..]);

        let fixed_header = parse_fixed_header(buffer.iter()).unwrap();
        let disconnect_bytes = buffer.split_to(fixed_header.frame_length()).freeze();
        let disconnect = Disconnect::read(fixed_header, disconnect_bytes).unwrap();

        assert_eq!(disconnect, expected);
    }

    #[test]
    fn disconnect2_encoding_works() {
        let mut buffer = BytesMut::new();

        let disconnect = sample2();
        let expected = sample_bytes2();

        disconnect.write(&mut buffer).unwrap();

        assert_eq!(&buffer[..], &expected);
    }

    // use super::*;
    use super::super::test::{USER_PROP_KEY, USER_PROP_VAL};
    // use bytes::BytesMut;
    use pretty_assertions::assert_eq;

    #[test]
    fn length_calculation() {
        let mut dummy_bytes = BytesMut::new();
        // Use user_properties to pad the size to exceed ~128 bytes to make the
        // remaining_length field in the packet be 2 bytes long.
        let disconn_props = DisconnectProperties {
            session_expiry_interval: None,
            reason_string: None,
            user_properties: vec![(USER_PROP_KEY.into(), USER_PROP_VAL.into())],
            server_reference: None,
        };

        let mut disconn_pkt = Disconnect::new(DisconnectReasonCode::NormalDisconnection);
        disconn_pkt.properties = Some(disconn_props);

        let size_from_size = disconn_pkt.size();
        let size_from_write = disconn_pkt.write(&mut dummy_bytes).unwrap();
        let size_from_bytes = dummy_bytes.len();

        assert_eq!(size_from_write, size_from_bytes);
        assert_eq!(size_from_size, size_from_bytes);
    }
}
