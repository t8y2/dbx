use base64::Engine;
use reqwest::{Client, Url};
use sqlparser::dialect::MySqlDialect;
use sqlparser::tokenizer::{Token, Tokenizer, Whitespace};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;
use tokio::time::{timeout, Duration};

const CLIENT_PROTOCOL_41: u32 = 0x0000_0200;
const CLIENT_SECURE_CONNECTION: u32 = 0x0000_8000;
const CLIENT_PLUGIN_AUTH: u32 = 0x0008_0000;
const SERVER_CAPABILITIES: u32 = CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH;
const MAX_PACKET_SIZE: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct NavicatMysqlEndpoint {
    url: Url,
    host: String,
    port: u16,
    username: String,
    password: String,
    database: String,
    request_timeout: Duration,
    client: Client,
}

impl NavicatMysqlEndpoint {
    pub fn new(
        url: &str,
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        database: Option<&str>,
        request_timeout_secs: u64,
    ) -> Result<Self, String> {
        let url = Url::parse(url.trim()).map_err(|error| format!("Invalid Navicat tunnel URL: {error}"))?;
        match url.scheme() {
            "https" => {}
            "http" => log::warn!(
                "[navicat-http] using unencrypted HTTP tunnel; database credentials and SQL are exposed in transit"
            ),
            other => return Err(format!("Unsupported Navicat tunnel URL scheme: {other}")),
        }
        if !url.path().to_ascii_lowercase().ends_with(".php") {
            return Err(
                "Navicat tunnel URL must point to the PHP tunnel script, for example https://example.com/ntunnel_mysql.php"
                    .to_string(),
            );
        }
        if host.trim().is_empty() || port == 0 {
            return Err("Navicat tunnel requires a MySQL target host and port".to_string());
        }
        if username.is_empty() {
            return Err("Navicat tunnel requires a MySQL username".to_string());
        }
        Ok(Self {
            url,
            host: host.to_string(),
            port,
            username: username.to_string(),
            password: password.to_string(),
            database: database.unwrap_or_default().to_string(),
            request_timeout: Duration::from_secs(request_timeout_secs.clamp(1, 300)),
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| format!("Failed to create Navicat HTTP client: {error}"))?,
        })
    }

    async fn query(&self, database: &str, sql: &str) -> Result<Vec<u8>, String> {
        let started = std::time::Instant::now();
        let encoded_query = base64::engine::general_purpose::STANDARD.encode(sql.as_bytes());
        let fields = [
            ("actn", "Q".to_string()),
            ("host", self.host.clone()),
            ("port", self.port.to_string()),
            ("login", self.username.clone()),
            ("password", self.password.clone()),
            ("db", database.to_string()),
            ("encodeBase64", "1".to_string()),
            ("q[]", encoded_query),
        ];
        log::debug!(
            "[navicat-http] POST tunnel request target={}:{} db={} sql_bytes={} timeout_secs={}",
            self.host,
            self.port,
            if database.is_empty() { "<none>" } else { "<set>" },
            sql.len(),
            self.request_timeout.as_secs()
        );
        let (status, response_url, content_type, body) = timeout(self.request_timeout, async {
            let response = self.client.post(self.url.clone()).form(&fields).send().await?;
            let status = response.status();
            let mut response_url = response.url().clone();
            let _ = response_url.set_username("");
            let _ = response_url.set_password(None);
            response_url.set_query(None);
            response_url.set_fragment(None);
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let body = response.bytes().await?;
            Ok::<_, reqwest::Error>((status, response_url, content_type, body))
        })
        .await
        .map_err(|_| {
            log::warn!(
                "[navicat-http] request timed out after {:?} target={}:{}",
                started.elapsed(),
                self.host,
                self.port
            );
            "Navicat HTTP tunnel request timed out".to_string()
        })?
        .map_err(|error| {
            log::warn!(
                "[navicat-http] request transport error after {:?} target={}:{}: {error}",
                started.elapsed(),
                self.host,
                self.port
            );
            format!("Navicat HTTP tunnel request failed: {error}")
        })?;
        log::debug!(
            "[navicat-http] response status={} content_type={:?} final_url={} bytes={} elapsed={:?}",
            status,
            content_type,
            response_url,
            body.len(),
            started.elapsed()
        );
        if !status.is_success() {
            let text = String::from_utf8_lossy(&body);
            return Err(format!("Navicat HTTP tunnel returned HTTP {status}: {}", text.trim()));
        }
        if body.len() < 16
            || u32::from_be_bytes(body[0..4].try_into().unwrap()) != 1111
            || u16::from_be_bytes(body[4..6].try_into().unwrap()) != 204
        {
            let header_bytes = body.iter().take(16).map(|byte| format!("{byte:02x}")).collect::<Vec<_>>().join(" ");
            let preview = String::from_utf8_lossy(body.get(..body.len().min(120)).unwrap_or_default())
                .chars()
                .map(|ch| if ch.is_control() { ' ' } else { ch })
                .collect::<String>();
            let message = format!(
                "Invalid Navicat HTTP tunnel response: HTTP {status}, content-type={}, final_url={}, bytes={}, header=[{}], preview={:?}",
                content_type.as_deref().unwrap_or("<missing>"),
                response_url,
                body.len(),
                header_bytes,
                preview.trim()
            );
            log::warn!("[navicat-http] {message}");
            return Err(message);
        }
        Ok(body.to_vec())
    }
}

