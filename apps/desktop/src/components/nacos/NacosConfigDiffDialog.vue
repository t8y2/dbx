<script setup lang="ts">
import { computed, ref } from "vue";
import { Loader2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buildNacosInlineDiff, buildNacosSideBySideDiff, summarizeNacosConfigDiff, type NacosDiffLineType, type NacosInlineSegment } from "@/lib/nacosAdmin";

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
  }>(),
  {
    title: "",
    beforeLabel: "",
    afterLabel: "",
    confirmLabel: "",
    confirmVariant: "default",
    showConfirm: true,
    loading: false,
  },
);

const emit = defineEmits<{
  confirm: [];
}>();

const { t } = useI18n();
const inlineCompare = ref(false);
const rows = computed(() => buildNacosSideBySideDiff(props.before, props.after));
const inlineRows = computed(() => buildNacosInlineDiff(props.before, props.after));
const summary = computed(() => summarizeNacosConfigDiff(props.before, props.after));

const dialogOpen = computed({
  get: () => open.value,
  set: (value) => {
    if (props.loading && !value) return;
    open.value = value;
  },
});

function lineClass(type: NacosDiffLineType, side: "left" | "right") {
  return {
    "bg-red-500/20 text-red-50": type === "delete" || (type === "modify" && side === "left"),
    "bg-emerald-500/18 text-emerald-50": type === "insert" || (type === "modify" && side === "right"),
    "text-zinc-200": type === "equal",
    "bg-zinc-900/80 text-zinc-600": type === "padding",
  };
}

function gutterClass(type: NacosDiffLineType, side: "left" | "right") {
  return {
    "text-red-300": type === "delete" || (type === "modify" && side === "left"),
    "text-emerald-300": type === "insert" || (type === "modify" && side === "right"),
    "text-zinc-500": type === "equal" || type === "padding",
  };
}

function prefix(type: NacosDiffLineType, side: "left" | "right") {
  if (type === "delete" || (type === "modify" && side === "left")) return "-";
  if (type === "insert" || (type === "modify" && side === "right")) return "+";
  return "";
}

function inlineSegments(content: string, segments: NacosInlineSegment[]) {
  return segments.length ? segments : [{ value: content, changed: false }];
}

function inlineClass(type: NacosDiffLineType, changed: boolean) {
  if (!changed) return "";
  if (type === "delete" || type === "modify") return "nacos-inline-change rounded-[2px] bg-red-500/80 text-red-50";
  if (type === "insert") return "nacos-inline-change rounded-[2px] bg-emerald-500/75 text-emerald-50";
  return "";
}

function rightInlineClass(type: NacosDiffLineType, changed: boolean) {
  if (!changed) return "";
  if (type === "modify" || type === "insert") return "nacos-inline-change rounded-[2px] bg-emerald-500/75 text-emerald-50";
  return inlineClass(type, changed);
}

function inlineRowClass(type: "equal" | "delete" | "insert") {
  return {
    "bg-red-500/20 text-red-50": type === "delete",
    "bg-emerald-500/18 text-emerald-50": type === "insert",
    "text-zinc-200": type === "equal",
  };
}

function inlineGutterClass(type: "equal" | "delete" | "insert") {
  return {
    "text-red-300": type === "delete",
    "text-emerald-300": type === "insert",
    "text-zinc-500": type === "equal",
  };
}

function inlinePrefix(type: "equal" | "delete" | "insert") {
  if (type === "delete") return "-";
  if (type === "insert") return "+";
  return "";
}

function inlineRowSegmentClass(type: "equal" | "delete" | "insert", changed: boolean) {
  if (!changed) return "";
  if (type === "delete") return "nacos-inline-change rounded-[2px] bg-red-500/80 text-red-50";
  if (type === "insert") return "nacos-inline-change rounded-[2px] bg-emerald-500/75 text-emerald-50";
  return "";
}

