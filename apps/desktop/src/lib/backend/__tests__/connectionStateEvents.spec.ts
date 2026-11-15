import { beforeEach, describe, expect, it, vi } from "vitest";
import * as tauri from "../tauri";
import type { ConnectionConfig } from "@/types/database";
import { subscribePluginConnectionStateChanges } from "@/lib/connection/connectionStateEvents";

const { invoke, emit, listen } = vi.hoisted(() => ({ invoke: vi.fn(), emit: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ emit, listen }));
const config = { id: "A", name: "A", password: "must-not-be-broadcast" } as ConnectionConfig;

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue("A");
  emit.mockResolvedValue(undefined);
});

describe("plugin connection state invalidation", () => {
  const sshConfig = { ...config, db_type: "plugin", plugin_id: "io.dbx.ssh" } as ConnectionConfig;
  const event = { pluginId: "io.dbx.ssh", method: "ssh/session/state", params: { connectionId: "A", state: "disconnected" } };

  async function subscribe() {
    const refresh = vi.fn(async () => {});
    const unlisten = vi.fn();
    listen.mockResolvedValueOnce(unlisten);
    const stop = await subscribePluginConnectionStateChanges((id) => (id === "A" ? sshConfig : undefined), refresh);
    expect(stop).toBe(unlisten);
    expect(listen.mock.calls[0][0]).toBe("dbx-plugin-event");
    return { refresh, receive: listen.mock.calls[0][1] as (event: { payload: unknown }) => Promise<void> };
  }

  it.each(["connected", "disconnected"])("confirms backend state on %s without treating the event as authoritative", async (state) => {
    const { refresh, receive } = await subscribe();
    await receive({ payload: { ...event, params: { ...event.params, state } } });
    expect(refresh).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...event, method: "ssh/terminal/output" },
    { ...event, pluginId: "another-plugin" },
    { ...event, pluginId: undefined },
    { ...event, params: null },
    { ...event, params: { connectionId: "missing", state: "disconnected" } },
    { ...event, params: { connectionId: 12, state: "disconnected" } },
    { ...event, params: { connectionId: "A", state: "connecting" } },
  ])("ignores unrelated, foreign, or malformed payload %j", async (payload) => {
    const { refresh, receive } = await subscribe();
    await receive({ payload });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("native connection state invalidation", () => {
  it.each([
    ["connect", () => tauri.connectDb(config), false],
    ["disconnect", () => tauri.disconnectDb("A"), false],
    ["save", () => tauri.saveConnections([config]), true],
  ] as const)("broadcasts only after %s succeeds without sending credentials", async (_name, operation, configurationChanged) => {
    let finish!: (value: string) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = operation();
    expect(emit).not.toHaveBeenCalled();
    finish("A");
    await pending;
    expect(emit).toHaveBeenCalledExactlyOnceWith("dbx:connection-state-changed", { sourceWindowLabel: "main", configurationChanged });
  });

  it("does not broadcast a failed backend operation", async () => {
    invoke.mockRejectedValueOnce(new Error("connect failed"));
    await expect(tauri.connectDb(config)).rejects.toThrow("connect failed");
    expect(emit).not.toHaveBeenCalled();
  });

  it("preserves backend success if broadcasting fails", async () => {
    emit.mockRejectedValueOnce(new Error("window closed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(tauri.connectDb(config)).resolves.toBe("A");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
