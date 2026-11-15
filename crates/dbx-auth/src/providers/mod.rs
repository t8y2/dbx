pub mod http_callback;
pub mod ldap;
pub mod local;
pub mod oidc;
pub mod proxy_header;

pub use http_callback::HttpCallbackProvider;
pub use ldap::LdapAuthProvider;
pub use local::LocalAuthProvider;
pub use oidc::OidcAuthProvider;
pub use proxy_header::ProxyHeaderProvider;
