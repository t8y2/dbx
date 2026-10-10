use dbx_codex::{gateway::Gateway, runtime::RuntimeHandle};
use rmcp::{model::*, service::RunningService, RoleClient, ServiceExt};

async fn client(handle: RuntimeHandle) -> (RunningService<RoleClient, ()>, tokio::task::JoinHandle<()>) {
    let (server_io, client_io) = tokio::io::duplex(65536);
    let server = tokio::spawn(async move {
        Gateway::new(handle, "private-fixture-credential-do-not-leak".into())
            .serve(server_io)
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap();
    });
    (().serve(client_io).await.unwrap(), server)
}

#[tokio::test]
async fn bootstrap_tools_survive_unconfigured_backend() {
    let handle = RuntimeHandle {
        base_url: "http://127.0.0.1:1/".parse().unwrap(),
        version: "0.6.39".into(),
        instance_id: uuid::Uuid::new_v4().to_string(),
    };
    let (client, server) = client(handle).await;
    let tools = client.list_tools(None).await.unwrap();
    for expected in ["dbx_codex_open", "dbx_codex_status"] {
        assert!(tools.tools.iter().any(|tool| tool.name == expected));
    }
    let opened = client.call_tool(CallToolRequestParams::new("dbx_codex_open")).await.unwrap();
    assert_ne!(opened.is_error, Some(true));
    assert_eq!(opened.structured_content.as_ref().unwrap()["url"], "http://127.0.0.1:1/");
    assert!(!serde_json::to_string(&opened).unwrap().contains("private-fixture-credential"));
    client.cancel().await.unwrap();
    server.await.unwrap();
}

use rmcp::{service::RequestContext, ErrorData, RoleServer, ServerHandler};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[derive(Clone, Default)]
struct Fixture {
    calls: Arc<AtomicUsize>,
    cancelled: Arc<AtomicUsize>,
}

impl ServerHandler for Fixture {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let second = request.and_then(|r| r.cursor).as_deref() == Some("tools-page-2");
        let mut result = ListToolsResult::with_all_items(vec![Tool::new(
            if second { "fixture_write" } else { "fixture_denied" },
            "Fixture tool",
            serde_json::Map::new(),
        )]);
        result.next_cursor = if second { None } else { Some("tools-page-2".into()) };
        Ok(result)
    }
    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        let second = request.and_then(|r| r.cursor).as_deref() == Some("resources-page-2");
        let mut result = ListResourcesResult::with_all_items(vec![Resource::new(
            if second { "dbx://two" } else { "dbx://one" },
            "Fixture",
        )]);
        result.next_cursor = if second { None } else { Some("resources-page-2".into()) };
        Ok(result)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if request.name == "fixture_denied" {
            return Err(ErrorData::invalid_params(
                "Denied by database policy",
                Some(serde_json::json!({"code":"POLICY_DENIED"})),
            ));
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        context.ct.cancelled().await;
        self.cancelled.fetch_add(1, Ordering::SeqCst);
        Ok(CallToolResult::structured_error(serde_json::json!({"cancelled":true})).into())
    }
}

async fn backend() -> (RuntimeHandle, Fixture, tokio::task::JoinHandle<()>) {
    use rmcp::transport::{
        streamable_http_server::{session::local::LocalSessionManager, tower::StreamableHttpService},
        StreamableHttpServerConfig,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let fixture = Fixture::default();
    let factory = fixture.clone();
    let service = StreamableHttpService::new(
        move || Ok(factory.clone()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_allowed_hosts(vec![address.to_string()]),
    );
    let app = axum::Router::new().nest_service("/mcp", service);
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let handle = RuntimeHandle {
        base_url: format!("http://{address}/").parse().unwrap(),
        version: "0.6.39".into(),
        instance_id: uuid::Uuid::new_v4().to_string(),
    };
    (handle, fixture, task)
}

#[tokio::test]
async fn tool_and_resource_pagination_is_preserved() {
    let (handle, _, backend) = backend().await;
    let (client, server) = client(handle).await;
    let first = client.list_tools(None).await.unwrap();
    assert!(first.tools.iter().any(|t| t.name == "fixture_denied"));
    assert!(first.tools.iter().any(|t| t.name == "dbx_codex_open"));
    let mut page = PaginatedRequestParams::default();
    page.cursor = first.next_cursor;
    let second = client.list_tools(Some(page)).await.unwrap();
    assert_eq!(second.tools.iter().map(|t| t.name.as_ref()).collect::<Vec<_>>(), vec!["fixture_write"]);
    assert!(second.next_cursor.is_none());
    let first = client.list_resources(None).await.unwrap();
    assert_eq!(first.resources[0].uri, "dbx://one");
    let mut page = PaginatedRequestParams::default();
    page.cursor = first.next_cursor;
    let second = client.list_resources(Some(page)).await.unwrap();
    assert_eq!(second.resources[0].uri, "dbx://two");
    assert!(second.next_cursor.is_none());
    client.cancel().await.unwrap();
    server.await.unwrap();
    backend.abort();
}

#[tokio::test]
async fn backend_denial_is_not_bypassed() {
    let (handle, fixture, backend) = backend().await;
    let (client, server) = client(handle).await;
    let error = client.call_tool(CallToolRequestParams::new("fixture_denied")).await.unwrap_err();
    match error {
        rmcp::service::ServiceError::McpError(error) => assert_eq!(error.data.unwrap()["code"], "POLICY_DENIED"),
        error => panic!("Expected unchanged upstream policy error, got {error}"),
    }
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    client.cancel().await.unwrap();
    server.await.unwrap();
    backend.abort();
}

#[tokio::test]
async fn cancelled_write_is_not_retried() {
    let (handle, fixture, backend) = backend().await;
    let (client, server) = client(handle).await;
    let request: ClientRequest =
        serde_json::from_value(serde_json::json!({"method":"tools/call","params":{"name":"fixture_write"}})).unwrap();
    let pending = client.send_request_with_option(request, Default::default()).await.unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while fixture.calls.load(Ordering::SeqCst) == 0 {
        assert!(tokio::time::Instant::now() < deadline, "write did not start");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    pending.cancel(Some("User cancelled".into())).await.unwrap();
    while fixture.cancelled.load(Ordering::SeqCst) == 0 {
        assert!(tokio::time::Instant::now() < deadline, "cancellation did not reach backend");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    client.cancel().await.unwrap();
    server.await.unwrap();
    backend.abort();
}

#[tokio::test]
async fn native_version_does_not_start_workbench() {
    let directory = tempfile::tempdir().unwrap();
    let data = directory.path().join("unused-data");
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_dbx-codex"))
        .arg("--version").env("DBX_CODEX_DATA_DIR", &data).output().await.unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), "dbx-codex 0.6.39");
    assert!(!data.exists());
}
