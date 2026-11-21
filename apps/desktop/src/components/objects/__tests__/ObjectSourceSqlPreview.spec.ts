// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, type App } from "vue";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import ObjectSourceSqlPreview from "../ObjectSourceSqlPreview.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BuildEditableObjectSourceSqlInput } from "@/lib/table/objectSourceEditor";

const api = vi.hoisted(() => ({ buildExecutableObjectSourceStatements: vi.fn(), executeQuery: vi.fn(), prepareOracleRoutineOperation: vi.fn() }));
const clipboard = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/common/clipboard", async (original) => ({ ...(await original<typeof import("@/lib/common/clipboard")>()), copyToClipboard: clipboard }));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...api }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: async () => (sql: string) => sql.replaceAll("&", "&amp;").replaceAll("<", "&lt;") }));
const mounted: Array<{ app: App; host: HTMLElement }> = [];
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.clearAllMocks();
});
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label)!;
}
async function mount(input: Partial<BuildEditableObjectSourceSqlInput> = {}) {
  const props = reactive({ input: { databaseType: "mysql", objectType: "PROCEDURE", schema: "sales", name: "sales_summary", source: "CREATE PROCEDURE sales_summary() SELECT 2;", ...input } as BuildEditableObjectSourceSqlInput, contextKey: "connection-a:sales", disabled: false });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(TooltipProvider, {}, () => h(ObjectSourceSqlPreview, props)) });
  app.use(createPinia());
  app.use(createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false, messages: { en: { contextMenu: { sqlPreview: "Preview SQL" }, common: { close: "Close" } } } }));
  app.mount(host);
  mounted.push({ app, host });
  await nextTick();
  return props;
}
describe("ObjectSourceSqlPreview", () => {
  it.each(["mysql", "postgres", "oracle", "sqlserver"] as const)("displays all save statements without executing %s writes", async (databaseType) => {
    const statements = databaseType === "mysql" ? ["DROP PROCEDURE IF EXISTS `sales`.`sales_summary`;", "CREATE PROCEDURE `sales`.`sales_summary`() BEGIN SELECT 2; END;"] : ["CREATE OR REPLACE PROCEDURE sales.sales_summary() AS BEGIN SELECT 2; END;"];
    api.buildExecutableObjectSourceStatements.mockResolvedValue(statements);
    const props = await mount({ databaseType });
    button("Preview SQL").click();
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toBe(statements.join("\n\n")));
    expect(api.buildExecutableObjectSourceStatements).toHaveBeenCalledWith({ ...props.input });
    button("grid.copy").click();
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith(statements.join("\n\n")));
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(api.prepareOracleRoutineOperation).not.toHaveBeenCalled();
    button("Close").click();
    await nextTick();
    expect(props.input.source).toBe("CREATE PROCEDURE sales_summary() SELECT 2;");
  });
  it("invalidates an in-flight preview when the object, connection, or draft changes", async () => {
    let resolve!: (sql: string[]) => void;
    api.buildExecutableObjectSourceStatements.mockImplementation(
      () =>
        new Promise<string[]>((done) => {
          resolve = done;
        }),
    );
    const props = await mount();
    button("Preview SQL").click();
    await nextTick();
    props.contextKey = "connection-b:sales";
    props.input.source = "changed";
    await nextTick();
    resolve(["obsolete definition"]);
    await nextTick();
    await nextTick();
    expect(document.body.textContent).not.toContain("obsolete definition");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.executeQuery).not.toHaveBeenCalled();
  });
  it("reports generation errors and can retry, while disabled or empty drafts cannot preview", async () => {
    api.buildExecutableObjectSourceStatements.mockRejectedValueOnce(new Error("Invalid routine definition")).mockResolvedValue(["CREATE PROCEDURE retry() SELECT 1;"]);
    const props = await mount();
    button("Preview SQL").click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe("Invalid routine definition"));
    button("Close").click();
    await nextTick();
    button("Preview SQL").click();
    await vi.waitFor(() => expect(document.querySelector("pre")?.textContent).toContain("CREATE PROCEDURE retry"));
    props.disabled = true;
    await nextTick();
    expect(button("Preview SQL").disabled).toBe(true);
    props.disabled = false;
    props.input.source = "  ";
    await nextTick();
    expect(button("Preview SQL").disabled).toBe(true);
  });
});
