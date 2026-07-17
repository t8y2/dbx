# DBX Xugu Agent

Native XuguDB agent for DBX using `gitee.com/XuguDB/go-xugu-driver`.

## Build

```bash
go build -o agent .
```

Cross-compile release builds use pure Go output:

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dbx-agent-xugu-linux-x64 .
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o dbx-agent-xugu-macos-aarch64 .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dbx-agent-xugu-windows-x64.exe .
```

## Local DBX Test

Build the binary, then copy it into DBX's installed XuguDB driver directory:

```bash
mkdir -p ~/.dbx/agents/drivers/xugu
cp agent ~/.dbx/agents/drivers/xugu/agent
chmod +x ~/.dbx/agents/drivers/xugu/agent
```

DBX prefers `agent` over `agent.jar`, so XuguDB connections will use this Go
agent until the file is removed.

To restore the Java/JDBC agent:

```bash
rm ~/.dbx/agents/drivers/xugu/agent
```
