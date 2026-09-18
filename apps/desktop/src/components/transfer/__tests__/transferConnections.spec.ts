// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConnectionTreeSelect from "@/components/connection/ConnectionTreeSelect.vue";
import { supportsTransfer } from "@/lib/database/databaseCapabilities";
import { transferDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

vi.mock("@/components/ui/button", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return { Button: createPassthroughStub("Button", "button") };
});

vi.mock("@/components/ui/popover", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return {
    Popover: createPassthroughStub("Popover"),
    PopoverContent: createPassthroughStub("PopoverContent"),
    PopoverTrigger: createPassthroughStub("PopoverTrigger"),
  };
});

vi.mock("@/components/icons/DatabaseIcon.vue", () => ({ default: defineComponent({ setup: () => () => h("span") }) }));

const connections: ConnectionConfig[] = [
  { id: "mysql-source", name: "MySQL Source", db_type: "mysql", host: "localhost", port: 3306, username: "test", password: "" },
  { id: "pg-source", name: "PostgreSQL Source", db_type: "postgres", host: "localhost", port: 5432, username: "test", password: "" },
  { id: "h2-local-id", name: "Local H2", db_type: "h2", driver_profile: "h2-v3", host: "", port: 0, username: "sa", password: "", database: "mem:transfer-test" },
  { id: "h2-jdbc-id", name: "JDBC H2", db_type: "jdbc", connection_string: "jdbc:h2:mem:transfer-test", host: "", port: 0, username: "sa", password: "" },
  { id: "redis-id", name: "Redis", db_type: "redis", host: "localhost", port: 6379, username: "", password: "" },
  { id: "unknown-jdbc-id", name: "Unknown JDBC", db_type: "jdbc", host: "localhost", port: 0, username: "", password: "" },
];
const layout: SidebarLayout = {
  groups: [{ id: "embedded", name: "Embedded", collapsed: false }],
  order: [{ type: "group", id: "embedded", children: [{ type: "connection", id: "h2-local-id" }] }],
};
const mountedApps: App[] = [];

async function mountTransferPickers(source: string) {
  const selection = reactive({ source, target: "" });
  const eligible = connections.filter((connection) => supportsTransfer(transferDatabaseTypeForConnection(connection)));
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(
          "div",
          (["source", "target"] as const).map((side) =>
            h("section", { "data-side": side }, [
              h(ConnectionTreeSelect, {
                modelValue: selection[side],
                connections: eligible,
                layout,
                placeholder: "Select connection",
                searchPlaceholder: "Search",
                emptyText: "No connections",
                "onUpdate:modelValue": (value: string) => {
                  selection[side] = value;
                },
              }),
            ]),
          ),
        ),
    }),
  );
  mountedApps.push(app);
  app.mount(container);
  await nextTick();
  return { container, selection };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("data transfer connection choices", () => {
  it.each(["mysql-source", "pg-source"])("offers H2 on both sides when opened from %s", async (source) => {
    const { container, selection } = await mountTransferPickers(source);
    for (const side of ["source", "target"]) {
      const picker = container.querySelector(`[data-side="${side}"]`)!;
      expect(picker.querySelector('[data-picker-connection="h2-local-id"]')?.textContent).toContain("Local H2");
      expect(picker.querySelector('[data-picker-connection="h2-jdbc-id"]')?.textContent).toContain("JDBC H2");
      expect(picker.querySelector('[data-picker-connection="redis-id"]')).toBeNull();
      expect(picker.querySelector('[data-picker-connection="unknown-jdbc-id"]')).toBeNull();
    }
    const target = container.querySelector('[data-side="target"]')!;
    (target.querySelector('[data-picker-connection="h2-local-id"]') as HTMLButtonElement).click();
    await nextTick();
    expect(selection.target).toBe("h2-local-id");
    expect(target.querySelector("button")?.textContent).toContain("Local H2");
    expect(selection.source).toBe(source);
  });

  it.each(["h2-local-id", "h2-jdbc-id"])("resolves the prefilled %s to its connection name", async (source) => {
    const { container } = await mountTransferPickers(source);
    const trigger = container.querySelector('[data-side="source"] button');
    expect(trigger?.textContent).toContain(connections.find((connection) => connection.id === source)!.name);
    expect(trigger?.textContent).not.toContain(source);
  });
});
