// @vitest-environment happy-dom

import { createApp, defineComponent, h, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import ObjectSourceDialog from "@/components/objects/ObjectSourceDialog.vue";

const mocks = vi.hoisted(() => ({
  getObjectSource: vi.fn(),
  buildEditableObjectSource: vi.fn(),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  ...mocks,
}));
vi.mock("@/components/editor/QueryEditor.vue", () => ({
  default: defineComponent({
    name: "QueryEditorStub",
    props: { modelValue: { type: String, default: "" } },
    template: "<div data-query-editor-stub>{{ modelValue }}</div>",
  }),
}));

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

async function mountDialog() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const connectionStore = useConnectionStore();
  vi.spyOn(connectionStore, "ensureConnected").mockResolvedValue(undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(ObjectSourceDialog, {
        open: true,
        connectionId: "jdbc-1",
        database: "catalog1",
        schema: "APP",
        name: "calculate_total",
        objectType: "FUNCTION",
        databaseType: "jdbc",
        dialect: "mysql",
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ app, host });
  return host;
}

describe("ObjectSourceDialog generic JDBC routine metadata", () => {
  it("renders a source-less function as read-only structured metadata", async () => {
    mocks.getObjectSource.mockResolvedValue({
      name: "calculate_total",
      object_type: "FUNCTION",
      schema: "APP",
      source: "",
      editable: false,
      routine_parameters: [
        { name: "result", mode: "OUT", jdbc_type: 12, type_name: "VARCHAR", length: 32, nullable: true, ordinal: 2 },
        { name: "RETURN", mode: "RETURN", jdbc_type: 3, type_name: "DECIMAL", precision: 12, scale: 2, ordinal: 0 },
        { name: "amount", mode: "IN", jdbc_type: 3, type_name: "DECIMAL", precision: 10, scale: 2, nullable: false, ordinal: 1 },
      ],
    });
    mocks.buildEditableObjectSource.mockResolvedValue("");

    await mountDialog();
    await vi.waitFor(() => expect(document.querySelectorAll("[data-routine-parameter]")).toHaveLength(2));

    expect(document.querySelector("[data-routine-return-type]")?.textContent).toContain("DECIMAL(12,2)");
    const rows = [...document.querySelectorAll("[data-routine-parameter]")];
    expect(rows[0].textContent).toContain("amount");
    expect(rows[0].textContent).toContain("DECIMAL(10,2)");
    expect(rows[1].textContent).toContain("VARCHAR(32)");
    expect(document.querySelector("[data-query-editor-stub]")).toBeNull();
    expect(document.body.textContent).not.toContain("Object source is not supported");
    expect(mocks.getObjectSource).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "contextMenu.editView")).toBe(false);
  });

  it("keeps a legacy source payload without the optional field on the existing preview path", async () => {
    mocks.getObjectSource.mockResolvedValue({
      name: "calculate_total",
      object_type: "FUNCTION",
      schema: "APP",
      source: "CREATE FUNCTION calculate_total() RETURNS INTEGER RETURN 1",
      editable: false,
    });
    mocks.buildEditableObjectSource.mockResolvedValue("CREATE FUNCTION calculate_total() RETURNS INTEGER RETURN 1");

    await mountDialog();
    await vi.waitFor(() => expect(document.querySelector("[data-query-editor-stub]")).not.toBeNull());

    expect(document.querySelector("[data-routine-metadata]")).toBeNull();
    expect(document.querySelector("[data-query-editor-stub]")?.textContent).toContain("CREATE FUNCTION");
  });
});
