use super::*;
use bytes::{Buf, Bytes};

/// Connection packet initiated by the client
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connect {
    /// Mqtt protocol version
    pub protocol: Protocol,
    /// Mqtt keep alive time
    pub keep_alive: u16,
    /// Client Id
    pub client_id: String,
    /// Clean session. Asks the broker to clear previous state
    pub clean_session: bool,
    /// Will that broker needs to publish when the client disconnects
    pub last_will: Option<LastWill>,
    /// Login credentials
    pub login: Option<Login>,
}

impl Connect {
    pub fn new<S: Into<String>>(id: S) -> Connect {
        Connect {
            protocol: Protocol::V4,
            keep_alive: 10,
            client_id: id.into(),
            clean_session: true,
            last_will: None,
            login: None,
        }
    }

    pub fn set_login<U: Into<String>, P: Into<String>>(&mut self, u: U, p: P) -> &mut Connect {
        let login = Login {
            username: u.into(),
            password: p.into(),
        };

        self.login = Some(login);
        self
    }

    fn len(&self) -> usize {
        let protocol_name = match self.protocol {
            Protocol::V3 => "MQIsdp",
            Protocol::V4 | Protocol::V5 => "MQTT",
        };

        let mut len = 2 + protocol_name.len() // protocol name
                              + 1            // protocol version
                              + 1            // connect flags
                              + 2; // keep alive

        len += 2 + self.client_id.len();

        // last will len
        if let Some(last_will) = &self.last_will {
            len += last_will.len();
        }

        // username and password len
        if let Some(login) = &self.login {
            len += login.len();
        }

        len
    }

    pub fn read(fixed_header: FixedHeader, mut bytes: Bytes) -> Result<Connect, Error> {
        let variable_header_index = fixed_header.fixed_header_len;
        bytes.advance(variable_header_index);

        // Variable header
        let protocol_name = read_mqtt_string(&mut bytes)?;
        let protocol_level = read_u8(&mut bytes)?;
        if protocol_name != "MQTT" && protocol_name != "MQIsdp" {
            return Err(Error::InvalidProtocol);
        }

        let protocol = match protocol_level {
            3 => Protocol::V3,
            4 => Protocol::V4,
            5 => Protocol::V5,
            num => return Err(Error::InvalidProtocolLevel(num)),
        };

        let connect_flags = read_u8(&mut bytes)?;
        let clean_session = (connect_flags & 0b10) != 0;
        let keep_alive = read_u16(&mut bytes)?;

        let client_id = read_mqtt_string(&mut bytes)?;
        let last_will = LastWill::read(connect_flags, &mut bytes)?;
        let login = Login::read(connect_flags, &mut bytes)?;

        let connect = Connect {
            protocol,
            keep_alive,
            client_id,
            clean_session,
            last_will,
            login,
        };

        Ok(connect)
    }

    pub fn write(&self, buffer: &mut BytesMut) -> Result<usize, Error> {
        let len = self.len();
        buffer.put_u8(0b0001_0000);
        let count = write_remaining_length(buffer, len)?;
        let protocol_name = match self.protocol {
            Protocol::V3 => "MQIsdp",
            Protocol::V4 | Protocol::V5 => "MQTT",
        };
        write_mqtt_string(buffer, protocol_name);

        match self.protocol {
            Protocol::V3 => buffer.put_u8(0x03),
            Protocol::V4 => buffer.put_u8(0x04),
            Protocol::V5 => buffer.put_u8(0x05),
        }

        let flags_index = 1 + count + 2 + protocol_name.len() + 1;

        let mut connect_flags = 0;
        if self.clean_session {
            connect_flags |= 0x02;
        }

        buffer.put_u8(connect_flags);
        buffer.put_u16(self.keep_alive);
        write_mqtt_string(buffer, &self.client_id);

        if let Some(last_will) = &self.last_will {
            connect_flags |= last_will.write(buffer)?;
        }

        if let Some(login) = &self.login {
            connect_flags |= login.write(buffer);
        }

        // update connect flags
        buffer[flags_index] = connect_flags;
        Ok(len)
    }
}

/// LastWill that broker forwards on behalf of the client
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastWill {
    pub topic: String,
    pub message: Bytes,
    pub qos: QoS,
    pub retain: bool,
}

impl LastWill {
    pub fn new(
        topic: impl Into<String>,
        payload: impl Into<Vec<u8>>,
        qos: QoS,
        retain: bool,
    ) -> LastWill {
        LastWill {
            topic: topic.into(),
            message: Bytes::from(payload.into()),
            qos,
            retain,
        }
    }

    fn len(&self) -> usize {
        let mut len = 0;
        len += 2 + self.topic.len() + 2 + self.message.len();
        len
    }

    fn read(connect_flags: u8, bytes: &mut Bytes) -> Result<Option<LastWill>, Error> {
        let last_will = match connect_flags & 0b100 {
            0 if (connect_flags & 0b0011_1000) != 0 => {
                return Err(Error::IncorrectPacketFormat);
            }
            0 => None,
            _ => {
                let will_topic = read_mqtt_string(bytes)?;
                let will_message = read_mqtt_bytes(bytes)?;
                let will_qos = qos((connect_flags & 0b11000) >> 3)?;
                Some(LastWill {
                    topic: will_topic,
                    message: will_message,
                    qos: will_qos,
                    retain: (connect_flags & 0b0010_0000) != 0,
                })
            }
        };

        Ok(last_will)
    }

