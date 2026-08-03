use std::future::Future;

use rmcp::{
    model::{ClientJsonRpcMessage, ClientRequest, ErrorCode, ErrorData, ServerJsonRpcMessage},
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::{IntoTransport, Transport},
    RoleServer,
};

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
            let discovery_request_id = match &message {
                ClientJsonRpcMessage::Request(request)
                    if matches!(
                        &request.request,
                        ClientRequest::CustomRequest(custom) if custom.method == "server/discover"
                    ) =>
                {
                    Some(request.id.clone())
                }
                _ => None,
            };

            let Some(request_id) = discovery_request_id else {
                return Some(message);
            };

            // Reject discovery without closing so new clients can fall back to the legacy initialize flow.
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
