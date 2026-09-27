use std::{
    io,
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

enum FaultDirective {
    None,
    DropCommitAck,
    DropQueryResponse { marker: String },
}

enum PendingResponse {
    Contention,
    DropCommitAck,
}

struct ProxyState {
    fault: Mutex<FaultDirective>,
    contention_marker: Mutex<Option<String>>,
    contention_forwarded: AtomicBool,
    contention_response_pending: AtomicBool,
    commit_tracking: AtomicBool,
    commit_forward_count: AtomicUsize,
    commit_ok_observed: AtomicBool,
    commit_ack_dropped: AtomicBool,
    dropped_query_forwarded: AtomicBool,
}

impl Default for ProxyState {
    fn default() -> Self {
        Self {
            fault: Mutex::new(FaultDirective::None),
            contention_marker: Mutex::new(None),
            contention_forwarded: AtomicBool::new(false),
            contention_response_pending: AtomicBool::new(false),
            commit_tracking: AtomicBool::new(false),
            commit_forward_count: AtomicUsize::new(0),
            commit_ok_observed: AtomicBool::new(false),
            commit_ack_dropped: AtomicBool::new(false),
            dropped_query_forwarded: AtomicBool::new(false),
        }
    }
}

pub struct MysqlWireProxy {
    listen_addr: SocketAddr,
    state: Arc<ProxyState>,
    cancellation: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl MysqlWireProxy {
    pub async fn start(target_host: String, target_port: u16) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let listen_addr = listener.local_addr()?;
        let state = Arc::new(ProxyState::default());
        let cancellation = CancellationToken::new();
        let task_state = state.clone();
        let task_cancellation = cancellation.clone();
        let task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = task_cancellation.cancelled() => break,
                    accepted = listener.accept() => accepted,
                };
                let Ok((client, _)) = accepted else { break };
                let target_host = target_host.clone();
                let state = task_state.clone();
                let cancellation = task_cancellation.child_token();
                tokio::spawn(async move {
                    let Ok(server) = TcpStream::connect((target_host.as_str(), target_port)).await else {
                        return;
                    };
                    let _ = proxy_connection(client, server, state, cancellation).await;
                });
            }
        });
        Ok(Self { listen_addr, state, cancellation, task: Some(task) })
    }

    pub fn listen_addr(&self) -> SocketAddr {
        self.listen_addr
    }

    pub async fn set_contention_marker(&self, marker: impl Into<String>) {
        *self.state.contention_marker.lock().await = Some(marker.into());
        self.state.contention_forwarded.store(false, Ordering::SeqCst);
        self.state.contention_response_pending.store(false, Ordering::SeqCst);
    }

    pub fn contention_forwarded_and_pending(&self) -> bool {
        self.state.contention_forwarded.load(Ordering::SeqCst)
            && self.state.contention_response_pending.load(Ordering::SeqCst)
    }

    pub async fn arm_drop_commit_ack(&self) {
        *self.state.fault.lock().await = FaultDirective::DropCommitAck;
        self.state.commit_tracking.store(true, Ordering::SeqCst);
        self.state.commit_forward_count.store(0, Ordering::SeqCst);
        self.state.commit_ok_observed.store(false, Ordering::SeqCst);
        self.state.commit_ack_dropped.store(false, Ordering::SeqCst);
    }

    pub fn commit_forward_count(&self) -> usize {
        self.state.commit_forward_count.load(Ordering::SeqCst)
    }

    pub fn commit_ok_observed(&self) -> bool {
        self.state.commit_ok_observed.load(Ordering::SeqCst)
    }

    pub fn commit_ack_dropped(&self) -> bool {
        self.state.commit_ack_dropped.load(Ordering::SeqCst)
    }

    pub async fn arm_drop_query_response(&self, marker: impl Into<String>) {
        *self.state.fault.lock().await = FaultDirective::DropQueryResponse { marker: marker.into() };
        self.state.dropped_query_forwarded.store(false, Ordering::SeqCst);
    }

    pub fn dropped_query_forwarded(&self) -> bool {
        self.state.dropped_query_forwarded.load(Ordering::SeqCst)
    }

    pub async fn shutdown(mut self) {
        self.cancellation.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for MysqlWireProxy {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn proxy_connection(
    client: TcpStream,
    server: TcpStream,
    state: Arc<ProxyState>,
    cancellation: CancellationToken,
) -> io::Result<()> {
    let (mut client_reader, mut client_writer) = client.into_split();
    let (mut server_reader, mut server_writer) = server.into_split();
    let pending = Arc::new(Mutex::new(None::<PendingResponse>));
    let client_pending = pending.clone();
    let client_state = state.clone();
    let client_cancellation = cancellation.clone();
    let upstream = async move {
        loop {
            let packet = tokio::select! {
                _ = client_cancellation.cancelled() => break,
                packet = read_mysql_packet(&mut client_reader) => packet?,
            };
            let Some(packet) = packet else { break };
            let sql = mysql_query_sql(&packet);
            let contention = if let Some(sql) = sql {
                client_state.contention_marker.lock().await.as_deref().is_some_and(|marker| sql.contains(marker))
            } else {
                false
            };
            if contention {
                client_state.contention_forwarded.store(true, Ordering::SeqCst);
                client_state.contention_response_pending.store(true, Ordering::SeqCst);
                *client_pending.lock().await = Some(PendingResponse::Contention);
            }

            let mut drop_after_forward = false;
            if let Some(sql) = sql {
                if sql.trim().eq_ignore_ascii_case("COMMIT") && client_state.commit_tracking.load(Ordering::SeqCst) {
                    client_state.commit_forward_count.fetch_add(1, Ordering::SeqCst);
                }
                let mut fault = client_state.fault.lock().await;
                match &*fault {
                    FaultDirective::DropCommitAck if sql.trim().eq_ignore_ascii_case("COMMIT") => {
                        *client_pending.lock().await = Some(PendingResponse::DropCommitAck);
                        *fault = FaultDirective::None;
                    }
                    FaultDirective::DropQueryResponse { marker } if sql.contains(marker) => {
                        client_state.dropped_query_forwarded.store(true, Ordering::SeqCst);
                        drop_after_forward = true;
                        *fault = FaultDirective::None;
                    }
                    _ => {}
                }
            }
            server_writer.write_all(&packet).await?;
            if drop_after_forward {
                client_cancellation.cancel();
                break;
            }
        }
        io::Result::Ok(())
    };

    let downstream_state = state;
    let downstream_cancellation = cancellation.clone();
    let downstream = async move {
        loop {
            let packet = tokio::select! {
                _ = downstream_cancellation.cancelled() => break,
                packet = read_mysql_packet(&mut server_reader) => packet?,
            };
            let Some(packet) = packet else { break };
            match pending.lock().await.take() {
                Some(PendingResponse::Contention) => {
                    downstream_state.contention_response_pending.store(false, Ordering::SeqCst);
                }
                Some(PendingResponse::DropCommitAck) if packet.get(4) == Some(&0x00) => {
                    downstream_state.commit_ok_observed.store(true, Ordering::SeqCst);
                    downstream_state.commit_ack_dropped.store(true, Ordering::SeqCst);
                    downstream_cancellation.cancel();
                    break;
                }
                Some(PendingResponse::DropCommitAck) | None => {}
            }
            client_writer.write_all(&packet).await?;
        }
        io::Result::Ok(())
    };

    let (upstream, downstream) = tokio::join!(upstream, downstream);
    upstream?;
    downstream?;
    Ok(())
}

pub async fn read_mysql_packet(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0_u8; 4];
    match reader.read(&mut header[..1]).await? {
        0 => return Ok(None),
        1 => {
            reader.read_exact(&mut header[1..]).await?;
        }
        _ => unreachable!("one-byte read returned more than one byte"),
    }
    let payload_len = usize::from(header[0]) | (usize::from(header[1]) << 8) | (usize::from(header[2]) << 16);
    let mut packet = Vec::with_capacity(4 + payload_len);
    packet.extend_from_slice(&header);
    packet.resize(4 + payload_len, 0);
    reader.read_exact(&mut packet[4..]).await?;
    Ok(Some(packet))
}

pub fn mysql_query_sql(packet: &[u8]) -> Option<&str> {
    let header: [u8; 4] = packet.get(..4)?.try_into().ok()?;
    let payload_len = usize::from(header[0]) | (usize::from(header[1]) << 8) | (usize::from(header[2]) << 16);
    if packet.len() != 4 + payload_len || packet.get(4) != Some(&0x03) {
        return None;
    }
    std::str::from_utf8(packet.get(5..)?).ok()
}

#[cfg(test)]
mod tests {
    use super::{mysql_query_sql, read_mysql_packet, MysqlWireProxy};

    fn packet(sequence: u8, payload: &[u8]) -> Vec<u8> {
        let length = payload.len();
        let mut encoded =
            vec![(length & 0xff) as u8, ((length >> 8) & 0xff) as u8, ((length >> 16) & 0xff) as u8, sequence];
        encoded.extend_from_slice(payload);
        encoded
    }

    #[tokio::test]
    async fn packet_reader_handles_fragmented_headers_and_coalesced_packets() {
        let first = packet(0, &[0x03, b'S', b'E', b'L', b'E', b'C', b'T', b' ', b'1']);
        let second = packet(1, &[0x00, 0x01]);
        let bytes = [first.clone(), second.clone()].concat();
        let (mut writer, mut reader) = tokio::io::duplex(64);
        let sender = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            for byte in bytes {
                writer.write_all(&[byte]).await.unwrap();
            }
        });

        let first_read = read_mysql_packet(&mut reader).await.unwrap().unwrap();
        let second_read = read_mysql_packet(&mut reader).await.unwrap().unwrap();
        assert_eq!(first_read, first);
        assert_eq!(second_read, second);
        assert!(read_mysql_packet(&mut reader).await.unwrap().is_none());
        sender.await.unwrap();
    }

    #[test]
    fn query_decoder_accepts_only_complete_com_query_payloads() {
        assert_eq!(mysql_query_sql(&packet(0, b"\x03COMMIT")), Some("COMMIT"));
        assert_eq!(mysql_query_sql(&packet(0, b"\x03SELECT 1")), Some("SELECT 1"));
        assert_eq!(mysql_query_sql(&packet(0, b"\x01COMMIT")), None);
        assert_eq!(mysql_query_sql(&[7, 0, 0, 0, 0x03, b'C']), None);
    }

    #[tokio::test]
    async fn proxy_forwards_commit_observes_ok_and_drops_only_the_downstream_ack() {
        use tokio::io::AsyncWriteExt;

        let upstream_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let upstream_address = upstream_listener.local_addr().unwrap();
        let proxy = MysqlWireProxy::start(upstream_address.ip().to_string(), upstream_address.port()).await.unwrap();
        proxy.arm_drop_commit_ack().await;
        let upstream = tokio::spawn(async move {
            let (mut socket, _) = upstream_listener.accept().await.unwrap();
            assert_eq!(read_mysql_packet(&mut socket).await.unwrap().unwrap(), packet(0, b"\x03COMMIT"));
            socket.write_all(&packet(1, &[0x00, 0x00, 0x00])).await.unwrap();
        });

        let mut client = tokio::net::TcpStream::connect(proxy.listen_addr()).await.unwrap();
        client.write_all(&packet(0, b"\x03COMMIT")).await.unwrap();
        assert!(read_mysql_packet(&mut client).await.unwrap().is_none());
        upstream.await.unwrap();
        assert_eq!(proxy.commit_forward_count(), 1);
        assert!(proxy.commit_ok_observed());
        assert!(proxy.commit_ack_dropped());
        proxy.shutdown().await;
    }

    #[tokio::test]
    async fn commit_counter_tracks_every_forward_after_the_fault_is_consumed() {
        use tokio::io::AsyncWriteExt;

        let upstream_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let upstream_address = upstream_listener.local_addr().unwrap();
        let proxy = MysqlWireProxy::start(upstream_address.ip().to_string(), upstream_address.port()).await.unwrap();
        proxy.arm_drop_commit_ack().await;
        let upstream = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = upstream_listener.accept().await.unwrap();
                assert_eq!(read_mysql_packet(&mut socket).await.unwrap().unwrap(), packet(0, b"\x03COMMIT"));
                socket.write_all(&packet(1, &[0x00, 0x00, 0x00])).await.unwrap();
            }
        });

        let mut first = tokio::net::TcpStream::connect(proxy.listen_addr()).await.unwrap();
        first.write_all(&packet(0, b"\x03COMMIT")).await.unwrap();
        assert!(read_mysql_packet(&mut first).await.unwrap().is_none());

        let mut second = tokio::net::TcpStream::connect(proxy.listen_addr()).await.unwrap();
        second.write_all(&packet(0, b"\x03COMMIT")).await.unwrap();
        assert!(read_mysql_packet(&mut second).await.unwrap().is_some());

        upstream.await.unwrap();
        assert_eq!(proxy.commit_forward_count(), 2);
        proxy.shutdown().await;
    }

    #[tokio::test]
    async fn dropping_proxy_releases_its_listener() {
        let upstream_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let upstream_address = upstream_listener.local_addr().unwrap();
        let proxy = MysqlWireProxy::start(upstream_address.ip().to_string(), upstream_address.port()).await.unwrap();
        let proxy_address = proxy.listen_addr();

        drop(proxy);

        let rebound = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                match tokio::net::TcpListener::bind(proxy_address).await {
                    Ok(listener) => break listener,
                    Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => tokio::task::yield_now().await,
                    Err(error) => panic!("unexpected listener rebind error: {error}"),
                }
            }
        })
        .await;

        assert!(rebound.is_ok(), "dropping the proxy must release its listener");
    }
}
