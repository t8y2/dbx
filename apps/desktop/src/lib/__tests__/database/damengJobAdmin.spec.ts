import { describe, expect, it } from "vitest";
import {
  DAMENG_JOB_ENVIRONMENT_SQL,
  damengCreateJobSql,
  damengEnableJobSql,
  damengJobHistoriesSql,
  damengJobListSql,
  damengJobStepsSql,
  damengRunJobSql,
  isDamengJobAlreadyInitializedError,
  isDamengJobEnvironmentMissingError,
  parseDamengJobEnvironmentReady,
  parseDamengJobs,
  quoteDamengString,
} from "@/lib/database/damengJobAdmin";
import type { QueryResult } from "@/types/database";

describe("damengJobAdmin", () => {
  it("quotes Dameng string literals", () => {
    expect(quoteDamengString("job's test")).toBe("'job''s test'");
  });

  it("builds job action sql with quoted names", () => {
    expect(damengEnableJobSql("JOB_A", false)).toBe("SP_ENABLE_JOB('JOB_A', 0);");
    expect(damengJobStepsSql("12")).toBe("SELECT * FROM SYSJOB.USER_JOBSTEPS_VIEW WHERE JOBID = 12");
    expect(damengJobStepsSql("12", true)).toBe("SELECT * FROM SYSJOB.SYSJOBSTEPS WHERE JOBID = 12");
    expect(damengJobHistoriesSql({ id: "12", name: "JOB'A" }, true)).toBe("SELECT * FROM SYSJOB.SYSJOBHISTORIES2 WHERE JOBID = 12");
    expect(damengRunJobSql("12")).toBe("SP_DBMS_JOB_RUN_ASYNC(12);");
  });

  it("avoids DBA running view for normal user job list", () => {
    expect(damengJobListSql()).toContain("FROM SYSJOB.USER_JOBS_VIEW J");
    expect(damengJobListSql()).toContain("0 AS RUNNING");
    expect(damengJobListSql()).not.toContain("DBA_JOBS_RUNNING");
  });

  it("uses system job tables with running state for SYSDBA job list", () => {
    expect(damengJobListSql(true)).toContain("FROM SYSJOB.SYSJOBS J");
    expect(damengJobListSql(true)).toContain("SYSJOB.DBA_JOBS_RUNNING");
  });

  it("builds simple sql job creation script", () => {
    const sql = damengCreateJobSql({
      name: "JOB_TEST",
      enabled: true,
      description: "demo",
      stepName: "STEP1",
      command: "SELECT 1;",
      scheduleName: "SCHEDULE1",
      scheduleMode: "daily",
      startDate: "CURDATE",
      startTime: "00:00:00",
      minuteInterval: 5,
    });

    expect(sql).toContain("SP_CREATE_JOB('JOB_TEST', 1");
    expect(sql).toContain("SP_ADD_JOB_STEP('JOB_TEST', 'STEP1', 0, 'SELECT 1;', 1, 1, 0, 0, NULL, 0);");
    expect(sql).toContain("SP_ADD_JOB_SCHEDULE('JOB_TEST', 'SCHEDULE1', 1, 1, 1, 0, 5, '00:00:00', NULL, CURDATE, NULL, '');");
    expect(sql).toContain("SP_JOB_CONFIG_COMMIT('JOB_TEST');");
  });

  it("parses job rows case-insensitively", () => {
    const result: QueryResult = {
      columns: ["id", "name", "enable", "username", "valid", "describe", "running", "running_sid"],
      rows: [[12, "JOB_TEST", 1, "SYSDBA", "Y", "demo", 1, 1234]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    expect(parseDamengJobs(result)).toEqual([
      {
        id: "12",
        name: "JOB_TEST",
        enabled: true,
        running: true,
        runningSid: "1234",
        owner: "SYSDBA",
        valid: "Y",
        createdAt: "",
        modifiedAt: "",
        description: "demo",
        raw: {
          id: 12,
          name: "JOB_TEST",
          enable: 1,
          username: "SYSDBA",
          valid: "Y",
          describe: "demo",
          running: 1,
          running_sid: 1234,
        },
      },
    ]);
  });

  it("parses job environment availability", () => {
    expect(parseDamengJobEnvironmentReady({ columns: ["CNT"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 })).toBe(true);
    expect(parseDamengJobEnvironmentReady({ columns: ["CNT"], rows: [[0]], affected_rows: 0, execution_time_ms: 1 })).toBe(false);
  });

  it("detects missing SYSJOB schema errors", () => {
    expect(isDamengJobEnvironmentMissingError("无效的模式名[SYSJOB]")).toBe(true);
    expect(isDamengJobEnvironmentMissingError("invalid schema name SYSJOB")).toBe(true);
  });

  it("probes the job environment through SYSJOBS instead of a build-dependent view", () => {
    // DM8 8.1.3.12 初始化后只有 DBA_JOBS / DBA_JOBS_RUNNING / USER_JOBS 三个视图；
    // USER_JOBS_VIEW 到 8.1.3.62 才出现，用它判定会让旧构建永远显示“未初始化”。
    expect(DAMENG_JOB_ENVIRONMENT_SQL).toContain("OWNER = 'SYSJOB'");
    expect(DAMENG_JOB_ENVIRONMENT_SQL).toContain("OBJECT_NAME = 'SYSJOBS'");
    expect(DAMENG_JOB_ENVIRONMENT_SQL).not.toContain("USER_JOBS_VIEW");
  });

  it("reads SP_INIT_JOB_SYS object-exists failure as an already initialized environment", () => {
    expect(isDamengJobAlreadyInitializedError("-2124 对象[SYSMAILINFO]已存在\n-2124: anonymous block line 826")).toBe(true);
    expect(isDamengJobAlreadyInitializedError("-2124 对象[SYSMAILINFO]已存在\n-2124: anonymous block line 969")).toBe(true);
    expect(isDamengJobAlreadyInitializedError("object [SYSMAILINFO] already exists")).toBe(true);
    expect(isDamengJobAlreadyInitializedError("-5598 没有执行权限")).toBe(false);
    expect(isDamengJobAlreadyInitializedError("-2501 用户名或密码错误")).toBe(false);
  });
});
