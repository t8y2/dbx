//! Opt-in regression against an isolated MySQL server with autocommit=0:
//! DBX_NAVICAT_MYSQL_SOCKET=/tmp/.../mysql.sock cargo test -p dbx-driver-support
//! --test navicat_mysql_persistence -- --ignored
//! Each mock PHP request opens a fresh real MySQL session via the mysql CLI.
use base64::Engine;
use dbx_driver_support::navicat_mysql_tunnel::{serve, NavicatMysqlEndpoint};
use std::process::Command;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn mysql(socket: &str, sql: &str) -> String {
    let output = Command::new(std::env::var("DBX_NAVICAT_MYSQL_BIN").unwrap_or_else(|_| "mysql".into()))
        .args([
            "--no-defaults",
            "--protocol=SOCKET",
            "--socket",
            socket,
            "--user=root",
            "--batch",
            "--raw",
            "--skip-column-names",
            "--execute",
            sql,
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

async fn read_packet(stream: &mut TcpStream) -> Vec<u8> {
    let mut header = [0; 4];
    stream.read_exact(&mut header).await.unwrap();
    let length = header[0] as usize | (header[1] as usize) << 8 | (header[2] as usize) << 16;
    let mut packet = vec![0; length];
    stream.read_exact(&mut packet).await.unwrap();
    packet
}

async fn write_packet(stream: &mut TcpStream, sequence: u8, packet: &[u8]) {
    let length = packet.len();
    stream.write_all(&[length as u8, (length >> 8) as u8, (length >> 16) as u8, sequence]).await.unwrap();
    stream.write_all(packet).await.unwrap();
}

async fn connect_bridge(address: std::net::SocketAddr) -> TcpStream {
    let mut client = TcpStream::connect(address).await.unwrap();
    read_packet(&mut client).await;
    let mut handshake = [0; 32];
    handshake[..4].copy_from_slice(&0x200u32.to_le_bytes());
    write_packet(&mut client, 1, &handshake).await;
    assert_eq!(read_packet(&mut client).await[0], 0);
    client
}

async fn query_ok(client: &mut TcpStream, sql: &str) {
    let mut payload = vec![3];
    payload.extend_from_slice(sql.as_bytes());
    write_packet(client, 0, &payload).await;
    let response = read_packet(client).await;
    assert_eq!(response[0], 0, "{sql}: {response:?}");
}

fn block(bytes: &[u8], output: &mut Vec<u8>) {
    assert!(bytes.len() < 254);
    output.push(bytes.len() as u8);
    output.extend_from_slice(bytes);
}

async fn php_request(mut stream: TcpStream, socket: String) {
    let mut request = Vec::new();
    let mut buffer = [0; 4096];
    let body = loop {
        let count = stream.read(&mut buffer).await.unwrap();
        assert!(count > 0);
        request.extend_from_slice(&buffer[..count]);
        if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&request[..end]);
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            if request.len() >= end + 4 + length {
                break String::from_utf8(request[end + 4..end + 4 + length].to_vec()).unwrap();
            }
        }
    };
    let url = reqwest::Url::parse(&format!("http://localhost/?{body}")).unwrap();
    let queries = url
        .query_pairs()
        .filter(|(key, _)| key == "q[]")
        .map(|(_, value)| {
            String::from_utf8(base64::engine::general_purpose::STANDARD.decode(value.as_bytes()).unwrap()).unwrap()
        })
        .collect::<Vec<_>>();
    // One process/connection for the entire request, never reused for another
    // HTTP request. ROW_COUNT/CONNECTION_ID are read in that same session.
    let sql = format!("{}; SELECT ROW_COUNT(); SELECT CONNECTION_ID()", queries.join("; "));
    let output = mysql(&socket, &sql);
    let lines = output.lines().collect::<Vec<_>>();
    let affected: u32 = lines[lines.len() - 2].parse().unwrap();
    let connection_id: u32 = lines[lines.len() - 1].parse().unwrap();
    let mut response = vec![0, 0, 4, 87, 0, 206, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (index, _) in queries.iter().enumerate() {
        let mut header = [0; 32];
        if index + 1 == queries.len() {
            header[4..8].copy_from_slice(&affected.to_be_bytes());
        }
        response.extend_from_slice(&header);
        block(b"", &mut response);
        response.push(u8::from(index + 1 != queries.len()));
    }
    let headers = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nX-Test-MySQL-Connection: {connection_id}\r\nConnection: close\r\n\r\n", response.len());
    stream.write_all(headers.as_bytes()).await.unwrap();
    stream.write_all(&response).await.unwrap();
}

#[tokio::test]
#[ignore = "requires an isolated MySQL server with global autocommit=0 and the mysql CLI"]
async fn stateless_requests_persist_insert_and_update_with_autocommit_off() {
    let socket = std::env::var("DBX_NAVICAT_MYSQL_SOCKET").expect("set isolated MySQL socket");
    assert_eq!(mysql(&socket, "SELECT @@GLOBAL.autocommit"), "0");
    let database = format!("dbx_navicat_{}", uuid::Uuid::new_v4().simple());
    mysql(&socket, &format!("CREATE DATABASE `{database}`; CREATE TABLE `{database}`.items (id INT PRIMARY KEY, value INT) ENGINE=InnoDB"));
    // Establish that this mock catches the original rollback failure.
    mysql(&socket, &format!("INSERT INTO `{database}`.items VALUES (99, 99)"));
    assert_eq!(mysql(&socket, &format!("SELECT COUNT(*) FROM `{database}`.items")), "0");

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/ntunnel_mysql.php", listener.local_addr().unwrap());
    let server_socket = socket.clone();
    let http = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let socket = server_socket.clone();
            tokio::spawn(php_request(stream, socket));
        }
    });
    let endpoint = NavicatMysqlEndpoint::new(&url, "localhost", 3306, "", "", None, 10).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let bridge = tokio::spawn(serve(listener, endpoint));
    let mut first = connect_bridge(address).await;
    query_ok(&mut first, "SET SESSION autocommit = 1").await;
    query_ok(&mut first, &format!("INSERT INTO `{database}`.items VALUES (1, 10)")).await;
    assert_eq!(mysql(&socket, &format!("SELECT value FROM `{database}`.items WHERE id=1")), "10");
    // A second bridge client and another HTTP request cannot inherit setup.
    let mut second = connect_bridge(address).await;
    query_ok(&mut second, &format!("UPDATE `{database}`.items SET value=20 WHERE id=1")).await;
    assert_eq!(mysql(&socket, &format!("SELECT value FROM `{database}`.items WHERE id=1")), "20");
    assert_eq!(mysql(&socket, "SELECT @@GLOBAL.autocommit"), "0");
    bridge.abort();
    http.abort();
    mysql(&socket, &format!("DROP DATABASE `{database}`"));
}
