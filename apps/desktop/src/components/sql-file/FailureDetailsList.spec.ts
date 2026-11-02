// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  readText: vi.fn(),
  exportLog: vi.fn(),
  reveal: vi.fn(),
  savePath: vi.fn(),
  copy: vi.fn(),
  toast: vi.fn(),
  desktop: true,
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}|${JSON.stringify(params)}` : key),
  }),
}));
vi.mock("@/lib/backend/api", () => ({
  sqlFileFailureLogInfo: mocks.logInfo,
  readSqlFileFailureLogText: mocks.readText,
  exportSqlFileFailureLog: mocks.exportLog,
  revealPathInFileManager: mocks.reveal,
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.desktop }));
vi.mock("@/lib/export/exportPath", () => ({ promptExportSavePath: mocks.savePath }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: mocks.copy }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

import FailureDetailsList from "@/components/sql-file/FailureDetailsList.vue";
import { failureLogSensitiveNotice } from "@/lib/export/failureLogExport";
import type { SqlFileFailure } from "@/composables/useExportTracker";

function failure(statementIndex: number, fileName = "a.sql"): SqlFileFailure {
  return {
    statementIndex,
    statementSummary: `INSERT #${statementIndex}`,
    error: "ORA-12899",
    fileIndex: 0,
    fileName,
  };
}

let app: App | null = null;
let root: HTMLElement;

async function mountList(options: { failures: SqlFileFailure[]; omitted?: number; expanded?: boolean } = { failures: [] }) {
  root = document.createElement("div");
  document.body.appendChild(root);
  // Reactive so a test can let a running execution report more failures.
  const state = reactive({ failures: [...options.failures], expanded: options.expanded ?? true });
  app = createApp({
    render: () =>
      h(FailureDetailsList, {
        executionId: "exec-1",
        failures: state.failures,
        omitted: options.omitted ?? 0,
        fileNameHint: "dump.sql",
        expanded: state.expanded,
        "onUpdate:expanded": (value: boolean) => {
          state.expanded = value;
        },
      }),
  });
  app.mount(root);
  await settle();
  return { root, app, state };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function buttons(): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll("button"));
}

function buttonWithText(fragment: string): HTMLButtonElement | undefined {
  return buttons().find((button) => (button.textContent ?? "").includes(fragment));
}

function checkboxes(): HTMLInputElement[] {
  return Array.from(root.querySelectorAll('input[type="checkbox"]'));
}

/** The first checkbox is "select all"; the rest belong to the failure rows. */
function selectAllBox(): HTMLInputElement {
  return checkboxes()[0]!;
}

function rowBox(index: number): HTMLInputElement {
  return checkboxes()[index + 1]!;
}

function toggle(box: HTMLInputElement) {
  box.checked = !box.checked;
  box.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop = true;
  mocks.logInfo.mockResolvedValue({ status: "available", path: "/home/user/.dbx/sql-file-logs/exec-1.jsonl" });
  mocks.readText.mockResolvedValue({ text: "FULL LOG TEXT", tooLarge: false, limitBytes: 5 * 1024 * 1024 });
  mocks.exportLog.mockResolvedValue({ records: 2, bytes: 120, format: "txt" });
  mocks.savePath.mockResolvedValue("/tmp/out.txt");
  mocks.copy.mockResolvedValue(undefined);
  // The sensitive-content notice is once per app run; each test starts a fresh run.
  failureLogSensitiveNotice.shown = false;
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
});

