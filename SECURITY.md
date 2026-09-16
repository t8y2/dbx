# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities in public GitHub issues.

Use GitHub's private vulnerability reporting for this repository when available. If that is not available to you, open a minimal GitHub issue asking for a private security contact without including exploit details, credentials, tokens, connection strings, database dumps, or screenshots containing secrets.

## What to Include

Helpful reports include:

- Affected DBX version or commit.
- Operating system and installation method.
- The impacted component, such as desktop app, Docker service, CLI, MCP server, or JDBC plugin.
- Steps to reproduce in a safe test environment.
- Impact assessment and any known workaround.

## Scope

Security-sensitive areas include:

- Connection storage, config import/export, and encryption.
- Database credential handling.
- SSH tunnel and proxy handling.
- AI provider keys and OpenAI-compatible endpoint configuration.
- MCP and CLI access to local DBX connections.
- Docker web service authentication and data directory handling.
- Plugin package verification, native sidecar execution, sandboxed plugin UI, host bridge permissions, and plugin connection secrets.

Plugin connection secrets are stored outside ordinary connection JSON. Unencrypted sync snapshots are always redacted. If encrypted secret sync is enabled with a user-provided passphrase, plugin secrets are included only in the encrypted payload and are restored through the normal secret-store path.

Please avoid testing against systems you do not own or have explicit permission to assess.
