// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n";

const mocks = vi.hoisted(() => ({
  invokePluginPathBrowse: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  invokePluginPathBrowse: mocks.invokePluginPathBrowse,
}));

import SchedulerPluginPathPickerDialog from "../SchedulerPluginPathPickerDialog.vue";

const mountedApps: App[] = [];

interface MountOptions {
  pluginId?: string;
  action?: string;
  connectionId?: string;
  initialPath?: string;
  open?: boolean;
}

async function mountDialog(options: MountOptions = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(SchedulerPluginPathPickerDialog, {
    open: options.open ?? true,
    pluginId: options.pluginId ?? "io.dbx.files",
    action: options.action ?? "files/listDirs",
    connectionId: options.connectionId ?? "conn-src",
    initialPath: options.initialPath ?? "/",
    "onUpdate:open": (value: boolean) => {
      app._instance!.props!.open = value;
    },
    onSelect: (path: string) => selected.push(path),
  });
  const selected: string[] = [];
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return { selected };
}

function pickerRoot(): HTMLElement {
  const root = document.body.querySelector<HTMLElement>("[data-scheduler-path-picker]");
  expect(root).not.toBeNull();
  return root!;
}

function entryButtons(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>("[data-scheduler-path-picker-entry]")];
}

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()?.unmount();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function dirsResult(entries: Array<[name: string, path: string]>, truncated = false) {
  return { entries: entries.map(([name, path]) => ({ name, path, is_dir: true })), truncated };
}

describe("SchedulerPluginPathPickerDialog", () => {
  it("browses the initial path through the plugin method and lists directories", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(
      dirsResult([
        ["sub", "/sub"],
        ["deep", "/sub/deep"],
      ]),
    );
    await mountDialog({ initialPath: "/data" });
    expect(mocks.invokePluginPathBrowse).toHaveBeenCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/data", "en");
    expect(entryButtons().map((button) => button.dataset.schedulerPathPickerEntry)).toEqual(["/sub", "/sub/deep"]);
  });

  it("non-directory rows are dropped defensively even if the plugin sends them", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue({
      entries: [
        { name: "keep", path: "/keep", is_dir: true },
        { name: "file.txt", path: "/file.txt", is_dir: false },
      ],
    });
    await mountDialog({});
    expect(entryButtons().map((button) => button.dataset.schedulerPathPickerEntry)).toEqual(["/keep"]);
  });

  it("navigates into a directory, up, and back through the breadcrumb", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([["sub", "/data/sub"]]));
    await mountDialog({ initialPath: "/data" });
    entryButtons()[0]!.click();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/data/sub", "en");

    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([["sub", "/data/sub"]]));
    document.body.querySelector<HTMLElement>("[data-scheduler-path-picker-parent]")!.click();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/data", "en");

    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([]));
    document.body.querySelector<HTMLElement>('[data-scheduler-path-picker-crumb="/"]')!.click();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/", "en");
  });

  it("re-anchors to the parent when the start path is a file (resolved_path) and confirms the resolved directory", async () => {
    // Copy single-file mode: the field holds a file path; the plugin answers
    // from the parent directory and names it in `resolved_path`.
    mocks.invokePluginPathBrowse.mockResolvedValue({
      entries: [{ name: "sub", path: "/data/sub", is_dir: true }],
      resolved_path: "/data",
    });
    const { selected } = await mountDialog({ initialPath: "/data/report.pdf" });
    expect(mocks.invokePluginPathBrowse).toHaveBeenCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/data/report.pdf", "en");
    expect(document.body.querySelector("[data-scheduler-path-picker-redirect]")).not.toBeNull();
    expect(document.body.querySelector<HTMLElement>("[data-scheduler-path-picker-current]")!.textContent).toContain("data");
    expect(entryButtons().map((button) => button.dataset.schedulerPathPickerEntry)).toEqual(["/data/sub"]);
    document.body.querySelector<HTMLElement>("[data-scheduler-path-picker-choose]")!.click();
    await nextTick();
    expect(selected).toEqual(["/data"]);
  });

  it("jumps to a manually typed path on Enter and normalizes a missing leading slash", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([]));
    await mountDialog({ initialPath: "/data" });
    const input = document.body.querySelector<HTMLInputElement>("[data-scheduler-path-picker-input]")!;
    expect(input).not.toBeNull();

    input.value = "/elsewhere";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/elsewhere", "en");

    input.value = "relative";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/relative", "en");
  });

  it("shows the empty state for any directory without subdirectories", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([]));
    await mountDialog({ initialPath: "/data" });
    expect(document.body.querySelector("[data-scheduler-path-picker-empty]")?.textContent).toContain("No subdirectories here");
  });

  it("shows a failed browse inside the dialog with a working retry", async () => {
    mocks.invokePluginPathBrowse.mockRejectedValueOnce(new Error("connection is not connected"));
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([["sub", "/sub"]]));
    const { selected } = await mountDialog({});
    expect(document.body.querySelector("[data-scheduler-path-picker-error]")?.textContent).toContain("connection is not connected");
    expect(entryButtons()).toHaveLength(0);
    document.body.querySelector<HTMLElement>("[data-scheduler-path-picker-retry]")!.click();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(entryButtons().map((button) => button.dataset.schedulerPathPickerEntry)).toEqual(["/sub"]);
    expect(selected).toEqual([]);
  });

  it("confirms the current directory through select and closes", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([["sub", "/sub"]]));
    const { selected } = await mountDialog({ initialPath: "/data" });
    const root = pickerRoot();
    root.dispatchEvent(new CustomEvent("update:open", { detail: false }));
    document.body.querySelector<HTMLElement>("[data-scheduler-path-picker-choose]")!.click();
    await nextTick();
    expect(selected).toEqual(["/data"]);
  });

  it("disables browsing and explaining when no connection is resolved", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([]));
    await mountDialog({ connectionId: "" });
    expect(mocks.invokePluginPathBrowse).not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-scheduler-path-picker-needs-connection]")).not.toBeNull();
    expect(document.body.querySelector<HTMLElement>("[data-scheduler-path-picker-choose]")!.disabled).toBe(true);
  });
});
