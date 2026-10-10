use crate::runtime::RuntimeHandle;
use rmcp::{
    model::*,
    service::{NotificationContext, Peer, PeerRequestOptions, RequestContext, RunningService, ServiceError},
    transport::{streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport},
    ErrorData, RoleClient, RoleServer, ServerHandler, Service, ServiceExt,
};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

type ProgressMap = Arc<Mutex<HashMap<ProgressToken, ProgressToken>>>;

pub struct Gateway {
    handle: RuntimeHandle,
    token: String,
    upstream: tokio::sync::Mutex<Option<RunningService<RoleClient, Notifications>>>,
    progress: ProgressMap,
}

impl Gateway {
    pub fn new(handle: RuntimeHandle, token: String) -> Self {
        Self { handle, token, upstream: tokio::sync::Mutex::new(None), progress: Default::default() }
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        if let Some(mut service) = self.upstream.lock().await.take() {
            match service.close_with_timeout(Duration::from_secs(3)).await {
                Ok(Some(_)) => {}
                Ok(None) => return Err("Upstream MCP session cleanup timed out".into()),
                Err(_) => return Err("Upstream MCP session cleanup failed".into()),
            }
        }
        Ok(())
    }

    async fn connect(&self, downstream: Peer<RoleServer>) -> Result<Peer<RoleClient>, ErrorData> {
        let mut upstream = self.upstream.lock().await;
        if let Some(service) = upstream.as_ref().filter(|service| !service.is_transport_closed()) {
            return Ok(service.peer().clone());
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| unavailable())?;
        let config = StreamableHttpClientTransportConfig::with_uri(
            self.handle.base_url.join("mcp").map_err(|_| unavailable())?.to_string(),
        )
        .auth_header(self.token.clone())
        // A lost/expired session must never cause a write to be submitted again.
        .reinit_on_expired_session(false);
        let transport = StreamableHttpClientTransport::with_client(client, config);
        let handler = Notifications { downstream: downstream.clone(), progress: self.progress.clone() };
        let service = tokio::time::timeout(Duration::from_secs(5), handler.serve(transport))
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
        let peer = service.peer().clone();
        *upstream = Some(service);
        let _ = downstream.notify_tool_list_changed().await;
        Ok(peer)
    }

    async fn send(
        &self,
        peer: Peer<RoleClient>,
        request: ClientRequest,
        context: RequestContext<RoleServer>,
    ) -> Result<ServerResult, ErrorData> {
        let original_progress = context.meta.get_progress_token();
        let mut pending =
            peer.send_request_with_option(request, PeerRequestOptions::no_options()).await.map_err(protocol_error)?;
        let token = pending.progress_token.clone();
        if let Some(original) = original_progress {
            self.progress.lock().unwrap_or_else(|e| e.into_inner()).insert(token.clone(), original);
        }
        let result = tokio::select! {
            response = &mut pending.rx => match response {
                Ok(response) => response.map_err(protocol_error),
                Err(_) => Err(unavailable()),
            },
            _ = context.ct.cancelled() => {
                let _ = pending.cancel(Some("Codex request cancelled".into())).await;
                Err(ErrorData::internal_error("Request cancelled; the database operation was not retried", None))
            }
        };
        self.progress.lock().unwrap_or_else(|e| e.into_inner()).remove(&token);
        result
    }

    async fn forward(
        &self,
        request: ClientRequest,
        context: RequestContext<RoleServer>,
    ) -> Result<ServerResult, ErrorData> {
        let peer = tokio::select! {
            peer = self.connect(context.peer.clone()) => peer?,
            _ = context.ct.cancelled() => return Err(ErrorData::internal_error("Request cancelled before forwarding", None)),
        };
        self.send(peer, request, context).await
    }
}

fn unavailable() -> ErrorData {
    ErrorData::internal_error("Database MCP is unavailable. Open the Codex workbench and complete password setup and migration; then retry discovery. Database operations are never retried automatically.", None)
}

