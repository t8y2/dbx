<script setup lang="ts">
// Plugin-backed directory picker (manifest field picker with
// `picker.source: "plugin"`): walks the plugin's own storage tree for the
// connection resolved by the renderer. The RPC carries only the connection id
// — the host resolves the stored connection (secrets included) server-side —
// and expects `{ entries: [{ name, path, is_dir }] }` from the plugin method
// named by the picker's `action`. A start path that is not a directory (e.g.
// a file path in copy single-file mode) is answered from its parent, with the
// actually listed directory reported in `resolved_path`; the dialog re-anchors
// there and says so. Failures render inside the dialog with a retry; they
// never crash the form.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronRight, CornerLeftUp, Folder, Loader2, RotateCcw } from "@lucide/vue";
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
/** Editable current path; Enter jumps (same target the breadcrumb shows). */
const pathDraft = ref("/");

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
    error.value = "";
    void load(path.value);
  },
  // Opening mounts with open=true in tests too; the first truthy run is the
  // "dialog just opened" run.
  { immediate: true },
);

async function load(target: string) {
  if (!props.pluginId || !props.action || !props.connectionId) return;
  loading.value = true;
  error.value = "";
  try {
    const result = await invokePluginPathBrowse(props.pluginId, props.action, props.connectionId, target, locale.value);
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
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
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

function choose() {
  emit("select", path.value);
  emit("update:open", false);
}

function close() {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => emit('update:open', value)">
    <DialogContent class="dbx-form-dialog max-h-[min(600px,calc(var(--dbx-viewport-height)-32px))] max-w-[min(520px,calc(100vw-32px))] overflow-x-hidden overflow-y-auto" data-scheduler-path-picker>
      <DialogHeader>
        <DialogTitle>{{ t("scheduler.pathPicker.title") }}</DialogTitle>
      </DialogHeader>

      <div class="space-y-2">
        <div class="flex min-h-8 items-center gap-0.5 overflow-x-auto rounded-md border border-border/70 px-2 py-1 text-xs" data-scheduler-path-picker-breadcrumb>
          <template v-for="(crumb, index) in crumbs" :key="crumb.path">
            <button v-if="index < crumbs.length - 1" type="button" class="shrink-0 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" :data-scheduler-path-picker-crumb="crumb.path" @click="openPath(crumb.path)">
              {{ crumb.label }}
            </button>
            <span v-else class="shrink-0 px-1 py-0.5 font-medium" data-scheduler-path-picker-current>{{ crumb.label }}</span>
            <ChevronRight v-if="index < crumbs.length - 1" class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </template>
        </div>

        <Input v-model="pathDraft" type="text" class="h-8 text-xs" :aria-label="t('scheduler.pathPicker.pathInput')" :disabled="!connectionId" spellcheck="false" data-scheduler-path-picker-input @keydown.enter.prevent="jumpToDraft" />

        <p v-if="!connectionId" class="text-xs text-destructive" data-scheduler-path-picker-needs-connection>
          {{ t("scheduler.pathPicker.needsConnection") }}
        </p>

        <p v-if="redirected" class="text-[11px] leading-5 text-muted-foreground" data-scheduler-path-picker-redirect>
          {{ t("scheduler.pathPicker.notDirectory") }}
        </p>

        <div v-if="error" class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" data-scheduler-path-picker-error>
          <span class="min-w-0 break-all">{{ t("scheduler.pathPicker.loadFailed", { error }) }}</span>
          <Button variant="outline" size="sm" class="h-7 gap-1 text-xs" :disabled="loading" data-scheduler-path-picker-retry @click="openPath(path)">
            <RotateCcw class="size-3" aria-hidden="true" />
            {{ t("scheduler.pathPicker.retry") }}
          </Button>
        </div>

        <div v-else class="max-h-64 min-h-24 space-y-0.5 overflow-y-auto rounded-md border border-border/70 p-1" data-scheduler-path-picker-list>
          <p v-if="loading" class="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground" data-scheduler-path-picker-loading>
            <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
            {{ t("scheduler.pathPicker.loading") }}
          </p>
          <template v-else>
            <button v-if="parentPath !== null" type="button" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60" data-scheduler-path-picker-parent @click="openPath(parentPath)">
              <CornerLeftUp class="size-3.5 shrink-0" aria-hidden="true" />
              <span class="truncate">{{ t("scheduler.pathPicker.parent") }}</span>
            </button>
            <button v-for="entry in entries" :key="entry.path" type="button" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60" :data-scheduler-path-picker-entry="entry.path" @click="openPath(entry.path)">
              <Folder class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="truncate">{{ entry.name }}</span>
            </button>
            <p v-if="entries.length === 0" class="px-2 py-3 text-xs text-muted-foreground" data-scheduler-path-picker-empty>
              {{ t("scheduler.pathPicker.empty") }}
            </p>
            <p v-if="truncated" class="px-2 py-1 text-[11px] text-muted-foreground" data-scheduler-path-picker-truncated>
              {{ t("scheduler.pathPicker.truncated") }}
            </p>
          </template>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="close">{{ t("scheduler.pathPicker.cancel") }}</Button>
        <Button :disabled="loading || !connectionId" data-scheduler-path-picker-choose @click="choose">
          {{ t("scheduler.pathPicker.choose") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
