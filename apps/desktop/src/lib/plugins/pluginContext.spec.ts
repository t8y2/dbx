import { describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, PluginContextMenuContribution, TreeNode } from "@/types/database";
import { activatePluginContextMenuItem, buildPluginConnectionContextMenuInvocation, buildPluginTableContext, buildPluginTableContextMenuInvocation, type PluginContextMenuActivationHandlers } from "./pluginContext";

function tableNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: "connection:demo:public:users",
    label: "users",
    type: "table",
    connectionId: "conn-1",
    database: "demo",
    schema: "public",
    tableName: "users",
    ...overrides,
  };
}

function activationHandlers(overrides: Partial<PluginContextMenuActivationHandlers> = {}): PluginContextMenuActivationHandlers {
  return {
    findWorkbench: () => true,
    openWorkbench: () => undefined,
    invokePlugin: async () => undefined,
    toast: () => undefined,
    ...overrides,
  };
}

const pluginId = "com.example.plugin";

function openWorkbenchContribution(menu: "connection" | "table"): PluginContextMenuContribution {
  return {
    type: "context-menu",
    id: "example.open",
    label: "Open Example",
    menu,
    action: { type: "open-workbench", workbench: "example.main" },
  };
}

describe("plugin context menu context", () => {
  it("builds the public table context from canonical table metadata", () => {
    expect(buildPluginTableContext(tableNode())).toEqual({
      connectionId: "conn-1",
      database: "demo",
      schema: "public",
      table: "users",
    });
  });

  it("omits optional database and schema values when the node has no scope", () => {
    expect(buildPluginTableContext(tableNode({ database: undefined, schema: undefined }))).toEqual({
      connectionId: "conn-1",
      table: "users",
    });
    expect(buildPluginTableContext(tableNode({ database: "", schema: "" }))).toEqual({
      connectionId: "conn-1",
      table: "users",
    });
  });

  it("fails closed when canonical table identity is missing instead of using the label", () => {
    const node = tableNode({ tableName: undefined, label: "users" });

    expect(buildPluginTableContext(node)).toBeNull();
    expect(buildPluginTableContextMenuInvocation("example.inspect", node)).toBeNull();
  });

  it("prepares the existing table backend invocation and carries TableContext separately", () => {
    expect(buildPluginTableContextMenuInvocation("example.inspect", tableNode())).toEqual({
      method: "contextMenu/example.inspect",
      params: {
        table: {
          connectionId: "conn-1",
          database: "demo",
          schema: "public",
          table: "users",
        },
      },
      context: {
        connectionId: "conn-1",
        database: "demo",
        schema: "public",
        table: "users",
      },
      connectionId: "conn-1",
    });
  });

  it("does not build table context for non-table nodes", () => {
    expect(buildPluginTableContext(tableNode({ type: "view" }))).toBeNull();
  });

  it("opens the same-plugin workbench from a connection menu without invoking the backend", async () => {
    const connection = {
      id: "conn-1",
      db_type: "mysql",
      name: "Development",
      database: "app",
      host: "db.internal",
      port: 3306,
      username: "user",
      password: "test-secret",
      connection_string: "mysql://user:test-secret@db.internal/app",
    } as ConnectionConfig;
    const invocation = buildPluginConnectionContextMenuInvocation("example.open", connection);
    expect(invocation).not.toBeNull();
    const openWorkbench = vi.fn();
    const invokePlugin = vi.fn().mockResolvedValue({ message: "must not run" });
    const findWorkbench = vi.fn((ownerPluginId: string, workbenchId: string) => ownerPluginId === pluginId && workbenchId === "example.main");

    await activatePluginContextMenuItem(pluginId, openWorkbenchContribution("connection"), invocation!, activationHandlers({ findWorkbench, openWorkbench, invokePlugin }));

    expect(invocation?.context).toEqual({ id: "conn-1", dbType: "mysql", name: "Development", database: "app" });
    expect(JSON.stringify(invocation)).not.toContain("test-secret");
    expect(findWorkbench).toHaveBeenCalledWith(pluginId, "example.main");
    expect(openWorkbench).toHaveBeenCalledWith(pluginId, "example.main", {
      title: "Open Example",
      connectionId: "conn-1",
      context: invocation?.context,
      refreshContextOnReuse: true,
    });
    expect(invokePlugin).not.toHaveBeenCalled();
  });

  it("opens a table workbench with the exact stable TableContext and no credentials", async () => {
    const invocation = buildPluginTableContextMenuInvocation("example.open", tableNode());
    expect(invocation).not.toBeNull();
    const openWorkbench = vi.fn();
    const invokePlugin = vi.fn();

    await activatePluginContextMenuItem(pluginId, openWorkbenchContribution("table"), invocation!, activationHandlers({ openWorkbench, invokePlugin }));

    expect(openWorkbench).toHaveBeenCalledWith(pluginId, "example.main", {
      title: "Open Example",
      connectionId: "conn-1",
      context: { connectionId: "conn-1", database: "demo", schema: "public", table: "users" },
      refreshContextOnReuse: true,
    });
    expect(invokePlugin).not.toHaveBeenCalled();
  });

  it("reports a missing workbench explicitly without falling back to the backend", async () => {
    const invocation = buildPluginTableContextMenuInvocation("example.open", tableNode())!;
    const openWorkbench = vi.fn();
    const invokePlugin = vi.fn();
    const toast = vi.fn();

    await activatePluginContextMenuItem(pluginId, openWorkbenchContribution("table"), invocation, activationHandlers({ findWorkbench: () => false, openWorkbench, invokePlugin, toast }));

    expect(openWorkbench).not.toHaveBeenCalled();
    expect(invokePlugin).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Plugin workbench 'com.example.plugin/example.main' is unavailable", 5000);
  });

  it("preserves legacy table backend invocation and result toast behavior", async () => {
    const invocation = buildPluginTableContextMenuInvocation("example.legacy-table", tableNode())!;
    const invokePlugin = vi.fn().mockResolvedValue({ message: "Legacy table action complete" });
    const toast = vi.fn();
    const contribution: PluginContextMenuContribution = {
      type: "context-menu",
      id: "example.legacy-table",
      label: "Legacy table",
      menu: "table",
    };

    await activatePluginContextMenuItem(pluginId, contribution, invocation, activationHandlers({ invokePlugin, toast }));

    expect(invokePlugin).toHaveBeenCalledWith(pluginId, "contextMenu/example.legacy-table", {
      table: { connectionId: "conn-1", database: "demo", schema: "public", table: "users" },
    });
    expect(toast).toHaveBeenCalledWith("Legacy table action complete", 4000);
  });

  it("preserves legacy backend invocation and result toast behavior", async () => {
    const connection = { id: "conn-1", db_type: "mysql", name: "Development", database: "app" } as ConnectionConfig;
    const invocation = buildPluginConnectionContextMenuInvocation("example.legacy", connection)!;
    const invokePlugin = vi.fn().mockResolvedValue({ message: "Legacy action complete" });
    const toast = vi.fn();
    const contribution: PluginContextMenuContribution = {
      type: "context-menu",
      id: "example.legacy",
      label: "Legacy",
      menu: "connection",
    };

    await activatePluginContextMenuItem(pluginId, contribution, invocation, activationHandlers({ invokePlugin, toast }));

    expect(invokePlugin).toHaveBeenCalledWith(pluginId, "contextMenu/example.legacy", {
      connection: { id: "conn-1", dbType: "mysql", name: "Development", database: "app" },
    });
    expect(toast).toHaveBeenCalledWith("Legacy action complete", 4000);
  });

  it("keeps legacy backend errors as error toasts", async () => {
    const connection = { id: "conn-1", db_type: "mysql", name: "Development", database: "app" } as ConnectionConfig;
    const invocation = buildPluginConnectionContextMenuInvocation("example.legacy", connection)!;
    const invokePlugin = vi.fn().mockRejectedValue(new Error("sidecar failed"));
    const toast = vi.fn();
    const contribution: PluginContextMenuContribution = {
      type: "context-menu",
      id: "example.legacy",
      label: "Legacy",
      menu: "connection",
    };

    await activatePluginContextMenuItem(pluginId, contribution, invocation, activationHandlers({ invokePlugin, toast }));

    expect(toast).toHaveBeenCalledWith("sidecar failed", 5000);
  });
});
