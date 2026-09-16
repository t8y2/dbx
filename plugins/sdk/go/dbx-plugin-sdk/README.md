# DBX Go plugin SDK

Go SDK for DBX native sidecar plugins using protocol v1 over JSON Lines or framed stdin/stdout.

```go
metadata := dbxpluginsdk.Metadata{
    ID: "vendor.example",
    Version: "1.0.0",
    Capabilities: []string{"events"},
}
server := dbxpluginsdk.NewServer(metadata, handler)
if err := server.Serve(); err != nil {
    log.Fatal(err)
}
```

Keep stdout reserved for protocol messages. Write diagnostics to stderr.

Use framed transport for binary input and output:

```go
server := dbxpluginsdk.NewServer(metadata, handler).
    WithTransport(dbxpluginsdk.TransportFramed)
```

Handlers can implement `HandleBinary(channel string, data []byte, emitter *Emitter) *PluginError` for host-to-plugin frames. Use `Emitter.Binary` for plugin-to-host frames and application-level chunking for large transfers.
