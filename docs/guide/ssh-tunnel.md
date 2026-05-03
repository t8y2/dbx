# SSH Tunnel

DBX can connect to databases through an SSH tunnel, allowing you to securely access database servers that are not directly reachable from your machine. This is common in production environments where the database is behind a firewall or on a private network.

## Configuration

When creating or editing a connection, enable the SSH tunnel option and provide the following details:

| Field | Description |
|---|---|
| SSH Host | Hostname or IP address of the SSH server |
| SSH Port | Port for the SSH connection (default: 22) |
| SSH User | Username for SSH authentication |
| Authentication | Password or private key |

## Authentication Methods

### Password

Enter your SSH password directly. The password is stored securely alongside your connection configuration.

### Private Key

Select a private key file (e.g., `~/.ssh/id_rsa`, `~/.ssh/id_ed25519`) using the file picker. You do not need to type the path manually -- click the browse button to select the key file from your filesystem.

#### Key Passphrase

If your private key is protected by a passphrase, DBX will prompt you to enter it. The passphrase is used to decrypt the key at connection time.

## Expose Tunnel to LAN

By default, the SSH tunnel listens only on `localhost` (`127.0.0.1`). If you enable the **Expose to LAN** option, the tunnel binds to `0.0.0.0`, making it accessible to other devices on your local network.

::: warning
Exposing the tunnel to your LAN means any device on the same network can access the tunneled database port. Only enable this on trusted networks.
:::

## How It Works

When you connect, DBX:

1. Establishes an SSH connection to the specified SSH server.
2. Creates a local port that forwards traffic through the SSH tunnel to the database server.
3. Connects to the database through the forwarded local port.

The tunnel remains active for the duration of the database connection and is closed automatically when you disconnect.
