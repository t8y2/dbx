"""Summarize sanitized health-probe JSONL; never print raw rows or error messages."""
import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

METRICS = (
    "dispatch_ms", "jdbc_isValid_calls", "jdbc_isValid_ms",
    "jdbc_statement_execute_calls", "jdbc_statement_execute_ms",
    "physical_connect_calls", "jdbc_cancel_calls",
    "reported_execution_ms",
)


def distribution(values):
    ordered = sorted(values)
    return {
        "n": len(ordered), "min": ordered[0],
        "p50": ordered[math.ceil(len(ordered) * .50) - 1],
        "p95": ordered[math.ceil(len(ordered) * .95) - 1], "max": ordered[-1],
    }


def summarize(rows):
    groups = defaultdict(list)
    allowed = {"connect", "cold_query", "warm_query", "idle_query", "invalid_hot", "invalid_expired", "reconnect", "after_reconnect", "cancel_race", "after_cancel", "disconnect", "after_explicit_reconnect"}
    outcomes = {"success", "error", "incorrect_result", "completed_during_cancel_race", "cancelled", "timeout", "rpc_timeout", "rpc_error"}
    for row in rows:
        if row.get("kind") == "sample" and row.get("scenario") in allowed:
            groups[row["scenario"]].append(row)
    result = {}
    for scenario, samples in sorted(groups.items()):
        counts = Counter(row.get("outcome") if row.get("outcome") in outcomes else "unknown" for row in samples)
        # Do not mix failure/cancellation latencies with successful-query distributions.
        by_outcome = {}
        for outcome in counts:
            selected = [row for row in samples if (row.get("outcome") if row.get("outcome") in outcomes else "unknown") == outcome]
            metrics = {}
            for metric in METRICS:
                values = [row[metric] for row in selected if type(row.get(metric)) in (int, float) and math.isfinite(row[metric]) and row[metric] >= 0]
                if values:
                    metrics[metric] = distribution(values)
            by_outcome[outcome] = metrics
        result[scenario] = {"outcomes": dict(counts), "by_outcome": by_outcome}
    return {"format": "dbx-health-summary-v1", "scope": "sample-defined dispatch/RPC boundary and reported counters; not pure database execution or GUI latency", "scenarios": result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    try:
        with args.evidence.open(encoding="utf-8") as source:
            rows = [json.loads(line) for line in source if line.strip()]
        if not all(isinstance(row, dict) for row in rows):
            raise ValueError()
        print(json.dumps(summarize(rows), ensure_ascii=False, indent=2))
    except (OSError, ValueError, TypeError):
        parser.exit(1, "Cannot read sanitized evidence; raw input was not printed.\n")


if __name__ == "__main__":
    main()
