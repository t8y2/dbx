// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagramTable } from "@/lib/diagram/erDiagram";

const mocks = vi.hoisted(() => ({
  buildDropTableSql: vi.fn(async (options: { schema?: string; tableName: string; cascade?: boolean }) => {
    const qualifiedName = options.schema ? `"${options.schema}"."${options.tableName}"` : `"${options.tableName}"`;
    return `DROP TABLE ${qualifiedName}${options.cascade ? " CASCADE" : ""};`;
  }),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Dialog: passthrough,
    DialogContent: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
  };
});

vi.mock("@/lib/backend/api", () => ({
  buildCreateTableSql: vi.fn(),
  buildTableStructureChangeSql: vi.fn(),
  executeBatch: vi.fn(),
}));

vi.mock("@/lib/database/dbAdminSql", () => ({
  buildDropTableSql: mocks.buildDropTableSql,
  supportsDropTableCascade: vi.fn(() => true),
}));

import DiagramSyncDialog from "../DiagramSyncDialog.vue";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  mocks.buildDropTableSql.mockClear();
});

async function flushAsyncUpdates() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe("DiagramSyncDialog", () => {
  it("previews live table deletion without silently enabling CASCADE", async () => {
    const liveTable: DiagramTable = {
      name: "orders",
      columns: [],
      foreignKeys: [],
      origin: "live",
      pendingDrop: true,
    };
    const open = ref(false);
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(DiagramSyncDialog, {
              open: open.value,
              tables: [liveTable],
              connectionId: "connection-1",
              database: "app",
              schema: "public",
              databaseType: "postgres",
              "onUpdate:open": (value: boolean) => (open.value = value),
            });
        },
      }),
    );
    app.mount(host);
    mountedApps.push({ app, host });

    open.value = true;
    await flushAsyncUpdates();

    expect(mocks.buildDropTableSql).toHaveBeenCalledWith({
      databaseType: "postgres",
      schema: "public",
      tableName: "orders",
      cascade: false,
    });
    expect(host.textContent).toContain('DROP TABLE "public"."orders";');
    expect(host.textContent).not.toContain("CASCADE");
  });
});
