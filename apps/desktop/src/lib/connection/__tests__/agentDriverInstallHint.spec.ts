import { describe, expect, it } from "vitest";
import { agentDriverInstallKey, driverStoreFocusElementKey, driverStoreFocusForInstallError, driverStoreFocusRowIsRenderable, hasInstalledAgentVersion, shouldApplyDriverStoreFocus, showAgentDriverInstallHint } from "@/lib/connection/agentDriverInstallHint";

describe("DuckDB driver installation", () => {
  it("requires the downloadable DuckDB driver before connecting", () => {
    expect(agentDriverInstallKey("duckdb")).toBe("duckdb");
    expect(showAgentDriverInstallHint("duckdb", [])).toBe(true);
    expect(showAgentDriverInstallHint("duckdb", [{ db_type: "duckdb", installed: true }])).toBe(false);
  });
});

describe("SQLite SSH worker installation", () => {
  it("requires the downloadable worker only for SQLite over SSH", () => {
    expect(agentDriverInstallKey("sqlite")).toBeUndefined();
    expect(showAgentDriverInstallHint("sqlite", [])).toBe(false);
    expect(agentDriverInstallKey("sqlite", undefined, { ssh: true })).toBe("sqlite-worker");
    expect(showAgentDriverInstallHint("sqlite", [], undefined, { ssh: true })).toBe(true);
    expect(showAgentDriverInstallHint("sqlite", [{ db_type: "sqlite-worker", installed: true }], undefined, { ssh: true })).toBe(false);
  });
});

describe("HiveServer2-compatible driver installation", () => {
  it("reuses the downloadable Hive driver", () => {
    expect(agentDriverInstallKey("impala")).toBe("hive");
    expect(showAgentDriverInstallHint("impala", [{ db_type: "hive", installed: true }])).toBe(false);
    expect(agentDriverInstallKey("kyuubi")).toBe("hive");
    expect(showAgentDriverInstallHint("kyuubi", [{ db_type: "hive", installed: true }])).toBe(false);
  });
});

describe("shouldApplyDriverStoreFocus", () => {
  it("applies when the driver first appears after a list load", () => {
    expect(shouldApplyDriverStoreFocus(null, "driver:mysql", false)).toBe(true);
  });

  it("does not re-apply on inventory refresh of the same focus", () => {
    expect(shouldApplyDriverStoreFocus("driver:mysql", "driver:mysql", false)).toBe(false);
  });

  it("re-applies when the parent sends a new focus object for the same driver", () => {
    expect(shouldApplyDriverStoreFocus("driver:mysql", "driver:mysql", true)).toBe(true);
  });

  it("applies when the focused driver changes", () => {
    expect(shouldApplyDriverStoreFocus("driver:mysql", "driver:postgres", true)).toBe(true);
  });
});

describe("driverStoreFocusElementKey", () => {
  it("keys driver and jre focus targets", () => {
    expect(driverStoreFocusElementKey({ target: "driver", driver: "mysql" })).toBe("driver:mysql");
    expect(driverStoreFocusElementKey({ target: "jre" })).toBe("jre");
  });
});

describe("driverStoreFocusRowIsRenderable", () => {
  it("does not treat managed JDBC as renderable while the agent list is still loading", () => {
    expect(driverStoreFocusRowIsRenderable({ target: "driver", driver: "phoenix" }, 0, [{ db_type: "phoenix" }])).toBe(false);
  });

  it("allows focus once the agent list has loaded and the row exists", () => {
    expect(driverStoreFocusRowIsRenderable({ target: "driver", driver: "phoenix" }, 1, [{ db_type: "phoenix" }])).toBe(true);
  });

  it("waits when the focused driver is not in the builtin rows yet", () => {
    expect(driverStoreFocusRowIsRenderable({ target: "driver", driver: "mysql" }, 3, [{ db_type: "phoenix" }])).toBe(false);
  });

  it("treats JRE focus as renderable during agent list loading", () => {
    expect(driverStoreFocusRowIsRenderable({ target: "jre" }, 0, [])).toBe(true);
  });
});

describe("driverStoreFocusForInstallError", () => {
  it("focuses the SQLite SSH worker for remote SQLite driver errors", () => {
    expect(driverStoreFocusForInstallError("sqlite-worker driver is not installed. Please install it from the Driver Manager.", "sqlite", undefined)).toEqual({
      target: "driver",
      driver: "sqlite-worker",
    });
  });

  it("resolves the driver key from the driver profile", () => {
    expect(driverStoreFocusForInstallError("kafka driver is not installed. Please install it from the Driver Manager.", "mq", "kafka")).toEqual({
      target: "driver",
      driver: "kafka",
    });
    expect(driverStoreFocusForInstallError("rocketmq driver is not installed. Please install it from the Driver Manager.", "mq", "rocketmq")).toEqual({
      target: "driver",
      driver: "rocketmq",
    });
  });

  it("focuses the JRE section for missing JRE errors", () => {
    expect(driverStoreFocusForInstallError("JRE 21 runtime is not installed. Please install it from the Driver Manager.", "zookeeper", undefined)).toEqual({
      target: "jre",
    });
  });

  it("focuses the agent driver for corrupt-jar reinstall errors", () => {
    expect(driverStoreFocusForInstallError("zookeeper driver jar is invalid or corrupt. Please reinstall it from the Driver Manager.", "zookeeper", undefined)).toEqual({
      target: "driver",
      driver: "zookeeper",
    });
  });

  it("returns null for unrelated connection errors", () => {
    expect(driverStoreFocusForInstallError("Connection timed out", "zookeeper", undefined)).toBeNull();
    expect(driverStoreFocusForInstallError("No reachable ZooKeeper server within 2000ms: zk:2181", "zookeeper", undefined)).toBeNull();
  });
});

describe("hasInstalledAgentVersion", () => {
  it("requires an installed Agent at or above the requested release", () => {
    expect(hasInstalledAgentVersion([{ db_type: "xugu", installed: true, installed_version: "0.1.23" }], "xugu", "0.1.23")).toBe(true);
    expect(hasInstalledAgentVersion([{ db_type: "xugu", installed: true, installed_version: "0.1.22" }], "xugu", "0.1.23")).toBe(false);
    expect(hasInstalledAgentVersion([{ db_type: "xugu", installed: true, installed_version: null }], "xugu", "0.1.23")).toBe(false);
  });
});
