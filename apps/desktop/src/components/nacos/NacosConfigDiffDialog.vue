<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ChevronDown, ChevronUp, Loader2, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import NacosConfigDiffPane from "@/components/nacos/NacosConfigDiffPane.vue";
import { buildNacosInlineDiff, buildNacosSideBySideDiff, type NacosInlineDiffRow } from "@/lib/nacos/nacosAdmin";

const open = defineModel<boolean>("open", { default: false });

const props = withDefaults(
  defineProps<{
    before: string;
    after: string;
    title?: string;
    beforeLabel?: string;
    afterLabel?: string;
    confirmLabel?: string;
    confirmVariant?: "default" | "destructive";
    showConfirm?: boolean;
    loading?: boolean;
    format?: string;
  }>(),
  {
    title: "",
    beforeLabel: "",
    afterLabel: "",
    confirmLabel: "",
    confirmVariant: "default",
    showConfirm: true,
    loading: false,
    format: "text",
  },
);

const emit = defineEmits<{
  confirm: [];
}>();

const { t } = useI18n();
const inlineCompare = ref(false);
const rows = computed(() => buildNacosSideBySideDiff(props.before, props.after));
const inlineRows = computed(() => buildNacosInlineDiff(props.before, props.after));
const changedRows = computed(() => rows.value.map((row, index) => ({ row, index })).filter(({ row }) => row.leftType !== "equal" || row.rightType !== "equal"));
const diffStats = computed(() => {
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const { row } of changedRows.value) {
    if (row.leftType === "modify" && row.rightType === "modify") modified += 1;
    else if (row.leftType === "padding" && row.rightType === "insert") added += 1;
    else if (row.leftType === "delete" && row.rightType === "padding") removed += 1;
  }
  return { added, removed, modified };
});
const activeChange = ref(0);
const activeRowIndex = computed(() => changedRows.value[activeChange.value]?.index ?? null);
const leftPane = ref<InstanceType<typeof NacosConfigDiffPane> | null>(null);
const rightPane = ref<InstanceType<typeof NacosConfigDiffPane> | null>(null);
let detachScrollSync: (() => void) | null = null;

const dialogOpen = computed({
  get: () => open.value,
  set: (value) => {
    if (props.loading && !value) return;
    open.value = value;
  },
});

function inlineRowClass(type: NacosInlineDiffRow["type"]) {
  return {
    "bg-red-500/20 text-red-700 dark:text-red-50": type === "delete",
    "bg-emerald-500/18 text-emerald-700 dark:text-emerald-50": type === "insert",
    "text-foreground": type === "equal",
  };
}

function inlineGutterClass(type: NacosInlineDiffRow["type"]) {
  return {
    "text-red-600 dark:text-red-300": type === "delete",
    "text-emerald-600 dark:text-emerald-300": type === "insert",
    "text-muted-foreground": type === "equal",
  };
}

function inlinePrefix(type: NacosInlineDiffRow["type"]) {
  if (type === "delete") return "-";
  if (type === "insert") return "+";
  return "";
}

function inlineRowSegmentClass(type: NacosInlineDiffRow["type"], changed: boolean) {
  if (!changed) return "";
  if (type === "delete") return "nacos-inline-change rounded-[2px] bg-red-500/80 text-red-50";
  if (type === "insert") return "nacos-inline-change rounded-[2px] bg-emerald-500/75 text-emerald-50";
  return "";
}

function onConfirm() {
  if (props.loading) return;
  emit("confirm");
}

function bindScrollSync() {
  detachScrollSync?.();
  detachScrollSync = null;
  const left = leftPane.value?.scrollerElement();
  const right = rightPane.value?.scrollerElement();
  if (!left || !right) return;
  let syncing = false;
  const sync = (source: HTMLElement, target: HTMLElement) => {
    if (syncing) return;
    syncing = true;
    target.scrollTop = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => {
      syncing = false;
    });
  };
  const onLeft = () => sync(left, right);
  const onRight = () => sync(right, left);
  left.addEventListener("scroll", onLeft, { passive: true });
  right.addEventListener("scroll", onRight, { passive: true });
  detachScrollSync = () => {
    left.removeEventListener("scroll", onLeft);
    right.removeEventListener("scroll", onRight);
  };
}

function onPaneReady() {
  if (!open.value || inlineCompare.value) return;
  bindScrollSync();
  const rowIndex = activeRowIndex.value;
  if (rowIndex != null) {
    leftPane.value?.scrollToRow(rowIndex);
    rightPane.value?.scrollToRow(rowIndex);
  }
}

function navigateChange(direction: 1 | -1) {
  if (!changedRows.value.length) return;
  activeChange.value = (activeChange.value + direction + changedRows.value.length) % changedRows.value.length;
  const rowIndex = changedRows.value[activeChange.value]?.index;
  if (rowIndex == null) return;
  leftPane.value?.scrollToRow(rowIndex);
  rightPane.value?.scrollToRow(rowIndex);
}

