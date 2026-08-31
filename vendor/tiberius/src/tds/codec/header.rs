use super::{Decode, Encode};
use crate::Error;
use bytes::{Buf, BufMut, BytesMut};
use std::convert::TryFrom;

uint_enum! {
    /// the type of the packet [2.2.3.1.1]#[repr(u32)]
    #[repr(u8)]
    pub enum PacketType {
        SQLBatch = 1,
        /// unused
        PreTDSv7Login = 2,
        Rpc = 3,
        TabularResult = 4,
        AttentionSignal = 6,
        BulkLoad = 7,
        /// Federated Authentication Token
        Fat = 8,
        TransactionManagerReq = 14,
        TDSv7Login = 16,
        Sspi = 17,
        PreLogin = 18,
    }
}

uint_enum! {
    /// the message state [2.2.3.1.2]
    #[repr(u8)]
    pub enum PacketStatus {
        NormalMessage = 0,
        EndOfMessage = 1,
        /// [client to server ONLY] (EndOfMessage also required)
        IgnoreEvent = 3,
        /// [client to server ONLY] [>= TDSv7.1]
        ResetConnection = 0x08,
        /// [client to server ONLY] [>= TDSv7.3]
        ResetConnectionSkipTran = 0x10,
    }
}

/// packet header consisting of 8 bytes [2.2.3.1]
#[derive(Debug, Clone, Copy)]
pub(crate) struct PacketHeader {
    ty: PacketType,
    status: PacketStatus,
    /// [BE] the length of the packet (including the 8 header bytes)
    /// must match the negotiated size sending from client to server [since TDSv7.3] after login
    /// (only if not EndOfMessage)
    length: u16,
    /// [BE] the process ID on the server, for debugging purposes only
    spid: u16,
    /// packet id
    id: u8,
    /// currently unused
    window: u8,
}

impl PacketHeader {
    pub fn new(length: usize, id: u8) -> PacketHeader {
        assert!(length <= u16::max_value() as usize);
        PacketHeader {
            ty: PacketType::TDSv7Login,
            status: PacketStatus::ResetConnection,
            length: length as u16,
            spid: 0,
            id,
            window: 0,
        }
    }

    pub fn rpc(id: u8) -> Self {
        Self {
            ty: PacketType::Rpc,
            status: PacketStatus::NormalMessage,
            ..Self::new(0, id)
        }
    }

    pub fn pre_login(id: u8) -> Self {
        Self {
            ty: PacketType::PreLogin,
            status: PacketStatus::EndOfMessage,
            ..Self::new(0, id)
        }
    }

    pub fn login(id: u8) -> Self {
        Self {
            ty: PacketType::TDSv7Login,
            status: PacketStatus::EndOfMessage,
            ..Self::new(0, id)
        }
    }

    pub fn batch(id: u8) -> Self {
        Self {
            ty: PacketType::SQLBatch,
            status: PacketStatus::NormalMessage,
            ..Self::new(0, id)
        }
    }

    pub fn bulk_load(id: u8) -> Self {
        Self {
            ty: PacketType::BulkLoad,
            status: PacketStatus::NormalMessage,
            ..Self::new(0, id)
        }
    }

    pub fn set_status(&mut self, status: PacketStatus) {
        self.status = status;
    }

    pub fn set_type(&mut self, ty: PacketType) {
        self.ty = ty;
    }

    pub fn status(&self) -> PacketStatus {
        self.status
    }

    pub fn r#type(&self) -> PacketType {
        self.ty
    }

    pub fn length(&self) -> u16 {
        self.length
    }
}

impl<B> Encode<B> for PacketHeader
where
    B: BufMut,
{
    fn encode(self, dst: &mut B) -> crate::Result<()> {
        dst.put_u8(self.ty as u8);
        dst.put_u8(self.status as u8);
        dst.put_u16(self.length);
        dst.put_u16(self.spid);
        dst.put_u8(self.id);
        dst.put_u8(self.window);

        Ok(())
    }
}

impl Decode<BytesMut> for PacketHeader {
    fn decode(src: &mut BytesMut) -> crate::Result<Self>
    where
        Self: Sized,
    {
        let raw_ty = src.get_u8();

        let ty = PacketType::try_from(raw_ty).map_err(|_| {
            Error::Protocol(format!("header: invalid packet type: {}", raw_ty).into())
        })?;

        let status = PacketStatus::try_from(src.get_u8())
            .map_err(|_| Error::Protocol("header: invalid packet status".into()))?;

        let header = PacketHeader {
            ty,
            status,
            length: src.get_u16(),
            spid: src.get_u16(),
            id: src.get_u8(),
            window: src.get_u8(),
        };

        Ok(header)
    }
}
