import { describe, expect, it } from "vitest";
import { DAMENG_CUSTOM_DRIVER_PROFILE, DAMENG_DEFAULT_JDBC_DRIVER_CLASS, damengCustomJdbcUrl, damengDriverModeForConfig, defaultDamengJdbcUrl } from "@/lib/database/damengDriverOptions";

describe("dameng driver options", () => {
  it("keeps existing connections on the built-in driver", () => {
    expect(damengDriverModeForConfig({ driver_profile: "dm", jdbc_driver_paths: [] })).toBe("builtin");
  });

  it("recognizes custom DM6 profiles and legacy configs with an external JAR", () => {
    expect(damengDriverModeForConfig({ driver_profile: DAMENG_CUSTOM_DRIVER_PROFILE })).toBe("custom");
    expect(damengDriverModeForConfig({ driver_profile: "dm", jdbc_driver_paths: [" /drivers/DmJdbcDriver6.jar "] })).toBe("custom");
  });

  it("builds DM6 driver defaults from host, port, and optional database", () => {
    expect(DAMENG_DEFAULT_JDBC_DRIVER_CLASS).toBe("dm6.jdbc.driver.DmDriver");
    expect(defaultDamengJdbcUrl({ host: "dm6.internal", port: 5237, database: "MAIN" })).toBe("jdbc:dm6://dm6.internal:5237/MAIN");
    expect(defaultDamengJdbcUrl({ host: "", port: 0, database: "" })).toBe("jdbc:dm6://127.0.0.1:5236");
  });

  it("preserves a complete custom JDBC URL", () => {
    expect(damengCustomJdbcUrl({ host: "ignored", port: 5236, connection_string: " jdbc:dm6://dm6.internal:5236?foo=bar " })).toBe("jdbc:dm6://dm6.internal:5236?foo=bar");
  });
});
