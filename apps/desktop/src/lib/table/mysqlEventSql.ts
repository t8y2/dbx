export type MysqlEventSchedule = { mode: "at"; executeAt: string } | { mode: "every"; intervalValue: string; intervalUnit: string };

export type MysqlEventDraft = {
  name: string;
  schema?: string;
  schedule: MysqlEventSchedule;
  starts?: string;
  ends?: string;
  preserve?: boolean;
  enabled?: boolean;
  comment?: string;
  body: string;
};

function ident(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Event name is required");
  return `\`${trimmed.replaceAll("`", "``")}\``;
}
function literal(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
const units = new Set(["SECOND", "MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "QUARTER", "YEAR"]);

export function buildMysqlEventSql(draft: MysqlEventDraft, operation: "CREATE" | "ALTER" = "ALTER"): string {
  const name = ident(draft.name);
  if (!draft.body.trim()) throw new Error("Event body is required");
  let schedule: string;
  if (draft.schedule.mode === "at") {
    if (!draft.schedule.executeAt.trim()) throw new Error("AT schedule requires an execution time");
    schedule = `AT ${literal(draft.schedule.executeAt)}`;
  } else {
    const unit = draft.schedule.intervalUnit.trim().toUpperCase();
    const intervalValue = draft.schedule.intervalValue.trim();
    if (!/^\d+$/.test(intervalValue) || /^0+$/.test(intervalValue)) {
      throw new Error("EVERY schedule requires a positive integer interval value");
    }
    if (!units.has(unit)) throw new Error(`Invalid interval unit: ${draft.schedule.intervalUnit}`);
    schedule = `EVERY ${intervalValue} ${unit}`;
  }
  let sql = `${operation} EVENT ${name} ON SCHEDULE ${schedule}`;
  if (draft.starts?.trim()) sql += ` STARTS ${literal(draft.starts)}`;
  if (draft.ends?.trim()) sql += ` ENDS ${literal(draft.ends)}`;
  if (draft.preserve !== undefined) sql += draft.preserve ? " ON COMPLETION PRESERVE" : " ON COMPLETION NOT PRESERVE";
  if (draft.enabled !== undefined) sql += draft.enabled ? " ENABLE" : " DISABLE";
  if (draft.comment !== undefined) sql += ` COMMENT ${literal(draft.comment)}`;
  return `${sql} DO ${draft.body.trim()}`;
}