fn protocol_error(error: ServiceError) -> ErrorData {
    match error {
        ServiceError::McpError(error) => error,
        _ => unavailable(),
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct StopArgs {
    #[serde(default)]
    confirm_interrupt: bool,
}

fn local_tools() -> Vec<Tool> {
    let schema: JsonObject =
        serde_json::from_value(json!({"type":"object","properties":{},"additionalProperties":false}))
            .expect("static schema");
    let mut tools: Vec<_> = [
        ("dbx_codex_open", "Open the full local DBX workbench in the Codex browser panel. Works before first setup; returns a URL without credentials."),
        ("dbx_codex_status", "Check the local workbench version and whether database MCP is ready."),
    ].into_iter().map(|(name, description)| Tool::new(name, description, schema.clone())
        .annotate(ToolAnnotations::new().read_only(true).destructive(false).idempotent(true).open_world(false))).collect();
    tools.push(Tool::new("dbx_codex_stop", "Stop the shared local DBX workbench. May interrupt other clients, writes, imports or backups. Set confirm_interrupt=true only after the user explicitly authorizes interrupting all work. Persistent data is retained.",
        serde_json::from_value::<JsonObject>(json!({"type":"object","properties":{"confirm_interrupt":{"type":"boolean","default":false}},"additionalProperties":false})).expect("static schema"))
        .annotate(ToolAnnotations::new().read_only(false).destructive(true).idempotent(true).open_world(false)));
    tools
}

impl ServerHandler for Gateway {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_tool_list_changed()
            .enable_resources().enable_resources_list_changed().build())
            .with_server_info(Implementation::new("dbx-codex", env!("CARGO_PKG_VERSION")))
            .with_instructions("Use dbx_codex_open to open the complete DBX workbench in Codex. Complete password setup and migration there before database operations. The workbench and database MCP share connections and permissions.")
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let first_page = request.as_ref().and_then(|r| r.cursor.as_ref()).is_none();
        let local = local_tools();
        let peer = match self.connect(context.peer.clone()).await {
            Ok(peer) => peer,
            Err(_) if first_page => return Ok(ListToolsResult::with_all_items(local)),
            Err(error) => return Err(error),
        };
        let mut request_message = ListToolsRequest::default();
        request_message.params = request;
        match self.send(peer, request_message.into(), context).await? {
            ServerResult::ListToolsResult(mut result) => {
                result.tools.retain(|tool| !local.iter().any(|own| own.name == tool.name));
                if first_page {
                    result.tools.extend(local);
                }
                Ok(result)
            }
            _ => Err(unavailable()),
        }
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if request.name == "dbx_codex_stop" {
            let args: StopArgs = serde_json::from_value(json!(request.arguments.unwrap_or_default()))
                .map_err(|_| ErrorData::invalid_params("Expected only confirm_interrupt: boolean", None))?;
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| unavailable())?;
            let response = client.post(self.handle.base_url.join("_codex/stop").map_err(|_| unavailable())?)
                .bearer_auth(&self.token)
                .json(&json!({"confirm_interrupt":args.confirm_interrupt,"instance_id":self.handle.instance_id}))
                .send().await.map_err(|_| ErrorData::internal_error("Stop response was lost; shutdown was not retried. Check workbench status before taking further action.", None))?;
            let is_error = !response.status().is_success();
            let body: serde_json::Value = response.json().await.map_err(|_| unavailable())?;
            let mut result = CallToolResult::structured(body);
            result.is_error = Some(is_error);
            return Ok(result.into());
        }
        if matches!(request.name.as_ref(), "dbx_codex_open" | "dbx_codex_status") {
            if request.arguments.as_ref().is_some_and(|args| !args.is_empty()) {
                return Err(ErrorData::invalid_params("This workbench tool takes no arguments", None));
            }
            let mut result =
                json!({"url":self.handle.base_url,"version":self.handle.version,"instance_id":self.handle.instance_id});
            if request.name == "dbx_codex_status" {
                result["database_ready"] = json!(self.connect(context.peer.clone()).await.is_ok());
                result["stop_requires_confirmation"] = json!(true);
                result["activity_tracking"] = json!("unavailable");
                if let Ok(client) = reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(2))
                    .build()
                {
                    if let Ok(response) = client
                        .get(self.handle.base_url.join("_codex/status").map_err(|_| unavailable())?)
                        .bearer_auth(&self.token)
                        .send()
                        .await
                    {
                        if response.status().is_success() {
                            if let Ok(status) = response.json::<serde_json::Value>().await {
                                if status["instance_id"] == self.handle.instance_id {
                                    for key in [
                                        "tracked_tasks",
                                        "active_mcp_sessions",
                                        "activity_tracking",
                                        "stop_requires_confirmation",
                                    ] {
                                        if let Some(value) = status.get(key) {
                                            result[key] = value.clone();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            return Ok(CallToolResult::structured(result).into());
        }
        match self.forward(CallToolRequest::new(request).into(), context).await? {
            ServerResult::CallToolResult(result) => Ok(result.into()),
            ServerResult::InputRequiredResult(result) => Ok(result.into()),
            ServerResult::CreateTaskResult(result) => Ok(result.into()),
            _ => Err(unavailable()),
        }
    }

    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        let peer = match self.connect(context.peer.clone()).await {
            Ok(peer) => peer,
            Err(_) if request.as_ref().and_then(|r| r.cursor.as_ref()).is_none() => {
                return Ok(ListResourcesResult::default())
            }
            Err(error) => return Err(error),
        };
        let mut message = ListResourcesRequest::default();
        message.params = request;
        match self.send(peer, message.into(), context).await? {
            ServerResult::ListResourcesResult(result) => Ok(result),
            _ => Err(unavailable()),
        }
    }

    async fn list_resource_templates(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        let peer = match self.connect(context.peer.clone()).await {
            Ok(peer) => peer,
            Err(_) if request.as_ref().and_then(|r| r.cursor.as_ref()).is_none() => {
                return Ok(ListResourceTemplatesResult::default())
            }
            Err(error) => return Err(error),
        };
        let mut message = ListResourceTemplatesRequest::default();
        message.params = request;
        match self.send(peer, message.into(), context).await? {
            ServerResult::ListResourceTemplatesResult(result) => Ok(result),
            _ => Err(unavailable()),
        }
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        match self.forward(ReadResourceRequest::new(request).into(), context).await? {
            ServerResult::ReadResourceResult(result) => Ok(result.into()),
            ServerResult::InputRequiredResult(result) => Ok(result.into()),
            _ => Err(unavailable()),
        }
    }
}

struct Notifications {
    downstream: Peer<RoleServer>,
    progress: ProgressMap,
}

impl Service<RoleClient> for Notifications {
    async fn handle_request(
        &self,
        request: ServerRequest,
        _: RequestContext<RoleClient>,
    ) -> Result<ClientResult, ErrorData> {
        match request {
            ServerRequest::PingRequest(_) => Ok(ClientResult::empty(())),
            _ => Err(ErrorData::invalid_request(
                "The workbench does not advertise server-initiated client capabilities",
                None,
            )),
        }
    }
    async fn handle_notification(
        &self,
        mut notification: ServerNotification,
        _: NotificationContext<RoleClient>,
    ) -> Result<(), ErrorData> {
        if let ServerNotification::ProgressNotification(progress) = &mut notification {
            let original =
                self.progress.lock().unwrap_or_else(|e| e.into_inner()).get(&progress.params.progress_token).cloned();
            let Some(original) = original else { return Ok(()) };
            progress.params.progress_token = original;
        }
        self.downstream.send_notification(notification).await.map_err(protocol_error)
    }
    fn get_info(&self) -> ClientConfig {
        ClientConfig::new(ClientCapabilities::default(), Implementation::new("dbx-codex", env!("CARGO_PKG_VERSION")))
    }
}
