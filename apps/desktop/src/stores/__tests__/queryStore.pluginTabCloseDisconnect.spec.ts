import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

describe("queryStore plugin tab close disconnects the plugin connection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    setActivePinia(createPinia());
  });

  it("disconnects the plugin connection when its last plugin tab closes", async () => {
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    const disconnectSpy = vi.spyOn(connectionStore, "disconnect").mockResolvedValue();

    const id = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", { connectionId: "conn-1", context: { connectionId: "conn-1" } });
    queryStore.closeTab(id);

    await vi.waitFor(() => expect(disconnectSpy).toHaveBeenCalledTimes(1));
    expect(disconnectSpy).toHaveBeenCalledWith("conn-1");
  });

  it("keeps the plugin connection while another plugin tab for it stays open", async () => {
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    const disconnectSpy = vi.spyOn(connectionStore, "disconnect").mockResolvedValue();

    // Workbench + filesystem tab riding the same connection (e.g. SSH terminal + SFTP).
    const workbenchId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", { connectionId: "conn-1", context: { connectionId: "conn-1" } });
    queryStore.openPluginFilesystem("io.dbx.ssh", "fs", { connectionId: "conn-1", rootUri: "sftp:/" });

    queryStore.closeTab(workbenchId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  it("does not disconnect non-plugin connections when a regular tab closes", async () => {
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    const disconnectSpy = vi.spyOn(connectionStore, "disconnect").mockResolvedValue();

    const id = queryStore.createTab("pg-1", "app", "Query 1", "query");
    queryStore.closeTab(id);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disconnectSpy).not.toHaveBeenCalled();
  });
});
