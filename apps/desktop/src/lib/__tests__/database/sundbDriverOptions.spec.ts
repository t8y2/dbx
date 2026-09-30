import { describe, expect, it } from "vitest";
import { SUNDB_DEFAULT_JDBC_DRIVER_CLASS, sundbJdbcDriverClass } from "@/lib/database/sundbDriverOptions";

describe("sundb driver options", () => {
  it("defaults the driver class to the vendor class bundled inside the Agent", () => {
    expect(SUNDB_DEFAULT_JDBC_DRIVER_CLASS).toBe("csii.sundb.jdbc.SundbDriver");
    expect(sundbJdbcDriverClass({})).toBe("csii.sundb.jdbc.SundbDriver");
    expect(sundbJdbcDriverClass({ jdbc_driver_class: "   " })).toBe("csii.sundb.jdbc.SundbDriver");
  });

  it("keeps an explicit driver class", () => {
    expect(sundbJdbcDriverClass({ jdbc_driver_class: " com.example.SundbDriver " })).toBe("com.example.SundbDriver");
  });
});
