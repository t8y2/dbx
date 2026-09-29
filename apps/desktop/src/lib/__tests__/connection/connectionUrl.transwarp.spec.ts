import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "@/lib/connection/connectionUrl";

describe("Transwarp JDBC URL parsing", () => {
  it("keeps the selected product when the SDK uses its other compatible URL", () => {
    const inceptor = parseConnectionUrl("jdbc:inceptor2://quark:10000/default;fetchSize=200", "transwarp-inceptor");
    expect(inceptor).toMatchObject({
      dbType: "transwarp",
      driverProfile: "transwarp-inceptor",
      host: "quark",
      port: 10000,
      database: "default",
      urlParams: "fetchSize=200",
    });
    expect(parseConnectionUrl("jdbc:transwarp2://quark:10000/default").driverProfile).toBe("transwarp-inceptor");
  });

  it("detects Inceptor URLs without an existing product selection", () => {
    expect(parseConnectionUrl("jdbc:inceptor2://quark:10000/default")).toMatchObject({
      dbType: "transwarp",
      driverProfile: "transwarp-inceptor",
    });
    expect(parseConnectionUrl("jdbc:hive2://quark:10000/default").dbType).toBe("hive");
  });
});
