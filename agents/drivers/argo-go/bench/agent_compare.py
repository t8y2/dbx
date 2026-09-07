#!/usr/bin/env python3
import json
import os
import queue
import shlex
import statistics
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Candidate:
    name: str
    command: list[str]
    artifact: Path
    rss_command: str = ""


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
        self.request_lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.pending: dict[int, queue.Queue] = {}
        self.ready = threading.Event()
        self.saw_ready = False
        self.exited = threading.Event()
        self.stderr_lines: list[str] = []
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        if not self.ready.wait(env_float("BENCH_READY_TIMEOUT", 30.0)) or not self.saw_ready:
            raise TimeoutError(self._failure("timed out waiting for agent readiness"))

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            try:
                response = json.loads(line)
            except json.JSONDecodeError:
                continue
            if response.get("ready") is True:
                self.saw_ready = True
                self.ready.set()
                continue
            response_id = response.get("id")
            if not isinstance(response_id, int):
                continue
            with self.request_lock:
                response_queue = self.pending.get(response_id)
            if response_queue is not None:
                response_queue.put(response)
        self.exited.set()
        self.ready.set()
        with self.request_lock:
            pending = list(self.pending.values())
        for response_queue in pending:
            response_queue.put(RuntimeError(self._failure("agent process exited")))

    def _drain_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self.stderr_lines.append(line.rstrip())

    def call(self, method: str, params: dict | None = None) -> object:
        if self.exited.is_set():
            raise RuntimeError(self._failure(f"agent exited before {method}"))
        with self.request_lock:
            self.request_id += 1
            request_id = self.request_id
            response_queue: queue.Queue = queue.Queue(maxsize=1)
            self.pending[request_id] = response_queue
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params or {},
        }
        try:
            assert self.process.stdin is not None
            with self.write_lock:
                self.process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
                self.process.stdin.flush()
            response = response_queue.get(timeout=env_float("BENCH_RPC_TIMEOUT", 180.0))
        except queue.Empty as error:
            raise TimeoutError(self._failure(f"timed out during {method}")) from error
        finally:
            with self.request_lock:
                self.pending.pop(request_id, None)
        if isinstance(response, Exception):
            raise response
        if response.get("error") is not None:
            raise RuntimeError(
                f"{self.candidate.name} {method}: "
                f"{json.dumps(response['error'], ensure_ascii=False)}"
            )
        return response.get("result")

    def rss_kib(self) -> int:
        if self.candidate.rss_command:
            output = subprocess.check_output(
                self.candidate.rss_command,
                shell=True,
                text=True,
            ).strip()
            return int(output or "0")
        status_path = Path(f"/proc/{self.process.pid}/status")
        if status_path.is_file():
            for line in status_path.read_text().splitlines():
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
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


class RSSMonitor:
    def __init__(self, process: AgentProcess):
        self.process = process
        self.peak_kib = 0
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self):
        self.peak_kib = self.process.rss_kib()
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.stop_event.set()
        self.thread.join(timeout=1)
        try:
            self.peak_kib = max(self.peak_kib, self.process.rss_kib())
        except (OSError, subprocess.SubprocessError, ValueError):
            pass

    def _run(self) -> None:
        interval = env_float("BENCH_RSS_INTERVAL", 0.02)
        while not self.stop_event.wait(interval):
            try:
                self.peak_kib = max(self.peak_kib, self.process.rss_kib())
            except (OSError, subprocess.SubprocessError, ValueError):
                return


