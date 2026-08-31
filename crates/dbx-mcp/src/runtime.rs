use std::{
    env, fs,
    net::{IpAddr, SocketAddr},
};

use crate::http_auth::HttpAuth;

const DEFAULT_HTTP_HOST: &str = "127.0.0.1";
const DEFAULT_HTTP_PORT: u16 = 5225;
const DEFAULT_HTTP_PATH: &str = "/mcp";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpTransport {
    Stdio,
    StreamableHttp,
}

pub struct RuntimeConfig {
    pub transport: McpTransport,
    pub http: Option<HttpRuntimeConfig>,
}

pub struct HttpRuntimeConfig {
    pub(crate) bind_addr: SocketAddr,
    pub(crate) path: String,
    pub(crate) auth: HttpAuth,
    pub(crate) allowed_hosts: Vec<String>,
}

impl HttpRuntimeConfig {
    pub fn new(bind_addr: SocketAddr, path: String, auth: HttpAuth, allowed_hosts: Vec<String>) -> Self {
        Self { bind_addr, path, auth, allowed_hosts }
    }

    pub fn bind_addr(&self) -> SocketAddr {
        self.bind_addr
    }
}

impl RuntimeConfig {
    /// Parses DBX MCP's small runtime surface without adding a command-line dependency.
    /// `stdio` remains the default, preserving all existing npm and native launchers.
    pub fn from_environment_and_args() -> Result<Self, String> {
        let mut transport = env::var("DBX_MCP_TRANSPORT").ok();
        let mut host = env::var("DBX_MCP_HTTP_HOST").ok();
        let mut port = env::var("DBX_MCP_HTTP_PORT").ok();
        let mut path = env::var("DBX_MCP_HTTP_PATH").ok();
        let mut allow_remote = env_flag("DBX_MCP_HTTP_ALLOW_REMOTE")?;
        let mut explicit_allow_remote = false;

        let mut arguments = env::args().skip(1);
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--stdio" => transport = Some("stdio".into()),
                "--http" => transport = Some("streamable-http".into()),
                "--http-allow-remote" => {
                    allow_remote = true;
                    explicit_allow_remote = true;
                }
                "--transport" => transport = Some(required_argument(&mut arguments, "--transport")?),
                "--http-host" => host = Some(required_argument(&mut arguments, "--http-host")?),
                "--http-port" => port = Some(required_argument(&mut arguments, "--http-port")?),
                "--http-path" => path = Some(required_argument(&mut arguments, "--http-path")?),
                _ => {
                    if let Some(value) = argument.strip_prefix("--transport=") {
                        transport = Some(value.into());
                    } else if let Some(value) = argument.strip_prefix("--http-host=") {
                        host = Some(value.into());
                    } else if let Some(value) = argument.strip_prefix("--http-port=") {
                        port = Some(value.into());
                    } else if let Some(value) = argument.strip_prefix("--http-path=") {
                        path = Some(value.into());
                    } else {
                        return Err(format!("unknown DBX MCP argument: {argument}"));
                    }
                }
            }
        }

        let transport = parse_transport(transport.as_deref().unwrap_or("stdio"))?;
        if transport == McpTransport::Stdio {
            return Ok(Self { transport, http: None });
        }

        let host = host.unwrap_or_else(|| DEFAULT_HTTP_HOST.into());
        let ip = host.parse::<IpAddr>().map_err(|_| "DBX_MCP_HTTP_HOST must be an IP address".to_string())?;
        let port = port
            .unwrap_or_else(|| DEFAULT_HTTP_PORT.to_string())
            .parse::<u16>()
            .map_err(|_| "DBX_MCP_HTTP_PORT must be a valid TCP port".to_string())?;
        let bind_addr = SocketAddr::new(ip, port);
        let path = path.unwrap_or_else(|| DEFAULT_HTTP_PATH.into());
        validate_path(&path)?;

        let is_loopback = ip.is_loopback();
        if !is_loopback && !(allow_remote && explicit_allow_remote) {
            return Err(
                "non-loopback HTTP binding requires both DBX_MCP_HTTP_ALLOW_REMOTE=1 and --http-allow-remote".into()
            );
        }

        let allowed_hosts = comma_separated_env("DBX_MCP_HTTP_ALLOWED_HOSTS");
        let allowed_origins = comma_separated_env("DBX_MCP_HTTP_ALLOWED_ORIGINS");
        if !is_loopback && (allowed_hosts.is_empty() || allowed_origins.is_empty()) {
            return Err(
                "non-loopback HTTP binding requires DBX_MCP_HTTP_ALLOWED_HOSTS and DBX_MCP_HTTP_ALLOWED_ORIGINS".into(),
            );
        }

        let token = http_token_from_environment()?;
        let auth = HttpAuth::new(token, allowed_origins.clone(), is_loopback)?;
        let allowed_hosts =
            if is_loopback { vec!["localhost".into(), "127.0.0.1".into(), "::1".into()] } else { allowed_hosts };

        Ok(Self { transport, http: Some(HttpRuntimeConfig { bind_addr, path, auth, allowed_hosts }) })
    }
}

fn parse_transport(value: &str) -> Result<McpTransport, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "stdio" => Ok(McpTransport::Stdio),
        "http" | "streamable-http" | "streamable_http" => Ok(McpTransport::StreamableHttp),
        _ => Err("DBX_MCP_TRANSPORT must be stdio or streamable-http".into()),
    }
}

fn required_argument(arguments: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    arguments.next().filter(|value| !value.starts_with("--")).ok_or_else(|| format!("{name} requires a value"))
}

fn env_flag(name: &str) -> Result<bool, String> {
    match env::var(name) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" => Ok(true),
            "0" | "false" | "no" | "" => Ok(false),
            _ => Err(format!("{name} must be true or false")),
        },
        Err(env::VarError::NotPresent) => Ok(false),
        Err(env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid UTF-8")),
    }
}

fn comma_separated_env(name: &str) -> Vec<String> {
    env::var(name)
        .ok()
        .into_iter()
        .flat_map(|value| {
            value.split(',').map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned).collect::<Vec<_>>()
        })
        .collect()
}

fn http_token_from_environment() -> Result<String, String> {
    let inline_token = env::var("DBX_MCP_HTTP_TOKEN").ok();
    let token_file = env::var("DBX_MCP_HTTP_TOKEN_FILE").ok();
    match (inline_token, token_file) {
        (Some(_), Some(_)) => Err("set only one of DBX_MCP_HTTP_TOKEN or DBX_MCP_HTTP_TOKEN_FILE".into()),
        (Some(token), None) if !token.trim().is_empty() => Ok(token),
        (None, Some(path)) => fs::read_to_string(&path)
            .map_err(|error| format!("failed to read DBX_MCP_HTTP_TOKEN_FILE: {error}"))
            .map(|token| token.trim_end_matches(['\r', '\n']).to_owned())
            .and_then(|token| {
                (!token.is_empty()).then_some(token).ok_or_else(|| "DBX_MCP_HTTP_TOKEN_FILE is empty".into())
            }),
        _ => Err("Streamable HTTP requires DBX_MCP_HTTP_TOKEN or DBX_MCP_HTTP_TOKEN_FILE".into()),
    }
}

fn validate_path(path: &str) -> Result<(), String> {
    if path == "/" || !path.starts_with('/') || path.ends_with('/') || path.contains('?') || path.contains('#') {
        return Err("DBX_MCP_HTTP_PATH must be an absolute path such as /mcp".into());
    }
    Ok(())
}