function onConfirm() {
  if (props.loading) return;
  emit("confirm");
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent :show-close-button="false" class="nacos-config-diff-dialog flex h-[min(88vh,900px)] flex-col gap-0 overflow-hidden rounded-lg p-0 shadow-2xl">
      <DialogHeader class="shrink-0 border-b px-5 py-4">
        <div class="flex items-center justify-between gap-4">
          <DialogTitle class="text-lg font-semibold">{{ title || t("nacos.configDiffTitle") }}</DialogTitle>
          <button type="button" class="text-2xl leading-none text-muted-foreground hover:text-foreground" :disabled="loading" @click="open = false">×</button>
        </div>
        <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
          <label class="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <input v-model="inlineCompare" type="checkbox" class="h-4 w-4 rounded border-border" />
            <span>{{ t("nacos.inlineCompare") }}</span>
          </label>
          <div class="text-xs text-muted-foreground">{{ t("nacos.confirmSaveMessage", { added: summary.addedLines, removed: summary.removedLines }) }}</div>
        </div>
      </DialogHeader>

      <div v-if="!inlineCompare" class="grid min-h-0 flex-1 grid-cols-1 gap-4 bg-background px-5 py-4 lg:grid-cols-2">
        <section class="flex min-w-0 min-h-0 flex-col">
          <div class="mb-2 text-sm font-medium text-foreground">{{ beforeLabel || t("nacos.currentVersionContent") }}</div>
          <div class="min-h-0 flex-1 overflow-auto rounded-sm border border-zinc-700 bg-[#1f1f1f] font-mono text-[13px] leading-6 text-zinc-200">
            <div v-for="row in rows" :key="`${row.id}-left`" class="grid min-w-max grid-cols-[52px_22px_minmax(48rem,1fr)]" :class="lineClass(row.leftType, 'left')">
              <span class="select-none border-r border-white/8 pr-2 text-right" :class="gutterClass(row.leftType, 'left')">{{ row.leftLineNumber ?? "" }}</span>
              <span class="select-none pl-2" :class="gutterClass(row.leftType, 'left')">{{ prefix(row.leftType, "left") }}</span>
              <pre class="whitespace-pre px-2"><template v-for="(segment, index) in inlineSegments(row.leftContent, row.leftInline)" :key="index"><span :class="inlineClass(row.leftType, segment.changed)">{{ segment.value }}</span></template></pre>
            </div>
          </div>
        </section>

        <section class="flex min-w-0 min-h-0 flex-col">
          <div class="mb-2 text-sm font-medium text-foreground">{{ afterLabel || t("nacos.publishVersionContent") }}</div>
          <div class="min-h-0 flex-1 overflow-auto rounded-sm border border-zinc-700 bg-[#1f1f1f] font-mono text-[13px] leading-6 text-zinc-200">
            <div v-for="row in rows" :key="`${row.id}-right`" class="grid min-w-max grid-cols-[52px_22px_minmax(48rem,1fr)]" :class="lineClass(row.rightType, 'right')">
              <span class="select-none border-r border-white/8 pr-2 text-right" :class="gutterClass(row.rightType, 'right')">{{ row.rightLineNumber ?? "" }}</span>
              <span class="select-none pl-2" :class="gutterClass(row.rightType, 'right')">{{ prefix(row.rightType, "right") }}</span>
              <pre class="whitespace-pre px-2"><template v-for="(segment, index) in inlineSegments(row.rightContent, row.rightInline)" :key="index"><span :class="rightInlineClass(row.rightType, segment.changed)">{{ segment.value }}</span></template></pre>
            </div>
          </div>
        </section>
      </div>

      <div v-else class="min-h-0 flex-1 bg-background px-5 py-4">
        <section class="flex h-full min-h-0 flex-col">
          <div class="mb-2 text-sm font-medium text-foreground">{{ t("nacos.inlineCompare") }}</div>
          <div class="min-h-0 flex-1 overflow-auto rounded-sm border border-zinc-700 bg-[#1f1f1f] font-mono text-[13px] leading-6 text-zinc-200">
            <div v-for="row in inlineRows" :key="row.id" class="grid min-w-max grid-cols-[52px_22px_minmax(96rem,1fr)]" :class="inlineRowClass(row.type)">
              <span class="select-none border-r border-white/8 pr-2 text-right" :class="inlineGutterClass(row.type)">{{ row.lineNumber ?? "" }}</span>
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
