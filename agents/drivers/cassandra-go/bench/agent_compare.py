#!/usr/bin/env python3
import json
import os
import statistics
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Candidate:
    name: str
    command: list[str]
    artifact: Path


def command_env_list(name: str) -> list[str]:
    """Reads a command from an env var holding a JSON argv array.

    Command env vars take JSON arrays so no shell is implied; operators who
    need shell features pass ["sh", "-c", "..."] explicitly.
    """
    raw = os.getenv(name, "")
    if not raw:
        return []
    value = json.loads(raw)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{name} must be a JSON array of strings")
    return [item for item in value]


class AgentProcess:
    def __init__(self, candidate: Candidate):
        self.candidate = candidate
        self.process = subprocess.Popen(
            candidate.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.request_id = 0
        self.stderr_lines: list[str] = []
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        self._wait_ready()

    def _drain_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self.stderr_lines.append(line.rstrip())

    def _wait_ready(self) -> None:
        assert self.process.stdout is not None
        deadline = time.monotonic() + env_float("BENCH_READY_TIMEOUT", 30.0)
        while time.monotonic() < deadline:
            line = self.process.stdout.readline()
            if line == "" and self.process.poll() is not None:
                raise RuntimeError(self._failure("agent exited before ready"))
            try:
                if json.loads(line).get("ready") is True:
                    return
            except (json.JSONDecodeError, AttributeError):
                continue
        raise TimeoutError(self._failure("timed out waiting for agent readiness"))

    def call(self, method: str, params: dict | None = None) -> dict:
        self.request_id += 1
        request = {
            "jsonrpc": "2.0",
            "id": self.request_id,
            "method": method,
            "params": params or {},
        }
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        self.process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        while True:
            line = self.process.stdout.readline()
            if line == "" and self.process.poll() is not None:
                raise RuntimeError(self._failure(f"agent exited during {method}"))
            try:
                response = json.loads(line)
            except json.JSONDecodeError:
                continue
            if response.get("id") != self.request_id:
                continue
            if response.get("error") is not None:
                raise RuntimeError(f"{self.candidate.name} {method}: {json.dumps(response['error'], ensure_ascii=False)}")
            return response.get("result")

    def rss_kib(self) -> int:
        output = subprocess.check_output(
            ["ps", "-o", "rss=", "-p", str(self.process.pid)],
            text=True,
        ).strip()
        return int(output or "0")

    def close(self) -> bool:
        if self.process.poll() is not None:
            return True
        try:
            self.call("shutdown")
        except Exception:
            pass
        try:
            self.process.wait(timeout=3)
            return True
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            return False

    def _failure(self, message: str) -> str:
        stderr = "\n".join(self.stderr_lines[-20:])
        return f"{self.candidate.name}: {message}\n{stderr}".rstrip()


def main() -> None:
    candidates = configured_candidates()
    connection = connection_params()
    startup_iterations = env_int("BENCH_STARTUPS", 10)
    connect_iterations = env_int("BENCH_CONNECTS", 10)
    warmups = env_int("BENCH_WARMUPS", 20)
    workloads = configured_workloads(connection["database"])
    results = []

    for candidate in candidates:
        startup_samples = benchmark_startup(candidate, startup_iterations)
        connect_samples = benchmark_connect(candidate, connection, connect_iterations)
        process = AgentProcess(candidate)
        shutdown_clean = False
        try:
            process.call("connect", connection)
            rss_kib = process.rss_kib()
            workload_results = [benchmark_workload(process, workload, warmups) for workload in workloads]
            process.call("disconnect")
        finally:
            shutdown_clean = process.close()
        results.append(
            {
                "candidate": candidate.name,
                "command": candidate.command,
                "artifact_bytes": candidate.artifact.stat().st_size,
                "startup_ms": statistics.median(startup_samples),
                "startup_samples_ms": startup_samples,
                "connect_ms": statistics.median(connect_samples),
                "connect_samples_ms": connect_samples,
                "rss_kib": rss_kib,
                "shutdown_exited_within_3s": shutdown_clean,
                "workloads": workload_results,
            }
        )

    output = {
        "host": os.uname().nodename,
        "server": env_default("CASSANDRA_SERVER", f"{connection['host']}:{connection['port']}"),
        "keyspace": connection["database"],
        "startup_iterations": startup_iterations,
        "connect_iterations": connect_iterations,
        "warmups": warmups,
        "results": results,
    }
    json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def configured_candidates() -> list[Candidate]:
    selected = {item.strip() for item in env_default("BENCH_CANDIDATES", "go,jdbc").split(",") if item.strip()}
    candidates = []
    if "go" in selected:
        artifact = required_path("GO_AGENT")
        candidates.append(Candidate("go-native", [str(artifact)], artifact))
    if "jdbc" in selected:
        artifact = required_path("JDBC_AGENT_JAR")
        command = command_env_list("JDBC_AGENT_COMMAND") or [env_default("JAVA_BIN", "java"), "-jar", str(artifact)]
        candidates.append(Candidate("jdbc-java", command, artifact))
    if not candidates:
        raise ValueError("BENCH_CANDIDATES selected no candidates")
    return candidates


def connection_params() -> dict:
    return {
        "host": env_default("CASSANDRA_HOST", "127.0.0.1"),
        "port": env_int("CASSANDRA_PORT", 9042),
        "database": env_default("CASSANDRA_KEYSPACE", "dbx_native_test"),
        "username": os.getenv("CASSANDRA_USERNAME", ""),
        "password": os.getenv("CASSANDRA_PASSWORD", ""),
        "url_params": os.getenv("CASSANDRA_URL_PARAMS", ""),
        "connection_string": os.getenv("CASSANDRA_CONNECTION_STRING", ""),
        "ssl": env_bool("CASSANDRA_SSL", False),
        "ca_cert_path": os.getenv("CASSANDRA_CA_CERT_PATH", ""),
        "client_cert_path": os.getenv("CASSANDRA_CLIENT_CERT_PATH", ""),
        "client_key_path": os.getenv("CASSANDRA_CLIENT_KEY_PATH", ""),
    }


def configured_workloads(keyspace: str) -> list[dict]:
    table = env_default("CASSANDRA_BENCH_TABLE", "all_types")
    qualified = f'"{keyspace}"."{table}"'
    return [
        {
            "name": "select_one",
            "method": "execute_query",
            "params": {"sql": env_default("BENCH_SELECT_ONE_SQL", f"SELECT id, txt FROM {qualified} WHERE id = 1"), "schema": keyspace, "maxRows": 1},
            "count": env_int("BENCH_SELECT_ONE_COUNT", 1000),
        },
        {
            "name": "decode_all_types",
            "method": "execute_query",
            "params": {"sql": env_default("BENCH_DECODE_SQL", f"SELECT * FROM {qualified} WHERE id = 1"), "schema": keyspace, "maxRows": 1},
            "count": env_int("BENCH_DECODE_COUNT", 500),
        },
        {
            "name": "list_tables",
            "method": "list_tables",
            "params": {"schema": keyspace},
            "count": env_int("BENCH_LIST_TABLES_COUNT", 500),
        },
        {
            "name": "page_100",
            "method": "execute_query_page",
            "params": {
                "sql": env_default("BENCH_PAGE_SQL", f"SELECT id, txt FROM {qualified}"),
                "schema": keyspace,
                "maxRows": 100,
                "pageSize": 100,
            },
            "count": env_int("BENCH_PAGE_COUNT", 200),
        },
    ]


def benchmark_startup(candidate: Candidate, iterations: int) -> list[float]:
    samples = []
    for _ in range(iterations):
        start = time.perf_counter()
        process = AgentProcess(candidate)
        samples.append((time.perf_counter() - start) * 1000)
        process.close()
    return samples


def benchmark_connect(candidate: Candidate, connection: dict, iterations: int) -> list[float]:
    samples = []
    for _ in range(iterations):
        process = AgentProcess(candidate)
        try:
            start = time.perf_counter()
            process.call("connect", connection)
            samples.append((time.perf_counter() - start) * 1000)
        finally:
            process.close()
    return samples


def benchmark_workload(process: AgentProcess, workload: dict, warmups: int) -> dict:
    for _ in range(warmups):
        process.call(workload["method"], workload["params"])
    samples = []
    start = time.perf_counter()
    for _ in range(workload["count"]):
        operation_start = time.perf_counter()
        process.call(workload["method"], workload["params"])
        samples.append((time.perf_counter() - operation_start) * 1000)
    elapsed = time.perf_counter() - start
    ordered = sorted(samples)
    return {
        "name": workload["name"],
        "count": workload["count"],
        "elapsed_ms": elapsed * 1000,
        "ops_per_sec": workload["count"] / elapsed,
        "mean_ms": statistics.mean(samples),
        "p50_ms": percentile(ordered, 0.50),
        "p95_ms": percentile(ordered, 0.95),
        "p99_ms": percentile(ordered, 0.99),
    }


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    index = min(len(values) - 1, max(0, round((len(values) - 1) * fraction)))
    return values[index]


def required_path(name: str) -> Path:
    value = os.getenv(name, "")
    if not value:
        raise ValueError(f"{name} is required")
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    return path


def env_default(name: str, fallback: str) -> str:
    return os.getenv(name, "") or fallback


def env_int(name: str, fallback: int) -> int:
    value = int(env_default(name, str(fallback)))
    if value < 1:
        raise ValueError(f"{name} must be positive")
    return value


def env_float(name: str, fallback: float) -> float:
    value = float(env_default(name, str(fallback)))
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def env_bool(name: str, fallback: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return fallback
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


if __name__ == "__main__":
    main()
