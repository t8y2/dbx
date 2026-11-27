//! SQLyog HTTP tunnel (`SQLyogTunnel.php`, tunnel version 11.x) for MySQL connections.
//!
//! The PHP script exposes the MySQL API as XML over HTTP: every POST carries the
//! target host, credentials, database, charset and the SQL text, and the script
//! opens a **new** MySQL connection for every request. Like the Navicat tunnel,
//! this transport is therefore stateless: transactions, temporary tables and
//! session variables cannot survive a statement. The MySQL wire protocol spoken
//! to the local driver is shared with [`crate::navicat_mysql_tunnel`].
//!
//! Request (plain XML, `E="1"` marks base64 character data):
//!
//! ```text
//! <xml><host>localhost</host><port>3306</port><user>root</user>
//! <password E="1">base64</password><db>erp</db><charset>utf8mb4</charset>
//! <query B="0">SELECT 1</query></xml>
//! ```
//!
//! Response: one `<result v="11.5">` element. Either `<e_i><e_n>errno</e_n>
//! <e_d>message</e_d></e_i>`, or `<e_i></e_i>` followed by `<a_r>`/`<i_i>` and
//! either `<f_i c="0"></f_i>` (no result set) or column definitions and rows
//! whose cells are base64 text, `(NULL)` or `_` (empty string).

use base64::Engine;
use reqwest::{Client, Url};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;
use tokio::time::{timeout, Duration};

use crate::navicat_mysql_tunnel::{
    mysql_handshake_greeting, mysql_ok_packet, parse_use_database, read_packet, send_mysql_error,
    validate_stateless_query, write_packet, write_query_result, NavicatColumn, NavicatResult, CLIENT_PROTOCOL_41,
};

/// Sent as `<charset>`; the PHP script runs `SET NAMES <charset>` on every request.
const DEFAULT_CHARSET: &str = "utf8mb4";

const STATELESS_ERROR: &str = "Transactions, disabling autocommit, and consistent snapshots are not supported by the stateless SQLyog HTTP tunnel; use the DBX TCP HTTP tunnel (dbx_tunnel.php) for a fixed database session";

#[derive(Clone)]
pub struct SqlyogMysqlEndpoint {
    url: Url,
    host: String,
    port: u16,
    username: String,
    password: String,
    database: String,
    charset: String,
    request_timeout: Duration,
    client: Client,
}

/// Either a MySQL error reported by the tunnel (kept with its own error code so
/// the driver sees the real failure) or a transport/protocol problem.
#[derive(Debug, PartialEq, Eq)]
pub enum SqlyogError {
    Mysql { code: u16, message: String },
    Other(String),
}

impl SqlyogError {
    fn other(message: String) -> Self {
        Self::Other(message)
    }
}

impl From<String> for SqlyogError {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl SqlyogMysqlEndpoint {
    pub fn new(
        url: &str,
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        database: Option<&str>,
        request_timeout_secs: u64,
    ) -> Result<Self, String> {
        let url = Url::parse(url.trim()).map_err(|error| format!("Invalid SQLyog tunnel URL: {error}"))?;
        match url.scheme() {
            "https" => {}
            "http" => log::warn!(
                "[sqlyog-http] using unencrypted HTTP tunnel; database credentials and SQL are exposed in transit"
            ),
            other => return Err(format!("Unsupported SQLyog tunnel URL scheme: {other}")),
        }
        if !url.path().to_ascii_lowercase().ends_with(".php") {
            return Err(
                "SQLyog tunnel URL must point to the PHP tunnel script, for example https://example.com/SQLyogTunnel.php"
                    .to_string(),
            );
        }
        if host.trim().is_empty() || port == 0 {
            return Err("SQLyog tunnel requires a MySQL target host and port".to_string());
        }
        Ok(Self {
            url,
            host: host.to_string(),
            port,
            username: username.to_string(),
            // An empty password is valid: some deployments hard-code the account in the script.
            password: password.to_string(),
            database: database.unwrap_or_default().to_string(),
            charset: DEFAULT_CHARSET.to_string(),
            request_timeout: Duration::from_secs(request_timeout_secs.clamp(1, 300)),
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| format!("Failed to create SQLyog HTTP client: {error}"))?,
        })
    }

