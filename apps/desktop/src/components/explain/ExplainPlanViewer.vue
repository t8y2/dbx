<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, Braces, Check, Copy, Download, GitBranch, Table2, FileText, Workflow } from "@lucide/vue";
import type { ParsedExplainPlan, ExplainPlanNode } from "@/lib/diagram/explainPlan";
import { flattenExplainPlanNodes, formatExplainPlanDetails } from "@/lib/diagram/explainPlan";
import { extractActualRows } from "@/lib/diagram/planCanvas";
import { Button } from "@/components/ui/button";
import RedisJsonEditor from "@/components/redis/RedisJsonEditor.vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/composables/useToast";
import { translateBackendError } from "@/i18n/backend-errors";
import { copyToClipboard, isPlainClipboardShortcut } from "@/lib/common/clipboard";
import { EXPLAIN_PLAN_EXPORT_COLUMN_KEYS, saveExplainPlanExport, type ExplainPlanExportFormat } from "@/lib/export/explainPlanExport";
import type { QueryResult } from "@/types/database";
import type { DefaultExplainView } from "@/stores/settingsStore";
import ExplainPlanNodeTree from "./ExplainPlanNodeTree.vue";
import ExplainPlanDiagram from "./ExplainPlanDiagram.vue";

export type ExplainView = DefaultExplainView;

const props = defineProps<{
  plan?: ParsedExplainPlan;
  error?: string;
  loading?: boolean;
  sourceSql?: string;
  explainSql?: string;
  tableResult?: QueryResult;
  tableError?: string;
  defaultView?: ExplainView;
}>();

const { t } = useI18n();
const { toast } = useToast();
const exporting = ref(false);
const exportFormats: { format: ExplainPlanExportFormat; label: string }[] = [
  { format: "svg", label: "diagram.exportSvg" },
  { format: "png", label: "diagram.exportPng" },
  { format: "html", label: "grid.exportHtml" },
  { format: "csv", label: "grid.exportCsv" },
  { format: "xlsx", label: "grid.exportXlsx" },
];

async function exportPlan(format: ExplainPlanExportFormat) {
  if (exporting.value || props.loading || props.error || !props.plan?.nodes.length) return;
  exporting.value = true;
  try {
    const saved = await saveExplainPlanExport(
      props.plan,
      format,
      EXPLAIN_PLAN_EXPORT_COLUMN_KEYS.map((key) => t(key)),
      t("explain.estimatedTime"),
      `${t("explain.title")} · ${props.plan.databaseType.toUpperCase()}`,
      {
        cost: t("explain.cost"),
        estimatedRows: t("explain.estRows"),
        legendHeat: t("explain.legendHeat"),
        legendEdge: t("explain.legendEdge"),
      },
    );
    if (saved) toast(t("grid.exported"));
  } catch (error) {
    toast(t("grid.exportFailed", { message: translateBackendError(t, error) }), 5000);
  } finally {
    exporting.value = false;
  }
}
const userSelectedView = ref<ExplainView | null>(null);
const activeView = ref<ExplainView>("canvas");
const hasTableView = computed(() => !!props.tableResult || !!props.tableError);

function isViewAvailable(view: ExplainView): boolean {
  if (view === "table") return hasTableView.value;
  return !!props.plan;
}

function resolveView(): ExplainView {
  if (userSelectedView.value && isViewAvailable(userSelectedView.value)) {
    return userSelectedView.value;
  }

  const preferred = props.defaultView ?? "canvas";
  if (preferred === "table") {
    if (hasTableView.value) return "table";
    if (props.plan) return "canvas";
    return "table";
  }

  if (props.plan) return preferred;
  if (!props.loading && hasTableView.value) return "table";
  return preferred;
}

function selectView(view: ExplainView) {
  userSelectedView.value = view;
  activeView.value = view;
}

watch([() => props.loading, () => props.sourceSql, () => props.explainSql, () => props.defaultView], ([loading, sourceSql, explainSql, defaultView], [prevLoading, prevSourceSql, prevExplainSql, prevDefaultView]) => {
  if ((loading && !prevLoading) || sourceSql !== prevSourceSql || explainSql !== prevExplainSql || defaultView !== prevDefaultView) {
    userSelectedView.value = null;
  }
});

watch(
  [hasTableView, () => !!props.tableResult, () => !!props.plan, () => props.loading, () => props.defaultView],
  () => {
    activeView.value = resolveView();
  },
  { immediate: true },
);

const flatRows = computed(() => {
  const rows: Array<{ node: ExplainPlanNode; depth: number }> = [];
  function visit(node: ExplainPlanNode, depth: number) {
    rows.push({ node, depth });
    node.children.forEach((child) => visit(child, depth + 1));
  }
  props.plan?.nodes.forEach((node) => visit(node, 0));
  return rows;
});

