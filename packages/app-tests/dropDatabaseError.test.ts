import { describe, expect, it } from "vitest";
import { dropDatabaseOtherSessionCount } from "@/lib/database/dropDatabaseError";

describe("dropDatabaseOtherSessionCount", () => {
  it("reads the session count from the openGauss error (#13733)", () => {
    const message = [
      'ERROR: Database "app_db" is being accessed by other users. You can stop all connections by command: "clean connection to all force for database XXXX;" or wait for the sessions to end by querying view: "pg_stat_activity".',
      "DETAIL: There is 1 other session using the database.",
      "SQL text omitted from user-facing error; enable debug SQL diagnostics to inspect the original statement.",
    ].join("\n");
    expect(dropDatabaseOtherSessionCount(message)).toBe(1);
  });

  it("reads the plural PostgreSQL form", () => {
    expect(dropDatabaseOtherSessionCount('ERROR: database "my ""quoted"" db" is being accessed by other users\nDETAIL: There are 3 other sessions using the database.')).toBe(3);
  });

  it("reports an unknown count when another holder is named", () => {
    expect(dropDatabaseOtherSessionCount('ERROR: database "app" is being accessed by other users\nDETAIL: There is 1 prepared transaction using the database.')).toBeNull();
  });

  it("ignores other drop failures", () => {
    expect(dropDatabaseOtherSessionCount("ERROR: must be owner of database app")).toBeUndefined();
    expect(dropDatabaseOtherSessionCount('ERROR: database "app" does not exist')).toBeUndefined();
  });
});
