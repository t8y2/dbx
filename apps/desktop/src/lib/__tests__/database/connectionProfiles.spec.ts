import { describe, expect, it } from "vitest";
import { CONNECTION_PICKER_OPTIONS, CONNECTION_PROFILES, CONNECTION_PROFILE_ICONS } from "@/types/generated/connectionProfiles";

describe("generated connection profiles", () => {
  it("keeps picker options unique and backed by profiles", () => {
    const optionIds = CONNECTION_PICKER_OPTIONS.map((option) => option.value);
    expect(new Set(optionIds).size).toBe(optionIds.length);
    expect(optionIds.every((id) => id in CONNECTION_PROFILES)).toBe(true);
  });

  it("preserves compatible products and specialized protocol defaults", () => {
    expect(CONNECTION_PROFILES.mariadb).toMatchObject({ type: "mysql", port: 3306, user: "root" });
    expect(CONNECTION_PROFILES.rabbitmq).toMatchObject({ type: "mq", port: 5672, host: "127.0.0.1" });
    expect(CONNECTION_PROFILES.nacos).toMatchObject({ type: "nacos", port: 8848, user: "nacos" });
  });

  it("keeps internal variants out of the main picker", () => {
    const optionIds = new Set(CONNECTION_PICKER_OPTIONS.map((option) => option.value));
    expect(optionIds.has("mongodb-legacy")).toBe(false);
    expect(optionIds.has("oceanbase-oracle")).toBe(false);
    expect(optionIds.has("h2-legacy")).toBe(false);
  });

  it("preserves picker-specific icon overrides", () => {
    expect(CONNECTION_PROFILE_ICONS.mq).toBe("mq");
    expect(CONNECTION_PROFILE_ICONS.prestosql).toBe("prestosql");
    expect(CONNECTION_PROFILE_ICONS.influxdb).toBe("influxdb");
  });
});
