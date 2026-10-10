"""Dedicated loopback TCP relay: log protocol metadata, never SQL/auth payloads."""
import argparse
import json
import socket
import threading
import time
from collections import Counter
from pathlib import Path


class WireLog:
    def __init__(self, output):
        self.output = output
        self.lock = threading.Lock()
        self.counts = Counter()

    def emit(self, connection, direction, category, size=0, elapsed_ns=None):
        row = {"kind": "wire", "connection": connection, "direction": direction,
               "category": category, "bytes": size, "monotonic_ns": time.monotonic_ns(), "utc_ns": time.time_ns()}
        if elapsed_ns is not None: row["first_response_ms"] = elapsed_ns / 1_000_000
        with self.lock:
            self.counts[f"{direction}:{category}"] += 1
            self.output.write(json.dumps(row) + "\n")
            self.output.flush()

    def snapshot(self):
        with self.lock:
            return dict(self.counts)


class Decoder:
    """Reassemble TCP frames, retaining only a bounded protocol prefix in memory."""
    MYSQL_COMMANDS = {1: "mysql_quit", 2: "mysql_init_db", 3: "mysql_query", 14: "mysql_ping",
                      22: "mysql_prepare", 23: "mysql_execute", 24: "mysql_long_data", 25: "mysql_stmt_close", 28: "mysql_fetch"}

    def __init__(self, protocol, log, connection, plaintext_ttc=False):
        self.protocol, self.log, self.connection = protocol, log, connection
        self.plaintext_ttc = plaintext_ttc
        self.authenticated = False
        self.opaque = False
        self.tns_extended = False
        self.mysql_pending = []
        self.ttc_pending = None
        self.parts = {side: {"header": bytearray(), "remaining": 0, "prefix": bytearray(), "size": 0} for side in ("c2s", "s2c")}
        self.lock = threading.Lock()

    def feed(self, side, data):
        with self.lock:
            if self.opaque:
                self.log.emit(self.connection, side, "opaque_transport", len(data))
                return
            state = self.parts[side]
            view = memoryview(data)
            while view:
                needed = 4 if self.protocol == "mysql" else 8
                if len(state["header"]) < needed:
                    take = min(needed - len(state["header"]), len(view))
                    state["header"].extend(view[:take]); view = view[take:]
                    if len(state["header"]) < needed:
                        return
                    header = state["header"]
                    if self.protocol == "mysql":
                        length = int.from_bytes(header[:3], "little")
                    else:
                        if header[0] in (20, 21, 22, 23) and header[1] == 3 and header[2] <= 4:
                            self.opaque = True
                            self.log.emit(self.connection, side, "tls_transport_not_decoded")
                            state["header"].clear(); state["prefix"].clear()
                            return
                        total = int.from_bytes(header[:4] if self.tns_extended else header[:2], "big")
                        length = total - 8
                    if length < 0 or length > 32 * 1024 * 1024:
                        self.opaque = True
                        self.log.emit(self.connection, side, "decode_invalid_length")
                        state["header"].clear(); state["prefix"].clear()
                        return
                    state["remaining"] = length
                    state["size"] = needed + length
                take = min(state["remaining"], len(view))
                keep = min(take, 40 - len(state["prefix"]))
                state["prefix"].extend(view[:keep]); view = view[take:]
                state["remaining"] -= take
                if state["remaining"]:
                    return
                self._frame(side, bytes(state["header"]), bytes(state["prefix"]), state["size"])
                state["header"].clear(); state["prefix"].clear()
                if self.opaque:
                    return

    def _frame(self, side, header, prefix, size):
        if self.protocol == "mysql":
            sequence = header[3]
            if not self.authenticated:
                self.log.emit(self.connection, side, "mysql_handshake_frame", size)
                if side == "c2s" and sequence == 1 and len(prefix) >= 4:
                    capabilities = int.from_bytes(prefix[:4], "little")
                    if capabilities & (0x800 | 0x20 | (1 << 26)):
                        self.opaque = True
                        self.log.emit(self.connection, side, "mysql_tls_or_compressed_not_decoded")
                elif side == "s2c" and sequence >= 2 and prefix[:1] == b"\x00":
                    self.authenticated = True
                return
            if side == "c2s" and sequence == 0 and prefix:
                # Connector/J defaults to OB20: three uncompressed-length bytes
                # precede little-endian magic 0x20AB and version20. Its envelope
                # is not a MySQL command; retain metadata without guessing counts.
                if len(prefix) >= 7 and prefix[3:7] == b"\xab\x20\x14\x00":
                    self.opaque = True
                    self.log.emit(self.connection, side, "mysql_ob20_not_decoded", size)
                    return
                category = self.MYSQL_COMMANDS.get(prefix[0], "mysql_other_command")
                self.log.emit(self.connection, side, category, size)
                if prefix[0] in (2, 3, 14, 22, 23, 28): self.mysql_pending.append((category, time.monotonic_ns()))
                if len(self.mysql_pending) > 100:
                    self.mysql_pending.clear(); self.log.emit(self.connection, side, "mysql_request_order_unknown")
            else:
                self.log.emit(self.connection, side, "mysql_response_or_continuation", size)
                if side == "s2c" and sequence == 1 and self.mysql_pending:
                    category, started = self.mysql_pending.pop(0)
                    self.log.emit(self.connection, side, f"{category}_first_response", elapsed_ns=time.monotonic_ns() - started)
            return
        packet_type = header[4]
        category = {1: "tns_connect", 2: "tns_accept", 4: "tns_refuse", 5: "tns_redirect", 6: "tns_data_packet", 12: "tns_marker"}.get(packet_type, "tns_other_packet")
        self.log.emit(self.connection, side, category, size)
        if side == "s2c" and packet_type == 2 and len(prefix) >= 2:
            self.tns_extended = int.from_bytes(prefix[:2], "big") >= 315
        if side == "c2s" and packet_type == 6:
            # TNS DATA has two flag bytes before TTC. These counts are confirmed
            # frame-prefix function observations, not a full TTC message parser.
            if self.plaintext_ttc and len(prefix) >= 5 and prefix[:2] == b"\x00\x00" and prefix[2] == 3:
                name = {0x93: "ttc_ping_prefix", 0x5E: "ttc_oall8_prefix", 9: "ttc_logoff_prefix"}.get(prefix[3], "ttc_other_function_prefix")
                self.log.emit(self.connection, side, name)
                if self.ttc_pending is not None: self.log.emit(self.connection, side, "tns_request_order_unknown")
                self.ttc_pending = (name, time.monotonic_ns())
            else:
                self.log.emit(self.connection, side, "tns_request_semantics_not_decoded")
        if side == "s2c" and packet_type == 6 and self.ttc_pending is not None:
            name, started = self.ttc_pending
            self.ttc_pending = None
            self.log.emit(self.connection, side, f"{name}_first_response", elapsed_ns=time.monotonic_ns() - started)

    def finish(self):
        with self.lock:
            for side, state in self.parts.items():
                if state["header"] or state["remaining"]:
                    self.log.emit(self.connection, side, "incomplete_frame")
                state["header"].clear(); state["prefix"].clear()


