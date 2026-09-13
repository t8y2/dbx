import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import type { DataView, DataViewParamValue, DataViewQuery, DataViewSummary, ExecuteDataViewOptions, ExecuteDataViewResponse } from "@/types/dataView";

function nowIso(): string {
  return new Date().toISOString();
}

/** Input for appending a query from the editor into a (new or existing) view. */
export interface AddQueryInput {
  title: string;
  connectionId: string;
  database?: string;
  catalog?: string | null;
  schema?: string | null;
  sqlTemplate: string;
}

export const useDataViewStore = defineStore("dataView", () => {
  const summaries = ref<DataViewSummary[]>([]);
  const loading = ref(false);
  const loaded = ref(false);
  // Full views cached by id so the runner/editor avoid refetching.
  const cache = ref<Record<string, DataView>>({});

  const sortedSummaries = computed(() => [...summaries.value].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      summaries.value = await api.listDataViews();
      loaded.value = true;
    } finally {
      loading.value = false;
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded.value && !loading.value) await refresh();
  }

  async function get(id: string, force = false): Promise<DataView | null> {
    if (!force && cache.value[id]) return cache.value[id];
    const view = await api.loadDataView(id);
    if (view) cache.value[id] = view;
    return view;
  }

  async function save(view: DataView): Promise<DataView> {
    const saved = await api.saveDataView({ ...view, updatedAt: nowIso() });
    cache.value[saved.id] = saved;
    upsertSummary(saved);
    return saved;
  }

  async function remove(id: string): Promise<void> {
    await api.deleteDataView(id);
    delete cache.value[id];
    summaries.value = summaries.value.filter((s) => s.id !== id);
  }

  function upsertSummary(view: DataView): void {
    const summary: DataViewSummary = {
      id: view.id,
      name: view.name,
      description: view.description ?? null,
      defaultDisplayMode: view.defaultDisplayMode,
      queryCount: view.queries.length,
      ownerId: view.ownerId ?? null,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
    const index = summaries.value.findIndex((s) => s.id === view.id);
    if (index >= 0) summaries.value.splice(index, 1, summary);
    else summaries.value.push(summary);
  }

  function newView(name: string, description?: string): DataView {
    const ts = nowIso();
    return {
      id: uuid(),
      name,
      description: description ?? null,
      defaultDisplayMode: "table",
      queries: [],
      variables: [],
      ownerId: null,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  function makeQuery(input: AddQueryInput, orderIndex: number): DataViewQuery {
    return {
      id: uuid(),
      title: input.title,
      connectionId: input.connectionId,
      database: input.database ?? "",
      catalog: input.catalog ?? null,
      schema: input.schema ?? null,
      sqlTemplate: input.sqlTemplate,
      kind: "query",
      displayMode: null,
      orderIndex,
    };
  }

  /** Creates a new view seeded with one or more queries from the editor (e.g. a multi-statement tab). */
  async function createFromQueries(name: string, description: string | undefined, queries: AddQueryInput[]): Promise<DataView> {
    const view = newView(name, description);
    queries.forEach((query, index) => view.queries.push(makeQuery(query, index)));
    return save(view);
  }

  /** Appends one or more queries to an existing view. */
  async function addQueriesToView(viewId: string, queries: AddQueryInput[]): Promise<DataView> {
    const view = await get(viewId, true);
    if (!view) throw new Error("data view not found");
    const startIndex = view.queries.length;
    queries.forEach((query, index) => view.queries.push(makeQuery(query, startIndex + index)));
    return save(view);
  }

  /** Imports a view from an export file as a brand-new view: fresh view/query ids, everything else preserved. */
  async function importDataView(source: DataView): Promise<DataView> {
    const view = newView(source.name, source.description ?? undefined);
    view.defaultDisplayMode = source.defaultDisplayMode;
    view.variables = source.variables.map((variable) => ({ ...variable }));
    view.queries = source.queries.map((query, index) => ({ ...query, id: uuid(), orderIndex: index }));
    return save(view);
  }

  async function execute(id: string, variables: Record<string, DataViewParamValue>, options: ExecuteDataViewOptions = {}): Promise<ExecuteDataViewResponse> {
    return api.executeDataView(id, variables, options);
  }

  return {
    summaries,
    sortedSummaries,
    loading,
    loaded,
    cache,
    refresh,
    ensureLoaded,
    get,
    save,
    remove,
    newView,
    makeQuery,
    createFromQueries,
    addQueriesToView,
    importDataView,
    execute,
  };
});
