# Docker Workbench

DBX can manage an existing Docker Engine from both the Tauri desktop application and the DBX Web deployment. Docker connections reuse DBX connection groups, cloud sync metadata, production/read-only markers, and shared SSH transport profiles.

## Supported transports

| Protocol | Target | Requirements |
| --- | --- | --- |
| HTTP | Docker Engine TCP API, normally `127.0.0.1:2375` | Remote clear-text HTTP shows a root-equivalent access warning. Prefer HTTPS or an SSH transport. |
| HTTPS | Docker Engine TLS API, normally port `2376` | CA path and optional client certificate/private-key paths must be readable by the DBX backend. |
| Unix | A local socket such as `/var/run/docker.sock` | The DBX backend must run on Unix and have socket permission. Windows named pipes are not supported. |
| Unix-Over-Nc | A Unix socket on an SSH host | Select exactly one SSH profile; the remote host must provide `nc -U`. |
| Unix-Over-Nc-Sudo | A privileged Unix socket on an SSH host | The remote host must allow `sudo -n -- nc -U ...` without a password. Interactive sudo is intentionally unsupported. |

API version `auto` discovers the Engine version through `/version`. Docker API versions older than 1.24 are rejected.

## Secure Web deployment

The default DBX Compose deployment does **not** mount the Docker socket. Mount it only when the DBX Web instance is trusted and access-controlled:

```yaml
services:
  dbx:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

Access to the Docker socket is root-equivalent. Any user who can control Docker can mount host paths, access host data, and start privileged workloads. DBX therefore rejects every Docker write operation when Web password protection is disabled (`DBX_DISABLE_PASSWORD=true`). This includes lifecycle operations, resource creation/deletion, and image pulls. A connection marked read-only rejects the same operations in the shared backend core.

For a remote TLS Engine, mount certificates read-only and configure their **backend file paths** in the connection:

```yaml
services:
  dbx:
    volumes:
      - ./docker-certs:/run/secrets/docker:ro
```

Example paths:

- CA: `/run/secrets/docker/ca.pem`
- Client certificate: `/run/secrets/docker/cert.pem`
- Client private key: `/run/secrets/docker/key.pem`

The Web connection form does not upload certificate files from the browser.

## SSH NC setup

Verify the remote prerequisites using the same SSH account configured in DBX:

```sh
command -v nc
printf 'GET /_ping HTTP/1.0\r\n\r\n' | nc -U /var/run/docker.sock
sudo -n -- true
```

For Sudo-NC, grant only the command and socket path required by your environment. DBX never sends an interactive sudo password.

## Management capabilities and limits

The workbench provides:

- Compose-grouped and standalone container lists, create/delete, start, pause, resume, restart, and stop.
- Container overview, a bounded live log stream, session-only 15-minute CPU/memory trends, and read-only file browsing.
- Image pull/push/delete/export, including optional per-request private Registry credentials.
- Volume and network creation.

Registry credentials are sent only in the Docker `X-Registry-Auth` request header. DBX does not save them or include them in application logs.

The file browser runs a fixed read-only `/bin/sh` script with the selected path passed as a separate argument. It does not accept arbitrary commands and does not provide upload, edit, or delete operations. Distroless and scratch containers without `/bin/sh`, `stat`, or `head` show an unsupported-capability error. Text preview is limited to 2 MiB.

Docker image archives can be large. The Web image export route streams the archive from the daemon, while Tauri streams directly to the selected local file without routing the archive through frontend IPC. Importing offline image archives is not included in this version.

## Compose editor

The workbench can create a project from Compose YAML and generate an editable definition from an existing Compose-labelled project. Applying an edit stops, removes, and recreates the project's containers after an explicit danger confirmation; volumes and networks are retained.

The parser intentionally supports a controlled common subset: `image`, `container_name`, `command`, `environment`, short-form `ports`, short-form `volumes`, `networks`, `restart`, and `labels`. It does not invoke Docker Compose, evaluate health-based `depends_on`, build images, process extension fields, or load `.env` files.

DBX does not invoke the Docker or Compose CLI. An interactive exec terminal, Windows named pipes, volume/network deletion, file writes, and persistent monitoring remain outside this version.
