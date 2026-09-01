export type XuguSchedulerJobAction = "enable" | "disable" | "run" | "drop";

/**
 * Build the DBMS_SCHEDULER statements supported by the first Xugu job
 * management slice. Scheduler jobs are database-scoped; names are string
 * arguments rather than schema-qualified identifiers.
 */
export function buildXuguSchedulerJobSql(action: XuguSchedulerJobAction, name: string): string | null {
  const jobName = name.trim();
  if (!jobName) return null;
  const literal = quoteXuguString(jobName);
  switch (action) {
    case "enable":
      return `EXEC DBMS_SCHEDULER.ENABLE(${literal});`;
    case "disable":
      return `EXEC DBMS_SCHEDULER.DISABLE(${literal}, FALSE);`;
    case "run":
      return `EXEC DBMS_SCHEDULER.RUN_JOB(${literal}, TRUE);`;
    case "drop":
      return `EXEC DBMS_SCHEDULER.DROP_JOB(${literal}, FALSE);`;
  }
}

function quoteXuguString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
