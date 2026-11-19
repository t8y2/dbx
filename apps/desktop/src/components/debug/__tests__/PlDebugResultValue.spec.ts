// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlDebugResultValue from "../PlDebugResultValue.vue";
import PlDebugOutcomePanel from "../PlDebugOutcomePanel.vue";
import en from "@/i18n/locales/en";
import type { PlDebugResultReference } from "@/lib/backend/pl-debug-tauri";

const mocks = vi.hoisted(() => ({ read: vi.fn(), download: vi.fn(), copy: vi.fn(), store: { status: null as Record<string, unknown> | null, sessionRef: null, publicSnapshot: null } }));
vi.mock("@/lib/backend/api", () => ({ plDebugRead: mocks.read }));
vi.mock("@/lib/dataGrid/binaryCellDownload", () => ({ downloadBinaryCellPayload: mocks.download }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: mocks.copy }));
vi.mock("@/stores/plDebugStore", () => ({ usePlDebugStore: () => mocks.store }));
const session = { serverEpoch: "epoch", sessionId: "session", connectionId: "conn", clientSessionId: "client" };
const source: PlDebugResultReference = { generation: "cache-generation", resultId: "cache-result", encoding: "utf16", length: 6, lengthUnit: "utf16", complete: true, truncated: false, state: "available" };
const apps: App[] = [];
function i18n() {
  return createI18n({ legacy: false, locale: "en", messages: { en } });
}
function render(result: PlDebugResultReference = source) {
  const props = reactive({ result, session, generation: 1, name: "payload" });
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp({ setup: () => () => h(PlDebugResultValue, props) });
  app.use(i18n()).mount(root);
  apps.push(app);
  return { root, props };
}
function page(offset: number, nextOffset: number, data: string, result = source) {
  return { ...result, offset, nextOffset, eof: nextOffset === result.length, data };
}
function button(root: HTMLElement, text: string) {
  const found = [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
  expect(found, text).toBeDefined();
  return found!;
}
async function click(view: ReturnType<typeof render>, text: string) {
  button(view.root, text).click();
  await nextTick();
  await vi.waitFor(() => expect(view.root.querySelector('[role="status"]')).toBeNull());
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockReset();
  mocks.store.status = null;
  mocks.download.mockResolvedValue({ kind: "saved" });
  mocks.copy.mockResolvedValue(undefined);
});
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.replaceChildren();
});

