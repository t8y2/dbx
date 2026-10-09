// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import FirebirdObjectManager from "../FirebirdObjectManager.vue";
import * as api from "@/lib/backend/api";

vi.mock("@/lib/backend/api", () => ({ listObjects: vi.fn(), getObjectSource: vi.fn(), executeQuery: vi.fn() }));
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup:
      (_props, { slots }) =>
      () =>
        h("section", slots.default?.()),
  });
  return { Dialog: passthrough, DialogContent: passthrough, DialogHeader: passthrough, DialogTitle: passthrough };
});
const apps: ReturnType<typeof createApp>[] = [];
async function mount() {
  i18n.global.locale.value = "en";
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(FirebirdObjectManager, { open: true, connectionId: "fb", database: "db" });
  app.use(i18n);
  apps.push(app);
  app.mount(container);
  await vi.waitFor(() => expect(api.listObjects).toHaveBeenCalled());
  await nextTick();
}
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Firebird object manager", () => {
  it("filters categories and names and reads sources without executing them", async () => {
    vi.mocked(api.listObjects).mockResolvedValue([
      { name: "GEN_ORDER", object_type: "SEQUENCE" },
      { name: "F_ABS", object_type: "FUNCTION_UDF", comment: "FreeAdhocUDF" },
      { name: "F_GETNO", object_type: "FUNCTION_INTERNAL" },
    ]);
    vi.mocked(api.getObjectSource).mockResolvedValue({ name: "F_ABS", object_type: "FUNCTION", source: "-- Module: FreeAdhocUDF", editable: false });
    await mount();
    await vi.waitFor(() => expect(document.body.textContent).toContain("GEN_ORDER"));
    const select = document.querySelector("select")!;
    select.value = "FUNCTION_UDF";
    select.dispatchEvent(new Event("change"));
    await nextTick();
    const input = document.querySelector("input")!;
    input.value = "FreeAdhoc";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    expect(document.querySelector("tbody")?.textContent).toContain("F_ABS");
    expect(document.querySelector("tbody")?.textContent).not.toContain("F_GETNO");
    [...document.querySelectorAll("button")].find((button) => button.textContent === "F_ABS")!.click();
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toContain("FreeAdhocUDF"));
    expect(api.getObjectSource).toHaveBeenCalledWith("fb", "db", "", "F_ABS", "FUNCTION");
    expect(api.executeQuery).not.toHaveBeenCalled();
  });
  it("escapes quoted index names and requests only read-only catalog details", async () => {
    vi.mocked(api.listObjects).mockResolvedValue([{ name: "IX'O", object_type: "INDEX", parent_name: "ORDERS" }]);
    vi.mocked(api.executeQuery).mockResolvedValue({ columns: ["TABLE_NAME"], rows: [["ORDERS"]], column_types: ["VARCHAR"], affected_rows: 0, execution_time_ms: 1 });
    await mount();
    await vi.waitFor(() => expect(document.querySelector("option[value=INDEX]")?.textContent).toContain("(1)"));
    const select = document.querySelector("select")!;
    select.value = "INDEX";
    select.dispatchEvent(new Event("change"));
    await nextTick();
    [...document.querySelectorAll("button")].find((button) => button.textContent === "IX'O")!.click();
    await vi.waitFor(() => expect(api.executeQuery).toHaveBeenCalled());
    const sql = vi.mocked(api.executeQuery).mock.calls[0][2];
    expect(sql).toContain("WHERE I.RDB$INDEX_NAME='IX''O'");
    expect(sql).toMatch(/^SELECT /);
  });
});