pub async fn serve(listener: TcpListener, endpoint: NavicatMysqlEndpoint) {
    let endpoint = Arc::new(endpoint);
    let mut clients = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let peer = stream.peer_addr().ok();
                    let endpoint = endpoint.clone();
                    clients.spawn(async move {
                        let mut stream = stream;
                        if let Err(error) = serve_client(&mut stream, endpoint).await {
                            log::warn!("[navicat-mysql] local client session failed peer={peer:?}: {error}");
                            let _ = send_mysql_error(&mut stream, 1, 1105, &error).await;
                        }
                    });
                }
                Err(_) => break,
            },
            _ = clients.join_next(), if !clients.is_empty() => {}
        }
    }
}

async fn serve_client(stream: &mut TcpStream, endpoint: Arc<NavicatMysqlEndpoint>) -> Result<(), String> {
    let peer = stream.peer_addr().ok();
    let seed_a = uuid::Uuid::new_v4();
    let seed_b = uuid::Uuid::new_v4();
    let mut auth_seed = [0; 20];
    auth_seed[..16].copy_from_slice(seed_a.as_bytes());
    auth_seed[16..].copy_from_slice(&seed_b.as_bytes()[..4]);
    let greeting = mysql_handshake_greeting(&auth_seed);
    write_packet(stream, 0, &greeting).await?;
    log::debug!("[navicat-mysql] sent protocol greeting peer={peer:?} bytes={}", greeting.len());

    let (sequence, handshake) = read_packet(stream).await.map_err(|error| {
        log::warn!("[navicat-mysql] failed waiting for client handshake peer={peer:?}: {error}");
        error
    })?;
    log::debug!(
        "[navicat-mysql] received client handshake peer={peer:?} sequence={sequence} bytes={} capabilities=0x{:08x}",
        handshake.len(),
        handshake.get(..4).and_then(|bytes| <[u8; 4]>::try_from(bytes).ok()).map(u32::from_le_bytes).unwrap_or(0)
    );
    if handshake.len() < 32 {
        return Err("Invalid MySQL handshake response".to_string());
    }
    let client_capabilities = u32::from_le_bytes(handshake[0..4].try_into().unwrap());
    if client_capabilities & CLIENT_PROTOCOL_41 == 0 {
        return send_mysql_error(stream, sequence.wrapping_add(1), 1043, "MySQL protocol 4.1 is required").await;
    }
    write_packet(stream, sequence.wrapping_add(1), &mysql_ok_packet(0, 0, "")).await?;
    log::debug!("[navicat-mysql] authenticated local client peer={peer:?}");

    let mut database = endpoint.database.clone();
    loop {
        let (sequence, packet) = match read_packet(stream).await {
            Ok(packet) => packet,
            Err(error) if error == "MySQL client disconnected" => return Ok(()),
            Err(error) => {
                log::warn!("[navicat-mysql] failed reading client command peer={peer:?}: {error}");
                return Err(error);
            }
        };
        let Some((&command, payload)) = packet.split_first() else {
            continue;
        };
        log::debug!("[navicat-mysql] received command peer={peer:?} command=0x{command:02x} sequence={sequence} payload_bytes={}", payload.len());
        match command {
            0x01 => return Ok(()),
            0x0e => write_packet(stream, sequence.wrapping_add(1), &mysql_ok_packet(0, 0, "")).await?,
            0x02 => {
                database = String::from_utf8_lossy(payload).to_string();
                write_packet(stream, sequence.wrapping_add(1), &mysql_ok_packet(0, 0, "")).await?;
            }
            0x03 => {
                let sql = String::from_utf8_lossy(payload).to_string();
                if let Err(error) = validate_stateless_query(&sql) {
                    send_mysql_error(stream, sequence.wrapping_add(1), 1235, &error).await?;
                    continue;
                }
                if let Some(next_database) = parse_use_database(&sql) {
                    database = next_database;
                    write_packet(stream, sequence.wrapping_add(1), &mysql_ok_packet(0, 0, "")).await?;
                    continue;
                }
                match endpoint.query(&database, &sql).await.and_then(|body| parse_navicat_response(&body)) {
                    Ok(result) => write_query_result(stream, result).await?,
                    Err(error) => send_mysql_error(stream, sequence.wrapping_add(1), 1105, &error).await?,
                }
            }
            0x16 => {
                send_mysql_error(
                    stream,
                    sequence.wrapping_add(1),
                    1295,
                    "Prepared statements are not supported by Navicat HTTP tunnels",
                )
                .await?
            }
            _ => {
                send_mysql_error(stream, sequence.wrapping_add(1), 1047, "Unsupported command for Navicat HTTP tunnel")
                    .await?
            }
        }
    }
}

