//! DBX multi-user authentication abstraction layer.
//!
//! Defines the unified provider contract (`AuthProvider`), user and role models,
//! in-memory session storage and the user-store abstraction. Providers shipped
//! by the upper layer (`dbx-web`): Local, LDAP, OIDC, HttpCallback (generic callback) and ProxyHeader.
//!
//! Layering rule (see crates/ARCHITECTURE.md): this crate must not depend on `dbx-core`;
//! user storage is injected from the upper layer via the `AuthUserStore` trait.

pub mod identity;
pub mod provider;
pub mod registry;
pub mod session;
pub mod user_store;

pub mod providers;

pub use identity::{map_role, AuthIdentity, UserRole};
pub use provider::{AuthError, AuthProvider, AuthProviderKind, CallbackParams, FormCredentials, LoginMode, ProviderInfo, RedirectInit, RedirectOutcome};
pub use registry::AuthRegistry;
pub use session::{SessionRecord, SessionStore, SessionUserSummary};
pub use user_store::{new_local_user, unix_now, AuthUserRecord, AuthUserStore};
