<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { DEFAULT_CUSTOM_THEME_DDL_COLORS } from "@/stores/settingsStore";
import { useDiffScrollSync } from "@/composables/useDiffScrollSync";
import { buildHunks, type DiffLine } from "@/components/diff/DiffHunkBuilder";
import DiffSvgConnector from "@/components/diff/DiffSvgConnector.vue";
import { FileCode, ScrollText, Copy, Play, FileDiff } from "@lucide/vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import type { SchemaDiffObject, CompatibilityWarning, DependencyGraph, PermissionDiff, MissingRollbackObject, RollbackCompleteness } from "@/lib/schema/schemaDiff";

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();

const ddlColors = computed(() => {
  const themes = settingsStore.editorSettings.customThemes;
  const activeId = settingsStore.editorSettings.activeCustomThemeId;
  const activeTheme = themes.find((t) => t.id === activeId);
  return activeTheme?.ddlColors ?? DEFAULT_CUSTOM_THEME_DDL_COLORS;
});

function toRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha / 100})`;
}

const props = defineProps<{
  selectedObject: SchemaDiffObject | null;
  deploySql: string;
  deploySqlAll: string;
  compatibilityWarnings?: CompatibilityWarning[];
  rollbackSql?: string;
  deploySqlMode?: "forward" | "rollback";
  dependencyGraph?: DependencyGraph | null;
  permissionDiffs?: PermissionDiff[];
  rollbackCompleteness?: RollbackCompleteness;
  missingRollbackObjects?: MissingRollbackObject[];
  canExecute?: boolean;
}>();

const emit = defineEmits<{
  executeScript: [];
  "update:deploySqlMode": [mode: "forward" | "rollback"];
}>();

const activeTab = ref<"ddl" | "script" | "scriptAll" | "warnings" | "depGraph" | "permissions" | "rollbackCompare">("ddl");
const diffContainerRef = ref<HTMLDivElement>();
const leftPaneRef = ref<HTMLDivElement>();
const rightPaneRef = ref<HTMLDivElement>();
const containerSize = ref({ width: 0, height: 0 });
const connectorKey = ref(0);

const rollbackDiffContainerRef = ref<HTMLDivElement>();
const rollbackLeftPaneRef = ref<HTMLDivElement>();
const rollbackRightPaneRef = ref<HTMLDivElement>();
const rollbackContainerSize = ref({ width: 0, height: 0 });
const rollbackConnectorKey = ref(0);

const rollbackHunks = computed(() => {
  if (!props.rollbackSql) return [];
  return buildHunks(props.deploySql, props.rollbackSql);
});

const hunks = computed(() => {
  if (!props.selectedObject?.sourceDdl && !props.selectedObject?.targetDdl) return [];
  return buildHunks(props.selectedObject?.sourceDdl || "", props.selectedObject?.targetDdl || "");
});

const { syncScroll, measureHunks } = useDiffScrollSync({
  container: diffContainerRef,
  leftPane: leftPaneRef,
  rightPane: rightPaneRef,
  hunks,
});

const { syncScroll: rollbackSyncScroll, measureHunks: rollbackMeasureHunks } = useDiffScrollSync({
  container: rollbackDiffContainerRef,
  leftPane: rollbackLeftPaneRef,
  rightPane: rollbackRightPaneRef,
  hunks: rollbackHunks,
});

function collectModifySegments(diffHunks: ReturnType<typeof buildHunks>) {
  const map = new Map<string, { leftSegments: Segment[]; rightSegments: Segment[] }>();
  for (const hunk of diffHunks) {
    for (let i = 0; i < hunk.leftLines.length; i++) {
      const left = hunk.leftLines[i];
      const right = hunk.rightLines[i];
      const key = `${hunk.id}:${i}`;
      if (left.type === "modify" && !left.isPadding && right.type === "modify" && !right.isPadding) {
        map.set(key, renderModifyLine(left, right));
      } else if (left.type === "modify" && !left.isPadding && left.comparisonContent !== undefined) {
        map.set(key, {
          leftSegments: renderModifyContent(left.content, left.comparisonContent).sourceSegments,
          rightSegments: [],
        });
      } else if (right.type === "modify" && !right.isPadding && right.comparisonContent !== undefined) {
        map.set(key, {
          leftSegments: [],
          rightSegments: renderModifyContent(right.comparisonContent, right.content).targetSegments,
        });
      }
    }
  }
  return map;
}

// Cache char-level diff segments so we don't recompute on every render
const modifySegments = computed(() => {
  return collectModifySegments(hunks.value);
});

const rollbackModifySegments = computed(() => {
  return collectModifySegments(rollbackHunks.value);
});

let measureRaf: number | null = null;
let measureTimeout: ReturnType<typeof setTimeout> | null = null;

function requestMeasure() {
  if (measureRaf) return;
  measureRaf = requestAnimationFrame(() => {
    measureRaf = null;
    measureHunks();
    connectorKey.value++;
  });
}

function requestMeasureDebounced() {
  if (measureTimeout) clearTimeout(measureTimeout);
  measureTimeout = setTimeout(() => {
    requestMeasure();
  }, 100);
}

function handleScroll(from: "left" | "right") {
  syncScroll(from);
  requestMeasureDebounced();
}

let rollbackMeasureRaf: number | null = null;
let rollbackMeasureTimeout: ReturnType<typeof setTimeout> | null = null;

function rollbackRequestMeasure() {
  if (rollbackMeasureRaf) return;
  rollbackMeasureRaf = requestAnimationFrame(() => {
    rollbackMeasureRaf = null;
    rollbackMeasureHunks();
    rollbackConnectorKey.value++;
  });
}

function rollbackRequestMeasureDebounced() {
  if (rollbackMeasureTimeout) clearTimeout(rollbackMeasureTimeout);
  rollbackMeasureTimeout = setTimeout(() => {
    rollbackRequestMeasure();
  }, 100);
}

function rollbackHandleScroll(from: "left" | "right") {
  rollbackSyncScroll(from);
  rollbackRequestMeasureDebounced();
}

function rollbackUpdateContainerSize() {
  const el = rollbackDiffContainerRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  rollbackContainerSize.value = { width: rect.width, height: rect.height };
}

watch(
  () => props.selectedObject?.id,
  async () => {
    await nextTick();
    updateContainerSize();
    requestMeasure();
  },
);

function updateContainerSize() {
  const el = diffContainerRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  containerSize.value = { width: rect.width, height: rect.height };
}

function onSplitpanesResized() {
  updateContainerSize();
  requestMeasure();
}

function rollbackOnSplitpanesResized() {
  rollbackUpdateContainerSize();
  rollbackRequestMeasure();
}

function lineBackground(line: DiffLine): string | undefined {
  if (line.isPadding) return undefined;
  if (line.type === "delete") {
    // source-only = will be added to target = green
    return toRgba(ddlColors.value.addedRowBg, ddlColors.value.addedRowBgAlpha);
  }
  if (line.type === "insert") {
    // target-only = will be removed from target = red
    return toRgba(ddlColors.value.removedRowBg, ddlColors.value.removedRowBgAlpha);
  }
  if (line.type === "modify") {
    return toRgba(ddlColors.value.modifiedRowBg, ddlColors.value.modifiedRowBgAlpha);
  }
  return undefined;
}

function lineTextClass(line: DiffLine): string {
  if (line.isPadding) return "text-transparent";
  if (line.type === "insert") return "line-through opacity-80";
  return "";
}

function computeCharDiffs(source: string, target: string): { source: string; target: string }[] {
  const result: { source: string; target: string }[] = [];
  let sIdx = 0;
  let tIdx = 0;
  while (sIdx < source.length || tIdx < target.length) {
    if (sIdx >= source.length) {
      result.push({ source: "", target: target.substring(tIdx) });
      break;
    }
    if (tIdx >= target.length) {
      result.push({ source: source.substring(sIdx), target: "" });
      break;
    }
    if (source[sIdx] === target[tIdx]) {
      let matchLen = 0;
      while (sIdx + matchLen < source.length && tIdx + matchLen < target.length && source[sIdx + matchLen] === target[tIdx + matchLen]) {
        matchLen++;
      }
      result.push({
        source: source.substring(sIdx, sIdx + matchLen),
        target: target.substring(tIdx, tIdx + matchLen),
      });
      sIdx += matchLen;
      tIdx += matchLen;
    } else {
      let sMatch = -1;
      let tMatch = -1;
      for (let i = 0; i < Math.min(10, source.length - sIdx, target.length - tIdx); i++) {
        if (source[sIdx + i] === target[tIdx]) {
          sMatch = i;
          tMatch = 0;
          break;
        }
        if (source[sIdx] === target[tIdx + i]) {
          sMatch = 0;
          tMatch = i;
          break;
        }
      }
      if (sMatch === -1) {
        sMatch = Math.min(1, source.length - sIdx);
        tMatch = Math.min(1, target.length - tIdx);
      }
      result.push({
        source: source.substring(sIdx, sIdx + (sMatch > 0 ? sMatch : 1)),
        target: target.substring(tIdx, tIdx + (tMatch > 0 ? tMatch : 1)),
      });
      sIdx += sMatch > 0 ? sMatch : 1;
      tIdx += tMatch > 0 ? tMatch : 1;
    }
  }
  return result;
}

function renderModifyLine(leftLine: DiffLine, rightLine: DiffLine): { leftSegments: Segment[]; rightSegments: Segment[] } {
  const { sourceSegments, targetSegments } = renderModifyContent(leftLine.content, rightLine.content);
  return { leftSegments: sourceSegments, rightSegments: targetSegments };
}

function renderModifyContent(source: string, target: string): { sourceSegments: Segment[]; targetSegments: Segment[] } {
  const charDiffs = computeCharDiffs(source, target);
  const leftSegments: Segment[] = [];
  const rightSegments: Segment[] = [];
  for (const cd of charDiffs) {
    if (cd.source === cd.target) {
      leftSegments.push({ text: cd.source, changed: false });
      rightSegments.push({ text: cd.target, changed: false });
    } else {
      if (cd.source) leftSegments.push({ text: cd.source, changed: true });
      if (cd.target) rightSegments.push({ text: cd.target, changed: true });
    }
  }
  return { sourceSegments: leftSegments, targetSegments: rightSegments };
}

interface Segment {
  text: string;
  changed: boolean;
}

function copyDeploySql() {
  copyToClipboard(props.deploySql);
  toast(t("diff.copied"), 2000);
}

function copyDeploySqlAll() {
  copyToClipboard(props.deploySqlAll);
  toast(t("diff.copied"), 2000);
}
</script>

<template>
  <div class="border rounded-md flex flex-col h-full">
    <!-- Forward / Rollback SQL mode toggle -->
    <div v-if="rollbackSql" class="flex items-center gap-1 px-3 py-1 border-b bg-muted/20 shrink-0">
      <span class="text-[11px] text-muted-foreground mr-2">{{ t("diff.deployMode") }}:</span>
      <button class="text-xs px-2 py-1 rounded transition-colors" :class="deploySqlMode === 'forward' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'" @click="$emit('update:deploySqlMode', 'forward')">{{ t("diff.forwardSql") }}</button>
      <button class="text-xs px-2 py-1 rounded transition-colors" :class="deploySqlMode === 'rollback' ? 'bg-destructive text-destructive-foreground' : 'hover:bg-accent'" @click="$emit('update:deploySqlMode', 'rollback')">{{ t("diff.rollbackSql") }}</button>
    </div>

    <div v-if="rollbackCompleteness === 'incomplete'" class="px-3 py-1.5 border-b bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-200 shrink-0">
      {{ t("diff.rollbackIncompleteBanner") }}
      <ul v-if="missingRollbackObjects?.length" class="mt-1 list-disc pl-4">
        <li v-for="(m, i) in missingRollbackObjects" :key="i">{{ m.kind }} {{ m.name }}{{ m.table ? ` @ ${m.table}` : "" }} — {{ m.reason }}</li>
      </ul>
    </div>
    <!-- Tabs -->
    <div class="flex border-b shrink-0">
      <button class="px-3 py-1.5 text-xs font-medium flex items-center gap-1 transition-colors" :class="activeTab === 'ddl' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'hover:bg-muted/50'" @click="activeTab = 'ddl'">
        <FileCode class="w-3.5 h-3.5" />
        {{ t("diff.ddlCompare") }}
      </button>
      <button class="px-3 py-1.5 text-xs font-medium flex items-center gap-1 transition-colors" :class="activeTab === 'script' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'hover:bg-muted/50'" @click="activeTab = 'script'">
        <ScrollText class="w-3.5 h-3.5" />
        {{ t("diff.deployScript") }}
      </button>
      <button class="px-3 py-1.5 text-xs font-medium flex items-center gap-1 transition-colors" :class="activeTab === 'scriptAll' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'hover:bg-muted/50'" @click="activeTab = 'scriptAll'">
        <ScrollText class="w-3.5 h-3.5" />
        {{ t("diff.deployScriptAll") }}
      </button>
      <button v-if="rollbackSql" class="px-3 py-1.5 text-xs font-medium flex items-center gap-1 transition-colors" :class="activeTab === 'rollbackCompare' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'hover:bg-muted/50'" @click="activeTab = 'rollbackCompare'">
        <FileDiff class="w-3.5 h-3.5" />
        {{ t("rollbackComparison.title") }}
      </button>
      <button
        v-if="compatibilityWarnings && compatibilityWarnings.length > 0"
        class="px-3 py-1.5 text-xs font-medium flex items-center gap-1 transition-colors relative"
        :class="activeTab === 'warnings' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-b-2 border-amber-500' : 'hover:bg-muted/50'"
        @click="activeTab = 'warnings'"
      >
        <span class="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
        {{ t("diff.compatibilityWarnings") }}
        <span class="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-500 text-white font-bold">{{ compatibilityWarnings.length }}</span>
      </button>
      <button v-if="dependencyGraph && dependencyGraph.nodes.length > 0" class="px-3 py-1.5 text-xs font-medium flex items-center gap-1 transition-colors" :class="activeTab === 'depGraph' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'hover:bg-muted/50'" @click="activeTab = 'depGraph'">
        <span class="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
        {{ t("diff.dependencyGraph") }}
      </button>
      <button v-if="permissionDiffs && permissionDiffs.length > 0" class="px-3 py-1.5 text-xs font-medium flex items-center gap-1 transition-colors" :class="activeTab === 'permissions' ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'hover:bg-muted/50'" @click="activeTab = 'permissions'">
        <span class="w-2 h-2 rounded-full bg-purple-500 shrink-0" />
        {{ t("diff.operation") }}
        <span class="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-purple-500 text-white font-bold">{{ permissionDiffs.length }}</span>
      </button>
    </div>

    <!-- DDL Compare -->
    <div v-if="activeTab === 'ddl'" class="flex-1 overflow-hidden relative">
      <!-- No object selected -->
      <div v-if="!selectedObject" class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        {{ t("diff.selectObjectToCompare") }}
      </div>
      <!-- No DDL data available -->
      <div v-else-if="!selectedObject.sourceDdl && !selectedObject.targetDdl" class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        {{ t("diff.noDdlAvailable") }}
      </div>
      <!-- Diff View -->
      <div v-else ref="diffContainerRef" class="absolute inset-0 font-mono text-xs leading-relaxed">
        <Splitpanes class="h-full" @resized="onSplitpanesResized">
          <!-- Source DDL -->
          <Pane min-size="20">
            <div ref="leftPaneRef" class="h-full overflow-y-auto border-r" @scroll="handleScroll('left')">
              <div class="sticky top-0 bg-muted/50 px-3 py-1.5 text-xs font-medium border-b z-10">
                {{ t("diff.sourceDdl") }}
              </div>
              <div v-for="hunk in hunks" :key="`left-${hunk.id}`" :data-hunk-id="hunk.id">
                <div
                  v-for="(line, idx) in hunk.leftLines"
                  :key="`l-${hunk.id}-${idx}`"
                  class="flex min-h-[1.5em]"
                  :class="{
                    'border rounded-sm border-yellow-500/40': line.type === 'modify',
                  }"
                  :style="{ backgroundColor: lineBackground(line) }"
                >
                  <span class="text-muted-foreground w-8 text-right pr-2 select-none shrink-0">
                    {{ line.lineNumber ?? "" }}
                  </span>
                  <span class="flex-1 px-1 whitespace-pre" :class="lineTextClass(line)">
                    <template v-if="line.type === 'modify' && !line.isPadding">
                      <template v-for="(segment, si) in modifySegments.get(`${hunk.id}:${idx}`)?.leftSegments ?? []" :key="`ls-${si}`">
                        <span :style="segment.changed ? { backgroundColor: toRgba(ddlColors.modifiedCharBg, ddlColors.modifiedCharBgAlpha) } : undefined">{{ segment.text }}</span>
                      </template>
                    </template>
                    <span v-else>{{ line.isPadding ? "\u00A0" : line.content }}</span>
                  </span>
                </div>
              </div>
            </div>
          </Pane>

          <!-- Target DDL -->
          <Pane min-size="20">
            <div ref="rightPaneRef" class="h-full overflow-y-auto" @scroll="handleScroll('right')">
              <div class="sticky top-0 bg-muted/50 px-3 py-1.5 text-xs font-medium border-b z-10">
                {{ t("diff.targetDdl") }}
              </div>
              <div v-for="hunk in hunks" :key="`right-${hunk.id}`" :data-hunk-id="hunk.id">
                <div
                  v-for="(line, idx) in hunk.rightLines"
                  :key="`r-${hunk.id}-${idx}`"
                  class="flex min-h-[1.5em]"
                  :class="{
                    'border rounded-sm border-yellow-500/40': line.type === 'modify',
                  }"
                  :style="{ backgroundColor: lineBackground(line) }"
                >
                  <span class="text-muted-foreground w-8 text-right pr-2 select-none shrink-0">
                    {{ line.lineNumber ?? "" }}
                  </span>
                  <span class="flex-1 px-1 whitespace-pre" :class="lineTextClass(line)">
                    <template v-if="line.type === 'modify' && !line.isPadding">
                      <template v-for="(segment, si) in modifySegments.get(`${hunk.id}:${idx}`)?.rightSegments ?? []" :key="`rs-${si}`">
                        <span :style="segment.changed ? { backgroundColor: toRgba(ddlColors.modifiedCharBg, ddlColors.modifiedCharBgAlpha) } : undefined">{{ segment.text }}</span>
                      </template>
                    </template>
                    <span v-else>{{ line.isPadding ? "\u00A0" : line.content }}</span>
                  </span>
                </div>
              </div>
            </div>
          </Pane>
        </Splitpanes>

        <!-- SVG Connector Overlay -->
        <DiffSvgConnector :key="connectorKey" :hunks="hunks" :container-width="containerSize.width" :container-height="containerSize.height" />
      </div>
    </div>

    <!-- Rollback Comparison -->
    <div v-else-if="activeTab === 'rollbackCompare'" class="flex-1 overflow-hidden relative">
      <div v-if="!rollbackSql" class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        {{ t("diff.noDdlAvailable") }}
      </div>
      <div v-else ref="rollbackDiffContainerRef" class="absolute inset-0 font-mono text-xs leading-relaxed">
        <Splitpanes class="h-full" @resized="rollbackOnSplitpanesResized">
          <Pane min-size="20">
            <div ref="rollbackLeftPaneRef" class="h-full overflow-y-auto border-r" @scroll="rollbackHandleScroll('left')">
              <div class="sticky top-0 bg-muted/50 px-3 py-1.5 text-xs font-medium border-b z-10">
                {{ t("rollbackComparison.forwardSql") }}
              </div>
              <div v-for="hunk in rollbackHunks" :key="`left-${hunk.id}`" :data-hunk-id="hunk.id">
                <div
                  v-for="(line, idx) in hunk.leftLines"
                  :key="`l-${hunk.id}-${idx}`"
                  class="flex min-h-[1.5em]"
                  :class="{
                    'border rounded-sm border-yellow-500/40': line.type === 'modify',
                  }"
                  :style="{ backgroundColor: lineBackground(line) }"
                >
                  <span class="text-muted-foreground w-8 text-right pr-2 select-none shrink-0">
                    {{ line.lineNumber ?? "" }}
                  </span>
                  <span class="flex-1 px-1 whitespace-pre" :class="lineTextClass(line)">
                    <template v-if="line.type === 'modify' && !line.isPadding">
                      <template v-for="(segment, si) in rollbackModifySegments.get(`${hunk.id}:${idx}`)?.leftSegments ?? []" :key="`ls-${si}`">
                        <span :style="segment.changed ? { backgroundColor: toRgba(ddlColors.modifiedCharBg, ddlColors.modifiedCharBgAlpha) } : undefined">{{ segment.text }}</span>
                      </template>
                    </template>
                    <span v-else>{{ line.isPadding ? "\u00A0" : line.content }}</span>
                  </span>
                </div>
              </div>
            </div>
          </Pane>
          <Pane min-size="20">
            <div ref="rollbackRightPaneRef" class="h-full overflow-y-auto" @scroll="rollbackHandleScroll('right')">
              <div class="sticky top-0 bg-muted/50 px-3 py-1.5 text-xs font-medium border-b z-10">
                {{ t("rollbackComparison.rollbackSql") }}
              </div>
              <div v-for="hunk in rollbackHunks" :key="`right-${hunk.id}`" :data-hunk-id="hunk.id">
                <div
                  v-for="(line, idx) in hunk.rightLines"
                  :key="`r-${hunk.id}-${idx}`"
                  class="flex min-h-[1.5em]"
                  :class="{
                    'border rounded-sm border-yellow-500/40': line.type === 'modify',
                  }"
                  :style="{ backgroundColor: lineBackground(line) }"
                >
                  <span class="text-muted-foreground w-8 text-right pr-2 select-none shrink-0">
                    {{ line.lineNumber ?? "" }}
                  </span>
                  <span class="flex-1 px-1 whitespace-pre" :class="lineTextClass(line)">
                    <template v-if="line.type === 'modify' && !line.isPadding">
                      <template v-for="(segment, si) in rollbackModifySegments.get(`${hunk.id}:${idx}`)?.rightSegments ?? []" :key="`rs-${si}`">
                        <span :style="segment.changed ? { backgroundColor: toRgba(ddlColors.modifiedCharBg, ddlColors.modifiedCharBgAlpha) } : undefined">{{ segment.text }}</span>
                      </template>
                    </template>
                    <span v-else>{{ line.isPadding ? "\u00A0" : line.content }}</span>
                  </span>
                </div>
              </div>
            </div>
          </Pane>
        </Splitpanes>
        <DiffSvgConnector :key="rollbackConnectorKey" :hunks="rollbackHunks" :container-width="rollbackContainerSize.width" :container-height="rollbackContainerSize.height" />
      </div>
    </div>

    <!-- Deploy Script -->
    <div v-else-if="activeTab === 'script'" class="flex-1 flex flex-col overflow-hidden">
      <div class="flex items-center justify-between px-3 py-1.5 border-b shrink-0">
        <span class="text-xs text-muted-foreground">{{ t("diff.deployScriptDesc") }}</span>
        <div class="flex gap-1">
          <Button variant="ghost" size="sm" class="h-6 px-2 text-xs gap-1" @click="copyDeploySql">
            <Copy class="w-3 h-3" />
            {{ t("diff.copy") }}
          </Button>
          <Button variant="ghost" size="sm" class="h-6 px-2 text-xs gap-1" :disabled="canExecute === false" @click="$emit('executeScript')">
            <Play class="w-3 h-3" />
            {{ t("diff.execute") }}
          </Button>
        </div>
      </div>
      <div class="flex-1 overflow-auto p-3">
        <pre class="text-xs whitespace-pre-wrap font-mono">{{ deploySql || t("diff.noDeployScript") }}</pre>
      </div>
    </div>

    <!-- Compatibility Warnings -->
    <div v-else-if="activeTab === 'warnings'" class="flex-1 flex flex-col overflow-hidden p-3">
      <div v-if="compatibilityWarnings && compatibilityWarnings.length > 0" class="space-y-2">
        <div v-for="(w, i) in compatibilityWarnings" :key="i" class="flex items-start gap-2 p-2 rounded border bg-amber-50 dark:bg-amber-950/20 text-xs">
          <span class="shrink-0 w-2 h-2 rounded-full mt-0.5" :class="w.risk === 'high' ? 'bg-red-500' : w.risk === 'medium' ? 'bg-amber-500' : 'bg-yellow-400'" />
          <div class="min-w-0">
            <span class="font-medium">{{ w.table }}.{{ w.column }}</span
            >:
            <span class="text-muted-foreground">{{ w.sourceType }} → {{ w.targetType }}</span>
            <p class="text-muted-foreground mt-0.5">{{ w.message }}</p>
          </div>
        </div>
      </div>
      <div v-else class="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        {{ t("diff.noDifferences") }}
      </div>
    </div>

    <!-- Dependency Graph -->
    <div v-else-if="activeTab === 'depGraph'" class="flex-1 flex flex-col overflow-hidden p-3">
      <div v-if="dependencyGraph && dependencyGraph.nodes.length > 0" class="space-y-1">
        <div v-for="node in dependencyGraph.nodes" :key="node.tableName" class="py-1 text-xs">
          <span class="font-mono font-medium">{{ node.tableName }}</span>
          <span v-if="node.dependsOn.length > 0" class="text-muted-foreground ml-2">
            → {{ t("diff.dependsOn") }}: <span class="font-mono">{{ node.dependsOn.join(", ") }}</span>
          </span>
          <span v-if="node.dependedBy.length > 0" class="text-muted-foreground ml-2">
            ← {{ t("diff.dependedBy") }}: <span class="font-mono">{{ node.dependedBy.join(", ") }}</span>
          </span>
        </div>
      </div>
      <div v-else class="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        {{ t("diff.noDifferences") }}
      </div>
    </div>

    <!-- Permissions -->
    <div v-else-if="activeTab === 'permissions'" class="flex-1 flex flex-col overflow-hidden p-3">
      <div v-if="permissionDiffs && permissionDiffs.length > 0" class="space-y-2">
        <div v-for="(pd, i) in permissionDiffs" :key="i" class="flex items-start gap-2 p-2 rounded border text-xs">
          <span class="shrink-0 w-2 h-2 rounded-full mt-0.5 bg-purple-500" />
          <div class="min-w-0">
            <span class="font-medium">{{ pd.objectName }}</span>
            <span class="text-muted-foreground"> — {{ pd.permissionType }}</span>
            <div class="mt-0.5">
              <span v-if="pd.sourcePermission" class="text-green-600 dark:text-green-400">{{ t("diff.source") }}: {{ pd.sourcePermission }}</span>
              <span v-if="pd.sourcePermission && pd.targetPermission" class="text-muted-foreground mx-1">→</span>
              <span v-if="pd.targetPermission" class="text-red-600 dark:text-red-400">{{ t("diff.target") }}: {{ pd.targetPermission }}</span>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        {{ t("diff.noDifferences") }}
      </div>
    </div>

    <!-- Deploy Script All -->
    <div v-else-if="activeTab === 'scriptAll'" class="flex-1 flex flex-col overflow-hidden">
      <div class="flex items-center justify-between px-3 py-1.5 border-b shrink-0">
        <span class="text-xs text-muted-foreground">{{ t("diff.deployScriptAllDesc") }}</span>
        <div class="flex gap-1">
          <Button variant="ghost" size="sm" class="h-6 px-2 text-xs gap-1" @click="copyDeploySqlAll">
            <Copy class="w-3 h-3" />
            {{ t("diff.copy") }}
          </Button>
          <Button variant="ghost" size="sm" class="h-6 px-2 text-xs gap-1" :disabled="canExecute === false" @click="$emit('executeScript')">
            <Play class="w-3 h-3" />
            {{ t("diff.executeAll") }}
          </Button>
        </div>
      </div>
      <div class="flex-1 overflow-auto p-3">
        <pre class="text-xs whitespace-pre-wrap font-mono">{{ deploySqlAll || t("diff.noDeployScriptAll") }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep(.splitpanes--vertical > .splitpanes__splitter) {
  background-color: var(--border);
  width: 4px;
  cursor: col-resize;
  position: relative;
}
:deep(.splitpanes--vertical > .splitpanes__splitter:hover) {
  background-color: var(--primary);
}
</style>
