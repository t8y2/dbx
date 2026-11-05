"""Runs only for the lifetime of its SSH stdin; binds remote loopback only."""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

hits = []
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self):
        if self.path == '/_stats' and self.server.role == 'model':
            with lock:
                body = json.dumps(hits).encode()
            status, kind = 200, 'application/json'
        else:
            length = int(self.headers.get('Content-Length', '0'))
            payload = {}
            if length:
                raw = self.rfile.read(length)
                try:
                    payload = json.loads(raw.decode())
                except (ValueError, UnicodeDecodeError):
                    pass
            with lock:
                hits.append({'role': self.server.role, 'method': self.command, 'path': self.path})
            if self.server.role.startswith('proxy'):
                status, kind, body = 502, 'text/plain', b'dbx-12277 mock proxy: request incorrectly routed here'
            elif self.command == 'POST' and payload.get('stream'):
                status, kind, body = 200, 'text/event-stream', b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
            elif self.command == 'POST':
                status, kind = 200, 'application/json'
                body = b'{"id":"proof","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}'
            else:
                status, kind = 200, 'application/json'
                body = b'{"object":"list","data":[{"id":"local-repro","object":"model"}]}'
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = respond
    do_POST = respond


servers = []
for role in ('model', 'proxy', 'proxy-explicit'):
    server = HTTPServer(('127.0.0.1', 0), Handler)
    server.role = role
    threading.Thread(target=server.serve_forever, daemon=True).start()
    servers.append(server)
print(json.dumps({s.role: s.server_port for s in servers}), flush=True)
try:
    sys.stdin.read()
finally:
    for server in servers:
        server.shutdown()
        server.server_close()
