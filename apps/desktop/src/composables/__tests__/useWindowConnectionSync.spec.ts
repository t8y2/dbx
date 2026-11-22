// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  sync: vi.fn(async (_id: string, _closedByUser?: boolean) => {}),
  unlisten: vi.fn(),
  listener: undefined as ((change: { connectionId: string; closedByUser?: boolean }) => Promise<void>) | undefined,
  connections: [] as { id: string }[],
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/connection/connectionStateEvents", () => ({ subscribeConnectionStateChanges: mocks.subscribe }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    get connections() {
      return mocks.connections;
    },
    syncSharedConnectionState: mocks.sync,
  }),
}));

import { useWindowConnectionSync } from "../useWindowConnectionSync";
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections = reactive([{ id: "existing" }]);
  mocks.subscribe.mockImplementation(async (listener) => {
    mocks.listener = listener;
    return mocks.unlisten;
  });
});
afterEach(() => app?.unmount());

function mount() {
  app = createApp(
    defineComponent({
      setup() {
        useWindowConnectionSync();
        return () => h("div");
      },
    }),
  );
  app.mount(document.createElement("div"));
}

describe("cross-window connection subscription", () => {
  it("hydrates existing connections and listens for remote state changes", async () => {
    mount();
    await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledWith("existing"));
    await mocks.listener!({ connectionId: "pg", closedByUser: true });
    expect(mocks.sync).toHaveBeenCalledWith("pg", true);
    mocks.sync.mockClear();
    mocks.connections.push({ id: "later" });
    await nextTick();
    expect(mocks.sync).toHaveBeenCalledExactlyOnceWith("later");
    app.unmount();
    mocks.sync.mockClear();
    mocks.connections.push({ id: "after-unmount" });
    await nextTick();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("cleans up a subscription that finishes after unmount", async () => {
    let ready!: (cleanup: () => void) => void;
    mocks.subscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    mount();
    app.unmount();
    ready(mocks.unlisten);
    await vi.waitFor(() => expect(mocks.unlisten).toHaveBeenCalledOnce());
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
