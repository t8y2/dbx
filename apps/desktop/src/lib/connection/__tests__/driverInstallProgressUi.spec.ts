import { describe, expect, it } from "vitest";
import { driverInstallProgressChannel, updateDriverInstallProgress, type DriverInstallProgress } from "@/lib/connection/driverInstallProgressUi";

describe("driver install progress channels", () => {
  it("classifies agent and JDBC plugin progress independently", () => {
    expect(driverInstallProgressChannel({ step: "driver", db_type: "mysql" })).toBe("agent");
    expect(driverInstallProgressChannel({ step: "jre-extract", db_type: "oracle" })).toBe("agent");
    expect(driverInstallProgressChannel({ step: "jdbc-plugin" })).toBe("jdbc-plugin");
    expect(driverInstallProgressChannel({ step: "jdbc-plugin-extract" })).toBe("jdbc-plugin");
  });

  it("does not let concurrent progress overwrite the other channel", () => {
    const agentProgress: DriverInstallProgress = { step: "driver", db_type: "mysql", downloaded: 20, total: 100 };
    const jdbcProgress: DriverInstallProgress = { step: "jdbc-plugin", downloaded: 70, total: 100 };

    expect(updateDriverInstallProgress(agentProgress, jdbcProgress, "agent")).toBe(agentProgress);
    expect(updateDriverInstallProgress(jdbcProgress, agentProgress, "jdbc-plugin")).toBe(jdbcProgress);
  });

  it("allows a built-in driver backed by JDBC to consume JDBC progress explicitly", () => {
    const jdbcProgress: DriverInstallProgress = { step: "jdbc-plugin", downloaded: 40, total: 100 };

    expect(updateDriverInstallProgress(null, jdbcProgress, "jdbc-plugin")).toBe(jdbcProgress);
    expect(updateDriverInstallProgress(null, jdbcProgress, "agent")).toBeNull();
  });

  it("clears only the channel identified by a terminal event", () => {
    const agentProgress: DriverInstallProgress = { step: "driver", db_type: "mysql", downloaded: 100, total: 100 };
    const jdbcProgress: DriverInstallProgress = { step: "jdbc-plugin", downloaded: 50, total: 100 };
    const agentDone: DriverInstallProgress = { step: "done", db_type: "mysql" };

    expect(updateDriverInstallProgress(agentProgress, agentDone, "agent")).toBeNull();
    expect(updateDriverInstallProgress(jdbcProgress, agentDone, "jdbc-plugin")).toBe(jdbcProgress);
  });

  it("ignores legacy ambiguous done events so operation cleanup owns reset", () => {
    const agentProgress: DriverInstallProgress = { step: "driver", db_type: "mysql", downloaded: 80, total: 100 };
    const jdbcProgress: DriverInstallProgress = { step: "jdbc-plugin", downloaded: 80, total: 100 };
    const ambiguousDone: DriverInstallProgress = { step: "done" };

    expect(updateDriverInstallProgress(agentProgress, ambiguousDone, "agent")).toBe(agentProgress);
    expect(updateDriverInstallProgress(jdbcProgress, ambiguousDone, "jdbc-plugin")).toBe(jdbcProgress);
  });
});
