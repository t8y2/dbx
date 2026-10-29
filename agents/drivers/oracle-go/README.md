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
- The agent builds a logfmt DSN with `connectString`, `user`, and `password`. Service
  name / SID / descriptor / TNS alias all come from the connection string DBX
  sends; `buildOCIDSN` in `oci_dsn.go` covers those rules and is unit tested
  without the build tag, so the regular CI test run covers them.
- Process-scoped client settings come from DBX's launch environment: the
  Instant Client directory is prepended to `PATH`, `TNS_ADMIN` points at
  `tnsnames.ora`. `NLS_LANG` supplies OCI locale settings, but godror explicitly
  transfers string data as UTF-8, independently of its charset component.

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

## Legacy Chinese bytes in US7ASCII databases

Some old databases advertise `US7ASCII` while ordinary character columns contain
unconverted GBK, GB18030, Big5 or UTF-8 bytes. Changing `NLS_LANG` cannot tell DBX
how to interpret those bytes. Select the **Thin** driver, open **Advanced**, and
set **Legacy encoding compatibility** to the historical encoding verified from
the stored bytes. Ordinary connections keep **Default (recommended)**. The same
setting can be supplied in URL parameters:

```text
DBX_LEGACY_CHARSET=ZHS16GBK
```

Supported values are `ZHS16GBK`, `ZHS32GB18030`, `ZHT16MSWIN950`, and `AL32UTF8`.
This opt-in mode preserves US7ASCII on the wire to avoid server conversion and
uses the chosen encoding for ordinary text, SQL, and metadata. National character
data retains its independent Unicode converter. RAW and BLOB data stay binary.
Unrepresentable SQL or ordinary string binds fail before execution.

The connection checks that the database actually uses US7ASCII and rejects this
option with OCI or with a conflicting `CHARSET`/`CLIENT CHARSET` option. Standard
connections keep their existing character conversion. This compatibility mode
does not change the database character set or recover data already replaced by
question marks.

To run the opt-in integration tests, provide a private JSON file containing
`connectParams` (`host`, `port`, `database`, `username`, `password`, and optionally
`connection_string`) for a disposable US7ASCII database with CREATE TABLE access:

```bash
DBX_LIVE_ORACLE_LEGACY_CONFIG=/private/path/us7ascii.json \
  go test -run TestLiveOracleLegacyCharset -v
```

The test creates and removes its own tables. An optional
`DBX_LIVE_ORACLE_UNICODE_CONFIG` file enables the test that rejects this mode on
a Unicode database.

### Live regression results (2026-10-28)

Verified against an isolated Oracle 19c database with `NLS_CHARACTERSET=US7ASCII`
and `NLS_NCHAR_CHARACTERSET=AL16UTF16`. Fixtures insert known raw bytes, so the
expected encoding is independent of the client converter being tested.

| Historical encoding | Stored bytes (hex) | Standard Thin read | Legacy read |
| --- | --- | --- | --- |
| ZHS16GBK | D6D0CEC4 | `????` | 中文 |
| AL32UTF8 | E4B8ADE69687F09F9880 | `??????????` | 中文😀 |
| ZHS32GB18030 | D6D0CEC49439FC36 | `?????9?6` | 中文😀 |
| ZHT16MSWIN950 | A4A4A4E5 | `????` | 中文 |

All four cases passed reads, bound writes with byte-for-byte verification,
prepared statements, transaction rollback, CLOB data, table comments, Chinese
column aliases, and connection isolation. NVARCHAR2 retained `中文😀`, and RAW
retained `D6D0CEC4`. GBK/Big5 rejected unrepresentable string binds before writing.
The live AL32UTF8 database check also rejected accidental use of legacy mode.

An agent RPC comparison confirmed that changing `NLS_LANG` between AL32UTF8,
ZHS16GBK, and US7ASCII leaves the standard Thin result as `????`; enabling
`DBX_LEGACY_CHARSET=ZHS16GBK` restores `中文` without changing the stored bytes.
