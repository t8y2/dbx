use super::guid::reorder_bytes;
use super::{Decode, Encode};
use crate::{tds, Error, Result};
use byteorder::{BigEndian, LittleEndian, ReadBytesExt, WriteBytesExt};
use bytes::{BufMut, BytesMut};
use std::convert::TryFrom;
use std::io::{Cursor, Read};
use tds::EncryptionLevel;
use uuid::Uuid;

/// Client application activity id token used for debugging purposes introduced
/// in TDS 7.4.
#[allow(unused)]
#[derive(Debug, Clone)]
#[cfg_attr(test, derive(PartialEq))]
pub struct ActivityId {
    id: Uuid,
    sequence: u32,
}

/// The prelogin packet used to initialize a connection
#[derive(Debug, Clone)]
#[cfg_attr(test, derive(PartialEq))]
pub struct PreloginMessage {
    /// [BE] token=0x00
    /// Either the driver version or the version of the SQL server
    pub version: u32,
    pub sub_build: u16,
    /// token=0x01
    pub encryption: EncryptionLevel,
    /// token=0x02
    pub instance_name: Option<String>,
    /// [client] threadid for debugging purposes, token=0x03
    pub thread_id: u32,
    /// token=0x04
    pub mars: bool,
    /// token=0x05
    pub activity_id: Option<ActivityId>,
    /// token=0x06
    pub fed_auth_required: bool,
    pub nonce: Option<[u8; 32]>,
}

impl PreloginMessage {
    pub fn new() -> PreloginMessage {
        let driver_version = crate::get_driver_version();
        PreloginMessage {
            version: driver_version as u32,
            sub_build: (driver_version >> 32) as u16,
            encryption: EncryptionLevel::NotSupported,
            instance_name: None,
            thread_id: 0,
            mars: false,
            activity_id: None,
            fed_auth_required: false,
            nonce: None,
        }
    }

    #[cfg(any(
        feature = "rustls",
        feature = "native-tls",
        feature = "vendored-openssl"
    ))]
    pub fn negotiated_encryption(&self, expected: EncryptionLevel) -> EncryptionLevel {
        match (expected, self.encryption) {
            (EncryptionLevel::NotSupported, EncryptionLevel::NotSupported) => {
                EncryptionLevel::NotSupported
            }
            (EncryptionLevel::Off, EncryptionLevel::Off) => EncryptionLevel::Off,
            (EncryptionLevel::On, EncryptionLevel::Off)
            | (EncryptionLevel::On, EncryptionLevel::NotSupported) => {
                panic!("Server does not allow the requested encryption level.")
            }
            (_, _) => EncryptionLevel::On,
        }
    }

    #[cfg(not(any(
        feature = "rustls",
        feature = "native-tls",
        feature = "vendored-openssl"
    )))]
    pub fn negotiated_encryption(&self, _: EncryptionLevel) -> EncryptionLevel {
        EncryptionLevel::NotSupported
    }
}

// prelogin fields
// http://msdn.microsoft.com/en-us/library/dd357559.aspx
const PRELOGIN_VERSION: u8 = 0;
const PRELOGIN_ENCRYPTION: u8 = 1;
const PRELOGIN_INSTOPT: u8 = 2;
const PRELOGIN_THREADID: u8 = 3;
const PRELOGIN_MARS: u8 = 4;
const PRELOGIN_TRACEID: u8 = 5;
const PRELOGIN_FEDAUTHREQUIRED: u8 = 6;
const PRELOGIN_NONCEOPT: u8 = 7;
const PRELOGIN_TERMINATOR: u8 = 0xff;

impl Encode<BytesMut> for PreloginMessage {
    fn encode(self, dst: &mut BytesMut) -> Result<()> {
        let mut fields = Vec::new();
        let mut data_cursor = Cursor::new(Vec::with_capacity(512));

        // version
        fields.push((PRELOGIN_VERSION, 0x04 + 0x02)); // version + subbuild
        data_cursor.write_u32::<BigEndian>(self.version)?;
        data_cursor.write_u16::<BigEndian>(self.sub_build)?;

        // encryption
        fields.push((PRELOGIN_ENCRYPTION, 0x01)); // encryption
        data_cursor.write_u8(self.encryption as u8)?;

        // threadid
        fields.push((PRELOGIN_THREADID, 0x04)); // thread id
        data_cursor.write_u32::<BigEndian>(self.thread_id)?;

        // MARS
        fields.push((PRELOGIN_MARS, 0x01)); // MARS
        data_cursor.write_u8(self.mars as u8)?;

        // fed auth
        if self.fed_auth_required {
            fields.push((PRELOGIN_FEDAUTHREQUIRED, 0x01));
            data_cursor.write_u8(0x01)?;
        }

        // build the packet-body
        // offset = PL_OPTION_TOKEN + PL_OFFSET + PL_OPTION_LENGTH = 5 bytes + the terminator (0xFF)
        let mut data_offset = (fields.len() * 5 + 1) as u16;

        // write the offset table
        for (token, length) in fields {
            dst.put_u8(token);
            dst.put_u16(data_offset);
            dst.put_u16(length);

            data_offset += length;
        }

        dst.put_u8(PRELOGIN_TERMINATOR);
        dst.extend(data_cursor.into_inner());

        Ok(())
    }
}

