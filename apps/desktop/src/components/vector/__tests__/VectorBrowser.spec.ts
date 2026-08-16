// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionInfo, MilvusFieldInfo } from "@/types/database";

const backend = vi.hoisted(() => ({
  cancelQuery: vi.fn(),
  executeMulti: vi.fn(),
  vectorGetCollectionDetail: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/api", () => backend);
vi.mock("@lucide/vue", async () => {
  const { defineComponent, h } = await import("vue");
  const Icon = defineComponent({ setup: () => () => h("i") });
  return { Play: Icon, RefreshCcw: Icon, RotateCcw: Icon, Save: Icon, Search: Icon, Trash2: Icon };
});
vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup(_, { attrs, slots }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
  };
});
vi.mock("@/components/common/QueryLoadingState.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      emits: ["cancel"],
      setup(_, { emit }) {
        return () => h("button", { onClick: () => emit("cancel") }, "cancel");
      },
    }),
  };
});
vi.mock("@/components/ui/ErrorBanner.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ setup: () => () => h("div") }) };
});
vi.mock("@/components/grid/DataGrid.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { __esModule: true, default: defineComponent({ setup: () => () => h("div") }) };
});

import VectorBrowser from "@/components/vector/VectorBrowser.vue";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...root!.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function requestBody() {
  const request = root!.querySelector<HTMLTextAreaElement>("textarea")!.value;
  return JSON.parse(request.slice(request.indexOf("\n") + 1));
}

function field(name: string, dataType: string, overrides: Partial<MilvusFieldInfo> = {}): MilvusFieldInfo {
  return { name, dataType, primaryKey: false, autoId: false, nullable: false, hasDefaultValue: false, isFunctionOutput: false, ...overrides };
}

beforeEach(() => {
  backend.cancelQuery.mockReset();
  backend.executeMulti.mockReset();
  backend.vectorGetCollectionDetail.mockReset();
  backend.cancelQuery.mockResolvedValue(false);
  backend.executeMulti.mockResolvedValue([{ columns: [], column_types: [], column_sortables: [], rows: [], affected_rows: 0, execution_time_ms: 0 }]);
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.unmount();
  app = null;
  root?.remove();
  root = null;
  document.body.innerHTML = "";
});

