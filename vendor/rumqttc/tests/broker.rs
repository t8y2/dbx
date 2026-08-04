use rumqttc::mqttbytes::v4::*;
use rumqttc::mqttbytes::*;
use std::collections::VecDeque;
use std::io;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::select;
use tokio::{task, time};

use bytes::BytesMut;
use flume::{bounded, Receiver, Sender};
use rumqttc::{Event, Incoming, Outgoing, Packet};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub struct Broker {
    pub(crate) framed: Network,
    pub(crate) incoming: VecDeque<Packet>,
    outgoing_tx: Sender<Packet>,
    outgoing_rx: Receiver<Packet>,
}

impl Broker {
    /// Create a new broker which accepts 1 mqtt connection
    pub async fn new(port: u16, connack: u8) -> Broker {
        let addr = format!("127.0.0.1:{port}");
        let listener = TcpListener::bind(&addr).await.unwrap();

        let (stream, _) = listener.accept().await.unwrap();
        let mut framed = Network::new(stream, 10 * 1024);
        let mut incoming = VecDeque::new();
        let (outgoing_tx, outgoing_rx) = bounded(10);
        framed.readb(&mut incoming).await.unwrap();

        match incoming.pop_front().unwrap() {
            Packet::Connect(_) => {
                let connack = match connack {
                    0 => ConnAck::new(ConnectReturnCode::Success, false),
                    1 => ConnAck::new(ConnectReturnCode::BadUserNamePassword, false),
                    _ => {
                        return Broker {
                            framed,
                            incoming,
                            outgoing_tx,
                            outgoing_rx,
                        }
                    }
                };

                framed.connack(connack).await.unwrap();
            }
            _ => {
                panic!("Expecting connect packet");
            }
        }

        Broker {
            framed,
            incoming: VecDeque::new(),
            outgoing_tx,
            outgoing_rx,
        }
    }

    // Reads a publish packet from the stream with 2 second timeout
    pub async fn read_publish(&mut self) -> Option<Publish> {
        loop {
            let packet = if !self.incoming.is_empty() {
                self.incoming.pop_front().unwrap()
            } else {
                let packet = time::timeout(Duration::from_secs(2), async {
                    self.framed.readb(&mut self.incoming).await.unwrap();
                    self.incoming.pop_front().unwrap()
                })
                .await;

                match packet {
                    Ok(packet) => packet,
                    Err(_e) => return None,
                }
            };

            match packet {
                Packet::Publish(publish) => return Some(publish),
                Packet::PingReq => {
                    self.framed.write(Packet::PingResp).await.unwrap();
                    continue;
                }
                packet => panic!("Expecting a publish. Received = {:?}", packet),
            }
        }
    }

    /// Reads next packet from the stream
    pub async fn read_packet(&mut self) -> Option<Packet> {
        let _ = time::timeout(Duration::from_secs(30), async {
            let p = self.framed.readb(&mut self.incoming).await;
            if p.is_err() {
                println!("Broker read = {p:?}");
            }
            // Sometimes there can be a timeout on the connection so instead of unwrapping return
            // an Option<Packet>
            // p.unwrap()
        })
        .await;

        self.incoming.pop_front()
    }

    /// Reads next packet from the stream
    pub async fn blackhole(&mut self) -> Packet {
        loop {
            self.framed.readb(&mut self.incoming).await.unwrap();
        }
    }

    /// Sends an acknowledgement
    pub async fn ack(&mut self, pkid: u16) {
        let packet = Packet::PubAck(PubAck::new(pkid));
        self.framed.write(packet).await.unwrap();
    }

    /// Sends an acknowledgement
    pub async fn pingresp(&mut self) {
        let packet = Packet::PingResp;
        self.framed.write(packet).await.unwrap();
    }

    pub async fn spawn_publishes(&mut self, count: u8, qos: QoS, delay: u64) {
        let tx = self.outgoing_tx.clone();

        task::spawn(async move {
            for i in 1..=count {
                let topic = "hello/world".to_owned();
                let payload = vec![1, 2, 3, i];
                let mut publish = Publish::new(topic, qos, payload);

                if qos as u8 > 0 {
                    publish.pkid = i as u16;
                }

                let packet = Packet::Publish(publish);
                tx.send_async(packet).await.unwrap();
                time::sleep(Duration::from_secs(delay)).await;
            }
        });
    }

    /// Selects between outgoing and incoming packets
    pub async fn tick(&mut self) -> Event {
        select! {
            request = self.outgoing_rx.recv_async() => {
                let request = request.unwrap();
                let outgoing = self.framed.write(request).await.unwrap();
                Event::Outgoing(outgoing)
            }
            packet = self.framed.readb(&mut self.incoming) => {
                packet.unwrap();
                let incoming = self.incoming.pop_front().unwrap();
                Event::Incoming(incoming)
            }
        }
    }
}

