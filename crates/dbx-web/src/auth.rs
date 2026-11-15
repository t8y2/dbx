//! Web authentication layer: multi-provider login (local multi-user / LDAP / OIDC / callback / proxy)
//! and session management. The abstract contract lives in the `dbx-auth` crate; this module handles the HTTP wiring:
//! endpoint handlers, the auth middleware, cookies, rate limiting and the user-store adapter.

pub mod cookies;
pub mod handlers;
pub mod handlers_admin;
pub mod handlers_oidc;
pub mod middleware;
pub mod providers;
pub mod rate_limit;
pub mod user_store;

pub use cookies::session_token_from_headers;
pub(crate) use cookies::{middleware_api_path_suffix, session_cookie};
pub use handlers::{captcha, change_password, check, login, logout, providers, setup};
pub use handlers_admin::{create_user, delete_user, list_providers, list_sessions, list_users, save_providers, test_provider, update_user};
pub use handlers_oidc::{authorize as oidc_authorize, callback as oidc_callback};
pub use middleware::auth_middleware;
pub(crate) use middleware::start_session_sweeper;
pub use rate_limit::LoginRateLimiter;
pub(crate) use providers::assemble_registry;
pub use user_store::StorageAuthUserStore;
