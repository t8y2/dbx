import { describe, it, expect, vi } from "vitest";
import { mqttSaveTopicConfig } from "../mqtt-tauri";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
describe("MQTT topic alias transport #13720", () => {
  it("sends a display-only alias separately from the literal topic", async () => {
    await mqttSaveTopicConfig("conn", "factory/+/status", "atmostonce", false, true, "  设备状态  ");
    expect(invoke).toHaveBeenLastCalledWith("mqtt_save_topic_config", { connectionId: "conn", config: { topic: "factory/+/status", qos: "atmostonce", noLocal: false, enabled: true, alias: "设备状态" } });
  });
  it("keeps older callers compatible and permits clearing aliases", async () => {
    await mqttSaveTopicConfig("conn", "factory/#", "atmostonce", false);
    expect(invoke).toHaveBeenLastCalledWith("mqtt_save_topic_config", { connectionId: "conn", config: { topic: "factory/#", qos: "atmostonce", noLocal: false, enabled: false, alias: "" } });
  });
});
