// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { tauriRuntime, openMock } = vi.hoisted(() => ({ tauriRuntime: { value: false }, openMock: vi.fn() }));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => tauriRuntime.value }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));

import { PLUGIN_PICKER_MAX_BYTES, pickPluginFieldFile } from "./pluginFieldPicker";

/** Captures the hidden `<input type="file">` the browser path creates. */
function stubFileSelection(files: File[]) {
  const original = document.createElement.bind(document);
  const created: HTMLInputElement[] = [];
  const spy = vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const element = original(tag, options as never);
    if (tag === "input") {
      created.push(element as HTMLInputElement);
      setTimeout(() => {
        Object.defineProperty(element, "files", { value: files, configurable: true });
        element.dispatchEvent(new Event("change"));
      }, 0);
    }
    return element;
  }) as typeof document.createElement);
  return { created, restore: () => spy.mockRestore() };
}

beforeEach(() => {
  tauriRuntime.value = false;
  openMock.mockReset();
});

describe("pickPluginFieldFile", () => {
  it("returns the client path on desktop so the plugin can read the file itself", async () => {
    tauriRuntime.value = true;
    openMock.mockResolvedValue("/Users/dev/.ssh/id_rsa");

    const picked = await pickPluginFieldFile({ kind: "file", accept: [".pem", ".key"] });

    expect(picked).toEqual({ path: "/Users/dev/.ssh/id_rsa", name: "id_rsa" });
    expect(openMock).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      filters: [{ name: "Files", extensions: ["pem", "key"] }],
    });
  });

  it("offers a folder dialog for directory pickers and ignores a dismissal", async () => {
    tauriRuntime.value = true;
    openMock.mockResolvedValue(null);

    expect(await pickPluginFieldFile({ kind: "directory" })).toBeNull();
    expect(openMock).toHaveBeenCalledWith({ directory: true, multiple: false, filters: undefined });
  });

  it("reads the file content on browser hosts, which cannot hand over a path", async () => {
    const files = [new File(["-----BEGIN PRIVATE KEY-----\nkey\n"], "id_rsa", { type: "text/plain" })];
    const selection = stubFileSelection(files);
    try {
      const picked = await pickPluginFieldFile({ kind: "file", accept: [".pem", "text/plain"] });

      expect(picked).toEqual({ content: "-----BEGIN PRIVATE KEY-----\nkey\n", name: "id_rsa" });
      expect(selection.created[0]?.accept).toBe(".pem,text/plain");
      expect(selection.created[0]?.multiple).toBe(false);
    } finally {
      selection.restore();
    }
  });

  it("has no browser equivalent for a folder picker", async () => {
    expect(await pickPluginFieldFile({ kind: "directory" })).toBeNull();
  });

  it("rejects an oversized upload instead of loading it", async () => {
    const oversized = new File(["x"], "big.key", { type: "text/plain" });
    Object.defineProperty(oversized, "size", { value: PLUGIN_PICKER_MAX_BYTES + 1 });
    const selection = stubFileSelection([oversized]);
    try {
      await expect(pickPluginFieldFile({ kind: "file" })).rejects.toThrow(/larger than 1024 KiB/);
    } finally {
      selection.restore();
    }
  });
});
