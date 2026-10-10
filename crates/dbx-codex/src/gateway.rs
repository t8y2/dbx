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

fn local_tools() -> Vec<Tool> {
    let schema: JsonObject =
        serde_json::from_value(json!({"type":"object","properties":{},"additionalProperties":false}))
            .expect("static schema");
    [
        ("dbx_codex_open", "Open the full local DBX workbench in the Codex browser panel. Works before first setup; returns a URL without credentials."),
        ("dbx_codex_status", "Check the local workbench version and whether database MCP is ready."),
    ].into_iter().map(|(name, description)| Tool::new(name, description, schema.clone())
        .annotate(ToolAnnotations::new().read_only(true).destructive(false).idempotent(true).open_world(false))).collect()
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
        if matches!(request.name.as_ref(), "dbx_codex_open" | "dbx_codex_status") {
            if request.arguments.as_ref().is_some_and(|args| !args.is_empty()) {
                return Err(ErrorData::invalid_params("This workbench tool takes no arguments", None));
            }
            let mut result =
                json!({"url":self.handle.base_url,"version":self.handle.version,"instance_id":self.handle.instance_id});
            if request.name == "dbx_codex_status" {
                result["database_ready"] = json!(self.connect(context.peer.clone()).await.is_ok());
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
