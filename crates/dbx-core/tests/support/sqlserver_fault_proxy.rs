//! TCP fault injector: forwards real TDS/TCP bytes (including TLS ciphertext), never SQL mocks.
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;
#[derive(Default)]
pub struct Stats {
    pub armed: AtomicBool,
    pub dropped_responses: AtomicUsize,
    pub request_bytes_after_arm: AtomicUsize,
    pub connections: AtomicUsize,
    pub close_failures: AtomicUsize,
    pub close_entered: AtomicUsize,
    pub closed_connections: AtomicUsize,
    pub cut: CancellationToken,
    shutdown: CancellationToken,
}
pub struct FaultProxy {
    pub port: u16,
    pub control_port: u16,
    pub stats: Arc<Stats>,
}
impl FaultProxy {
    pub async fn start(host: &str, port: u16) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let control = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy = Self {
            port: listener.local_addr().unwrap().port(),
            control_port: control.local_addr().unwrap().port(),
            stats: Arc::default(),
        };
        let stats = proxy.stats.clone();
        let host = host.to_owned();
        tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    _ = stats.shutdown.cancelled() => break,
                    accepted = listener.accept() => {
                        let (client, _) = accepted.unwrap();
                        stats.connections.fetch_add(1, Ordering::SeqCst);
                        let stats = stats.clone(); let host = host.clone();
                        tasks.spawn(async move { relay(client, &host, port, stats).await });
                    }
                    Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
                }
            }
        });
        let stats = proxy.stats.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stats.shutdown.cancelled() => break,
                    accepted = control.accept() => {
                        let Ok((mut socket, _)) = accepted else { break; };
                        let read = async {
                            let mut command = Vec::new();
                            loop {
                                let ch = socket.read_u8().await?;
                                if ch == b'\n' { return Ok::<_, std::io::Error>(command); }
                                command.push(ch);
                                if command.len() >= 64 { return Err(std::io::ErrorKind::InvalidData.into()); }
                            }
                        };
                        let command = tokio::select! {
                            _ = stats.shutdown.cancelled() => break,
                            result = tokio::time::timeout(std::time::Duration::from_secs(3), read) => {
                                match result { Ok(Ok(command)) => command, _ => continue }
                            }
                        };
                        match command.as_slice() {
                            b"ARM" => stats.armed.store(true, Ordering::SeqCst),
                            b"CLOSE_ENTERED" => { stats.close_entered.fetch_add(1, Ordering::SeqCst); },
                            b"CLOSE_FAILED" => { stats.close_failures.fetch_add(1, Ordering::SeqCst); },
                            _ => panic!("unknown fault command"),
                        }
                        let _ = socket.write_all(b"K").await;
                    }
                }
            }
        });
        proxy
    }
}
impl Drop for FaultProxy {
    fn drop(&mut self) {
        self.stats.shutdown.cancel();
        self.stats.cut.cancel();
    }
}
async fn relay(client: TcpStream, host: &str, port: u16, stats: Arc<Stats>) {
    let server = TcpStream::connect((host, port)).await.unwrap();
    let (mut client_read, mut client_write) = client.into_split();
    let (mut server_read, mut server_write) = server.into_split();
    let send = async {
        let mut buffer = [0u8; 8192];
        loop {
            let size = client_read.read(&mut buffer).await?;
            if size == 0 {
                return server_write.shutdown().await;
            }
            let armed = stats.armed.load(Ordering::SeqCst);
            server_write.write_all(&buffer[..size]).await?;
            if armed {
                stats.request_bytes_after_arm.fetch_add(size, Ordering::SeqCst);
            }
        }
    };
    let receive = async {
        let mut buffer = [0u8; 8192];
        loop {
            let size = server_read.read(&mut buffer).await?;
            if size == 0 {
                return client_write.shutdown().await;
            }
            if stats.armed.load(Ordering::SeqCst) {
                stats.dropped_responses.fetch_add(1, Ordering::SeqCst);
                stats.cut.cancel();
                return Ok::<(), std::io::Error>(());
            }
            client_write.write_all(&buffer[..size]).await?;
        }
    };
    tokio::select! {
        _ = stats.cut.cancelled() => {},
        _ = stats.shutdown.cancelled() => {},
        _ = async { let _ = tokio::try_join!(send, receive); } => {},
    }
    drop(client_read);
    drop(client_write);
    drop(server_read);
    drop(server_write);
    stats.closed_connections.fetch_add(1, Ordering::SeqCst);
}
