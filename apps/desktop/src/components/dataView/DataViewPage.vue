<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import dayjs from "dayjs";
import { ChevronLeft, Download, LayoutDashboard, Loader2, Pencil, Play, Plus, RefreshCw, Search, Share2, Trash2, Upload, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import DataViewRunner from "@/components/dataView/DataViewRunner.vue";
import DataViewEditor from "@/components/dataView/DataViewEditor.vue";
import { useDataViewStore } from "@/stores/dataViewStore";
import { useToast } from "@/composables/useToast";
import { filterDataViewSummaries } from "@/lib/dataView/dataViewList";
import { dataViewShareUrl } from "@/lib/dataView/dataViewShareLink";
import { exportDataView, parseDataViewImportFile, readDataViewImportFile } from "@/lib/dataView/dataViewConfigTransfer";
import type { DataView, DataViewSummary } from "@/types/dataView";

const props = defineProps<{
  /** Set by the parent to jump straight to a specific view (e.g. after
   *  "add to data view"). A fresh token forces the navigation even if the
   *  same view id is requested twice in a row. */
  openRequest?: { id: string; mode: "editor" | "runner"; token: number } | null;
}>();

const { t } = useI18n();
const store = useDataViewStore();
const { toast } = useToast();

type Mode = "list" | "runner" | "editor";
const mode = ref<Mode>("list");
const active = ref<DataView | null>(null);
const busy = ref(false);
const searchText = ref("");

const deleteTarget = ref<DataViewSummary | null>(null);
const deleting = ref(false);
const deleteOpen = computed({
  get: () => deleteTarget.value !== null,
  set: (open: boolean) => {
    if (!open && !deleting.value) deleteTarget.value = null;
  },
});

const visibleSummaries = computed(() => filterDataViewSummaries(store.sortedSummaries, searchText.value));

onMounted(() => {
  store.ensureLoaded();
});

watch(
  () => props.openRequest,
  (request) => {
    if (!request) return;
    if (request.mode === "editor") openEditor(request.id);
    else openRunner(request.id);
  },
  { immediate: true },
);

async function openRunner(id: string) {
  busy.value = true;
  try {
    active.value = await store.get(id, true);
    if (active.value) mode.value = "runner";
  } finally {
    busy.value = false;
  }
}

async function openEditor(id: string) {
  busy.value = true;
  try {
    active.value = await store.get(id, true);
    if (active.value) mode.value = "editor";
  } finally {
    busy.value = false;
  }
}

function createNew() {
  active.value = store.newView(t("dataView.newView"));
  mode.value = "editor";
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target || deleting.value) return;
  deleting.value = true;
  try {
    await store.remove(target.id);
    deleteTarget.value = null;
  } finally {
    deleting.value = false;
  }
}

