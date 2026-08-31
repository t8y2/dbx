// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import type { Translate } from "../docsWarnings";
import type { ColumnInfo } from "../types";
import ColumnTable from "../components/ColumnTable.vue";

const translate: Translate = (key) => key;

function column(overrides: Partial<ColumnInfo>): ColumnInfo {
  return {
    name: "value",
    data_type: "text",
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    extra: null,
    comment: null,
    numeric_precision: null,
    numeric_scale: null,
    character_maximum_length: null,
    ...overrides,
  };
}

async function renderTypes(columns: ColumnInfo[]): Promise<{ app: ReturnType<typeof createApp>; container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(ColumnTable, {
    columns,
    columnNotes: {},
    tableKey: "public.orders",
    readonly: true,
    translate,
  });
  app.mount(container);
  await nextTick();
  return { app, container };
}

describe("ColumnTable type labels", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not duplicate modifiers already present in the snapshot type", async () => {
    const { app, container } = await renderTypes([
      column({ name: "mysql_int", data_type: "int(11)", numeric_precision: 10, numeric_scale: 0 }),
      column({ name: "postgres_varchar", data_type: "character varying(255)", character_maximum_length: 255 }),
      column({ name: "postgres_numeric", data_type: "numeric(18,2)", numeric_precision: 18, numeric_scale: 2 }),
      column({ name: "array_type", data_type: "numeric(10,2)[]", numeric_precision: 10, numeric_scale: 2 }),
    ]);

    const labels = [...container.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td")[1]?.textContent?.trim());
    expect(labels).toEqual(["int(11)", "character varying(255)", "numeric(18,2)", "numeric(10,2)[]"]);
    app.unmount();
  });

  it("rebuilds modifiers when the snapshot reports a bare type", async () => {
    const { app, container } = await renderTypes([column({ name: "varchar", data_type: "varchar", character_maximum_length: 255 }), column({ name: "numeric", data_type: "numeric", numeric_precision: 18, numeric_scale: 2 }), column({ name: "plain", data_type: "integer" })]);

    const labels = [...container.querySelectorAll("tbody tr")].map((row) => row.querySelectorAll("td")[1]?.textContent?.trim());
    expect(labels).toEqual(["varchar(255)", "numeric(18,2)", "integer"]);
    app.unmount();
  });
});
