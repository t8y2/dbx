import type { QueryResult } from "@/types/database";

export interface DamengJob {
  id: string;
  name: string;
  enabled: boolean;
  running: boolean;
  runningSid?: string;
  valid?: string;
  owner?: string;
  createdAt?: string;
  modifiedAt?: string;
  description?: string;
  raw: Record<string, unknown>;
}

export interface DamengJobCreateInput {
  name: string;
  enabled: boolean;
  description?: string;
  stepName: string;
  command: string;
  scheduleName: string;
  scheduleMode: "once" | "daily";
  startDate: string;
  startTime: string;
  endTime?: string;
  minuteInterval?: number;
}

export function damengJobListSql(useSystemTables = false): string {
  if (!useSystemTables) {
    return `SELECT J.ID, J.NAME, J.ENABLE, J.USERNAME, J.CREATETIME, J.MODIFYTIME, J.VALID, J.DESCRIBE,
       0 AS RUNNING,
       NULL AS RUNNING_SID
FROM SYSJOB.USER_JOBS_VIEW J
ORDER BY J.NAME`;
  }

  return `SELECT J.ID, J.NAME, J.ENABLE, J.USERNAME, J.CREATETIME, J.MODIFYTIME, J.VALID, J.DESCRIBE,
       CASE WHEN R.JOB IS NULL THEN 0 ELSE 1 END AS RUNNING,
       R.SID AS RUNNING_SID
FROM SYSJOB.SYSJOBS J
LEFT JOIN SYSJOB.DBA_JOBS_RUNNING R ON R.JOB = J.ID
ORDER BY J.NAME`;
}

export const DAMENG_JOB_ENVIRONMENT_SQL = `SELECT COUNT(*) AS CNT
FROM ALL_OBJECTS
WHERE OWNER = 'SYSJOB'
  AND OBJECT_NAME = 'USER_JOBS_VIEW'`;

export function damengJobStepsSql(jobId: string | number, useSystemTables = false): string {
  return `SELECT * FROM ${useSystemTables ? "SYSJOB.SYSJOBSTEPS" : "SYSJOB.USER_JOBSTEPS_VIEW"} WHERE JOBID = ${quoteDamengNumber(jobId)}`;
}

export function damengJobSchedulesSql(jobId: string | number, useSystemTables = false): string {
  return `SELECT * FROM ${useSystemTables ? "SYSJOB.SYSJOBSCHEDULES" : "SYSJOB.USER_JOBSCHEDULES_VIEW"} WHERE JOBID = ${quoteDamengNumber(jobId)}`;
}

export function damengJobHistoriesSql(job: { id: string | number; name: string }, useSystemTables = false): string {
  if (useSystemTables) {
    return `SELECT * FROM SYSJOB.SYSJOBHISTORIES2 WHERE JOBID = ${quoteDamengNumber(job.id)}`;
  }
  return `SELECT * FROM SYSJOB.USER_JOBHISTORIES_VIEW WHERE JOBID = ${quoteDamengNumber(job.id)}`;
}

export function damengInitJobSystemSql(): string {
  return "SP_INIT_JOB_SYS(1);";
}

export function damengEnableJobSql(jobName: string, enabled: boolean): string {
  return `SP_ENABLE_JOB(${quoteDamengString(jobName)}, ${enabled ? 1 : 0});`;
}

export function damengDropJobSql(jobName: string): string {
  return `SP_DROP_JOB(${quoteDamengString(jobName)});`;
}

export function damengRunJobSql(jobId: string | number): string {
  const id = Number(jobId);
  if (!Number.isFinite(id)) return "";
  return `SP_DBMS_JOB_RUN_ASYNC(${Math.trunc(id)});`;
}

export function damengStopJobSql(jobId: string | number): string {
  const id = Number(jobId);
  if (!Number.isFinite(id)) return "";
  return `SP_STOP_RUNNING_JOB(${Math.trunc(id)});`;
}

