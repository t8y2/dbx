import * as api from "@/lib/backend/api";
import { parseMongoJson } from "@/lib/mongo/mongoJson";

export interface MongoTaskStep {
  name: string;
  connectionId: string;
  database: string;
  collection: string;
  kind: "find" | "aggregate";
  query: Record<string, unknown> | unknown[];
  maxRows: number;
  timeoutSeconds: number;
}
export interface MongoTask {
  id: string;
  name: string;
  enabled: boolean;
  intervalMinutes: number;
  steps: MongoTaskStep[];
  revision: string;
  nextRunAt: string | null;
}
export interface MongoTaskRun {
  id: string;
  taskId: string;
  taskName: string;
  trigger: "manual" | "schedule";
  status: "queued" | "running" | "success" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  results: { name: string; returnedRows: number; sample: unknown[]; sampleTruncated: boolean; rowLimitReached: boolean }[];
}
export interface MongoTaskSnapshot {
  tasks: MongoTask[];
  runs: MongoTaskRun[];
  heartbeat: string | null;
}
export type MongoTaskCommand = { action: "snapshot" } | { action: "save"; task: MongoTask } | { action: "delete" | "run"; id: string; revision: string } | { action: "cancel"; id: string };

/** Uses the shared transport, update-preparation guard and diagnostics. */
export function mongoTaskCommand<T>(command: MongoTaskCommand): Promise<T> {
  return api.mongoTaskCommand<T>(command);
}

export function isActiveMongoTaskRun(run: Pick<MongoTaskRun, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

export function parseMongoTaskSteps(text: string): MongoTaskStep[] {
  const steps = parseMongoJson(text);
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error("A task requires 1–20 steps / 任务需要 1–20 个步骤");
  for (const step of steps) {
    if (!step || typeof step !== "object") throw new Error("Invalid step / 步骤格式错误");
    for (const field of ["name", "connectionId", "database", "collection"] as const) {
      if (typeof step[field] !== "string" || !step[field].trim()) throw new Error(`Missing ${field} / 缺少字段`);
    }
    if (step.kind !== "find" && step.kind !== "aggregate") throw new Error("Only read-only find/aggregate steps are supported / 仅支持只读 find/aggregate");
    if ((step.kind === "aggregate" && !Array.isArray(step.query)) || (step.kind === "find" && (!step.query || typeof step.query !== "object" || Array.isArray(step.query)))) throw new Error("find requires a filter object; aggregate requires a pipeline array / 查询结构错误");
    if (!Number.isInteger(step.maxRows) || step.maxRows < 1 || step.maxRows > 1000) throw new Error("maxRows must be 1–1000 / 行数限制必须为 1–1000");
    if (!Number.isInteger(step.timeoutSeconds) || step.timeoutSeconds < 1 || step.timeoutSeconds > 300) throw new Error("timeoutSeconds must be 1–300 / 超时必须为 1–300 秒");
  }
  // Backend revalidates all JSON operators, nesting, byte bounds and connections.
  return steps as MongoTaskStep[];
}