def main() -> None:
    candidates = configured_candidates()
    connection = connection_params()
    startup_iterations = env_int("BENCH_STARTUPS", 8)
    connect_iterations = env_int("BENCH_CONNECTS", 8)
    rounds = env_int("BENCH_ROUNDS", 3)
    warmups = env_int("BENCH_WARMUPS", 2)
    workloads = configured_workloads(connection["database"])
    concurrency_levels = env_int_list("BENCH_CONCURRENCY", [1, 8, 32])

    startup_samples = {candidate.name: [] for candidate in candidates}
    connect_samples = {candidate.name: [] for candidate in candidates}
    workload_samples = {
        candidate.name: {workload["name"]: [] for workload in workloads}
        for candidate in candidates
    }
    concurrency_samples = {
        candidate.name: {str(level): [] for level in concurrency_levels}
        for candidate in candidates
    }
    process_metrics = {candidate.name: [] for candidate in candidates}

    for iteration in range(startup_iterations):
        for candidate in rotated(candidates, iteration):
            startup_samples[candidate.name].append(benchmark_startup(candidate))

    for iteration in range(connect_iterations):
        for candidate in rotated(candidates, iteration):
            connect_samples[candidate.name].append(benchmark_connect(candidate, connection))

    for round_index in range(rounds):
        for candidate in rotated(candidates, round_index):
            process = AgentProcess(candidate)
            shutdown_clean = False
            metrics = None
            try:
                process.call("connect", connection)
                idle_rss_kib = process.rss_kib()
                with RSSMonitor(process) as monitor:
                    for workload in workloads:
                        sample = benchmark_workload(process, workload, warmups)
                        workload_samples[candidate.name][workload["name"]].append(sample)
                process.call("disconnect")
                metrics = {
                    "idle_rss_kib": idle_rss_kib,
                    "peak_rss_kib": monitor.peak_kib,
                }
            finally:
                shutdown_clean = process.close()
            if metrics is not None:
                metrics["shutdown_exited_within_3s"] = shutdown_clean
                process_metrics[candidate.name].append(metrics)

        for level in concurrency_levels:
            for candidate in rotated(candidates, round_index + level):
                concurrency_samples[candidate.name][str(level)].append(
                    benchmark_concurrency(candidate, connection, level, warmups)
                )

    results = []
    for candidate in candidates:
        name = candidate.name
        results.append(
            {
                "candidate": name,
                "command": candidate.command,
                "artifact_bytes": candidate.artifact.stat().st_size,
                "startup": summarize_latencies(startup_samples[name]),
                "connect": summarize_latencies(connect_samples[name]),
                "process": summarize_process_metrics(process_metrics[name]),
                "workloads": [
                    summarize_rounds(workload["name"], workload_samples[name][workload["name"]])
                    for workload in workloads
                ],
                "concurrency": [
                    summarize_rounds(f"concurrency_{level}", concurrency_samples[name][str(level)])
                    for level in concurrency_levels
                ],
            }
        )

    output = {
        "host": os.uname().nodename,
        "server": env_default("HIVE_SERVER", f"{connection['host']}:{connection['port']}"),
        "database": connection["database"],
        "table": env_default("HIVE_BENCH_TABLE", "agent_bench"),
        "startup_iterations": startup_iterations,
        "connect_iterations": connect_iterations,
        "rounds": rounds,
        "warmups": warmups,
        "concurrency_levels": concurrency_levels,
        "results": results,
    }
    json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def configured_candidates() -> list[Candidate]:
    selected = {
        item.strip()
        for item in env_default("BENCH_CANDIDATES", "go,jdbc").split(",")
        if item.strip()
    }
    candidates = []
    if "go" in selected:
        artifact = required_path("GO_AGENT")
        raw_command = os.getenv("GO_AGENT_COMMAND", "")
        command = shlex.split(raw_command) if raw_command else [str(artifact)]
        candidates.append(
            Candidate("go-native", command, artifact, os.getenv("GO_RSS_COMMAND", ""))
        )
    if "jdbc" in selected:
        artifact = required_path("JDBC_AGENT_JAR")
        raw_command = os.getenv("JDBC_AGENT_COMMAND", "")
        command = (
            shlex.split(raw_command)
            if raw_command
            else [env_default("JAVA_BIN", "java"), "-jar", str(artifact)]
        )
        candidates.append(
            Candidate("jdbc-java", command, artifact, os.getenv("JDBC_RSS_COMMAND", ""))
        )
    if not candidates:
        raise ValueError("BENCH_CANDIDATES selected no candidates")
    return candidates


def connection_params() -> dict:
    return {
        "host": env_default("HIVE_HOST", "127.0.0.1"),
        "port": env_int("HIVE_PORT", 10000),
        "database": env_default("HIVE_DATABASE", "dbx_agent_bench"),
        "username": os.getenv("HIVE_USERNAME", ""),
        "password": os.getenv("HIVE_PASSWORD", ""),
        "url_params": env_default("HIVE_URL_PARAMS", "auth=noSasl"),
        "connection_string": os.getenv("HIVE_CONNECTION_STRING", ""),
        "ssl": env_bool("HIVE_SSL", False),
        "ca_cert_path": os.getenv("HIVE_CA_CERT_PATH", ""),
        "client_cert_path": os.getenv("HIVE_CLIENT_CERT_PATH", ""),
        "client_key_path": os.getenv("HIVE_CLIENT_KEY_PATH", ""),
        "connect_timeout_secs": env_int("HIVE_CONNECT_TIMEOUT", 30),
    }