watch(
  [open, rows],
  async () => {
    activeChange.value = 0;
    if (!open.value) {
      detachScrollSync?.();
      detachScrollSync = null;
      return;
    }
    await nextTick();
    bindScrollSync();
  },
  { deep: true },
);

watch(inlineCompare, async (value) => {
  if (value) {
    detachScrollSync?.();
    detachScrollSync = null;
    return;
  }
  await nextTick();
  bindScrollSync();
});

onBeforeUnmount(() => detachScrollSync?.());
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent :show-close-button="false" class="nacos-config-diff-dialog flex h-[min(88vh,900px)] flex-col gap-0 overflow-hidden rounded-lg p-0 shadow-2xl">
      <DialogHeader class="shrink-0 border-b px-5 py-4">
        <div class="flex items-center justify-between gap-4">
          <DialogTitle class="text-lg font-semibold">{{ title || t("nacos.configDiffTitle") }}</DialogTitle>
          <Button size="icon" variant="ghost" class="h-8 w-8 shrink-0" :disabled="loading" :aria-label="t('dangerDialog.cancel')" @click="open = false"><X class="h-4 w-4" /></Button>
        </div>
        <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
          <label class="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <input v-model="inlineCompare" type="checkbox" class="h-4 w-4 rounded border-border" />
            <span>{{ t("nacos.inlineCompare") }}</span>
          </label>
          <div class="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{{ t("nacos.diffStats", diffStats) }}</span>
            <div v-if="changedRows.length && !inlineCompare" class="inline-flex items-center gap-1">
              <Button size="icon" variant="ghost" class="h-6 w-6" :title="t('nacos.previousDifference')" :aria-label="t('nacos.previousDifference')" @click="navigateChange(-1)"><ChevronUp class="h-3.5 w-3.5" /></Button>
              <span>{{ activeChange + 1 }} / {{ changedRows.length }}</span>
              <Button size="icon" variant="ghost" class="h-6 w-6" :title="t('nacos.nextDifference')" :aria-label="t('nacos.nextDifference')" @click="navigateChange(1)"><ChevronDown class="h-3.5 w-3.5" /></Button>
            </div>
          </div>
        </div>
      </DialogHeader>

      <div v-if="!inlineCompare" class="grid min-h-0 flex-1 grid-cols-1 gap-4 bg-background px-5 py-4 lg:grid-cols-2">
        <section class="flex min-w-0 min-h-0 flex-col">
          <div class="mb-2 text-sm font-medium text-foreground">{{ beforeLabel || t("nacos.currentVersionContent") }}</div>
          <NacosConfigDiffPane ref="leftPane" :rows="rows" side="left" :format="format" :active-row="activeRowIndex" class="min-h-0 flex-1" @ready="onPaneReady" />
        </section>

        <section class="flex min-w-0 min-h-0 flex-col">
          <div class="mb-2 text-sm font-medium text-foreground">{{ afterLabel || t("nacos.publishVersionContent") }}</div>
          <NacosConfigDiffPane ref="rightPane" :rows="rows" side="right" :format="format" :active-row="activeRowIndex" class="min-h-0 flex-1" @ready="onPaneReady" />
        </section>
      </div>

      <div v-else class="min-h-0 flex-1 bg-background px-5 py-4">
        <section class="flex h-full min-h-0 flex-col">
          <div class="mb-2 text-sm font-medium text-foreground">{{ t("nacos.inlineCompare") }}</div>
          <div class="min-h-0 flex-1 overflow-auto rounded-sm border bg-background font-mono text-[13px] leading-6 text-foreground">
            <div v-for="row in inlineRows" :key="row.id" class="grid min-w-max grid-cols-[52px_22px_minmax(96rem,1fr)]" :class="inlineRowClass(row.type)">
              <span class="select-none border-r border-border pr-2 text-right" :class="inlineGutterClass(row.type)">{{ row.lineNumber ?? "" }}</span>
              <span class="select-none pl-2" :class="inlineGutterClass(row.type)">{{ inlinePrefix(row.type) }}</span>
              <pre class="whitespace-pre px-2"><template v-for="(segment, index) in row.segments" :key="index"><span :class="inlineRowSegmentClass(row.type, segment.changed)">{{ segment.value }}</span></template></pre>
            </div>
          </div>
        </section>
      </div>

      <DialogFooter class="shrink-0 gap-3 border-t bg-muted/20 px-5 pb-6 pt-4">
        <Button v-if="showConfirm" :variant="confirmVariant" class="min-w-24 gap-1.5 px-5" :disabled="loading" @click="onConfirm">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          {{ confirmLabel || t("nacos.publish") }}
        </Button>
        <Button variant="outline" class="min-w-24 px-5" :disabled="loading" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style>
.nacos-config-diff-dialog {
  width: min(96vw, 1440px) !important;
  max-width: min(96vw, 1440px) !important;
}

.nacos-inline-change {
  box-decoration-break: clone;
  padding: 0 1px;
}

@media (max-width: 1023px) {
  .nacos-config-diff-dialog {
    width: min(96vw, 760px) !important;
    max-width: min(96vw, 760px) !important;
  }
}
</style>
