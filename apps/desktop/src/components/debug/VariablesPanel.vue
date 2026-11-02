<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useResizeObserver } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, Eye, Info, Pencil, Plus, RotateCcw, Search, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePlDebugStore, type PlDebugWatchRow } from "@/stores/plDebugStore";
import type { PlDebugValueContext, PlDebugVariable } from "@/lib/debug/plDebugProtocol";
import { copyToClipboard } from "@/lib/common/clipboard";

const { t } = useI18n();
const store = usePlDebugStore();
const root = ref<HTMLElement | null>(null);
const filter = ref("");
const editingName = ref<string | null>(null);
const draft = ref("");
const savingName = ref<string | null>(null);
const saveError = ref<string | null>(null);
const saveNotice = ref<string | null>(null);
const editingContext = ref<PlDebugValueContext | null>(null);
/** The watch section edits separately from the variable rows (keys can collide). */
const editingWatch = ref<string | null>(null);
const watchDraft = ref("");
const savingWatch = ref<string | null>(null);
const watchError = ref<string | null>(null);
const watchNotice = ref<string | null>(null);
const watchContext = ref<PlDebugValueContext | null>(null);
const watchInput = ref("");
const copyError = ref<string | null>(null);
const copied = ref(false);

async function copyCell(text: string) {
  copied.value = false;
  copyError.value = null;
  try {
    await copyToClipboard(text);
    copied.value = true;
  } catch (caught) {
    copyError.value = String(caught);
  }
}

function copyableValue(row: Pick<PlDebugVariable, "state" | "value">): string | null {
  if (row.state === "null") return "NULL";
  return row.state === "value" || row.state === "empty" ? row.value : null;
}
const nameWidth = ref<number | null>(null);
const containerWidth = ref(800);
const maxNameWidth = computed(() => Math.max(96, Math.min(480, containerWidth.value * 0.45)));
const defaultNameWidth = computed(() => Math.min(260, Math.max(160, containerWidth.value * 0.3), containerWidth.value * 0.4));
let resizeStart: { x: number; width: number } | null = null;

useResizeObserver(root, () => {
  containerWidth.value = root.value?.clientWidth || 800;
  if (nameWidth.value !== null) nameWidth.value = Math.min(nameWidth.value, maxNameWidth.value);
});

function adjustNameWidth(delta: number) {
  const width = root.value?.clientWidth || 800;
  const current = nameWidth.value ?? defaultNameWidth.value;
  nameWidth.value = Math.max(96, Math.min(480, width * 0.45, current + delta));
}

function startNameResize(event: PointerEvent) {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  const width = handle.closest("th")!.getBoundingClientRect().width;
  resizeStart = { x: event.clientX, width };
  handle.setPointerCapture(event.pointerId);
}

function moveNameResize(event: PointerEvent) {
  if (!resizeStart) return;
  nameWidth.value = resizeStart.width;
  adjustNameWidth(event.clientX - resizeStart.x);
}

function endNameResize() {
  resizeStart = null;
}

function nameWidthKey(event: KeyboardEvent) {
  if (event.key === "Home") nameWidth.value = null;
  else if (event.key === "ArrowLeft") adjustNameWidth(-16);
  else if (event.key === "ArrowRight") adjustNameWidth(16);
  else return;
  event.preventDefault();
}

const variablesUnsupported = computed(() => store.probe?.variablesSupported === false);
const setUnavailable = computed(() => store.probe?.capabilities?.setValue?.canAttempt === false || store.probe?.capabilities?.setValue?.status === "unsupported");
const editDisabled = computed(() => setUnavailable.value || store.busy || store.terminated || store.recoveryRequired || store.publicSnapshot?.state !== "paused");
const staleEdit = computed(() => !!editingContext.value && !store.valueContextMatches(editingContext.value));
const staleWatch = computed(() => !!watchContext.value && !store.valueContextMatches(watchContext.value));
/** This server has no GET_VALUES, so the agent reads one name per call (GET_VALUE). */
const variablesFallback = computed(() => store.probe?.variablesFallback === "get_value");
const unsupportedReason = computed(() => store.probe?.reason ?? "");
/**
 * Why the panel is degraded, when the agent knows: it reports the DBMS_DEBUG entry
 * points this server does not declare (Oracle 19c/21c lack GET_VALUES, which is the
 * primitive that enumerates variables). `reason` is only set when the *server* cannot
 * be debugged at all, so it is normally empty on this axis — the missing list is what
 * actually explains the panel.
 */