fn validate_stateless_query(sql: &str) -> Result<(), String> {
    let mut tokens = Vec::new();
    stateless_query_tokens(sql, &mut tokens)?;
    for statement in tokens.split(|token| *token == Token::SemiColon) {
        let word_is = |token: Option<&Token>, expected: &str| matches!(token, Some(Token::Word(word)) if word.value.eq_ignore_ascii_case(expected));
        let first = statement.first();
        let transaction =
            ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "XA"].iter().any(|keyword| word_is(first, keyword))
                || (word_is(first, "START") && word_is(statement.get(1), "TRANSACTION"))
                || (word_is(first, "RELEASE") && word_is(statement.get(1), "SAVEPOINT"))
                || (word_is(first, "SET")
                    && statement.iter().any(|token| {
                        word_is(Some(token), "AUTOCOMMIT")
                            || word_is(Some(token), "@@AUTOCOMMIT")
                            || word_is(Some(token), "TRANSACTION")
                    }));
        if transaction {
            return Err(
                "Transactions and autocommit settings are not supported by Navicat HTTP tunnels: each request uses a separate MySQL session"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn stateless_query_tokens(sql: &str, output: &mut Vec<Token>) -> Result<(), String> {
    for token in Tokenizer::new(&MySqlDialect {}, sql)
        .tokenize()
        .map_err(|error| format!("Cannot validate Navicat HTTP tunnel query: {error}"))?
    {
        match token {
            Token::Whitespace(Whitespace::MultiLineComment(comment)) => {
                // MySQL executes versioned comments; inspect their SQL as well.
                if let Some(body) = comment.strip_prefix('!').or_else(|| comment.strip_prefix("M!")) {
                    stateless_query_tokens(body.trim_start_matches(|ch: char| ch.is_ascii_digit()), output)?;
                }
            }
            Token::Whitespace(_) | Token::EOF => {}
            token => output.push(token),
        }
    }
    Ok(())
}

fn mysql_handshake_greeting(auth_seed: &[u8; 20]) -> Vec<u8> {
    let mut greeting = vec![10];
    greeting.extend_from_slice(b"8.0.0-dbx-navicat\0");
    // MySQL's handshake places a 4-byte connection id before the first
    // eight bytes of the authentication seed.  Omitting it shifts every
    // following field and makes clients wait for a handshake that never
    // arrives.
    greeting.extend_from_slice(&1u32.to_le_bytes());
    greeting.extend_from_slice(&auth_seed[..8]);
    greeting.push(0); // auth-plugin-data-part-1 terminator
    greeting.extend_from_slice(&(SERVER_CAPABILITIES as u16).to_le_bytes());
    greeting.push(45);
    greeting.extend_from_slice(&2u16.to_le_bytes());
    greeting.extend_from_slice(&((SERVER_CAPABILITIES >> 16) as u16).to_le_bytes());
    greeting.push(21);
    greeting.extend_from_slice(&[0; 10]);
    greeting.extend_from_slice(&auth_seed[8..]);
    greeting.push(0);
    greeting.extend_from_slice(b"mysql_native_password\0");
    greeting
}

#[derive(Debug, PartialEq, Eq)]
struct NavicatResult {
    affected_rows: u64,
    last_insert_id: u64,
    columns: Vec<NavicatColumn>,
    rows: Vec<Vec<Option<Vec<u8>>>>,
    info: String,
}

#[derive(Debug, PartialEq, Eq)]
struct NavicatColumn {
    name: Vec<u8>,
    table: Vec<u8>,
    column_type: u8,
    flags: u32,
    length: u32,
}

fn parse_navicat_response(data: &[u8]) -> Result<NavicatResult, String> {
    if data.len() < 16 || u32::from_be_bytes(data[0..4].try_into().unwrap()) != 1111 {
        return Err("Invalid Navicat HTTP tunnel response header".to_string());
    }
    if u16::from_be_bytes(data[4..6].try_into().unwrap()) != 204 {
        return Err("Unsupported Navicat HTTP tunnel response version".to_string());
    }
    let connect_error = u32::from_be_bytes(data[6..10].try_into().unwrap());
    let mut cursor = 16;
    if connect_error != 0 {
        let message = read_navicat_block(data, &mut cursor)?;
        return Err(format!("MySQL connection error {connect_error}: {}", String::from_utf8_lossy(&message)));
    }
    let mut result = NavicatResult {
        affected_rows: 0,
        last_insert_id: 0,
        columns: Vec::new(),
        rows: Vec::new(),
        info: String::new(),
    };
    if cursor == data.len() {
        return Ok(result);
    }
    // Navicat's result-set header has five 4-byte integers followed by
    // twelve reserved bytes: 32 bytes total.
    if data.len() - cursor < 32 {
        return Err("Truncated Navicat query result header".to_string());
    }
    let query_error = u32::from_be_bytes(data[cursor..cursor + 4].try_into().unwrap());
    result.affected_rows = u32::from_be_bytes(data[cursor + 4..cursor + 8].try_into().unwrap()) as u64;
    result.last_insert_id = u32::from_be_bytes(data[cursor + 8..cursor + 12].try_into().unwrap()) as u64;
    let column_count = u32::from_be_bytes(data[cursor + 12..cursor + 16].try_into().unwrap()) as usize;
    let row_count = u32::from_be_bytes(data[cursor + 16..cursor + 20].try_into().unwrap()) as usize;
    cursor += 32;
    if query_error != 0 {
        let message = read_navicat_block(data, &mut cursor)?;
        return Err(format!("MySQL query error {query_error}: {}", String::from_utf8_lossy(&message)));
    }
    for _ in 0..column_count {
        let name = read_navicat_block(data, &mut cursor)?;
        let table = read_navicat_block(data, &mut cursor)?;
        let column_type = read_u32_be(data, &mut cursor)? as u8;
        let flags = read_u32_be(data, &mut cursor)?;
        let length = read_u32_be(data, &mut cursor)?;
        result.columns.push(NavicatColumn { name, table, column_type, flags, length });
    }
    for _ in 0..row_count {
        let mut row = Vec::with_capacity(column_count);
        for _ in 0..column_count {
            if data.get(cursor) == Some(&0xff) {
                cursor += 1;
                row.push(None);
            } else {
                row.push(Some(read_navicat_block(data, &mut cursor)?));
            }
        }
        result.rows.push(row);
    }
    if result.columns.is_empty() {
        result.info = String::from_utf8_lossy(&read_navicat_block(data, &mut cursor)?).to_string();
    }
    if data.get(cursor) != Some(&0) || cursor + 1 != data.len() {
        return Err("Invalid or missing Navicat result terminator".to_string());
    }
    Ok(result)
}

fn read_navicat_block(data: &[u8], cursor: &mut usize) -> Result<Vec<u8>, String> {
    let marker = *data.get(*cursor).ok_or("Truncated Navicat value")?;
    *cursor += 1;
    let length = match marker {
        0..=253 => marker as usize,
        254 => read_u32_be(data, cursor)? as usize,
        255 => return Err("Unexpected NULL marker in Navicat value".to_string()),
    };
    let end = cursor.checked_add(length).ok_or("Navicat value length overflow")?;
    let value = data.get(*cursor..end).ok_or("Truncated Navicat value")?.to_vec();
    *cursor = end;
    Ok(value)
}

fn read_u32_be(data: &[u8], cursor: &mut usize) -> Result<u32, String> {
    let end = cursor.checked_add(4).ok_or("Navicat response offset overflow")?;
    let bytes: [u8; 4] = data.get(*cursor..end).ok_or("Truncated Navicat integer")?.try_into().unwrap();
    *cursor = end;
    Ok(u32::from_be_bytes(bytes))
}

fn parse_use_database(sql: &str) -> Option<String> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let rest = trimmed.get(..4)?.eq_ignore_ascii_case("USE ").then(|| trimmed[4..].trim())?;
    let rest = rest.strip_prefix('`').and_then(|value| value.strip_suffix('`')).unwrap_or(rest);
    (!rest.is_empty()).then(|| rest.replace("``", "`"))
}

async fn write_query_result(stream: &mut TcpStream, result: NavicatResult) -> Result<(), String> {
    let mut sequence = 1u8;
    if result.columns.is_empty() {
        write_packet(stream, sequence, &mysql_ok_packet(result.affected_rows, result.last_insert_id, &result.info))
            .await?;
        return Ok(());
    }
    let mut header = Vec::new();
    push_lenenc(&mut header, result.columns.len() as u64);
    write_packet(stream, sequence, &header).await?;
    sequence = sequence.wrapping_add(1);
    for column in &result.columns {
        let definition = mysql_column_packet(column);
        write_packet(stream, sequence, &definition).await?;
        sequence = sequence.wrapping_add(1);
    }
    write_packet(stream, sequence, &[0xfe, 0, 0, 2, 0]).await?;
    sequence = sequence.wrapping_add(1);
    for row in result.rows {
        let mut payload = Vec::new();
        for value in row {
            match value {
                Some(value) => push_lenenc_bytes(&mut payload, &value),
                None => payload.push(0xfb),
            }
        }
        write_packet(stream, sequence, &payload).await?;
        sequence = sequence.wrapping_add(1);
    }
    write_packet(stream, sequence, &[0xfe, 0, 0, 2, 0]).await
}

fn mysql_column_packet(column: &NavicatColumn) -> Vec<u8> {
    let mut packet = Vec::new();
    for value in [
        b"def".as_slice(),
        b"".as_slice(),
        column.table.as_slice(),
        column.table.as_slice(),
        column.name.as_slice(),
        column.name.as_slice(),
    ] {
        push_lenenc_bytes(&mut packet, value);
    }
    packet.push(0x0c);
    packet.extend_from_slice(&45u16.to_le_bytes());
    packet.extend_from_slice(&column.length.to_le_bytes());
    packet.push(column.column_type);
    packet.extend_from_slice(&(column.flags as u16).to_le_bytes());
    packet.push(0);
    packet.extend_from_slice(&[0, 0]);
    packet
}

fn mysql_ok_packet(affected_rows: u64, last_insert_id: u64, info: &str) -> Vec<u8> {
    let mut packet = vec![0];
    push_lenenc(&mut packet, affected_rows);
    push_lenenc(&mut packet, last_insert_id);
    packet.extend_from_slice(&2u16.to_le_bytes());
    packet.extend_from_slice(&0u16.to_le_bytes());
    packet.extend_from_slice(info.as_bytes());
    packet
}

async fn send_mysql_error(stream: &mut TcpStream, sequence: u8, code: u16, message: &str) -> Result<(), String> {
    let mut payload = vec![0xff];
    payload.extend_from_slice(&code.to_le_bytes());
    payload.extend_from_slice(b"#HY000");
    payload.extend_from_slice(message.as_bytes());
    write_packet(stream, sequence, &payload).await
}

async fn read_packet(stream: &mut TcpStream) -> Result<(u8, Vec<u8>), String> {
    let mut header = [0; 4];
    match stream.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Err("MySQL client disconnected".to_string())
        }
        Err(error) => return Err(format!("Failed to read MySQL packet header: {error}")),
    }
    let length = header[0] as usize | ((header[1] as usize) << 8) | ((header[2] as usize) << 16);
    if length > MAX_PACKET_SIZE {
        return Err("MySQL packet exceeds the supported size".to_string());
    }
    let mut payload = vec![0; length];
    stream.read_exact(&mut payload).await.map_err(|error| format!("Failed to read MySQL packet: {error}"))?;
    Ok((header[3], payload))
}