describe("retained debugger result viewer", () => {
  it("uses exact result identity and cached previous pages, preserving Unicode", async () => {
    mocks.read.mockResolvedValueOnce(page(0, 1, "a")).mockResolvedValueOnce(page(1, 6, "😀xyz"));
    const view = render();
    expect(mocks.read).not.toHaveBeenCalled();
    await click(view, "View result");
    expect(view.root.querySelector("pre")?.textContent).toBe("a");
    await click(view, "Next page");
    expect(view.root.querySelector("pre")?.textContent).toBe("😀xyz");
    await click(view, "Previous page");
    expect(view.root.querySelector("pre")?.textContent).toBe("a");
    await click(view, "Copy this page");
    expect(mocks.copy).toHaveBeenCalledWith("a");
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.read.mock.calls[0]![0]).toEqual({ ...session, generation: 1, kind: "result_page", params: { generation: source.generation, resultId: source.resultId, offset: 0, limit: 32000 } });
  });

  it("keeps a confirmed page after a failed next page and retries only when requested", async () => {
    mocks.read
      .mockResolvedValueOnce(page(0, 1, "a"))
      .mockRejectedValueOnce(new Error("Missing retained page"))
      .mockResolvedValueOnce(page(1, 6, "😀xyz"));
    const view = render();
    await click(view, "View result");
    await click(view, "Next page");
    expect(view.root.querySelector("pre")?.textContent).toBe("a");
    expect(view.root.querySelector('[role="alert"]')?.textContent).toContain("Missing retained page");
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await click(view, "Next page");
    expect(view.root.querySelector("pre")?.textContent).toBe("😀xyz");
    expect(view.root.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([true, false])("exports binary pages as bytes with an explicit complete=%s filename", async (complete) => {
    const result: PlDebugResultReference = { ...source, encoding: "base64", lengthUnit: "bytes", length: 4, complete, truncated: !complete, state: complete ? "available" : "partial" };
    mocks.read.mockResolvedValueOnce(page(0, 2, "AAE=", result)).mockResolvedValueOnce(page(2, 4, "Av8=", result));
    const view = render(result);
    await click(view, complete ? "Save result" : "Save available prefix");
    expect(mocks.download).toHaveBeenCalledTimes(1);
    const [payload, filename] = mocks.download.mock.calls[0]!;
    expect(Array.from(payload.data)).toEqual([0, 1, 2, 255]);
    expect(filename).toBe(complete ? "payload.bin" : "payload.partial.bin");
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("never saves a failed export as a complete file and retains its readable prefix", async () => {
    mocks.read.mockResolvedValueOnce(page(0, 1, "a")).mockRejectedValueOnce(new Error("Second page unavailable"));
    const view = render();
    await click(view, "Save result");
    expect(mocks.download).not.toHaveBeenCalled();
    await click(view, "View result");
    expect(view.root.querySelector("pre")?.textContent).toBe("a");
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("discards late pages when the original result context changes", async () => {
    let resolve!: (value: unknown) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render();
    button(view.root, "View result").click();
    await nextTick();
    const next: PlDebugResultReference = { ...source, generation: "next-cache", resultId: "next-result", length: 1 };
    Object.assign(view.props, { generation: 2, result: next });
    await nextTick();
    resolve(page(0, 1, "a"));
    await nextTick();
    expect(view.root.querySelector("pre")).toBeNull();
    mocks.read.mockResolvedValueOnce(page(0, 1, "n", next));
    await click(view, "View result");
    expect(view.root.querySelector("pre")?.textContent).toBe("n");
    expect(mocks.read.mock.calls[1]![0].generation).toBe(2);
  });

  it.each(["identity", "completeness"])("rejects contradictory %s without replacing confirmed data", async (field) => {
    mocks.read.mockResolvedValueOnce(page(0, 1, "a")).mockResolvedValueOnce({ ...page(1, 6, "😀xyz"), ...(field === "identity" ? { resultId: "wrong-result" } : { complete: false }) });
    const view = render();
    await click(view, "View result");
    await click(view, "Next page");
    expect(view.root.querySelector("pre")?.textContent).toBe("a");
    expect(view.root.querySelector('[role="alert"]')?.textContent).toContain("original identity");
  });

  it("cancels only the cached export and preserves the confirmed page", async () => {
    let resolve!: (value: unknown) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render();
    button(view.root, "Save result").click();
    await nextTick();
    button(view.root, "Cancel").click();
    resolve(page(0, 1, "a"));
    await vi.waitFor(() => expect(view.root.querySelector('[role="status"]')).toBeNull());
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await click(view, "View result");
    expect(view.root.querySelector("pre")?.textContent).toBe("a");
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("distinguishes SQL NULL, empty strings and unavailable output fields", () => {
    mocks.store.status = {
      outParams: [
        { name: "N", mode: "OUT", type: "NUMBER", value: null, state: "null" },
        { name: "E", mode: "OUT", type: "VARCHAR2", value: "", state: "empty" },
        { name: "U", mode: "OUT", type: "NUMBER", value: null, state: "unavailable" },
      ],
    };
    const root = document.createElement("div");
    document.body.append(root);
    const app = createApp(PlDebugOutcomePanel);
    app.use(i18n()).mount(root);
    apps.push(app);
    const rows = root.querySelectorAll("tbody tr");
    expect(rows[0]!.textContent).toContain("SQL NULL");
    expect(rows[1]!.textContent).toContain(en.plDebug.variables.emptyString);
    expect(rows[2]!.textContent).toContain(en.plDebug.variables.unread);
    expect(rows[2]!.textContent).not.toContain("SQL NULL");
  });
});
