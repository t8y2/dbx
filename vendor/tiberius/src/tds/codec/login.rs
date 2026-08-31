use super::Encode;
use byteorder::{LittleEndian, WriteBytesExt};
use bytes::BytesMut;
use enumflags2::{bitflags, BitFlags};
use io::{Cursor, Write};
use std::fmt::Debug;
use std::{borrow::Cow, io};

uint_enum! {
    #[repr(u32)]
    #[derive(PartialOrd)]
    pub enum FeatureLevel {
        SqlServerV7 = 0x70000000,
        SqlServer2000 = 0x71000000,
        SqlServer2000Sp1 = 0x71000001,
        SqlServer2005 = 0x72090002,
        SqlServer2008 = 0x730A0003,
        SqlServer2008R2 = 0x730B0003,
        /// 2012, 2014, 2016
        SqlServerN = 0x74000004,
    }
}

impl Default for FeatureLevel {
    fn default() -> Self {
        Self::SqlServerN
    }
}

impl FeatureLevel {
    pub fn done_row_count_bytes(self) -> u8 {
        if self as u32 >= FeatureLevel::SqlServer2005 as u32 {
            8
        } else {
            4
        }
    }
}

#[bitflags]
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionFlag1 {
    /// The byte order used by client for numeric and datetime data types.
    /// (default: little-endian)
    BigEndian = 1 << 0,
    /// The character set used on the client. (default: ASCII)
    CharsetEBDDIC = 1 << 1,
    /// Use VAX floating point representation. (default: IEEE 754)
    FloatVax = 1 << 2,
    /// Use ND5000 floating point representation. (default: IEEE 754)
    FloatND5000 = 1 << 3,
    /// Set is dump/load or BCP capabilities are needed by the client.
    /// (default: ON)
    BcpDumploadOff = 1 << 4,
    /// Set if the client requires warning messages on execution of the USE SQL
    /// statement. If this flag is not set, the server MUST NOT inform the
    /// client when the database changes, and therefore the client will be
    /// unaware of any accompanying collation changes. (default: ON)
    UseDbNotify = 1 << 5,
    /// Set if the change to initial database needs to succeed if the connection
    /// is to succeed. (default: OFF)
    InitDbFatal = 1 << 6,
    /// Set if the client requires warning messages on execution of a language
    /// change statement. (default: OFF)
    LangChangeWarn = 1 << 7,
}

#[bitflags]
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionFlag2 {
    /// Set if the change to initial language needs to succeed if the connect is
    /// to succeed.
    InitLangFatal = 1 << 0,
    /// Set if the client is the ODBC driver. This causes the server to set
    /// `ANSI_DEFAULTS=ON`, `CURSOR_CLOSE_ON_COMMIT`, `IMPLICIT_TRANSACTIONS=OFF`,
    /// `TEXTSIZE=0x7FFFFFFF` (2GB) (TDS 7.2 and earlier) `TEXTSIZE` to infinite
    /// (TDS 7.3), and `ROWCOUNT` to infinite.
    OdbcDriver = 1 << 1,
    /// (not documented)
    TransBoundary = 1 << 2,
    /// (not documented)
    CacheConnect = 1 << 3,
    /// Reserved (not really documented)
    UserTypeServer = 1 << 4,
    /// Distributed Query login
    UserTypeRemUser = 1 << 5,
    /// Replication login
    UserTypeSqlRepl = 1 << 6,
    /// Use integrated security in the client.
    IntegratedSecurity = 1 << 7,
}

#[bitflags]
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionFlag3 {
    /// Request to change login's password.
    RequestChangePassword = 1 << 0,
    /// XML data type instances are returned as binary XML.
    BinaryXML = 1 << 1,
    /// Client is requesting separate process to be spawned as user instance.
    SpawnUserInstance = 1 << 2,
    /// This bit is used by the server to determine if a client is able to
    /// properly handle collations introduced after TDS 7.2. TDS 7.2 and earlier
    /// clients are encouraged to use this loginpacket bit. Servers MUST ignore
    /// this bit when it is sent by TDS 7.3 or 7.4 clients.
    UnknownCollationHandling = 1 << 3,
    /// ibExtension/cbExtension fields are used.
    ExtensionUsed = 1 << 4,
}

