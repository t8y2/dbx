import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { ConnectionConfig } from "@/types/database";

function postgresConnection(id: string): ConnectionConfig {
  return {
    id,
    name: "PostgreSQL",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
  };
}

function pluginConnection(id: string, pluginId: string): ConnectionConfig {
  return {
    ...postgresConnection(id),
    name: "Plugin connection",
    db_type: "plugin",
    plugin_id: pluginId,
    plugin_connection_provider: "connection",
    plugin_connection_type: "ssh",
  };
}

async function settlePluginTabClose() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("queryStore plugin tab close connection lifecycle", () => {
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

  it("keeps a host-owned PostgreSQL connection and SQL tab when its plugin tab closes", async () => {
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    connectionStore.connections = [postgresConnection("conn-host")];
    const disconnectSpy = vi.spyOn(connectionStore, "disconnect").mockResolvedValue();

    const sqlTabId = queryStore.createTab("conn-host", "app", "Query 1", "query");
    const pluginTabId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      connectionId: "conn-host",
      context: { connectionId: "conn-host" },
    });

    queryStore.closeTab(pluginTabId);
    await settlePluginTabClose();

    expect(disconnectSpy).not.toHaveBeenCalled();
    expect(queryStore.tabs.some((tab) => tab.id === sqlTabId)).toBe(true);
  });

  it("never disconnects a host-owned connection after its last plugin consumer closes", async () => {
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    connectionStore.connections = [postgresConnection("conn-host")];
    const disconnectSpy = vi.spyOn(connectionStore, "disconnect").mockResolvedValue();

    const workbenchId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      connectionId: "conn-host",
      context: { connectionId: "conn-host" },
    });
    const filesystemId = queryStore.openPluginFilesystem("io.dbx.ssh", "fs", {
      connectionId: "conn-host",
      rootUri: "sftp:/",
    });

    queryStore.closeTab(workbenchId);
    await settlePluginTabClose();
    expect(disconnectSpy).not.toHaveBeenCalled();

    queryStore.closeTab(filesystemId);
    await settlePluginTabClose();
    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  it("disconnects a plugin-owned connection when its last owner tab closes", async () => {
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    connectionStore.connections = [pluginConnection("conn-plugin", "io.dbx.ssh")];
    const disconnectSpy = vi.spyOn(connectionStore, "disconnect").mockResolvedValue();

    const pluginTabId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      connectionId: "conn-plugin",
      context: { connectionId: "conn-plugin" },
    });

    queryStore.closeTab(pluginTabId);
    await vi.waitFor(() => expect(disconnectSpy).toHaveBeenCalledTimes(1));
    expect(disconnectSpy).toHaveBeenCalledWith("conn-plugin");
  });

  it("waits for the last plugin-owned workbench and filesystem tab before disconnecting", async () => {
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    connectionStore.connections = [pluginConnection("conn-plugin", "io.dbx.ssh")];
    const disconnectSpy = vi.spyOn(connectionStore, "disconnect").mockResolvedValue();

    const workbenchId = queryStore.openPluginWorkbench("io.dbx.ssh", "workbench", {
      connectionId: "conn-plugin",
      context: { connectionId: "conn-plugin" },
    });
    const filesystemId = queryStore.openPluginFilesystem("io.dbx.ssh", "fs", {
      connectionId: "conn-plugin",
      rootUri: "sftp:/",
    });

    queryStore.closeTab(workbenchId);
    await settlePluginTabClose();
    expect(disconnectSpy).not.toHaveBeenCalled();

    queryStore.closeTab(filesystemId);
    await vi.waitFor(() => expect(disconnectSpy).toHaveBeenCalledTimes(1));
    expect(disconnectSpy).toHaveBeenCalledWith("conn-plugin");
  });

  it("does not let another plugin disconnect a plugin-owned connection it only borrows", async () => {
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    connectionStore.connections = [pluginConnection("conn-plugin", "io.dbx.owner")];
    const disconnectSpy = vi.spyOn(connectionStore, "disconnect").mockResolvedValue();

    const borrowedTabId = queryStore.openPluginWorkbench("io.dbx.borrower", "workbench", {
      connectionId: "conn-plugin",
      context: { connectionId: "conn-plugin" },
    });

    queryStore.closeTab(borrowedTabId);
    await settlePluginTabClose();

    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  it("does not disconnect a non-plugin connection when a regular tab closes", async () => {
    const queryStore = useQueryStore();
    const connectionStore = useConnectionStore();
    connectionStore.connections = [postgresConnection("pg-1")];
    const disconnectSpy = vi.spyOn(connectionStore, "disconnect").mockResolvedValue();

    const id = queryStore.createTab("pg-1", "app", "Query 1", "query");
    queryStore.closeTab(id);

    await settlePluginTabClose();
    expect(disconnectSpy).not.toHaveBeenCalled();
  });
});
