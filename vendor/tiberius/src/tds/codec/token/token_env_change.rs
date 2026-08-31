use crate::{tds::Collation, Error, SqlReadBytes};
use byteorder::{LittleEndian, ReadBytesExt};
use fmt::Debug;
use futures_util::io::AsyncReadExt;
use std::{
    convert::TryFrom,
    fmt,
    io::{Cursor, Read},
};

uint_enum! {
    #[repr(u8)]
    pub enum EnvChangeTy {
        Database = 1,
        Language = 2,
        CharacterSet = 3,
        PacketSize = 4,
        UnicodeDataSortingLID = 5,
        UnicodeDataSortingCFL = 6,
        SqlCollation = 7,
        /// below here: >= TDSv7.2
        BeginTransaction = 8,
        CommitTransaction = 9,
        RollbackTransaction = 10,
        EnlistDTCTransaction = 11,
        DefectTransaction = 12,
        Rtls = 13,
        PromoteTransaction = 15,
        TransactionManagerAddress = 16,
        TransactionEnded = 17,
        ResetConnection = 18,
        UserName = 19,
        /// below here: TDS v7.4
        Routing = 20,
    }
}

impl fmt::Display for EnvChangeTy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EnvChangeTy::Database => write!(f, "Database"),
            EnvChangeTy::Language => write!(f, "Language"),
            EnvChangeTy::CharacterSet => write!(f, "CharacterSet"),
            EnvChangeTy::PacketSize => write!(f, "PacketSize"),
            EnvChangeTy::UnicodeDataSortingLID => write!(f, "UnicodeDataSortingLID"),
            EnvChangeTy::UnicodeDataSortingCFL => write!(f, "UnicodeDataSortingCFL"),
            EnvChangeTy::SqlCollation => write!(f, "SqlCollation"),
            EnvChangeTy::BeginTransaction => write!(f, "BeginTransaction"),
            EnvChangeTy::CommitTransaction => write!(f, "CommitTransaction"),
            EnvChangeTy::RollbackTransaction => write!(f, "RollbackTransaction"),
            EnvChangeTy::EnlistDTCTransaction => write!(f, "EnlistDTCTransaction"),
            EnvChangeTy::DefectTransaction => write!(f, "DefectTransaction"),
            EnvChangeTy::Rtls => write!(f, "RTLS"),
            EnvChangeTy::PromoteTransaction => write!(f, "PromoteTransaction"),
            EnvChangeTy::TransactionManagerAddress => write!(f, "TransactionManagerAddress"),
            EnvChangeTy::TransactionEnded => write!(f, "TransactionEnded"),
            EnvChangeTy::ResetConnection => write!(f, "ResetConnection"),
            EnvChangeTy::UserName => write!(f, "UserName"),
            EnvChangeTy::Routing => write!(f, "Routing"),
        }
    }
}

#[derive(Debug)]
pub enum TokenEnvChange {
    Database(String, String),
    PacketSize(u32, u32),
    SqlCollation {
        old: Option<Collation>,
        new: Option<Collation>,
    },
    BeginTransaction([u8; 8]),
    CommitTransaction,
    RollbackTransaction,
    DefectTransaction,
    Routing {
        host: String,
        port: u16,
    },
    ChangeMirror(String),
    Ignored(EnvChangeTy),
}

impl fmt::Display for TokenEnvChange {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(ref old, ref new) => {
                write!(f, "Database change from '{}' to '{}'", old, new)
            }
            Self::PacketSize(old, new) => {
                write!(f, "Packet size change from '{}' to '{}'", old, new)
            }
            Self::SqlCollation { old, new } => match (old, new) {
                (Some(old), Some(new)) => write!(f, "SQL collation change from {} to {}", old, new),
                (_, Some(new)) => write!(f, "SQL collation changed to {}", new),
                (_, _) => write!(f, "SQL collation change"),
            },
            Self::BeginTransaction(_) => write!(f, "Begin transaction"),
            Self::CommitTransaction => write!(f, "Commit transaction"),
            Self::RollbackTransaction => write!(f, "Rollback transaction"),
            Self::DefectTransaction => write!(f, "Defect transaction"),
            Self::Routing { host, port } => write!(
                f,
                "Server requested routing to a new address: {}:{}",
                host, port
            ),
            Self::ChangeMirror(ref mirror) => write!(f, "Fallback mirror server: `{}`", mirror),
            Self::Ignored(ty) => write!(f, "Ignored env change: `{}`", ty),
        }
    }
}

