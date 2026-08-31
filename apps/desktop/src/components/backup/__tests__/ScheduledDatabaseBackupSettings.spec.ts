// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";
import ScheduledDatabaseBackupSettings from "../ScheduledDatabaseBackupSettings.vue";
import type { DatabaseBackupRun, DatabaseBackupSchedule } from "../../../lib/backup/scheduledDatabaseBackup";

const mocks = vi.hoisted(() => ({
  connections: [] as Array<{ id: string; name: string; db_type: string }>,
  schedules: [] as DatabaseBackupSchedule[],
  runs: [] as DatabaseBackupRun[],
  activeRunIds: new Set<string>(),
  cancellingRunIds: new Set<string>(),
  activeRuns: [] as DatabaseBackupRun[],
  ensureConnected: vi.fn(async () => {}),
  listDatabases: vi.fn(async (_connectionId: string) => [{ name: "app" }]),
  recordDatabaseExportDestination: vi.fn(async (_directory: string) => {}),
  toast: vi.fn(),
  saveSchedule: vi.fn(),
  setScheduleEnabled: vi.fn(),
  deleteSchedule: vi.fn(),
  deleteRun: vi.fn(),
  runSchedule: vi.fn(),
  runOneShot: vi.fn(),
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
    runs: { __v_isRef: true, value: mocks.runs },
    activeScheduleIds: new Set<string>(),
    activeRunIds: mocks.activeRunIds,
    cancellingRunIds: mocks.cancellingRunIds,
    activeRuns: { __v_isRef: true, value: mocks.activeRuns },
    saveSchedule: mocks.saveSchedule,
    setScheduleEnabled: mocks.setScheduleEnabled,
    deleteSchedule: mocks.deleteSchedule,
    deleteRun: mocks.deleteRun,
    runSchedule: mocks.runSchedule,
    runOneShot: mocks.runOneShot,
    cancelRun: mocks.cancelRun,
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => "/backups"),
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  deleteDatabaseBackupFiles: vi.fn(),
  revealPathInFileManager: vi.fn(),
  recordDatabaseExportDestination: mocks.recordDatabaseExportDestination,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function currentDialog(): HTMLElement {
  const dialog = document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  if (!dialog) throw new Error("Dialog not found");
  return dialog;
}

async function selectDialogOption(triggerIndex: number, optionText: string) {
  const trigger = currentDialog().querySelectorAll<HTMLButtonElement>('[data-slot="select-trigger"]')[triggerIndex];
  if (!trigger) throw new Error(`Select trigger not found: ${triggerIndex}`);
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  await flush();
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent?.trim() === optionText);
  if (!option) throw new Error(`Select option not found: ${optionText}`);
  option.focus();
  option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await flush();
}

async function setTablePattern(pattern: string) {
  await selectDialogOption(0, String(i18n.global.t("databaseBackup.includeTables")));
  const input = currentDialog().querySelector<HTMLInputElement>(`input[placeholder="${String(i18n.global.t("databaseBackup.tablePatternsPlaceholder"))}"]`);
  if (!input) throw new Error("Table pattern input not found");
  input.value = pattern;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
}

async function selectBackupConnection(connectionName: string) {
  const trigger = currentDialog().querySelector<HTMLButtonElement>("[data-backup-connection-picker]");
  if (!trigger) throw new Error("Backup connection picker not found");
  trigger.click();
  await flush();
  const search = document.body.querySelector<HTMLInputElement>("[data-backup-connection-search]");
  if (!search) throw new Error("Backup connection search not found");
  search.value = connectionName;
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  const option = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === connectionName);
  if (!option) throw new Error(`Backup connection option not found: ${connectionName}`);
  option.click();
  await flush();
}

async function selectHistoryConnection(connectionName: string) {
  const trigger = document.body.querySelector<HTMLButtonElement>("[data-backup-history-connection-picker]");
  if (!trigger) throw new Error("History connection picker not found");
  trigger.click();
  await flush();
  const search = document.body.querySelector<HTMLInputElement>("[data-backup-history-connection-search]");
  if (!search) throw new Error("History connection search not found");
  search.value = connectionName;
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  const option = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === connectionName);
  if (!option) throw new Error(`History connection option not found: ${connectionName}`);
  option.click();
  await flush();
}

