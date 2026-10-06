// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import { useSettingsStore } from "@/stores/settingsStore";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  saveTask: vi.fn(),
  createTask: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/scheduler/schedulerApi", () => ({
  schedulerErrorCode: (error: unknown) => (error instanceof Error && error.message.startsWith("version_conflict") ? "version_conflict" : undefined),
  getTask: mocks.getTask,
  saveTask: mocks.saveTask,
  createTask: mocks.createTask,
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

import SchedulerTaskEditor from "../SchedulerTaskEditor.vue";
import type { SchedulerTaskProviderDescriptor, TaskDefinition } from "@/lib/scheduler/schedulerTypes";

const mountedApps: App[] = [];

const providers: SchedulerTaskProviderDescriptor[] = [
  {
    providerId: "io.dbx.ssh.tasks",
    label: "SSH Tasks",
    pluginId: "io.dbx.ssh",
    connectionProviders: ["io.dbx.ssh.connection"],
    capabilities: ["run", "cancel", "logs"],
    triggers: [{ id: "execute", label: "Execute Command", mode: "run", risk: "high", fields: [{ key: "command", label: "Command", type: "textarea", required: true }] }],
  },
  {
    providerId: "io.dbx.files.tasks",
    label: "Files Tasks",
    pluginId: "io.dbx.files",
    connectionProviders: [],
    capabilities: ["run"],
    triggers: [{ id: "sync", label: "Sync Directory", mode: "run", fields: [] }],
  },
];

const connections = [
  { id: "conn-prod", name: "prod-web-01", db_type: "mysql", host: "h", port: 3306, username: "u", password: "p" },
  { id: "conn-backup", name: "backup-host", db_type: "postgres", host: "h", port: 5432, username: "u", password: "p" },
] as const;

function cronTask(): TaskDefinition {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    name: "检查 nginx",
    providerType: "plugin",
    providerId: "io.dbx.ssh.tasks",
    target: { connectionId: "conn-prod" },
    trigger: { type: "cron", expression: "*/5 * * * *", timeZone: "Asia/Shanghai" },
    execution: { mode: "run", timeoutSeconds: 60, concurrency: "forbid", retry: { maxAttempts: 1, backoffSeconds: 30, backoffStrategy: "fixed" }, misfire: "coalesce", restart: null },
    configVersion: 1,
    config: { __triggerId: "io.dbx.ssh.tasks/execute", command: "systemctl is-active nginx" },
    enabled: true,
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    version: 7,
  };
}

async function mountEditor(props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(SchedulerTaskEditor, {
    providers,
    connections,
    "onUpdate:open": (value: boolean) => Object.assign(props, { open: value }),
    onSaved: () => {},
    ...props,
  });
  mountedApps.push(app);
  app.use(createPinia());
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return document.body;
}

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

beforeEach(() => {
  mocks.getTask.mockReset();
  mocks.saveTask.mockReset();
  mocks.createTask.mockReset();
  mocks.toast.mockReset();
});

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("SchedulerTaskEditor", () => {
  it("requires the high-risk acknowledgement before saving", async () => {
    const container = await mountEditor({ open: true, task: cronTask() });
    const save = container.querySelector<HTMLButtonElement>("[data-scheduler-editor-save]")!;
    expect(save.disabled).toBe(true);
    expect(container.querySelector("[data-scheduler-editor-risk-high]")).toBeTruthy();
    const ack = container.querySelector<HTMLInputElement>("[data-scheduler-editor-risk-ack]")!;
    ack.checked = true;
    ack.dispatchEvent(new Event("change"));
    await flush();
    expect(container.querySelector<HTMLButtonElement>("[data-scheduler-editor-save]")!.disabled).toBe(false);
  });

  it("persists an edited cron timezone on save", async () => {
    mocks.saveTask.mockResolvedValue(cronTask());
    useSettingsStore;
    const container = await mountEditor({ open: true, task: cronTask() });
    const ack = container.querySelector<HTMLInputElement>("[data-scheduler-editor-risk-ack]")!;
    ack.checked = true;
    ack.dispatchEvent(new Event("change"));
    await flush();
    const zoneInput = container.querySelector<HTMLInputElement>("[data-scheduler-trigger-timezone]")!;
    expect(zoneInput.value).toBe("Asia/Shanghai");
    zoneInput.value = "America/Los_Angeles";
    zoneInput.dispatchEvent(new Event("input"));
    await flush();
    container.querySelector<HTMLButtonElement>("[data-scheduler-editor-save]")!.click();
    await flush();
    expect(mocks.saveTask).toHaveBeenCalledTimes(1);
    const saved = mocks.saveTask.mock.calls[0]![0] as TaskDefinition;
    expect(saved.trigger).toEqual({ type: "cron", expression: "*/5 * * * *", timeZone: "America/Los_Angeles" });
    expect(saved.version).toBe(7);
  });

  it("surfaces a version conflict and reloads the stored version", async () => {
    mocks.saveTask.mockRejectedValue(new Error("version_conflict: stored version 8"));
    const container = await mountEditor({ open: true, task: cronTask() });
    const ack = container.querySelector<HTMLInputElement>("[data-scheduler-editor-risk-ack]")!;
    ack.checked = true;
    ack.dispatchEvent(new Event("change"));
    await flush();
    container.querySelector<HTMLButtonElement>("[data-scheduler-editor-save]")!.click();
    await flush();
    expect(container.querySelector("[data-scheduler-editor-conflict]")).toBeTruthy();
    mocks.getTask.mockResolvedValue({ ...cronTask(), version: 8, name: "renamed elsewhere" });
    container.querySelector<HTMLButtonElement>("[data-scheduler-editor-conflict] button")!.click();
    await flush();
    expect(mocks.getTask).toHaveBeenCalledWith("task-1");
    expect(container.querySelector("[data-scheduler-editor-conflict]")).toBeNull();
  });

  it("flags a missing required connection from the provider declaration", async () => {
    const task = { ...cronTask(), target: { connectionId: "" } };
    const container = await mountEditor({ open: true, task });
    expect(container.querySelector("[data-scheduler-editor-connection]")).toBeTruthy();
    const validation = container.querySelector("[data-scheduler-editor-validation]")?.textContent ?? "";
    expect(validation.length).toBeGreaterThan(0);
    expect(container.querySelector<HTMLButtonElement>("[data-scheduler-editor-save]")!.disabled).toBe(true);
  });

  it("renders no provider options without discovery results (no hardcoded fallback)", async () => {
    const container = await mountEditor({ open: true, task: null, providers: [] });
    expect(container.querySelector("[data-scheduler-editor-provider]")).toBeTruthy();
    expect(container.querySelector<HTMLButtonElement>("[data-scheduler-editor-save]")!.disabled).toBe(true);
  });
});