export function damengClearJobHistoriesSql(jobName: string): string {
  return `SP_JOB_CLEAR_HISTORIES(${quoteDamengString(jobName)});`;
}

export function damengCreateJobSql(input: DamengJobCreateInput): string {
  const name = input.name.trim();
  const stepName = input.stepName.trim() || "STEP1";
  const scheduleName = input.scheduleName.trim() || "SCHEDULE1";
  const startDate = input.startDate.trim() || "CURDATE";
  const startTime = input.startTime.trim() || "CURTIME";
  const endTime = input.endTime?.trim();
  const interval = Math.max(0, Math.min(1439, Math.trunc(input.minuteInterval ?? 0)));
  const scheduleType = input.scheduleMode === "once" ? 0 : 1;
  const freqInterval = input.scheduleMode === "once" ? 0 : 1;
  const freqMinuteInterval = input.scheduleMode === "once" ? 0 : interval;
  const startTimeSql = input.scheduleMode === "once" ? "NULL" : quoteDamengString(startTime);
  const endTimeSql = endTime ? quoteDamengString(endTime) : "NULL";
  const startDateSql = startDate.toUpperCase() === "CURDATE" ? "CURDATE" : quoteDamengString(startDate);

  return [
    `SP_CREATE_JOB(${quoteDamengString(name)}, ${input.enabled ? 1 : 0}, 0, '', 0, 0, '', 0, ${quoteDamengString(input.description ?? "")});`,
    `SP_JOB_CONFIG_START(${quoteDamengString(name)});`,
    `SP_ADD_JOB_STEP(${quoteDamengString(name)}, ${quoteDamengString(stepName)}, 0, ${quoteDamengString(input.command)}, 1, 1, 0, 0, NULL, 0);`,
    `SP_ADD_JOB_SCHEDULE(${quoteDamengString(name)}, ${quoteDamengString(scheduleName)}, 1, ${scheduleType}, ${freqInterval}, 0, ${freqMinuteInterval}, ${startTimeSql}, ${endTimeSql}, ${startDateSql}, NULL, '');`,
    `SP_JOB_CONFIG_COMMIT(${quoteDamengString(name)});`,
  ].join("\n");
}

export function parseDamengJobs(result: QueryResult): DamengJob[] {
  return result.rows.map((row) => {
    const raw = rowToObject(result.columns, row);
    const name = valueAt(raw, "NAME");
    const id = valueAt(raw, "ID");
    return {
      id: id || name,
      name,
      enabled: valueAt(raw, "ENABLE") === "1",
      running: valueAt(raw, "RUNNING") === "1",
      runningSid: valueAt(raw, "RUNNING_SID"),
      valid: valueAt(raw, "VALID"),
      owner: valueAt(raw, "USERNAME"),
      createdAt: valueAt(raw, "CREATETIME"),
      modifiedAt: valueAt(raw, "MODIFYTIME"),
      description: valueAt(raw, "DESCRIBE"),
      raw,
    };
  });
}

export function parseDamengJobEnvironmentReady(result: QueryResult): boolean {
  const value = result.rows[0]?.[0];
  return Number(value) > 0;
}

export function isDamengJobEnvironmentMissingError(message: string): boolean {
  return /SYSJOB/i.test(message) && (/无效的模式名/.test(message) || /invalid schema/i.test(message));
}

export function queryResultToObjects(result: QueryResult): Record<string, unknown>[] {
  return result.rows.map((row) => rowToObject(result.columns, row));
}

export function quoteDamengString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteDamengNumber(value: string | number): string {
  const id = Number(value);
  if (!Number.isFinite(id)) return "NULL";
  return String(Math.trunc(id));
}

function rowToObject(columns: string[], row: QueryResult["rows"][number]): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    object[column] = row[index] ?? null;
  });
  return object;
}

function valueAt(row: Record<string, unknown>, column: string): string {
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === column.toLowerCase());
  const value = key ? row[key] : undefined;
  return value == null ? "" : String(value);
}
