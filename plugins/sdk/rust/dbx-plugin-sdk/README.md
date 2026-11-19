# dbx-plugin-sdk

Rust SDK for DBX sidecar protocol v1.

It provides:

- `plugin/initialize` negotiation and backend identity reporting;
- concurrent JSON-RPC request dispatch through a bounded worker pool;
- JSON-RPC responses and plugin events;
- JSON Lines and framed transports;
- binary input/output channels for framed plugins;
- bounded JSON and binary message sizes.

## Minimal sidecar

```rust
use dbx_plugin_sdk::{
    PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer,
    RequestContext,
};
use serde_json::{json, Value};

struct Example;

impl PluginHandler for Example {
    fn handle(
        &self,
        _context: RequestContext,
        method: &str,
        params: Value,
        emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        match method {
            "example/echo" => {
                emitter.event("example/progress", json!({ "done": true }))?;
                Ok(params)
            }
            _ => Err(PluginError::method_not_found(method)),
        }
    }
}

fn main() -> std::io::Result<()> {
    PluginServer::new(
        PluginMetadata::new("vendor.example", env!("CARGO_PKG_VERSION"))
            .with_capability("events"),
        Example,
    )
    .serve()
}
```

The metadata ID and version must exactly match `manifest.json`; DBX rejects a mismatched backend during initialization.

## Framed transport

Use framed transport for PTY, SFTP, file transfer, or other binary streams:

```rust
use dbx_plugin_sdk::{PluginServer, PluginTransport};

PluginServer::new(metadata, handler)
    .transport(PluginTransport::Framed)
    .serve()?;
```

Implement `PluginHandler::handle_binary` for host-to-plugin frames and call `PluginEmitter::binary` for plugin-to-host frames. The manifest must declare `"transport": "stdio-framed"`; workbench UI binary access requires the `host.binary` permission.

The server defaults to 2-16 worker threads (based on available parallelism) and a 256-job queue. CPU-heavy or latency-sensitive plugins can tune both without falling back to unbounded thread creation:

```rust
PluginServer::new(metadata, handler)
    .worker_threads(8)
    .work_queue_capacity(512)
    .serve()?;
```

## Process rules

- Reserve stdout for protocol traffic.
- Write diagnostics to stderr.
- Keep plugin-owned sessions in the handler or another process-wide registry.
- Make connect/disconnect idempotent.
- Use application-level cancellation and chunk acknowledgements for long-running transfers.
- Never send connection secrets in plugin events or workbench context.

See `plugins/examples/hello-workbench` for a complete package.
