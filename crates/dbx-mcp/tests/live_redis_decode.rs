use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};

use dbx_core::{models::connection::ConnectionConfig, storage::Storage};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};
use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde_json::{json, Value};

struct RedisProcess(Child);
impl Drop for RedisProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn set_value(port: u16, key: &str, bytes: &[u8]) {
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    write!(stream, "*3\r\n$3\r\nSET\r\n${}\r\n{key}\r\n${}\r\n", key.len(), bytes.len()).unwrap();
    stream.write_all(bytes).unwrap();
    stream.write_all(b"\r\n").unwrap();
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).unwrap();
    assert_eq!(reply, "+OK\r\n");
}

#[tokio::test]
#[ignore = "requires redis-server on PATH; starts an isolated ephemeral Redis instance"]
async fn real_redis_values_decode_over_the_mcp_transport() {
    let directory = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let _redis = RedisProcess(
        Command::new("redis-server")
            .args(["--bind", "127.0.0.1", "--port", &port.to_string(), "--save", "", "--appendonly", "no", "--dir"])
            .arg(directory.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut ready = false;
    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(ready, "temporary Redis did not start");

    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("../../dbx-formats/tests/fixtures/redis_java.json")).unwrap();
    for fixture in &fixtures {
        let bytes = fixture["hex"]
            .as_str()
            .unwrap()
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        set_value(port, fixture["name"].as_str().unwrap(), &bytes);
    }
    let mut extra: Vec<Value> =
        serde_json::from_str(include_str!("../../dbx-formats/tests/fixtures/redis_codecs.json")).unwrap();
    let compressed: Vec<Value> =
        serde_json::from_str(include_str!("../../dbx-formats/tests/fixtures/redis_compression.json")).unwrap();
    extra.extend(compressed);
    for fixture in &extra {
        let bytes = fixture["hex"]
            .as_str()
            .unwrap()
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        set_value(port, fixture["name"].as_str().unwrap(), &bytes);
    }
    set_value(port, "plain", b"plain text");
    set_value(port, "broken", &[0xac, 0xed, 0, 5]);
    let large_text = "x".repeat(21_000);
    let mut large_bytes = vec![0xac, 0xed, 0, 5, 0x74];
    large_bytes.extend(21_000_u16.to_be_bytes());
    large_bytes.extend(large_text.as_bytes());
    set_value(port, "large", &large_bytes);

    let path = directory.path().join("dbx.db");
    let storage = Storage::open(&path).await.unwrap();
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id":"redis-codec", "name":"redis-codec", "db_type":"redis", "host":"127.0.0.1",
        "port":port, "username":"", "password":"", "database":"0", "ssl":false
    }))
    .unwrap();
    storage.save_connections(&[config]).await.unwrap();
    let backend = Arc::new(LocalBackend::open(&path).await.unwrap());
    let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.unwrap();

    for fixture in &fixtures {
        let key = fixture["name"].as_str().unwrap();
        let request = json!({"connection_id":"redis-codec", "db":0, "command":format!("GET {key}"), "decode":"auto"});
        let result = client
            .peer()
            .call_tool(
                CallToolRequestParams::new("dbx_execute_redis_command")
                    .with_arguments(request.as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true), "{result:?}");
        let output = &result.content[0].as_text().unwrap().text;
        let decoded: Value = serde_json::from_str(output.split_once("\n\n").unwrap().1).unwrap();
        assert_eq!(decoded, json!({"codec":"java-serialized", "value":fixture["expected"]}), "{key}");
    }
    for fixture in &extra {
        let key = fixture["name"].as_str().unwrap();
        let mut request = json!({"connection_id":"redis-codec","command":format!("GET {key}")});
        let mut expected = json!({"value":fixture["expected"]});
        if let Some(codec) = fixture["codec"].as_str() {
            request["decode"] = json!(codec);
            expected["codec"] = json!(codec);
        }
        if let Some(compression) = fixture["compression"].as_str() {
            request["decompress"] = json!(compression);
            expected["compression"] = json!(compression);
        }
        let result = client
            .peer()
            .call_tool(
                CallToolRequestParams::new("dbx_execute_redis_command")
                    .with_arguments(request.as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true), "{result:?}");
        let output = result.content[0].as_text().unwrap().text.split_once("\n\n").unwrap().1;
        assert_eq!(serde_json::from_str::<Value>(output).unwrap(), expected, "{key}");
    }
    let result=client.peer().call_tool(CallToolRequestParams::new("dbx_execute_redis_command").with_arguments(json!({"connection_id":"redis-codec","command":"MGET msgpack-map php-map pickle-protocol-4 gzip-msgpack-map plain broken missing","decode":"auto"}).as_object().unwrap().clone())).await.unwrap();
    assert_ne!(result.is_error, Some(true), "{result:?}");
    let values: Value =
        serde_json::from_str(result.content[0].as_text().unwrap().text.split_once("\n\n").unwrap().1).unwrap();
    for (index, codec) in [(0, "msgpack"), (1, "php-serialize"), (2, "pickle"), (3, "msgpack")] {
        assert_eq!(values[index]["codec"], json!(codec));
    }
    assert_eq!(values[3]["compression"], json!("gzip"));
    assert_eq!(values[4], json!("plain text"));
    assert_eq!(values[5], json!(r"\xac\xed\x00\x05"));
    assert_eq!(values[6], Value::Null);
    for (command, decode, expected) in [
        ("GET string", None, json!(r"\xac\xed\x00\x05t\x00\x08sometext")),
        (
            "MGET string plain broken missing",
            Some("java-serialized"),
            json!([
                {"codec":"java-serialized", "value":"sometext"}, "plain text", r"\xac\xed\x00\x05", null
            ]),
        ),
        ("GET large", Some("auto"), json!({"codec":"java-serialized", "value":large_text})),
    ] {
        let mut request = json!({"connection_id":"redis-codec", "command":command});
        if let Some(decode) = decode {
            request["decode"] = json!(decode);
        }
        let result = client
            .peer()
            .call_tool(
                CallToolRequestParams::new("dbx_execute_redis_command")
                    .with_arguments(request.as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true), "{result:?}");
        let output = result.content[0].as_text().unwrap().text.split_once("\n\n").unwrap().1;
        if decode.is_none() {
            assert_eq!(output, expected.as_str().unwrap());
        } else {
            assert_eq!(serde_json::from_str::<Value>(output).unwrap(), expected);
        }
    }
    client.cancel().await.unwrap();
    server_task.await.unwrap().unwrap().cancel().await.unwrap();
}