async function selectHistoryFilter(triggerIndex: number, optionText: string) {
  const trigger = document.body.querySelectorAll<HTMLButtonElement>('[data-slot="select-trigger"]')[triggerIndex];
  if (!trigger) throw new Error(`History filter trigger not found: ${triggerIndex}`);
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  await flush();
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent?.trim() === optionText);
  if (!option) throw new Error(`History filter option not found: ${optionText}`);
  option.focus();
  option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await flush();
}

async function showDatabaseOptions() {
  const label = String(i18n.global.t("databaseBackup.allDatabases"));
  const checkbox = Array.from(currentDialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((item) => item.parentElement?.textContent?.includes(label));
  if (!checkbox) throw new Error("All databases checkbox not found");
  checkbox.checked = false;
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
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
    outputCompression: "none",
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
  mocks.runs.splice(0);
  mocks.activeRuns.splice(0);
  mocks.activeRunIds.clear();
  mocks.cancellingRunIds.clear();
  mocks.ensureConnected.mockClear();
  mocks.listDatabases.mockReset();
  mocks.listDatabases.mockResolvedValue([{ name: "app" }]);
  mocks.recordDatabaseExportDestination.mockReset();
  mocks.recordDatabaseExportDestination.mockResolvedValue(undefined);
  mocks.toast.mockClear();
  mocks.saveSchedule.mockClear();
  mocks.cancelRun.mockClear();
  mocks.runOneShot.mockReset();
  mocks.runOneShot.mockResolvedValue(null);
});

