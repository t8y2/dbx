<script setup lang="ts">
// Plugin-backed directory picker, shared by every surface that renders a
// manifest field with `picker.source: "plugin"` (scheduler task forms today,
// connection dialogs tomorrow). The UI mirrors the files plugin's
// DirectoryBrowser: an up button plus a jump-anywhere breadcrumb toolbar, an
// editable path row, and an accent-hovered directory list whose current
// directory is the choice the footer confirms.
//
// RPC contract (frozen): invokePluginPathBrowse(pluginId, action,
// connectionId, path, locale) → { entries: [{ name, path, is_dir }],
// truncated?, resolved_path? }. The connection id is host-resolved (secrets
// stay server-side); a start path that is not a directory is answered from
// its parent with the actually listed directory in `resolved_path`, which the
// dialog re-anchors to and says so. Failures render inside the dialog with a
// retry; they never crash the embedding form.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowUp, Folder, Loader2, RotateCcw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { invokePluginPathBrowse } from "@/lib/backend/api";
import type { PluginPathBrowseEntry } from "@/types/database";

const props = defineProps<{
  open: boolean;
  pluginId?: string;
  /** Plugin method from the picker declaration, e.g. `files/listDirs`. */
  action?: string;
  /** Resolved connection id (field chain → task connection). */
  connectionId?: string;
  /** Path the field already holds; the dialog starts (or navigates) there. */
  initialPath?: string;
  /** Dialog title override; defaults to the shared picker wording. */
  title?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  select: [path: string];
}>();

const { t, locale } = useI18n();

const path = ref("/");
const entries = ref<PluginPathBrowseEntry[]>([]);
const truncated = ref(false);
const loading = ref(false);
const error = ref("");
const redirected = ref(false);
/** Row highlighted in the list (single click); the footer confirms it. */
const selectedPath = ref("");
/** Editable current path; Enter jumps (same target the breadcrumb shows). */
const pathDraft = ref("/");

/** Request sequence: a slow listing of an older directory must never drag the
 * browse back once a newer navigation happened (ported from the files
 * plugin's DirectoryBrowser). */
let browseSeq = 0;

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const initial = (props.initialPath ?? "").trim();
    path.value = initial.startsWith("/") ? initial : "/";
    pathDraft.value = path.value;
    entries.value = [];
    truncated.value = false;
    redirected.value = false;
    selectedPath.value = "";
    error.value = "";
    void load(path.value);
  },
  // Opening mounts with open=true in tests too; the first truthy run is the
  // "dialog just opened" run.
  { immediate: true },
);

async function load(target: string) {
  if (!props.pluginId || !props.action || !props.connectionId) return;
  const seq = ++browseSeq;
  loading.value = true;
  error.value = "";
  selectedPath.value = "";
  try {
    const result = await invokePluginPathBrowse(props.pluginId, props.action, props.connectionId, target, locale.value);
    if (seq !== browseSeq) return;
    // The contract is directories-only (the plugin filters); the defensive
    // is_dir check keeps a mixed-listing plugin from showing files.
    entries.value = (result?.entries ?? []).filter((entry) => entry && entry.is_dir !== false);
    truncated.value = Boolean(result?.truncated);
    // `resolved_path` names the directory actually listed — present only when
    // the plugin redirected a non-directory start to its parent.
    const resolved = typeof result?.resolved_path === "string" && result.resolved_path ? result.resolved_path : "";
    redirected.value = resolved !== "";
    path.value = resolved || target;
    pathDraft.value = path.value;
  } catch (cause) {
    if (seq !== browseSeq) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    // Only the latest browse may clear the loading flag.
    if (seq === browseSeq) loading.value = false;
  }
}

function openPath(target: string) {
  if (loading.value) return;
  void load(target);
}

/** Manual path jump: normalize to the leading-slash listing vocabulary. */
function jumpToDraft() {
  const draft = pathDraft.value.trim();
  if (!draft) return;
  openPath(draft.startsWith("/") ? draft : `/${draft}`);
}

/** Single click highlights the row; the footer confirms the highlighted one. */
function selectEntry(entryPath: string) {
  selectedPath.value = entryPath;
}

/** Double click (or Enter on the row) descends into the directory. */
function enterEntry(entryPath: string) {
  openPath(entryPath);
}

/** `/a/b` → `/a`, `/a` → `/`, `/` → null (already at the root). */
const parentPath = computed(() => {
  const current = path.value;
  if (!current.startsWith("/") || current === "/") return null;
  const parent = current.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  return parent === "" || parent === "/" ? "/" : parent;
});

const crumbs = computed(() => {
  const segments = path.value.split("/").filter(Boolean);
  const list = [{ label: "/", path: "/" }];
  let accumulated = "";
  for (const segment of segments) {
    accumulated += `/${segment}`;
    list.push({ label: segment, path: accumulated });
  }
  return list;
});

