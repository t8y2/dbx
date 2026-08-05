pub mod backend;
pub mod paths;
pub mod server;
pub mod session;
pub mod transport;

pub use backend::{ConnectionSummary, DbxBackend, LocalBackend, WebBackend};
pub use dbx_core::mongo_shell as mongo;
pub use server::{DbxMcpServer, McpScope};
pub use session::McpSessionStore;
pub use transport::with_legacy_discovery_fallback;
