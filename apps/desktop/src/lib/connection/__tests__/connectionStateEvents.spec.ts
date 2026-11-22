import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  emit: vi.fn(async (_event: string, _payload: unknown) => {}),
  listen: vi.fn(),
  callback: undefined as ((event: { payload: unknown }) => void) | undefined,
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit, listen: mocks.listen }));
import { notifyConnectionStateChanged, subscribeConnectionStateChanges } from "../connectionStateEvents";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockImplementation(async (_event, callback) => {
    mocks.callback = callback;
    return () => {};
  });
});

describe("connection state event routing", () => {
  it("publishes identifiers and intent without credentials", async () => {
    await notifyConnectionStateChanged({ connectionId: "pg", closedByUser: true });
    expect(mocks.emit).toHaveBeenCalledWith("dbx:connection-state-changed", { connectionId: "pg", closedByUser: true, sourceWindow: "main" });
  });

  it("only forwards changes from another window", async () => {
    const sync = vi.fn(async () => {});
    await subscribeConnectionStateChanges(sync);
    mocks.callback!({ payload: { connectionId: "pg", sourceWindow: "main" } });
    expect(sync).not.toHaveBeenCalled();
    mocks.callback!({ payload: { connectionId: "pg", sourceWindow: "dbx-tab-child" } });
    expect(sync).toHaveBeenCalledOnce();
  });
});
