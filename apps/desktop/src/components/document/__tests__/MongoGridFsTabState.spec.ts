// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  documentListGridFsBuckets: vi.fn(),
  documentListGridFsFiles: vi.fn(),
}));

const settings = vi.hoisted(() => ({
  editorSettings: {
    pageSize: 50,
    tableOpenPageSize: 50,
    infiniteScroll: false,
    tableFontFamily: "system-ui",
    tableFontSize: 12,
  },
  updateEditorSettings: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  documentListGridFsBuckets: backend.documentListGridFsBuckets,
  documentListGridFsFiles: backend.documentListGridFsFiles,
  documentCreateGridFsBucket: vi.fn(),
  documentDeleteGridFsBucket: vi.fn(),
  documentUploadGridFsFile: vi.fn(),
  documentDownloadGridFsFile: vi.fn(),
  documentDeleteGridFsFile: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: () => ({}), ensureConnected: vi.fn() }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ openMongoBucket: vi.fn() }),
}));

vi.mock("@/stores/settingsStore", () => ({
  TABLE_FONT_SIZE_MIN: 8,
  TABLE_FONT_SIZE_MAX: 16,
  useSettingsStore: () => settings,
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

function passthroughStub(name: string) {
  return defineComponent({
    name,
    inheritAttrs: false,
    setup(_, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
}

vi.mock("@/components/ui/popover", () => ({
  Popover: passthroughStub("PopoverStub"),
  PopoverTrigger: passthroughStub("PopoverTriggerStub"),
  PopoverContent: passthroughStub("PopoverContentStub"),
}));

vi.mock("@/components/ui/select", () => ({
  Select: passthroughStub("SelectStub"),
  SelectContent: passthroughStub("SelectContentStub"),
  SelectItem: passthroughStub("SelectItemStub"),
  SelectTrigger: passthroughStub("SelectTriggerStub"),
  SelectValue: passthroughStub("SelectValueStub"),
}));

import MongoGridFsBrowser from "@/components/document/MongoGridFsBrowser.vue";
import MongoBucketBrowser from "@/components/document/MongoBucketBrowser.vue";
import { resetBrowserStateCaches } from "@/lib/tabs/documentBrowserStateCache";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  for (let index = 0; index < 4; index++) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mount(component: unknown, props: Record<string, unknown>) {
  app = createApp(component as Parameters<typeof createApp>[0], props);
  app.mount(root!);
  await flushUi();
}

async function remount(component: unknown, props: Record<string, unknown>) {
  app!.unmount();
  app = null;
  root!.replaceChildren();
  await flushUi();
  await mount(component, props);
}

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  backend.documentListGridFsBuckets.mockReset();
  backend.documentListGridFsFiles.mockReset();
  backend.documentListGridFsBuckets.mockResolvedValue([{ name: "fs", fileCount: 2, totalBytes: 100 }]);
  backend.documentListGridFsFiles.mockResolvedValue([
    { id: "1", filename: "a.txt", length: 10, chunkSize: 1, uploadDate: "2026-01-01T00:00:00Z", metadata: null },
    { id: "2", filename: "b.txt", length: 20, chunkSize: 1, uploadDate: "2026-01-02T00:00:00Z", metadata: null },
  ]);
  resetBrowserStateCaches();

  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = null;
  root = null;
  vi.unstubAllGlobals();
});

describe("MongoGridFsBrowser tab state", () => {
  const props = { connectionId: "conn-1", database: "test", stateKey: "gridfs-tab" };

  it("does not re-list buckets when a tab switch remounts the browser", async () => {
    await mount(MongoGridFsBrowser, props);
    expect(backend.documentListGridFsBuckets).toHaveBeenCalledTimes(1);

    await remount(MongoGridFsBrowser, props);
    expect(backend.documentListGridFsBuckets).toHaveBeenCalledTimes(1);
  });

  it("re-lists when no state key ties the tab to a snapshot", async () => {
    await mount(MongoGridFsBrowser, { connectionId: "conn-1", database: "test" });
    await remount(MongoGridFsBrowser, { connectionId: "conn-1", database: "test" });

    expect(backend.documentListGridFsBuckets).toHaveBeenCalledTimes(2);
  });

  it("re-lists when the previous load failed", async () => {
    backend.documentListGridFsBuckets.mockReset();
    backend.documentListGridFsBuckets.mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]);

    await mount(MongoGridFsBrowser, props);
    await remount(MongoGridFsBrowser, props);

    expect(backend.documentListGridFsBuckets).toHaveBeenCalledTimes(2);
  });
});

describe("MongoBucketBrowser tab state", () => {
  const props = { connectionId: "conn-1", database: "test", bucket: "fs", stateKey: "bucket-tab" };

  it("does not re-list files when a tab switch remounts the browser", async () => {
    await mount(MongoBucketBrowser, props);
    expect(backend.documentListGridFsFiles).toHaveBeenCalledTimes(1);

    await remount(MongoBucketBrowser, props);
    expect(backend.documentListGridFsFiles).toHaveBeenCalledTimes(1);
  });

  it("re-lists when the bucket changed", async () => {
    await mount(MongoBucketBrowser, props);
    await remount(MongoBucketBrowser, { ...props, bucket: "other" });

    expect(backend.documentListGridFsFiles).toHaveBeenCalledTimes(2);
  });

  it("keeps the filter condition across a remount and re-lists under it", async () => {
    await mount(MongoBucketBrowser, props);

    const filterInput = root!.querySelector<HTMLInputElement>('input[placeholder="{}"]');
    expect(filterInput).not.toBeNull();
    filterInput!.value = '{"filename":"a.txt"}';
    filterInput!.dispatchEvent(new Event("input", { bubbles: true }));
    filterInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushUi();
    expect(backend.documentListGridFsFiles).toHaveBeenCalledTimes(2);

    await remount(MongoBucketBrowser, props);

    // The condition survives, and the cached listing means no third request.
    const restoredFilter = root!.querySelector<HTMLInputElement>('input[placeholder="{}"]');
    expect(restoredFilter?.value).toBe('{"filename":"a.txt"}');
    expect(backend.documentListGridFsFiles).toHaveBeenCalledTimes(2);
  });
});
