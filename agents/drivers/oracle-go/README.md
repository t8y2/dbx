# DBX Oracle Go Agent

Experimental native Oracle agent for DBX using `github.com/sijms/go-ora/v2`.

## Build

```bash
go build -o agent .
```

Cross-compile release builds use pure Go output:

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dbx-agent-oracle-linux-x64 .
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o dbx-agent-oracle-macos-aarch64 .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o dbx-agent-oracle-windows-x64.exe .
```

## Local DBX Test

Build the binary, then copy it into DBX's installed Oracle driver directory:

```bash
mkdir -p ~/.dbx/agents/drivers/oracle
cp agent ~/.dbx/agents/drivers/oracle/agent
chmod +x ~/.dbx/agents/drivers/oracle/agent
```

DBX prefers `agent` over `agent.jar`, so Oracle connections will use this Go
agent until the file is removed.

To restore the Java agent:

```bash
rm ~/.dbx/agents/drivers/oracle/agent
```

## OCI (thick driver) variant

The `oracle-oci` driver shipped for Windows x64 is this same agent compiled with
the `oci` build tag, which swaps the pure-Go `go-ora` driver for
`github.com/godror/godror` (Oracle Call Interface through CGO):

- Connections that select the OCI driver profile (`driver_profile: "oci"`) use
  the OCI driver; every other Oracle connection keeps the thin `go-ora` path,
  and a thin binary asked for OCI fails with an explicit "install the
  oracle-oci driver" error instead of a driver-not-found surprise.
- The agent builds a `user/password@connectString [AS SYSDBA]` DSN. Service
  name / SID / descriptor / TNS alias all come from the connection string DBX
  sends; `buildOCIDSN` in `oci_dsn.go` covers those rules and is unit tested
  without the build tag, so the regular CI test run covers them.
- Process-scoped client settings come from DBX's launch environment: the
  Instant Client directory is prepended to `PATH`, `TNS_ADMIN` points at
  `tnsnames.ora`, and `NLS_LANG` sets the client character set.

### Building the OCI variant (Windows x64)

Building requires the Oracle Instant Client **SDK** (headers + import library)
and a C compiler for CGO (MinGW-w64 GCC):

```powershell
$env:CGO_ENABLED=1
$env:GOOS="windows"; $env:GOARCH="amd64"
$env:CC="C:/mingw64/bin/gcc.exe"
$env:CGO_CFLAGS="-IC:/instantclient/sdk/include"
$env:CGO_LDFLAGS="-LC:/instantclient/sdk/lib/msvc"
# go.mod keeps `go 1.20` for the Windows 7-compatible thin build; the OCI
# variant needs Go >= 1.21 (godror), so -mod=mod updates go.mod in place.
go build -mod=mod -tags oci -trimpath -ldflags="-s -w" -o oracle-oci.exe .
```

At runtime only `oci.dll` is needed, located through `PATH`.
