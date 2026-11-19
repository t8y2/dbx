// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLayerStore } from "@/lib/diagram/layer-store";
import { FOCUSED_TABLE_COLOR, isFocusedTable } from "@/lib/diagram/focused-table";
import { toVueFlowNodes } from "@/lib/diagram/vue-flow-adapter";
import { buildDiagramRelationships, type DiagramTable } from "@/lib/diagram/erDiagram";

vi.mock("@vue-flow/core", () => ({ Handle: { render: () => null }, Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" } }));
import TableNode from "../TableNode.vue";

const mounted: App[] = [];
afterEach(() => mounted.splice(0).forEach((app) => app.unmount()));

describe("focused table appearance", () => {
  it("tints FK and referenced PK rows, including composite keys, without tinting unrelated same-name tables", () => {
    const column = (name: string, primary = false) => ({ name, data_type: "int", is_nullable: false, is_primary_key: primary, column_default: null, extra: null });
    const tables: DiagramTable[] = [
      {
        name: "child",
        schema: "public",
        columns: [column("parent_id"), column("tenant_id"), column("note")],
        foreignKeys: [
          { name: "fk", column: "parent_id", ref_table: "parent", ref_schema: "public", ref_column: "id" },
          { name: "fk", column: "tenant_id", ref_table: "parent", ref_schema: "public", ref_column: "tenant_id" },
        ],
      },
      { name: "parent", schema: "public", columns: [column("id", true), column("tenant_id", true), column("note")], foreignKeys: [] },
      { name: "parent", schema: "other", columns: [column("id", true), column("note")], foreignKeys: [] },
    ];
    const pinia = createPinia();
    useLayerStore(pinia);
    const nodes = toVueFlowNodes(tables, {}, true, undefined, buildDiagramRelationships(tables, [], true));
    const rows: string[][] = [];
    for (const node of nodes) {
      const host = document.createElement("div");
      const app = createApp(TableNode, { data: node.data! });
      app.use(pinia);
      app.mount(host);
      mounted.push(app);
      rows.push([...host.querySelectorAll<HTMLElement>("[data-column]")].filter((row) => row.classList.contains("bg-rose-100")).map((row) => row.dataset.column!));
    }
    expect(rows).toEqual([["parent_id", "tenant_id"], ["id", "tenant_id"], []]);
  });

  it("keeps focused header and layer stripe when selection changes", async () => {
    const props = reactive({ data: { table: { name: "A", schema: "public", origin: "draft" as const, columns: [], foreignKeys: [] }, isFocused: true, isMultiSchema: true }, selected: false });
    const host = document.createElement("div");
    const app = createApp({ render: () => h(TableNode, props) });
    const pinia = createPinia();
    app.use(pinia);
    const layerStore = useLayerStore(pinia);
    const layer = layerStore.addLayer("Group");
    layer.color = "#123456";
    layerStore.addTableToLayer(layer.id, "public.A");
    app.mount(host);
    mounted.push(app);
    const header = host.querySelector<HTMLElement>(".cursor-grab")!;
    expect(header.style.backgroundColor).toBe(FOCUSED_TABLE_COLOR);
    expect(header.style.color).toBe("white");
    const card = host.firstElementChild as HTMLElement;
    expect(card.style.borderLeftColor).toBe("#123456");
    props.selected = true;
    await nextTick();
    expect(card.classList.contains("ring-2")).toBe(true);
    expect(header.style.backgroundColor).toBe(FOCUSED_TABLE_COLOR);
    props.selected = false;
    await nextTick();
    expect(header.style.backgroundColor).toBe(FOCUSED_TABLE_COLOR);
    expect(FOCUSED_TABLE_COLOR).toBe("#9F2B68");
  });

  it("marks every root by schema and name without marking same-name dependencies", () => {
    const pinia = createPinia();
    useLayerStore(pinia);
    const roots = [
      { name: "A", schema: "public" },
      { name: "B", schema: "public" },
    ];
    const tables = [...roots, { name: "A", schema: "other" }].map((table) => ({ ...table, columns: [], foreignKeys: [] }));
    const nodes = toVueFlowNodes(tables, {}, true, (table) => isFocusedTable(table, roots));
    expect(nodes.map((node) => [node.id, node.data?.isFocused])).toEqual([
      ["public.A", true],
      ["public.B", true],
      ["other.A", false],
    ]);
  });
});
