//! Compatibility shim for the `server/discover` probe used by agents that
//! predate the final `2026-07-28` lifecycle.
//!
//! rmcp implements `server/discover` natively, but it rejects a probe that omits
//! the `_meta` fields the spec made mandatory (`protocolVersion` and
//! `clientCapabilities`) with `-32602 Invalid Params`. Its client-side
//! classification treats that code as a *modern* server rejection, so a client
//! that probes discovery before falling back to `initialize` does not fall back
//! and the connection fails.
//!
//! Before the SDK upgrade DBX answered every `server/discover` request with
//! `-32601 Method not found`, which those clients do treat as "this server is
//! legacy, use `initialize`". This shim keeps that negotiated behaviour for a
//! bare probe while leaving a well-formed probe to the SDK, so modern agents
//! still discover `2026-07-28` and older ones keep their established fallback.

use std::future::Future;

use rmcp::{
    model::{
        ClientJsonRpcMessage, ClientRequest, ErrorCode, ErrorData, GetExtensions, RequestMetaObject,
        ServerJsonRpcMessage,
    },
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::{IntoTransport, Transport},
    RoleServer,
};

/// Wrap a server transport so a bare `server/discover` probe is answered with
/// `METHOD_NOT_FOUND` instead of the SDK's `INVALID_PARAMS`.
pub fn with_legacy_discovery_fallback<T, E, A>(transport: T) -> impl Transport<RoleServer, Error = E> + 'static
where
    T: IntoTransport<RoleServer, E, A>,
    E: std::error::Error + Send + Sync + 'static,
{
    LegacyDiscoveryFallback { inner: transport.into_transport() }
}

struct LegacyDiscoveryFallback<T> {
    inner: T,
}

impl<T> Transport<RoleServer> for LegacyDiscoveryFallback<T>
where
    T: Transport<RoleServer>,
{
    type Error = T::Error;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleServer>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        self.inner.send(item)
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleServer>> {
        loop {
            let message = self.inner.receive().await?;

            let Some(request_id) = bare_discovery_probe_id(&message) else {
                return Some(message);
            };

            // Reject the probe without closing the transport so the client can
            // fall back to the legacy `initialize` handshake, exactly as it did
            // before the SDK learned about `server/discover`.
            let error = ErrorData::new(ErrorCode::METHOD_NOT_FOUND, "Method not found", None);
            if self.inner.send(ServerJsonRpcMessage::error(error, Some(request_id))).await.is_err() {
                return None;
            }
        }
    }

    fn close(&mut self) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.inner.close()
    }
}

/// The request id of a `server/discover` probe that carries no request
/// metadata at all.
///
/// Returns `None` for every other message, including a probe that carries
/// `_meta`, so the SDK answers those. Deciding on the presence of `_meta` rather
/// than on its completeness keeps the SDK in charge of validating a
/// well-intentioned modern request.
fn bare_discovery_probe_id(message: &ClientJsonRpcMessage) -> Option<rmcp::model::RequestId> {
    let ClientJsonRpcMessage::Request(request) = message else {
        return None;
    };
    let ClientRequest::DiscoverRequest(discover) = &request.request else {
        return None;
    };
    // The SDK keeps a request's `_meta` in the request extensions after
    // deserializing it, so an absent or empty entry means the client probed
    // discovery without any per-request metadata.
    let has_meta = discover.extensions().get::<RequestMetaObject>().is_some_and(|meta| !meta.0.is_empty());
    (!has_meta).then(|| request.id.clone())
}

#[cfg(test)]
mod tests {
    use rmcp::model::{
        ClientJsonRpcMessage, ClientRequest, DiscoverRequest, DiscoverRequestParams, GetExtensions, JsonRpcRequest,
        NumberOrString, RequestMetaObject,
    };

    use super::bare_discovery_probe_id;

    fn discover_probe(id: i64, meta: Option<RequestMetaObject>) -> ClientJsonRpcMessage {
        let mut discover = DiscoverRequest::new(DiscoverRequestParams {});
        if let Some(meta) = meta {
            discover.extensions_mut().insert(meta);
        }
        ClientJsonRpcMessage::Request(JsonRpcRequest::new(
            NumberOrString::Number(id),
            ClientRequest::DiscoverRequest(discover),
        ))
    }

    #[test]
    fn a_bare_discovery_probe_is_reported_so_it_can_be_rejected_as_legacy() {
        let message = discover_probe(1, None);
        assert_eq!(bare_discovery_probe_id(&message), Some(NumberOrString::Number(1)));
    }

    #[test]
    fn a_probe_with_request_metadata_is_left_to_the_sdk() {
        let mut meta = RequestMetaObject::default();
        meta.insert("io.modelcontextprotocol/protocolVersion".to_string(), serde_json::json!("2026-07-28"));
        let message = discover_probe(7, Some(meta));
        assert_eq!(bare_discovery_probe_id(&message), None);
    }
}
