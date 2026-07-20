import { describe, expect, it } from "vitest";
import { driverStoreFocusForInstallError } from "@/lib/connection/agentDriverInstallHint";

describe("driverStoreFocusForInstallError", () => {
  it("focuses the missing agent driver for driver-not-installed errors", () => {
    expect(driverStoreFocusForInstallError("zookeeper driver is not installed. Please install it from the Driver Manager.", "zookeeper", undefined)).toEqual({
      target: "driver",
      driver: "zookeeper",
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