const missingPrimitives = computed(() => (store.probe?.missingOptionalProcedures ?? []).filter((name) => name === "GET_VALUE" || name === "GET_VALUES"));
const setUnavailableReason = computed(() => store.probe?.capabilities?.setValue?.evidence || t("plDebug.variables.setUnavailable"));

const filteredVariables = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  const rows = store.variables.slice();
  if (editingName.value && !rows.some((entry) => entry.name === editingName.value)) rows.push({ name: editingName.value, state: "unknown", value: null });
  return needle ? rows.filter((entry) => entry.name.toLowerCase().includes(needle)) : rows;
});

async function startEditing(entry: PlDebugVariable) {
  try {
    editingContext.value = store.captureValueContext();
  } catch (caught) {
    saveError.value = String(caught);
    return;
  }
  editingName.value = entry.name;
  draft.value = editText(entry);
  saveError.value = null;
  await nextTick();
  root.value?.querySelector<HTMLInputElement>("[data-variable-editor]")?.focus();
  root.value?.querySelector<HTMLInputElement>("[data-variable-editor]")?.select();
}

function cancelEditing() {
  editingName.value = null;
  editingContext.value = null;
  draft.value = "";
  saveError.value = null;
}

/** DBMS_DEBUG.SET_VALUE: frame 0 is the stopped frame, index 0 the first scalar. */
async function saveValue(name: string) {
  saveError.value = null;
  saveNotice.value = null;
  savingName.value = name;
  try {
    if (!editingContext.value) return;
    const result = await store.setValue(name, editingContext.value.frame, 0, draft.value, editingContext.value);
    saveNotice.value = result.readError;
    editingName.value = null;
    editingContext.value = null;
    draft.value = "";
  } catch (caught) {
    saveError.value = String(caught);
  } finally {
    savingName.value = null;
  }
}

/** Adds the name typed into the watch box (blank names are ignored by the store). */
async function addTypedWatch() {
  const name = watchInput.value;
  watchInput.value = "";
  await addWatch(name);
}

async function addWatch(name: string) {
  store.addWatch(name);
  if (store.publicSnapshot?.state === "paused" && !store.busy) await store.refreshWatches();
}

async function startEditingWatch(row: PlDebugWatchRow) {
  try {
    watchContext.value = store.captureValueContext();
  } catch (caught) {
    watchError.value = String(caught);
    return;
  }
  editingWatch.value = row.name;
  watchDraft.value = editText(row);
  watchError.value = null;
  await nextTick();
  root.value?.querySelector<HTMLInputElement>("[data-watch-editor]")?.focus();
  root.value?.querySelector<HTMLInputElement>("[data-watch-editor]")?.select();
}

function cancelWatchEditing() {
  editingWatch.value = null;
  watchContext.value = null;
  watchDraft.value = "";
  watchError.value = null;
}

/** Same SET_VALUE channel as a variable row: frame = the inspected frame, index 0. */
async function saveWatchValue(name: string) {
  watchError.value = null;
  watchNotice.value = null;
  savingWatch.value = name;
  try {
    if (!watchContext.value) return;
    const result = await store.setWatchValue(name, watchDraft.value, watchContext.value.frame, watchContext.value);
    watchNotice.value = result.readError;
    editingWatch.value = null;
    watchContext.value = null;
    watchDraft.value = "";
  } catch (caught) {
    watchError.value = String(caught);
  } finally {
    savingWatch.value = null;
  }
}

/** A watch row's value cell: the value, or the explicit out-of-scope placeholder. */
function valueText(row: Pick<PlDebugVariable, "state" | "value">): string {
  if (row.state === "value") return row.value ?? "";
  if (row.state === "null") return "SQL NULL";
  if (row.state === "empty") return t("plDebug.variables.emptyString");
  if (row.state === "out_of_scope") return t("plDebug.watch.notInScope");
  return t(row.state === "error" ? "plDebug.variables.readError" : "plDebug.variables.unread");
}

function editText(row: Pick<PlDebugVariable, "state" | "value">): string {
  if (row.state === "null") return "NULL";
  if (row.state === "empty") return "''";
  return row.value ?? "";
}
</script>

