import { describe, expect, it } from "vitest";
import { ACCESS_AGENT_MIN_CONNECT_TIMEOUT_SECS, AGENT_DRIVER_MIN_CONNECT_TIMEOUT_SECS, connectionAttemptOriginalErrorMessage, connectionAttemptTimeoutMessage, connectionAttemptTimeoutMs, CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS } from "@/lib/connectionAttemptTimeout";

describe("connectionAttemptTimeout", () => {
  it("uses a 10s default for regular database connections", () => {
    expect(connectionAttemptTimeoutMs({ db_type: "mysql", connect_timeout_secs: undefined, transport_layers: [] })).toBe(12_000);
  });

  it("keeps explicit regular database timeout values", () => {
    expect(connectionAttemptTimeoutMs({ db_type: "mysql", connect_timeout_secs: 5, transport_layers: [] })).toBe(7_000);
  });

  it("uses a 30s agent startup floor", () => {
    expect(connectionAttemptTimeoutMs({ db_type: "oracle", connect_timeout_secs: 5, transport_layers: [] })).toBe(AGENT_DRIVER_MIN_CONNECT_TIMEOUT_SECS * 1000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS);
  });

  it("uses the startup floor for PrestoSQL JDBC plugin connections", () => {
    expect(connectionAttemptTimeoutMs({ db_type: "prestosql", connect_timeout_secs: 5, transport_layers: [] })).toBe(AGENT_DRIVER_MIN_CONNECT_TIMEOUT_SECS * 1000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS);
  });

  it("uses the startup floor for ZooKeeper agent connections", () => {
    expect(connectionAttemptTimeoutMs({ db_type: "zookeeper", connect_timeout_secs: 5, transport_layers: [] })).toBe(AGENT_DRIVER_MIN_CONNECT_TIMEOUT_SECS * 1000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS);
  });

  it("uses a 30s Access agent startup floor", () => {
    expect(connectionAttemptTimeoutMs({ db_type: "access", connect_timeout_secs: 5, transport_layers: [] })).toBe(ACCESS_AGENT_MIN_CONNECT_TIMEOUT_SECS * 1000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS);
  });

  it("respects a user configured Access timeout above the default floor", () => {
    expect(connectionAttemptTimeoutMs({ db_type: "access", connect_timeout_secs: 45, transport_layers: [] })).toBe(47_000);
  });

  it("adds late original database errors to timeout messages", () => {
    const timeoutMessage = connectionAttemptTimeoutMessage(7_000);

    expect(connectionAttemptOriginalErrorMessage(timeoutMessage, "MySQL connection failed: os error 10060")).toContain("MySQL connection failed: os error 10060");
  });
});