    async fn query(&self, database: &str, sql: &str) -> Result<NavicatResult, SqlyogError> {
        let started = std::time::Instant::now();
        let body =
            build_request_body(&self.host, self.port, &self.username, &self.password, database, &self.charset, sql);
        log::debug!(
            "[sqlyog-http] POST tunnel request target={}:{} db={} sql_bytes={} timeout_secs={}",
            self.host,
            self.port,
            if database.is_empty() { "<none>" } else { "<set>" },
            sql.len(),
            self.request_timeout.as_secs()
        );
        let (status, response_body) = timeout(self.request_timeout, async {
            let response = self
                .client
                .post(self.url.clone())
                .header(reqwest::header::CONTENT_TYPE, "text/xml")
                .body(body)
                .send()
                .await?;
            let status = response.status();
            let response_body = response.bytes().await?;
            Ok::<_, reqwest::Error>((status, response_body))
        })
        .await
        .map_err(|_| {
            log::warn!(
                "[sqlyog-http] request timed out after {:?} target={}:{}",
                started.elapsed(),
                self.host,
                self.port
            );
            "SQLyog HTTP tunnel request timed out".to_string()
        })?
        .map_err(|error| {
            log::warn!(
                "[sqlyog-http] request transport error after {:?} target={}:{}: {error}",
                started.elapsed(),
                self.host,
                self.port
            );
            format!("SQLyog HTTP tunnel request failed: {error}")
        })?;
        log::debug!(
            "[sqlyog-http] response status={} bytes={} elapsed={:?}",
            status,
            response_body.len(),
            started.elapsed()
        );
        if !status.is_success() {
            return Err(format!(
                "SQLyog HTTP tunnel returned HTTP {status}: {}",
                String::from_utf8_lossy(&response_body).trim()
            )
            .into());
        }
        parse_sqlyog_response(&response_body)
    }
}

