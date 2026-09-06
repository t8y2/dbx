// @vitest-environment happy-dom

import { createApp, defineComponent, h, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ExternalSqlFileTooLargeError } from "@/lib/sql/sqlFileOpen";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  store: {
    connections: [] as { id: string }[],
    sqlFileSource: null as { connectionId: string; database: string; filePath?: string } | null,
    getConfig: vi.fn(),
  },
}));

vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => mocks.store }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

import { useLargeSqlFileStreamingFallback } from "@/composables/useLargeSqlFileFallback";

const mountedApps: App[] = [];

beforeEach(() => {
  mocks.store.connections = [];
  mocks.store.sqlFileSource = null;
  mocks.store.getConfig.mockReset().mockReturnValue(undefined);
  mocks.toast.mockReset();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
});

function withComposable<T>(run: (fallback: ReturnType<typeof useLargeSqlFileStreamingFallback>) => T): T {
  let result!: T;
  const component = defineComponent({
    setup() {
      const fallback = useLargeSqlFileStreamingFallback();
      result = run(fallback);
      return () => h("div");
    },
  });
  // The composable reads i18n/store in setup, so mount a host component that
  // invokes it and hands the result back to the test.
  const app = createApp(component);
  app.use(i18n);
  mountedApps.push(app);
  app.mount(document.createElement("div"));
  return result;
}

describe("useLargeSqlFileStreamingFallback", () => {
  it("routes oversized sql files to the streaming executor dialog", () => {
    const outcome = withComposable((fallback) => {
      const handled = fallback.openInStreamingExecutorOnTooLarge("/tmp/dbx_export.sql", new ExternalSqlFileTooLargeError(100 * 1024 * 1024, 64 * 1024 * 1024));
      return { handled, error: null as unknown };
    });

    expect(outcome.handled).toBe(true);
    expect(mocks.store.sqlFileSource).toEqual({
      connectionId: "",
      database: "",
      filePath: "/tmp/dbx_export.sql",
    });
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(String(mocks.toast.mock.calls[0][0])).toContain("100.0 MB");
  });

  it("keeps unrelated open failures as errors", () => {
    const outcome = withComposable((fallback) => fallback.openInStreamingExecutorOnTooLarge("/tmp/dbx_export.sql", new Error("disk failure")));

    expect(outcome).toBe(false);
    expect(mocks.store.sqlFileSource).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("ignores oversized non-sql paths", () => {
    const outcome = withComposable((fallback) => fallback.openInStreamingExecutorOnTooLarge("/tmp/notes.txt", new ExternalSqlFileTooLargeError(100 * 1024 * 1024, 64 * 1024 * 1024)));

    expect(outcome).toBe(false);
    expect(mocks.store.sqlFileSource).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("ignores missing paths", () => {
    const outcome = withComposable((fallback) => fallback.openInStreamingExecutorOnTooLarge(undefined, new ExternalSqlFileTooLargeError(100 * 1024 * 1024, 64 * 1024 * 1024)));

    expect(outcome).toBe(false);
    expect(mocks.store.sqlFileSource).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
