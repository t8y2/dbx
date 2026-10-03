<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Star, Pencil, Link, RefreshCw, Trash2 } from "@lucide/vue";
import { useFavoritesStore } from "@/stores/favoritesStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useFavoriteOpen } from "@/composables/useFavoriteOpen";
import { favoritePath } from "@/lib/favorites/target";
import { favoriteErrorMessage } from "@/lib/favorites/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { TableFavorite } from "@/types/favorites";

const { t } = useI18n();
const store = useFavoritesStore();
const connections = useConnectionStore();
const opener = useFavoriteOpen();
const shown = ref(false);
const search = ref("");
const selected = ref(0);
const opening = ref(false);
const failure = ref<{ item: TableFavorite; message: string } | null>(null);
const list = ref<HTMLElement>();
watch(
  () => store.resetVersion,
  () => {
    shown.value = false;
    failure.value = null;
    search.value = "";
  },
);
const filtered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return store.sorted.filter((item) => [item.code, item.name, item.objectName, item.catalog, item.database, item.schema, connections.getConfig(item.connectionId)?.name || ""].join("\n").toLocaleLowerCase().includes(query));
});
watch(shown, (open) => {
  if (open) {
    search.value = "";
    selected.value = 0;
    void store.refresh();
  }
});
watch(filtered, () => {
  selected.value = Math.min(selected.value, Math.max(0, filtered.value.length - 1));
});
function path(item: TableFavorite) {
  return favoritePath(item, connections.getConfig(item.connectionId)?.name || t("favorites.connectionMissing"));
}
async function open(item: TableFavorite) {
  if (opening.value) return;
  const context = store.resetVersion;
  opening.value = true;
  failure.value = null;
  try {
    await opener.open(item);
    shown.value = false;
  } catch (reason) {
    if (context !== store.resetVersion) return;
    shown.value = false;
    failure.value = { item, message: favoriteErrorMessage(reason, t) };
  } finally {
    opening.value = false;
  }
}
async function keydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!filtered.value.length) return;
    selected.value = event.target instanceof HTMLInputElement ? (event.key === "ArrowDown" ? 0 : filtered.value.length - 1) : (selected.value + (event.key === "ArrowDown" ? 1 : -1) + filtered.value.length) % filtered.value.length;
    await nextTick();
    list.value?.querySelectorAll<HTMLElement>("[data-favorite-open]")[selected.value]?.focus();
  }
}
function edit(item: TableFavorite) {
  shown.value = false;
  failure.value = null;
  store.dialog = { mode: "edit", item: { ...item } };
}
function remove(item: TableFavorite) {
  shown.value = false;
  failure.value = null;
  store.dialog = { mode: "edit", item: { ...item }, remove: true };
}
function relink(item: TableFavorite) {
  shown.value = false;
  failure.value = null;
  store.relinking = { ...item };
}
</script>

<template>
  <Popover v-model:open="shown">
    <PopoverTrigger as-child
      ><Button variant="ghost" size="sm" class="h-8 shrink-0 gap-1" :aria-label="t('favorites.title')"
        ><Star class="h-3.5 w-3.5" /><span>{{ t("favorites.title") }}</span
        ><span v-if="store.relinking" class="h-2 w-2 rounded-full bg-primary" /></Button
    ></PopoverTrigger>
    <PopoverContent align="start" class="w-[420px] max-w-[calc(100vw-16px)] p-3" @keydown="keydown">
      <div class="flex gap-2">
        <Input v-model="search" :placeholder="t('favorites.search')" :aria-label="t('favorites.search')" @keydown.enter.prevent="filtered[selected] && open(filtered[selected])" /><Button variant="ghost" size="icon" :aria-label="t('favorites.refresh')" :disabled="store.loading" @click="store.refresh"
          ><RefreshCw class="h-4 w-4"
        /></Button>
      </div>
      <p v-if="store.error" role="alert" class="mt-2 break-words text-xs text-destructive">{{ store.error }}</p>
      <p v-if="store.loading && !store.initialized" role="status" class="p-4 text-muted-foreground">{{ t("favorites.loading") }}</p>
      <p v-else-if="!filtered.length && !store.error" class="p-4 text-muted-foreground">{{ t(search ? "favorites.noMatches" : "favorites.empty") }}</p>
      <div ref="list" class="mt-2 flex max-h-80 flex-col gap-1 overflow-y-auto py-1" :aria-label="t('favorites.title')">
        <div v-for="(item, index) in filtered" :key="item.id" class="flex shrink-0 items-center rounded hover:bg-accent focus-within:bg-accent">
          <button data-favorite-open type="button" class="min-w-0 flex-1 p-2 text-left" :disabled="opening" @focus="selected = index" @click="open(item)">
            <span class="block truncate text-sm">{{ item.code }} · {{ item.name }}</span
            ><span class="block truncate text-xs text-muted-foreground" :title="path(item)">{{ path(item) }}</span>
          </button>
          <Button variant="ghost" size="icon" :aria-label="t('favorites.edit')" @click.stop="edit(item)"><Pencil class="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" :aria-label="t('favorites.relink')" @click.stop="relink(item)"><Link class="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" :aria-label="t('favorites.remove')" @click.stop="remove(item)"><Trash2 class="h-3.5 w-3.5" /></Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
  <div v-if="store.relinking" class="fixed right-4 bottom-4 z-40 flex max-w-lg items-center gap-2 rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-md">
    <span>{{ t("favorites.selectTarget", { name: store.relinking.name }) }}</span
    ><Button variant="outline" size="sm" @click="store.relinking = null">{{ t("favorites.cancel") }}</Button>
  </div>
  <Dialog :open="!!failure" @update:open="!$event && (failure = null)">
    <DialogContent class="max-w-lg"
      ><DialogTitle>{{ t("favorites.openFailed") }}</DialogTitle
      ><DialogDescription>{{ t("favorites.openHelp") }}</DialogDescription>
      <p class="break-all text-sm">{{ failure && path(failure.item) }}</p>
      <p role="alert" class="break-words text-sm text-destructive">{{ failure?.message }}</p>
      <DialogFooter class="flex-wrap"
        ><Button variant="outline" @click="failure = null">{{ t("favorites.cancel") }}</Button
        ><Button variant="outline" @click="failure && edit(failure.item)">{{ t("favorites.edit") }}</Button
        ><Button variant="outline" @click="failure && relink(failure.item)">{{ t("favorites.relink") }}</Button
        ><Button :disabled="opening" @click="failure && open(failure.item)">{{ t("favorites.retry") }}</Button></DialogFooter
      ></DialogContent
    >
  </Dialog>
</template>
