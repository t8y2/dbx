// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, type App } from "vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  zookeeperListPrefix: vi.fn(),
  zookeeperGet: vi.fn(),
  zookeeperPut: vi.fn(),
  zookeeperDelete: vi.fn(),
}));

vi.mock("@/components/kv/KvKeyBrowser.vue", () => ({
  default: defineComponent({
    name: "KvKeyBrowserStub",
    props: {
      enableBase64Utf8Preview: { type: Boolean, default: false },
      labels: { type: Object, required: true },
    },
    setup(props) {
      return () =>
        h("div", {
          id: "kv-browser-stub",
          "data-base64-utf8-preview": String(props.enableBase64Utf8Preview),
          "data-lossy-label": (props.labels as Record<string, string>).utf8PreviewLossy,
        });
    },
  }),
}));

import ZooKeeperKeyBrowser from "@/components/zookeeper/ZooKeeperKeyBrowser.vue";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = null;
  root = null;
});

describe("ZooKeeperKeyBrowser", () => {
  it("enables the Base64 UTF-8 preview with ZooKeeper labels", () => {
    root = document.createElement("div");
    document.body.appendChild(root);
    app = createApp(ZooKeeperKeyBrowser, { connectionId: "zookeeper-1" });
    app.mount(root);

    const browser = root.querySelector("#kv-browser-stub");
    expect(browser?.getAttribute("data-base64-utf8-preview")).toBe("true");
    expect(browser?.getAttribute("data-lossy-label")).toBe("zookeeper.utf8PreviewLossy");
  });
});
