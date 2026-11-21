#!/usr/bin/env python3
"""SDK stdio + native CLI smoke. Uses no database and only loopback endpoints."""
import json
import os
import selectors
import socket
import subprocess
import sys

binary = os.path.abspath(sys.argv[1])
process = subprocess.Popen([binary, "plugin"], stdin=subprocess.PIPE,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
sequence = 0

def rpc(method, params):
    global sequence
    sequence += 1
    process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": sequence,
                                  "method": method, "params": params}) + "\n")
    process.stdin.flush()
    with selectors.DefaultSelector() as selected:
        selected.register(process.stdout, selectors.EVENT_READ)
        if not selected.select(5):
            raise AssertionError("sidecar response timeout")
    response = json.loads(process.stdout.readline())
    assert response["id"] == sequence and "error" not in response, response
    return response["result"]

try:
    initialized = rpc("plugin/initialize", {"host": {"protocolVersions": [1]}})
    assert initialized["plugin"]["id"] == "io.xuedinge.pg-fault-lab"
    with socket.socket() as port_picker:
        port_picker.bind(("127.0.0.1", 0))
        proxy_port = port_picker.getsockname()[1]
    lifecycle = {"connection": {"id": "smoke", "host": "127.0.0.1", "port": 55432,
                 "external_config": {"proxy_port": proxy_port, "disposable_lab": True,
                                     "allow_injection": True}}}
    started = rpc("connection/connect", lifecycle)
    endpoints = rpc("lab/cli_endpoints", {"connectionId": "smoke"})
    observer, injector = endpoints["observe"], endpoints["inject"]
    request = {"method": "add_rule", "rule": {"selector": {"application": "smoke"},
               "phase": "execute", "action": "pause", "hits": 1, "ttlMs": 1000}}
    def cli(endpoint, request):
        env = dict(os.environ, DBX_FAULT_CAPABILITY=endpoint["capability"])
        return subprocess.run([binary, "ctl", "--address", endpoint["address"]],
                              input=json.dumps(request), capture_output=True, text=True,
                              env=env, timeout=5)
    denied = cli(observer, request)
    assert denied.returncode != 0 and json.loads(denied.stdout)["error"]
    armed = cli(injector, request)
    assert armed.returncode == 0, armed.stderr
    tools = rpc("mcp/tools", {"connectionId": "smoke"})["tools"]
    assert len(tools) == 5
    assert next(t for t in tools if t["name"] == "lab_snapshot")["annotations"]["readOnlyHint"]
    result = rpc("mcp/call", {"tool": "lab_snapshot", "arguments": {}, "lifecycle": lifecycle})
    assert result["isError"] is False
    snapshot = json.loads(result["content"][0]["text"])
    assert len(snapshot["rules"]) == 1 and "capability" not in json.dumps(snapshot)
    rpc("connection/disconnect", lifecycle)
    assert cli(observer, {"method": "snapshot"}).returncode != 0
    print("PASS: SDK initialization, lifecycle, native CLI authorization, shared rules, MCP discovery/call, redaction and cleanup")
finally:
    process.stdin.close()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    assert process.returncode == 0, "sidecar did not exit cleanly"
