// @vitest-environment happy-dom
import { createApp, h, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ConnectionConfig, DatabaseType, ObjectSourceKind } from "@/types/database";
import ObjectSourceDialog from "../ObjectSourceDialog.vue";

const mocks = vi.hoisted(() => ({
  getObjectSource: vi.fn(),
  buildEditableObjectSource: vi.fn(),
  buildExecutableObjectSourceStatements: vi.fn(),
  executeQuery: vi.fn(),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  ...mocks,
}));

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === text);
}

async function mountDialog(options: { objectType: ObjectSourceKind; name: string; initialEditing?: boolean }) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined as any);
  vi.spyOn(store, "getConfig").mockReturnValue({ id: "pg", name: "test", db_type: "postgres" } as ConnectionConfig);
  mocks.getObjectSource.mockResolvedValue({
    name: options.name,
    schema: "public",
    object_type: options.objectType,
    source: "CREATE OR REPLACE ...",
    editable: true,
  });
  mocks.buildEditableObjectSource.mockResolvedValue("CREATE OR REPLACE ...");

  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(ObjectSourceDialog, {
        open: true,
        connectionId: "pg",
        database: "testdb",
        schema: "public",
        name: options.name,
        objectType: options.objectType,
        databaseType: "postgres" as DatabaseType,
        dialect: "postgres",
        initialEditing: options.initialEditing ?? false,
      }),
  });
  app.use(pinia);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          contextMenu: {
            editView: "Edit View",
            editObject: "Edit Object",
            viewSource: "View Source",
          },
          common: {
            loading: "Loading...",
            close: "Close",
          },
        },
      },
    }),
  );
  app.mount(host);
  mountedApps.push({ app, host });
  await vi.waitFor(
    () => {
      const btn = button("Edit Object") || button("Edit View");
      expect(btn).toBeDefined();
      expect(btn?.disabled).toBe(false);
    },
    { timeout: 10_000 },
  );
  return host;
}

describe("ObjectSourceDialog dynamic edit label and title", () => {
  it("uses Edit Object for procedures in view mode and editing title", async () => {
    await mountDialog({ objectType: "PROCEDURE", name: "calculate_bonus" });
    const editBtn = button("Edit Object");
    expect(editBtn).toBeDefined();
    expect(button("Edit View")).toBeUndefined();
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("View Source - calculate_bonus");

    editBtn!.click();
    await vi.waitFor(() => expect(document.querySelector("[role='dialog']")?.textContent).toContain("Edit Object - calculate_bonus"));
  });

  it("uses Edit View for views in view mode and editing title", async () => {
    await mountDialog({ objectType: "VIEW", name: "active_users" });
    const editBtn = button("Edit View");
    expect(editBtn).toBeDefined();
    expect(button("Edit Object")).toBeUndefined();
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("View Source - active_users");

    editBtn!.click();
    await vi.waitFor(() => expect(document.querySelector("[role='dialog']")?.textContent).toContain("Edit View - active_users"));
  });
});
