#!/usr/bin/env python3
"""Manually verify the dbx-mcp stdio handshake paths without extra tooling.

Usage:
    python3 scripts/manual-mcp-check.py [path/to/dbx-mcp]

Runs the four paths that matter after the MCP protocol work:

  1. bare `server/discover` (no `_meta`)  -> -32601, the legacy fallback signal
  2. `initialize` at 2025-11-25           -> legacy stateful session
  3. `server/discover` with `_meta`       -> advertises 2026-07-28
  4. `tools/call` with no `initialize`    -> served statelessly
"""

import json
import os
import subprocess
import sys
import tempfile

DEFAULT_BINARY = "target/debug/dbx-mcp"

META_2026 = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {"name": "manual-check", "version": "0"},
    "io.modelcontextprotocol/clientCapabilities": {},
}


class Probe:
    def __init__(self, binary):
        self.data_dir = tempfile.mkdtemp(prefix="dbx-mcp-manual-")
        env = {**os.environ, "DBX_DATA_DIR": self.data_dir, "RUST_LOG": "warn"}
        self.process = subprocess.Popen(
            [binary],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            bufsize=1,
        )

    def send(self, **message):
        """Send one request and return the matching response."""
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line.strip():
            raise RuntimeError(f"no response for {message.get('method')}; stderr: {self.stderr()}")
        return json.loads(line)

    def notify(self, method):
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
        self.process.stdin.flush()

    def stderr(self):
        if self.process.poll() is None:
            return ""
        return self.process.stderr.read()

    def close(self):
        self.process.kill()


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BINARY
    if not os.path.exists(binary):
        if os.path.exists(os.path.join(os.path.dirname(__file__), "..", binary)):
            binary = os.path.join(os.path.dirname(__file__), "..", binary)
        else:
            sys.exit(f"binary not found: {binary}\nBuild it first:\n  cargo build -p dbx-mcp --no-default-features --features sqlite-bundled")

    failures = []
    probe = Probe(binary)
    try:
        # 1. Bare discovery probe: agents older than the final 2026 lifecycle use
        #    -32601 as the "this server is legacy, use initialize" signal.
        bare = probe.send(id=1, method="server/discover", params={})
        code = bare.get("error", {}).get("code")
        print(f"[1] bare server/discover      -> error {code} (expected -32601)")
        if code != -32601:
            failures.append(f"bare probe returned {code}, expected -32601")

        # 2. Legacy initialize still negotiates a pre-2026 version.
        init = probe.send(
            id=2,
            method="initialize",
            params={"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "manual-check", "version": "0"}},
        )
        version = init.get("result", {}).get("protocolVersion")
        server = init.get("result", {}).get("serverInfo", {}).get("name")
        print(f"[2] initialize 2025-11-25     -> protocolVersion={version} serverInfo={server}")
        if version != "2025-11-25" or server != "dbx":
            failures.append(f"legacy initialize returned {init}")

        probe.notify("notifications/initialized")
        legacy_tools = probe.send(id=3, method="tools/list", params={}).get("result", {}).get("tools", [])
        print(f"    legacy tools/list         -> {len(legacy_tools)} tools")
        if not legacy_tools:
            failures.append("legacy tools/list returned no tools")

        # 3. A well-formed probe must reach the SDK and advertise 2026-07-28.
        discover = probe.send(id=4, method="server/discover", params={"_meta": META_2026})
        result = discover.get("result", {})
        versions = result.get("supportedVersions", [])
        print(f"[3] server/discover + _meta   -> versions={versions}")
        print(f"    serverInfo={result.get('_meta', {}).get('io.modelcontextprotocol/serverInfo', {}).get('name')}"
              f" ttlMs={result.get('ttlMs')} cacheScope={result.get('cacheScope')}")
        if "2026-07-28" not in versions:
            failures.append(f"discovery did not advertise 2026-07-28: {discover}")

        # 4. Stateless tools/call: no initialize at all, metadata per request.
        call = probe.send(
            id=5,
            method="tools/call",
            params={"name": "dbx_list_connections", "arguments": {}, "_meta": META_2026},
        )
        call_result = call.get("result", {})
        text = (call_result.get("content") or [{}])[0].get("text", "")
        print(f"[4] stateless tools/call      -> isError={call_result.get('isError')} text={text[:60]!r}")
        if call_result.get("isError"):
            failures.append(f"stateless tools/call failed: {call}")
    finally:
        probe.close()

    if failures:
        print("\nFAILED:")
        for failure in failures:
            print(f"  - {failure}")
        sys.exit(1)
    print("\nAll checks passed.")


if __name__ == "__main__":
    main()
