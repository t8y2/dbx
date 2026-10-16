// @vitest-environment happy-dom

import { createApp, defineComponent, h, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import SchemaDiffDialog from "@/components/diff/SchemaDiffDialog.vue";
import type { SchemaDiffSession } from "@/composables/useSchemaDiffSession";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn().mockResolvedValue({ rows: [] }),
  listTables: vi.fn().mockResolvedValue([]),
  generateSchemaSyncPlan: vi.fn(),
  executeScriptWith2pc: vi.fn(),
  getObjectSource: vi.fn(),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

const sessionMocks = vi.hoisted(() => ({
  session: null as SchemaDiffSession | null,
}));

vi.mock("@/composables/useSchemaDiffSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useSchemaDiffSession")>();
  return {
    ...actual,
    getSchemaDiffSession: (id: string | null | undefined) => (id && sessionMocks.session?.id === id ? sessionMocks.session : undefined),
  };
});

vi.mock("@/stores/connectionStore", () => {
  const connections = [
    { id: "pg-src", name: "Postgres Source", db_type: "postgres", driver_profile: "postgres" },
    { id: "pg-tgt", name: "Postgres Target", db_type: "postgres", driver_profile: "postgres" },
  ];
  return {
    useConnectionStore: () => ({
      connections,
      sidebarLayout: { groups: [], order: [] },
      getConfig: (id: string) => connections.find((connection) => connection.id === id),
      ensureConnected: mocks.ensureConnected,
    }),
  };
});

vi.mock("@/lib/backend/api", () => ({
  executeQuery: mocks.executeQuery,
  listTables: mocks.listTables,
  generateSchemaSyncPlan: mocks.generateSchemaSyncPlan,
  executeScriptWith2pc: mocks.executeScriptWith2pc,
  getObjectSource: mocks.getObjectSource,
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

const mountedApps: App[] = [];

async function flushAsyncSetup() {
  const { nextTick } = await import("vue");
  for (let index = 0; index < 8; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mountDialog(session?: SchemaDiffSession): App {
  sessionMocks.session = session ?? null;
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () => h(SchemaDiffDialog, { open: true, sessionId: session?.id ?? null }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  return app;
}

function runningSession(): SchemaDiffSession {
  return {
    id: "diff-session",
    version: 1,
    status: "running",
    config: {
      sourceConnectionId: "pg-src",
      sourceDatabase: "srcdb",
      sourceSchema: "public",
      targetConnectionId: "pg-tgt",
      targetDatabase: "tgtdb",
      targetSchema: "public",
      sourceDbType: "postgres",
      targetDbType: "postgres",
      sourceEngineDbType: "postgres",
      targetEngineDbType: "postgres",
      options: { tables: true },
      ignoreComments: false,
      label: "src -> tgt",
    },
    progress: { phase: "loading-table-lists" },
    result: null,
    error: null,
    startedAt: 1,
  } as unknown as SchemaDiffSession;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  sessionMocks.session = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("SchemaDiffDialog wizard rendering", () => {
  it("renders the config step for a fresh open", async () => {
    installLocalStorage();
    mountDialog();
    await flushAsyncSetup();

    // Header title plus the config step's connection selectors are present.
    expect(document.body.textContent).toContain(i18n.global.t("diff.title"));
    const triggers = [...document.querySelectorAll<HTMLButtonElement>("button")];
    expect(triggers.length).toBeGreaterThan(0);
    // No footer navigation buttons before a result exists.
    expect(document.body.textContent).not.toContain(i18n.global.t("diff.prevStep"));
  });

  it("renders the compare progress step for a running session", async () => {
    installLocalStorage();
    mountDialog(runningSession());
    await flushAsyncSetup();

    expect(document.body.textContent).toContain(i18n.global.t("diff.progress.loadingObjects"));
  });
});