describe("VectorBrowser default requests", () => {
  it("keeps non-Milvus browse defaults schema-free", async () => {
    for (const [databaseType, expected] of [
      ["qdrant", "POST /collections/demo/points/scroll"],
      ["weaviate", "GET /v1/objects?class=demo&limit=100"],
      ["chromadb", "POST /api/v2/tenants/default_tenant/databases/default_database/collections/demo/get"],
    ] as const) {
      const database = databaseType === "chromadb" ? "default_database" : "default";
      app = createApp(VectorBrowser, { connectionId: "vector-1", database, collection: "demo", databaseType });
      app.mount(root!);
      await flushUi();
      expect(root!.querySelector<HTMLTextAreaElement>("textarea")!.value).toContain(expected);
      app.unmount();
      app = null;
      root!.replaceChildren();
    }
    expect(backend.vectorGetCollectionDetail).not.toHaveBeenCalled();
  });

  it("uses the configured Chroma Cloud namespace in generated requests", async () => {
    app = createApp(VectorBrowser, {
      connectionId: "chroma-cloud-1",
      database: "support/kb",
      collection: "collection/id",
      databaseType: "chromadb",
      tenant: "tenant /eu",
    });
    app.mount(root!);
    await flushUi();

    const prefix = "/api/v2/tenants/tenant%20%2Feu/databases/support%2Fkb/collections/collection%2Fid";
    expect(root!.querySelector<HTMLTextAreaElement>("textarea")!.value).toContain(`POST ${prefix}/get`);

    for (const [button, operation] of [
      ["vector.search", "query"],
      ["vector.upsert", "upsert"],
      ["vector.delete", "delete"],
    ] as const) {
      buttonWithText(button).click();
      await nextTick();
      expect(root!.querySelector<HTMLTextAreaElement>("textarea")!.value).toContain(`POST ${prefix}/${operation}`);
    }
  });

  it("resolves the schema before executing a generated upsert request", async () => {
    let resolveDetail: (value: CollectionInfo) => void;
    backend.vectorGetCollectionDetail.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );

    app = createApp(VectorBrowser, {
      connectionId: "milvus-1",
      database: "default",
      collection: "script_milvus_crud_demo",
      databaseType: "milvus",
    });
    app.mount(root!);
    await nextTick();

    buttonWithText("vector.upsert").click();
    await nextTick();
    buttonWithText("vector.apply").click();
    await nextTick();
    expect(requestBody().data).toEqual([{}]);
    expect(root!.querySelector<HTMLTextAreaElement>("textarea")!.readOnly).toBe(true);
    expect(backend.executeMulti).not.toHaveBeenCalled();
    expect(backend.vectorGetCollectionDetail).toHaveBeenCalledTimes(1);

    resolveDetail!({
      name: "script_milvus_crud_demo",
      id: "script_milvus_crud_demo",
      dimension: 4,
      milvusSchema: { fields: [field("id", "Int64", { primaryKey: true }), field("embedding", "FloatVector", { dimension: 4 })] },
    });
    await flushUi();

    const request = root!.querySelector<HTMLTextAreaElement>("textarea")!.value;
    expect(request).toContain('"embedding"');
    expect(request).not.toContain('"vector"');
    expect(backend.executeMulti.mock.calls[0][2]).toContain('"embedding"');
  });

  it("generates a default entity from required schema fields", async () => {
    backend.vectorGetCollectionDetail.mockResolvedValue({
      name: "documents",
      id: "documents",
      dimension: 3,
      milvusSchema: {
        fields: [
          field("document_id", "VarChar", { primaryKey: true }),
          field("embedding", "FloatVector", { dimension: 3 }),
          field("keywords", "SparseFloatVector"),
          field("rating", "Double"),
          field("metadata", "JSON"),
          field("tags", "Array"),
          field("optional_note", "VarChar", { nullable: true }),
          field("status", "VarChar", { hasDefaultValue: true }),
          field("bm25", "SparseFloatVector", { isFunctionOutput: true }),
        ],
      },
    });

    app = createApp(VectorBrowser, {
      connectionId: "milvus-1",
      database: "default",
      collection: "documents",
      databaseType: "milvus",
      dimension: 9,
    });
    app.mount(root!);
    await flushUi();

    buttonWithText("vector.upsert").click();
    await nextTick();

    expect(requestBody().data[0]).toEqual({
      document_id: "x",
      embedding: [0.1, 0.2, 0.3],
      keywords: { "0": 0.1 },
      rating: 0.1,
      metadata: {},
      tags: [],
    });
  });

  it("keeps an auto-generated primary key in the default upsert entity", async () => {
    backend.vectorGetCollectionDetail.mockResolvedValue({
      name: "documents",
      id: "documents",
      milvusSchema: {
        fields: [field("document_id", "Int64", { primaryKey: true, autoId: true }), field("embedding", "FloatVector", { dimension: 3 })],
      },
    });

    app = createApp(VectorBrowser, {
      connectionId: "milvus-1",
      database: "default",
      collection: "documents",
      databaseType: "milvus",
    });
    app.mount(root!);
    await flushUi();

    buttonWithText("vector.upsert").click();
    await nextTick();

    expect(requestBody().data[0]).toEqual({ document_id: 1, embedding: [0.1, 0.2, 0.3] });
  });

  it("uses a BM25 function output field for full-text search", async () => {
    backend.vectorGetCollectionDetail.mockResolvedValue({
      name: "documents",
      id: "documents",
      milvusSchema: {
        fields: [field("document_id", "Int64", { primaryKey: true }), field("text", "VarChar"), field("sparse", "SparseFloatVector", { isFunctionOutput: true })],
      },
    });

    app = createApp(VectorBrowser, {
      connectionId: "milvus-1",
      database: "default",
      collection: "documents",
      databaseType: "milvus",
    });
    app.mount(root!);
    await flushUi();

    buttonWithText("vector.search").click();
    await nextTick();

    expect(requestBody()).toMatchObject({ annsField: "sparse", data: ["x"] });

    const searchButtons = [...root!.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "vector.search");
    searchButtons[searchButtons.length - 1].click();
    await flushUi();
    expect(backend.executeMulti).toHaveBeenCalledTimes(1);
  });

  it("keeps a custom request when the schema arrives", async () => {
    let resolveDetail: (value: CollectionInfo) => void;
    backend.vectorGetCollectionDetail.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );

    app = createApp(VectorBrowser, {
      connectionId: "milvus-1",
      database: "default",
      collection: "documents",
      databaseType: "milvus",
    });
    app.mount(root!);
    await nextTick();

    buttonWithText("vector.upsert").click();
    await nextTick();
    const editor = root!.querySelector<HTMLTextAreaElement>("textarea")!;
    const customRequest = 'POST /v2/vectordb/entities/upsert\n{"collectionName":"documents","data":[{"id":7,"embedding":[1,2,3]}]}';
    editor.value = customRequest;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    resolveDetail!({
      name: "documents",
      id: "documents",
      milvusSchema: { fields: [field("id", "Int64", { primaryKey: true }), field("embedding", "FloatVector", { dimension: 3 })] },
    });
    await flushUi();

    expect(editor.value).toBe(customRequest);
  });

  it("does not send a generated request when schema discovery fails", async () => {
    backend.vectorGetCollectionDetail.mockRejectedValue(new Error("schema unavailable"));

    app = createApp(VectorBrowser, {
      connectionId: "milvus-1",
      database: "default",
      collection: "documents",
      databaseType: "milvus",
    });
    app.mount(root!);
    await flushUi();

    buttonWithText("vector.upsert").click();
    await nextTick();
    buttonWithText("vector.apply").click();
    await flushUi();

    expect(backend.executeMulti).not.toHaveBeenCalled();
  });

  it("does not execute a generated request after cancellation during schema loading", async () => {
    let resolveDetail: (value: CollectionInfo) => void;
    backend.vectorGetCollectionDetail.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );

    app = createApp(VectorBrowser, {
      connectionId: "milvus-1",
      database: "default",
      collection: "documents",
      databaseType: "milvus",
    });
    app.mount(root!);
    await nextTick();

    buttonWithText("vector.upsert").click();
    await nextTick();
    buttonWithText("vector.apply").click();
    await nextTick();
    buttonWithText("cancel").click();
    await flushUi();

    resolveDetail!({
      name: "documents",
      id: "documents",
      milvusSchema: { fields: [field("id", "Int64", { primaryKey: true }), field("embedding", "FloatVector", { dimension: 3 })] },
    });
    await flushUi();

    expect(backend.executeMulti).not.toHaveBeenCalled();
  });

  it("does not execute a generated request after the browser unmounts", async () => {
    let resolveDetail: (value: CollectionInfo) => void;
    backend.vectorGetCollectionDetail.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );

    app = createApp(VectorBrowser, {
      connectionId: "milvus-1",
      database: "default",
      collection: "documents",
      databaseType: "milvus",
    });
    app.mount(root!);
    await nextTick();

    buttonWithText("vector.upsert").click();
    await nextTick();
    buttonWithText("vector.apply").click();
    await nextTick();
    app.unmount();
    app = null;

    resolveDetail!({
      name: "documents",
      id: "documents",
      milvusSchema: { fields: [field("id", "Int64", { primaryKey: true }), field("embedding", "FloatVector", { dimension: 3 })] },
    });
    await flushUi();

    expect(backend.executeMulti).not.toHaveBeenCalled();
  });

  it("does not execute a generated request after the collection changes", async () => {
    let resolveDetail: (value: CollectionInfo) => void;
    const collection = ref("documents");
    backend.vectorGetCollectionDetail.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );

    app = createApp(
      defineComponent({
        setup: () => () => h(VectorBrowser, { connectionId: "milvus-1", database: "default", collection: collection.value, databaseType: "milvus" }),
      }),
    );
    app.mount(root!);
    await nextTick();

    buttonWithText("vector.upsert").click();
    await nextTick();
    buttonWithText("vector.apply").click();
    await nextTick();
    collection.value = "other_documents";
    await nextTick();

    resolveDetail!({
      name: "documents",
      id: "documents",
      milvusSchema: { fields: [field("id", "Int64", { primaryKey: true }), field("embedding", "FloatVector", { dimension: 3 })] },
    });
    await flushUi();

    expect(backend.executeMulti).not.toHaveBeenCalled();
  });

  it("keeps a custom search request when the schema arrives", async () => {
    let resolveDetail: (value: CollectionInfo) => void;
    backend.vectorGetCollectionDetail.mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );

    app = createApp(VectorBrowser, {
      connectionId: "milvus-1",
      database: "default",
      collection: "documents",
      databaseType: "milvus",
    });
    app.mount(root!);
    await nextTick();

    buttonWithText("vector.search").click();
    await nextTick();
    const editor = root!.querySelector<HTMLTextAreaElement>("textarea")!;
    const customRequest = 'POST /v2/vectordb/entities/search\n{"collectionName":"documents","data":[[1,2,3]]}';
    editor.value = customRequest;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    resolveDetail!({
      name: "documents",
      id: "documents",
      milvusSchema: { fields: [field("id", "Int64", { primaryKey: true }), field("embedding", "FloatVector", { dimension: 3 })] },
    });
    await flushUi();

    expect(editor.value).toBe(customRequest);
  });

  it("uses the schema primary key and vector field for delete and search defaults", async () => {
    backend.vectorGetCollectionDetail.mockResolvedValue({
      name: "documents",
      id: "documents",
      milvusSchema: { fields: [field("document_id", "VarChar", { primaryKey: true }), field("embedding", "FloatVector", { dimension: 3 })] },
    });

    app = createApp(VectorBrowser, {
      connectionId: "milvus-1",
      database: "default",
      collection: "documents",
      databaseType: "milvus",
    });
    app.mount(root!);
    await flushUi();

    buttonWithText("vector.delete").click();
    await nextTick();
    expect(requestBody().filter).toBe('document_id in ["x"]');

    buttonWithText("vector.search").click();
    await nextTick();
    expect(requestBody()).toMatchObject({ annsField: "embedding", data: [[0.1, 0.2, 0.3]] });
  });
});