#[bitflags]
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginTypeFlag {
    /// Use T-SQL syntax.
    UseTSQL = 1 << 0,
    /// Set if the client is the OLEDB driver. This causes the server to set
    /// ANSI_DEFAULTS to ON, CURSOR_CLOSE_ON_COMMIT and IMPLICIT_TRANSACTIONS to
    /// OFF, TEXTSIZE to 0x7FFFFFFF (2GB) (TDS 7.2 and earlier), TEXTSIZE to
    /// infinite (introduced in TDS 7.3), and ROWCOUNT to infinite.
    UseOLEDB = 1 << 4,
    /// This bit was introduced in TDS 7.4; however, TDS 7.1, 7.2, and 7.3
    /// clients can also use this bit in LOGIN7 to specify that the application
    /// intent of the connection is read-only. The server SHOULD ignore this bit
    /// if the highest TDS version supported by the server is lower than TDS 7.4.
    ReadOnlyIntent = 1 << 5,
}

pub(crate) const FEA_EXT_FEDAUTH: u8 = 0x02u8;
pub(crate) const FEA_EXT_TERMINATOR: u8 = 0xFFu8;
pub(crate) const FED_AUTH_LIBRARYSECURITYTOKEN: u8 = 0x01;

/// https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-tds/773a62b6-ee89-4c02-9e5e-344882630aac
#[derive(Debug, Clone, Default)]
#[cfg_attr(test, derive(PartialEq, Eq))]
struct FedAuthExt<'a> {
    fed_auth_echo: bool,
    fed_auth_token: Cow<'a, str>,
    nonce: Option<[u8; 32]>,
}

/// the login packet
#[derive(Debug, Clone, Default)]
#[cfg_attr(test, derive(PartialEq, Eq))]
pub struct LoginMessage<'a> {
    /// the highest TDS version the client supports
    tds_version: FeatureLevel,
    /// the requested packet size
    packet_size: u32,
    /// the version of the interface library
    client_prog_ver: u32,
    /// the process id of the client application
    client_pid: u32,
    /// the connection id of the primary server
    /// (used when connecting to an "Always UP" backup server)
    connection_id: u32,
    option_flags_1: BitFlags<OptionFlag1>,
    option_flags_2: BitFlags<OptionFlag2>,
    /// flag included in option_flags_2
    integrated_security: Option<Vec<u8>>,
    type_flags: BitFlags<LoginTypeFlag>,
    option_flags_3: BitFlags<OptionFlag3>,
    client_timezone: i32,
    client_lcid: u32,
    hostname: Cow<'a, str>,
    username: Cow<'a, str>,
    password: Cow<'a, str>,
    app_name: Cow<'a, str>,
    server_name: Cow<'a, str>,
    /// the default database to connect to
    db_name: Cow<'a, str>,
    fed_auth_ext: Option<FedAuthExt<'a>>,
}

impl<'a> LoginMessage<'a> {
    pub fn new() -> LoginMessage<'a> {
        Self {
            packet_size: 4096,
            option_flags_1: OptionFlag1::UseDbNotify | OptionFlag1::InitDbFatal,
            option_flags_2: OptionFlag2::InitLangFatal | OptionFlag2::OdbcDriver,
            option_flags_3: BitFlags::from_flag(OptionFlag3::UnknownCollationHandling),
            app_name: "tiberius".into(),
            ..Default::default()
        }
    }

    #[cfg(any(all(unix, feature = "integrated-auth-gssapi"), windows))]
    pub fn integrated_security(&mut self, bytes: Option<Vec<u8>>) {
        if bytes.is_some() {
            self.option_flags_2.insert(OptionFlag2::IntegratedSecurity);
        } else {
            self.option_flags_2.remove(OptionFlag2::IntegratedSecurity);
        }

        self.integrated_security = bytes;
    }

    pub fn app_name(&mut self, name: impl Into<Cow<'a, str>>) {
        self.app_name = name.into();
    }

    pub fn db_name(&mut self, db_name: impl Into<Cow<'a, str>>) {
        self.db_name = db_name.into();
    }

    pub fn server_name(&mut self, server_name: impl Into<Cow<'a, str>>) {
        self.server_name = server_name.into();
    }

    pub fn user_name(&mut self, user_name: impl Into<Cow<'a, str>>) {
        self.username = user_name.into();
    }

    pub fn password(&mut self, password: impl Into<Cow<'a, str>>) {
        self.password = password.into();
    }

    pub fn aad_token(
        &mut self,
        token: impl Into<Cow<'a, str>>,
        fed_auth_echo: bool,
        nonce: Option<[u8; 32]>,
    ) {
        self.option_flags_3.insert(OptionFlag3::ExtensionUsed);

        self.fed_auth_ext = Some(FedAuthExt {
            fed_auth_echo,
            fed_auth_token: token.into(),
            nonce,
        })
    }

    pub fn readonly(&mut self, readonly: bool) {
        if readonly {
            self.type_flags.insert(LoginTypeFlag::ReadOnlyIntent);
        } else {
            self.type_flags.remove(LoginTypeFlag::ReadOnlyIntent);
        }
    }
}

