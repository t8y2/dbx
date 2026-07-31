// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";

const backend = vi.hoisted(() => ({
  etcdSupportsTtl: vi.fn(),
  etcdListPrefix: vi.fn(),
  etcdGet: vi.fn(),
  etcdPut: vi.fn(),
  etcdDelete: vi.fn(),
  etcdRename: vi.fn(),
  etcdHistory: vi.fn(),
  etcdGetCalls: [] as unknown[][],
  capturedKvBrowserApi: null as any,
  selectKeyCalls: [] as unknown[],
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  etcdListPrefix: backend.etcdListPrefix,
  etcdGet: backend.etcdGet,
  etcdPut: backend.etcdPut,
  etcdDelete: backend.etcdDelete,
  etcdRename: backend.etcdRename,
  etcdHistory: backend.etcdHistory,
  etcdSupportsTtl: backend.etcdSupportsTtl,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [],
    getConfig: () => undefined,
  }),
}));

vi.mock("@/components/kv/KvKeyBrowser.vue", () => ({
  default: defineComponent({
    name: "KvKeyBrowserStub",
    inheritAttrs: false,
    props: {
      api: { type: Object, required: true },
      connectionId: { type: String, required: true },
      supportsTtl: { type: Boolean, default: false },
      ttlCapabilityKnown: { type: Boolean, default: true },
    },
    emits: ["refreshRequested"],
    setup(props, { emit, expose }) {
      backend.capturedKvBrowserApi = props.api;
      expose({
        focusSearch: () => true,
        selectKey: (route: unknown) => {
          backend.selectKeyCalls.push(route);
          return Promise.resolve();
        },
        refresh: () => {
          emit("refreshRequested");
          return true;
        },
      });
      return () =>
        h(
          "button",
          {
            id: "kv-browser-stub",
            "data-supports-ttl": String(props.supportsTtl),
            "data-capability-known": String(props.ttlCapabilityKnown),
            onClick: () => emit("refreshRequested"),
          },
          "refresh",
        );
    },
  }),
}));

import EtcdKeyBrowser from "@/components/etcd/EtcdKeyBrowser.vue";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

async function mountBrowser() {
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(EtcdKeyBrowser, { connectionId: "etcd-1" });
  app.mount(root);
  await flushUi();
  return root.querySelector<HTMLButtonElement>("#kv-browser-stub")!;
}

beforeEach(() => {
  vi.useFakeTimers();
  backend.etcdSupportsTtl.mockReset();
  backend.etcdListPrefix.mockReset();
  backend.etcdGet.mockReset();
  backend.etcdPut.mockReset();
  backend.etcdDelete.mockReset();
  backend.etcdRename.mockReset();
  backend.etcdHistory.mockReset();
  backend.etcdListPrefix.mockResolvedValue({ keys: [], continuation: null, revision: "1" });
  backend.etcdGetCalls.length = 0;
  backend.capturedKvBrowserApi = null;
  backend.selectKeyCalls.length = 0;
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
  vi.useRealTimers();
});

describe("EtcdKeyBrowser TTL capability recovery", () => {
  it("keeps a transient probe failure unknown and retries automatically", async () => {
    backend.etcdSupportsTtl.mockRejectedValueOnce(new Error("Agent is reconnecting")).mockResolvedValue(true);

    const browser = await mountBrowser();
    expect(browser.dataset.supportsTtl).toBe("false");
    expect(browser.dataset.capabilityKnown).toBe("false");

    await vi.advanceTimersByTimeAsync(5000);
    await flushUi();

    expect(backend.etcdSupportsTtl).toHaveBeenCalledTimes(2);
    expect(browser.dataset.supportsTtl).toBe("true");
    expect(browser.dataset.capabilityKnown).toBe("true");
  });

  it("rechecks a confirmed unsupported Agent when the user refreshes", async () => {
    backend.etcdSupportsTtl.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const browser = await mountBrowser();
    expect(browser.dataset.supportsTtl).toBe("false");
    expect(browser.dataset.capabilityKnown).toBe("true");

    browser.click();
    await flushUi();

    expect(backend.etcdSupportsTtl).toHaveBeenCalledTimes(2);
    expect(browser.dataset.supportsTtl).toBe("true");
    expect(browser.dataset.capabilityKnown).toBe("true");
  });

  it("keeps the last confirmed capability through a transient later failure", async () => {
    backend.etcdSupportsTtl.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("temporary failure"));

    const browser = await mountBrowser();
    expect(browser.dataset.supportsTtl).toBe("true");
    expect(browser.dataset.capabilityKnown).toBe("true");

    await vi.advanceTimersByTimeAsync(5000);
    await flushUi();

    expect(backend.etcdSupportsTtl).toHaveBeenCalledTimes(2);
    expect(browser.dataset.supportsTtl).toBe("true");
    expect(browser.dataset.capabilityKnown).toBe("true");
  });
});

