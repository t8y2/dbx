// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginFilesystemProviderContribution } from "@/types/database";

const api = vi.hoisted(() => ({
  listPluginFilesystemEntries: vi.fn(),
  readPluginFilesystemFile: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => api);
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    inheritAttrs: false,
    props: { items: { type: Array, default: () => [] } },
    setup(props, { attrs, slots }) {
      return () =>
        h(
          "div",
          attrs,
          (props.items as unknown[]).flatMap((item) => slots.default?.({ item }) ?? []),
        );
    },
  }),
}));

import PluginFileManager from "./PluginFileManager.vue";

const SPLIT_SIZE_KEY = "dbx-plugin-file-manager-split-size";
const provider: PluginFilesystemProviderContribution = {
  type: "filesystem-provider",
  id: "ftp.files",
  label: "FTP files",
  schemes: ["ftp"],
  root_uri: "ftp:/",
  capabilities: ["read"],
};

let app: App<Element> | undefined;
let root: HTMLDivElement;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function mountFileManager() {
  root = document.createElement("div");
  root.style.width = "300px";
  document.body.appendChild(root);
  app = createApp(PluginFileManager, { pluginId: "io.dbx.ftp", provider, connectionId: "ftp-connection" });
  app.mount(root);
  await flushUi();
  return root;
}

function pointer(target: EventTarget, type: string, clientX: number) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.listPluginFilesystemEntries.mockResolvedValue({
    entries: [{ name: "release-notes.txt", uri: "ftp:/release-notes.txt", kind: "file", size: 2048, modifiedAt: "2026-09-27T10:11:12Z", contentType: "text/plain" }],
  });
  api.readPluginFilesystemFile.mockResolvedValue({ dataBase64: btoa("preview contents"), contentType: "text/plain", truncated: false });
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.replaceChildren();
  document.body.classList.remove("dbx-is-resizing");
});

describe("PluginFileManager", () => {
  it("keeps a narrow list inside its pane without the legacy 28rem minimum", async () => {
    const container = await mountFileManager();
    const panes = container.querySelector<HTMLElement>("[data-file-manager-panes]")!;
    const list = container.querySelector<HTMLElement>("[data-file-list]")!;
    const row = container.querySelector<HTMLElement>("[data-file-entry-uri]")!;
    const separator = container.querySelector<HTMLElement>("[data-file-preview-resize]")!;

    expect(panes.classList).toContain("min-w-0");
    expect(panes.classList).toContain("overflow-hidden");
    expect(list.classList).toContain("min-w-0");
    expect(list.className).not.toContain("min-w-[28rem]");
    expect(row.classList).toContain("min-w-0");
    expect(separator.getAttribute("role")).toBe("separator");
    expect(separator.getAttribute("aria-valuenow")).toBe("42");
    expect(panes.style.gridTemplateColumns).toContain("42fr");
  });

  it("resizes with pointer and keyboard input, clamps, and restores the persisted split", async () => {
    let container = await mountFileManager();
    let panes = container.querySelector<HTMLElement>("[data-file-manager-panes]")!;
    let separator = container.querySelector<HTMLElement>("[data-file-preview-resize]")!;
    vi.spyOn(panes, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
    vi.spyOn(separator, "getBoundingClientRect").mockReturnValue({ width: 6 } as DOMRect);

    pointer(separator, "pointerdown", 420);
    pointer(window, "pointermove", 1200);
    await nextTick();
    expect(separator.getAttribute("aria-valuenow")).toBe("80");
    expect(document.body.classList).toContain("dbx-is-resizing");
    pointer(window, "pointerup", 1200);
    await nextTick();
    expect(localStorage.getItem(SPLIT_SIZE_KEY)).toBe("80");
    expect(document.body.classList).not.toContain("dbx-is-resizing");

    separator.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }));
    expect(separator.getAttribute("aria-valuenow")).toBe("80");
    separator.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home" }));
    await nextTick();
    expect(separator.getAttribute("aria-valuenow")).toBe("20");
    separator.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowLeft" }));
    expect(separator.getAttribute("aria-valuenow")).toBe("20");
    expect(localStorage.getItem(SPLIT_SIZE_KEY)).toBe("20");

    app!.unmount();
    app = undefined;
    root.remove();
    container = await mountFileManager();
    panes = container.querySelector<HTMLElement>("[data-file-manager-panes]")!;
    separator = container.querySelector<HTMLElement>("[data-file-preview-resize]")!;
    expect(separator.getAttribute("aria-valuenow")).toBe("20");
    expect(panes.style.gridTemplateColumns).toContain("20fr");

    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await nextTick();
    expect(separator.getAttribute("aria-valuenow")).toBe("42");
    expect(localStorage.getItem(SPLIT_SIZE_KEY)).toBeNull();
  });

  it("preserves file selection and bounded text preview behavior", async () => {
    const container = await mountFileManager();
    const row = container.querySelector<HTMLElement>('[data-file-entry-uri="ftp:/release-notes.txt"]')!;

    row.click();
    await nextTick();
    expect(container.textContent).toContain("release-notes.txt");
    expect(container.textContent).toContain("pluginPlatform.previewSelectedFileHint");

    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flushUi();
    expect(api.readPluginFilesystemFile).toHaveBeenCalledWith("io.dbx.ftp", "ftp.files", "ftp:/release-notes.txt", { connectionId: "ftp-connection", maxBytes: 256 * 1024 });
    expect(container.textContent).toContain("preview contents");
    expect(api.listPluginFilesystemEntries).toHaveBeenCalledWith("io.dbx.ftp", "ftp.files", expect.objectContaining({ connectionId: "ftp-connection", uri: "ftp:/", limit: 200 }));
  });
});