impl<'a> Encode<BytesMut> for LoginMessage<'a> {
    fn encode(self, dst: &mut BytesMut) -> crate::Result<()> {
        let mut cursor = Cursor::new(Vec::with_capacity(512));

        // Space for the length
        cursor.write_u32::<LittleEndian>(0)?;

        cursor.write_u32::<LittleEndian>(self.tds_version as u32)?;
        cursor.write_u32::<LittleEndian>(self.packet_size)?;
        cursor.write_u32::<LittleEndian>(self.client_prog_ver)?;
        cursor.write_u32::<LittleEndian>(self.client_pid)?;
        cursor.write_u32::<LittleEndian>(self.connection_id)?;

        cursor.write_u8(self.option_flags_1.bits())?;
        cursor.write_u8(self.option_flags_2.bits())?;
        cursor.write_u8(self.type_flags.bits())?;
        cursor.write_u8(self.option_flags_3.bits())?;

        cursor.write_u32::<LittleEndian>(self.client_timezone as u32)?;
        cursor.write_u32::<LittleEndian>(self.client_lcid)?;

        // variable length data (OffsetLength)
        let var_data = [
            &self.hostname,
            &self.username,
            &self.password,
            &self.app_name,
            &self.server_name,
            &"".into(), // 5. ibExtension
            &"".into(), // ibCltIntName
            &"".into(), // ibLanguage
            &self.db_name,
            &"".into(), // 9. ClientId (6 bytes); this is included in var_data so we don't lack the bytes of cbSspiLong (4=2*2) and can insert it at the correct position
            &"".into(), // 10. ibSSPI
            &"".into(), // ibAtchDBFile
            &"".into(), // ibChangePassword
        ];

        let mut data_offset = cursor.position() as usize + var_data.len() * 2 * 2 + 6;
        let mut fea_ext_offset = 0;

        for (i, value) in var_data.iter().enumerate() {
            if i == 5 {
                // we might need to update the feature ext potion later
                fea_ext_offset = cursor.position();
            }

            // write the client ID (created from the MAC address)
            if i == 9 {
                cursor.write_u32::<LittleEndian>(0)?; //TODO:
                cursor.write_u16::<LittleEndian>(42)?; //TODO: generate real client id
                continue;
            }

            cursor.write_u16::<LittleEndian>(data_offset as u16)?;

            // ibSSPI
            if i == 10 {
                let length = if let Some(ref bytes) = self.integrated_security {
                    let bak = cursor.position();

                    cursor.set_position(data_offset as u64);
                    cursor.write_all(bytes)?;

                    data_offset += bytes.len();
                    cursor.set_position(bak);

                    bytes.len()
                } else {
                    0
                };

                cursor.write_u16::<LittleEndian>(length as u16)?;

                continue;
            }

            // jump into the data portion of the output
            let bak = cursor.position();
            cursor.set_position(data_offset as u64);

            for codepoint in value.encode_utf16() {
                cursor.write_u16::<LittleEndian>(codepoint)?;
            }

            let new_position = cursor.position() as usize;

            // prepare the password in MS-fashion
            if i == 2 {
                let buffer = cursor.get_mut();
                for byte in buffer.iter_mut().take(new_position).skip(data_offset) {
                    *byte = ((*byte << 4) & 0xf0 | (*byte >> 4) & 0x0f) ^ 0xA5;
                }
            }

            let length = new_position - data_offset;
            cursor.set_position(bak);
            data_offset += length;

            // microsoft being really consistent here... using byte offsets with utf16-length's
            // sounds like premature optimization
            cursor.write_u16::<LittleEndian>(length as u16 / 2)?;
        }

        // cbSSPILong
        cursor.write_u32::<LittleEndian>(0)?;

        // FeatureExt
        if let Some(fed_auth_ext) = self.fed_auth_ext {
            // update fea_ext_offset
            cursor.set_position(fea_ext_offset);
            cursor.write_u16::<LittleEndian>(data_offset as u16)?;
            cursor.write_u16::<LittleEndian>(4)?;

            cursor.set_position(data_offset as u64);
            data_offset += 4;
            cursor.write_u32::<LittleEndian>(data_offset as u32)?;

            cursor.write_u8(FEA_EXT_FEDAUTH)?;

            let mut token = Cursor::new(Vec::new());
            for codepoint in fed_auth_ext.fed_auth_token.encode_utf16() {
                token.write_u16::<LittleEndian>(codepoint)?;
            }
            let token = token.into_inner();

            // options (1) + TokenLength(4) + Token.length + nonce.length
            let feature_ext_length =
                1 + 4 + token.len() + if fed_auth_ext.nonce.is_some() { 32 } else { 0 };

            cursor.write_u32::<LittleEndian>(feature_ext_length as u32)?;

            let mut options: u8 = FED_AUTH_LIBRARYSECURITYTOKEN << 1;
            if fed_auth_ext.fed_auth_echo {
                options |= 1 // fFedAuthEcho
            }

            cursor.write_u8(options)?;

            cursor.write_u32::<LittleEndian>(token.len() as u32)?;
            cursor.write_all(token.as_slice())?;

            if let Some(nonce) = fed_auth_ext.nonce {
                cursor.write_all(nonce.as_ref())?;
            }

            cursor.write_u8(FEA_EXT_TERMINATOR)?;
        }

        cursor.set_position(0);
        cursor.write_u32::<LittleEndian>(cursor.get_ref().len() as u32)?;

        dst.extend(cursor.into_inner());

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Decode;
    use byteorder::ReadBytesExt;
    use bytes::BytesMut;
    use std::io::Read;

    impl<'a> Decode<BytesMut> for LoginMessage<'a> {
        fn decode(src: &mut BytesMut) -> crate::Result<Self>
        where
            Self: Sized,
        {
            let mut cursor = Cursor::new(src);
            let mut ret = LoginMessage::new();

            let total_length = cursor.read_u32::<LittleEndian>()?;

            ret.tds_version = cursor
                .read_u32::<LittleEndian>()?
                .try_into()
                .expect("tds_version verification");
            ret.packet_size = cursor.read_u32::<LittleEndian>()?;
            ret.client_prog_ver = cursor.read_u32::<LittleEndian>()?;
            ret.client_pid = cursor.read_u32::<LittleEndian>()?;
            ret.connection_id = cursor.read_u32::<LittleEndian>()?;

            ret.option_flags_1 =
                BitFlags::from_bits(cursor.read_u8()?).expect("option_flags_1 verification");
            ret.option_flags_2 =
                BitFlags::from_bits(cursor.read_u8()?).expect("option_flags_2 verification");
            ret.type_flags =
                BitFlags::from_bits(cursor.read_u8()?).expect("type_flags verification");
            ret.option_flags_3 =
                BitFlags::from_bits(cursor.read_u8()?).expect("option_flags_3 verification");

            ret.client_timezone = cursor.read_u32::<LittleEndian>()? as i32;
            ret.client_lcid = cursor.read_u32::<LittleEndian>()?;

            macro_rules! read_offset_length_bytes {
                () => {{
                    let offset = cursor.read_u16::<LittleEndian>()?;
                    let length = cursor.read_u16::<LittleEndian>()?;
                    let pos = cursor.position();
                    cursor.set_position(offset as u64);

                    let mut values = vec![0u8; length as usize];
                    cursor.read_exact(&mut values)?;

                    cursor.set_position(pos);
                    values
                }};
            }

            macro_rules! read_offset_length_string {
                () => {
                    read_offset_length_string!("")
                };
                ($tag:expr) => {{
                    let offset = cursor.read_u16::<LittleEndian>()?;
                    let length = cursor.read_u16::<LittleEndian>()?;
                    let pos = cursor.position();
                    cursor.set_position(offset as u64);

                    if $tag == "password" {
                        let buffer = cursor.get_mut();
                        for byte in buffer
                            .iter_mut()
                            .skip(offset as usize)
                            .take(length as usize * 2)
                        {
                            *byte ^= 0xA5;
                            *byte = ((*byte << 4) & 0xf0 | (*byte >> 4) & 0x0f);
                        }
                    }

                    let mut values = vec![0u16; length as usize];
                    cursor.read_u16_into::<LittleEndian>(&mut values)?;
                    cursor.set_position(pos);

                    String::from_utf16(&values).expect("decode utf16")
                }};
            }

            ret.hostname = read_offset_length_string!().into();
            ret.username = read_offset_length_string!().into();
            ret.password = read_offset_length_string!("password").into();
            ret.app_name = read_offset_length_string!().into();
            ret.server_name = read_offset_length_string!().into();
            let fea_ext_offset = read_offset_length_bytes!(); // 5. ibExtension
            let fea_ext_offset = if fea_ext_offset.len() == 4 {
                u32::from_le_bytes(fea_ext_offset.try_into().unwrap())
            } else {
                0
            };
            let _ = read_offset_length_string!(); // ibCltIntName
            let _ = read_offset_length_string!(); // ibLanguage
            ret.db_name = read_offset_length_string!().into();
            // 9. ClientId (6 bytes); this is included in var_data so we don't lack the bytes of cbSspiLong (4=2*2) and can insert it at the correct position
            let _ = cursor.read_u32::<LittleEndian>()?;
            let _ = cursor.read_u16::<LittleEndian>()?;
            let is = read_offset_length_bytes!();
            ret.integrated_security = if is.is_empty() { None } else { Some(is) };
            let _ = read_offset_length_string!(); // ibAtchDBFile
            let _ = read_offset_length_string!(); // ibChangePassword
                                                  // let _ = cursor.read_u32::<LittleEndian>()?;
                                                  // cbSSPILong

            if fea_ext_offset != 0 {
                cursor.set_position((fea_ext_offset) as u64);

                assert!(ret.option_flags_3.contains(OptionFlag3::ExtensionUsed));
                loop {
                    let fe = cursor.read_u8()?;
                    if fe == FEA_EXT_TERMINATOR {
                        break;
                    } else if fe == FEA_EXT_FEDAUTH {
                        let fea_ext_len = cursor.read_u32::<LittleEndian>()?;
                        let pos = cursor.position();
                        let mut options = cursor.read_u8()?;
                        let fed_auth_echo = (options & 1) == 1;
                        options >>= 1;
                        if options != FED_AUTH_LIBRARYSECURITYTOKEN {
                            unimplemented!("unsupported FedAuthLibrary {:?}", options);
                        }
                        let token_len = cursor.read_u32::<LittleEndian>()? as usize;
                        let mut token = vec![0u16; token_len / 2];
                        cursor.read_u16_into::<LittleEndian>(&mut token)?;
                        let token = String::from_utf16(&token).expect("decode utf16");
                        let remaining = fea_ext_len - (cursor.position() - pos) as u32;
                        let nonce = if remaining == 32 {
                            let mut a = [0u8; 32];
                            cursor.read_exact(&mut a)?;
                            Some(a)
                        } else if remaining == 0 {
                            None
                        } else {
                            panic!("read feature ext fail: {}", remaining);
                        };

                        let fed_auth_ext = FedAuthExt {
                            fed_auth_echo,
                            fed_auth_token: token.into(),
                            nonce,
                        };
                        ret.fed_auth_ext = Some(fed_auth_ext);
                    } else {
                        unimplemented!("unsupported feature ext {:?}", fe);
                    }
                }
            }

            assert!(cursor.position() <= total_length as u64);

            Ok(ret)
        }
    }

    #[test]
    fn login_message_round_trip() {
        let mut payload = BytesMut::new();
        let mut login = LoginMessage::new();
        login.db_name("fake-database-name");
        login.app_name("fake-app-name");
        login.server_name("fake-server-name");
        login.user_name("fake-user-name");
        login.password("fake-pw");
        login
            .clone()
            .encode(&mut payload)
            .expect("encode should succeed");

        let decoded = LoginMessage::decode(&mut payload).expect("decode should succeed");

        assert_eq!(login, decoded);
    }

    #[test]
    fn specify_aad_token() {
        let mut login = LoginMessage::new();
        let token = "fake-aad-token";
        let nonce = [3u8; 32];
        login.aad_token(token, true, Some(nonce));

        assert!(login.option_flags_3.contains(OptionFlag3::ExtensionUsed));
        assert_eq!(
            login.fed_auth_ext.expect("fed_auto_specified"),
            FedAuthExt {
                fed_auth_echo: true,
                fed_auth_token: token.into(),
                nonce: Some(nonce)
            }
        )
    }

    #[test]
    fn login_message_with_fed_auth_round_trip() {
        let mut payload = BytesMut::new();
        let mut login = LoginMessage::new();
        let nonce = [1u8; 32];
        login.aad_token("fake-aad-token", true, Some(nonce));
        login
            .clone()
            .encode(&mut payload)
            .expect("encode should succeed");

        let decoded = LoginMessage::decode(&mut payload).expect("decode should succeed");

        assert_eq!(login, decoded);
    }
}
