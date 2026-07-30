use super::*;

mod connack;
mod connect;
mod disconnect;
mod ping;
mod puback;
mod pubcomp;
mod publish;
mod pubrec;
mod pubrel;
mod suback;
mod subscribe;
mod unsuback;
mod unsubscribe;

pub use connack::*;
pub use connect::*;
pub use disconnect::*;
pub use ping::*;
pub use puback::*;
pub use pubcomp::*;
pub use publish::*;
pub use pubrec::*;
pub use pubrel::*;
pub use suback::*;
pub use subscribe::*;
pub use unsuback::*;
pub use unsubscribe::*;

/// Encapsulates all MQTT packet types
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Packet {
    Connect(Connect),
    ConnAck(ConnAck),
    Publish(Publish),
    PubAck(PubAck),
    PubRec(PubRec),
    PubRel(PubRel),
    PubComp(PubComp),
    Subscribe(Subscribe),
    SubAck(SubAck),
    Unsubscribe(Unsubscribe),
    UnsubAck(UnsubAck),
    PingReq,
    PingResp,
    Disconnect,
}

/// Reads a stream of bytes and extracts next MQTT packet out of it
pub fn read(stream: &mut BytesMut, max_size: usize) -> Result<Packet, Error> {
    let fixed_header = check(stream.iter(), max_size)?;

    // Test with a stream with exactly the size to check border panics
    let packet = stream.split_to(fixed_header.frame_length());
    let packet_type = fixed_header.packet_type()?;

    if fixed_header.remaining_len == 0 {
        // no payload packets
        return match packet_type {
            PacketType::PingReq => Ok(Packet::PingReq),
            PacketType::PingResp => Ok(Packet::PingResp),
            PacketType::Disconnect => Ok(Packet::Disconnect),
            _ => Err(Error::PayloadRequired),
        };
    }

    let packet = packet.freeze();
    let packet = match packet_type {
        PacketType::Connect => Packet::Connect(Connect::read(fixed_header, packet)?),
        PacketType::ConnAck => Packet::ConnAck(ConnAck::read(fixed_header, packet)?),
        PacketType::Publish => Packet::Publish(Publish::read(fixed_header, packet)?),
        PacketType::PubAck => Packet::PubAck(PubAck::read(fixed_header, packet)?),
        PacketType::PubRec => Packet::PubRec(PubRec::read(fixed_header, packet)?),
        PacketType::PubRel => Packet::PubRel(PubRel::read(fixed_header, packet)?),
        PacketType::PubComp => Packet::PubComp(PubComp::read(fixed_header, packet)?),
        PacketType::Subscribe => Packet::Subscribe(Subscribe::read(fixed_header, packet)?),
        PacketType::SubAck => Packet::SubAck(SubAck::read(fixed_header, packet)?),
        PacketType::Unsubscribe => Packet::Unsubscribe(Unsubscribe::read(fixed_header, packet)?),
        PacketType::UnsubAck => Packet::UnsubAck(UnsubAck::read(fixed_header, packet)?),
        PacketType::PingReq => Packet::PingReq,
        PacketType::PingResp => Packet::PingResp,
        PacketType::Disconnect => Packet::Disconnect,
    };

    Ok(packet)
}

/// Return number of remaining length bytes required for encoding length
fn len_len(len: usize) -> usize {
    if len >= 2_097_152 {
        4
    } else if len >= 16_384 {
        3
    } else if len >= 128 {
        2
    } else {
        1
    }
}