<template>
  <div ref="root" class="flex h-full flex-col" :style="{ '--debug-name-width': `${nameWidth ?? defaultNameWidth}px` }">
    <div v-if="variablesFallback" class="flex items-start gap-1.5 border-b bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground" :title="t('plDebug.variables.fallback')">
      <Info class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{{ t("plDebug.variables.fallback") }}</span>
    </div>
    <div v-else-if="variablesUnsupported" class="flex items-start gap-1.5 border-b bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
      <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {{ t("plDebug.variables.unsupported") }}
        <span v-if="missingPrimitives.length" class="opacity-80">— {{ t("plDebug.variables.unsupportedMissing", { procedures: missingPrimitives.join(", ") }) }}</span>
        <span v-else-if="unsupportedReason" class="opacity-80">— {{ unsupportedReason }}</span>
      </span>
    </div>
    <div class="flex items-center gap-1 border-b px-2 py-1">
      <div class="relative min-w-0 flex-1">
        <Search class="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="filter" class="h-7 pl-7 text-xs" :placeholder="t('plDebug.variables.filter')" />
      </div>
      <Button variant="ghost" size="sm" class="h-7 w-7 shrink-0 p-0" :aria-label="t('plDebug.variables.narrowName')" :title="t('plDebug.variables.narrowName')" @click="adjustNameWidth(-16)"><ChevronLeft class="h-3.5 w-3.5" /></Button>
      <Button variant="ghost" size="sm" class="h-7 w-7 shrink-0 p-0" :aria-label="t('plDebug.variables.widenName')" :title="t('plDebug.variables.widenName')" @click="adjustNameWidth(16)"><ChevronRight class="h-3.5 w-3.5" /></Button>
      <Button variant="ghost" size="sm" class="h-7 w-7 shrink-0 p-0" :aria-label="t('plDebug.variables.resetWidth')" :title="t('plDebug.variables.resetWidth')" @click="nameWidth = null"><RotateCcw class="h-3.5 w-3.5" /></Button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full table-fixed text-xs">
        <colgroup>
          <col style="width: var(--debug-name-width)" />
          <col />
          <col style="width: 4rem" />
        </colgroup>
        <thead class="sticky top-0 bg-background">
          <tr class="text-left text-muted-foreground">
            <th class="relative px-2 py-1 font-normal">
              {{ t("plDebug.variables.name") }}
              <div
                role="separator"
                tabindex="0"
                aria-orientation="vertical"
                :aria-label="t('plDebug.variables.resizeName')"
                :aria-valuemin="96"
                :aria-valuemax="maxNameWidth"
                :aria-valuenow="nameWidth ?? defaultNameWidth"
                class="absolute inset-y-0 right-0 w-2 cursor-col-resize touch-none border-r border-border hover:bg-accent focus-visible:bg-accent focus-visible:outline focus-visible:outline-ring"
                @pointerdown.prevent="startNameResize"
                @pointermove="moveNameResize"
                @pointerup="endNameResize"
                @pointercancel="endNameResize"
                @lostpointercapture="endNameResize"
                @keydown="nameWidthKey"
              />
            </th>
            <th class="px-2 py-1 font-normal">{{ t("plDebug.variables.value") }}</th>
            <th class="w-16 px-2 py-1 font-normal">{{ t("plDebug.variables.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in filteredVariables" :key="entry.name" class="border-t">
            <td class="px-2 py-1 align-top font-mono">
              <details class="group min-w-0">
                <summary class="cursor-pointer truncate rounded-sm focus-visible:outline focus-visible:outline-ring" :aria-label="t('plDebug.variables.expandName', { name: entry.name })">{{ entry.name }}</summary>
                <div class="mt-1">
                  <pre class="whitespace-pre-wrap break-all font-mono">{{ entry.name }}</pre>
                  <Button variant="ghost" size="sm" class="mt-1 h-6 px-1 text-xs" :title="t('plDebug.variables.copyName')" @click="copyCell(entry.name)"><Copy class="mr-1 h-3 w-3" />{{ t("plDebug.variables.copyName") }}</Button>
                </div>
              </details>
            </td>
            <td class="whitespace-pre-wrap break-all px-2 py-1 align-top font-mono">
              <template v-if="editingName === entry.name">
                <div class="flex items-center gap-1">
                  <Input
                    data-variable-editor
                    v-model="draft"
                    class="h-6 text-xs"
                    :disabled="savingName === entry.name"
                    :aria-label="t('plDebug.variables.valuePlaceholder')"
                    :placeholder="t('plDebug.variables.valuePlaceholder')"
                    @keydown.enter.prevent="saveValue(entry.name)"
                    @keydown.esc.prevent="cancelEditing"
                  />
                  <Button variant="ghost" size="sm" class="h-6 w-6 p-0" :disabled="savingName === entry.name || staleEdit || editDisabled" :title="t('plDebug.variables.save')" @click="saveValue(entry.name)">
                    <Check class="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" class="h-6 w-6 p-0" :disabled="savingName === entry.name" :title="t('plDebug.variables.cancel')" @click="cancelEditing">
                    <X class="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p v-if="staleEdit" role="status" class="mt-1 text-muted-foreground">{{ t("plDebug.variables.editContextChanged") }}</p>
              </template>
              <template v-else>
                <details>
                  <summary class="cursor-pointer truncate rounded-sm focus-visible:outline focus-visible:outline-ring" :aria-label="t('plDebug.variables.expandValue')">{{ valueText(entry) }}</summary>
                  <div class="mt-1">
                    <pre class="whitespace-pre-wrap break-all font-mono">{{ valueText(entry) }}</pre>
                    <Button v-if="copyableValue(entry) !== null" variant="ghost" size="sm" class="mt-1 h-6 px-1 text-xs" :title="t('plDebug.variables.copyValue')" @click="copyCell(copyableValue(entry)!)"><Copy class="mr-1 h-3 w-3" />{{ t("plDebug.variables.copyValue") }}</Button>
                  </div>
                </details>
                <p v-if="entry.message" class="mt-1 text-muted-foreground">{{ entry.message }}</p>
              </template>
            </td>
            <td class="px-2 py-1 align-top">
              <div class="flex items-center">
                <Button v-if="editingName !== entry.name" variant="ghost" size="sm" class="h-6 w-6 p-0" :disabled="editDisabled" :title="setUnavailable ? setUnavailableReason : t('plDebug.variables.edit')" @click="startEditing(entry)">
                  <Pencil class="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" class="h-6 w-6 p-0" :title="t('plDebug.variables.addToWatch')" @click="addWatch(entry.name)">
                  <Eye class="h-3.5 w-3.5" />
                </Button>
              </div>
            </td>
          </tr>
          <tr v-if="filteredVariables.length === 0">
            <td colspan="3" class="px-2 py-3 text-center text-muted-foreground">
              {{
                t(
                  store.publicSnapshot?.state !== "paused"
                    ? "plDebug.variables.noStop"
                    : store.variablesState === "ready"
                      ? "plDebug.variables.empty"
                      : store.variablesState === "loading"
                        ? "common.loading"
                        : store.variablesState === "error"
                          ? "plDebug.variables.readError"
                          : "plDebug.variables.unread",
                )
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="store.variableError" role="status" class="border-t px-2 py-1 text-xs text-destructive">{{ store.variableError }}</p>
    <p v-if="saveError" class="border-t px-2 py-1 text-xs text-destructive">{{ t("plDebug.variables.setFailed", { error: saveError }) }}</p>
    <p v-if="saveNotice" role="status" class="border-t px-2 py-1 text-xs text-muted-foreground">{{ t("plDebug.variables.readbackFailed", { error: saveNotice }) }}</p>

    <section class="flex max-h-[48%] min-h-0 shrink-0 flex-col border-t">
      <div class="flex items-center gap-2 border-b px-2 py-1">
        <span class="text-xs font-medium">{{ t("plDebug.watch.title") }}</span>
        <Input v-model="watchInput" class="h-6 flex-1 text-xs" :placeholder="t('plDebug.watch.addPlaceholder')" @keydown.enter.prevent="addTypedWatch" />
        <Button variant="ghost" size="sm" class="h-6 w-6 p-0" :disabled="!watchInput.trim()" :title="t('plDebug.watch.add')" @click="addTypedWatch">
          <Plus class="h-3.5 w-3.5" />
        </Button>
      </div>
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="w-full table-fixed text-xs">
          <colgroup>
            <col style="width: var(--debug-name-width)" />
            <col />
            <col style="width: min(6rem, 16%)" />
            <col style="width: 4rem" />
          </colgroup>
          <thead class="sticky top-0 bg-background">
            <tr class="text-left text-muted-foreground">
              <th class="relative px-2 py-1 font-normal">
                {{ t("plDebug.variables.name") }}
                <div
                  role="separator"
                  tabindex="0"
                  aria-orientation="vertical"
                  :aria-label="t('plDebug.variables.resizeName')"
                  :aria-valuemin="96"
                  :aria-valuemax="maxNameWidth"
                  :aria-valuenow="nameWidth ?? defaultNameWidth"
                  class="absolute inset-y-0 right-0 w-2 cursor-col-resize touch-none border-r border-border hover:bg-accent focus-visible:bg-accent focus-visible:outline focus-visible:outline-ring"
                  @pointerdown.prevent="startNameResize"
                  @pointermove="moveNameResize"
                  @pointerup="endNameResize"
                  @pointercancel="endNameResize"
                  @lostpointercapture="endNameResize"
                  @keydown="nameWidthKey"
                />
              </th>
              <th class="px-2 py-1 font-normal">{{ t("plDebug.variables.value") }}</th>
              <th class="w-24 px-2 py-1 font-normal">{{ t("plDebug.variables.type") }}</th>
              <th class="w-16 px-2 py-1 font-normal">{{ t("plDebug.variables.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in store.watches" :key="row.name" class="border-t">
              <td class="px-2 py-1 align-top font-mono">
                <details>
                  <summary class="cursor-pointer truncate rounded-sm focus-visible:outline focus-visible:outline-ring" :aria-label="t('plDebug.variables.expandName', { name: row.name })">{{ row.name }}</summary>
                  <div class="mt-1">
                    <pre class="whitespace-pre-wrap break-all font-mono">{{ row.name }}</pre>
                    <Button variant="ghost" size="sm" class="mt-1 h-6 px-1 text-xs" :title="t('plDebug.variables.copyName')" @click="copyCell(row.name)"><Copy class="mr-1 h-3 w-3" />{{ t("plDebug.variables.copyName") }}</Button>
                  </div>
                </details>
              </td>
              <td class="whitespace-pre-wrap break-all px-2 py-1 align-top font-mono" :class="row.inScope ? '' : 'text-muted-foreground italic'">
                <template v-if="editingWatch === row.name">
                  <div class="flex items-center gap-1">
                    <Input
                      data-watch-editor
                      v-model="watchDraft"
                      class="h-6 text-xs"
                      :disabled="savingWatch === row.name"
                      :aria-label="t('plDebug.watch.valuePlaceholder')"
                      :placeholder="t('plDebug.watch.valuePlaceholder')"
                      @keydown.enter.prevent="saveWatchValue(row.name)"
                      @keydown.esc.prevent="cancelWatchEditing"
                    />
                    <Button variant="ghost" size="sm" class="h-6 w-6 p-0" :disabled="savingWatch === row.name || staleWatch || editDisabled" :title="t('plDebug.variables.save')" @click="saveWatchValue(row.name)">
                      <Check class="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" class="h-6 w-6 p-0" :disabled="savingWatch === row.name" :title="t('plDebug.variables.cancel')" @click="cancelWatchEditing">
                      <X class="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p v-if="staleWatch" role="status" class="mt-1 text-muted-foreground">{{ t("plDebug.variables.editContextChanged") }}</p>
                </template>
                <template v-else>
                  <details>
                    <summary class="cursor-pointer truncate rounded-sm focus-visible:outline focus-visible:outline-ring" :aria-label="t('plDebug.variables.expandValue')">{{ valueText(row) }}</summary>
                    <div class="mt-1">
                      <pre class="whitespace-pre-wrap break-all font-mono">{{ valueText(row) }}</pre>
                      <Button v-if="copyableValue(row) !== null" variant="ghost" size="sm" class="mt-1 h-6 px-1 text-xs" :title="t('plDebug.variables.copyValue')" @click="copyCell(copyableValue(row)!)"><Copy class="mr-1 h-3 w-3" />{{ t("plDebug.variables.copyValue") }}</Button>
                    </div>
                  </details>
                  <p v-if="row.message" class="mt-1 text-muted-foreground">{{ row.message }}</p>
                </template>
              </td>
              <td class="break-words px-2 py-1 align-top font-mono text-muted-foreground">{{ row.type || "—" }}</td>
              <td class="px-2 py-1 align-top">
                <div class="flex items-center">
                  <Button v-if="editingWatch !== row.name" variant="ghost" size="sm" class="h-6 w-6 p-0" :disabled="editDisabled" :title="setUnavailable ? setUnavailableReason : t('plDebug.watch.edit')" @click="startEditingWatch(row)">
                    <Pencil class="h-3.5 w-3.5" />
                  </Button>
                  <Button v-if="editingWatch !== row.name" variant="ghost" size="sm" class="h-6 w-6 p-0" :title="t('plDebug.watch.remove')" @click="store.removeWatch(row.name)">
                    <X class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </td>
            </tr>
            <tr v-if="store.watches.length === 0">
              <td colspan="4" class="px-2 py-3 text-center text-muted-foreground">{{ t("plDebug.watch.empty") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <p v-if="watchError" class="border-t px-2 py-1 text-xs text-destructive">{{ t("plDebug.watch.setFailed", { error: watchError }) }}</p>
    <p v-if="watchNotice" role="status" class="border-t px-2 py-1 text-xs text-muted-foreground">{{ t("plDebug.variables.readbackFailed", { error: watchNotice }) }}</p>
    <p v-if="copied" role="status" class="border-t px-2 py-1 text-xs text-muted-foreground">{{ t("plDebug.variables.copied") }}</p>
    <p v-if="copyError" role="status" class="border-t px-2 py-1 text-xs text-destructive">{{ t("plDebug.variables.copyFailed", { error: copyError }) }}</p>
  </div>
</template>
