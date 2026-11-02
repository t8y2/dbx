#!/usr/bin/env python3
import hashlib
import json
import os
import sys
from pathlib import Path

from agent_compare import AgentProcess, configured_candidates, connection_params, env_default, env_int


def main() -> None:
    os.environ.setdefault("BENCH_CANDIDATES", "go")
    connection = connection_params()
    candidates = configured_candidates()
    results = {candidate.name: probe_candidate(candidate, connection) for candidate in candidates}
    output = {
        "server": env_default("HIVE_SERVER", f"{connection['host']}:{connection['port']}"),
        "connection": sanitized_connection(connection),
        "artifacts": {
            candidate.name: {
                "path": str(candidate.artifact),
                "sha256": sha256(candidate.artifact),
                "size_bytes": candidate.artifact.stat().st_size,
            }
            for candidate in candidates
        },
        "results": results,
        "parity": compare_results(results),
    }
    json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    if any(not result.get("ok") for result in results.values()) or not output["parity"]["ok"]:
        raise SystemExit(1)


def probe_candidate(candidate, connection: dict) -> dict:
    process = None
    session_id = f"functional-probe-{candidate.name}"
    result = {"ok": False}
    try:
        process = AgentProcess(candidate)
        result["test_connection"] = process.call("test_connection", connection)
        process.call("open_session", {"agentSessionId": session_id, **connection})
        result["validate_session"] = process.call("validate_session", {"agentSessionId": session_id})
        result["select_one"] = normalized_query(
            process.call(
                "execute_query",
                {
                    "agentSessionId": session_id,
                    "sql": env_default("PROBE_SELECT_SQL", "SELECT 1 AS value"),
                    "maxRows": env_int("PROBE_SELECT_MAX_ROWS", 10),
                    "fetchSize": env_int("PROBE_FETCH_SIZE", 10),
                },
            )
        )
        result["databases"] = sorted(
            item.get("name", "")
            for item in process.call("list_databases", {"agentSessionId": session_id})
        )
        schema = env_default("PROBE_SCHEMA", connection["database"])
        result["tables"] = sorted(
            item.get("name", "")
            for item in process.call(
                "list_tables",
                {"agentSessionId": session_id, "schema": schema},
            )
        )
        result["paging"] = probe_paging(process, session_id)
        result["invalid_sql"] = probe_failure_semantics(process, session_id)
        result["after_failure"] = normalized_query(
            process.call(
                "execute_query",
                {
                    "agentSessionId": session_id,
                    "sql": env_default("PROBE_AFTER_FAILURE_SQL", "SELECT 2 AS value"),
                    "maxRows": 10,
                    "fetchSize": env_int("PROBE_FETCH_SIZE", 10),
                },
            )
        )
        process.call("close_session", {"agentSessionId": session_id})
        result["ok"] = True
    except Exception as error:
        result["error"] = str(error)
    finally:
        if process is not None:
            result["clean_shutdown"] = process.close()
    return result


def probe_paging(process: AgentProcess, agent_session_id: str) -> dict:
    page_size = env_int("PROBE_PAGE_SIZE", 2)
    first = process.call(
        "execute_query_page",
        {
            "agentSessionId": agent_session_id,
            "sql": env_default(
                "PROBE_PAGE_SQL",
                "SELECT id, payload FROM dbx_agent_bench.agent_bench LIMIT 3",
            ),
            "maxRows": env_int("PROBE_PAGE_MAX_ROWS", 3),
            "pageSize": page_size,
        },
    )
    pages = [first]
    query_session_id = first.get("session_id")
    while pages[-1].get("has_more"):
        pages.append(
            process.call(
                "fetch_query_page",
                {
                    "agentSessionId": agent_session_id,
                    "sessionId": query_session_id,
                    "pageSize": page_size,
                },
            )
        )
    return {
        "columns": first.get("columns", []),
        "column_types": first.get("column_types", []),
        "rows": [row for page in pages for row in page.get("rows", [])],
        "page_count": len(pages),
        "has_more_final": pages[-1].get("has_more", False),
        "truncated": any(page.get("truncated", False) for page in pages),
    }


def probe_failure_semantics(process: AgentProcess, agent_session_id: str) -> dict:
    try:
        process.call(
            "execute_query",
            {
                "agentSessionId": agent_session_id,
                "sql": env_default(
                    "PROBE_INVALID_SQL",
                    "SELECT * FROM dbx_missing_table_for_failure_semantics",
                ),
                "maxRows": 10,
                "fetchSize": env_int("PROBE_FETCH_SIZE", 10),
            },
        )
    except Exception as error:
        return {"failed": True, "error": str(error)}
    return {"failed": False, "error": ""}


def normalized_query(result: dict) -> dict:
    return {
        "columns": result.get("columns", []),
        "column_types": result.get("column_types", []),
        "rows": result.get("rows", []),
        "truncated": result.get("truncated", False),
    }


def compare_results(results: dict) -> dict:
    successful = [result for result in results.values() if result.get("ok")]
    if len(successful) < 2:
        return {"ok": len(results) == 1 and len(successful) == 1, "differences": []}
    baseline = successful[0]
    differences = []
    for field in ["select_one", "databases", "tables", "paging", "after_failure"]:
        expected = baseline.get(field)
        for candidate_name, candidate_result in results.items():
            if candidate_result.get("ok") and candidate_result.get(field) != expected:
                differences.append(
                    {
                        "candidate": candidate_name,
                        "field": field,
                        "expected": expected,
                        "actual": candidate_result.get(field),
                    }
                )
    for candidate_name, candidate_result in results.items():
        if candidate_result.get("ok") and not candidate_result.get("invalid_sql", {}).get("failed"):
            differences.append(
                {
                    "candidate": candidate_name,
                    "field": "invalid_sql.failed",
                    "expected": True,
                    "actual": False,
                }
            )
    return {"ok": not differences, "differences": differences}


def sanitized_connection(connection: dict) -> dict:
    result = dict(connection)
    if result.get("password"):
        result["password"] = "***"
    return result


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    main()