async function share(id: string) {
  try {
    await navigator.clipboard.writeText(dataViewShareUrl(id));
    toast(t("dataView.shareLinkCopied"));
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
}

async function exportSummary(summary: DataViewSummary) {
  try {
    const view = await store.get(summary.id);
    if (view) await exportDataView(view);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
}

async function exportActive() {
  if (!active.value) return;
  try {
    await exportDataView(active.value);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
}

const importing = ref(false);
async function importFromFile() {
  if (importing.value) return;
  importing.value = true;
  try {
    const content = await readDataViewImportFile();
    if (!content) return;
    const parsed = parseDataViewImportFile(content);
    const imported = await store.importDataView(parsed);
    toast(t("dataView.importSuccess", { name: imported.name }));
  } catch (error) {
    toast(error instanceof Error ? error.message : t("dataView.importInvalidFile"));
  } finally {
    importing.value = false;
  }
}

function onSaved(view: DataView) {
  active.value = view;
  mode.value = "list";
}

function backToList() {
  mode.value = "list";
  active.value = null;
}

function formatUpdatedAt(iso: string): string {
  return dayjs(iso).format("YYYY-MM-DD HH:mm");
}

function summaryMenuItems(summary: DataViewSummary): ContextMenuItem[] {
  return [
    { label: t("dataView.open"), icon: Play, action: () => openRunner(summary.id) },
    { label: t("dataView.edit"), icon: Pencil, action: () => openEditor(summary.id) },
    { label: t("dataView.share"), icon: Share2, action: () => share(summary.id) },
    { label: t("dataView.export"), icon: Download, action: () => exportSummary(summary) },
    { label: "", separator: true },
    {
      label: t("dataView.delete"),
      icon: Trash2,
      variant: "destructive",
      action: () => {
        deleteTarget.value = summary;
      },
    },
  ];
}
</script>

<template>
  <div class="flex h-full flex-col">
    <template v-if="mode === 'list'">
      <div class="flex h-9 shrink-0 items-center gap-1 border-b bg-muted/20 px-2">
        <LayoutDashboard class="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
        <h2 class="text-[13px] font-medium">{{ t("dataView.title") }}</h2>
        <span class="text-[12px] text-muted-foreground">({{ visibleSummaries.length }})</span>
        <span class="flex-1" />
        <LightTooltip :text="t('dataView.refresh')" side="bottom">
          <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="store.loading" @click="store.refresh()">
            <RefreshCw class="h-3 w-3" :class="store.loading ? 'animate-spin' : ''" />
          </Button>
        </LightTooltip>
        <LightTooltip :text="t('dataView.import')" side="bottom">
          <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="importing" @click="importFromFile">
            <Loader2 v-if="importing" class="h-3 w-3 animate-spin" />
            <Upload v-else class="h-3 w-3" />
          </Button>
        </LightTooltip>
        <LightTooltip :text="t('dataView.newView')" side="bottom">
          <Button variant="ghost" size="icon" class="h-5 w-5" @click="createNew">
            <Plus class="h-3 w-3" />
          </Button>
        </LightTooltip>
      </div>

      <div class="shrink-0 border-b px-2 py-1">
        <div class="relative">
          <Search class="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input v-model="searchText" type="text" class="h-6 w-full rounded border border-border bg-background pl-7 pr-6 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring" :placeholder="t('dataView.search')" />
          <button v-if="searchText" type="button" class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" :aria-label="t('dataView.search')" @click="searchText = ''">
            <X class="h-3 w-3" />
          </button>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto py-1">
        <div v-if="store.loading" class="flex items-center justify-center py-12">
          <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
        <div v-else-if="store.sortedSummaries.length === 0" class="flex justify-center px-4 py-12">
          <div class="w-full max-w-sm rounded-xl border border-dashed px-4 py-8 text-center">
            <p class="text-[13px] text-muted-foreground">{{ t("dataView.emptyListHint") }}</p>
            <Button size="sm" class="mt-3" @click="createNew">
              <Plus class="mr-1 h-3.5 w-3.5" />
              {{ t("dataView.newView") }}
            </Button>
          </div>
        </div>
        <div v-else-if="visibleSummaries.length === 0" class="px-4 py-12 text-center text-[13px] text-muted-foreground">
          {{ t("dataView.noSearchResults") }}
        </div>
        <template v-else>
          <CustomContextMenu v-for="summary in visibleSummaries" :key="summary.id" :items="summaryMenuItems(summary)">
            <template #default="{ onContextMenu }">
              <div class="group flex cursor-default items-center gap-1.5 px-2 py-1.5 text-[13px] hover:bg-accent" :title="summary.name" @click="openRunner(summary.id)" @dblclick="openEditor(summary.id)" @contextmenu.prevent="onContextMenu($event)">
                <LayoutDashboard class="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
                <span class="min-w-0 flex-1 truncate">{{ summary.name }}</span>
                <span v-if="summary.description" class="hidden max-w-[25%] shrink truncate text-[11px] text-muted-foreground/80 md:inline" :title="summary.description">{{ summary.description }}</span>
                <span class="shrink-0 text-[11px] tabular-nums text-muted-foreground/80">{{ summary.queryCount }} {{ t("dataView.queries") }}</span>
                <span class="shrink-0 text-[11px] tabular-nums text-muted-foreground/80">{{ formatUpdatedAt(summary.updatedAt) }}</span>
                <span class="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <LightTooltip :text="t('dataView.run')" side="bottom">
                    <Button variant="ghost" size="icon" class="h-5 w-5" @mousedown.stop @click.stop="openRunner(summary.id)">
                      <Play class="h-3 w-3" />
                    </Button>
                  </LightTooltip>
                  <LightTooltip :text="t('dataView.edit')" side="bottom">
                    <Button variant="ghost" size="icon" class="h-5 w-5" @mousedown.stop @click.stop="openEditor(summary.id)">
                      <Pencil class="h-3 w-3" />
                    </Button>
                  </LightTooltip>
                  <LightTooltip :text="t('dataView.share')" side="bottom">
                    <Button variant="ghost" size="icon" class="h-5 w-5" @mousedown.stop @click.stop="share(summary.id)">
                      <Share2 class="h-3 w-3" />
                    </Button>
                  </LightTooltip>
                </span>
              </div>
            </template>
          </CustomContextMenu>
        </template>
      </div>
    </template>

    <template v-else-if="mode === 'runner' && active">
      <div class="flex h-9 shrink-0 items-center gap-1 border-b bg-muted/20 px-2">
        <LightTooltip :text="t('dataView.back')" side="bottom">
          <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="busy" @click="backToList">
            <ChevronLeft class="h-3.5 w-3.5" />
          </Button>
        </LightTooltip>
        <span class="min-w-0 truncate text-[13px] font-medium" :title="active.name">{{ active.name }}</span>
        <span v-if="active.description" class="min-w-0 truncate text-[12px] text-muted-foreground" :title="active.description">{{ active.description }}</span>
        <span class="flex-1" />
        <LightTooltip :text="t('dataView.edit')" side="bottom">
          <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="busy" @click="openEditor(active.id)">
            <Pencil class="h-3 w-3" />
          </Button>
        </LightTooltip>
        <LightTooltip :text="t('dataView.share')" side="bottom">
          <Button variant="ghost" size="icon" class="h-5 w-5" @click="share(active.id)">
            <Share2 class="h-3 w-3" />
          </Button>
        </LightTooltip>
        <LightTooltip :text="t('dataView.export')" side="bottom">
          <Button variant="ghost" size="icon" class="h-5 w-5" @click="exportActive">
            <Download class="h-3 w-3" />
          </Button>
        </LightTooltip>
      </div>
      <div class="min-h-0 flex-1">
        <DataViewRunner :view="active" />
      </div>
    </template>

    <template v-else-if="mode === 'editor' && active">
      <DataViewEditor :view="active" @saved="onSaved" @back="backToList" />
    </template>

    <Dialog v-model:open="deleteOpen">
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle>{{ t("dataView.confirmDelete") }}</DialogTitle>
          <DialogDescription v-if="deleteTarget">{{ t("dataView.confirmDeleteMessage", { name: deleteTarget.name }) }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" :disabled="deleting" @click="deleteTarget = null">{{ t("dataView.cancel") }}</Button>
          <Button variant="destructive" class="gap-1.5" :disabled="deleting" @click="confirmDelete">
            <Loader2 v-if="deleting" class="h-3.5 w-3.5 animate-spin" />
            {{ t("dataView.delete") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
