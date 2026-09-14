// @vitest-environment happy-dom

import { defineComponent, h, nextTick, ref } from "vue";
import { createApp } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MongoImportPreview } from "@/lib/backend/api";

const api = vi.hoisted(() => ({
  previewMongodbImportFile: vi.fn(),
  importMongodbFile: vi.fn(),
  cancelMongodbImport: vi.fn(),
  releaseMongodbImportSource: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => api);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: () => ({ id: "c1", name: "mongo", read_only: false }), mongoImportCompleted: null }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({
  executeWithProductionContextGuard: async ({ execute }: { execute: () => Promise<unknown> }) => execute(),
}));

import MongoImportDialog from "../MongoImportDialog.vue";

function previewResult(overrides: Partial<MongoImportPreview> = {}): MongoImportPreview {
  return {
    sourceRef: "src-1",
    format: "csv",
    fileName: "orders.csv",
    filePath: "/tmp/orders.csv",
    sizeBytes: 12,
    columns: [{ name: "id", inferredType: "string" }],
    rows: [{ id: "1" }],
    warnings: [],
    errors: [],
    estimatedRows: 1,
    estimatedRowsExact: true,
    ...overrides,
  };
}

describe("MongoImportDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.previewMongodbImportFile.mockReset().mockResolvedValue(previewResult());
    api.releaseMongodbImportSource.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("keeps the collection target in the wizard", async () => {
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(MongoImportDialog, {
              open: true,
              connectionId: "c1",
              database: "shop",
              collection: "orders",
            });
        },
      }),
    );
    app.mount(document.body);
    await nextTick();
    expect(document.body.textContent).toContain("shop.orders");
    app.unmount();
  });

  it("reuses the uploaded sourceRef on later previews and releases it on close", async () => {
    const open = ref(true);
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(MongoImportDialog, {
              open: open.value,
              "onUpdate:open": (value: boolean) => {
                open.value = value;
              },
              connectionId: "c1",
              database: "shop",
              collection: "orders",
            });
        },
      }),
    );
    app.mount(document.body);
    await nextTick();

    const input = document.querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["id\n1"], "orders.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();

    expect(api.previewMongodbImportFile).toHaveBeenCalledTimes(1);
    const firstSource = api.previewMongodbImportFile.mock.calls[0]?.[0];
    expect(firstSource).toBeInstanceOf(File);
    expect((firstSource as File).name).toBe("orders.csv");
    expect(api.previewMongodbImportFile.mock.calls[0]?.[1]).toMatchObject({ sourceRef: null });

    const header = document.querySelector("input[type='checkbox']") as HTMLInputElement;
    header.click();
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await nextTick();

    expect(api.previewMongodbImportFile).toHaveBeenCalledTimes(2);
    expect(api.previewMongodbImportFile.mock.calls[1]?.[0]).toBe("/tmp/orders.csv");
    expect(api.previewMongodbImportFile.mock.calls[1]?.[1]).toMatchObject({ sourceRef: "src-1" });

    open.value = false;
    await nextTick();
    expect(api.releaseMongodbImportSource).toHaveBeenCalledWith("src-1");
    app.unmount();
  });
});