describe("EtcdKeyBrowser global search", () => {
  it("clears results and counters while retaining the search form", async () => {
    backend.etcdListPrefix.mockResolvedValue({
      keys: [
        {
          key: "/test/config",
          keyBytes: { encoding: "utf8", data: "/test/config" },
          value: { encoding: "utf8", data: "matched value" },
          modRevision: "8",
        },
      ],
      continuation: null,
      revision: "8",
    });

    await mountBrowser();
    const openSearch = [...root!.querySelectorAll("button")].find((button) => button.textContent?.includes("etcd.globalSearch"));
    openSearch?.click();
    await flushUi();

    const input = root!.querySelector<HTMLInputElement>('input[placeholder="etcd.searchPlaceholder"]')!;
    input.value = "matched";
    input.dispatchEvent(new Event("input"));
    await flushUi();
    const submit = [...root!.querySelectorAll("button")].filter((button) => button.textContent?.includes("etcd.globalSearch")).at(-1);
    submit?.click();
    await flushUi();

    expect(root!.textContent).toContain("/test/config");
    const clear = [...root!.querySelectorAll("button")].find((button) => button.textContent?.includes("etcd.clearSearchResults"));
    expect(clear).toBeTruthy();
    clear?.click();
    await flushUi();

    expect(root!.textContent).not.toContain("/test/config");
    expect(root!.textContent).toContain("已扫描 0 个 Key");
    expect(input.value).toBe("matched");
    expect([...root!.querySelectorAll("button")].some((button) => button.textContent?.includes("etcd.clearSearchResults"))).toBe(false);
  });
});