pub async fn serve(listener: TcpListener, endpoint: SqlyogMysqlEndpoint) {
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
                            log::warn!("[sqlyog-mysql] local client session failed peer={peer:?}: {error}");
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

async fn serve_client(stream: &mut TcpStream, endpoint: Arc<SqlyogMysqlEndpoint>) -> Result<(), String> {
    let peer = stream.peer_addr().ok();
    let seed_a = uuid::Uuid::new_v4();
    let seed_b = uuid::Uuid::new_v4();
    let mut auth_seed = [0; 20];
    auth_seed[..16].copy_from_slice(seed_a.as_bytes());
    auth_seed[16..].copy_from_slice(&seed_b.as_bytes()[..4]);
    let greeting = mysql_handshake_greeting(&auth_seed);
    write_packet(stream, 0, &greeting).await?;
    log::debug!("[sqlyog-mysql] sent protocol greeting peer={peer:?} bytes={}", greeting.len());

    let (sequence, handshake) = read_packet(stream).await.map_err(|error| {
        log::warn!("[sqlyog-mysql] failed waiting for client handshake peer={peer:?}: {error}");
        error
    })?;
    if handshake.len() < 32 {
        return Err("Invalid MySQL handshake response".to_string());
    }
    let client_capabilities = u32::from_le_bytes(handshake[0..4].try_into().unwrap());
    if client_capabilities & CLIENT_PROTOCOL_41 == 0 {
        return send_mysql_error(stream, sequence.wrapping_add(1), 1043, "MySQL protocol 4.1 is required").await;
    }
    write_packet(stream, sequence.wrapping_add(1), &mysql_ok_packet(0, 0, "")).await?;
    log::debug!("[sqlyog-mysql] authenticated local client peer={peer:?}");

    let mut database = endpoint.database.clone();
    loop {
        let (sequence, packet) = match read_packet(stream).await {
            Ok(packet) => packet,
            Err(error) if error == "MySQL client disconnected" => return Ok(()),
            Err(error) => {
                log::warn!("[sqlyog-mysql] failed reading client command peer={peer:?}: {error}");
                return Err(error);
            }
        };
        let Some((&command, payload)) = packet.split_first() else {
            continue;
        };
        log::debug!(
            "[sqlyog-mysql] received command peer={peer:?} command=0x{command:02x} sequence={sequence} payload_bytes={}",
            payload.len()
        );
        match command {
            0x01 => return Ok(()),
            0x0e => write_packet(stream, sequence.wrapping_add(1), &mysql_ok_packet(0, 0, "")).await?,
            0x02 => {
                database = String::from_utf8_lossy(payload).to_string();
                write_packet(stream, sequence.wrapping_add(1), &mysql_ok_packet(0, 0, "")).await?;
            }
            0x03 => {
                let sql = String::from_utf8_lossy(payload).to_string();
                // Same stateless rules as the Navicat tunnel: reject transactions before any HTTP request.
                if validate_stateless_query(&sql).is_err() {
                    send_mysql_error(stream, sequence.wrapping_add(1), 1235, STATELESS_ERROR).await?;
                    continue;
                }
                if let Some(next_database) = parse_use_database(&sql) {
                    database = next_database;
                    write_packet(stream, sequence.wrapping_add(1), &mysql_ok_packet(0, 0, "")).await?;
                    continue;
                }
                match endpoint.query(&database, &sql).await {
                    Ok(result) => write_query_result(stream, result).await?,
                    Err(SqlyogError::Mysql { code, message }) => {
                        send_mysql_error(stream, sequence.wrapping_add(1), code, &message).await?
                    }
                    Err(SqlyogError::Other(message)) => {
                        send_mysql_error(stream, sequence.wrapping_add(1), 1105, &message).await?
                    }
                }
            }
            0x16 => {
                send_mysql_error(
                    stream,
                    sequence.wrapping_add(1),
                    1295,
                    "Prepared statements are not supported by SQLyog HTTP tunnels",
                )
                .await?
            }
            _ => {
                send_mysql_error(stream, sequence.wrapping_add(1), 1047, "Unsupported command for SQLyog HTTP tunnel")
                    .await?
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Request encoding
// ---------------------------------------------------------------------------

fn build_request_body(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    database: &str,
    charset: &str,
    sql: &str,
) -> String {
    format!(
        "<xml><host>{host}</host><port>{port}</port><user>{user}</user>\
         <password E=\"1\">{password}</password><db>{db}</db><charset>{charset}</charset>\
         <query B=\"0\">{query}</query></xml>",
        host = xml_escape(host),
        port = port,
        user = xml_escape(username),
        password = base64::engine::general_purpose::STANDARD.encode(password.as_bytes()),
        db = xml_escape(database),
        charset = xml_escape(charset),
        query = xml_escape(sql),
    )
}

/// Escapes only the three characters that terminate XML text. Quotes are left
/// as-is inside element content, and the short password travels base64-encoded.
fn xml_escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            _ => output.push(ch),
        }
    }
    output
}

// ---------------------------------------------------------------------------
// Response parsing (the tunnel output is small and regular; no XML crate needed)
// ---------------------------------------------------------------------------

/// Parses one tunnel response. Private on purpose: the shared `NavicatResult`
/// is only `pub(crate)`, so exposing this fn would widen its interface.
fn parse_sqlyog_response(body: &[u8]) -> Result<NavicatResult, SqlyogError> {
    let mut cursor = Cursor::new(body);
    let mut count = 0usize;
    let mut last = None;
    while cursor.find(b"<result").is_some() {
        cursor.find(b">").ok_or_else(|| {
            SqlyogError::other(format!("Truncated <result> tag in SQLyog tunnel response; preview={:?}", preview(body)))
        })?;
        let data = cursor.data;
        let end = find_bytes(&data[cursor.pos..], b"</result>").ok_or_else(|| {
            SqlyogError::other(format!(
                "Unterminated <result> element in SQLyog tunnel response; preview={:?}",
                preview(body)
            ))
        })?;
        let fragment = &data[cursor.pos..cursor.pos + end];
        cursor.pos += end + b"</result>".len();
        last = Some(parse_sqlyog_result(fragment)?);
        count += 1;
    }
    match count {
        0 => Err(SqlyogError::other(format!(
            "Invalid SQLyog HTTP tunnel response: no <result> element; preview={:?}",
            preview(body)
        ))),
        1 => last.ok_or_else(|| SqlyogError::other("Missing SQLyog query result".to_string())),
        other => Err(SqlyogError::other(format!(
            "SQLyog HTTP tunnel returned {other} result sets; multiple result sets are not supported by this tunnel"
        ))),
    }
}

fn parse_sqlyog_result(fragment: &[u8]) -> Result<NavicatResult, SqlyogError> {
    let mut cursor = Cursor::new(fragment);
    cursor.expect(b"<e_i>")?;
    if cursor.starts_with(b"<e_n>") {
        cursor.skip(b"<e_n>".len());
        let code = cursor.text_until(b"</e_n>")?;
        cursor.expect(b"<e_d>")?;
        let message = cursor.text_until(b"</e_d>")?;
        let code = parse_u64(&code).unwrap_or(1105).min(u16::MAX as u64) as u16;
        let message = String::from_utf8_lossy(&xml_unescape(&message)).into_owned();
        return Err(SqlyogError::Mysql { code, message });
    }
    cursor.expect(b"</e_i>")?;

    let mut result = NavicatResult {
        affected_rows: 0,
        last_insert_id: 0,
        columns: Vec::new(),
        rows: Vec::new(),
        info: String::new(),
    };
    cursor.find(b"<a_r>").ok_or_else(|| malformed("affected rows"))?;
    result.affected_rows = parse_u64(&cursor.text_until(b"</a_r>")?).unwrap_or(0);
    cursor.find(b"<i_i>").ok_or_else(|| malformed("last insert id"))?;
    result.last_insert_id = parse_u64(&cursor.text_until(b"</i_i>")?).unwrap_or(0);

    // The script prints the bare column count right before <f_i>; locate the tag instead of expecting it.
    cursor.find(b"<f_i").ok_or_else(|| malformed("field information"))?;
    cursor.find(b">").ok_or_else(|| malformed("field information"))?;
    while !cursor.starts_with(b"</f_i>") {
        cursor.expect(b"<f>")?;
        cursor.expect(b"<n>")?;
        let name = cursor.text_until(b"</n>")?;
        cursor.expect(b"<t>")?;
        let table = cursor.text_until(b"</t>")?;
        cursor.expect(b"<m>")?;
        let max_length = cursor.text_until(b"</m>")?;
        cursor.expect(b"<d>")?;
        cursor.text_until(b"</d>")?;
        cursor.expect(b"<ty>")?;
        let type_name = cursor.text_until(b"</ty>")?;
        cursor.expect(b"</f>")?;
        result.columns.push(NavicatColumn {
            name: xml_unescape(&name),
            table: xml_unescape(&table),
            column_type: sqlyog_column_type(&type_name),
            // Flags and decimals are not reported by the tunnel script.
            flags: 0,
            length: parse_u64(&max_length).unwrap_or(0).max(255).min(u32::MAX as u64) as u32,
        });
    }

    cursor.find(b"<r_i").ok_or_else(|| malformed("row information"))?;
    cursor.find(b">").ok_or_else(|| malformed("row information"))?;
    let column_count = result.columns.len();
    while !cursor.starts_with(b"</r_i>") {
        cursor.expect(b"<r>")?;
        let mut row = Vec::with_capacity(column_count);
        while cursor.starts_with(b"<c ") {
            cursor.find(b">").ok_or_else(|| malformed("cell tag"))?;
            let cell = cursor.text_until(b"</c>")?;
            row.push(decode_cell(&cell));
        }
        cursor.expect(b"</r>")?;
        result.rows.push(row);
    }
    if result.columns.is_empty() {
        result.rows.clear();
    }
    Ok(result)
}

fn malformed(what: &str) -> SqlyogError {
    SqlyogError::other(format!("Malformed SQLyog HTTP tunnel response: missing {what}"))
}

fn preview(body: &[u8]) -> String {
    String::from_utf8_lossy(body.get(..body.len().min(160)).unwrap_or_default())
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect()
}

/// Maps the type names emitted by `GetCorrectDataTypeMySQLI()` to MySQL type
/// codes. Integers and floats keep their real type so the driver parses them;
/// everything else (dates, decimals, blobs, unknown names) is returned as a
/// string, because zero dates and binary blobs cannot be parsed reliably.
fn sqlyog_column_type(type_name: &[u8]) -> u8 {
    match String::from_utf8_lossy(type_name).trim().to_ascii_lowercase().as_str() {
        "tinyint" => 0x01,
        "int" => 0x03,
        "float" => 0x04,
        "double" => 0x05,
        "default null" => 0x06,
        "bigint" => 0x08,
        "mediumint" => 0x09,
        // MYSQL_TYPE_VAR_STRING
        _ => 0xfd,
    }
}

fn decode_cell(text: &[u8]) -> Option<Vec<u8>> {
    let text = String::from_utf8_lossy(text);
    let trimmed = text.trim();
    match trimmed {
        "(NULL)" => None,
        "_" => Some(Vec::new()),
        _ => Some(
            base64::engine::general_purpose::STANDARD.decode(trimmed).unwrap_or_else(|_| trimmed.as_bytes().to_vec()),
        ),
    }
}

fn parse_u64(text: &[u8]) -> Option<u64> {
    std::str::from_utf8(text).ok()?.trim().parse().ok()
}

/// Reverses `convertxmlchars()` from the tunnel script. Scans left to right so
/// `&amp;lt;` becomes `&lt;` and not `<`.
fn xml_unescape(text: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(text);
    let mut output = String::with_capacity(text.len());
    // `Cow::as_str` is still unstable; a plain borrow derefs to the same `&str`.
    let mut rest: &str = &text;
    while let Some(index) = rest.find('&') {
        output.push_str(&rest[..index]);
        rest = &rest[index..];
        let entity =
            ["&amp;", "&lt;", "&gt;", "&apos;", "&quot;"].into_iter().find(|candidate| rest.starts_with(candidate));
        match entity {
            Some(entity) => {
                output.push(match entity {
                    "&amp;" => '&',
                    "&lt;" => '<',
                    "&gt;" => '>',
                    "&apos;" => '\'',
                    _ => '"',
                });
                rest = &rest[entity.len()..];
            }
            None => {
                output.push('&');
                rest = &rest[1..];
            }
        }
    }
    output.push_str(rest);
    output.into_bytes()
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn starts_with(&self, tag: &[u8]) -> bool {
        self.data[self.pos..].starts_with(tag)
    }

    fn skip(&mut self, count: usize) {
        self.pos += count;
    }

    fn expect(&mut self, tag: &[u8]) -> Result<(), SqlyogError> {
        if self.starts_with(tag) {
            self.pos += tag.len();
            Ok(())
        } else {
            Err(SqlyogError::other(format!(
                "Malformed SQLyog HTTP tunnel response: expected {:?} at byte {}; preview={:?}",
                String::from_utf8_lossy(tag),
                self.pos,
                preview(&self.data[self.pos..])
            )))
        }
    }

    fn find(&mut self, tag: &[u8]) -> Option<()> {
        let index = find_bytes(&self.data[self.pos..], tag)?;
        self.pos += index + tag.len();
        Some(())
    }

    fn text_until(&mut self, close: &[u8]) -> Result<Vec<u8>, SqlyogError> {
        let index = find_bytes(&self.data[self.pos..], close).ok_or_else(|| {
            SqlyogError::other(format!(
                "Malformed SQLyog HTTP tunnel response: missing closing {:?} at byte {}",
                String::from_utf8_lossy(close),
                self.pos
            ))
        })?;
        let text = self.data[self.pos..self.pos + index].to_vec();
        self.pos += index + close.len();
        Ok(text)
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
    }

    fn ok_envelope(inner: &str) -> String {
        format!(
            "<xml><result v=\"11.5\"><e_i></e_i><s_v>8.0.13</s_v><m_i></m_i><a_r>0</a_r><i_i>0</i_i>{inner}</result></xml>"
        )
    }

    #[test]
    fn request_body_matches_sqlyog_tunnel_xml_format() {
        let body = build_request_body("localhost", 3306, "root", "p<ss&word", "erp`x", "utf8mb4", "SELECT '<a & b>'");
        assert!(body.starts_with("<xml><host>localhost</host><port>3306</port><user>root</user>"));
        assert!(body.contains(&format!("<password E=\"1\">{}</password>", b64("p<ss&word"))));
        assert!(body.contains("<db>erp`x</db><charset>utf8mb4</charset>"));
        assert!(body.contains("<query B=\"0\">SELECT '&lt;a &amp; b&gt;'</query></xml>"));
        assert!(!body.contains("p<ss"));
    }

    #[test]
    fn parses_rows_with_null_empty_and_base64_cells() {
        let body = ok_envelope(&format!(
            "2<f_i c=\"2\"><f><n>id</n><t></t><m>3</m><d></d><ty>bigint</ty></f>\
             <f><n>a &amp; &lt;name&gt;</n><t>orders</t><m>5</m><d></d><ty>varchar</ty></f></f_i>\
             <r_i c=\"2\"><r><c l=\"3\">{}</c><c l=\"0\">_</c></r><r><c l=\"3\">{}</c><c l=\"4\">{}</c></r></r_i>",
            b64("123"),
            b64("456"),
            b64("中x")
        ));
        let result = parse_sqlyog_response(body.as_bytes()).unwrap();
        assert_eq!(result.columns.len(), 2);
        assert_eq!(result.columns[0].name, b"id");
        assert_eq!(result.columns[0].column_type, 0x08);
        assert_eq!(result.columns[1].name, "a & <name>".as_bytes());
        assert_eq!(result.columns[1].table, b"orders");
        assert_eq!(result.columns[1].column_type, 0xfd);
        assert_eq!(
            result.rows,
            vec![
                vec![Some(b"123".to_vec()), Some(Vec::new())],
                vec![Some(b"456".to_vec()), Some("中x".as_bytes().to_vec())]
            ]
        );
    }

    #[test]
    fn parses_empty_cells_and_non_result_statements() {
        let null = ok_envelope(&format!(
            "1<f_i c=\"1\"><f><n>c</n><t></t><m>0</m><d></d><ty>varchar</ty></f></f_i>\
             <r_i c=\"1\"><r><c l=\"0\">(NULL)</c></r></r_i>"
        ));
        assert_eq!(parse_sqlyog_response(null.as_bytes()).unwrap().rows, vec![vec![None]]);

        let statement = ok_envelope("<f_i c=\"0\"></f_i><r_i></r_i>");
        let result = parse_sqlyog_response(statement.as_bytes()).unwrap();
        assert!(result.columns.is_empty() && result.rows.is_empty());
        assert_eq!((result.affected_rows, result.last_insert_id), (0, 0));
    }

    #[test]
    fn keeps_mysql_error_code_from_tunnel() {
        let body = "<xml><result v=\"11.5\"><e_i><e_n>1064</e_n><e_d>You have an error near &apos;x&apos; &amp; &quot;y&quot;</e_d></e_i></result></xml>";
        assert_eq!(
            parse_sqlyog_response(body.as_bytes()),
            Err(SqlyogError::Mysql { code: 1064, message: "You have an error near 'x' & \"y\"".to_string() })
        );
    }

    #[test]
    fn rejects_html_banners_and_multiple_results() {
        let html = b"<html><head><title>SQLyog HTTP Tunneling</title></head><body>Tunnel version: 11.5</body></html>";
        assert!(matches!(parse_sqlyog_response(html), Err(SqlyogError::Other(_))));

        let two = format!(
            "{}{}",
            ok_envelope("<f_i c=\"0\"></f_i><r_i></r_i>"),
            ok_envelope("<f_i c=\"0\"></f_i><r_i></r_i>")
        );
        match parse_sqlyog_response(two.as_bytes()) {
            Err(SqlyogError::Other(message)) => assert!(message.contains("2 result sets"), "{message}"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn maps_only_numeric_types_to_typed_columns() {
        for (name, expected) in [
            ("tinyint", 0x01u8),
            ("int", 0x03),
            ("float", 0x04),
            ("double", 0x05),
            ("bigint", 0x08),
            ("mediumint", 0x09),
            ("", 0xfd),
            ("datetime", 0xfd),
            ("blob", 0xfd),
            ("varchar", 0xfd),
        ] {
            assert_eq!(sqlyog_column_type(name.as_bytes()), expected, "{name}");
        }
    }

    #[test]
    fn endpoint_requires_php_script_and_target() {
        assert!(SqlyogMysqlEndpoint::new(
            "https://example.com/SQLyogTunnel.php",
            "localhost",
            3306,
            "root",
            "",
            None,
            10,
        )
        .is_ok());
        assert!(
            SqlyogMysqlEndpoint::new("https://example.com/tunnel", "localhost", 3306, "root", "", None, 10,).is_err()
        );
        assert!(SqlyogMysqlEndpoint::new("https://example.com/SQLyogTunnel.php", "", 0, "root", "", None, 10,).is_err());
    }
}
