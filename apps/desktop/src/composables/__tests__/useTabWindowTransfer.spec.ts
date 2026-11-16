// @vitest-environment happy-dom
import { createApp, defineComponent, h } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryTab } from "@/types/database";
import type { TabWindowTransferPayload } from "@/lib/tabs/tabWindowTransfer";

const mocks = vi.hoisted(() => ({
  createWindow: vi.fn(async (_payload: TabWindowTransferPayload) => true),
  accepted: vi.fn(async () => true),
  send: vi.fn(async (_target: string, _payload: TabWindowTransferPayload) => true),
  detach: vi.fn(),
  importTabs: vi.fn(() => true),
  markAccepted: vi.fn(),
  clear: vi.fn(),
  requestClose: vi.fn(async () => {}),
  tabs: [] as QueryTab[],
  windowLabel: "dbx-tab-source",
  canCloseEmptyWindow: true,
  receive: undefined as ((payload: TabWindowTransferPayload) => void) | undefined,
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/backend/api", () => ({ requestAppClose: mocks.requestClose }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { crossWindowTabDragPreviewEnabled: true } }) }));
vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    activeTabId: "tab-2",
    get tabs() {
      return mocks.tabs;
    },
    detachTabForTransfer: mocks.detach,
    importTransferredTabs: mocks.importTabs,
    flushPendingPersist: vi.fn(async () => {}),
  }),
}));
vi.mock("@/lib/tabs/tabWindowTransfer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tabs/tabWindowTransfer")>()),
  createDetachedTabWindow: mocks.createWindow,
  waitForTabWindowTransferAccepted: mocks.accepted,
  sendTabWindowTransfer: mocks.send,
  markTabWindowTransferAccepted: mocks.markAccepted,
  clearTabWindowTransfer: mocks.clear,
  currentTabWindowLabel: async () => mocks.windowLabel,
  listOtherTabWindows: async () => [],
  listenForTabWindowTransfer: async (handler: (payload: TabWindowTransferPayload) => void) => {
    mocks.receive = handler;
    return () => {};
  },
  listenForTabWindowInfoRequest: async () => () => {},
  listenForTabWindowInfoResponse: async () => () => {},
  listenForTabWindowDragPreview: async () => () => {},
  listenForNativeTabDragPreviewRelease: async () => () => {},
  hideTabDragPreviewWebview: async () => {},
}));

import { useTabWindowTransfer } from "@/composables/useTabWindowTransfer";

const tabs = [1, 2].map((number) => ({ id: `tab-${number}`, title: `Query ${number}`, mode: "query", connectionId: "pg", database: "app", sql: `select ${number}`, createdAt: number }) as QueryTab);
let app: ReturnType<typeof createApp>;
let host: HTMLElement;
let transfer: ReturnType<typeof useTabWindowTransfer>;

async function mountCoordinator() {
  host = document.createElement("div");
  app = createApp(
    defineComponent({
      setup() {
        transfer = useTabWindowTransfer({ canCloseEmptyWindow: () => mocks.canCloseEmptyWindow });
        return () => h("div");
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} } }));
  app.mount(host);
  await vi.waitFor(() => expect(mocks.receive).toBeTypeOf("function"));
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.accepted.mockResolvedValue(true);
  mocks.importTabs.mockReturnValue(true);
  mocks.receive = undefined;
  mocks.tabs = [...tabs];
  mocks.windowLabel = "dbx-tab-source";
  mocks.canCloseEmptyWindow = true;
  mocks.detach.mockImplementation((id: string) => {
    mocks.tabs = mocks.tabs.filter((tab) => tab.id !== id);
  });
  await mountCoordinator();
});

afterEach(() => app.unmount());

describe("group window transfer acknowledgement", () => {
  it("creates one window for all tabs and removes the source only after acceptance", async () => {
    await transfer.openTabsInNewWindow(tabs);
    expect(mocks.createWindow).toHaveBeenCalledOnce();
    const payload = mocks.createWindow.mock.calls[0][0];
    expect(payload.tab.id).toBe("tab-1");
    expect(payload.additionalTabs?.map((entry) => entry.tab.id)).toEqual(["tab-2"]);
    expect(payload.activeTabId).toBe("tab-2");
    expect(mocks.detach.mock.calls.map(([id]) => id)).toEqual(["tab-1", "tab-2"]);
    expect(mocks.accepted.mock.invocationCallOrder[0]).toBeLessThan(mocks.detach.mock.invocationCallOrder[0]);
    expect(mocks.requestClose).toHaveBeenCalledOnce();
    expect(mocks.detach.mock.invocationCallOrder[1]).toBeLessThan(mocks.requestClose.mock.invocationCallOrder[0]);
  });

  it("keeps every source tab when the new window does not acknowledge the group", async () => {
    mocks.accepted.mockResolvedValue(false);
    await transfer.openTabsInNewWindow(tabs);
    expect(mocks.detach).not.toHaveBeenCalled();
    expect(mocks.requestClose).not.toHaveBeenCalled();
  });

  it("sends the whole group to an existing window as one transfer", async () => {
    await transfer.moveTabsToWindow(tabs, "dbx-tab-target");
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0][0]).toBe("dbx-tab-target");
    expect(mocks.send.mock.calls[0][1].additionalTabs).toHaveLength(1);
    expect(mocks.detach).toHaveBeenCalledTimes(2);
    expect(mocks.requestClose).toHaveBeenCalledOnce();
  });

  it("keeps the source window while other tabs or app pages are still open", async () => {
    await transfer.moveTabToWindow(tabs[0], "main");
    expect(mocks.tabs.map((tab) => tab.id)).toEqual([tabs[1].id]);
    expect(mocks.requestClose).not.toHaveBeenCalled();
    mocks.canCloseEmptyWindow = false;
    await transfer.moveTabToWindow(tabs[1], "main");
    expect(mocks.tabs).toEqual([]);
    expect(mocks.requestClose).not.toHaveBeenCalled();
  });

  it("retains the empty main workspace after its last tab is moved out", async () => {
    app.unmount();
    mocks.receive = undefined;
    mocks.windowLabel = "main";
    await mountCoordinator();
    await transfer.openTabsInNewWindow(tabs);
    expect(mocks.tabs).toEqual([]);
    expect(mocks.requestClose).not.toHaveBeenCalled();
  });

  it("acknowledges the incoming group only after all tabs are imported", async () => {
    mocks.receive!({ transferId: "group", sourceWindowLabel: "dbx-tab-other", tab: tabs[0], additionalTabs: [{ tab: tabs[1] }], activeTabId: tabs[1].id });
    await vi.waitFor(() => expect(mocks.markAccepted).toHaveBeenCalledWith("group"));
    expect(mocks.importTabs).toHaveBeenCalledWith([{ tab: tabs[0], liveTab: undefined }, { tab: tabs[1] }], tabs[1].id);
    mocks.markAccepted.mockClear();
    mocks.importTabs.mockReturnValue(false);
    mocks.receive!({ transferId: "failed-group", sourceWindowLabel: "dbx-tab-other", tab: tabs[0] });
    await vi.waitFor(() => expect(mocks.importTabs).toHaveBeenCalledTimes(2));
    expect(mocks.markAccepted).not.toHaveBeenCalled();
  });
});
