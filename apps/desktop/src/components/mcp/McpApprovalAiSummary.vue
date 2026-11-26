<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores/settingsStore";
import { aiComplete } from "@/lib/backend/api";
import { buildMcpApprovalSummaryRequest, normalizeMcpApprovalAiSettings, parseMcpApprovalSummary, resolveMcpApprovalAiConfig, type McpApprovalSummary, type McpApprovalSummaryInput } from "@/lib/mcp/mcpApprovalSummary";

const props = defineProps<{ approval: McpApprovalSummaryInput }>();
const { t, locale } = useI18n();
const settings = useSettingsStore();
const loading = ref(false);
const result = ref<McpApprovalSummary | null>(null);
const errorKey = ref("");
const model = ref("");
const initialized = ref(false);
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const selection = computed(() => normalizeMcpApprovalAiSettings(settings.editorSettings.mcpApprovalAi));
const config = computed(() => resolveMcpApprovalAiConfig(settings.aiConfigs, selection.value));
const identity = computed(() => JSON.stringify([props.approval, locale.value, selection.value.configId, selection.value.modelId, config.value]));
const riskClass = computed(() => ({ low: "bg-emerald-500", medium: "bg-amber-500", high: "bg-red-500", unknown: "bg-slate-400" })[result.value?.riskLevel || "unknown"]);
function reset() {
  revision += 1;
  clearTimeout(timer);
  loading.value = false;
  result.value = null;
  errorKey.value = "";
  model.value = "";
}
watch(
  identity,
  () => {
    reset();
    if (initialized.value && selection.value.autoGenerate && config.value) void generate();
  },
  { flush: "sync" },
);
onUnmounted(reset);
onMounted(async () => {
  try {
    await Promise.all([settings.initAiConfigs(), settings.initEditorSettings()]);
  } catch {
    errorKey.value = "settings.mcpApprovalAiConfigure";
  }
  if (!alive) return;
  initialized.value = true;
  if (selection.value.autoGenerate && config.value) void generate();
});
let alive = true;
onUnmounted(() => {
  alive = false;
});

async function generate() {
  if (loading.value || !config.value) return;
  reset();
  const generation = revision;
  const request = buildMcpApprovalSummaryRequest({ ...props.approval }, config.value, locale.value);
  model.value = config.value.model;
  loading.value = true;
  timer = setTimeout(() => {
    if (generation !== revision) return;
    revision += 1;
    loading.value = false;
    errorKey.value = "settings.mcpApprovalAiTimeout";
  }, 20_000);
  try {
    const answer = await aiComplete(request);
    if (generation === revision) result.value = parseMcpApprovalSummary(answer);
  } catch {
    if (generation === revision) errorKey.value = "settings.mcpApprovalAiFailed";
  } finally {
    if (generation === revision) {
      clearTimeout(timer);
      loading.value = false;
    }
  }
}
</script>

<template>
  <div class="min-w-0 space-y-2" data-mcp-approval-ai>
    <div v-if="config" class="flex flex-wrap items-center justify-between gap-2" data-mcp-approval-ai-toolbar>
      <span class="text-xs text-muted-foreground">{{ t("settings.mcpApprovalAiModel", { model: config.model }) }}</span>
      <Button variant="outline" size="sm" :disabled="loading" data-mcp-approval-ai-generate @click="generate">
        {{ t(loading ? "settings.mcpApprovalAiLoading" : result ? "settings.mcpApprovalAiRegenerate" : "settings.mcpApprovalAiGenerate") }}
      </Button>
    </div>
    <p class="text-xs text-muted-foreground">{{ t(config ? "settings.mcpApprovalAiDisclosure" : "settings.mcpApprovalAiConfigure") }}</p>
    <p v-if="errorKey" role="alert" class="text-xs text-destructive">{{ t(errorKey) }}</p>
    <div v-if="result" class="space-y-3 rounded border bg-muted/20 p-3" data-mcp-approval-ai-result>
      <section class="space-y-1" data-mcp-approval-risk>
        <h3 class="text-xs font-medium">{{ t("settings.mcpApprovalAiRiskTitle") }}</h3>
        <p class="flex items-center gap-2 text-sm font-semibold"><span aria-hidden="true" class="size-2.5 shrink-0 rounded-full" :class="riskClass" />{{ t(`settings.mcpApprovalAiRisk_${result.riskLevel}`) }}</p>
      </section>
      <section class="space-y-1">
        <h3 class="text-xs font-medium">{{ t("settings.mcpApprovalAiExecution") }}</h3>
        <p class="text-xs whitespace-pre-wrap break-all" data-mcp-approval-summary>{{ result.summary }}</p>
      </section>
      <section class="space-y-1">
        <h3 class="text-xs font-medium">{{ t("settings.mcpApprovalAiRationale") }}</h3>
        <ul class="list-disc space-y-1 pl-4 text-xs">
          <li v-for="(risk, index) in result.risks" :key="index" class="whitespace-pre-wrap break-all">{{ risk }}</li>
        </ul>
      </section>
    </div>
    <p v-if="result" class="text-xs text-muted-foreground">{{ t("settings.mcpApprovalAiCaution") }}</p>
  </div>
</template>