async fn write_packet(stream: &mut TcpStream, sequence: u8, payload: &[u8]) -> Result<(), String> {
    if payload.len() > 0x00ff_ffff {
        return Err("MySQL response packet exceeds 16 MiB".to_string());
    }
    let length = payload.len();
    let header = [length as u8, (length >> 8) as u8, (length >> 16) as u8, sequence];
    stream.write_all(&header).await.map_err(|error| format!("Failed to write MySQL packet header: {error}"))?;
    stream.write_all(payload).await.map_err(|error| format!("Failed to write MySQL packet: {error}"))
}

fn push_lenenc(output: &mut Vec<u8>, value: u64) {
    match value {
        0..=250 => output.push(value as u8),
        251..=0xffff => {
            output.push(0xfc);
            output.extend_from_slice(&(value as u16).to_le_bytes());
        }
        0x1_0000..=0xff_ffff => {
            output.push(0xfd);
            output.extend_from_slice(&(value as u32).to_le_bytes()[..3]);
        }
        _ => {
            output.push(0xfe);
            output.extend_from_slice(&value.to_le_bytes());
        }
    }
}

fn push_lenenc_bytes(output: &mut Vec<u8>, value: &[u8]) {
    push_lenenc(output, value.len() as u64);
    output.extend_from_slice(value);
}

