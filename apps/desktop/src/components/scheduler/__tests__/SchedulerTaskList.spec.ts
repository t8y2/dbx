// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import SchedulerTaskList from "../SchedulerTaskList.vue";
import type { SchedulerTaskProviderDescriptor, TaskDefinition } from "@/lib/scheduler/schedulerTypes";

const mountedApps: App[] = [];

const providers: SchedulerTaskProviderDescriptor[] = [
  {
    providerId: "io.dbx.files.tasks",
    label: "Files Tasks",
    pluginId: "io.dbx.files",
    connectionProviders: [],
    capabilities: ["run"],
    triggers: [{ id: "sync", label: "Sync Directory", mode: "run", fields: [] }],
  },
];

function task(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    name: "生产日志采集",
    providerType: "plugin",
    providerId: "io.dbx.files.tasks",
    target: { connectionId: "conn-prod" },
    trigger: { type: "cron", expression: "0 2 * * *", timeZone: "Asia/Shanghai" },
    execution: { mode: "run", concurrency: "forbid", retry: { maxAttempts: 1, backoffSeconds: 30, backoffStrategy: "fixed" }, misfire: "coalesce" },
    configVersion: 1,
    config: { __triggerId: "io.dbx.files.tasks/sync" },
    enabled: true,
    createdAt: now,
    updatedAt: now,
    nextRunAt: "2026-10-06T02:00:00Z",
    lastRunAt: null,
    lastRunStatus: null,
    version: 3,
    ...overrides,
  };
}

interface ListEvents {
  runNow: TaskDefinition[];
  cancel: Array<[TaskDefinition, string]>;
  toggle: Array<[TaskDefinition, boolean]>;
}

async function mountList(tasks: TaskDefinition[], activeRunIds: ReadonlyMap<string, string> = new Map(), events: ListEvents = { runNow: [], cancel: [], toggle: [] }) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(SchedulerTaskList, {
    tasks,
    healthContext: { providers, connectionIds: new Set(["conn-prod"]) },
    connectionNames: new Map([["conn-prod", "prod-web-01"]]),
    activeRunIds,
    cancellingRunIds: new Set<string>(),
    onCreate: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onViewRuns: () => {},
    onRunNow: (value: TaskDefinition) => events.runNow.push(value),
    onCancel: (value: TaskDefinition, runId: string) => events.cancel.push([value, runId]),
    onToggleEnabled: (value: TaskDefinition, enabled: boolean) => events.toggle.push([value, enabled]),
  });
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  return container;
}

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("SchedulerTaskList", () => {
  it("shows provider, cron timezone, next run and health for each task", async () => {
    const container = await mountList([task()]);
    expect(container.querySelector("[data-scheduler-task-row='task-1']")).toBeTruthy();
    expect(container.textContent).toContain("Files Tasks");
    expect(container.textContent).toContain("Cron 0 2 * * * · Asia/Shanghai");
    expect(container.textContent).toContain("2026");
  });

  it("marks tasks of uninstalled providers unavailable and blocks run-now (never deletes them)", async () => {
    const gone = task({ id: "task-gone", providerId: "io.dbx.gone.tasks" });
    const container = await mountList([gone]);
    expect(container.textContent).toContain("unavailable");
    const runButton = container.querySelector<HTMLButtonElement>("[data-scheduler-task-run]")!;
    expect(runButton.disabled).toBe(true);
    // The delete affordance stays available — removal is always a user decision.
    expect(container.querySelector("[data-scheduler-task-delete]")).toBeTruthy();
  });

  it("warns when the bound connection disappeared", async () => {
    const orphan = task({ target: { connectionId: "conn-deleted" } });
    const container = await mountList([orphan]);
    expect(container.textContent).toContain("Connection missing");
  });

  it("routes run-now and cancel to the right task and run", async () => {
    const events: ListEvents = { runNow: [], cancel: [], toggle: [] };
    const container = await mountList([task()], new Map([["task-1", "run-9"]]), events);
    // Active run replaces run-now with a cancel button.
    expect(container.querySelector("[data-scheduler-task-run]")).toBeNull();
    const cancel = container.querySelector<HTMLButtonElement>("[data-scheduler-task-cancel]")!;
    expect(cancel.disabled).toBe(false);
    cancel.click();
    expect(events.cancel).toEqual([[taskMatcher("task-1"), "run-9"]]);

    const idle = task({ id: "task-idle" });
    const events2: ListEvents = { runNow: [], cancel: [], toggle: [] };
    const container2 = await mountList([idle], new Map(), events2);
    container2.querySelector<HTMLButtonElement>("[data-scheduler-task-run]")!.click();
    expect(events2.runNow.map((value) => value.id)).toEqual(["task-idle"]);
  });

  it("filters tasks by search text", async () => {
    const container = await mountList([task(), task({ id: "task-2", name: "files sync" })]);
    const search = container.querySelector<HTMLInputElement>("[data-scheduler-task-search]")!;
    search.value = "sync";
    search.dispatchEvent(new Event("input"));
    await nextTick();
    expect(container.querySelectorAll("[data-scheduler-task-row]")).toHaveLength(1);
    expect(container.querySelector("[data-scheduler-task-row='task-2']")).toBeTruthy();
  });
});

function taskMatcher(id: string): TaskDefinition {
  return expect.objectContaining({ id }) as TaskDefinition;
}