class Relay:
    def __init__(self, protocol, target, log, port=0, plaintext_ttc=False):
        self.protocol, self.target, self.log, self.plaintext_ttc = protocol, target, log, plaintext_ttc
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", port)); self.listener.listen(16); self.listener.settimeout(.2)
        self.port = self.listener.getsockname()[1]
        self.stopped = threading.Event()
        self.pause_until = 0
        self.sockets = set()
        self.lock = threading.Lock()
        self.threads = []
        self.next_id = 0

    def start(self):
        thread = threading.Thread(target=self._accept, daemon=True)
        self.threads.append(thread); thread.start()
        return self

    def _accept(self):
        while not self.stopped.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.next_id += 1
            connection = self.next_id
            try:
                upstream = socket.create_connection(self.target, timeout=10)
                if self.stopped.is_set():
                    upstream.close(); client.close(); return
                client.settimeout(.5); upstream.settimeout(.5)
            except OSError:
                self.log.emit(connection, "relay", "upstream_connect_failed")
                client.close(); continue
            with self.lock:
                self.sockets.update((client, upstream))
            self.log.emit(connection, "relay", "physical_tcp_connected")
            decoder = Decoder(self.protocol, self.log, connection, self.plaintext_ttc)
            for source, destination, side in ((client, upstream, "c2s"), (upstream, client, "s2c")):
                thread = threading.Thread(target=self._copy, args=(source, destination, side, decoder), daemon=True)
                self.threads.append(thread); thread.start()

    def _copy(self, source, destination, side, decoder):
        try:
            while not self.stopped.is_set():
                if time.monotonic() < self.pause_until:
                    self.stopped.wait(.05); continue
                try:
                    data = source.recv(65536)
                except socket.timeout:
                    continue
                if not data:
                    break
                decoder.feed(side, data)
                destination.sendall(data)
        except OSError:
            self.log.emit(decoder.connection, side, "transport_closed_or_failed")
        finally:
            decoder.finish()
            for stream in (source, destination):
                try: stream.shutdown(socket.SHUT_RDWR)
                except OSError: pass
                stream.close()
                with self.lock: self.sockets.discard(stream)

    def disconnect_all(self):
        with self.lock: streams = list(self.sockets)
        self.log.emit(0, "relay", "dedicated_transport_disconnected")
        for stream in streams:
            try: stream.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            stream.close()

    def pause(self, seconds):
        self.pause_until = time.monotonic() + seconds
        self.log.emit(0, "relay", "dedicated_forwarding_paused")

    def close(self):
        self.stopped.set(); self.listener.close(); self.disconnect_all()
        for thread in self.threads: thread.join(timeout=11 if thread is self.threads[0] else 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("protocol", choices=("mysql", "tns"))
    parser.add_argument("target_host"); parser.add_argument("target_port", type=int)
    parser.add_argument("output", type=Path)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--duration", type=int, default=600)
    parser.add_argument("--verified-plaintext-ttc", action="store_true")
    args = parser.parse_args()
    if args.duration < 1 or args.duration > 3600:
        parser.error("duration must be between 1 and 3600 seconds")
    try:
        with args.output.open("x", encoding="utf-8") as output:
            relay = Relay(args.protocol, (args.target_host, args.target_port), WireLog(output), args.port, args.verified_plaintext_ttc).start()
            print(json.dumps({"listen_host": "127.0.0.1", "listen_port": relay.port, "scope": "wire metadata; no payload persisted"}), flush=True)
            try: relay.stopped.wait(args.duration)
            except KeyboardInterrupt: pass
            finally: relay.close()
    except (OSError, ValueError):
        parser.exit(1, "Relay failed; raw endpoint or payload was not printed.\n")


if __name__ == "__main__":
    main()
