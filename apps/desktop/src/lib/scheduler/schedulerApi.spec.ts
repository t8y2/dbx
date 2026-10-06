import { describe, expect, it } from "vitest";
import { schedulerErrorCode } from "./schedulerApi";

describe("schedulerErrorCode", () => {
  it("reads the desktop machine-code prefix", () => {
    expect(schedulerErrorCode(new Error("version_conflict: stored version 3, got 2"))).toBe("version_conflict");
    expect(schedulerErrorCode(new Error("task_not_found: no row"))).toBe("task_not_found");
  });

  it("reads codes from structured backend errors", () => {
    const error = new Error("save failed");
    error.name = "BackendErrorException";
    (error as unknown as { backendError: { code: string } }).backendError = { code: "run_already_active" };
    expect(schedulerErrorCode(error)).toBe("run_already_active");
  });

  it("recognizes JSON bodies from the web transport", () => {
    expect(schedulerErrorCode(new Error(`500: {"code":"provider_unavailable","message":"sidecar down"}`))).toBe("provider_unavailable");
  });

  it("returns undefined for unrelated errors", () => {
    expect(schedulerErrorCode(new Error("boom"))).toBeUndefined();
    expect(schedulerErrorCode("plain string")).toBeUndefined();
  });
});

// The desktop transport invokes Tauri commands by exact name, and the backend
// registers snake_case handlers. A camelCase name regresses into
// "Command schedulerListTasks not found" at runtime (the exact bug this spec
// pins), so every task-center call must use the frozen snake_case commands.
import { vi, afterEach } from "vitest";

const invoked: Array<{ command: string; args?: Record<string, unknown> }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    invoked.push({ command, args });
    if (command === "scheduler_list_tasks") return [];
    if (command === "scheduler_list_runs") return [];
    if (command === "scheduler_list_resident_sessions") return [];
    if (command === "scheduler_get_run_logs") return { entries: [], nextSeq: 0, eof: true };
    if (command === "scheduler_get_run") return { id: "run-1", taskId: "task-1", trigger: "manual", status: "queued", attempt: 1, createdAt: "2026-10-06T00:00:00Z" };
    if (command === "scheduler_list_artifacts") return [];
    return undefined;
  }),
}));

vi.mock("@/lib/backend/tauriRuntime", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/backend/tauriRuntime")>()), isTauriRuntime: () => true }));

describe("schedulerApi desktop transport", () => {
  afterEach(() => {
    invoked.length = 0;
    vi.restoreAllMocks();
  });

  it("invokes the snake_case Tauri commands for every task-center call", async () => {
    const api = await import("./schedulerApi");
    await api.listTasks();
    await api.listRuns();
    await api.getRun("run-1");
    await api.getRunLogs("run-1", {});
    await api.listArtifacts("run-1");
    await api.listResidentSessions();
    await api.residentAction("session-1", "stop");

    expect(invoked.map((entry) => entry.command)).toEqual(["scheduler_list_tasks", "scheduler_list_runs", "scheduler_get_run", "scheduler_get_run_logs", "scheduler_list_artifacts", "scheduler_list_resident_sessions", "scheduler_resident_action"]);
  });

  it("maps the mutating calls to their snake_case commands", async () => {
    const api = await import("./schedulerApi");
    const task = { id: "task-1", version: 1 } as unknown as Parameters<typeof api.saveTask>[0];
    await api.saveTask(task);
    await api.deleteTask("task-1");
    await api.runTask("task-1");
    await api.cancelRun("task-1", "run-1");
    await api.enableTask("task-1");
    await api.disableTask("task-1");

    expect(invoked.map((entry) => entry.command)).toEqual(["scheduler_save_task", "scheduler_delete_task", "scheduler_run_task", "scheduler_cancel_run", "scheduler_enable_task", "scheduler_disable_task"]);
  });
});
