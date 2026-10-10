"""Join sanitized wire metadata to sample windows without conflating RPC and DB requests."""
import argparse
import json
import math
from collections import Counter
from datetime import datetime
from pathlib import Path

MYSQL_REQUESTS = {"mysql_query", "mysql_ping", "mysql_prepare", "mysql_execute", "mysql_fetch", "mysql_init_db", "mysql_quit", "mysql_long_data", "mysql_stmt_close", "mysql_other_command"}
TTC_PREFIXES = {"ttc_ping_prefix", "ttc_oall8_prefix", "ttc_logoff_prefix", "ttc_other_function_prefix"}
LIMITATIONS = {"mysql_tls_or_compressed_not_decoded", "mysql_ob20_not_decoded", "tls_transport_not_decoded", "opaque_transport", "decode_invalid_length", "incomplete_frame", "tns_redirect", "tns_request_semantics_not_decoded", "tns_request_order_unknown", "mysql_request_order_unknown"}
TURNAROUNDS = {f"{name}_first_response" for name in MYSQL_REQUESTS | TTC_PREFIXES}
SCENARIOS = {"connect", "cold_query", "warm_query", "idle_query", "invalid_hot", "invalid_expired", "reconnect", "after_reconnect", "cancel_race", "after_cancel", "disconnect", "after_explicit_reconnect"}


def utc_ns(value):
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1_000_000_000)


def correlate(samples, events):
    result = []
    for sample in samples:
        if sample.get("kind") != "sample" or sample.get("scenario") not in SCENARIOS:
            continue
        try:
            start = sample["started_utc_ns"] if "started_utc_ns" in sample else utc_ns(sample["at"])
            end = sample["completed_utc_ns"] if "completed_utc_ns" in sample else utc_ns(sample["completed_at"])
            if type(start) is not int or type(end) is not int or end < start:
                raise ValueError()
        except (KeyError, ValueError, TypeError, AttributeError):
            result.append({"scenario": sample["scenario"], "coverage": "sample_window_missing"})
            continue
        window = [event for event in events if event.get("kind") == "wire" and type(event.get("utc_ns")) is int and start <= event["utc_ns"] <= end]
        categories = Counter(event.get("category") for event in window if event.get("direction") == "c2s")
        limitations = sorted({event["category"] for event in window if event.get("category") in LIMITATIONS})
        tns = categories.get("tns_data_packet", 0)
        row = {
            "scenario": sample["scenario"], "index": sample.get("index") if type(sample.get("index")) is int else None,
            "mysql_wire_commands": {name: count for name, count in categories.items() if name in MYSQL_REQUESTS},
            "oracle_tns_request_packets": tns,
            "oracle_ttc_prefix_lower_bounds": {name: count for name, count in categories.items() if name in TTC_PREFIXES},
            "limitations": limitations,
            "coverage": "partial_or_opaque" if limitations else "observed_frames_only",
            "first_response_ms": {name: [event["first_response_ms"] for event in window if event.get("category") == name and type(event.get("first_response_ms")) in (int, float) and math.isfinite(event["first_response_ms"]) and event["first_response_ms"] >= 0] for name in TURNAROUNDS if any(event.get("category") == name for event in window)},
            "scope": "actual relay frames in sample window; TNS packets and TTC lower bounds are not total logical database requests",
        }
        result.append(row)
    return {"format": "dbx-wire-health-summary-v1", "sample_windows": result,
            "capture_limitations": sorted({event["category"] for event in events if event.get("category") in LIMITATIONS})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("samples", type=Path); parser.add_argument("wire", type=Path)
    args = parser.parse_args()
    try:
        with args.samples.open(encoding="utf-8") as source: samples = [json.loads(line) for line in source if line.strip()]
        with args.wire.open(encoding="utf-8") as source: events = [json.loads(line) for line in source if line.strip()]
        if not all(isinstance(row, dict) for row in samples + events): raise ValueError()
        print(json.dumps(correlate(samples, events), ensure_ascii=False, indent=2))
    except (OSError, ValueError, TypeError): parser.exit(1, "Cannot summarize sanitized evidence; raw rows were not printed.\n")


if __name__ == "__main__":
    main()
