use super::{HttpTunnelManager, ProxyTunnelManager, TunnelManager};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(super) fn transport_prefix(connection_id: &str) -> String {
    format!("{connection_id}:zookeeper:")
}

/// A unique startup generation owns every partially created chain. Retaining
/// this guard in the published endpoint also covers cancellation before adoption.
pub(super) struct ZooKeeperTransportGuard {
    prefix: String,
    published: AtomicBool,
    tunnels: Arc<TunnelManager>,
    proxy_tunnels: Arc<ProxyTunnelManager>,
    http_tunnels: Arc<HttpTunnelManager>,
}

impl std::fmt::Debug for ZooKeeperTransportGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZooKeeperTransportGuard").field("prefix", &self.prefix).finish_non_exhaustive()
    }
}

impl ZooKeeperTransportGuard {
    pub(super) fn new(
        connection_id: &str,
        tunnels: Arc<TunnelManager>,
        proxy_tunnels: Arc<ProxyTunnelManager>,
        http_tunnels: Arc<HttpTunnelManager>,
    ) -> Self {
        Self {
            published: AtomicBool::new(false),
            prefix: format!("{}{}:", transport_prefix(connection_id), uuid::Uuid::new_v4()),
            tunnels,
            proxy_tunnels,
            http_tunnels,
        }
    }

    pub(super) fn mark_published(&self) {
        self.published.store(true, Ordering::Release);
    }
    pub(super) fn is_published(&self) -> bool {
        self.published.load(Ordering::Acquire)
    }

    pub(super) fn endpoint_id(&self, index: usize) -> String {
        format!("{}{index}", self.prefix)
    }

    pub(super) async fn stop(&self) {
        self.tunnels.stop_tunnels_with_prefix(&self.prefix).await;
        self.proxy_tunnels.stop_tunnels_with_prefix(&self.prefix).await;
        self.http_tunnels.stop_tunnels_with_prefix(&self.prefix).await;
    }
}

impl Drop for ZooKeeperTransportGuard {
    fn drop(&mut self) {
        let prefix = self.prefix.clone();
        let tunnels = self.tunnels.clone();
        let proxy_tunnels = self.proxy_tunnels.clone();
        let http_tunnels = self.http_tunnels.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                tunnels.stop_tunnels_with_prefix(&prefix).await;
                proxy_tunnels.stop_tunnels_with_prefix(&prefix).await;
                http_tunnels.stop_tunnels_with_prefix(&prefix).await;
            });
        }
    }
}

/// Cleans a routed attempt if its caller is canceled after endpoint publication.
/// The stamp check prevents a delayed cleanup from touching a replacement.
pub struct ZooKeeperTransportCancellation<'a> {
    pending: Option<(&'a super::AppState, String, super::ConnectionTransportStamp)>,
}

impl<'a> ZooKeeperTransportCancellation<'a> {
    pub fn new(state: &'a super::AppState, connection_id: &str, attempt: &super::ConnectionEndpointAttempt) -> Self {
        Self::for_endpoint(state, connection_id, &attempt.stamp, attempt.endpoint.as_ref().ok())
    }

    pub(super) fn for_endpoint(
        state: &'a super::AppState,
        connection_id: &str,
        stamp: &super::ConnectionTransportStamp,
        endpoint: Option<&super::ConnectionEndpoint>,
    ) -> Self {
        let pending = endpoint
            .filter(|endpoint| endpoint.zookeeper_endpoint_routes.is_some())
            .map(|_| (state, connection_id.to_owned(), stamp.clone()));
        Self { pending }
    }

    pub fn disarm(&mut self) {
        self.pending = None;
    }
}

impl Drop for ZooKeeperTransportCancellation<'_> {
    fn drop(&mut self) {
        if let Some((state, connection_id, stamp)) = self.pending.take() {
            crate::query::pl_debug::retire_unpublished_zookeeper_transport(state, &connection_id, &stamp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::ProxyType;
    use std::time::Duration;

    async fn start_proxy(guard: &ZooKeeperTransportGuard, index: usize) -> u16 {
        guard
            .proxy_tunnels
            .start_tunnel(&guard.endpoint_id(index), ProxyType::Socks5, "127.0.0.1", 1, "", "", "remote.invalid", 2181)
            .await
            .unwrap()
    }

    async fn wait_removed(proxy: &ProxyTunnelManager, id: &str) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while proxy.local_port(id).await.is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn canceled_partial_startup_cleans_only_its_generation() {
        let tunnels = Arc::new(TunnelManager::default());
        let proxy = Arc::new(ProxyTunnelManager::new());
        let http = Arc::new(HttpTunnelManager::new());
        let current = Arc::new(ZooKeeperTransportGuard::new("conn", tunnels.clone(), proxy.clone(), http.clone()));
        let current_port = start_proxy(&current, 0).await;
        let failed = ZooKeeperTransportGuard::new("conn", tunnels, proxy.clone(), http);
        let failed_id = failed.endpoint_id(0);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            start_proxy(&failed, 0).await;
            ready_tx.send(()).unwrap();
            std::future::pending::<()>().await;
            drop(failed);
        });
        ready_rx.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        wait_removed(&proxy, &failed_id).await;
        assert_eq!(proxy.local_port(&current.endpoint_id(0)).await, Some(current_port));
        let retained = current.clone();
        let current_id = current.endpoint_id(0);
        drop(current);
        assert_eq!(proxy.local_port(&current_id).await, Some(current_port));
        drop(retained);
        wait_removed(&proxy, &current_id).await;
    }

    #[tokio::test]
    async fn partial_startup_failure_stops_all_created_endpoints() {
        let proxy = Arc::new(ProxyTunnelManager::new());
        let guard = ZooKeeperTransportGuard::new(
            "conn",
            Arc::new(TunnelManager::default()),
            proxy.clone(),
            Arc::new(HttpTunnelManager::new()),
        );
        start_proxy(&guard, 0).await;
        start_proxy(&guard, 1).await;
        // The same stop path runs before propagating a later chain startup error.
        guard.stop().await;
        assert!(proxy.local_port(&guard.endpoint_id(0)).await.is_none());
        assert!(proxy.local_port(&guard.endpoint_id(1)).await.is_none());
    }
}