#[cfg(test)]
mod tests {
    use super::{
        parse_navicat_response, parse_use_database, push_lenenc_bytes, read_packet, validate_stateless_query,
        write_packet, NavicatMysqlEndpoint, CLIENT_PROTOCOL_41, CLIENT_SECURE_CONNECTION,
    };
    use tokio::net::{TcpListener, TcpStream};

    #[test]
    fn accepts_http_and_https_tunnel_urls_without_changing_scheme() {
        for scheme in ["http", "https"] {
            let endpoint = NavicatMysqlEndpoint::new(
                &format!("{scheme}://example.test/ntunnel_mysql.php"),
                "127.0.0.1",
                3306,
                "user",
                "password",
                None,
                10,
            )
            .unwrap();

            assert_eq!(endpoint.url.scheme(), scheme);
        }
    }

    #[test]
    fn parses_navicat_query_response() {
        let mut body = Vec::from([0, 0, 4, 87, 0, 204, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        body.extend_from_slice(&[0; 4]);
        body.extend_from_slice(&[0, 0, 0, 1]);
        body.extend_from_slice(&[0; 4]);
        body.extend_from_slice(&[0, 0, 0, 1]);
        body.extend_from_slice(&[0, 0, 0, 1]);
        body.extend_from_slice(&[0; 12]);
        push_lenenc_bytes(&mut body, b"id");
        push_lenenc_bytes(&mut body, b"users");
        body.extend_from_slice(&3u32.to_be_bytes());
        body.extend_from_slice(&2u32.to_be_bytes());
        body.extend_from_slice(&11u32.to_be_bytes());
        push_lenenc_bytes(&mut body, b"42");
        body.push(0);

        let result = parse_navicat_response(&body).unwrap();
        assert_eq!(result.columns.len(), 1);
        assert_eq!(result.columns[0].name, b"id");
        assert_eq!(result.rows, vec![vec![Some(b"42".to_vec())]]);
    }

    #[test]
    fn parses_use_database_statement() {
        assert_eq!(parse_use_database("USE `other``db`;"), Some("other`db".to_string()));
        assert_eq!(parse_use_database("SELECT 1"), None);
    }

    #[test]
    fn rejects_transaction_control_including_comments_and_autocommit() {
        for sql in [
            "BEGIN",
            "START /* comment */ TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",
            "COMMIT",
            "ROLLBACK TO SAVEPOINT s",
            "SAVEPOINT s",
            "RELEASE SAVEPOINT s",
            "XA START 'x'",
            "SET autocommit = 0",
            "SET @@autocommit = 0",
            "SET @@`autocommit` = 0",
            "SET @@session.autocommit = OFF",
            "SET SESSION `autocommit` = 0",
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
            "/*!40101 SET AUTOCOMMIT=0 */",
            "/*M! SET autocommit=0 */",
            "START /*!40100 TRANSACTION */",
            "SELECT 1; BEGIN",
        ] {
            assert!(validate_stateless_query(sql).is_err(), "{sql}");
        }
        for sql in [
            "SELECT 'BEGIN; SET autocommit=0'",
            "SELECT `autocommit` FROM t",
            "/* BEGIN */ SELECT 1",
            "SET NAMES utf8mb4",
            "SET SESSION group_concat_max_len = 1048576",
            "SET @note = 'autocommit'",
            "USE information_schema",
        ] {
            assert!(validate_stateless_query(sql).is_ok(), "{sql}");
        }
    }

    #[tokio::test]
    async fn transaction_commands_fail_before_any_http_request() {
        let http_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/ntunnel_mysql.php", http_listener.local_addr().unwrap());
        let endpoint = NavicatMysqlEndpoint::new(&url, "localhost", 3306, "user", "password", None, 1).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        let server = tokio::spawn(super::serve(listener, endpoint));

        read_packet(&mut client).await.unwrap();
        let mut handshake = [0; 32];
        handshake[..4].copy_from_slice(&CLIENT_PROTOCOL_41.to_le_bytes());
        write_packet(&mut client, 1, &handshake).await.unwrap();
        assert_eq!(read_packet(&mut client).await.unwrap().1[0], 0);

        for sql in ["START TRANSACTION", "BEGIN", "ROLLBACK", "COMMIT", "SET autocommit=0", "SET @@autocommit=0"] {
            let response = send_test_command(&mut client, 0x03, sql.as_bytes()).await;
            assert_eq!(response[0], 0xff, "{sql}");
            assert_eq!(u16::from_le_bytes(response[1..3].try_into().unwrap()), 1235, "{sql}");
            assert!(String::from_utf8_lossy(&response[9..]).contains("separate MySQL session"));
        }
        assert!(tokio::time::timeout(std::time::Duration::from_millis(50), http_listener.accept()).await.is_err());
        assert_eq!(send_test_command(&mut client, 0x0e, b"").await[0], 0);
        server.abort();
    }

    #[tokio::test]
    async fn live_navicat_http_tunnel_query_use_ping_and_error_paths() {
        let (Some(url), Some(username), Some(password)) = (
            std::env::var("DBX_NAVICAT_TEST_URL").ok(),
            std::env::var("DBX_NAVICAT_TEST_USERNAME").ok(),
            std::env::var("DBX_NAVICAT_TEST_PASSWORD").ok(),
        ) else {
            eprintln!("skipping live Navicat tunnel test: DBX_NAVICAT_TEST_* variables are not all set");
            return;
        };

        let endpoint = NavicatMysqlEndpoint::new(&url, "localhost", 3306, &username, &password, None, 20).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(super::serve(listener, endpoint));
        let mut client = TcpStream::connect(address).await.unwrap();

        let (_, greeting) = read_packet(&mut client).await.unwrap();
        assert_eq!(greeting.first(), Some(&10), "expected MySQL protocol 10 greeting");

        let mut handshake = Vec::new();
        handshake.extend_from_slice(&(CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION).to_le_bytes());
        handshake.extend_from_slice(&0x0100_0000u32.to_le_bytes());
        handshake.push(45);
        handshake.extend_from_slice(&[0; 23]);
        handshake.extend_from_slice(b"dbx-live-test\0");
        handshake.push(0);
        write_packet(&mut client, 1, &handshake).await.unwrap();
        let (_, auth_result) = read_packet(&mut client).await.unwrap();
        assert_eq!(auth_result.first(), Some(&0), "expected local proxy authentication OK");

        let use_result = send_test_command(&mut client, 0x03, b"USE information_schema").await;
        assert_eq!(use_result.first(), Some(&0), "USE should return an OK packet");

        let ping_result = send_test_command(&mut client, 0x0e, b"").await;
        assert_eq!(ping_result.first(), Some(&0), "COM_PING should return an OK packet");

        let _ = send_test_command(&mut client, 0x03, b"SELECT DATABASE()").await;
        let (_, column_definition) = read_packet(&mut client).await.unwrap();
        assert!(!column_definition.is_empty());
        let (_, column_terminator) = read_packet(&mut client).await.unwrap();
        assert_eq!(column_terminator.first(), Some(&0xfe));
        let (_, row) = read_packet(&mut client).await.unwrap();
        assert_eq!(row.first().copied(), Some("information_schema".len() as u8));
        assert_eq!(&row[1..], b"information_schema", "USE must select the database for the following HTTP query");
        let (_, row_terminator) = read_packet(&mut client).await.unwrap();
        assert_eq!(row_terminator.first(), Some(&0xfe));

        let sql_error = send_test_command(&mut client, 0x03, b"SELECT FROM dbx_live_test").await;
        assert_eq!(sql_error.first(), Some(&0xff), "invalid SQL should return an ERR packet");
        assert_eq!(u16::from_le_bytes(sql_error[1..3].try_into().unwrap()), 1105);
        assert!(
            String::from_utf8_lossy(&sql_error[9..]).contains("1064"),
            "the Navicat server error should be preserved"
        );

        write_packet(&mut client, 0, &[0x01]).await.unwrap();
        server.abort();
    }

    async fn send_test_command(client: &mut TcpStream, command: u8, payload: &[u8]) -> Vec<u8> {
        let mut packet = vec![command];
        packet.extend_from_slice(payload);
        write_packet(client, 0, &packet).await.unwrap();
        read_packet(client).await.unwrap().1
    }
}