/** Name order, case-insensitive — the files plugin's listing comparator. */
const sortedEntries = computed(() => [...entries.value].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })));

function choose() {
  emit("select", selectedPath.value || path.value);
  emit("update:open", false);
}

function close() {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => emit('update:open', value)">
    <DialogContent class="dbx-form-dialog max-h-[min(600px,calc(var(--dbx-viewport-height)-32px))] max-w-[min(520px,calc(100vw-32px))] overflow-x-hidden overflow-y-auto" data-plugin-path-picker>
      <DialogHeader>
        <DialogTitle>{{ title ?? t("pluginPathPicker.title") }}</DialogTitle>
      </DialogHeader>

      <div class="space-y-2">
        <div class="flex min-h-8 items-center gap-0.5 px-0.5" data-plugin-path-picker-breadcrumb>
          <button
            type="button"
            class="inline-grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            :aria-label="t('pluginPathPicker.parent')"
            :disabled="loading || parentPath === null || !connectionId"
            data-plugin-path-picker-parent
            @click="parentPath !== null && openPath(parentPath)"
          >
            <ArrowUp class="size-4" aria-hidden="true" />
          </button>
          <nav class="flex min-w-0 flex-1 items-center overflow-hidden" aria-label="breadcrumb">
            <template v-for="(crumb, index) in crumbs" :key="crumb.path">
              <!-- crumbs[0] is the root "/" and carries its own slash; only
                   deeper levels get a separator, mirroring the files picker. -->
              <span v-if="index > 1" class="shrink-0 text-xs text-muted-foreground" aria-hidden="true">/</span>
              <button v-if="index < crumbs.length - 1" type="button" class="max-w-[130px] truncate rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground" :data-plugin-path-picker-crumb="crumb.path" @click="openPath(crumb.path)">
                {{ crumb.label }}
              </button>
              <span v-else class="shrink-0 truncate px-1 py-0.5 text-xs font-medium" data-plugin-path-picker-current>{{ crumb.label }}</span>
            </template>
          </nav>
        </div>

        <Input v-model="pathDraft" type="text" class="h-8 text-xs" :aria-label="t('pluginPathPicker.pathInput')" :disabled="!connectionId" spellcheck="false" data-plugin-path-picker-input @keydown.enter.prevent="jumpToDraft" />

        <p v-if="!connectionId" class="text-xs text-destructive" data-plugin-path-picker-needs-connection>
          {{ t("pluginPathPicker.needsConnection") }}
        </p>

        <p v-if="redirected" class="text-[11px] leading-5 text-muted-foreground" data-plugin-path-picker-redirect>
          {{ t("pluginPathPicker.notDirectory") }}
        </p>

        <div v-if="error" class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" data-plugin-path-picker-error>
          <span class="min-w-0 break-all">{{ t("pluginPathPicker.loadFailed", { error }) }}</span>
          <Button variant="outline" size="sm" class="h-7 gap-1 text-xs" :disabled="loading" data-plugin-path-picker-retry @click="openPath(path)">
            <RotateCcw class="size-3" aria-hidden="true" />
            {{ t("pluginPathPicker.retry") }}
          </Button>
        </div>

        <div v-else class="flex max-h-80 min-h-40 flex-col gap-0.5 overflow-y-auto rounded-md border border-border/70 p-1.5 text-xs" data-plugin-path-picker-list>
          <p v-if="loading" class="flex items-center gap-2 px-2 py-3 text-muted-foreground" data-plugin-path-picker-loading>
            <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
            {{ t("pluginPathPicker.loading") }}
          </p>
          <template v-else>
            <button
              v-for="entry in sortedEntries"
              :key="entry.path"
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              :class="selectedPath === entry.path ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60 hover:text-accent-foreground'"
              :aria-current="selectedPath === entry.path ? 'true' : undefined"
              :data-plugin-path-picker-entry="entry.path"
              @click="selectEntry(entry.path)"
              @dblclick.prevent="enterEntry(entry.path)"
              @keydown.enter.prevent="enterEntry(entry.path)"
            >
              <Folder class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="truncate">{{ entry.name }}</span>
            </button>
            <p v-if="entries.length === 0" class="px-2 py-3 text-muted-foreground" data-plugin-path-picker-empty>
              {{ t("pluginPathPicker.empty") }}
            </p>
            <p v-if="truncated" class="px-2 py-1 text-[11px] text-muted-foreground" data-plugin-path-picker-truncated>
              {{ t("pluginPathPicker.truncated") }}
            </p>
          </template>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="close">{{ t("pluginPathPicker.cancel") }}</Button>
        <Button :disabled="loading || !connectionId" data-plugin-path-picker-choose @click="choose">
          {{ t("pluginPathPicker.choose") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