/// Network transforms packets <-> frames efficiently. It takes
/// advantage of pre-allocation, buffering and vectorization when
/// appropriate to achieve performance
pub struct Network {
    /// Socket for IO
    socket: Box<dyn N>,
    /// Buffered reads
    read: BytesMut,
    /// Buffered writes
    write: BytesMut,
    /// Maximum packet size
    max_incoming_size: usize,
    /// Maximum readv count
    max_readb_count: usize,
}

impl Network {
    pub fn new(socket: impl N + 'static, max_incoming_size: usize) -> Network {
        let socket = Box::new(socket) as Box<dyn N>;
        Network {
            socket,
            read: BytesMut::with_capacity(10 * 1024),
            write: BytesMut::with_capacity(10 * 1024),
            max_incoming_size,
            max_readb_count: 10,
        }
    }

    /// Reads more than 'required' bytes to frame a packet into self.read buffer
    async fn read_bytes(&mut self, required: usize) -> io::Result<usize> {
        let mut total_read = 0;
        loop {
            let read = self.socket.read_buf(&mut self.read).await?;
            if 0 == read {
                return if self.read.is_empty() {
                    Err(io::Error::new(
                        io::ErrorKind::ConnectionAborted,
                        "connection closed by peer",
                    ))
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "connection reset by peer",
                    ))
                };
            }

            total_read += read;
            if total_read >= required {
                return Ok(total_read);
            }
        }
    }

    pub async fn connack(&mut self, connack: ConnAck) -> io::Result<usize> {
        let mut write = BytesMut::new();
        let len = match connack.write(&mut write) {
            Ok(size) => size,
            Err(e) => return Err(io::Error::new(io::ErrorKind::InvalidData, e.to_string())),
        };

        self.socket.write_all(&write[..]).await?;
        Ok(len)
    }

    /// Read packets in bulk. This allow replies to be in bulk. This method is used
    /// after the connection is established to read a bunch of incoming packets
    pub async fn readb(&mut self, incoming: &mut VecDeque<Incoming>) -> io::Result<()> {
        let mut count = 0;
        loop {
            match read(&mut self.read, self.max_incoming_size) {
                Ok(packet) => {
                    incoming.push_back(packet);
                    count += 1;
                    if count >= self.max_readb_count {
                        return Ok(());
                    }
                }
                // If some packets are already framed, return those
                Err(Error::InsufficientBytes(_)) if count > 0 => return Ok(()),
                // Wait for more bytes until a frame can be created
                Err(Error::InsufficientBytes(required)) => {
                    self.read_bytes(required).await?;
                }
                Err(e) => return Err(io::Error::new(io::ErrorKind::InvalidData, e.to_string())),
            };
        }
    }

    #[inline]
    async fn write(&mut self, packet: Packet) -> Result<Outgoing, Error> {
        let outgoing = outgoing(&packet);
        match packet {
            Packet::Publish(packet) => packet.write(&mut self.write)?,
            Packet::PubRel(packet) => packet.write(&mut self.write)?,
            Packet::PingReq => {
                let packet = PingReq;
                packet.write(&mut self.write)?
            }
            Packet::PingResp => {
                let packet = PingResp;
                packet.write(&mut self.write)?
            }
            Packet::Subscribe(packet) => packet.write(&mut self.write)?,
            Packet::SubAck(packet) => packet.write(&mut self.write)?,
            Packet::Unsubscribe(packet) => packet.write(&mut self.write)?,
            Packet::UnsubAck(packet) => packet.write(&mut self.write)?,
            Packet::Disconnect => {
                let packet = Disconnect;
                packet.write(&mut self.write)?
            }
            Packet::PubAck(packet) => packet.write(&mut self.write)?,
            Packet::PubRec(packet) => packet.write(&mut self.write)?,
            Packet::PubComp(packet) => packet.write(&mut self.write)?,
            _ => unimplemented!(),
        };

        self.socket.write_all(&self.write[..]).await.unwrap();
        self.write.clear();

        Ok(outgoing)
    }
}

fn outgoing(packet: &Packet) -> Outgoing {
    match packet {
        Packet::Publish(publish) => Outgoing::Publish(publish.pkid),
        Packet::PubAck(puback) => Outgoing::PubAck(puback.pkid),
        Packet::PubRec(pubrec) => Outgoing::PubRec(pubrec.pkid),
        Packet::PubRel(pubrel) => Outgoing::PubRel(pubrel.pkid),
        Packet::PubComp(pubcomp) => Outgoing::PubComp(pubcomp.pkid),
        Packet::Subscribe(subscribe) => Outgoing::Subscribe(subscribe.pkid),
        Packet::Unsubscribe(unsubscribe) => Outgoing::Unsubscribe(unsubscribe.pkid),
        Packet::PingReq => Outgoing::PingReq,
        Packet::PingResp => Outgoing::PingResp,
        Packet::Disconnect => Outgoing::Disconnect,
        packet => panic!("Invalid outgoing packet = {:?}", packet),
    }
}

pub trait N: AsyncRead + AsyncWrite + Send + Sync + Unpin {}
impl<T> N for T where T: AsyncRead + AsyncWrite + Unpin + Send + Sync {}
