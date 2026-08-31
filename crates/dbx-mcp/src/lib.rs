pub mod backend;
pub mod diagnostics;
pub mod http;
pub mod http_auth;
pub mod paths;
pub mod runtime;
pub mod server;
pub mod session;
pub mod transport;

pub use backend::{ConnectionSummary, DbxBackend, LocalBackend, WebBackend};
pub use dbx_core::mongo_shell as mongo;
pub use http::{serve_streamable_http_on_listener, serve_streamable_http_with_shutdown, streamable_http_router};
pub use http_auth::HttpAuth;
pub use runtime::{HttpRuntimeConfig, McpTransport, RuntimeConfig};
pub use server::{DbxMcpServer, McpScope};
pub use session::McpSessionStore;
pub use transport::with_legacy_discovery_fallback;
