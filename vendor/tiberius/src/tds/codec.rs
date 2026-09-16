mod batch_request;
mod bulk_load;
mod column_data;
mod decode;
mod encode;
mod guid;
mod header;
mod iterator_ext;
mod login;
mod packet;
mod pre_login;
mod rpc_request;
mod token;
mod type_info;

pub use batch_request::*;
pub use bulk_load::*;
use bytes::BytesMut;
pub use column_data::*;
pub use decode::*;
pub(crate) use encode::*;
use futures_util::stream::{Stream, TryStreamExt};
pub use header::*;
pub(crate) use iterator_ext::*;
pub use login::*;
pub use packet::*;
pub use pre_login::*;
pub use rpc_request::*;
pub use token::*;
pub use type_info::*;

const HEADER_BYTES: usize = 8;
const ALL_HEADERS_LEN_TX: usize = 22;

#[derive(Debug)]
#[repr(u16)]
#[allow(dead_code)]
enum AllHeaderTy {
    QueryDescriptor = 1,
    TransactionDescriptor = 2,
    TraceActivity = 3,
}

pub struct PacketCodec;

pub(crate) async fn collect_from<S, T>(stream: &mut S) -> crate::Result<T>
where
    T: Decode<BytesMut> + Sized,
    S: Stream<Item = crate::Result<Packet>> + Unpin,
{
    let mut buf = BytesMut::new();

    while let Some(packet) = stream.try_next().await? {
        let is_last = packet.is_last();
        let (_, payload) = packet.into_parts();
        buf.extend(payload);

        if is_last {
            break;
        }
    }

    T::decode(&mut buf)
}