impl Decode<BytesMut> for PreloginMessage {
    fn decode(src: &mut BytesMut) -> Result<Self>
    where
        Self: Sized,
    {
        let mut cursor = Cursor::new(src);
        let mut ret = PreloginMessage::new();

        // read all options
        loop {
            let token = cursor.read_u8()?;

            // read until terminator
            if token == 0xff {
                break;
            }

            let offset = cursor.read_u16::<BigEndian>()?;
            let length = cursor.read_u16::<BigEndian>()?;
            let old_pos = cursor.position();

            cursor.set_position(offset as u64);

            // verify whether the server acts in accordance to what we requested
            // and if we can handle on what we seemingly agreed to
            // TODO: support parsing more
            match token {
                // version
                PRELOGIN_VERSION => {
                    ret.version = cursor.read_u32::<BigEndian>()?;
                    ret.sub_build = cursor.read_u16::<BigEndian>()?;
                }
                // encryption
                PRELOGIN_ENCRYPTION => {
                    let encrypt = cursor.read_u8()?;
                    ret.encryption = tds::EncryptionLevel::try_from(encrypt).map_err(|_| {
                        Error::Protocol(format!("invalid encryption value: {}", encrypt).into())
                    })?;
                }
                // instance name
                PRELOGIN_INSTOPT => {
                    let mut bytes = Vec::new();
                    let mut next_byte = cursor.read_u8()?;

                    while next_byte != 0x00 {
                        bytes.push(next_byte);
                        next_byte = cursor.read_u8()?;
                    }

                    if !bytes.is_empty() {
                        ret.instance_name = Some(String::from_utf8_lossy(&bytes).into_owned());
                    }
                }
                PRELOGIN_THREADID => {
                    ret.thread_id = if length == 0 {
                        0
                    } else if length == 4 {
                        cursor.read_u32::<BigEndian>()?
                    } else {
                        panic!("should never happen")
                    }
                }
                // mars
                PRELOGIN_MARS => {
                    ret.mars = cursor.read_u8()? != 0;
                }
                // activity id
                PRELOGIN_TRACEID => {
                    // Data is a Guid, 16 bytes and ordered the wrong way around
                    // than Uuid.
                    let mut data = [0u8; 16];

                    cursor.read_exact(&mut data)?;
                    reorder_bytes(&mut data);

                    ret.activity_id = Some(ActivityId {
                        id: Uuid::from_bytes(data),
                        sequence: cursor.read_u32::<LittleEndian>()?,
                    });
                }
                // fed auth
                PRELOGIN_FEDAUTHREQUIRED => {
                    ret.fed_auth_required = cursor.read_u8()? != 0;
                }
                // nonce
                PRELOGIN_NONCEOPT => {
                    let mut data = [0u8; 32];

                    for item in data.iter_mut() {
                        *item = cursor.read_u8()?;
                    }

                    ret.nonce = Some(data);
                }
                _ => panic!("unsupported prelogin token: {}", token),
            }

            cursor.set_position(old_pos);
        }

        Ok(ret)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prelogin_roundtrip() {
        let mut payload = BytesMut::new();
        let prelogin = PreloginMessage::new();
        prelogin
            .clone()
            .encode(&mut payload)
            .expect("encode should succeed");

        let decoded = PreloginMessage::decode(&mut payload).expect("decode should succeed");

        assert_eq!(prelogin, decoded);
    }

    #[test]
    fn prelogin_with_fedauth_roundtrip() {
        let mut payload = BytesMut::new();
        let mut prelogin = PreloginMessage::new();
        prelogin.fed_auth_required = true;
        prelogin
            .clone()
            .encode(&mut payload)
            .expect("encode should succeed");

        let decoded = PreloginMessage::decode(&mut payload).expect("decode should succeed");

        assert_eq!(prelogin, decoded);
    }
}
