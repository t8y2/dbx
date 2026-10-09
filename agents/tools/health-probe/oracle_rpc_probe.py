"""Sample the unmodified Oracle Go/OCI agent RPC through a metadata-only TNS relay."""
import argparse
import hashlib
import json
import math
import os
import queue
import re
import subprocess
import threading
import time
from pathlib import Path
from wire_relay import Relay, WireLog


class AgentRPC:
    def __init__(self, binary):
        self.process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
        self.ready = threading.Event()
        self.lock = threading.Lock()
        self.pending = {}
        self.counter = 0
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        if not self.ready.wait(10):
            self.close(); raise TimeoutError("agent readiness")

    def _read(self):
        try:
            for line in self.process.stdout:
                try: row = json.loads(line)
                except ValueError: continue  # Never persist raw agent output.
                if not isinstance(row, dict): continue
                if row.get("ready") is True: self.ready.set(); continue
                with self.lock: result = self.pending.get(row.get("id"))
                if result is not None: result.put(row)
        finally:
            with self.lock:
                for result in self.pending.values(): result.put({"error": {"message": "agent stream closed"}})

    def request(self, method, params, timeout=20):
        with self.lock:
            self.counter += 1
            identity = self.counter
            result = queue.Queue()
            self.pending[identity] = result
            self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": identity, "method": method, "params": params}) + "\n")
            self.process.stdin.flush()
        try: return result.get(timeout=timeout)
        finally:
            with self.lock: self.pending.pop(identity, None)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=5)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait(timeout=5)
        if self.process.stdin: self.process.stdin.close()
        self.reader.join(timeout=1)
        if self.process.stdout: self.process.stdout.close()


def sanitized_outcome(response):
    if "error" not in response: return "success", None
    message = str(response.get("error", {}).get("message", ""))
    code = re.search(r"\bORA-(\d{5})\b", message)
    vendor = f"ORA-{code.group(1)}" if code else None
    if vendor == "ORA-01013" or re.search(r"cancel(?:led|ed)|context canceled", message, re.I): return "cancelled", vendor
    if re.search(r"deadline|timeout|timed out", message, re.I): return "timeout", vendor
    return "error", vendor


def sample(rpc, wire, output, scenario, index, method, params, cancel=False):
    started = time.monotonic_ns()
    before = wire.snapshot()
    row = {"kind": "sample", "scenario": scenario, "index": index, "method": method,
           "started_monotonic_ns": started, "started_utc_ns": time.time_ns(), "rpc_requests": 1,
           "timing_scope": "production Agent JSON-RPC roundtrip including process pipes; wire observation is separate"}
    control = []
    cancellation = None
    def cancel_request():
        try: control.append(rpc.request("cancel_session", {"agentSessionId": params["agentSessionId"]}, timeout=10))
        except (OSError, queue.Empty): control.append({"error": {}})
    try:
        if cancel:
            cancellation = threading.Timer(.2, cancel_request); cancellation.start()
        response = rpc.request(method, params)
        outcome, vendor = sanitized_outcome(response)
        row["outcome"] = "completed_during_cancel_race" if cancel and outcome == "success" else outcome
        if vendor: row["vendor_code"] = vendor
        if method == "execute_query" and outcome == "success":
            rows = response.get("result", {}).get("rows", [])
            reported = response.get("result", {}).get("execution_time_ms")
            if type(reported) in (int, float) and math.isfinite(reported) and reported >= 0:
                row["reported_execution_ms"] = reported
            row["server_execute_time"] = "not_independently_measured"
            row["correct_result"] = len(rows) == 1 and len(rows[0]) == 1 and str(rows[0][0]) == "1"
            if not row["correct_result"]: row["outcome"] = "incorrect_result"
    except queue.Empty: row["outcome"] = "rpc_timeout"
    except (OSError, ValueError, TypeError): row["outcome"] = "rpc_error"
    finally:
        ended = time.monotonic_ns()
        row["dispatch_ms"] = (ended - started) / 1_000_000
        row["query_completed_monotonic_ns"] = ended
        if cancellation:
            cancellation.cancel(); cancellation.join(timeout=11)
            if cancellation.is_alive(): raise TimeoutError("cancel worker did not stop")
            row["cancel_rpc_requests"] = len(control)
            row["cancel_rpc_outcomes"] = [sanitized_outcome(reply)[0] for reply in control]
        row["completed_monotonic_ns"] = time.monotonic_ns()
        row["completed_utc_ns"] = time.time_ns()
        after = wire.snapshot()
        row["wire_window_counts"] = {name: count - before.get(name, 0) for name, count in after.items() if count != before.get(name, 0)}
        row["wire_scope"] = "dedicated relay frames during request/control window; TTC prefixes are lower bounds, not SQL statement counts"
        output.write(json.dumps(row) + "\n"); output.flush()
    return row


