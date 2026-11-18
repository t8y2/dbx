#!/usr/bin/env python3
"""Minimal HTTP-callback auth adapter demo for verifying DBX's HttpCallback provider.

Zero dependencies (standard library only). Run it, then configure the provider
in DBX (Settings → Security, or DBX_AUTH_CONFIG):

    {"id": "corp", "kind": "http_callback", "config": {
        "url": "http://127.0.0.1:4322/auth",
        "shared_secret": "demo-shared-secret",
        "role_map": {"ops-admin": "admin"},
        "default_role": "member"
    }}

Built-in demo accounts (username / password / groups):
    demo / demo123   -> groups ["ops-admin"]  -> DBX role admin
    viewer / viewer123 -> groups []           -> DBX role member

Env overrides: ADAPTER_HOST (default 127.0.0.1), ADAPTER_PORT (default 4322),
ADAPTER_SHARED_SECRET (default demo-shared-secret).
"""

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

SHARED_SECRET = os.environ.get("ADAPTER_SHARED_SECRET", "demo-shared-secret")
HOST = os.environ.get("ADAPTER_HOST", "127.0.0.1")
PORT = int(os.environ.get("ADAPTER_PORT", "4322"))

# username -> (password, identity payload)
USERS = {
    "demo": (
        "demo123",
        {
            "subject": "u-1001",
            "username": "demo",
            "display_name": "Demo User",
            "email": "demo@corp.example",
            "groups": ["ops-admin"],
        },
    ),
    "viewer": (
        "viewer123",
        {
            "subject": "u-1002",
            "username": "viewer",
            "display_name": "Viewer User",
            "email": "viewer@corp.example",
            "groups": [],
        },
    ),
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/auth":
            self._send(404, {"error": "not found"})
            return
        if self.headers.get("X-DBX-Auth-Secret") != SHARED_SECRET:
            self._send(401, {"error": "bad shared secret"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"error": f"invalid JSON: {exc}"})
            return
        user = USERS.get(str(body.get("username", "")))
        if not user or user[0] != body.get("password"):
            self._send(401, {"error": "invalid credentials"})
            return
        self._send(200, user[1])

    def _send(self, code, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # noqa: A003 - keep the demo output tidy
        print(f"[adapter] {fmt % args}")


if __name__ == "__main__":
    print(f"[adapter] listening on http://{HOST}:{PORT}/auth (shared secret: {SHARED_SECRET!r})")
    print(f"[adapter] demo accounts: demo/demo123 (admin), viewer/viewer123 (member)")
    HTTPServer((HOST, PORT), Handler).serve_forever()
