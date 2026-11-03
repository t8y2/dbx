// @vitest-environment happy-dom

import { createApp, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { GeneratorParams } from "@/lib/dataGrid/dataGenerate";
import ForeignKeyParams from "@/components/generate/params/ForeignKeyParams.vue";

// MySQL exposes no schema list: the database is the schema. listTables and
// getColumns still filter on that schema, so an empty listSchemas() must not
// make the panel fall back to SQLite's "main" (#13879).
vi.mock("@/lib/backend/api", () => ({
  listSchemas: vi.fn(async (): Promise<string[]> => []),
  listTables: vi.fn(async (_connectionId: string, _database: string, schema?: string) => (schema === "ecommerce" ? [{ name: "orders" }] : [])),
  getColumns: vi.fn(async (_connectionId: string, _database: string, schema?: string, table?: string) => (schema === "ecommerce" && table === "orders" ? [{ name: "id" }, { name: "total" }] : [])),
}));

import * as api from "@/lib/backend/api";

let app: App | null = null;
let host: HTMLElement | null = null;

function mountPanel(params: GeneratorParams) {
  host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp({
    render: () => h(ForeignKeyParams, { params, config: { columnName: "order_id", dataType: "int", rowCount: 10 }, connectionId: "c1", database: "ecommerce" }),
  });
  app.use(i18n);
  app.mount(host);
  return params;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function selectOptions(): string[][] {
  return Array.from(host?.querySelectorAll("select") ?? []).map((select) =>
    Array.from(select.options)
      .filter((option) => !option.disabled)
      .map((option) => option.value)
      .filter(Boolean),
  );
}

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
  vi.clearAllMocks();
});

describe("foreign key generator schema defaults (#13879)", () => {
  it("defaults the schema to the current database when the server lists none", async () => {
    const params = mountPanel({});
    await flush();
    expect(params.fkSchema).toBe("ecommerce");
    expect(selectOptions()[0]).toEqual(["ecommerce"]);
  });

  it("populates the referenced columns once a parent table is chosen", async () => {
    const params = mountPanel({ fkSchema: "ecommerce" });
    await flush();
    expect(selectOptions()[1]).toEqual(["orders"]);

    params.fkTable = "orders";
    const tableSelect = host!.querySelectorAll("select")[1] as HTMLSelectElement;
    tableSelect.value = "orders";
    tableSelect.dispatchEvent(new Event("change"));
    await flush();

    expect(selectOptions()[2]).toEqual(["id", "total"]);
    expect(api.getColumns).toHaveBeenCalledWith("c1", "ecommerce", "ecommerce", "orders");
  });
});
