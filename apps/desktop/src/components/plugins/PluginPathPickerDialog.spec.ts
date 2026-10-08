// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
  invokePluginPathBrowse: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  invokePluginPathBrowse: mocks.invokePluginPathBrowse,
}));

import PluginPathPickerDialog from "./PluginPathPickerDialog.vue";

const mountedApps: App[] = [];

interface MountOptions {
  pluginId?: string;
  action?: string;
  connectionId?: string;
  initialPath?: string;
  open?: boolean;
  title?: string;
}

async function mountDialog(options: MountOptions = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(PluginPathPickerDialog, {
    open: options.open ?? true,
    pluginId: options.pluginId ?? "io.dbx.files",
    action: options.action ?? "files/listDirs",
    connectionId: options.connectionId ?? "conn-src",
    initialPath: options.initialPath ?? "/",
    title: options.title,
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
  const root = document.body.querySelector<HTMLElement>("[data-plugin-path-picker]");
  expect(root).not.toBeNull();
  return root!;
}

function entryButtons(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>("[data-plugin-path-picker-entry]")];
}

async function settle() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

afterEach(() => {
  while (mountedApps.length) mountedApps.pop()?.unmount();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function dirsResult(entries: Array<[name: string, path: string]>, truncated = false) {
  return { entries: entries.map(([name, path]) => ({ name, path, is_dir: true })), truncated };
}

describe("PluginPathPickerDialog", () => {
  it("browses the initial path through the plugin method and lists directories", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(
      dirsResult([
        ["sub", "/sub"],
        ["deep", "/sub/deep"],
      ]),
    );
    await mountDialog({ initialPath: "/data" });
    expect(mocks.invokePluginPathBrowse).toHaveBeenCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/data", "en");
    // Name order, case-insensitively: "deep" leads even though it arrived last.
    expect(entryButtons().map((button) => button.dataset.pluginPathPickerEntry)).toEqual(["/sub/deep", "/sub"]);
  });

  it("non-directory rows are dropped defensively even if the plugin sends them", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue({
      entries: [
        { name: "keep", path: "/keep", is_dir: true },
        { name: "file.txt", path: "/file.txt", is_dir: false },
      ],
    });
    await mountDialog({});
    expect(entryButtons().map((button) => button.dataset.pluginPathPickerEntry)).toEqual(["/keep"]);
  });

  it("sorts entries by name, case-insensitively, like the files picker listing", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(
      dirsResult([
        ["beta", "/beta"],
        ["Alpha", "/alpha"],
        ["gamma", "/gamma"],
      ]),
    );
    await mountDialog({ initialPath: "/data" });
    expect(entryButtons().map((button) => button.textContent?.trim())).toEqual(["Alpha", "beta", "gamma"]);
  });

  it("enters a directory on double click, up through the parent button, and back through the breadcrumb", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([["sub", "/data/sub"]]));
    await mountDialog({ initialPath: "/data" });
    entryButtons()[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle();
    expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/data/sub", "en");

    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([["sub", "/data/sub"]]));
    document.body.querySelector<HTMLElement>("[data-plugin-path-picker-parent]")!.click();
    await settle();
    expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/data", "en");

    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([]));
    document.body.querySelector<HTMLElement>('[data-plugin-path-picker-crumb="/"]')!.click();
    await settle();
    expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/", "en");
  });

  it("enters a directory with the keyboard (Enter on the row)", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([["sub", "/data/sub"]]));
    await mountDialog({ initialPath: "/data" });
    entryButtons()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/data/sub", "en");
  });

  it("single click only highlights the row without navigating, and the footer confirms the highlighted directory", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([["sub", "/data/sub"]]));
    const { selected } = await mountDialog({ initialPath: "/data" });
    const row = entryButtons()[0]!;
    row.click();
    await nextTick();
    expect(mocks.invokePluginPathBrowse).toHaveBeenCalledTimes(1);
    expect(row.className).toContain("bg-accent");
    expect(row.getAttribute("aria-current")).toBe("true");

    document.body.querySelector<HTMLElement>("[data-plugin-path-picker-choose]")!.click();
    await nextTick();
    expect(selected).toEqual(["/data/sub"]);
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
    expect(document.body.querySelector("[data-plugin-path-picker-redirect]")).not.toBeNull();
    expect(document.body.querySelector<HTMLElement>("[data-plugin-path-picker-current]")!.textContent).toContain("data");
    expect(entryButtons().map((button) => button.dataset.pluginPathPickerEntry)).toEqual(["/data/sub"]);
    document.body.querySelector<HTMLElement>("[data-plugin-path-picker-choose]")!.click();
    await nextTick();
    expect(selected).toEqual(["/data"]);
  });

  it("jumps to a manually typed path on Enter and normalizes a missing leading slash", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([]));
    await mountDialog({ initialPath: "/data" });
    const input = document.body.querySelector<HTMLInputElement>("[data-plugin-path-picker-input]")!;
    expect(input).not.toBeNull();

    input.value = "/elsewhere";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/elsewhere", "en");

    input.value = "relative";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(mocks.invokePluginPathBrowse).toHaveBeenLastCalledWith("io.dbx.files", "files/listDirs", "conn-src", "/relative", "en");
  });

  it("shows the empty state for any directory without subdirectories", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([]));
    await mountDialog({ initialPath: "/data" });
    expect(document.body.querySelector("[data-plugin-path-picker-empty]")?.textContent).toContain("No subdirectories here");
  });

  it("shows a failed browse inside the dialog with a working retry", async () => {
    mocks.invokePluginPathBrowse.mockRejectedValueOnce(new Error("connection is not connected"));
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([["sub", "/sub"]]));
    const { selected } = await mountDialog({});
    expect(document.body.querySelector("[data-plugin-path-picker-error]")?.textContent).toContain("connection is not connected");
    expect(entryButtons()).toHaveLength(0);
    document.body.querySelector<HTMLElement>("[data-plugin-path-picker-retry]")!.click();
    await settle();
    expect(entryButtons().map((button) => button.dataset.pluginPathPickerEntry)).toEqual(["/sub"]);
    expect(selected).toEqual([]);
  });

  it("confirms the current directory through select and closes", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([["sub", "/sub"]]));
    const { selected } = await mountDialog({ initialPath: "/data" });
    const root = pickerRoot();
    root.dispatchEvent(new CustomEvent("update:open", { detail: false }));
    document.body.querySelector<HTMLElement>("[data-plugin-path-picker-choose]")!.click();
    await nextTick();
    expect(selected).toEqual(["/data"]);
  });

  it("disables browsing and explaining when no connection is resolved", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([]));
    await mountDialog({ connectionId: "" });
    expect(mocks.invokePluginPathBrowse).not.toHaveBeenCalled();
    expect(document.body.querySelector("[data-plugin-path-picker-needs-connection]")).not.toBeNull();
    expect(document.body.querySelector<HTMLButtonElement>("[data-plugin-path-picker-choose]")!.disabled).toBe(true);
  });

  it("lets the embedding surface override the dialog title", async () => {
    mocks.invokePluginPathBrowse.mockResolvedValue(dirsResult([]));
    await mountDialog({ title: "Pick the backup directory" });
    expect(document.body.textContent).toContain("Pick the backup directory");
  });
});
