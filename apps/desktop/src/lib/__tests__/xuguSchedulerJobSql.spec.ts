import { describe, expect, it } from "vitest";
import { buildXuguSchedulerJobSql } from "@/lib/database/xuguSchedulerJobSql";

describe("buildXuguSchedulerJobSql", () => {
  it("uses DBMS_SCHEDULER actions and safely quotes the job name", () => {
    expect(buildXuguSchedulerJobSql("enable", "nightly'load")).toBe("EXEC DBMS_SCHEDULER.ENABLE('nightly''load');");
    expect(buildXuguSchedulerJobSql("disable", "nightly")).toBe("EXEC DBMS_SCHEDULER.DISABLE('nightly', FALSE);");
    expect(buildXuguSchedulerJobSql("run", "nightly")).toBe("EXEC DBMS_SCHEDULER.RUN_JOB('nightly', TRUE);");
    expect(buildXuguSchedulerJobSql("drop", "nightly")).toBe("EXEC DBMS_SCHEDULER.DROP_JOB('nightly', FALSE);");
  });

  it("refuses an empty scheduler job name", () => {
    expect(buildXuguSchedulerJobSql("enable", "  ")).toBeNull();
  });
});
