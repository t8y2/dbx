// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, type App } from "vue";

const backend = vi.hoisted(() => ({
  etcdSupportsTtl: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  etcdListPrefix: vi.fn(),
  etcdGet: vi.fn(),
  etcdPut: vi.fn(),
  etcdDelete: vi.fn(),
  etcdSupportsTtl: backend.etcdSupportsTtl,
}));

vi.mock("@/components/kv/KvKeyBrowser.vue", () => ({
  default: defineComponent({
    name: "KvKeyBrowserStub",
    props: {
      supportsTtl: { type: Boolean, default: false },
      ttlCapabilityKnown: { type: Boolean, default: true },
    },
    emits: ["refreshRequested"],
    setup(props, { emit, expose }) {
      expose({
        focusSearch: () => true,
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
