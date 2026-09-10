# DBX

DBX is a lightweight, self-hosted database client for the browser. It supports 90+ databases, including MySQL, PostgreSQL, SQLite, Redis, MongoDB, DuckDB, ClickHouse, SQL Server, Oracle, and Elasticsearch.

- Official website: https://dbxio.com
- Documentation: https://dbxio.com/en/docs/getting-started
- 中文文档: https://dbxio.com/cn/docs/getting-started
- Source code: https://github.com/t8y2/dbx

## Quick Start

Set a strong access password and start DBX:

```bash
docker run -d \
  --pull=always \
  --name dbx \
  -p 4224:4224 \
  -e DBX_PASSWORD='change-this-password' \
  -v dbx-data:/app/data \
  --restart unless-stopped \
  t8y2/dbx:latest
```

Open `http://localhost:4224` and sign in with username `admin` (or the value of `DBX_USERNAME`) and the value of `DBX_PASSWORD`.

The image supports `linux/amd64` and `linux/arm64`.

## Docker Compose

```yaml
services:
  dbx:
    image: t8y2/dbx:latest
    pull_policy: always
    environment:
      DBX_PASSWORD: change-this-password
    ports:
      - "4224:4224"
    volumes:
      - dbx-data:/app/data
    restart: unless-stopped

volumes:
  dbx-data:
```

Start or update the service:

```bash
docker compose up -d --pull always
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DBX_PASSWORD` | Not set | Password of the pre-configured DBX Web login account. Set a strong value for server deployments. |
| `DBX_USERNAME` | `admin` | Username of the pre-configured account (used with `DBX_PASSWORD`). |
| `DBX_DISABLE_PASSWORD` | `false` | Disables login protection when set to `true`. Do not use this on an untrusted network. |
| `DBX_DATA_DIR` | `/app/data` | Directory containing the DBX database, plugins, drivers, and other persistent data. |
| `DBX_PORT` | `4224` | HTTP port inside the container. |
| `DBX_PUBLIC_BASE_PATH` | `/` | URL prefix for reverse-proxy deployments, for example `/dbx`. |
| `DBX_WEB_MCP_TOKEN` | Not set | Enables native Streamable HTTP MCP with this bearer token. Keep it secret. |
| `DBX_WEB_MCP_TOKEN_FILE` | Not set | Read the native MCP bearer token from a file, for example a mounted Docker secret. Cannot be combined with `DBX_WEB_MCP_TOKEN`. |
| `DBX_WEB_MCP_ALLOWED_HOSTS` | Not set | Required when native MCP is enabled. Comma-separated public Host authorities, including ports when present. |
| `DBX_WEB_MCP_ALLOWED_ORIGINS` | Not set | Comma-separated browser Origins allowed to call native MCP. Optional for non-browser MCP clients. |

Without `DBX_PASSWORD`, the first visit shows a setup page that creates the initial username and password. Signed-in users can create and manage additional accounts under **Settings → Security**.

Persist `/app/data` with a named volume or bind mount. Removing this data removes saved connections and other DBX application data.

## Native HTTP MCP

Native MCP is disabled by default. When enabled, it is served by the existing DBX Web listener at `/mcp`; no second container port is required. With a host mapping of `4225:4224`, configure the public authority clients use:

```yaml
environment:
  DBX_WEB_MCP_TOKEN: replace-with-a-long-random-secret
  DBX_WEB_MCP_ALLOWED_HOSTS: localhost:4225
ports:
  - "4225:4224"
```

The MCP endpoint is `http://localhost:4225/mcp` and requires `Authorization: Bearer <DBX_WEB_MCP_TOKEN>`. For a reverse proxy, set `DBX_WEB_MCP_ALLOWED_HOSTS` to the public hostname (and port if non-default); with `DBX_PUBLIC_BASE_PATH: /dbx`, the endpoint becomes `/dbx/mcp`. Browser-based clients must also set `DBX_WEB_MCP_ALLOWED_ORIGINS` to their exact `https://host[:port]` origin.

The token is a deployment credential: rotate it through your secret manager and restart the container. DBX Desktop offers a local **Rotate Token** action for its separately managed loopback HTTP MCP service.

DuckDB is delivered as a standalone native driver instead of being embedded in `dbx-web`. Install the DuckDB driver from Driver Manager after the first launch. It is stored under `/app/data/agents` and remains available across container upgrades when `/app/data` is persisted.

## Reverse Proxy

To publish DBX under a path such as `https://example.com/dbx`, set:

```yaml
environment:
  DBX_PUBLIC_BASE_PATH: /dbx
```

Configure the reverse proxy to forward the same `/dbx` prefix to port `4224` in the container.

## China Mirror

For faster pulls in mainland China, use the CNB mirror:

```text
docker.cnb.cool/dbxio.com/dbx:latest
```

## 1Panel

DBX is available from the 1Panel app store. See the official installation guide for port, password, persistence, and access instructions:

- 中文教程: https://dbxio.com/cn/docs/1panel
- English guide: https://dbxio.com/en/docs/1panel

## Tags

- `latest`: latest stable DBX release
- `<version>`: a specific DBX release
- `dev`: current development image

For production deployments, pin a version tag when you need controlled upgrades.