    fn write(&self, buffer: &mut BytesMut) -> Result<u8, Error> {
        let mut connect_flags = 0;

        connect_flags |= 0x04 | (self.qos as u8) << 3;
        if self.retain {
            connect_flags |= 0x20;
        }

        write_mqtt_string(buffer, &self.topic);
        write_mqtt_bytes(buffer, &self.message);
        Ok(connect_flags)
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

    fn read(connect_flags: u8, bytes: &mut Bytes) -> Result<Option<Login>, Error> {
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

    fn write(&self, buffer: &mut BytesMut) -> u8 {
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

    pub fn validate(&self, username: &str, password: &str) -> bool {
        (self.username == *username) && (self.password == *password)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use bytes::BytesMut;
    use pretty_assertions::assert_eq;

    #[test]
    fn connect_parsing_works() {
        let mut stream = bytes::BytesMut::new();
        let packetstream = &[
            0x10,
            39, // packet type, flags and remaining len
            0x00,
            0x04,
            b'M',
            b'Q',
            b'T',
            b'T',
            0x04,        // variable header
            0b1100_1110, // variable header. +username, +password, -will retain, will qos=1, +last_will, +clean_session
            0x00,
            0x0a, // variable header. keep alive = 10 sec
            0x00,
            0x04,
            b't',
            b'e',
            b's',
            b't', // payload. client_id
            0x00,
            0x02,
            b'/',
            b'a', // payload. will topic = '/a'
            0x00,
            0x07,
            b'o',
            b'f',
            b'f',
            b'l',
            b'i',
            b'n',
            b'e', // payload. variable header. will msg = 'offline'
            0x00,
            0x04,
            b'r',
            b'u',
            b'm',
            b'q', // payload. username = 'rumq'
            0x00,
            0x02,
            b'm',
            b'q', // payload. password = 'mq'
            0xDE,
            0xAD,
            0xBE,
            0xEF, // extra packets in the stream
        ];

        stream.extend_from_slice(&packetstream[..]);
        let fixed_header = parse_fixed_header(stream.iter()).unwrap();
        let connect_bytes = stream.split_to(fixed_header.frame_length()).freeze();
        let packet = Connect::read(fixed_header, connect_bytes).unwrap();

        assert_eq!(
            packet,
            Connect {
                protocol: Protocol::V4,
                keep_alive: 10,
                client_id: "test".to_owned(),
                clean_session: true,
                last_will: Some(LastWill::new("/a", "offline", QoS::AtLeastOnce, false)),
                login: Some(Login::new("rumq", "mq")),
            }
        );
    }

    fn sample_bytes() -> Vec<u8> {
        vec![
            0x10,
            39,
            0x00,
            0x04,
            b'M',
            b'Q',
            b'T',
            b'T',
            0x04,
            0b1100_1110, // +username, +password, -will retain, will qos=1, +last_will, +clean_session
            0x00,
            0x0a, // 10 sec
            0x00,
            0x04,
            b't',
            b'e',
            b's',
            b't', // client_id
            0x00,
            0x02,
            b'/',
            b'a', // will topic = '/a'
            0x00,
            0x07,
            b'o',
            b'f',
            b'f',
            b'l',
            b'i',
            b'n',
            b'e', // will msg = 'offline'
            0x00,
            0x04,
            b'r',
            b'u',
            b's',
            b't', // username = 'rust'
            0x00,
            0x02,
            b'm',
            b'q', // password = 'mq'
        ]
    }

    #[test]
    fn connect_encoding_works() {
        let connect = Connect {
            protocol: Protocol::V4,
            keep_alive: 10,
            client_id: "test".to_owned(),
            clean_session: true,
            last_will: Some(LastWill::new("/a", "offline", QoS::AtLeastOnce, false)),
            login: Some(Login::new("rust", "mq")),
        };

        let mut buf = BytesMut::new();
        connect.write(&mut buf).unwrap();

        // println!("{:?}", &buf[..]);
        // println!("{:?}", sample_bytes());

        assert_eq!(buf, sample_bytes());
    }

    #[test]
    fn connect_v3_encoding_works() {
        let connect = Connect {
            protocol: Protocol::V3,
            keep_alive: 10,
            client_id: "test".to_owned(),
            clean_session: true,
            last_will: Some(LastWill::new("/a", "offline", QoS::AtLeastOnce, false)),
            login: Some(Login::new("rust", "mq")),
        };

        let mut buf = BytesMut::new();
        connect.write(&mut buf).unwrap();

        assert_eq!(
            buf,
            vec![
                0x10, 41, 0x00, 0x06, b'M', b'Q', b'I', b's', b'd', b'p', 0x03, 0b1100_1110, 0x00, 0x0a, 0x00, 0x04,
                b't', b'e', b's', b't', 0x00, 0x02, b'/', b'a', 0x00, 0x07, b'o', b'f', b'f', b'l', b'i', b'n', b'e',
                0x00, 0x04, b'r', b'u', b's', b't', 0x00, 0x02, b'm', b'q'
            ]
        );
    }
}