def run(args):
    if os.environ.get("DBX_HEALTH_DEDICATED") != "1": raise ValueError("dedicated endpoint required")
    connect = json.loads(os.environ["DBX_HEALTH_CONNECT_JSON"])
    if not isinstance(connect, dict) or connect.get("connection_string") or not re.fullmatch(r"[A-Za-z0-9_$.-]+", str(connect.get("database", ""))):
        raise ValueError("use simple dedicated service parameters, no redirecting descriptor")
    target = (connect["host"], int(connect["port"]))
    digest = hashlib.sha256(args.agent.read_bytes()).hexdigest()
    with args.wire.open("x", encoding="utf-8") as wire_file, args.output.open("x", encoding="utf-8") as output:
        wire = WireLog(wire_file)
        relay = Relay("tns", target, wire, plaintext_ttc=args.verified_plaintext_ttc).start()
        rpc = None
        try:
            connect = {**connect, "host": "127.0.0.1", "port": relay.port, "connection_string": "", "driver_profile": "oci" if args.profile == "oci" else "oracle", "agentSessionId": "health-probe"}
            output.write(json.dumps({"kind": "environment", "format": "dbx-oracle-health-v1", "profile": args.profile,
                                     "agent_sha256": digest, "samples_per_scenario": args.samples,
                                     "wire_semantics": "verified plaintext TTC prefix lower bounds" if args.verified_plaintext_ttc else "TNS packets only; TTC request semantics not decoded",
                                     "scope": "production Agent JSON-RPC and actual dedicated TCP relay; no desktop GUI"}) + "\n")
            output.flush()
            rpc = AgentRPC(args.agent.resolve())
            query = {"agentSessionId": "health-probe", "sql": "SELECT 1 FROM DUAL", "maxRows": 1, "timeoutSecs": 5}
            for index in range(args.samples):
                sample(rpc, wire, output, "connect", index, "open_session", connect)
                sample(rpc, wire, output, "cold_query", index, "execute_query", query)
                sample(rpc, wire, output, "warm_query", index, "execute_query", query)
                time.sleep(5.1)
                sample(rpc, wire, output, "idle_query", index, "execute_query", query)
                relay.disconnect_all()
                sample(rpc, wire, output, "invalid_hot", index, "execute_query", query)
                sample(rpc, wire, output, "invalid_expired", index, "validate_session", {"agentSessionId": "health-probe"})
                sample(rpc, wire, output, "after_reconnect", index, "execute_query", query)
                # Hold forwarding so the cancellation request is delivered while a
                # real production query is waiting, without a business long query.
                relay.pause(1)
                sample(rpc, wire, output, "cancel_race", index, "execute_query", query, cancel=True)
                sample(rpc, wire, output, "after_cancel", index, "execute_query", query)
                sample(rpc, wire, output, "disconnect", index, "close_session", {"agentSessionId": "health-probe"})
                sample(rpc, wire, output, "reconnect", index, "open_session", connect)
                sample(rpc, wire, output, "after_explicit_reconnect", index, "execute_query", query)
                sample(rpc, wire, output, "disconnect", index, "close_session", {"agentSessionId": "health-probe"})
            rpc.request("shutdown", {})
        finally:
            if rpc is not None: rpc.close()
            relay.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("agent", type=Path); parser.add_argument("profile", choices=("thin", "oci"))
    parser.add_argument("output", type=Path); parser.add_argument("wire", type=Path)
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--verified-plaintext-ttc", action="store_true")
    args = parser.parse_args()
    if not 5 <= args.samples <= 100: parser.error("samples must be between 5 and 100")
    try: run(args)
    except (OSError, ValueError, KeyError, TypeError, TimeoutError, queue.Empty): parser.exit(1, "Oracle probe failed; raw credentials/response/endpoint were not printed.\n")


if __name__ == "__main__":
    main()
