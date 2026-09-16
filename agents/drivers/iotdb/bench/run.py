#!/usr/bin/env python3
import json
import os
import socket
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path


BENCH_DIR = Path(__file__).resolve().parent
IOTDB_PROJECT = BENCH_DIR.parent
AGENTS_DIR = IOTDB_PROJECT.parents[1]
JDBC_JAR = BENCH_DIR / "build" / "libs" / "dbx-iotdb-jdbc-benchmark.jar"
GO_BINARY = BENCH_DIR / "build" / "iotdb-go-benchmark"


def main() -> None:
    environment = os.environ.copy()
    wait_for_server(environment)
    if not env_bool("BENCH_SKIP_BUILD", False):
        build_candidates()
    ensure_artifacts()
    if env_bool("BENCH_PREPARE", True):
        run_json(["java", "-jar", str(JDBC_JAR)], environment | {"IOTDB_BENCH_MODE": "prepare"})

    commands = {
        "jdbc": ["java", "-jar", str(JDBC_JAR)],
        "go": [str(GO_BINARY)],
    }
    names = benchmark_order(commands)
    startup_samples = {name: [] for name in commands}
    startup_iterations = env_int("BENCH_STARTUPS", 5)
    for iteration in range(startup_iterations):
        order = names if iteration % 2 == 0 else list(reversed(names))
        for name in order:
            started = time.perf_counter()
            run_json(commands[name], environment | {"IOTDB_BENCH_MODE": "probe"})
            startup_samples[name].append((time.perf_counter() - started) * 1_000)

    rss_samples = {name: [] for name in commands}
    for iteration in range(env_int("BENCH_RSS_SAMPLES", 3)):
        order = names if iteration % 2 == 0 else list(reversed(names))
        for name in order:
            rss_samples[name].append(measure_rss(commands[name], environment))

    rounds = {name: [] for name in commands}
    for iteration in range(env_int("BENCH_ROUNDS", 3)):
        order = names if iteration % 2 == 0 else list(reversed(names))
        for name in order:
            rounds[name].append(run_json(commands[name], environment | {"IOTDB_BENCH_MODE": "benchmark"}))

    output = {
        "server": {
            "host": environment.get("IOTDB_HOST", "127.0.0.1"),
            "port": int(environment.get("IOTDB_PORT", "6667")),
        },
        "config": {
            "rows": env_int("BENCH_ROWS", 10_000),
            "fetch_size": env_int("BENCH_FETCH_SIZE", 1_024),
            "warmups": env_int("BENCH_WARMUPS", 3),
        },
        "artifact_bytes": {
            "jdbc": JDBC_JAR.stat().st_size,
            "go": GO_BINARY.stat().st_size,
        },
        "startup_ms": {name: summarize(samples) for name, samples in startup_samples.items()},
        "connected_rss_kb": {name: summarize(samples) for name, samples in rss_samples.items()},
        "results": {name: summarize_rounds(values) for name, values in rounds.items()},
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


def build_candidates() -> None:
    subprocess.run(
        [str(AGENTS_DIR / "gradlew"), "-p", str(BENCH_DIR), "benchmarkJar", "--console=plain"],
        check=True,
        stdout=sys.stderr,
        stderr=sys.stderr,
    )
    GO_BINARY.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["go", "build", "-o", str(GO_BINARY), "."],
        cwd=BENCH_DIR / "go",
        check=True,
        stdout=sys.stderr,
        stderr=sys.stderr,
    )


def wait_for_server(environment: dict[str, str]) -> None:
    host = environment.get("IOTDB_HOST", "127.0.0.1")
    port = int(environment.get("IOTDB_PORT", "6667"))
    deadline = time.monotonic() + env_float("BENCH_SERVER_TIMEOUT", 60.0)
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1):
                return
        except OSError:
            time.sleep(0.5)
    raise TimeoutError(f"IoTDB is not reachable at {host}:{port}")


def run_json(command: list[str], environment: dict[str, str]) -> dict:
    completed = subprocess.run(
        command,
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=env_float("BENCH_COMMAND_TIMEOUT", 180.0),
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"command failed ({' '.join(command)}):\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    for line in reversed(completed.stdout.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise RuntimeError(f"command returned no JSON ({' '.join(command)}):\n{completed.stdout}")


def measure_rss(command: list[str], environment: dict[str, str]) -> float:
    process = subprocess.Popen(
        command,
        env=environment | {"IOTDB_BENCH_MODE": "hold"},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    stderr_lines: list[str] = []

    def drain_stderr() -> None:
        assert process.stderr is not None
        stderr_lines.extend(line.rstrip() for line in process.stderr)

    threading.Thread(target=drain_stderr, daemon=True).start()
    try:
        assert process.stdout is not None
        deadline = time.monotonic() + env_float("BENCH_READY_TIMEOUT", 30.0)
        while time.monotonic() < deadline:
            line = process.stdout.readline()
            if line == "" and process.poll() is not None:
                raise RuntimeError(f"RSS probe exited early: {'; '.join(stderr_lines)}")
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if payload.get("ready") is True:
                break
        else:
            raise TimeoutError(f"RSS probe timed out: {'; '.join(stderr_lines)}")
        time.sleep(0.2)
        completed = subprocess.run(
            ["ps", "-o", "rss=", "-p", str(process.pid)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        return float(completed.stdout.strip())
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def summarize(samples: list[float]) -> dict:
    ordered = sorted(samples)
    return {
        "count": len(samples),
        "mean": round(statistics.mean(samples), 3),
        "p50": round(percentile(ordered, 0.50), 3),
        "p95": round(percentile(ordered, 0.95), 3),
        "min": round(ordered[0], 3),
        "max": round(ordered[-1], 3),
    }


def summarize_rounds(rounds: list[dict]) -> dict:
    workloads: dict[str, list[dict]] = {}
    for result in rounds:
        for workload in result["workloads"]:
            workloads.setdefault(workload["name"], []).append(workload)
    return {
        "driver": rounds[0]["driver"],
        "client_version": rounds[0]["client_version"],
        "connect_ms": summarize([result["connect_ms"] for result in rounds]),
        "workloads": {
            name: {
                "rows": values[0]["rows"],
                "decoded_cells": values[0]["decoded_cells"],
                "round_mean_ms": summarize([value["mean_ms"] for value in values]),
                "round_p50_ms": summarize([value["p50_ms"] for value in values]),
                "round_p95_ms": summarize([value["p95_ms"] for value in values]),
            }
            for name, values in workloads.items()
        },
        "rounds": rounds,
    }


def percentile(values: list[float], fraction: float) -> float:
    index = max(0, min(len(values) - 1, int(len(values) * fraction + 0.999999) - 1))
    return values[index]


def ensure_artifacts() -> None:
    for path in (JDBC_JAR, GO_BINARY):
        if not path.is_file():
            raise FileNotFoundError(path)


def benchmark_order(commands: dict[str, list[str]]) -> list[str]:
    names = [name.strip() for name in os.getenv("BENCH_ORDER", "jdbc,go").split(",") if name.strip()]
    if len(names) != len(commands) or set(names) != set(commands):
        raise ValueError(f"BENCH_ORDER must contain exactly: {','.join(commands)}")
    return names


def env_int(name: str, fallback: int) -> int:
    value = int(os.getenv(name, str(fallback)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def env_float(name: str, fallback: float) -> float:
    value = float(os.getenv(name, str(fallback)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def env_bool(name: str, fallback: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return fallback
    return raw.strip().lower() in {"1", "true", "yes", "on"}


if __name__ == "__main__":
    main()
