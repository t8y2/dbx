// @vitest-environment happy-dom

// Backup migration compatibility (plan §41–45): the legacy backup settings
// page stays functional and gains an entry into the unified task center —
// the old view must come back intact afterwards.
import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  listTasks: vi.fn(async () => []),
  listRuns: vi.fn(async () => []),
  listResidentSessions: vi.fn(async () => []),
  listPlugins: vi.fn(async () => []),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/scheduler/schedulerApi", () => ({
  schedulerErrorCode: () => undefined,
  listTasks: mocks.listTasks,
  listRuns: mocks.listRuns,
  listResidentSessions: mocks.listResidentSessions,
  getTask: vi.fn(),
  saveTask: vi.fn(),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  runTask: vi.fn(),
  cancelRun: vi.fn(),
  enableTask: vi.fn(),
  disableTask: vi.fn(),
  getRun: vi.fn(),
  getRunLogs: vi.fn(),
  listArtifacts: vi.fn(async () => []),
  residentAction: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ connections: [], ensureConnected: vi.fn(), recordConnectionLostError: vi.fn(() => false), getConfig: () => undefined }),
}));

vi.mock("@/composables/useScheduledDatabaseBackups", () => ({
  useScheduledDatabaseBackups: () => ({
    schedules: { __v_isRef: true, value: [] },
    runs: { __v_isRef: true, value: [] },
    activeScheduleIds: new Set<string>(),
    activeRunIds: new Set<string>(),
    cancellingRunIds: new Set<string>(),
    activeRuns: { __v_isRef: true, value: [] },
    heartbeat: { __v_isRef: true, value: null },
    destinationRoot: { __v_isRef: true, value: null },
    error: { __v_isRef: true, value: "" },
    saveSchedule: vi.fn(),
    setScheduleEnabled: vi.fn(),
    deleteSchedule: vi.fn(),
    deleteRuns: vi.fn(),
    deleteRun: vi.fn(),
    renameRun: vi.fn(),
    runSchedule: vi.fn(),
    runOneShot: vi.fn(),
    cancelRun: vi.fn(),
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  listPlugins: mocks.listPlugins,
  databaseBackupBackground: vi.fn(async () => ({ enabled: false, platform: "windows" })),
  databaseBackupCommand: vi.fn(async () => "2026-09-13T02:00:00Z"),
  databaseExportDestinationNeedsConfirmation: vi.fn(async () => false),
  recordDatabaseExportDestination: vi.fn(),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

vi.mock("@/lib/scheduler/schedulerEvents", () => ({
  subscribeSchedulerEvents: async () => () => {},
}));

import i18n from "../../../i18n";
import ScheduledDatabaseBackupSettings from "@/components/backup/ScheduledDatabaseBackupSettings.vue";

const mountedApps: App[] = [];

async function mountBackupPage() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(ScheduledDatabaseBackupSettings);
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return container;
}

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()?.unmount();
  document.body.innerHTML = "";
});

/** The scheduler page mounts through defineAsyncComponent; poll until it lands. */
async function waitFor(selector: string, timeoutMs = 2000): Promise<Element | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = document.body.querySelector(selector);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("legacy backup page migration entry", () => {
  it("keeps the legacy view and offers the task center entry", async () => {
    const container = await mountBackupPage();
    expect(container.querySelector("[data-backup-open-scheduler]")).toBeTruthy();
    expect(container.textContent).toContain("Open the task center");
    expect(document.body.querySelector("[data-scheduler-page]")).toBeNull();
  });

  it("switches to the unified task center and back without losing the legacy page", async () => {
    const container = await mountBackupPage();
    container.querySelector<HTMLButtonElement>("[data-backup-open-scheduler]")!.click();
    expect(await waitFor("[data-scheduler-page]")).toBeTruthy();
    expect(await waitFor("[data-backup-back-to-legacy]")).toBeTruthy();

    document.body.querySelector<HTMLButtonElement>("[data-backup-back-to-legacy]")!.click();
    await nextTick();
    expect(document.body.querySelector("[data-scheduler-page]")).toBeNull();
    expect(container.querySelector("[data-backup-open-scheduler]")).toBeTruthy();
  });
});