const rawContent = computed(() => {
  if (!props.plan?.raw) return "";
  // DM returns raw plan text as a string → show as-is
  if (typeof props.plan.raw === "string") return props.plan.raw;
  // Other DBs return JSON → pretty-print
  return JSON.stringify(props.plan.raw, null, 2);
});

const isRawString = computed(() => typeof props.plan?.raw === "string");
const rawFormatLabel = computed(() => (props.plan?.databaseType === "sqlserver" ? "XML" : isRawString.value ? "TEXT" : "JSON"));
const nodeCount = computed(() => (props.plan ? flattenExplainPlanNodes(props.plan.nodes).length : 0));
// Measured rows exist only when the plan was produced by a mode that ran the query:
// EXPLAIN ANALYZE on Postgres, SET STATISTICS XML on SQL Server.
const measuredRowsLabel = computed(() => {
  const databaseType = props.plan?.databaseType;
  if (databaseType !== "postgres" && databaseType !== "sqlserver") return undefined;
  if (!flattenExplainPlanNodes(props.plan!.nodes).some((node) => extractActualRows(node) !== undefined)) return undefined;
  return databaseType === "sqlserver" ? "ACTUAL" : "ANALYZE";
});

const copied = ref(false);
let copiedTimer: number | undefined;

async function copyRawContent() {
  if (!rawContent.value) return;
  try {
    await copyToClipboard(rawContent.value);
    copied.value = true;
    window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => (copied.value = false), 1600);
    toast(t("explain.copied"), 1500);
  } catch (error) {
    toast(t("explain.copyFailed", { message: error instanceof Error ? error.message : String(error) }), 3000);
  }
}

onUnmounted(() => window.clearTimeout(copiedTimer));