describe("FailureDetailsList", () => {
  it("counts hidden failures and says the export still has them all", async () => {
    // Collapsed view is what the user sees first, so the counts must be right there.
    await mountList({ failures: [failure(1), failure(2)], omitted: 98, expanded: false });

    expect(root.textContent).toContain("exportProgress.showFailureDetails|");
    expect(root.textContent).toContain('"count":100');
    expect(root.textContent).toContain("exportProgress.failureLog.listTruncated");
    expect(root.textContent).toContain('"visible":2,"total":100');
  });

  it("copies the selected rows from the backend log, not the truncated list", async () => {
    await mountList({ failures: [failure(644), failure(645), failure(646)] });

    toggle(rowBox(0));
    toggle(rowBox(2));
    await settle();
    expect(root.textContent).toContain('"count":2');

    buttonWithText("exportProgress.failureLog.copySelected")!.click();
    await settle();

    // Selected keys come from the visible rows, and the text comes from the log
    // so it carries the complete statements.
    expect(mocks.readText).toHaveBeenCalledWith("exec-1", "txt", [
      { fileIndex: 0, statementIndex: 644 },
      { fileIndex: 0, statementIndex: 646 },
    ]);
    expect(mocks.copy).toHaveBeenCalledWith("FULL LOG TEXT");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("copySelectedDone"), 2500);
  });

  it("selects every visible row and exports the full log", async () => {
    await mountList({ failures: [failure(1), failure(2)] });

    toggle(selectAllBox());
    await settle();

    buttonWithText("exportProgress.failureLog.exportTxt")!.click();
    await settle();

    expect(mocks.savePath).toHaveBeenCalledWith(expect.objectContaining({ defaultFileName: "dump-failures.txt" }));
    // Exporting everything passes no keys, so the backend writes the whole log.
    expect(mocks.exportLog).toHaveBeenCalledWith("exec-1", "txt", "/tmp/out.txt", undefined);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("exportedRecords"), 3000);
  });

  it("exports only the selected rows when the user asks for it", async () => {
    await mountList({ failures: [failure(1), failure(2)] });

    toggle(rowBox(1));
    await settle();
    mocks.savePath.mockResolvedValue("/tmp/selected.csv");

    buttonWithText("exportProgress.failureLog.exportSelected")!.click();
    await settle();

    expect(mocks.exportLog).toHaveBeenCalledWith("exec-1", "txt", "/tmp/selected.csv", [{ fileIndex: 0, statementIndex: 2 }]);
  });

  it("degrades to the in-memory summaries when the log is unavailable, and says so", async () => {
    mocks.logInfo.mockResolvedValue({ status: "unavailable", reason: "Cannot create failure log" });
    await mountList({ failures: [failure(644)] });

    expect(root.textContent).toContain("exportProgress.failureLog.unavailable");

    toggle(rowBox(0));
    await settle();
    buttonWithText("exportProgress.failureLog.copySelected")!.click();
    await settle();

    expect(mocks.readText).not.toHaveBeenCalled();
    expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining("INSERT #644"));
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("copySummaryFallback"), 5000);
  });

  it("sends the user to the file export when the selection is too large to copy", async () => {
    mocks.readText.mockResolvedValue({ text: undefined, tooLarge: true, limitBytes: 5 * 1024 * 1024 });
    await mountList({ failures: [failure(1)] });

    toggle(rowBox(0));
    await settle();
    buttonWithText("exportProgress.failureLog.copySelected")!.click();
    await settle();

    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("copyTooLarge"), 5000);
  });

  it("keeps the per-row copy button for a single failure", async () => {
    await mountList({ failures: [failure(644)] });

    const rowCopy = buttons().find((button) => (button.getAttribute("aria-label") ?? "") === "exportProgress.copyFailureDetail");
    rowCopy!.click();
    await settle();

    expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining("INSERT #644"));
    expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining("ORA-12899"));
  });

  it("notices a log that degrades while the execution is still running", async () => {
    const mounted = await mountList({ failures: [failure(1)] });
    expect(root.textContent).not.toContain("exportProgress.failureLog.degraded");

    // The disk fills up mid-run: the next failure arrives together with a
    // degraded status, which must reach the UI without any user action.
    mocks.logInfo.mockResolvedValue({ status: "degraded", reason: "Cannot write failure log" });
    mounted.state.failures.push(failure(2));
    await settle();

    expect(mocks.logInfo.mock.calls.length).toBeGreaterThan(1);
    expect(root.textContent).toContain("exportProgress.failureLog.degraded");
  });

  it("re-reads the log state before acting on it", async () => {
    await mountList({ failures: [failure(1)] });
    mocks.logInfo.mockClear();

    toggle(rowBox(0));
    await settle();
    buttonWithText("exportProgress.failureLog.copySelected")!.click();
    await settle();

    // Acting on a cached status could export or copy from a log that is gone.
    expect(mocks.logInfo).toHaveBeenCalledWith("exec-1");
  });

  it("warns once per app run that the log can contain sensitive data", async () => {
    await mountList({ failures: [failure(1)] });

    toggle(rowBox(0));
    await settle();
    buttonWithText("exportProgress.failureLog.copySelected")!.click();
    await settle();

    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("sensitiveWarning"), 8000);

    mocks.toast.mockClear();
    buttonWithText("exportProgress.failureLog.exportTxt")!.click();
    await settle();

    // Warning once is informative; repeating it on every action is just noise.
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringContaining("sensitiveWarning"), 8000);
  });

  it("offers the log folder only when the backend reported a path", async () => {
    await mountList({ failures: [failure(1)] });
    expect(buttonWithText("exportProgress.failureLog.openFolder")).toBeDefined();

    app?.unmount();
    root.remove();
    mocks.logInfo.mockResolvedValue({ status: "degraded", reason: "Cannot write failure log" });
    await mountList({ failures: [failure(1)] });

    expect(root.textContent).toContain("exportProgress.failureLog.degraded");
    expect(buttonWithText("exportProgress.failureLog.openFolder")).toBeUndefined();
  });
});
