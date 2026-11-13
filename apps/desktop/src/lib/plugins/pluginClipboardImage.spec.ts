// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { canWritePluginClipboardImage, MAX_PLUGIN_CLIPBOARD_IMAGE_BASE64, MAX_PLUGIN_CLIPBOARD_IMAGE_BYTES, requirePluginClipboardImage, writePluginClipboardImage } from "./pluginClipboardImage";
import { PluginHostBridge, pluginSdkSource } from "./pluginHostBridge";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";

const runtime = vi.hoisted(() => ({ native: false }));
const writeImage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => runtime.native }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeImage }));
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
const png = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
const options = { contentType: "image/png", dataBase64: pngBase64 };

afterEach(() => {
  runtime.native = false;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("plugin PNG clipboard", () => {
  it("accepts base64 and transferred bytes without trusting supplied dimensions", () => {
    expect(requirePluginClipboardImage({ ...options, width: 999999, height: 999999 })).toEqual(png);
    expect(requirePluginClipboardImage({ contentType: "image/png" }, png.slice().buffer)).toEqual(png);
  });

  it.each([null, {}, { contentType: "image/jpeg", dataBase64: pngBase64 }, { ...options, dataBase64: "data:image/png;base64," + pngBase64 }, { ...options, dataBase64: "AQI" }, { ...options, dataBase64: "!!!!" }, { ...options, dataBase64: "AQID" }, { ...options, dataBase64: "" }])(
    "rejects malformed or non-PNG input before writing (%j)",
    (input) => {
      expect(() => requirePluginClipboardImage(input)).toThrow();
    },
  );

  it("bounds encoded bytes before decoding", () => {
    expect(() => requirePluginClipboardImage({ ...options, dataBase64: "A".repeat(MAX_PLUGIN_CLIPBOARD_IMAGE_BASE64 + 4) })).toThrow(/18 MiB/);
    expect(() => requirePluginClipboardImage(options, new ArrayBuffer(MAX_PLUGIN_CLIPBOARD_IMAGE_BYTES + 1))).toThrow(/18 MiB/);
  });

  it.each([
    [0, 1],
    [1, 0],
    [0xffffffff, 0xffffffff],
    [4097, 4096],
  ])("rejects unsafe actual PNG dimensions %i x %i", (width, height) => {
    const bytes = png.slice();
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    expect(() => requirePluginClipboardImage(options, bytes.buffer)).toThrow(/megapixel/);
  });

  it("writes PNG bytes with the native plugin and propagates native errors", async () => {
    runtime.native = true;
    expect(canWritePluginClipboardImage()).toBe(true);
    await writePluginClipboardImage(png);
    expect(writeImage).toHaveBeenCalledWith(png);
    writeImage.mockRejectedValueOnce(new Error("clipboard busy"));
    await expect(writePluginClipboardImage(png)).rejects.toThrow("clipboard busy");
  });

  it("uses the browser image clipboard and propagates browser denial", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    class Item {
      constructor(public entries: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", Item);
    vi.stubGlobal("navigator", { clipboard: { write } });
    expect(canWritePluginClipboardImage()).toBe(true);
    await writePluginClipboardImage(png);
    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0][0][0] as Item;
    expect(item.entries["image/png"].type).toBe("image/png");
    expect(new Uint8Array(await item.entries["image/png"].arrayBuffer())).toEqual(png);
    write.mockRejectedValueOnce(new Error("NotAllowedError"));
    await expect(writePluginClipboardImage(png)).rejects.toThrow("NotAllowedError");
    expect(writeImage).not.toHaveBeenCalled();
  });

  it("does not advertise unsupported browser image writes", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", {});
    expect(canWritePluginClipboardImage()).toBe(false);
    await expect(writePluginClipboardImage(png)).rejects.toThrow(/unavailable/);
  });
});

describe("image host protocol and injected SDK", () => {
  const contribution: PluginWorkbenchContribution = { type: "workbench", id: "sample.main", label: "Sample" };
  const plugin: InstalledPlugin = { manifest: { id: "sample", name: "Sample", version: "1.0.0", permissions: [], drivers: [], contributions: [contribution] }, compatibility: { compatible: true } };
  function harness(copyImage?: (id: string, data: Uint8Array) => Promise<void>) {
    const messages: any[] = [];
    const target = { postMessage: (data: unknown) => messages.push(data) } as unknown as Window;
    const bridge = new PluginHostBridge(plugin, contribution, {}, () => target, { invoke: vi.fn(), notify: vi.fn(), sendBinary: vi.fn(), readAsset: vi.fn(), copyImage });
    const send = (params: unknown, data?: ArrayBuffer) => bridge.handleWindowMessage({ source: target, data: { source: "dbx-plugin", version: 1, type: "request", method: "host.copyImage", id: "image", params, data, pluginId: "forged" } } as MessageEvent);
    return { bridge, messages, target, send };
  }

  it("advertises and writes for the bridge owner without requiring clipboard read permission", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    const h = harness(copy);
    h.bridge.sendInit();
    expect(h.messages[0].capabilities.clipboardImageWrite).toBe(true);
    expect(h.messages[0].capabilities.clipboardImageRead).toBe(false);
    h.send(options);
    await vi.waitFor(() => expect(h.messages).toHaveLength(2));
    expect(copy).toHaveBeenCalledWith("sample", png);
    expect(h.messages[1]).toMatchObject({ id: "image", result: { success: true } });
  });

  it("accepts image base64 over the generic 2 MiB request cap but caps other metadata", async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024);
    bytes.set(png);
    const copy = vi.fn().mockResolvedValue(undefined);
    const h = harness(copy);
    const encoded = btoa(String.fromCharCode(...bytes.slice(0, 33))) + "A".repeat(((bytes.length - 33) * 4) / 3);
    // A valid base64 payload larger than the generic metadata cap.
    h.send({ contentType: "image/png", dataBase64: encoded + "=".repeat((4 - (encoded.length % 4)) % 4) });
    await vi.waitFor(() => expect(h.messages).toHaveLength(1));
    expect(copy).toHaveBeenCalledTimes(1);
    h.send({ ...options, extra: "x".repeat(2 * 1024 * 1024 + 1) });
    await vi.waitFor(() => expect(h.messages).toHaveLength(2));
    expect(h.messages[1].error).toMatch(/too large/);
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it("reports unsupported hosts, invalid PNGs and host failures without a success acknowledgement", async () => {
    const old = harness();
    old.bridge.sendInit();
    old.send(options);
    await vi.waitFor(() => expect(old.messages).toHaveLength(2));
    expect(old.messages[0].capabilities.clipboardImageWrite).toBe(false);
    expect(old.messages[1].error).toMatch(/unavailable/);
    const copy = vi.fn().mockRejectedValue(new Error("native error"));
    const h = harness(copy);
    h.send({ ...options, dataBase64: "AQID" });
    await vi.waitFor(() => expect(h.messages).toHaveLength(1));
    expect(copy).not.toHaveBeenCalled();
    h.send({ contentType: "image/png" }, png.slice().buffer);
    await vi.waitFor(() => expect(h.messages).toHaveLength(2));
    expect(h.messages[1]).toMatchObject({ error: "native error" });
    expect(h.messages[1]).not.toHaveProperty("result");
  });

  it("injected SDK transfers only a typed array slice and resolves the host response", async () => {
    const posted: any[] = [];
    const parent = { postMessage: (...args: unknown[]) => posted.push(args) };
    const sdkWindow: Record<string, any> = {
      addEventListener: (type: string, listener: unknown) => {
        sdkWindow[type] = listener;
      },
    };
    new Function("window", "parent", "document", "addEventListener", pluginSdkSource())(sdkWindow, parent, document, sdkWindow.addEventListener);
    const backing = new Uint8Array(png.length + 20);
    backing.set(png, 10);
    const view = backing.subarray(10, 10 + png.length);
    const promise = sdkWindow.dbxPlugin.copyImage({ contentType: "image/png" }, view);
    const [request, , transfers] = posted.find(([message]) => message.method === "host.copyImage");
    expect(new Uint8Array(request.data)).toEqual(png);
    expect(transfers).toEqual([request.data]);
    expect(backing.byteLength).toBe(png.length + 20);
    sdkWindow.message({ source: parent, data: { source: "dbx-host", version: 1, type: "response", id: request.id, result: { success: true } } });
    await expect(promise).resolves.toEqual({ success: true });
  });
});
