# DBX Go plugin SDK

Go SDK for DBX native sidecar plugins using protocol v1 over JSON Lines stdin/stdout.

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
