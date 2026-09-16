import { describe, expect, it } from "vitest";
import { buildMysqlEventSql } from "./mysqlEventSql";

describe("buildMysqlEventSql", () => {
  it("builds an escaped EVERY event", () => {
    expect(buildMysqlEventSql({ name: "daily`sync", schedule: { mode: "every", intervalValue: "1", intervalUnit: "day" }, preserve: true, enabled: false, comment: "owner's job", body: "CALL refresh();" }, "CREATE")).toBe(
      "CREATE EVENT `daily``sync` ON SCHEDULE EVERY 1 DAY ON COMPLETION PRESERVE DISABLE COMMENT 'owner\\'s job' DO CALL refresh();",
    );
  });
  it("rejects empty body and invalid units", () => {
    expect(() => buildMysqlEventSql({ name: "e", schedule: { mode: "every", intervalValue: "1", intervalUnit: "FORTNIGHT" }, body: "SELECT 1" })).toThrow("Invalid interval unit");
    expect(() => buildMysqlEventSql({ name: "e", schedule: { mode: "at", executeAt: "" }, body: " " })).toThrow("Event body");
  });
  it("rejects non-positive or non-numeric interval values", () => {
    for (const intervalValue of ["", "0", " 000 ", "1 DAY", "1; DROP EVENT other"]) {
      expect(() => buildMysqlEventSql({ name: "e", schedule: { mode: "every", intervalValue, intervalUnit: "DAY" }, body: "SELECT 1" })).toThrow("positive integer interval value");
    }
  });
});
