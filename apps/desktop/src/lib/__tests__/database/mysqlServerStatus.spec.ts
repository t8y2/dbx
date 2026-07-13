import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import { computeQps, computeRate, connectionSupportsServerDashboard, formatBytes, formatBytesPerSec, formatUptime, innodbBufferHitRatio, parseStatusResult, statusNumber, supportsServerDashboard, type StatusSample } from "@/lib/database/mysqlServerStatus";

function statusResult(rows: [string, string][]): QueryResult {
  return { columns: ["Variable_name", "Value"], rows, affected_rows: 0, execution_time_ms: 0 };
}

function sample(at: number, status: Record<string, string>): StatusSample {
  return { at, status };
}

describe("parseStatusResult", () => {
  it("parses two-column status into a map", () => {
    const map = parseStatusResult(
      statusResult([
        ["Threads_connected", "12"],
        ["Uptime", "3600"],
      ]),
    );
    expect(map).toEqual({ Threads_connected: "12", Uptime: "3600" });
  });

  it("returns empty map for malformed input", () => {
    expect(parseStatusResult(null)).toEqual({});
    expect(parseStatusResult({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 })).toEqual({});
  });
});

describe("statusNumber", () => {
  it("reads numeric values and defaults to 0", () => {
    expect(statusNumber({ Questions: "500" }, "Questions")).toBe(500);
    expect(statusNumber({}, "Missing")).toBe(0);
    expect(statusNumber({ X: "abc" }, "X")).toBe(0);
  });
});

describe("computeRate", () => {
  it("computes per-second delta", () => {
    const prev = sample(1000, { Bytes_sent: "1000" });
    const curr = sample(3000, { Bytes_sent: "5000" });
    expect(computeRate(prev, curr, "Bytes_sent")).toBe(2000); // 4000 bytes / 2s
  });

  it("returns 0 on counter reset (decrease)", () => {
    const prev = sample(1000, { Queries: "9000" });
    const curr = sample(2000, { Queries: "10" });
    expect(computeRate(prev, curr, "Queries")).toBe(0);
  });

  it("returns 0 for non-positive time delta", () => {
    const prev = sample(2000, { Queries: "10" });
    const curr = sample(2000, { Queries: "20" });
    expect(computeRate(prev, curr, "Queries")).toBe(0);
  });
});

describe("computeQps", () => {
  it("prefers Queries and falls back to Questions", () => {
    const withQueries = computeQps(sample(0, { Queries: "0", Questions: "0" }), sample(1000, { Queries: "100", Questions: "40" }));
    expect(withQueries).toBe(100);
    const withoutQueries = computeQps(sample(0, { Questions: "0" }), sample(1000, { Questions: "40" }));
    expect(withoutQueries).toBe(40);
  });
});

describe("innodbBufferHitRatio", () => {
  it("computes hit ratio as a percentage", () => {
    expect(innodbBufferHitRatio({ Innodb_buffer_pool_read_requests: "1000", Innodb_buffer_pool_reads: "3" })).toBeCloseTo(99.7, 1);
  });

  it("returns null when counters are absent", () => {
    expect(innodbBufferHitRatio({})).toBeNull();
  });
});

describe("formatters", () => {
  it("formats bytes and bytes/sec", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 2)).toBe("2.0 MB");
    expect(formatBytesPerSec(1024)).toBe("1.0 KB/s");
  });

  it("formats uptime compactly", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(3661)).toBe("1h 1m");
    expect(formatUptime(90061)).toBe("1d 1h 1m");
  });
});

describe("supportsServerDashboard", () => {
  it("is true for MySQL (incl. MariaDB/TiDB via mysql dbType) only", () => {
    expect(supportsServerDashboard("mysql")).toBe(true);
    // OLAP forks lack MySQL status counters — dashboard would be empty.
    expect(supportsServerDashboard("doris")).toBe(false);
    expect(supportsServerDashboard("starrocks")).toBe(false);
    expect(supportsServerDashboard("goldendb")).toBe(false);
    expect(supportsServerDashboard("postgres")).toBe(false);
    expect(supportsServerDashboard(undefined)).toBe(false);
  });

  it("rejects JDBC profiles that only use the MySQL-compatible dialect", () => {
    expect(connectionSupportsServerDashboard({ id: "mysql", name: "MySQL", db_type: "mysql" } as any)).toBe(true);
    expect(connectionSupportsServerDashboard({ id: "jdbc-mysql", name: "JDBC MySQL", db_type: "jdbc", connection_string: "jdbc:mysql://localhost/db" } as any)).toBe(true);
    expect(connectionSupportsServerDashboard({ id: "kyuubi", name: "Kyuubi", db_type: "jdbc", driver_profile: "kyuubi", connection_string: "jdbc:hive2://localhost/default" } as any)).toBe(false);
    expect(connectionSupportsServerDashboard({ id: "hive", name: "Hive", db_type: "jdbc", jdbc_driver_class: "org.apache.hive.jdbc.HiveDriver" } as any)).toBe(false);
  });
});