// Ctrl/Cmd+A inside the XML / TEXT block selects only the plan text, so it can be
// copied natively instead of being swallowed by the app-wide select-all guard.
function onRawKeydown(event: KeyboardEvent) {
  if (!isPlainClipboardShortcut(event, "a")) return;
  const el = event.currentTarget as HTMLElement | null;
  const selection = window.getSelection();
  if (!el || !selection) return;
  event.preventDefault();
  event.stopPropagation();
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

function tableCellText(value: unknown): string {
  if (value === null) return "NULL";
  return value === undefined ? "" : String(value);
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="h-9 shrink-0 border-b px-3 flex items-center gap-2 text-xs overflow-x-auto overflow-y-hidden">
      <span class="shrink-0 whitespace-nowrap inline-flex items-center gap-1 rounded border bg-muted px-2 py-0.5 font-medium">
        <GitBranch class="h-3.5 w-3.5" />
        {{ t("explain.title") }}
      </span>
      <span v-if="plan || hasTableView" class="shrink-0 whitespace-nowrap text-muted-foreground">
        {{ plan?.databaseType.toUpperCase() || "MYSQL" }}<template v-if="plan"> · {{ t("explain.nodeCount", { count: nodeCount }) }}</template>
      </span>
      <span v-if="plan?.databaseType === 'dameng' && isRawString && rawContent.includes('->')" class="shrink-0 whitespace-nowrap ml-1 inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 font-semibold text-green-700 dark:bg-green-900/30 dark:text-green-300" style="font-size: 10px"
        >A-TRACE</span
      >
      <span v-if="measuredRowsLabel" class="shrink-0 whitespace-nowrap ml-1 inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 font-semibold text-green-700 dark:bg-green-900/30 dark:text-green-300" style="font-size: 10px">{{ measuredRowsLabel }}</span>
      <span class="flex-1 min-w-2" />
      <DropdownMenu v-if="plan">
        <DropdownMenuTrigger as-child>
          <Button size="sm" variant="ghost" class="h-6 shrink-0 gap-1 px-2 text-xs" :disabled="loading || !!error || exporting || !plan.nodes.length">
            <Download class="h-3.5 w-3.5" />
            {{ t("grid.export") }}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem v-for="item in exportFormats" :key="item.format" :disabled="exporting" @select="exportPlan(item.format)">
            {{ t(item.label) }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div v-if="plan || hasTableView" class="shrink-0 inline-flex rounded-md border bg-muted/40 p-0.5">
        <Button v-if="plan" size="sm" :variant="activeView === 'canvas' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs gap-1" @click="selectView('canvas')">
          <Workflow class="h-3.5 w-3.5" />
          {{ t("explain.canvas") }}
        </Button>
        <Button v-if="plan" size="sm" :variant="activeView === 'tree' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs gap-1" @click="selectView('tree')">
          <GitBranch class="h-3.5 w-3.5" />
          {{ t("explain.tree") }}
        </Button>
        <Button v-if="plan" size="sm" :variant="activeView === 'summary' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs gap-1" @click="selectView('summary')">
          <Table2 class="h-3.5 w-3.5" />
          {{ t("explain.summary") }}
        </Button>
        <Button v-if="plan" size="sm" :variant="activeView === 'raw' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs gap-1" @click="selectView('raw')">
          <FileText v-if="isRawString" class="h-3.5 w-3.5" />
          <Braces v-else class="h-3.5 w-3.5" />
          {{ rawFormatLabel }}
        </Button>
        <Button v-if="hasTableView" size="sm" :variant="activeView === 'table' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs gap-1" @click="selectView('table')">
          <Table2 class="h-3.5 w-3.5" />
          {{ t("explain.standardTable") }}
        </Button>
      </div>
    </div>

    <div v-if="loading && !(activeView === 'table' && hasTableView)" class="flex-1 min-h-0 flex items-center justify-center text-sm text-muted-foreground">
      {{ t("explain.running") }}
    </div>

    <div v-else-if="activeView === 'table' && hasTableView" class="flex-1 min-h-0 overflow-auto">
      <div v-if="tableError" class="flex h-full min-h-0 items-center justify-center p-3">
        <div class="flex max-w-xl items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
          <span>{{ tableError }}</span>
        </div>
      </div>

      <div v-else-if="tableResult" class="p-3">
        <div class="overflow-x-auto rounded border">
          <table class="min-w-full w-max text-left text-xs">
            <thead class="bg-muted/70 text-muted-foreground">
              <tr>
                <th v-for="(column, columnIndex) in tableResult.columns" :key="columnIndex" class="whitespace-nowrap px-2 py-1.5 font-medium">{{ column }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, rowIndex) in tableResult.rows" :key="rowIndex" class="border-t">
                <td v-for="(_column, columnIndex) in tableResult.columns" :key="columnIndex" class="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                  {{ tableCellText(row[columnIndex]) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div v-else-if="error" class="flex-1 min-h-0 flex items-center justify-center">
      <div class="flex max-w-xl items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
        <span>{{ error }}</span>
      </div>
    </div>

    <div v-else-if="!plan" class="flex-1 min-h-0 flex items-center justify-center text-sm text-muted-foreground">
      {{ t("explain.empty") }}
    </div>

    <div v-else-if="activeView === 'canvas'" class="flex-1 min-h-0">
      <ExplainPlanDiagram :nodes="plan.nodes" />
    </div>

    <div v-else class="flex-1 min-h-0 overflow-auto">
      <div v-if="activeView === 'tree'" class="mx-auto max-w-5xl space-y-px p-2">
        <ExplainPlanNodeTree v-for="node in plan.nodes" :key="node.id" :node="node" />
      </div>

      <div v-else-if="activeView === 'summary'" class="p-3">
        <div class="overflow-auto rounded border">
          <table class="w-full min-w-[760px] text-left text-xs">
            <thead class="bg-muted/70 text-muted-foreground">
              <tr>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.node") }}</th>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.relation") }}</th>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.index") }}</th>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.cost") }}</th>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.rows") }}</th>
                <th class="px-2 py-1.5 font-medium">{{ t("explain.details") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in flatRows" :key="row.node.id" class="border-t">
                <td class="px-2 py-1.5 font-medium" :style="{ paddingLeft: `${8 + row.depth * 18}px` }">
                  {{ row.node.title }}
                </td>
                <td class="px-2 py-1.5 text-muted-foreground">{{ row.node.relation || "-" }}</td>
                <td class="px-2 py-1.5 text-muted-foreground">{{ row.node.index || "-" }}</td>
                <td class="px-2 py-1.5 tabular-nums">{{ row.node.cost || "-" }}</td>
                <td class="px-2 py-1.5 tabular-nums">{{ row.node.rows || "-" }}</td>
                <td class="px-2 py-1.5 text-muted-foreground">
                  {{ formatExplainPlanDetails(row.node, t("explain.estimatedTime")).join("; ") || "-" }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-else class="relative m-3 rounded border bg-muted/30" :class="rawFormatLabel === 'JSON' ? 'flex h-full min-h-0 flex-col' : ''">
        <Button v-if="rawContent" size="sm" variant="outline" class="absolute right-3 top-2 z-10 h-6 px-2 text-xs gap-1 bg-background/90" data-testid="explain-copy-raw" @click="copyRawContent">
          <Check v-if="copied" class="h-3.5 w-3.5" />
          <Copy v-else class="h-3.5 w-3.5" />
          {{ t("explain.copyRaw", { format: rawFormatLabel }) }}
        </Button>
        <RedisJsonEditor v-if="rawFormatLabel === 'JSON'" :model-value="rawContent" read-only presentation="viewer" class="min-h-0 flex-1" />
        <pre v-else data-native-clipboard tabindex="-1" class="overflow-auto whitespace-pre p-3 font-mono text-xs leading-relaxed select-text outline-none" @keydown="onRawKeydown">{{ rawContent }}</pre>
      </div>
    </div>
  </div>
</template>
