import { computed, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { favoriteTargetKey, sortFavorites } from "@/lib/favorites/target";
import type { CreatedTableFavorite, CreateTableFavorite, FavoriteTarget, RelinkTableFavorite, TableFavorite, UpdateTableFavorite } from "@/types/favorites";

export type FavoriteDialogState = { mode: "create"; target: FavoriteTarget } | { mode: "edit"; item: TableFavorite; remove?: boolean } | { mode: "relink"; item: TableFavorite; target: FavoriteTarget };

export const useFavoritesStore = defineStore("tableFavorites", () => {
  const items = ref<TableFavorite[]>([]);
  const initialized = ref(false);
  const loading = ref(false);
  const error = ref("");
  const pending = ref(0);
  const resetVersion = ref(0);
  const dialog = shallowRef<FavoriteDialogState | null>(null);
  const relinking = shallowRef<TableFavorite | null>(null);
  const byTarget = computed(() => new Map(items.value.map((item) => [favoriteTargetKey(item), item])));
  const sorted = computed(() => sortFavorites(items.value));
  let context = 0;
  let generation = 0;
  let flight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    if (flight) return flight;
    const requestGeneration = generation;
    const requestContext = context;
    loading.value = true;
    const task = api
      .listTableFavorites()
      .then((result) => {
        if (requestGeneration !== generation || requestContext !== context) return;
        items.value = result.items;
        initialized.value = true;
        error.value = "";
      })
      .catch((reason: unknown) => {
        if (requestGeneration === generation && requestContext === context) error.value = formatError(reason);
      })
      .finally(() => {
        if (flight === task) {
          flight = null;
          loading.value = false;
        }
      });
    flight = task;
    return task;
  }

  function invalidateList() {
    generation += 1;
    flight = null;
    loading.value = false;
  }

  async function mutate<T>(operation: () => Promise<T>, apply: (result: T) => void): Promise<T> {
    const requestContext = context;
    pending.value += 1;
    try {
      const result = await operation();
      if (requestContext !== context) throw new Error("FAVORITE_CONTEXT_CHANGED");
      invalidateList();
      apply(result);
      initialized.value = true;
      error.value = "";
      return result;
    } finally {
      if (requestContext === context) {
        pending.value -= 1;
        // Reconcile both successful writes and ambiguous timeouts. Never retry a write blindly.
        invalidateList();
        void refresh();
      }
    }
  }

  function upsert(item: TableFavorite) {
    if (items.value.some((existing) => existing.id === item.id && existing.revision > item.revision)) return;
    items.value = [...items.value.filter((existing) => existing.id !== item.id), item];
  }

  function create(input: CreateTableFavorite): Promise<CreatedTableFavorite> {
    return mutate(
      () => api.createTableFavorite(input),
      (result) => upsert(result.item),
    );
  }
  function update(id: string, input: UpdateTableFavorite): Promise<TableFavorite> {
    return mutate(() => api.updateTableFavorite(id, input), upsert);
  }
  function relink(id: string, input: RelinkTableFavorite): Promise<TableFavorite> {
    return mutate(() => api.relinkTableFavorite(id, input), upsert);
  }
  function remove(item: TableFavorite): Promise<void> {
    return mutate(
      () => api.removeTableFavorite(item.id, item.revision),
      () => {
        items.value = items.value.filter((existing) => existing.id !== item.id);
      },
    );
  }

  async function addTarget(target: FavoriteTarget) {
    const requestContext = context;
    await refresh();
    if (requestContext !== context) return;
    const item = byTarget.value.get(favoriteTargetKey(target));
    dialog.value = item ? { mode: "edit", item: { ...item } } : { mode: "create", target };
  }

  function reset() {
    context += 1;
    resetVersion.value += 1;
    invalidateList();
    items.value = [];
    initialized.value = false;
    error.value = "";
    pending.value = 0;
    dialog.value = null;
    relinking.value = null;
  }

  return { items, sorted, byTarget, initialized, loading, error, pending, resetVersion, dialog, relinking, refresh, create, update, relink, remove, addTarget, reset };
});
