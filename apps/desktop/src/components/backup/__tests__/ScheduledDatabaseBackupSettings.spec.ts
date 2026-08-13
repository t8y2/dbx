// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import ScheduledDatabaseBackupSettings from "@/components/backup/ScheduledDatabaseBackupSettings.vue";
import type { DatabaseBackupSchedule } from "@/lib/backup/scheduledDatabaseBackup";

const mocks = vi.hoisted(() => ({
  connections: [] as Array<{ id: string; name: string; db_type: string }>,
  schedules: [] as DatabaseBackupSchedule[],
  ensureConnected: vi.fn(async () => {}),
  listDatabases: vi.fn(async () => [{ name: "app" }]),
  toast: vi.fn(),
  saveSchedule: vi.fn(),
  setScheduleEnabled: vi.fn(),
  deleteSchedule: vi.fn(),
  deleteRun: vi.fn(),
  runSchedule: vi.fn(),
  cancelRun: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: mocks.connections,
    ensureConnected: mocks.ensureConnected,
    getConfig: (connectionId: string) => mocks.connections.find((connection) => connection.id === connectionId),
    sqlFileSource: null,
  }),
}));

vi.mock("@/composables/useScheduledDatabaseBackups", () => ({
  useScheduledDatabaseBackups: () => ({
    schedules: { __v_isRef: true, value: mocks.schedules },
    runs: { __v_isRef: true, value: [] },
    activeScheduleIds: new Set<string>(),
    activeRunIds: new Set<string>(),
    activeRuns: { __v_isRef: true, value: [] },
    saveSchedule: mocks.saveSchedule,
    setScheduleEnabled: mocks.setScheduleEnabled,
    deleteSchedule: mocks.deleteSchedule,
    deleteRun: mocks.deleteRun,
    runSchedule: mocks.runSchedule,
    cancelRun: mocks.cancelRun,
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  deleteDatabaseBackupFiles: vi.fn(),
  revealPathInFileManager: vi.fn(),
}));

const mountedApps: App[] = [];

async function flush() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountSettings() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(ScheduledDatabaseBackupSettings);
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await flush();
}

function addScheduleButton(): HTMLButtonElement {
  const label = String(i18n.global.t("databaseBackup.addSchedule"));
  const button = Array.from(document.body.querySelectorAll("button")).find((item) => item.textContent?.includes(label));
  if (!button) throw new Error("Add schedule button not found");
  return button;
}

function schedule(overrides: Partial<DatabaseBackupSchedule> = {}): DatabaseBackupSchedule {
  return {
    id: "schedule-1",
    name: "Nightly backup",
    enabled: true,
    connectionId: "mysql-1",
    databases: ["app"],
    tableFilterMode: "all",
    tablePatterns: [],
    destinationDirectory: "/backups",
    frequency: "daily",
    intervalHours: 6,
    timeOfDay: "02:00",
    weekday: 1,
    includeStructure: true,
    includeData: true,
    includeObjects: true,
    dropTableIfExists: false,
    retentionCount: 10,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    nextRunAt: "2026-08-13T02:00:00.000Z",
    ...overrides,
  };
}

function buttonWithTitle(title: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll("button")).find((item) => item.title === title);
  if (!button) throw new Error(`Button not found: ${title}`);
  return button;
}

function saveScheduleButton(): HTMLButtonElement {
  const dialog = document.body.querySelector('[data-slot="dialog-content"]');
  const label = String(i18n.global.t("common.save"));
  const button = Array.from(dialog?.querySelectorAll("button") ?? []).find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error("Save schedule button not found");
  return button;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  mocks.connections.splice(0);
  mocks.schedules.splice(0);
  mocks.ensureConnected.mockClear();
  mocks.listDatabases.mockClear();
  mocks.toast.mockClear();
  mocks.saveSchedule.mockClear();
});

describe("ScheduledDatabaseBackupSettings schedule dialog", () => {
  it("opens the create schedule dialog for supported SQL connections", async () => {
    mocks.connections.push({ id: "mysql-1", name: "Local MySQL", db_type: "mysql" });
    await mountSettings();

    const button = addScheduleButton();
    expect(button.disabled).toBe(false);

    button.click();
    await flush();

    const dialog = document.body.querySelector('[data-slot="dialog-content"]');
    expect(dialog?.textContent).toContain(String(i18n.global.t("databaseBackup.addSchedule")));
    expect(dialog?.textContent).toContain(String(i18n.global.t("databaseBackup.scheduleName")));
    expect(mocks.ensureConnected).toHaveBeenCalledWith("mysql-1");
    expect(mocks.listDatabases).toHaveBeenCalledWith("mysql-1");
  });

  it("disables create schedule when there are no supported backup connections", async () => {
    mocks.connections.push({ id: "oracle-1", name: "Oracle", db_type: "oracle" });
    await mountSettings();

    expect(addScheduleButton().disabled).toBe(true);
    expect(document.body.textContent).toContain(String(i18n.global.t("databaseBackup.noSupportedConnections")));
  });

  it("removes unavailable databases from an edited schedule before saving", async () => {
    mocks.connections.push({ id: "mysql-1", name: "Local MySQL", db_type: "mysql" });
    mocks.schedules.push(schedule({ databases: ["app", "deleted"] }));
    mocks.listDatabases.mockResolvedValueOnce([{ name: "app" }]);
    await mountSettings();

    buttonWithTitle(String(i18n.global.t("databaseBackup.edit"))).click();
    await flush();
    saveScheduleButton().click();
    await flush();

    expect(mocks.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ databases: ["app"] }));
  });

  it("does not allow saving when every selected database is unavailable", async () => {
    mocks.connections.push({ id: "mysql-1", name: "Local MySQL", db_type: "mysql" });
    mocks.schedules.push(schedule({ databases: ["deleted"] }));
    mocks.listDatabases.mockResolvedValueOnce([{ name: "app" }]);
    await mountSettings();

    buttonWithTitle(String(i18n.global.t("databaseBackup.edit"))).click();
    await flush();

    expect(saveScheduleButton().disabled).toBe(true);
    expect(mocks.saveSchedule).not.toHaveBeenCalled();
  });

  it("preserves configured databases when refreshing the list fails", async () => {
    mocks.connections.push({ id: "mysql-1", name: "Local MySQL", db_type: "mysql" });
    mocks.schedules.push(schedule({ databases: ["app", "archive"] }));
    mocks.listDatabases.mockRejectedValueOnce(new Error("database list failed"));
    await mountSettings();

    buttonWithTitle(String(i18n.global.t("databaseBackup.edit"))).click();
    await flush();
    saveScheduleButton().click();
    await flush();

    expect(mocks.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ databases: ["app", "archive"] }));
  });
});
