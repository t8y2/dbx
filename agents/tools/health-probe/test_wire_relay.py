import io
import json
import socket
import threading
import unittest
from wire_relay import Decoder, Relay, WireLog
from wire_summary import correlate
from oracle_rpc_probe import sanitized_outcome


def mysql(payload, sequence=0):
    return len(payload).to_bytes(3, "little") + bytes([sequence]) + payload


def tns(packet_type, payload, extended=False):
    size = 8 + len(payload)
    length = size.to_bytes(4, "big") if extended else size.to_bytes(2, "big") + b"\x00\x00"
    return length + bytes([packet_type, 0, 0, 0]) + payload


class WireTests(unittest.TestCase):
    def fixture(self, protocol="mysql", plaintext=False):
        output = io.StringIO()
        log = WireLog(output)
        return output, log, Decoder(protocol, log, 1, plaintext)

    def authenticate(self, decoder):
        decoder.feed("s2c", mysql(b"\x0a greeting", 0))
        decoder.feed("c2s", mysql(b"\x00\x00\x00\x00" + b"private user/password", 1))
        decoder.feed("s2c", mysql(b"\x00", 2))

    def test_fragmented_and_coalesced_real_mysql_commands_do_not_emit_payload(self):
        output, log, decoder = self.fixture()
        self.authenticate(decoder)
        data = mysql(b"\x03SELECT private_bind") + mysql(b"\x0e")
        for chunk in (data[:2], data[2:8], data[8:]): decoder.feed("c2s", chunk)
        self.assertEqual(log.snapshot()["c2s:mysql_query"], 1)
        self.assertEqual(log.snapshot()["c2s:mysql_ping"], 1)
        self.assertNotIn("private", output.getvalue())

    def test_wire_ping_turnaround_is_first_response_not_database_execute_time(self):
        output, _, decoder = self.fixture()
        self.authenticate(decoder)
        decoder.feed("c2s", mysql(b"\x0e"))
        decoder.feed("s2c", mysql(b"\x00", 1))
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        measured = [row for row in events if row["category"] == "mysql_ping_first_response"]
        self.assertEqual(len(measured), 1)
        self.assertGreaterEqual(measured[0]["first_response_ms"], 0)
        self.assertNotIn("database_execute_ms", measured[0])

    def test_tls_stops_command_decoding(self):
        _, log, decoder = self.fixture()
        decoder.feed("c2s", mysql((0x800).to_bytes(4, "little") + b"\x00" * 28, 1))
        decoder.feed("c2s", b"\x16\x03 encrypted bytes")
        self.assertNotIn("c2s:mysql_query", log.snapshot())
        self.assertEqual(log.snapshot()["c2s:mysql_tls_or_compressed_not_decoded"], 1)

    def test_tns_packet_count_does_not_claim_logical_query_count(self):
        output, log, decoder = self.fixture("tns")
        decoder.feed("c2s", tns(6, b"\x00\x00\x03\x93\x00private"))
        self.assertEqual(log.snapshot()["c2s:tns_data_packet"], 1)
        self.assertNotIn("c2s:ttc_ping_prefix", log.snapshot())
        self.assertIn("c2s:tns_request_semantics_not_decoded", log.snapshot())
        self.assertNotIn("private", output.getvalue())

    def test_tcps_is_not_mislabeled_as_plaintext_tns(self):
        output, log, decoder = self.fixture("tns", True)
        decoder.feed("c2s", b"\x16\x03\x03\x00\x2fprivate")
        self.assertIn("c2s:tls_transport_not_decoded", log.snapshot())
        self.assertNotIn("c2s:tns_data_packet", log.snapshot())
        self.assertNotIn("private", output.getvalue())

    def test_verified_plaintext_ttc_prefix_and_extended_tns_length(self):
        _, log, decoder = self.fixture("tns", True)
        decoder.feed("s2c", tns(2, (315).to_bytes(2, "big") + b"\x00" * 30))
        data = tns(6, b"\x00\x00\x03\x93\x00", True) + tns(6, b"\x00\x00\x03\x5e\x00", True)
        for byte in data: decoder.feed("c2s", bytes([byte]))
        self.assertEqual(log.snapshot()["c2s:ttc_ping_prefix"], 1)
        self.assertEqual(log.snapshot()["c2s:ttc_oall8_prefix"], 1)
        self.assertEqual(log.snapshot()["c2s:tns_data_packet"], 2)

    def test_incomplete_frame_is_explicit(self):
        _, log, decoder = self.fixture()
        decoder.feed("c2s", b"\x04\x00"); decoder.finish()
        self.assertEqual(log.snapshot()["c2s:incomplete_frame"], 1)

    def test_relay_preserves_actual_socket_bytes_without_logging_them(self):
        listener = socket.socket(); listener.bind(("127.0.0.1", 0)); listener.listen(1)
        output = io.StringIO()
        relay = Relay("tns", listener.getsockname(), WireLog(output)).start()
        payload = tns(6, b"\x00\x00private_bind")
        captured = []
        def upstream():
            client, _ = listener.accept()
            with client:
                client.settimeout(2)
                received = bytearray()
                while len(received) < len(payload):
                    chunk = client.recv(1024)
                    if not chunk: break
                    received.extend(chunk)
                captured.append(bytes(received)); client.sendall(received)
        worker = threading.Thread(target=upstream, daemon=True); worker.start()
        try:
            with socket.create_connection(("127.0.0.1", relay.port), timeout=2) as client:
                client.sendall(payload)
                received = bytearray()
                while len(received) < len(payload):
                    chunk = client.recv(1024)
                    if not chunk: break
                    received.extend(chunk)
                self.assertEqual(bytes(received), payload)
            worker.join(timeout=2)
            self.assertEqual(captured, [payload])
        finally: relay.close(); listener.close()
        self.assertNotIn("private_bind", output.getvalue())

    def test_correlates_wire_without_substituting_rpc_or_jdbc_counts(self):
        sample = {"kind": "sample", "scenario": "warm_query", "index": 0, "started_utc_ns": 10, "completed_utc_ns": 20, "rpc_requests": 9, "jdbc_isValid_calls": 7}
        events = [{"kind": "wire", "utc_ns": 15, "direction": "c2s", "category": "mysql_ping"}, {"kind": "wire", "utc_ns": 18, "direction": "c2s", "category": "mysql_query"}]
        row = correlate([sample], events)["sample_windows"][0]
        self.assertEqual(row["mysql_wire_commands"], {"mysql_ping": 1, "mysql_query": 1})
        self.assertNotIn("rpc_requests", row)
        self.assertNotIn("jdbc_isValid_calls", row)

    def test_raw_agent_errors_are_sanitized(self):
        self.assertEqual(sanitized_outcome({"error": {"message": "ORA-01013 user secret SELECT private"}}), ("cancelled", "ORA-01013"))
        self.assertEqual(sanitized_outcome({"error": {"message": "context deadline exceeded secret"}}), ("timeout", None))


if __name__ == "__main__":
    unittest.main()