def configured_workloads(database: str) -> list[dict]:
    table = env_default("HIVE_BENCH_TABLE", "agent_bench")
    qualified = f"`{database}`.`{table}`"
    workloads = [
        query_workload("select_one", "SELECT 1 AS value", 1, 40),
        query_workload("rows_100", f"SELECT id, payload FROM {qualified} LIMIT 100", 100, 20),
        query_workload("rows_1000", f"SELECT id, payload FROM {qualified} LIMIT 1000", 1000, 10),
        query_workload("rows_10000", f"SELECT id, payload FROM {qualified} LIMIT 10000", 10000, 3),
        {
            "name": "list_databases",
            "kind": "rpc",
            "method": "list_databases",
            "params": {},
            "count": env_int("BENCH_LIST_DATABASES_COUNT", 20),
        },
        {
            "name": "list_tables",
            "kind": "rpc",
            "method": "list_tables",
            "params": {"schema": database},
            "count": env_int("BENCH_LIST_TABLES_COUNT", 20),
        },
        {
            "name": "page_10000_by_500",
            "kind": "paged",
            "sql": env_default("BENCH_PAGE_SQL", f"SELECT id, payload FROM {qualified} LIMIT 10000"),
            "max_rows": 10000,
            "page_size": env_int("BENCH_PAGE_SIZE", 500),
            "count": env_int("BENCH_PAGE_COUNT", 3),
        },
    ]
    return workloads


def query_workload(name: str, fallback_sql: str, max_rows: int, fallback_count: int) -> dict:
    suffix = name.upper()
    return {
        "name": name,
        "kind": "rpc",
        "method": "execute_query",
        "params": {
            "sql": env_default(f"BENCH_{suffix}_SQL", fallback_sql),
            "maxRows": max_rows,
            "fetchSize": min(max_rows, env_int("BENCH_FETCH_SIZE", 1000)),
        },
        "count": env_int(f"BENCH_{suffix}_COUNT", fallback_count),
    }


def benchmark_startup(candidate: Candidate) -> float:
    started = time.perf_counter()
    process = AgentProcess(candidate)
    elapsed = elapsed_ms(started)
    process.close()
    return elapsed


def benchmark_connect(candidate: Candidate, connection: dict) -> float:
    process = AgentProcess(candidate)
    try:
        started = time.perf_counter()
        process.call("connect", connection)
        return elapsed_ms(started)
    finally:
        process.close()


def benchmark_workload(process: AgentProcess, workload: dict, warmups: int) -> dict:
    for _ in range(warmups):
        execute_workload(process, workload)
    samples = []
    started = time.perf_counter()
    for _ in range(workload["count"]):
        operation_started = time.perf_counter()
        execute_workload(process, workload)
        samples.append(elapsed_ms(operation_started))
    elapsed = time.perf_counter() - started
    return sample_result(workload["count"], elapsed, samples)


def benchmark_concurrency(
    candidate: Candidate,
    connection: dict,
    concurrency: int,
    warmups: int,
) -> dict:
    process = AgentProcess(candidate)
    session_ids = [f"bench-{concurrency}-{index}" for index in range(concurrency)]
    qualified = (
        f"`{connection['database']}`."
        f"`{env_default('HIVE_BENCH_TABLE', 'agent_bench')}`"
    )
    workload = {
        "kind": "rpc",
        "method": "execute_query",
        "params": {
            "sql": env_default(
                "BENCH_CONCURRENCY_SQL",
                "SELECT 1 AS value",
            ),
            "maxRows": 1,
        },
    }
    operations_per_worker = env_int("BENCH_CONCURRENCY_OPS_PER_WORKER", 8)
    try:
        for session_id in session_ids:
            process.call("open_session", {**connection, "agentSessionId": session_id})
        for session_id in session_ids:
            for _ in range(warmups):
                execute_workload(process, workload, session_id)
        with RSSMonitor(process) as monitor:
            started = time.perf_counter()
            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                futures = [
                    executor.submit(
                        concurrency_worker,
                        process,
                        workload,
                        session_id,
                        operations_per_worker,
                    )
                    for session_id in session_ids
                ]
                samples = [sample for future in futures for sample in future.result()]
            elapsed = time.perf_counter() - started
        result = sample_result(len(samples), elapsed, samples)
        result["concurrency"] = concurrency
        result["peak_rss_kib"] = monitor.peak_kib
        return result
    finally:
        for session_id in session_ids:
            try:
                process.call("close_session", {"agentSessionId": session_id})
            except Exception:
                pass
        process.close()