describe("EtcdKeyBrowser byte-identity routing", () => {
  it("keeps colliding display keys on distinct keyBytes routes", async () => {
    backend.etcdListPrefix.mockResolvedValue({
      keys: [
        {
          key: "/w==",
          keyBytes: { encoding: "base64", data: "/w==" },
          value: { encoding: "utf8", data: "binary" },
          modRevision: "1",
        },
        {
          key: "[base64:/w==]",
          keyBytes: { encoding: "utf8", data: "[base64:/w==]" },
          value: { encoding: "utf8", data: "utf8" },
          modRevision: "2",
        },
      ],
      continuation: null,
      revision: "7",
    });
    backend.etcdGet.mockImplementation(async (_connectionId, key, options) => ({
      found: true,
      key,
      keyBytes: options?.keyBytes ?? null,
      value: { encoding: "utf8", data: "value" },
      metadata: { modRevision: "9" },
    }));
    backend.etcdPut.mockResolvedValue({ revision: 10, key: "[base64:/w==]" });
    backend.etcdDelete.mockResolvedValue({ deleted: 1 });
    backend.etcdRename.mockResolvedValue({ renamed: true, revision: "11" });
    backend.etcdHistory.mockResolvedValue({ events: [] });

    await mountBrowser();
    expect(backend.capturedKvBrowserApi).toBeTruthy();

    const { keys } = await backend.capturedKvBrowserApi.listPrefix("etcd-1", "", 20);
    expect(keys).toHaveLength(2);
    const [binaryKey, utf8Key] = keys;
    expect(binaryKey.key).toBe("[base64:/w==]");
    expect(utf8Key.key).toBe("[base64:/w==]");
    expect(binaryKey.keyIdentity).not.toBe(utf8Key.keyIdentity);

    await backend.capturedKvBrowserApi.get("etcd-1", binaryKey.key, { keyBytes: binaryKey.keyBytes });
    await backend.capturedKvBrowserApi.put("etcd-1", binaryKey.key, { encoding: "utf8", data: "x" }, { keyBytes: binaryKey.keyBytes });
    await backend.capturedKvBrowserApi.deleteKey("etcd-1", utf8Key.key, { keyBytes: utf8Key.keyBytes });
    await backend.capturedKvBrowserApi.rename?.("etcd-1", { key: binaryKey.key, keyBytes: binaryKey.keyBytes, newKey: "renamed", expectedModRevision: "9" });
    await backend.capturedKvBrowserApi.history?.("etcd-1", { key: utf8Key.key, keyBytes: utf8Key.keyBytes, limit: 10 });
    await backend.capturedKvBrowserApi.exportScope?.("etcd-1", { path: binaryKey.key, kind: "key", keyBytes: binaryKey.keyBytes });

    expect(backend.etcdGet).toHaveBeenCalledWith("etcd-1", "[base64:/w==]", expect.objectContaining({ keyBytes: binaryKey.keyBytes }));
    expect(backend.etcdPut).toHaveBeenCalledWith("etcd-1", "[base64:/w==]", { encoding: "utf8", data: "x" }, expect.objectContaining({ keyBytes: binaryKey.keyBytes }));
    expect(backend.etcdDelete).toHaveBeenCalledWith("etcd-1", "[base64:/w==]", expect.objectContaining({ keyBytes: utf8Key.keyBytes }));
    expect(backend.etcdRename).toHaveBeenCalledWith("etcd-1", expect.objectContaining({ key: "[base64:/w==]", keyBytes: binaryKey.keyBytes }));
    expect(backend.etcdHistory).toHaveBeenCalledWith("etcd-1", expect.objectContaining({ key: "[base64:/w==]", keyBytes: utf8Key.keyBytes }));
    expect(backend.etcdGet.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({ keyBytes: binaryKey.keyBytes }));
  });

  it("opens search results with the selected keyBytes", async () => {
    backend.etcdListPrefix.mockResolvedValue({
      keys: [
        {
          key: "/w==",
          keyBytes: { encoding: "base64", data: "/w==" },
          value: { encoding: "utf8", data: "match" },
          modRevision: "1",
        },
        {
          key: "[base64:/w==]",
          keyBytes: { encoding: "utf8", data: "[base64:/w==]" },
          value: { encoding: "utf8", data: "match" },
          modRevision: "2",
        },
      ],
      continuation: null,
      revision: "7",
    });

    const root = document.createElement("div");
    document.body.appendChild(root);
    const app = createApp(EtcdKeyBrowser, { connectionId: "etcd-1" });
    app.mount(root);
    await flushUi();

    const searchButton = [...root.querySelectorAll("button")].find((button) => button.textContent?.includes("etcd.globalSearch")) as HTMLButtonElement | undefined;
    expect(searchButton).toBeTruthy();
    searchButton!.click();
    await flushUi();

    const input = root.querySelector('input[placeholder="etcd.searchPlaceholder"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    input.value = "match";
    input.dispatchEvent(new Event("input"));
    await flushUi();

    const searchSubmit = [...root.querySelectorAll("button")].filter((button) => button.textContent?.includes("etcd.globalSearch")).at(-1) as HTMLButtonElement | undefined;
    searchSubmit?.click();
    await flushUi();

    const resultButtons = [...root.querySelectorAll("button")].filter((button) => button.textContent?.includes("[base64:/w==]"));
    expect(resultButtons).toHaveLength(2);
    resultButtons[0].click();
    resultButtons[1].click();
    await flushUi();

    expect(backend.selectKeyCalls).toHaveLength(2);
    expect(backend.selectKeyCalls[0]).toEqual(expect.objectContaining({ keyBytes: { encoding: "base64", data: "/w==" } }));
    expect(backend.selectKeyCalls[1]).toEqual(expect.objectContaining({ keyBytes: { encoding: "utf8", data: "[base64:/w==]" } }));
    app.unmount();
    root.remove();
  });
});
