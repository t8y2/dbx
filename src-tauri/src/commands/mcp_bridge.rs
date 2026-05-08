use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::connection::AppState;

const BIND_ADDR: &str = "127.0.0.1:0";

#[derive(Deserialize)]
struct OpenTableRequest {
    connection_name: String,
    database: Option<String>,
    schema: Option<String>,
    table: String,
}

#[derive(Deserialize)]
struct ExecuteQueryRequest {
    connection_name: String,
    database: Option<String>,
    sql: String,
}

#[derive(Clone, Serialize)]
pub struct McpOpenTableEvent {
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub table: String,
}

#[derive(Clone, Serialize)]
pub struct McpExecuteQueryEvent {
    pub connection_id: String,
    pub database: String,
    pub sql: String,
}

pub fn start(app_handle: AppHandle, state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(BIND_ADDR).await {
            Ok(l) => l,
            Err(e) => {
                log::warn!("MCP bridge failed to bind {BIND_ADDR}: {e}");
                return;
            }
        };
        log::info!("MCP bridge listening on {BIND_ADDR}");
        let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        log::info!("MCP bridge assigned port {actual_port}");
        if let Ok(dir) = app_handle.path().app_data_dir() {
            let _ = std::fs::write(dir.join("mcp-bridge-port"), actual_port.to_string());
        }
        loop {
            let (mut stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(_) => continue,
            };
            let app = app_handle.clone();
            let st = state.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 16384];
                let n = match stream.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let request = String::from_utf8_lossy(&buf[..n]);
                let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
                let first_line = request.lines().next().unwrap_or("");

                if first_line.starts_with("POST /open-table") {
                    handle_open_table(&app, &st, body, &mut stream).await;
                } else if first_line.starts_with("POST /execute-query") {
                    handle_execute_query(&app, &st, body, &mut stream).await;
                } else if first_line.starts_with("POST /reload-connections") {
                    let _ = app.emit("mcp-reload-connections", ());
                    respond(&mut stream, "200 OK", "ok").await;
                } else {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                }
            });
        }
    });
}

fn find_config_by_name<'a>(
    configs: &'a [crate::models::connection::ConnectionConfig],
    name: &str,
) -> Option<&'a crate::models::connection::ConnectionConfig> {
    configs.iter().find(|c| c.name.eq_ignore_ascii_case(name))
}

async fn respond(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let resp = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n\r\n{body}", body.len());
    let _ = stream.write_all(resp.as_bytes()).await;
}

async fn handle_open_table(app: &AppHandle, state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: OpenTableRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond(stream, "400 Bad Request", "").await;
            return;
        }
    };
    let configs = match state.storage.load_connections().await {
        Ok(c) => c,
        Err(_) => {
            respond(stream, "500 Internal Server Error", "").await;
            return;
        }
    };
    let Some(config) = find_config_by_name(&configs, &req.connection_name) else {
        respond(stream, "404 Not Found", "Connection not found").await;
        return;
    };
    let event = McpOpenTableEvent {
        connection_id: config.id.clone(),
        database: req.database.unwrap_or_else(|| config.database.clone().unwrap_or_default()),
        schema: req.schema,
        table: req.table,
    };
    let _ = app.emit("mcp-open-table", &event);
    respond(stream, "200 OK", "ok").await;
}

async fn handle_execute_query(app: &AppHandle, state: &Arc<AppState>, body: &str, stream: &mut tokio::net::TcpStream) {
    let req: ExecuteQueryRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(_) => {
            respond(stream, "400 Bad Request", "").await;
            return;
        }
    };
    let configs = match state.storage.load_connections().await {
        Ok(c) => c,
        Err(_) => {
            respond(stream, "500 Internal Server Error", "").await;
            return;
        }
    };
    let Some(config) = find_config_by_name(&configs, &req.connection_name) else {
        respond(stream, "404 Not Found", "Connection not found").await;
        return;
    };
    let event = McpExecuteQueryEvent {
        connection_id: config.id.clone(),
        database: req.database.unwrap_or_else(|| config.database.clone().unwrap_or_default()),
        sql: req.sql,
    };
    let _ = app.emit("mcp-execute-query", &event);
    respond(stream, "200 OK", "ok").await;
}