describe("ScheduledDatabaseBackupSettings schedule dialog", () => {
  it("filters backup history by a searched connection", async () => {
    mocks.runs.push(
      {
        id: "run-primary",
        scheduleName: "Primary backup",
        connectionId: "mysql-primary",
        connectionName: "Primary MySQL",
        trigger: "manual",
        source: "schedule",
        status: "success",
        startedAt: "2026-08-18T00:00:00.000Z",
        files: [],
      },
      {
        id: "run-archive",
        scheduleName: "Archive backup",
        connectionId: "mysql-archive",
        connectionName: "Archive MySQL",
        trigger: "manual",
        source: "schedule",
        status: "success",
        startedAt: "2026-08-19T00:00:00.000Z",
        files: [],
      },
    );
    await mountSettings();

    await selectHistoryConnection("Archive MySQL");

    expect(document.body.textContent).toContain("Archive backup");
    expect(document.body.textContent).not.toContain("Primary backup");
  });

  it("combines backup method and status filters for history", async () => {
    mocks.runs.push(
      {
        id: "run-manual-success",
        scheduleName: "Manual success backup",
        connectionId: "mysql-1",
        connectionName: "Local MySQL",
        trigger: "manual",
        source: "scheduled",
        status: "success",
        startedAt: "2026-08-18T00:00:00.000Z",
        files: [],
      },
      {
        id: "run-scheduled-failed",
        scheduleName: "Scheduled failed backup",
        connectionId: "mysql-1",
        connectionName: "Local MySQL",
        trigger: "scheduled",
        source: "scheduled",
        status: "failed",
        startedAt: "2026-08-19T00:00:00.000Z",
        files: [],
      },
    );
    await mountSettings();

    await selectHistoryFilter(0, String(i18n.global.t("databaseBackup.scheduledTrigger")));
    await selectHistoryFilter(1, String(i18n.global.t("databaseBackup.status.failed")));

    expect(document.body.textContent).toContain("Scheduled failed backup");
    expect(document.body.textContent).not.toContain("Manual success backup");
  });

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

  it("opens an independent one-shot dialog without schedule fields", async () => {
    mocks.connections.push({ id: "mysql-1", name: "Local MySQL", db_type: "mysql" });
    await mountSettings();

    buttonWithText(String(i18n.global.t("databaseBackup.oneShotBackup"))).click();
    await flush();

    const dialog = document.body.querySelector('[data-slot="dialog-content"]');
    expect(dialog?.textContent).toContain(String(i18n.global.t("databaseBackup.oneShotDescription")));
    expect(dialog?.textContent).toContain(String(i18n.global.t("databaseBackup.connection")));
    expect(dialog?.textContent).toContain(String(i18n.global.t("databaseBackup.contents")));
    expect(dialog?.textContent).not.toContain(String(i18n.global.t("databaseBackup.scheduleName")));
    expect(dialog?.textContent).not.toContain(String(i18n.global.t("databaseBackup.frequency")));
    expect(dialog?.textContent).not.toContain(String(i18n.global.t("databaseBackup.retention")));
    expect(dialog?.textContent).not.toContain(String(i18n.global.t("databaseBackup.enabled")));
  });

  it("validates one-shot fields and starts without creating a schedule", async () => {
    mocks.connections.push({ id: "mysql-1", name: "Local MySQL", db_type: "mysql" });
    mocks.runOneShot.mockResolvedValueOnce({ id: "run-1", status: "success", files: [], scheduleName: "One-time backup" });
    await mountSettings();

    buttonWithText(String(i18n.global.t("databaseBackup.oneShotBackup"))).click();
    await flush();
    const dialog = document.body.querySelector('[data-slot="dialog-content"]');
    const startLabel = String(i18n.global.t("databaseBackup.startBackup"));
    const startButton = Array.from(dialog?.querySelectorAll("button") ?? []).find((item) => item.textContent?.trim() === startLabel) as HTMLButtonElement | undefined;
    expect(startButton?.disabled).toBe(true);

    buttonWithTitle(String(i18n.global.t("databaseBackup.selectDestination"))).click();
    await flush();
    expect(startButton?.disabled).toBe(false);
    startButton?.click();
    await flush();

    expect(mocks.schedules).toHaveLength(0);
    expect(mocks.saveSchedule).not.toHaveBeenCalled();
    expect(mocks.runOneShot).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "mysql-1", destinationDirectory: "/backups", databases: [] }), String(i18n.global.t("databaseBackup.oneShotName")));
  });

  it("keeps the newer connection database list when an older response finishes last", async () => {
    mocks.connections.push({ id: "mysql-a", name: "MySQL A", db_type: "mysql" }, { id: "mysql-b", name: "MySQL B", db_type: "mysql" });
    const firstLoad = deferred<Array<{ name: string }>>();
    const secondLoad = deferred<Array<{ name: string }>>();
    mocks.listDatabases.mockImplementation((connectionId: string) => (connectionId === "mysql-a" ? firstLoad.promise : secondLoad.promise));
    await mountSettings();

    buttonWithText(String(i18n.global.t("databaseBackup.oneShotBackup"))).click();
    await vi.waitFor(() => expect(mocks.listDatabases).toHaveBeenCalledWith("mysql-a"));
    await selectBackupConnection("MySQL B");
    await vi.waitFor(() => expect(mocks.listDatabases).toHaveBeenCalledWith("mysql-b"));

    secondLoad.resolve([{ name: "new_database" }]);
    await flush();
    await showDatabaseOptions();
    expect(currentDialog().textContent).toContain("new_database");

    firstLoad.resolve([{ name: "stale_database" }]);
    await flush();
    expect(currentDialog().textContent).toContain("new_database");
    expect(currentDialog().textContent).not.toContain("stale_database");
  });

  it("filters database choices locally without changing the loaded options", async () => {
    mocks.connections.push({ id: "mysql-1", name: "Local MySQL", db_type: "mysql" });
    mocks.listDatabases.mockResolvedValue([{ name: "analytics" }, { name: "application" }, { name: "billing" }]);
    await mountSettings();

    buttonWithText(String(i18n.global.t("databaseBackup.oneShotBackup"))).click();
    await flush();
    await showDatabaseOptions();

    const search = currentDialog().querySelector<HTMLInputElement>("[data-backup-database-search]");
    if (!search) throw new Error("Backup database search not found");
    search.value = "bill";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    expect(currentDialog().textContent).toContain("billing");
    expect(currentDialog().textContent).not.toContain("analytics");
    expect(currentDialog().textContent).not.toContain("application");
  });

  it("does not let a closed one-shot request clear a schedule draft", async () => {
    mocks.connections.push({ id: "mysql-1", name: "Local MySQL", db_type: "mysql" });
    const oneShotLoad = deferred<Array<{ name: string }>>();
    const scheduleLoad = deferred<Array<{ name: string }>>();
    mocks.listDatabases.mockImplementationOnce(() => oneShotLoad.promise).mockImplementationOnce(() => scheduleLoad.promise);
    await mountSettings();

    buttonWithText(String(i18n.global.t("databaseBackup.oneShotBackup"))).click();
    await vi.waitFor(() => expect(mocks.listDatabases).toHaveBeenCalledTimes(1));
    const closeOneShot = Array.from(currentDialog().querySelectorAll("button")).find((item) => item.textContent?.trim() === String(i18n.global.t("common.cancel")));
    closeOneShot?.click();
    await flush();

    addScheduleButton().click();
    await vi.waitFor(() => expect(mocks.listDatabases).toHaveBeenCalledTimes(2));
    await setTablePattern("schedule_*");

    oneShotLoad.resolve([{ name: "one_shot_database" }]);
    await flush();
    expect(currentDialog().querySelector<HTMLInputElement>(`input[placeholder="${String(i18n.global.t("databaseBackup.tablePatternsPlaceholder"))}"]`)?.value).toBe("schedule_*");

    scheduleLoad.resolve([{ name: "schedule_database" }]);
    await flush();
    expect(currentDialog().querySelector<HTMLInputElement>(`input[placeholder="${String(i18n.global.t("databaseBackup.tablePatternsPlaceholder"))}"]`)?.value).toBe("schedule_*");
  });

  it("keeps closing the one-shot dialog separate from cancelling the active run", async () => {
    mocks.connections.push({ id: "mysql-1", name: "Local MySQL", db_type: "mysql" });
    const activeRun = {
      id: "one-shot-active",
      scheduleName: "One-time backup",
      connectionId: "mysql-1",
      connectionName: "Local MySQL",
      trigger: "manual",
      source: "one-shot",
      status: "running",
      startedAt: "2026-08-18T00:00:00.000Z",
      files: [],
      progressPercent: 25,
    } satisfies DatabaseBackupRun;
    mocks.runs.push(activeRun);
    mocks.activeRuns.push(activeRun);
    mocks.activeRunIds.add(activeRun.id);
    const pendingRun = deferred<DatabaseBackupRun>();
    mocks.runOneShot.mockReturnValueOnce(pendingRun.promise);
    await mountSettings();

    buttonWithText(String(i18n.global.t("databaseBackup.oneShotBackup"))).click();
    await flush();
    buttonWithTitle(String(i18n.global.t("databaseBackup.selectDestination"))).click();
    await flush();
    const startButton = Array.from(currentDialog().querySelectorAll("button")).find((item) => item.textContent?.trim() === String(i18n.global.t("databaseBackup.startBackup")));
    startButton?.click();
    await flush();

    const runningDialog = currentDialog();
    const closeButton = Array.from(runningDialog.querySelectorAll("button")).find((item) => item.textContent?.trim() === String(i18n.global.t("common.close")));
    const cancelButton = Array.from(runningDialog.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.title === String(i18n.global.t("databaseBackup.cancel")));
    expect(closeButton).toBeTruthy();
    expect(cancelButton?.disabled).toBe(false);

    closeButton?.click();
    await flush();
    expect(mocks.cancelRun).not.toHaveBeenCalled();

    buttonWithTitle(String(i18n.global.t("databaseBackup.cancel"))).click();
    await flush();
    expect(mocks.cancelRun).toHaveBeenCalledWith(activeRun.id);

    pendingRun.resolve({ ...activeRun, status: "cancelled", completedAt: "2026-08-18T00:01:00.000Z" });
    await flush();
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

  it("does not save when the destination identity cannot be recorded", async () => {
    mocks.connections.push({ id: "mysql-1", name: "Local MySQL", db_type: "mysql" });
    mocks.schedules.push(schedule());
    mocks.recordDatabaseExportDestination.mockRejectedValueOnce(new Error("backup destination unavailable"));
    await mountSettings();

    buttonWithTitle(String(i18n.global.t("databaseBackup.edit"))).click();
    await flush();
    saveScheduleButton().click();
    await flush();

    expect(mocks.recordDatabaseExportDestination).toHaveBeenCalledWith("/backups");
    expect(mocks.saveSchedule).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("backup destination unavailable", 5000);
  });
});
