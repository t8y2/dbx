import json
import pathlib
import sys

log_path = pathlib.Path(sys.argv[1])
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    with log_path.open("a", encoding="utf-8") as log:
        log.write(method + "\n")
    if method == "handshake":
        result = {"protocolVersion": 2, "agentProtocolVersion": 2, "capabilities": ["multi_session"]}
    elif method == "read_large_value_chunk":
        result = {"data": "fixture", "nextOffset": 7, "eof": True, "kind": "text"}
    else:
        result = {"ok": True}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