impl TokenEnvChange {
    pub(crate) async fn decode<R>(src: &mut R) -> crate::Result<Self>
    where
        R: SqlReadBytes + Unpin,
    {
        let len = src.read_u16_le().await? as usize;

        // We read all the bytes now, due to whatever environment change tokens
        // we read, they might contain padding zeroes in the end we must
        // discard.
        let mut bytes = vec![0; len];
        src.read_exact(&mut bytes[0..len]).await?;

        let mut buf = Cursor::new(bytes);
        let ty_byte = buf.read_u8()?;

        let ty = EnvChangeTy::try_from(ty_byte)
            .map_err(|_| Error::Protocol(format!("invalid envchange type {:x}", ty_byte).into()))?;

        let token = match ty {
            EnvChangeTy::Database => {
                let len = buf.read_u8()? as usize;
                let mut bytes = vec![0; len];

                for item in bytes.iter_mut().take(len) {
                    *item = buf.read_u16::<LittleEndian>()?;
                }

                let new_value = String::from_utf16(&bytes[..])?;

                let len = buf.read_u8()? as usize;
                let mut bytes = vec![0; len];

                for item in bytes.iter_mut().take(len) {
                    *item = buf.read_u16::<LittleEndian>()?;
                }

                let old_value = String::from_utf16(&bytes[..])?;

                TokenEnvChange::Database(new_value, old_value)
            }
            EnvChangeTy::PacketSize => {
                let len = buf.read_u8()? as usize;
                let mut bytes = vec![0; len];

                for item in bytes.iter_mut().take(len) {
                    *item = buf.read_u16::<LittleEndian>()?;
                }

                let new_value = String::from_utf16(&bytes[..])?;

                let len = buf.read_u8()? as usize;
                let mut bytes = vec![0; len];

                for item in bytes.iter_mut().take(len) {
                    *item = buf.read_u16::<LittleEndian>()?;
                }

                let old_value = String::from_utf16(&bytes[..])?;

                TokenEnvChange::PacketSize(new_value.parse()?, old_value.parse()?)
            }
            EnvChangeTy::SqlCollation => {
                let len = buf.read_u8()? as usize;
                let mut new_value = vec![0; len];
                buf.read_exact(&mut new_value[0..len])?;

                let new = if len == 5 {
                    let new_sortid = new_value[4];
                    let new_info = u32::from_le_bytes([
                        new_value[0],
                        new_value[1],
                        new_value[2],
                        new_value[3],
                    ]);

                    Some(Collation::new(new_info, new_sortid))
                } else {
                    None
                };

                let len = buf.read_u8()? as usize;
                let mut old_value = vec![0; len];
                buf.read_exact(&mut old_value[0..len])?;

                let old = if len == 5 {
                    let old_sortid = old_value[4];
                    let old_info = u32::from_le_bytes([
                        old_value[0],
                        old_value[1],
                        old_value[2],
                        old_value[3],
                    ]);

                    Some(Collation::new(old_info, old_sortid))
                } else {
                    None
                };

                TokenEnvChange::SqlCollation { new, old }
            }
            EnvChangeTy::BeginTransaction | EnvChangeTy::EnlistDTCTransaction => {
                let len = buf.read_u8()?;
                assert!(len == 8);

                let mut desc = [0; 8];
                buf.read_exact(&mut desc)?;

                TokenEnvChange::BeginTransaction(desc)
            }

            EnvChangeTy::CommitTransaction => TokenEnvChange::CommitTransaction,
            EnvChangeTy::RollbackTransaction => TokenEnvChange::RollbackTransaction,
            EnvChangeTy::DefectTransaction => TokenEnvChange::DefectTransaction,

            EnvChangeTy::Routing => {
                buf.read_u16::<LittleEndian>()?; // routing data value length
                buf.read_u8()?; // routing protocol, always 0 (tcp)

                let port = buf.read_u16::<LittleEndian>()?;

                let len = buf.read_u16::<LittleEndian>()? as usize; // hostname string length
                let mut bytes = vec![0; len];

                for item in bytes.iter_mut().take(len) {
                    *item = buf.read_u16::<LittleEndian>()?;
                }

                let host = String::from_utf16(&bytes[..])?;

                TokenEnvChange::Routing { host, port }
            }
            EnvChangeTy::Rtls => {
                let len = buf.read_u8()? as usize;
                let mut bytes = vec![0; len];

                for item in bytes.iter_mut().take(len) {
                    *item = buf.read_u16::<LittleEndian>()?;
                }

                let mirror_name = String::from_utf16(&bytes[..])?;

                TokenEnvChange::ChangeMirror(mirror_name)
            }
            ty => TokenEnvChange::Ignored(ty),
        };

        Ok(token)
    }
}