def concurrency_worker(
    process: AgentProcess,
    workload: dict,
    session_id: str,
    operations: int,
) -> list[float]:
    samples = []
    for _ in range(operations):
        started = time.perf_counter()
        execute_workload(process, workload, session_id)
        samples.append(elapsed_ms(started))
    return samples


def execute_workload(
    process: AgentProcess,
    workload: dict,
    agent_session_id: str = "",
) -> object:
    params = dict(workload.get("params", {}))
    if agent_session_id:
        params["agentSessionId"] = agent_session_id
    if workload["kind"] == "rpc":
        return process.call(workload["method"], params)
    if workload["kind"] != "paged":
        raise ValueError(f"unknown workload kind: {workload['kind']}")
    first = process.call(
        "execute_query_page",
        {
            "sql": workload["sql"],
            "maxRows": workload["max_rows"],
            "pageSize": workload["page_size"],
            **({"agentSessionId": agent_session_id} if agent_session_id else {}),
        },
    )
    rows = len(first.get("rows", []))
    session_id = first.get("session_id")
    has_more = first.get("has_more", False)
    try:
        while has_more:
            page = process.call(
                "fetch_query_page",
                {
                    "sessionId": session_id,
                    "pageSize": workload["page_size"],
                    **({"agentSessionId": agent_session_id} if agent_session_id else {}),
                },
            )
            rows += len(page.get("rows", []))
            session_id = page.get("session_id")
            has_more = page.get("has_more", False)
    finally:
        if session_id:
            process.call(
                "close_query_session",
                {
                    "sessionId": session_id,
                    **({"agentSessionId": agent_session_id} if agent_session_id else {}),
                },
            )
    if rows != workload["max_rows"]:
        raise RuntimeError(
            f"{process.candidate.name} paged query returned {rows} rows, "
            f"expected {workload['max_rows']}"
        )
    return rows


def sample_result(count: int, elapsed: float, samples: list[float]) -> dict:
    summary = summarize_latencies(samples)
    summary.update(
        {
            "count": count,
            "elapsed_ms": elapsed * 1000,
            "ops_per_sec": count / elapsed,
        }
    )
    return summary


def summarize_latencies(samples: list[float]) -> dict:
    ordered = sorted(samples)
    return {
        "samples_ms": samples,
        "mean_ms": statistics.mean(samples),
        "p50_ms": percentile(ordered, 0.50),
        "p95_ms": percentile(ordered, 0.95),
        "p99_ms": percentile(ordered, 0.99),
        "min_ms": ordered[0],
        "max_ms": ordered[-1],
    }


def summarize_rounds(name: str, rounds: list[dict]) -> dict:
    latencies = [sample for round_result in rounds for sample in round_result["samples_ms"]]
    elapsed = sum(round_result["elapsed_ms"] for round_result in rounds) / 1000
    result = summarize_latencies(latencies)
    result.update(
        {
            "name": name,
            "rounds": rounds,
            "count": len(latencies),
            "elapsed_ms": elapsed * 1000,
            "ops_per_sec": len(latencies) / elapsed,
        }
    )
    peak_values = [round_result.get("peak_rss_kib", 0) for round_result in rounds]
    if any(peak_values):
        result["peak_rss_kib"] = max(peak_values)
    return result


def summarize_process_metrics(samples: list[dict]) -> dict:
    return {
        "idle_rss_kib": summarize_numbers([sample["idle_rss_kib"] for sample in samples]),
        "peak_rss_kib": summarize_numbers([sample["peak_rss_kib"] for sample in samples]),
        "shutdown_exited_within_3s": all(
            sample["shutdown_exited_within_3s"] for sample in samples
        ),
        "rounds": samples,
    }


def summarize_numbers(values: list[int]) -> dict:
    return {
        "min": min(values),
        "median": statistics.median(values),
        "max": max(values),
    }


def rotated(values: list[Candidate], offset: int) -> list[Candidate]:
    if not values:
        return []
    shift = offset % len(values)
    return values[shift:] + values[:shift]


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    index = min(len(values) - 1, max(0, round((len(values) - 1) * fraction)))
    return values[index]


def elapsed_ms(started: float) -> float:
    return (time.perf_counter() - started) * 1000


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


def env_int_list(name: str, fallback: list[int]) -> list[int]:
    raw = os.getenv(name, "")
    values = fallback if not raw else [int(value.strip()) for value in raw.split(",")]
    if not values or any(value < 1 for value in values):
        raise ValueError(f"{name} must contain positive integers")
    return values


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
