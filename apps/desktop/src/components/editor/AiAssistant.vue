<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import {
  ArrowDown,
  ArrowUp,
  ArrowRightLeft,
  AlertTriangle,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Copy,
  Database,
  FileCode,
  FileDown,
  FlaskConical,
  GitBranch,
  HelpCircle,
  History,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Replace,
  Server,
  ShieldCheck,
  Table2,
  Play,
  Square,
  Trash2,
  Terminal,
  Wand2,
  Wrench,
  X,
  Zap,
  TestTube,
  Search,
} from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore, AI_PROVIDER_PRESETS, normalizeAiConfig } from "@/stores/settingsStore";
import AiProviderLogo from "@/components/icons/AiProviderLogo.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { usePromptTemplateStore } from "@/stores/promptTemplateStore";
import { connectionIconType } from "@/lib/connection/connectionPresentation";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import ConnectionGroupBadge from "@/components/connection/ConnectionGroupBadge.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import { useNavigationTargets } from "@/composables/useNavigationTargets";
import { buildAiContext, resolveAiDatabaseTarget, resolveAiNamespaceSelection, resolveDefaultAiSchema, runAgentStream, isVectorDbType, isValidActionForMode, defaultActionForMode, type AiAction, type AiAssistantMode, type AiSqlFileContext, type CustomPromptContext } from "@/lib/ai/ai";
import { isAiConfigModelCandidate } from "@/lib/ai/aiConfigCandidates";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { addConfiguredAiModel, aiModelOptions } from "@/lib/ai/aiConfigList";
import { orderAiConfigsForDisplay } from "@/lib/ai/aiConfigOrdering";
import { effortSelectionEquals, runtimeEffortFromPreference } from "@/lib/ai/aiEffortPreference";
import { useAiModelCatalog } from "@/composables/useAiModelCatalog";
import { ACTIVE_TEMPLATES_TOTAL_MAX, promptTemplateCharacterCount } from "@/types/promptTemplate";

import type { AgentEvent } from "@/lib/backend/tauri";
import { buildAiAgentPlan } from "@/lib/ai/aiAgentPlan";
import { extractFirstSqlCodeBlock, extractSingleSqlCodeBlock } from "@/lib/ai/aiSqlExecutionPolicy";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import ProductionContextBadge from "@/components/common/ProductionContextBadge.vue";
import { buildAiAgentStepItems, toolCallStepKey, upsertAgentStep, type AiAgentStepItem, type AiAgentStepTone } from "@/lib/ai/aiAgentStepPresentation";
import { createAiShikiCodeHighlighter, type AiCodeHighlighter } from "@/lib/ai/aiCodeHighlighter";
import { createAiMessageRenderer } from "@/lib/ai/aiMessageRender";
import { formatAiInlineMarkdown, handleAiMarkdownLinkClick } from "@/lib/ai/aiMarkdown";
import { aiCancelStream, saveAiConversation, loadAiConversations, deleteAiConversation, listSchemas, listTables, type AiConversation } from "@/lib/backend/api";
import type { AiMessage } from "@/lib/backend/api";
import type { AiConfigItem, AiEffortCapability, AiEffortOption, AiEffortSelection } from "@/types/ai";
import type { ConnectionConfig, QueryTab, SavedSqlFile, TableInfo } from "@/types/database";
import { fetchNamespaceOptionsForConnection, useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { decodeSelectableDatabaseValue, encodeSelectableDatabaseValue, formatDatabaseLabel, resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { normalizeSqliteNamespace } from "@/lib/database/sqliteNamespace";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";
import { isSchemaAware } from "@/lib/database/databaseCapabilities";
import ExplainPlanViewer from "@/components/explain/ExplainPlanViewer.vue";
import { parseExplainResult, parseOracleExplainText, type ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import { copyToClipboard } from "@/lib/common/clipboard";
import { AI_TABLE_MENTION_CANDIDATE_LIMIT, AI_TABLE_MENTION_SCHEMA_LIMIT, filterAiTableMentionCandidates, formatAiTableMention, parseAiTableMentions, type AiTableMention } from "@/lib/ai/aiTableMentions";
import { isAiPromptImeCompositionEvent, shouldSubmitAiPromptOnKeydown } from "@/lib/ai/aiPromptKeyboard";
import { looksLikeActionProposal, containsChinese, looksLikeWriteSqlProposal, shouldGrantWriteSqlOnShortAffirmative } from "@/lib/ai/aiProposalDetect";
import { visibleToActualIndex } from "@/lib/ai/aiMessageEdit";
import { shouldShowReasoningCharCount, reasoningCharCountClass } from "@/lib/ai/aiReasoningPresentation";
import { saveTextFile } from "@/lib/export/saveTextFile";
import { buildAiAnalysisExport } from "@/lib/export/aiAnalysisExport";

const { t } = useI18n();
const settings = useSettingsStore();
const connectionStore = useConnectionStore();
const savedSqlStore = useSavedSqlStore();
const promptTemplateStore = usePromptTemplateStore();
const queryStore = useQueryStore();
const { openTableTarget } = useNavigationTargets({
  showFieldLineageDialog: ref(false),
  showDatabaseSearchDialog: ref(false),
  showDiagramDialog: ref(false),
});
const { toast } = useToast();
const { isDark } = useTheme();
const supportsCliProviders = isTauriRuntime();

type AiMessageMention =
  | {
      kind: "table";
      raw: string;
      connectionId: string;
      database: string;
      schema?: string;
      table: string;
    }
  | {
      kind: "sqlFile";
      raw: string;
      connectionId: string;
      id: string;
      name: string;
    };

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Connection that produced this assistant response; ephemeral export metadata. */
  sourceConnectionName?: string;
  mentions?: AiMessageMention[];
  reasoning?: string;
  isThinking?: boolean;
  agentSteps?: AiAgentStepItem[];
  /** Hidden system-generated context summary; not rendered in chat UI but included in LLM history. */
  kind?: "contextSummary";
  /** Per-message token stats from the last agent run; ephemeral, not persisted. */
  tokens?: { input: number; output: number };
}

const props = defineProps<{
  tab?: QueryTab;
  connection?: ConnectionConfig;
}>();

const emit = defineEmits<{
  replaceSql: [sql: string];
  executeSql: [sql: string];
  tempRunSql: [sql: string];
  requestAutoExecuteSql: [sql: string];
  insertRedisCommand: [command: string];
  executeRedisCommand: [command: string];
  openExplainPlan: [sql: string];
  close: [];
}>();

const prompt = ref("");
const messages = ref<ChatMessage[]>([]);
const isGenerating = ref(false);
const scrollRef = ref<InstanceType<typeof ScrollArea> | null>(null);
const activeAction = ref<AiAction>("general");
const assistantMode = ref<AiAssistantMode>("ask");
// The selection is loaded asynchronously. Apply it once when this panel mounts,
// but do not let later setting changes alter an active conversation.
let defaultModeInitialized = false;
watch(
  () => settings.isAiConfigLoaded,
  (loaded) => {
    if (loaded && !defaultModeInitialized) {
      assistantMode.value = settings.defaultAiMode;
      defaultModeInitialized = true;
    }
  },
  { immediate: true },
);
const currentSessionId = ref("");
const conversationId = ref("");
const conversations = ref<AiConversation[]>([]);
const showConversationList = ref(false);
const showTemplateSelector = ref(false);
const modeActionOpen = ref(false);

// Prompt template selection (panel-session scope)
const activeTemplateIds = ref<string[]>([]);
const activeTemplates = computed(() => promptTemplateStore.templates.filter((t) => activeTemplateIds.value.includes(t.id)));

watch(
  () => promptTemplateStore.templates,
  (templates) => {
    const availableIds = new Set(templates.map((template) => template.id));
    activeTemplateIds.value = activeTemplateIds.value.filter((id) => availableIds.has(id));
  },
);

// Retry store load on selector open if prior init failed (e.g. backend not yet ready at mount)
watch(showTemplateSelector, (open) => {
  if (open) void promptTemplateStore.ensureLoaded();
});

// Reset template selection when the user switches to a different connection or database —
// a new database context warrants a fresh selection of scenario templates.
watch(
  // Return a stable primitive key: a fresh array literal is never Object.is-equal to the
  // previous one, so a getter returning `[id, database]` fires on every dependency
  // invalidation (e.g. the 30s backup scheduler replacing connection objects) even when the
  // id/database values are unchanged — spuriously clearing the selection mid agent-run.
  () => `${props.connection?.id ?? ""}::${props.tab?.database ?? ""}`,
  () => {
    activeTemplateIds.value = [];
  },
);

function toggleTemplateId(id: string) {
  if (activeTemplateIds.value.includes(id)) {
    activeTemplateIds.value = activeTemplateIds.value.filter((tid) => tid !== id);
  } else {
    // Check total content limit
    const tpl = promptTemplateStore.templates.find((t) => t.id === id);
    if (tpl) {
      const currentTotal = activeTemplates.value.reduce((sum, template) => sum + promptTemplateCharacterCount(template.content), 0);
      if (currentTotal + promptTemplateCharacterCount(tpl.content) > ACTIVE_TEMPLATES_TOTAL_MAX) {
        toast(t("ai.templateSelectorTooLong", { max: ACTIVE_TEMPLATES_TOTAL_MAX }), 4000);
        return;
      }
    }
    activeTemplateIds.value = [...activeTemplateIds.value, id];
  }
}

function deselectAllTemplates() {
  activeTemplateIds.value = [];
}

const templateSelectorLabel = computed(() => {
  if (!promptTemplateStore.isLoaded) return t("ai.templateSelectorLoading");
  const count = activeTemplates.value.length;
  if (count === 0) return t("ai.templateSelectorNone");
  const name = activeTemplates.value[0].name;
  if (count === 1) return name;
  return `${name} +${count - 1}`;
});
const templateSelectorTriggerLabel = computed(() => {
  if (activeTemplates.value.length === 0) {
    return t("ai.templateSelectorLabel", { label: templateSelectorLabel.value });
  }
  return templateSelectorLabel.value;
});
const promptTextareaRef = ref<HTMLTextAreaElement | null>(null);
const shouldAutoScroll = ref(true);
const userPausedAutoScroll = ref(false);
const showScrollToBottom = ref(false);
const promptCompositionActive = ref(false);
const shikiCodeHighlighter = ref<AiCodeHighlighter>();
const promptHistory = ref<string[]>([]);
const historyIndex = ref(-1);
const draftBeforeHistory = ref("");

const editingMessageIndex = ref<number | null>(null);
const editingContent = ref("");
const editingMentions = ref<AiPromptMentionChip[]>([]);
const editCompositionActive = ref(false);
const MESSAGE_SCROLL_RESUME_THRESHOLD_PX = 16;
const MESSAGE_SCROLL_BUTTON_SHOW_THRESHOLD_PX = 120;
const MESSAGE_SCROLL_BUTTON_HIDE_THRESHOLD_PX = 48;
let messageScrollViewport: HTMLElement | null = null;
let messageTouchStartY: number | null = null;
let lastMessageScrollTop = 0;
const STREAM_RENDER_INTERVAL_MS = 33;
let assistantDeltaFrame: number | null = null;
let lastAssistantFlushAt = 0;
let pendingAssistantDelta = "";
let pendingAssistantReasoning = "";
let pendingAssistantIndex = -1;

function startEditMessage(visibleIndex: number) {
  if (isGenerating.value) return;
  editingMessageIndex.value = visibleIndex;
  const msg = visibleMessages.value[visibleIndex];
  editingContent.value = msg.content;
  editingMentions.value = promptMentionChipsFromMessage(msg);
  nextTick(() => {
    const el = document.querySelector<HTMLTextAreaElement>("[data-edit-textarea]");
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  });
}

function cancelEdit() {
  editingMessageIndex.value = null;
  editingContent.value = "";
  editingMentions.value = [];
}

function submitEdit(visibleIndex: number) {
  const content = editingContent.value.trim();
  if (!content && !editingMentions.value.length) return;
  const actualIndex = visibleToActualIndex(messages.value, visibleIndex);
  if (actualIndex < 0) return;
  if (!props.connection || !props.tab) return;
  if (!activeFullConfig.value) {
    toast(t("ai.noConfig"));
    return;
  }
  messages.value = messages.value.slice(0, actualIndex);
  editingMessageIndex.value = null;
  editingContent.value = "";
  selectedMentions.value = editingMentions.value.filter((mention): mention is AiTableMention & { kind: "table" } => mention.kind === "table").map(({ raw, schema, table }) => ({ raw, schema, table }));
  selectedSqlFileMentions.value = editingMentions.value.filter((mention): mention is AiSqlFileMention => mention.kind === "sqlFile");
  editingMentions.value = [];
  prompt.value = content;
  send();
}

function onEditKeydown(event: KeyboardEvent, visibleIndex: number) {
  if (isAiPromptImeCompositionEvent(event, editCompositionActive.value)) return;
  if (event.key === "Escape") {
    cancelEdit();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitEdit(visibleIndex);
  }
}

// Inline model selector
const providerSelectorOpen = ref(false);
const modelSearchQuery = ref("");
const collapsedModelConfigIds = ref<Set<string>>(new Set());
const effortMenuOpen = ref(false);
const manualModelConfigId = ref("");
const manualModelId = ref("");
const effortTextValue = ref("");
const effortIntegerValue = ref(0);
let effortMenuCloseTimer: ReturnType<typeof setTimeout> | null = null;
const { catalogs: modelCatalogs, effortCatalogs, loadModels, resolveEffort, effortKey } = useAiModelCatalog();

// Configured providers for quick switching - get from aiConfigs
const configuredProviders = computed(() => {
  const providers = orderAiConfigsForDisplay(settings.aiConfigs.filter(isModelCandidate));
  if (modelSearchQuery.value.trim()) {
    const query = modelSearchQuery.value.trim().toLowerCase();
    return providers.filter((c) => {
      if (configMatchesModelQuery(c, query)) return true;
      const models = getModelsForConfig(c.id);
      return models.some((model) => model.id.toLowerCase().includes(query) || model.displayName?.toLowerCase().includes(query));
    });
  }
  return providers;
});

const activeFullConfig = computed(() => {
  if (!settings.activeModel) return null;
  const item = settings.aiConfigs.find((c) => c.id === settings.activeModel!.configId);
  if (!item || !isModelCandidate(item)) return null;
  const modelId = settings.activeModel.modelId;
  return normalizeAiConfig({ ...item, model: modelId, runtimeEffort: runtimeEffortFromPreference(settings.activeEffort) });
});

function isModelCandidate(config: AiConfigItem): boolean {
  return isAiConfigModelCandidate(config, AI_PROVIDER_PRESETS[config.provider].requiresApiKey, supportsCliProviders);
}

function getModelsForConfig(configId: string) {
  const config = settings.aiConfigs.find((item) => item.id === configId);
  if (!config) return [];
  return aiModelOptions(config, modelCatalogs.get(configId)?.models ?? []);
}

function configMatchesModelQuery(config: AiConfigItem, query: string): boolean {
  return config.name.toLowerCase().includes(query) || config.provider.toLowerCase().includes(query) || AI_PROVIDER_PRESETS[config.provider].label.toLowerCase().includes(query);
}

function getConfigModelOptions(config: AiConfigItem) {
  const models = getModelsForConfig(config.id);
  const query = modelSearchQuery.value.trim().toLowerCase();
  if (!query || configMatchesModelQuery(config, query)) return models;
  return models.filter((model) => model.id.toLowerCase().includes(query) || model.displayName?.toLowerCase().includes(query));
}

function getModelCatalog(configId: string) {
  return modelCatalogs.get(configId) ?? { status: "idle" as const, models: [] };
}

function isModelConfigCollapsed(configId: string): boolean {
  return collapsedModelConfigIds.value.has(configId);
}

function toggleModelConfig(configId: string) {
  const next = new Set(collapsedModelConfigIds.value);
  if (next.has(configId)) next.delete(configId);
  else next.add(configId);
  collapsedModelConfigIds.value = next;
}

async function loadConfiguredModelCatalogs(force = false) {
  const configs = settings.aiConfigs.filter(isModelCandidate);
  const queue = [...configs];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const config = queue.shift();
      if (!config) return;
      await loadModels(config, force).catch(() => {});
    }
  });
  await Promise.all(workers);
}

watch(providerSelectorOpen, (open) => {
  if (open) {
    void loadConfiguredModelCatalogs();
  } else {
    modelSearchQuery.value = "";
    closeEffortMenu();
    manualModelConfigId.value = "";
    manualModelId.value = "";
  }
});

async function ensureModelEffort(config: AiConfigItem, modelId: string, force = false) {
  try {
    const capability = await resolveEffort(config, modelId, force);
    syncEffortInputs(capability);
  } catch {
    // The effort section exposes the scoped retry state.
  }
}

function handleModelSelect(configId: string, modelId: string) {
  const config = settings.aiConfigs.find((c) => c.id === configId);
  if (!config) return;
  settings.updateActiveModel({ configId, modelId });
  closeEffortMenu();
}

function startManualModel(configId: string) {
  manualModelConfigId.value = configId;
  manualModelId.value = settings.activeModel?.configId === configId ? settings.activeModel.modelId : "";
  nextTick(() => document.querySelector<HTMLInputElement>("[data-manual-model-input]")?.focus());
}

async function applyManualModel(configId: string) {
  const modelId = manualModelId.value.trim();
  if (!modelId) return;
  const config = settings.aiConfigs.find((item) => item.id === configId);
  if (!config) return;
  try {
    if (config.model.trim() !== modelId) {
      await settings.updateAiConfigItem(configId, { models: addConfiguredAiModel(config.models, modelId) });
    }
    handleModelSelect(configId, modelId);
    manualModelConfigId.value = "";
    manualModelId.value = "";
  } catch (error) {
    toast(translateBackendError(t, error));
  }
}

const activeEffortEntry = computed(() => {
  const active = settings.activeModel;
  if (!active) return undefined;
  return effortCatalogs.get(effortKey(active.configId, active.modelId));
});

const activeEffortCapability = computed(() => activeEffortEntry.value?.capability);

function syncEffortInputs(capability = activeEffortCapability.value) {
  const selection = settings.activeEffort;
  effortTextValue.value = selection?.kind === "text" ? selection.value : "";
  if (capability?.kind === "integer") {
    const selectedValue = selection?.kind === "integer" ? selection.value : undefined;
    const defaultValue = capability.default.kind === "integer" ? capability.default.value : undefined;
    effortIntegerValue.value = selectedValue !== undefined && selectedValue >= capability.min && selectedValue <= capability.max ? selectedValue : defaultValue !== undefined && defaultValue >= capability.min && defaultValue <= capability.max ? defaultValue : capability.min;
  }
}

function clearEffortMenuCloseTimer() {
  if (!effortMenuCloseTimer) return;
  clearTimeout(effortMenuCloseTimer);
  effortMenuCloseTimer = null;
}

function openEffortMenu() {
  clearEffortMenuCloseTimer();
  if (settings.activeModel) effortMenuOpen.value = true;
}

function closeEffortMenu() {
  clearEffortMenuCloseTimer();
  effortMenuOpen.value = false;
}

function scheduleEffortMenuClose() {
  clearEffortMenuCloseTimer();
  effortMenuCloseTimer = setTimeout(() => {
    effortMenuOpen.value = false;
    effortMenuCloseTimer = null;
  }, 120);
}

watch(effortMenuOpen, (open) => {
  const active = settings.activeModel;
  if (!open || !active) return;
  const config = settings.aiConfigs.find((item) => item.id === active.configId);
  if (config) void ensureModelEffort(config, active.modelId);
});

function selectEffort(selection: AiEffortSelection) {
  settings.updateActiveEffort(selection);
  syncEffortInputs();
}

function selectEffortOption(option: AiEffortOption) {
  selectEffort(option.selection);
}

function commitIntegerEffort(capability: Extract<AiEffortCapability, { kind: "integer" }>) {
  const steppedValue = capability.min + Math.round((effortIntegerValue.value - capability.min) / capability.step) * capability.step;
  const value = Math.min(capability.max, Math.max(capability.min, steppedValue));
  effortIntegerValue.value = value;
  selectEffort({ kind: "integer", value });
}

function commitTextEffort() {
  const value = effortTextValue.value.trim();
  settings.updateActiveEffort(value ? { kind: "text", value } : { kind: "providerDefault" });
}

function effortSelectionLabel(selection: AiEffortSelection | null): string {
  if (!selection || selection.kind === "providerDefault") return t("ai.providerDefault");
  const capability = activeEffortCapability.value;
  const options = capability?.kind === "enum" ? capability.options : capability?.kind === "integer" ? capability.specialValues : undefined;
  const matchingOption = options?.find((option) => effortSelectionEquals(selection, option.selection));
  if (matchingOption) return matchingOption.label;
  if (selection.kind === "disabled") return t("ai.effortDisabled");
  if (selection.kind === "boolean") return selection.value ? t("ai.effortEnabled") : t("ai.effortDisabled");
  return String(selection.value);
}

function retryActiveEffort() {
  const active = settings.activeModel;
  if (!active) return;
  const config = settings.aiConfigs.find((item) => item.id === active.configId);
  if (config) void ensureModelEffort(config, active.modelId, true);
}

/** Deferred context compaction info; applied after stream ends to avoid shifting assistantIdx. */
const pendingCompaction = ref<{ summary: string; compactedMessages: number } | null>(null);

const AI_TEXTAREA_MIN_HEIGHT_PX = 64;
const AI_TEXTAREA_MAX_PANEL_RATIO = 0.5;
const AI_TEXTAREA_HEIGHT_STORAGE_KEY = "dbx-ai-textarea-height";

const textareaHeight = ref<number>(AI_TEXTAREA_MIN_HEIGHT_PX);
const assistantRootRef = ref<HTMLElement | null>(null);
const promptPanelRef = ref<HTMLElement | null>(null);
const isResizing = ref<boolean>(false);
let resizeStartY = 0;
let resizeStartHeight = 0;
let promptPanelResizeObserver: ResizeObserver | undefined;

interface AiTableMentionCandidate {
  kind: "table";
  schema?: string;
  name: string;
  tableType: string;
}

interface AiSqlFileMentionCandidate {
  kind: "sqlFile";
  id: string;
  name: string;
  folderPath?: string;
}

type AiMentionCandidate = AiTableMentionCandidate | AiSqlFileMentionCandidate;

interface AiSqlFileMention {
  kind: "sqlFile";
  raw: string;
  id: string;
  name: string;
}

type AiPromptMentionChip = (AiTableMention & { kind: "table" }) | AiSqlFileMention;

const mentionOpen = ref(false);
const mentionLoading = ref(false);
const mentionError = ref("");
const mentionStart = ref(0);
const mentionSelectedIndex = ref(0);
const mentionCandidates = ref<AiMentionCandidate[]>([]);
const mentionCache = ref<Record<string, AiMentionCandidate[]>>({});
const mentionListRef = ref<HTMLElement | null>(null);
const selectedMentions = ref<AiTableMention[]>([]);
const selectedSqlFileMentions = ref<AiSqlFileMention[]>([]);
let mentionTimer: ReturnType<typeof setTimeout> | undefined;
let mentionRequestId = 0;

// Slash command menu
const commandOpen = ref(false);
const commandSelectedIndex = ref(0);
const commandStart = ref(0);

const filteredCommands = computed(() => {
  const query = prompt.value.slice(commandStart.value + 1).toLowerCase();
  return actionButtons.value.filter((cmd) => cmd.action.toLowerCase().includes(query) || t(cmd.key).toLowerCase().includes(query));
});

const AI_SQL_FILE_MENTION_CANDIDATE_LIMIT = 50;
const AI_SQL_FILE_CONTEXT_MAX_CHARS = 12_000;

interface AiActionButton {
  action: AiAction;
  icon: Component;
  /** i18n key for the menu label. */
  key: string;
}

/** Ask-mode actions: SQL-producing, never auto-run. */
const askActionButtons: AiActionButton[] = [
  { action: "general", icon: MessageSquarePlus, key: "ai.actions.general" },
  { action: "generate", icon: Wand2, key: "ai.actions.generate" },
  { action: "explain", icon: HelpCircle, key: "ai.actions.explain" },
  { action: "optimize", icon: Zap, key: "ai.actions.optimize" },
  { action: "fix", icon: Wrench, key: "ai.actions.fix" },
  { action: "convert", icon: ArrowRightLeft, key: "ai.actions.convert" },
  { action: "sampleData", icon: TestTube, key: "ai.actions.sampleData" },
];

/** Agent-mode actions: task-oriented, drive tool use and real results. */
const agentActionButtons: AiActionButton[] = [
  { action: "general", icon: MessageSquarePlus, key: "ai.actions.general" },
  { action: "query", icon: Search, key: "ai.actions.query" },
  { action: "exploreSchema", icon: Table2, key: "ai.actions.exploreSchema" },
  { action: "executeAndExplain", icon: Play, key: "ai.actions.executeAndExplain" },
  // `generate` is shared with Ask so users can still request SQL-only output without execution.
  { action: "generate", icon: Wand2, key: "ai.actions.generateNoExec" },
];

const actionButtons = computed<AiActionButton[]>(() => (assistantMode.value === "agent" ? agentActionButtons : askActionButtons));
const isRedisConnection = computed(() => props.connection?.db_type === "redis");

// Vector DBs hide the action menu and only expose collection tools.
// Keep their action at `generate` so the task contract doesn't tell the LLM to call execute_query.
function resolveDefaultAction(mode: AiAssistantMode): AiAction {
  if (props.connection && isVectorDbType(props.connection.db_type)) return "generate";
  return defaultActionForMode(mode);
}

// Switching mode is a deliberate context change: land on that mode's default action so the
// menu and behavior match the new intent. The shared `general` action is the default.
//
// `triggerAction` may set the action itself after programmatically switching mode (e.g. "Fix
// with AI" invoked from Agent mode); `suppressModeActionReset` tells this watch to skip the
// default reset so the menu keeps reflecting the action actually being run.
let suppressModeActionReset = false;
watch(assistantMode, (mode) => {
  if (suppressModeActionReset) {
    suppressModeActionReset = false;
    return;
  }
  activeAction.value = resolveDefaultAction(mode);
});

watch(
  () => props.connection?.db_type,
  () => {
    // Vector DBs hide the action picker, so keep the hidden action aligned with
    // the collection-oriented prompt contract on initial render and connection changes.
    if (props.connection && isVectorDbType(props.connection.db_type)) {
      activeAction.value = "generate";
    }
  },
  { immediate: true },
);

function selectAction(action: AiAction) {
  activeAction.value = action;
  if (action === "fix" && props.tab?.result) {
    if (isQueryExecutionErrorResult(props.tab.result)) {
      const errVal = props.tab.result.rows[0]?.[0];
      if (errVal != null) prompt.value = String(errVal);
    }
  }
}

/** Messages visible in the chat UI (excludes hidden context summaries). */
const visibleMessages = computed(() => messages.value.filter((m) => m.kind !== "contextSummary"));

function messagesForAgentHistory(historyMessages: ChatMessage[]): AiMessage[] {
  let latestSummaryIndex = -1;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    if (historyMessages[i].kind === "contextSummary") {
      latestSummaryIndex = i;
      break;
    }
  }
  if (latestSummaryIndex < 0) {
    return historyMessages.map((m) => ({ role: m.role, content: messageContentForModel(m) }));
  }
  const compactedHistory = historyMessages.slice(latestSummaryIndex);
  const firstMsg = historyMessages[0];
  if (firstMsg && firstMsg.role === "user" && firstMsg.kind !== "contextSummary") {
    return [{ role: "user" as const, content: messageContentForModel(firstMsg) }, ...compactedHistory.map((m) => ({ role: m.role, content: messageContentForModel(m) }))];
  }
  return compactedHistory.map((m) => ({ role: m.role, content: messageContentForModel(m) }));
}

const chatTitle = computed(() => {
  const first = messages.value.find((m) => m.role === "user" && m.kind !== "contextSummary");
  return first ? messageTitle(first).slice(0, 30) : t("ai.newChat");
});

const promptMentionChips = computed<AiPromptMentionChip[]>(() => [...selectedMentions.value.map((mention) => ({ ...mention, kind: "table" as const })), ...selectedSqlFileMentions.value]);

function messageMentionLabels(message: ChatMessage): string[] {
  return promptMentionChipsFromMessage(message).map((mention) => mention.raw);
}

function messageContentForModel(message: ChatMessage): string {
  if (message.kind === "contextSummary") return message.content;
  return [...messageMentionLabels(message), message.content].filter(Boolean).join(" ");
}

function messageTitle(message: ChatMessage): string {
  return [promptMentionChipsFromMessage(message).map(mentionDisplayName).join(" "), message.content].filter(Boolean).join(" ") || t("ai.newChat");
}

const isWaitingForFirstDelta = computed(() => {
  const last = messages.value[messages.value.length - 1];
  return isGenerating.value && last?.role === "assistant" && !last.content && !last.reasoning;
});

/**
 * The last assistant message whose final line looks like an action
 * proposal question. Used to render an inline "Yes / No" confirmation bar
 * so the user can answer without typing. `null` while the assistant is
 * still generating or when no such message exists.
 */
const proposalConfirmMessage = computed<ChatMessage | null>(() => {
  if (isGenerating.value) return null;
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const msg = messages.value[i];
    if (msg.kind === "contextSummary") continue;
    if (msg.role !== "assistant") return null;
    if (!msg.content) return null;
    return looksLikeActionProposal(msg.content) ? msg : null;
  }
  return null;
});

let allowWriteSqlForNextRun = false;
/** The specific write SQL embedded in the confirmed proposal, for binding to the agent run. */
let confirmedWriteSqlText: string | undefined = undefined;
/** Connection/database snapshot captured at confirmation time, verified at send time
 *  to prevent a database change between confirmation and execution. */
let confirmedConnectionId: string | undefined = undefined;
let confirmedDatabase: string | undefined = undefined;
let confirmedSchema: string | undefined = undefined;

/** Clear all pending write-confirmation state. Call on every early-return
 *  and failure path so a stale grant cannot leak into a subsequent send(). */
function clearPendingWriteGrant() {
  allowWriteSqlForNextRun = false;
  confirmedWriteSqlText = undefined;
  confirmedConnectionId = undefined;
  confirmedDatabase = undefined;
  confirmedSchema = undefined;
}

const productionContext = computed(() => {
  const target = props.connection && props.tab ? resolveAiDatabaseTarget(props.tab, props.connection) : undefined;
  return productionContextForDatabase(props.connection, target?.database);
});

function sendProposalReply(positive: boolean) {
  // Disable while a stream is in flight or no proposal is currently active.
  if (isGenerating.value) return;
  const target = proposalConfirmMessage.value;
  if (!target) return;
  if (positive && productionContext.value.active && looksLikeWriteSqlProposal(target.content)) {
    const sql = extractFirstSqlCodeBlock(target.content);
    if (sql) emit("replaceSql", sql);
    toast(t("production.aiReviewRequired"), 5000);
    return;
  }
  const isZh = containsChinese(target.content || "");
  const replyZh = positive ? "请执行上面你刚提议的操作，不要再反问确认。" : "不用执行上面提到的操作，继续当前对话。";
  const replyEn = positive ? "Execute the action you just proposed above; do not ask for confirmation again." : "Do not execute the action mentioned above; continue the current conversation.";
  prompt.value = isZh ? replyZh : replyEn;
  if (positive && assistantMode.value === "agent" && looksLikeWriteSqlProposal(target.content)) {
    confirmedWriteSqlText = extractSingleSqlCodeBlock(target.content);
    if (confirmedWriteSqlText) {
      allowWriteSqlForNextRun = true;
      confirmedConnectionId = props.connection?.id;
      if (props.tab && props.connection) {
        const target = resolveAiDatabaseTarget(props.tab, props.connection);
        confirmedDatabase = target.database;
        confirmedSchema = target.schema;
      }
    }
    // When no SQL code block is found in the proposal, treat the
    // confirmation as rejected — we cannot bind the agent to a
    // specific SQL statement, so we must not grant blanket write access.
  }
  // Use the existing send pipeline so the message is added to history, persisted, etc.
  send();
}

const activePlaceholder = computed(() => `${t(`ai.placeholders.${activeAction.value}`)} ${t("ai.tableMentionPlaceholderHint")}`);
const aiCodeAppearance = computed(() => (isDark.value ? "dark" : "light"));

const showActionButtons = computed(() => {
  if (!props.connection) return true;
  return !isVectorDbType(props.connection.db_type);
});

const modeIcon = computed<Component>(() => (assistantMode.value === "agent" ? Bot : MessageSquarePlus));
const modeLabel = computed(() => t(`ai.modes.${assistantMode.value}`));
const selectedActionButton = computed<AiActionButton | undefined>(() => actionButtons.value.find((b) => b.action === activeAction.value));
const modeActionTriggerLabel = computed(() => {
  const modePart = `${modeLabel.value}`;
  if (!showActionButtons.value || !selectedActionButton.value) return modePart;
  return `${modePart} · ${t(selectedActionButton.value.key)}`;
});

function switchModeActionTab(mode: "ask" | "agent") {
  activeAction.value = resolveDefaultAction(mode);
  if (assistantMode.value !== mode) {
    // Set the mode after the action so the tab label and picker stay aligned.
    assistantMode.value = mode;
  }
}

function selectModeActionItem(action: AiAction) {
  // Vector databases only support generation; keep this constraint at the selection boundary.
  if (!showActionButtons.value) return;
  selectAction(action);
  modeActionOpen.value = false;
}

const { databaseOptions, loadDatabaseOptions } = useDatabaseOptions();

// Dameng presents schemas as its top-level namespace, unlike the other
// connection types that rely on the shared database-options loader.
const aiDatabaseOptions = ref<Record<string, string[]>>({});

const dbOptions = computed(() => {
  const connection = props.connection;
  if (!connection) return [];
  if (connection.db_type === "dameng") return aiDatabaseOptions.value[connection.id] || [];
  return databaseOptions.value[connection.id] || [];
});

const dbSelectOptions = computed(() => {
  const connection = props.connection;
  if (!connection) return [];
  return dbOptions.value.map((database) => ({
    database,
    value: encodeSelectableDatabaseValue(connection.db_type, database),
    label: formatDatabaseLabel(connection, database, {
      defaultDatabase: t("editor.defaultDatabase"),
      noDatabase: t("editor.noDatabase"),
    }),
  }));
});

const selectedNamespace = computed(() => (props.connection && props.tab ? resolveAiNamespaceSelection(props.tab, props.connection).value : ""));

const selectedDatabaseSelectValue = computed(() => (props.connection ? encodeSelectableDatabaseValue(props.connection.db_type, selectedNamespace.value) : ""));

const selectedDatabaseLabel = computed(() => {
  if (!props.connection) return t("editor.selectDatabase");
  if (!props.tab) return t("editor.selectDatabase");
  return formatDatabaseLabel(props.connection, selectedNamespace.value, {
    defaultDatabase: t("editor.defaultDatabase"),
    noDatabase: t("editor.noDatabase"),
  });
});

async function loadDatabases(connection = props.connection): Promise<string[]> {
  if (!connection) return [];
  if (connection.db_type !== "dameng") {
    await loadDatabaseOptions(connection.id);
    return databaseOptions.value[connection.id] || [];
  }
  await connectionStore.ensureConnected(connection.id);
  const options = await fetchNamespaceOptionsForConnection(connection.id, connection);
  aiDatabaseOptions.value[connection.id] = options;
  return options;
}

async function changeConnection(connectionId: string) {
  const conn = connectionStore.getConfig(connectionId);
  if (!conn) return;
  connectionStore.activeConnectionId = connectionId;
  const tab = props.tab;
  const tabId = tab ? tab.id : queryStore.createTab(connectionId, resolveDefaultDatabase(conn, []));
  if (tab) {
    queryStore.updateConnection(tab.id, connectionId, resolveDefaultDatabase(conn, []));
  }
  try {
    const options = await loadDatabases(conn);
    if (conn.db_type === "dameng") {
      queryStore.updateSchema(tabId, resolveDefaultAiSchema(conn, options));
    } else {
      queryStore.updateDatabase(tabId, resolveDefaultDatabase(conn, options));
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    toast(t("connection.connectFailed", { message: translateBackendError(t, message) }), 5000);
  }
}

function changeNamespace(value: string) {
  const tab = props.tab;
  const connection = props.connection;
  if (!tab || !connection) return;
  const namespace = decodeSelectableDatabaseValue(connection.db_type, value);
  if (resolveAiNamespaceSelection(tab, connection).kind === "schema") {
    queryStore.updateSchema(tab.id, namespace || undefined);
  } else {
    queryStore.updateDatabase(tab.id, namespace);
  }
}

function flushAssistantDeltas() {
  assistantDeltaFrame = null;
  lastAssistantFlushAt = performance.now();
  const msg = messages.value[pendingAssistantIndex];
  if (!msg) return;
  if (pendingAssistantReasoning) {
    msg.reasoning = (msg.reasoning || "") + pendingAssistantReasoning;
    msg.isThinking = true;
  }
  if (pendingAssistantDelta) {
    msg.isThinking = false;
    msg.content += pendingAssistantDelta;
  }
  pendingAssistantDelta = "";
  pendingAssistantReasoning = "";
  scrollToBottom();
}

function runAssistantDeltaFrame() {
  // Markdown is rendered live, so keep the refresh rate under the frame rate:
  // a repaint every STREAM_RENDER_INTERVAL_MS still reads as continuous typing.
  if (performance.now() - lastAssistantFlushAt < STREAM_RENDER_INTERVAL_MS) {
    assistantDeltaFrame = requestAnimationFrame(runAssistantDeltaFrame);
    return;
  }
  flushAssistantDeltas();
}

function scheduleAssistantDeltaFlush(assistantIdx: number) {
  pendingAssistantIndex = assistantIdx;
  if (assistantDeltaFrame !== null) return;
  // Providers can emit many tiny chunks. Batch them on an animation frame so
  // Markdown parsing, highlighting, and layout do not run for every token.
  assistantDeltaFrame = requestAnimationFrame(runAssistantDeltaFrame);
}

function appendAssistantDelta(assistantIdx: number, delta: string) {
  const msg = messages.value[assistantIdx];
  if (msg.isThinking) msg.isThinking = false;
  pendingAssistantDelta += delta;
  scheduleAssistantDeltaFlush(assistantIdx);
}

function appendAssistantReasoning(assistantIdx: number, delta: string) {
  pendingAssistantReasoning += delta;
  scheduleAssistantDeltaFlush(assistantIdx);
}

const reasoningExpanded = ref(false);
const expandedSteps = ref<Set<string>>(new Set());

function toggleStep(key: string) {
  const next = new Set(expandedSteps.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedSteps.value = next;
}

function agentStepIcon(tone: AiAgentStepTone) {
  if (tone === "danger") return CircleSlash;
  if (tone === "warning") return AlertTriangle;
  if (tone === "active") return Play;
  return ShieldCheck;
}

function agentStepClass(tone: AiAgentStepTone): string {
  const base = "transition-colors duration-200 ease-out motion-safe:transition-colors motion-reduce:transition-none";
  switch (tone) {
    case "success":
      return `border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ${base}`;
    case "active":
      return `border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 ${base}`;
    case "warning":
      return `border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300 ${base}`;
    case "danger":
      return `border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300 ${base}`;
    default:
      return `border-border bg-background/60 text-muted-foreground ${base}`;
  }
}

/** Extract tool result content from the AgentEvent result value */
function extractToolResultContent(result: unknown): string | undefined {
  if (!result) return undefined;
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(extractToolResultContent).filter(Boolean).join("\n");
  if (typeof result === "object" && result !== null && "content" in result) {
    const content = (result as Record<string, unknown>).content;
    if (Array.isArray(content)) return content.map(extractToolResultContent).filter(Boolean).join("\n");
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  if (typeof result === "object" && result !== null && "text" in result) {
    const text = (result as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  if (typeof result === "object" && result !== null && "message" in result) {
    const message = (result as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(result);
}

/** Extract structured explain plan data from the AgentEvent result value */
function extractExplainData(result: unknown): unknown | undefined {
  if (!result || typeof result !== "object") return undefined;
  const obj = result as Record<string, unknown>;
  return obj.explain_data;
}

/** Parse explain_data (a serialized QueryResult) into ParsedExplainPlan */
function parseExplainFromData(explainData: unknown, dbType: string): ParsedExplainPlan | undefined {
  if (dbType === "oracle" && typeof explainData === "string") {
    return parseOracleExplainText(explainData);
  }
  if (!explainData || typeof explainData !== "object") return undefined;
  const supportedTypes = ["mysql", "postgres", "dameng", "questdb"] as const;
  if (!supportedTypes.includes(dbType as (typeof supportedTypes)[number])) return undefined;
  try {
    return parseExplainResult(dbType as (typeof supportedTypes)[number], explainData as import("@/types/database").QueryResult);
  } catch {
    return undefined;
  }
}

function agentEventToStep(event: AgentEvent, index: number): AiAgentStepItem | undefined {
  if (event.type === "context_compacted") {
    return {
      key: `compact-${index}`,
      labelKey: "ai.agentSteps.contextCompacted",
      tone: "active",
      toolResult: `Compacted ${event.compacted_messages} messages. Estimated prompt tokens: ${event.estimated_before.toLocaleString()} -> ${event.estimated_after.toLocaleString()}. Summary: ${event.summary_tokens.toLocaleString()} tokens.`,
      isError: false,
    };
  }

  if (event.type !== "tool_call_start" && event.type !== "tool_call_end") return undefined;

  // Use a stable key based on tool_call_id so start and end events map to the same card.
  const toolKey = toolCallStepKey(event.tool_call_id, index, event.type);

  if (event.type === "tool_call_start") {
    return {
      key: toolKey,
      labelKey: "ai.agentSteps.callingTool",
      tone: "active",
      toolName: event.tool_name,
      toolArgs: event.args as Record<string, unknown>,
    };
  }

  // tool_call_end: produce a final step; toolArgs will be merged from the start step by upsert if missing.
  const isExecuteQuery = event.tool_name === "execute_query" || event.tool_name === "dbx_execute_query";
  const labelKey = isExecuteQuery ? (event.is_error ? "ai.agentSteps.executeBlocked" : "ai.agentSteps.executeSafe") : event.is_error ? "ai.agentSteps.toolError" : "ai.agentSteps.toolDone";
  const tone: AiAgentStepTone = event.is_error ? "danger" : "success";

  return {
    key: toolKey,
    labelKey,
    tone,
    toolName: event.tool_name,
    toolResult: extractToolResultContent(event.result),
    explainData: extractExplainData(event.result),
    isError: event.is_error,
  };
}

function toggleReasoning() {
  reasoningExpanded.value = !reasoningExpanded.value;
}

function getMessageScrollViewport(): HTMLElement | null {
  const root = scrollRef.value?.$el as HTMLElement | undefined;
  return root?.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
}

function messageBottomDistance(el: HTMLElement) {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

function isAtMessageBottom(el: HTMLElement) {
  return messageBottomDistance(el) <= MESSAGE_SCROLL_RESUME_THRESHOLD_PX;
}

function messageCanScroll(el: HTMLElement) {
  return el.scrollHeight > el.clientHeight + MESSAGE_SCROLL_RESUME_THRESHOLD_PX;
}

function shouldShowMessageScrollButton(el: HTMLElement) {
  if (!messageCanScroll(el)) return false;
  const distance = messageBottomDistance(el);
  return distance > (showScrollToBottom.value ? MESSAGE_SCROLL_BUTTON_HIDE_THRESHOLD_PX : MESSAGE_SCROLL_BUTTON_SHOW_THRESHOLD_PX);
}

function updateMessageScrollButtonVisibility() {
  const el = getMessageScrollViewport();
  showScrollToBottom.value = !!el && shouldShowMessageScrollButton(el);
}

function pauseMessageAutoScroll() {
  userPausedAutoScroll.value = true;
  shouldAutoScroll.value = false;
  updateMessageScrollButtonVisibility();
}

function updateMessageScrollState() {
  const el = getMessageScrollViewport();
  if (!el) {
    showScrollToBottom.value = false;
    return;
  }
  if (isAtMessageBottom(el)) {
    userPausedAutoScroll.value = false;
    shouldAutoScroll.value = true;
    showScrollToBottom.value = false;
    return;
  }
  if (userPausedAutoScroll.value) {
    shouldAutoScroll.value = false;
    showScrollToBottom.value = shouldShowMessageScrollButton(el);
    return;
  }
  shouldAutoScroll.value = false;
  showScrollToBottom.value = shouldShowMessageScrollButton(el);
}

function handleMessageScroll() {
  const el = getMessageScrollViewport();
  if (!el) return;
  if (el.scrollTop < lastMessageScrollTop - 2) {
    userPausedAutoScroll.value = true;
  }
  lastMessageScrollTop = el.scrollTop;
  updateMessageScrollState();
}

function handleMessageWheel(event: WheelEvent) {
  if (event.deltaY < 0) pauseMessageAutoScroll();
}

function handleMessageTouchStart(event: TouchEvent) {
  messageTouchStartY = event.touches[0]?.clientY ?? null;
}

function handleMessageTouchMove(event: TouchEvent) {
  if (messageTouchStartY == null) return;
  const currentY = event.touches[0]?.clientY ?? messageTouchStartY;
  if (currentY - messageTouchStartY > 4) pauseMessageAutoScroll();
}

function handleMessageKeydown(event: KeyboardEvent) {
  if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pauseMessageAutoScroll();
}

function detachMessageScrollListener() {
  if (!messageScrollViewport) return;
  messageScrollViewport.removeEventListener("scroll", handleMessageScroll);
  messageScrollViewport.removeEventListener("wheel", handleMessageWheel);
  messageScrollViewport.removeEventListener("touchstart", handleMessageTouchStart);
  messageScrollViewport.removeEventListener("touchmove", handleMessageTouchMove);
  messageScrollViewport.removeEventListener("keydown", handleMessageKeydown);
  messageScrollViewport = null;
}

function attachMessageScrollListener() {
  nextTick(() => {
    const el = getMessageScrollViewport();
    if (el === messageScrollViewport) return;
    detachMessageScrollListener();
    messageScrollViewport = el;
    if (!el) return;
    el.addEventListener("scroll", handleMessageScroll, { passive: true });
    el.addEventListener("wheel", handleMessageWheel, { passive: true });
    el.addEventListener("touchstart", handleMessageTouchStart, { passive: true });
    el.addEventListener("touchmove", handleMessageTouchMove, { passive: true });
    el.addEventListener("keydown", handleMessageKeydown);
    lastMessageScrollTop = el.scrollTop;
    updateMessageScrollState();
  });
}

function scrollToBottom(options: { force?: boolean } = {}) {
  if (options.force) {
    userPausedAutoScroll.value = false;
    shouldAutoScroll.value = true;
  }
  if (!options.force && (userPausedAutoScroll.value || !shouldAutoScroll.value)) {
    updateMessageScrollButtonVisibility();
    return;
  }
  nextTick(() => {
    const el = getMessageScrollViewport();
    if (!el) return;
    requestAnimationFrame(() => {
      if (!options.force && (userPausedAutoScroll.value || !shouldAutoScroll.value)) {
        updateMessageScrollButtonVisibility();
        return;
      }
      el.scrollTop = el.scrollHeight;
      lastMessageScrollTop = el.scrollTop;
      userPausedAutoScroll.value = false;
      shouldAutoScroll.value = true;
      showScrollToBottom.value = false;
    });
  });
}

watch(
  () => messages.value.length,
  (length) => {
    if (length) {
      attachMessageScrollListener();
      return;
    }
    detachMessageScrollListener();
    userPausedAutoScroll.value = false;
    shouldAutoScroll.value = true;
    showScrollToBottom.value = false;
  },
  { flush: "post" },
);

function mentionCacheKey(connectionId: string, database: string, query: string) {
  return `${connectionId}:${database}:${savedSqlStore.version}:${query.toLowerCase()}`;
}

function mentionSchemaOrder(schemas: string[]): string[] {
  const currentSchema = props.tab?.tableMeta?.schema;
  const preferred = [currentSchema, "public", "dbo", "main"].filter((value): value is string => !!value);
  return [...schemas].sort((a, b) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 99) - (bi >= 0 ? bi : 99);
    return a.localeCompare(b);
  });
}

function activeMentionAtCursor(): { start: number; query: string } | null {
  const textarea = promptTextareaRef.value;
  const cursor = textarea?.selectionStart ?? prompt.value.length;
  const beforeCursor = prompt.value.slice(0, cursor);
  const match = /(^|[\s([{,;:])@([^\s]*)$/.exec(beforeCursor);
  if (!match) return null;
  return { start: beforeCursor.length - match[2].length - 1, query: match[2] };
}

function normalizeMentionQuery(query: string): { schemaPrefix: string; tableFilter: string } {
  const clean = query.replace(/^["`]+|["`]+$/g, "");
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return { schemaPrefix: "", tableFilter: clean };
  return {
    schemaPrefix: clean.slice(0, dot).replace(/^["`]+|["`]+$/g, ""),
    tableFilter: clean.slice(dot + 1).replace(/^["`]+|["`]+$/g, ""),
  };
}

async function loadMentionCandidates(query: string) {
  if (!props.connection || !props.tab?.connectionId || !props.tab.database) return;

  const key = mentionCacheKey(props.tab.connectionId, props.tab.database, query);
  if (mentionCache.value[key]) {
    mentionCandidates.value = mentionCache.value[key];
    return;
  }

  const requestId = ++mentionRequestId;
  mentionLoading.value = true;
  mentionError.value = "";
  const { schemaPrefix, tableFilter } = normalizeMentionQuery(query);
  let sqlFileCandidates: AiSqlFileMentionCandidate[] = [];

  try {
    sqlFileCandidates = await loadSqlFileMentionCandidates(query);
    await connectionStore.ensureConnected(props.tab.connectionId);
    let tableCandidates: AiMentionCandidate[] = [];
    if (isSchemaAware(props.connection.db_type)) {
      const schemas = mentionSchemaOrder(await listSchemas(props.tab.connectionId, props.tab.database));
      const filteredSchemas = schemaPrefix ? schemas.filter((schema) => schema.toLowerCase().includes(schemaPrefix.toLowerCase())) : schemas;
      const results = await Promise.all(
        filteredSchemas.slice(0, AI_TABLE_MENTION_SCHEMA_LIMIT).map(async (schema) => {
          const tables = await listTables(props.tab!.connectionId, props.tab!.database, schema, tableFilter || undefined, AI_TABLE_MENTION_CANDIDATE_LIMIT);
          return filterAiTableMentionCandidates(
            tables.map((table) => mentionCandidateFromTable(table, schema)),
            tableFilter,
            AI_TABLE_MENTION_CANDIDATE_LIMIT,
          );
        }),
      );
      tableCandidates = filterAiTableMentionCandidates(results.flat(), "", AI_TABLE_MENTION_CANDIDATE_LIMIT);
    } else {
      const database = props.connection.db_type === "sqlite" ? normalizeSqliteNamespace(props.tab.database || props.connection.database, props.connection) : props.tab.database;
      const schema = database || props.connection.database || "main";
      const tables = await listTables(props.tab.connectionId, database, schema, tableFilter || undefined, AI_TABLE_MENTION_CANDIDATE_LIMIT);
      tableCandidates = filterAiTableMentionCandidates(
        tables.map((table) => mentionCandidateFromTable(table)),
        tableFilter,
        AI_TABLE_MENTION_CANDIDATE_LIMIT,
      );
    }

    if (requestId !== mentionRequestId) return;
    mentionCache.value[key] = [...tableCandidates, ...sqlFileCandidates];
    mentionCandidates.value = mentionCache.value[key];
    setMentionSelectedIndex(0);
  } catch (e: unknown) {
    if (requestId !== mentionRequestId) return;
    if (sqlFileCandidates.length) {
      mentionCache.value[key] = sqlFileCandidates;
      mentionCandidates.value = sqlFileCandidates;
      mentionError.value = "";
      setMentionSelectedIndex(0);
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    mentionError.value = translateBackendError(t, message);
    mentionCandidates.value = [];
  } finally {
    if (requestId === mentionRequestId) mentionLoading.value = false;
  }
}

async function loadSqlFileMentionCandidates(query: string): Promise<AiSqlFileMentionCandidate[]> {
  const connectionId = props.tab?.connectionId;
  if (!connectionId) return [];
  await savedSqlStore.initFromStorage();
  const normalizedQuery = normalizeSqlFileMentionQuery(query);
  return savedSqlStore.allFiles
    .filter((file) => file.connectionId === connectionId)
    .map((file) => ({ file, folderPath: savedSqlFolderPath(file) }))
    .filter(({ file, folderPath }) => sqlFileMatchesQuery(file, folderPath, normalizedQuery))
    .slice(0, AI_SQL_FILE_MENTION_CANDIDATE_LIMIT)
    .map(({ file, folderPath }) => ({
      kind: "sqlFile",
      id: file.id,
      name: file.name,
      folderPath,
    }));
}

function normalizeSqlFileMentionQuery(query: string) {
  return query.replace(/^["`{]+|["`}]+$/g, "").toLowerCase();
}

function sqlFileMatchesQuery(file: SavedSqlFile, folderPath: string | undefined, query: string) {
  if (!query) return true;
  return [file.name, folderPath || ""].some((value) => value.toLowerCase().includes(query));
}

function savedSqlFolderPath(file: SavedSqlFile): string | undefined {
  if (!file.folderId) return undefined;
  const foldersById = new Map(savedSqlStore.allFolders.map((folder) => [folder.id, folder]));
  const names: string[] = [];
  let current = foldersById.get(file.folderId);
  while (current) {
    names.unshift(current.name);
    current = current.parentFolderId ? foldersById.get(current.parentFolderId) : undefined;
  }
  return names.length ? names.join(" / ") : undefined;
}

function mentionCandidateFromTable(table: TableInfo, schema?: string): AiTableMentionCandidate {
  return { kind: "table", schema, name: table.name, tableType: table.table_type };
}

function mentionCandidateName(candidate: AiMentionCandidate) {
  if (candidate.kind === "sqlFile") return candidate.name;
  return [candidate.schema, candidate.name].filter(Boolean).join(".");
}

function mentionDisplayName(mention: AiPromptMentionChip) {
  if (mention.kind === "sqlFile") return mention.name;
  return [mention.schema, mention.table].filter(Boolean).join(".");
}

function promptMentionChipsFromMessage(message: ChatMessage): AiPromptMentionChip[] {
  return (message.mentions || []).map((mention) => {
    if (mention.kind === "sqlFile") return { kind: "sqlFile", raw: mention.raw, id: mention.id, name: mention.name };
    return { kind: "table", raw: mention.raw, schema: mention.schema, table: mention.table };
  });
}

function removeMentionChip(mention: AiPromptMentionChip) {
  if (mention.kind === "sqlFile") {
    selectedSqlFileMentions.value = selectedSqlFileMentions.value.filter((item) => item.id !== mention.id);
  } else {
    selectedMentions.value = selectedMentions.value.filter((item) => item.raw !== mention.raw);
  }
  nextTick(() => promptTextareaRef.value?.focus());
}

function removeEditingMentionChip(index: number) {
  editingMentions.value = editingMentions.value.filter((_, itemIndex) => itemIndex !== index);
  nextTick(() => {
    const el = document.querySelector<HTMLTextAreaElement>("[data-edit-textarea]");
    el?.focus();
  });
}

function addSelectedMention(candidate: AiMentionCandidate) {
  if (candidate.kind === "sqlFile") {
    const raw = `@{${candidate.name}}`;
    if (selectedSqlFileMentions.value.some((mention) => mention.id === candidate.id)) return;
    selectedSqlFileMentions.value.push({ kind: "sqlFile", raw, id: candidate.id, name: candidate.name });
    return;
  }
  const raw = formatAiTableMention(candidate.schema, candidate.name);
  const key = `${candidate.schema || ""}.${candidate.name}`.toLowerCase();
  if (selectedMentions.value.some((mention) => `${mention.schema || ""}.${mention.table}`.toLowerCase() === key)) return;
  selectedMentions.value.push({ raw, schema: candidate.schema, table: candidate.name });
}

function formatMentionCandidateType(candidate: AiMentionCandidate) {
  if (candidate.kind === "sqlFile") return candidate.folderPath || "SQL";
  return formatMentionTableType(candidate.tableType);
}

function selectedMessageMentions(tableMentions: AiTableMention[], sqlFileMentions: AiSqlFileMention[]): AiMessageMention[] {
  const connectionId = props.tab?.connectionId || props.connection?.id || "";
  const database = props.tab?.database || props.connection?.database || "";
  return [
    ...tableMentions.map((mention) => ({
      kind: "table" as const,
      raw: mention.raw,
      connectionId,
      database,
      schema: mention.schema,
      table: mention.table,
    })),
    ...sqlFileMentions.map((mention) => ({
      kind: "sqlFile" as const,
      raw: mention.raw,
      connectionId,
      id: mention.id,
      name: mention.name,
    })),
  ];
}

async function openMessageMention(mention: AiMessageMention) {
  try {
    if (mention.kind === "sqlFile") {
      const file = await savedSqlStore.ensureFileContent(mention.id);
      if (file) {
        const tabId = queryStore.openSavedSql(file);
        connectionStore.activeConnectionId = queryStore.tabs.find((tab) => tab.id === tabId)?.connectionId ?? file.connectionId;
      }
      return;
    }
    await openTableTarget({
      connectionId: mention.connectionId || props.tab?.connectionId || props.connection?.id || "",
      database: mention.database || props.tab?.database || props.connection?.database || "",
      schema: mention.schema,
      tableName: mention.table,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    toast(translateBackendError(t, message), 5000);
  }
}

function formatMentionTableType(tableType: string) {
  const normalized = tableType.toUpperCase().replace(/\s+/g, "_");
  if (normalized.includes("VIEW")) return t("ai.tableMentionTypes.view");
  if (normalized.includes("SYSTEM")) return t("ai.tableMentionTypes.systemTable");
  if (normalized.includes("TEMP")) return t("ai.tableMentionTypes.temporaryTable");
  return t("ai.tableMentionTypes.table");
}

function setMentionSelectedIndex(index: number, keepVisible = true) {
  mentionSelectedIndex.value = Math.max(0, Math.min(index, Math.max(mentionCandidates.value.length - 1, 0)));
  if (keepVisible) scrollMentionSelectedIntoView();
}

function scrollMentionSelectedIntoView() {
  nextTick(() => {
    const list = mentionListRef.value;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(`[data-mention-index="${mentionSelectedIndex.value}"]`);
    if (!item) return;

    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const itemTop = itemRect.top - listRect.top + list.scrollTop;
    const itemBottom = itemTop + itemRect.height;
    const visibleTop = list.scrollTop;
    const visibleBottom = visibleTop + list.clientHeight;

    if (itemTop < visibleTop) {
      list.scrollTop = itemTop;
    } else if (itemBottom > visibleBottom) {
      list.scrollTop = itemBottom - list.clientHeight;
    }
  });
}

function refreshMentionState() {
  clearTimeout(mentionTimer);

  // 优先检测斜杠命令（仅在输入内容为空时触发）
  const textarea = promptTextareaRef.value;
  const cursor = textarea?.selectionStart ?? prompt.value.length;
  const beforeCursor = prompt.value.slice(0, cursor);
  const slashMatch = /^\/([^\s]*)$/.exec(beforeCursor.trimStart());

  if (slashMatch) {
    mentionOpen.value = false;
    commandOpen.value = true;
    commandStart.value = beforeCursor.length - slashMatch[1].length - 1;
    commandSelectedIndex.value = 0;
    return;
  }

  commandOpen.value = false;

  const mention = activeMentionAtCursor();
  if (!mention || !props.connection || !props.tab?.database) {
    mentionOpen.value = false;
    return;
  }

  mentionOpen.value = true;
  mentionStart.value = mention.start;
  mentionTimer = setTimeout(() => {
    loadMentionCandidates(mention.query).catch(() => {});
  }, 120);
}

function onPromptKeyup(event: KeyboardEvent) {
  if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return;
  refreshMentionState();
}

function selectCommand(command: AiActionButton) {
  const before = prompt.value.slice(0, commandStart.value);
  const after = prompt.value.slice(promptTextareaRef.value?.selectionStart ?? prompt.value.length);
  prompt.value = `${before}${after}`.replace(/\s{2,}/g, " ").trim();
  commandOpen.value = false;
  activeAction.value = command.action;
  nextTick(() => {
    const textarea = promptTextareaRef.value;
    if (textarea) {
      textarea.selectionStart = textarea.selectionEnd = before.length;
      textarea.focus();
    }
  });
}

function insertMention(candidate: AiMentionCandidate) {
  const textarea = promptTextareaRef.value;
  const cursor = textarea?.selectionStart ?? prompt.value.length;
  const before = prompt.value.slice(0, mentionStart.value);
  const after = prompt.value.slice(cursor);
  addSelectedMention(candidate);
  prompt.value = `${before}${after}`.replace(/\s{2,}/g, " ");
  mentionOpen.value = false;
  nextTick(() => {
    const nextCursor = before.length;
    promptTextareaRef.value?.focus();
    promptTextareaRef.value?.setSelectionRange(nextCursor, nextCursor);
  });
}

function onPromptKeydown(event: KeyboardEvent) {
  if (isAiPromptImeCompositionEvent(event, promptCompositionActive.value)) return;

  // 斜杠命令菜单键盘导航
  if (commandOpen.value) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      commandSelectedIndex.value = Math.min(commandSelectedIndex.value + 1, filteredCommands.value.length - 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      commandSelectedIndex.value = Math.max(commandSelectedIndex.value - 1, 0);
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && filteredCommands.value[commandSelectedIndex.value]) {
      event.preventDefault();
      selectCommand(filteredCommands.value[commandSelectedIndex.value]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      commandOpen.value = false;
      return;
    }
  }

  if (mentionOpen.value) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionSelectedIndex(mentionSelectedIndex.value + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionSelectedIndex(mentionSelectedIndex.value - 1);
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && mentionCandidates.value[mentionSelectedIndex.value]) {
      event.preventDefault();
      insertMention(mentionCandidates.value[mentionSelectedIndex.value]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      mentionOpen.value = false;
      return;
    }
  }

  // Prompt history navigation (↑/↓ when not in @mention dropdown)
  if (event.key === "ArrowUp" && promptHistory.value.length > 0) {
    const textarea = promptTextareaRef.value;
    // Only enter history when cursor is on the first line
    if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
      event.preventDefault();
      if (historyIndex.value === -1) {
        draftBeforeHistory.value = prompt.value;
      }
      const nextIndex = historyIndex.value + 1;
      if (nextIndex < promptHistory.value.length) {
        historyIndex.value = nextIndex;
        prompt.value = promptHistory.value[nextIndex];
        nextTick(() => {
          textarea.selectionStart = textarea.selectionEnd = prompt.value.length;
        });
      }
      return;
    }
  }
  if (event.key === "ArrowDown" && historyIndex.value >= 0) {
    event.preventDefault();
    const nextIndex = historyIndex.value - 1;
    if (nextIndex >= 0) {
      historyIndex.value = nextIndex;
      prompt.value = promptHistory.value[nextIndex];
    } else {
      historyIndex.value = -1;
      prompt.value = draftBeforeHistory.value;
    }
    nextTick(() => {
      const textarea = promptTextareaRef.value;
      if (textarea) textarea.selectionStart = textarea.selectionEnd = prompt.value.length;
    });
    return;
  }

  if (shouldSubmitAiPromptOnKeydown(event, promptCompositionActive.value)) {
    event.preventDefault();
    send();
  }
}

async function loadReferencedSqlFiles(mentions: AiSqlFileMention[]): Promise<AiSqlFileContext[]> {
  if (!mentions.length) return [];
  const results: AiSqlFileContext[] = [];
  for (const mention of mentions) {
    const file = await savedSqlStore.ensureFileContent(mention.id).catch(() => undefined);
    if (!file) continue;
    const sql = file.sql || "";
    const truncated = sql.length > AI_SQL_FILE_CONTEXT_MAX_CHARS;
    results.push({
      id: file.id,
      name: file.name,
      sql: truncated ? `${sql.slice(0, AI_SQL_FILE_CONTEXT_MAX_CHARS)}\n-- ... truncated ...` : sql,
      truncated,
    });
  }
  return results;
}

async function send() {
  const text = prompt.value.trim();
  if ((!text && !selectedMentions.value.length && !selectedSqlFileMentions.value.length) || isGenerating.value) return;

  // Snapshot the target connection/database before any async work so that
  // suspension points during context loading cannot cause a TOCTOU target switch.
  const connection = props.connection;
  const tab = props.tab;
  if (!connection || !tab) {
    clearPendingWriteGrant();
    return;
  }
  const activeConfig = activeFullConfig.value;
  if (!activeConfig) {
    clearPendingWriteGrant();
    toast(t("ai.noConfig"));
    return;
  }
  // Acquire the send guard before the first async operation so two rapid
  // submissions cannot both pass the initial isGenerating check and then
  // resume into concurrent agent runs.
  isGenerating.value = true;
  if (!(await promptTemplateStore.ensureLoaded())) {
    clearPendingWriteGrant();
    isGenerating.value = false;
    toast(t("ai.customInstructionsLoadFailed"), 5000);
    return;
  }
  // Snapshot the selected custom prompts at send time so later async context loading
  // cannot change the instructions for an already-submitted request.
  const customPromptContext: CustomPromptContext = {
    globalInstructions: promptTemplateStore.globalInstructions,
    activeTemplates: [...activeTemplates.value],
  };

  const selectedTableMentions = [...selectedMentions.value];
  const selectedSqlFiles = [...selectedSqlFileMentions.value];
  const mentionedTables = [...selectedTableMentions, ...parseAiTableMentions(text)];
  const modelInstruction = [selectedTableMentions.map((mention) => mention.raw).join(" "), selectedSqlFiles.map((mention) => mention.raw).join(" "), text].filter(Boolean).join(" ");

  messages.value.push({ role: "user", content: text, mentions: selectedMessageMentions(selectedTableMentions, selectedSqlFiles) });
  // Save to prompt history (deduplicate consecutive duplicates)
  if (text && promptHistory.value[0] !== text) {
    promptHistory.value.unshift(text);
    if (promptHistory.value.length > 100) promptHistory.value.length = 100;
  }
  historyIndex.value = -1;
  draftBeforeHistory.value = "";
  prompt.value = "";
  selectedMentions.value = [];
  selectedSqlFileMentions.value = [];
  scrollToBottom({ force: true });

  const requestedAction = activeAction.value;
  const requestedMode = assistantMode.value;
  // Detect user-typed short confirmation (e.g. "可以"/"go ahead") as an alternative
  // path to the proposal ✅ button. Delegates to the shared pure function so the
  // component and its unit tests share the same gating logic.
  if (!allowWriteSqlForNextRun) {
    allowWriteSqlForNextRun = shouldGrantWriteSqlOnShortAffirmative({
      mode: requestedMode,
      alreadyGranted: false,
      isProduction: productionContext.value.active,
      userText: text,
      // Pass the history BEFORE the just-pushed user message so the function skips it.
      messages: messages.value.slice(0, -1),
    });
    if (allowWriteSqlForNextRun) {
      // Extract the confirmed SQL from the assistant's proposal message.
      // If no SQL code block is found, treat the confirmation as rejected —
      // we cannot bind the agent to a specific SQL statement.
      for (let i = messages.value.length - 2; i >= 0; i--) {
        const msg = messages.value[i];
        if (msg.kind === "contextSummary") continue;
        if (msg.role === "assistant" && msg.content) {
          confirmedWriteSqlText = extractSingleSqlCodeBlock(msg.content);
          confirmedConnectionId = connection.id;
          const target = resolveAiDatabaseTarget(tab, connection);
          confirmedDatabase = target.database;
          confirmedSchema = target.schema;
          break;
        }
        if (msg.role === "user") break;
      }
      if (!confirmedWriteSqlText) {
        allowWriteSqlForNextRun = false;
      }
    }
  }
  // Verify the connection/database/schema haven't changed since the user confirmed
  // the write operation. If the user switched connections or namespaces between
  // confirmation and execution, the grant is void.
  if (allowWriteSqlForNextRun && confirmedWriteSqlText) {
    const target = resolveAiDatabaseTarget(tab, connection);
    if (confirmedConnectionId !== connection.id || confirmedDatabase !== target.database || confirmedSchema !== target.schema) {
      allowWriteSqlForNextRun = false;
      confirmedWriteSqlText = undefined;
    }
  }
  // Agent confirmation cannot grant autonomous writes while the active database is production.
  const allowWriteSql = requestedMode === "agent" && allowWriteSqlForNextRun && !productionContext.value.active;
  const confirmedWriteSql = allowWriteSql ? confirmedWriteSqlText : undefined;
  // Capture the confirmed target snapshot before clearing the one-shot grant
  // state, so the values survive to be passed through to the backend.
  const confirmedTargetConnId = allowWriteSql ? confirmedConnectionId : undefined;
  const confirmedTargetDb = allowWriteSql ? confirmedDatabase : undefined;
  const confirmedTargetSchema = allowWriteSql ? confirmedSchema : undefined;
  allowWriteSqlForNextRun = false;
  confirmedWriteSqlText = undefined;
  confirmedConnectionId = undefined;
  confirmedDatabase = undefined;
  confirmedSchema = undefined;
  messages.value.push({ role: "assistant", content: "", sourceConnectionName: connection.name });
  const assistantIdx = messages.value.length - 1;
  const sessionId = uuid();
  currentSessionId.value = sessionId;
  const agentEvents: AgentEvent[] = [];
  try {
    const sqlFiles = await loadReferencedSqlFiles(selectedSqlFiles);
    const context = await buildAiContext(tab, connection, {
      mentionedTables,
      sqlFiles,
    });
    const history: AiMessage[] = messagesForAgentHistory(messages.value.slice(0, -2));
    await runAgentStream(
      {
        config: activeConfig,
        action: requestedAction,
        mode: requestedMode,
        instruction: modelInstruction,
        context,
        allowWriteSql,
        confirmedWriteSql,
        confirmedConnectionId: confirmedTargetConnId,
        confirmedDatabase: confirmedTargetDb,
        confirmedSchema: confirmedTargetSchema,
      },
      history,
      (event: AgentEvent) => {
        agentEvents.push(event);
        if (event.type === "text_delta" && event.delta) {
          appendAssistantDelta(assistantIdx, event.delta);
        }
        if (event.type === "reasoning_delta" && event.delta) {
          appendAssistantReasoning(assistantIdx, event.delta);
        }
        if (event.type === "agent_end") {
          if (event.input_tokens || event.output_tokens) {
            const msg = messages.value[assistantIdx];
            if (msg) msg.tokens = { input: event.input_tokens ?? 0, output: event.output_tokens ?? 0 };
          }
        }
        if (event.type === "context_compacted") {
          const msg = messages.value[assistantIdx];
          if (msg) {
            if (!msg.agentSteps) msg.agentSteps = [];
            const step = agentEventToStep(event, agentEvents.length - 1);
            if (step) upsertAgentStep(msg.agentSteps, step);
          }
          pendingCompaction.value = { summary: event.summary, compactedMessages: event.compacted_messages };
        }
        // Real-time agent step rendering
        if (event.type === "tool_call_start" || event.type === "tool_call_end") {
          const msg = messages.value[assistantIdx];
          if (msg) {
            if (!msg.agentSteps) msg.agentSteps = [];
            const step = agentEventToStep(event, agentEvents.length - 1);
            if (step) upsertAgentStep(msg.agentSteps, step);
          }
        }
        scrollToBottom();
      },
      sessionId,
      customPromptContext,
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    messages.value[assistantIdx].content = `${t("ai.requestFailed")}\n\n${translateBackendError(t, message)}`;
  } finally {
    if (assistantDeltaFrame !== null) cancelAnimationFrame(assistantDeltaFrame);
    flushAssistantDeltas();
    const msg = messages.value[assistantIdx];
    if (msg) msg.isThinking = false;
    isGenerating.value = false;
    // Render agent tool call steps from agent events (fallback when no real-time steps)
    if (msg && agentEvents.length > 0 && !msg.agentSteps?.length) {
      const steps: AiAgentStepItem[] = [];
      agentEvents.forEach((e, index) => {
        const step = agentEventToStep(e, index);
        if (step) upsertAgentStep(steps, step);
      });
      if (steps.length) msg.agentSteps = steps;
    }
    // Fallback: use aiAgentPlan for backward compatibility
    if (msg && !msg.agentSteps?.length) {
      const agentPlan = buildAiAgentPlan({
        mode: requestedMode,
        action: requestedAction,
        instruction: modelInstruction,
        assistantContent: msg?.content || "",
        connection: connection,
        database: tab.database,
      });
      if (msg && requestedMode === "agent") msg.agentSteps = buildAiAgentStepItems(agentPlan);
      if (agentPlan.handoffSql) emit("requestAutoExecuteSql", agentPlan.handoffSql);
    }
    currentSessionId.value = "";
    // Apply deferred context compaction after streaming so assistantIdx stays stable.
    // Visible chat history is kept for the user; future LLM history starts from this hidden summary.
    if (pendingCompaction.value) {
      const { summary, compactedMessages } = pendingCompaction.value;
      pendingCompaction.value = null;
      const insertAt = Math.min(1 + compactedMessages, messages.value.length - 1);
      if (summary) {
        messages.value.splice(insertAt, 0, {
          role: "user",
          content: summary,
          kind: "contextSummary",
        });
      }
    }
    persistConversation();
    scrollToBottom();
  }
}

async function cancelStream() {
  if (currentSessionId.value) {
    await aiCancelStream(currentSessionId.value).catch(() => {});
  }
}

function applySql(code: string) {
  if (isRedisConnection.value) {
    emit("insertRedisCommand", code);
    return;
  }
  emit("replaceSql", code);
}

function executeSql(code: string) {
  if (isRedisConnection.value) {
    emit("executeRedisCommand", code);
    return;
  }
  emit("executeSql", code);
}

function tempRunSql(code: string) {
  if (isRedisConnection.value) {
    emit("executeRedisCommand", code);
    return;
  }
  emit("tempRunSql", code);
}

const copiedIndex = ref("");

async function copyCode(code: string, key: string) {
  try {
    await copyToClipboard(code);
    copiedIndex.value = key;
    setTimeout(() => {
      if (copiedIndex.value === key) copiedIndex.value = "";
    }, 2000);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    toast(t("grid.copyFailed", { message }), 5000);
  }
}

async function exportMessageAsMarkdown(msg: ChatMessage) {
  if (!msg.content) return;

  try {
    const result = buildAiAnalysisExport({
      connectionName: msg.sourceConnectionName ?? props.connection?.name,
      content: msg.content,
      analysisLabel: t("ai.analysis"),
      dateLabel: new Date().toLocaleString(),
    });
    if (!result) return;
    await saveTextFile(result.markdown, result.defaultFileName, "Markdown", "md");
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    toast(t("grid.exportFailed", { message }), 5000);
  }
}

function clearMessages() {
  messages.value = [];
  conversationId.value = "";
  historyIndex.value = -1;
  draftBeforeHistory.value = "";
  messageRenderer.value.clear();
}

async function persistConversation() {
  if (!messages.value.length || !props.connection) return;
  if (!conversationId.value) conversationId.value = uuid();
  const first = messages.value.find((m) => m.role === "user" && m.kind !== "contextSummary");
  await saveAiConversation({
    id: conversationId.value,
    title: first ? messageTitle(first).slice(0, 50) : "Untitled",
    connectionName: props.connection.name,
    database: props.tab?.database || "",
    messages: messages.value.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.mentions?.length ? { mentions: m.mentions } : {}),
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.kind ? { kind: m.kind } : {}),
    })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).catch(() => {});
}

async function setConversationListOpen(open: boolean) {
  showConversationList.value = open;
  if (open) conversations.value = await loadAiConversations().catch(() => []);
}

function selectConversation(conv: AiConversation) {
  conversationId.value = conv.id;
  // Drop the previous conversation's rendered Markdown instead of keeping it until the LRU evicts it.
  messageRenderer.value.clear();
  messages.value = conv.messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
    sourceConnectionName: m.role === "assistant" ? conv.connectionName : undefined,
    mentions: Array.isArray(m.mentions) ? (m.mentions as AiMessageMention[]) : undefined,
    reasoning: m.reasoning,
    kind: m.kind,
  }));
  pendingCompaction.value = null;
  showConversationList.value = false;
  scrollToBottom({ force: true });
}

async function deleteConversation(id: string) {
  await deleteAiConversation(id).catch(() => {});
  conversations.value = conversations.value.filter((c) => c.id !== id);
  if (conversationId.value === id) clearMessages();
}

function startNewChat() {
  clearMessages();
  showConversationList.value = false;
  // A fresh conversation starts from the configured default mode.
  const mode = settings.defaultAiMode;
  assistantMode.value = mode;
  activeAction.value = resolveDefaultAction(mode);
}

onMounted(async () => {
  const savedHeight = localStorage.getItem(AI_TEXTAREA_HEIGHT_STORAGE_KEY);
  if (savedHeight) {
    const height = parseInt(savedHeight, 10);
    if (!isNaN(height)) {
      textareaHeight.value = clampTextareaHeight(height);
    }
  }

  conversations.value = await loadAiConversations().catch(() => []);
  shikiCodeHighlighter.value = await createAiShikiCodeHighlighter({
    appearance: () => aiCodeAppearance.value,
  }).catch(() => undefined);

  window.addEventListener("resize", handlePanelResize);
  if (typeof ResizeObserver !== "undefined" && assistantRootRef.value) {
    promptPanelResizeObserver = new ResizeObserver(handlePanelResize);
    promptPanelResizeObserver.observe(assistantRootRef.value);
  }
});

function maxTextareaHeight() {
  const panelHeight = assistantRootRef.value?.clientHeight || window.innerHeight || 0;
  const promptPanelHeight = promptPanelRef.value?.offsetHeight || 0;
  const currentTextareaHeight = promptTextareaRef.value?.offsetHeight || textareaHeight.value;
  const promptPanelChromeHeight = Math.max(0, promptPanelHeight - currentTextareaHeight);
  return Math.max(AI_TEXTAREA_MIN_HEIGHT_PX, Math.floor(panelHeight * AI_TEXTAREA_MAX_PANEL_RATIO - promptPanelChromeHeight));
}

function clampTextareaHeight(height: number) {
  return Math.max(AI_TEXTAREA_MIN_HEIGHT_PX, Math.min(maxTextareaHeight(), Math.round(height)));
}

function handlePanelResize() {
  textareaHeight.value = clampTextareaHeight(textareaHeight.value);
}

function startResize(event: MouseEvent) {
  event.preventDefault();
  isResizing.value = true;
  resizeStartY = event.clientY;
  resizeStartHeight = textareaHeight.value;

  document.addEventListener("mousemove", handleResize);
  document.addEventListener("mouseup", stopResize);

  document.body.style.userSelect = "none";
  document.body.style.cursor = "ns-resize";
}

function handleResize(event: MouseEvent) {
  if (!isResizing.value) return;

  const deltaY = resizeStartY - event.clientY;
  textareaHeight.value = clampTextareaHeight(resizeStartHeight + deltaY);
}

function stopResize() {
  if (!isResizing.value) return;

  isResizing.value = false;

  document.removeEventListener("mousemove", handleResize);
  document.removeEventListener("mouseup", stopResize);

  document.body.style.userSelect = "";
  document.body.style.cursor = "";

  localStorage.setItem(AI_TEXTAREA_HEIGHT_STORAGE_KEY, clampTextareaHeight(textareaHeight.value).toString());
}

onUnmounted(() => {
  if (assistantDeltaFrame !== null) cancelAnimationFrame(assistantDeltaFrame);
  clearTimeout(mentionTimer);
  clearEffortMenuCloseTimer();
  cancelStream();
  detachMessageScrollListener();
  // 清理拖拽事件监听，防止内存泄漏
  document.removeEventListener("mousemove", handleResize);
  document.removeEventListener("mouseup", stopResize);
  // 若卸载时仍在拖拽，复位 body 样式，避免全局残留
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  window.removeEventListener("resize", handlePanelResize);
  promptPanelResizeObserver?.disconnect();
});

function triggerAction(action: AiAction, instruction?: string) {
  // External Ask-style entry points (Fix with AI, Explain history) produce/analyze SQL text.
  // If the assistant is currently in Agent mode where those actions aren't offered, switch to
  // Ask mode so the action is valid and the menu reflects what actually runs.
  if (!isValidActionForMode(action, assistantMode.value)) {
    // Suppress the mode-switch watch so it doesn't overwrite `action` (set below) with the
    // Ask default — the menu must reflect the action actually being run.
    suppressModeActionReset = true;
    assistantMode.value = "ask";
  }
  activeAction.value = action;
  if (instruction) prompt.value = instruction;
  send();
}

function setPrompt(text: string) {
  prompt.value = text;
  nextTick(() => promptTextareaRef.value?.focus());
}

defineExpose({ triggerAction, setPrompt });

const messageRenderer = computed(() => {
  const appearance = aiCodeAppearance.value;
  const highlightCode = shikiCodeHighlighter.value;
  return createAiMessageRenderer({
    markdown: formatAiInlineMarkdown,
    highlightCode: highlightCode ? (content, lang) => highlightCode(content, lang, appearance) : undefined,
  });
});

/**
 * Renders Markdown live while the answer streams in. The renderer reuses the
 * already-finished segments, so a frame only re-parses the growing tail.
 */
function renderMessageSegments(msg: ChatMessage) {
  const streaming = isGenerating.value && msg === messages.value[messages.value.length - 1];
  return messageRenderer.value.render(msg.content, { streaming });
}

function onMarkdownClick(event: MouseEvent) {
  handleAiMarkdownLinkClick(event, openExternalUrl);
}

async function openExternalUrl(url: string) {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
</script>

<template>
  <div ref="assistantRootRef" class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="flex items-center gap-2 border-b px-3 shrink-0" :class="settings.editorSettings.appLayout === 'classic' ? 'h-9' : 'h-10'">
      <span class="flex flex-1 self-stretch items-center truncate text-xs font-medium" data-tauri-drag-region>
        {{ chatTitle }}
      </span>
      <ProductionContextBadge v-if="productionContext.active" compact />
      <Button variant="ghost" size="icon" class="h-6 w-6" @click="startNewChat" :title="t('ai.newChat')">
        <MessageSquarePlus class="h-3.5 w-3.5" />
      </Button>
      <Popover :open="showConversationList" @update:open="setConversationListOpen">
        <PopoverTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6" :class="{ 'bg-accent': showConversationList }" :title="t('history.title')">
            <History class="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-72 gap-0 p-0" @click.stop>
          <div class="flex items-center border-b px-3 py-2">
            <span class="flex-1 text-xs font-medium">{{ t("history.title") }}</span>
            <Button variant="ghost" size="icon" class="h-6 w-6" @click="startNewChat">
              <MessageSquarePlus class="h-3.5 w-3.5" />
            </Button>
          </div>
          <div v-if="!conversations.length" class="p-3 text-center text-xs text-muted-foreground">
            {{ t("history.empty") }}
          </div>
          <div v-else class="max-h-64 overflow-auto p-1">
            <div v-for="conv in conversations" :key="conv.id" class="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted" :class="{ 'bg-muted': conv.id === conversationId }" @click="selectConversation(conv)">
              <span class="min-w-0 flex-1 truncate">{{ conv.title }}</span>
              <button class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-destructive" @click.stop="deleteConversation(conv.id)">
                <X class="h-3 w-3" />
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <Button variant="ghost" size="icon" class="h-6 w-6" @click="clearMessages" :title="t('ai.clear')">
        <Trash2 class="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" class="h-6 w-6" @click="emit('close')">
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>

    <div v-if="messages.length === 0" class="flex-1 min-h-0 flex flex-col items-center justify-center text-center text-muted-foreground">
      <Bot class="h-10 w-10 mb-3 opacity-30" />
      <p class="text-sm">{{ t("ai.welcome") }}</p>
    </div>
    <div v-else class="relative min-h-0 flex-1">
      <ScrollArea ref="scrollRef" class="ai-message-scroll h-full overflow-hidden">
        <div class="flex flex-col gap-3 p-3">
          <template v-for="(msg, i) in visibleMessages" :key="i">
            <div v-if="msg.role === 'user'" class="group flex justify-end">
              <div class="relative min-w-0 max-w-[85%]" :class="{ 'w-[85%]': editingMessageIndex === i }">
                <template v-if="editingMessageIndex === i">
                  <div v-if="editingMentions.length" class="mb-1.5 flex flex-wrap justify-end gap-1">
                    <button
                      v-for="(mention, mentionIndex) in editingMentions"
                      :key="`${mention.kind}:${mention.raw}:${mentionIndex}`"
                      type="button"
                      class="group inline-flex max-w-full items-center gap-1 rounded border border-border/80 bg-muted/70 px-1.5 py-0.5 text-[11px] text-foreground/90 hover:bg-muted"
                      :title="mentionDisplayName(mention)"
                      @click="removeEditingMentionChip(mentionIndex)"
                    >
                      <FileCode v-if="mention.kind === 'sqlFile'" class="h-3 w-3 shrink-0 text-primary" />
                      <Table2 v-else class="h-3 w-3 shrink-0 text-primary" />
                      <span class="truncate">{{ mentionDisplayName(mention) }}</span>
                      <X class="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-foreground" />
                    </button>
                  </div>
                  <textarea
                    data-edit-textarea
                    v-model="editingContent"
                    rows="3"
                    class="w-full resize-none rounded-lg border bg-background px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-primary"
                    @keydown="onEditKeydown($event, i)"
                    @compositionstart="editCompositionActive = true"
                    @compositionend="editCompositionActive = false"
                  />
                  <div class="mt-1.5 flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" class="h-6 px-2 text-[11px]" @click="cancelEdit">{{ t("ai.editCancel") }}</Button>
                    <Button size="sm" class="h-6 px-2 text-[11px]" @click="submitEdit(i)">{{ t("ai.editResend") }}</Button>
                  </div>
                </template>
                <template v-else>
                  <div class="min-w-0">
                    <!-- Keep the hover action out of normal flow so message wrapping stays stable. -->
                    <button
                      v-if="!isGenerating"
                      class="pointer-events-none absolute right-full top-1 mr-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:pointer-events-auto focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                      :title="t('ai.editMessage')"
                      @click="startEditMessage(i)"
                    >
                      <Pencil class="h-3 w-3" />
                    </button>
                    <div class="min-w-0 rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground">
                      <div v-if="msg.mentions?.length" class="mb-1.5 flex flex-wrap justify-end gap-1">
                        <button
                          v-for="mention in msg.mentions"
                          :key="`${mention.kind}:${mention.raw}`"
                          type="button"
                          class="inline-flex max-w-full items-center gap-1 rounded border border-primary-foreground/25 bg-primary-foreground/15 px-1.5 py-0.5 text-[11px] text-primary-foreground hover:bg-primary-foreground/25"
                          :title="mention.kind === 'sqlFile' ? mention.name : [mention.schema, mention.table].filter(Boolean).join('.')"
                          @click.stop="openMessageMention(mention)"
                        >
                          <FileCode v-if="mention.kind === 'sqlFile'" class="h-3 w-3 shrink-0" />
                          <Table2 v-else class="h-3 w-3 shrink-0" />
                          <span class="truncate">{{ mention.kind === "sqlFile" ? mention.name : [mention.schema, mention.table].filter(Boolean).join(".") }}</span>
                        </button>
                      </div>
                      <div v-if="msg.content" class="whitespace-pre-wrap">{{ msg.content }}</div>
                    </div>
                  </div>
                </template>
              </div>
            </div>

            <!-- Keep the metadata row as wide as the reply card so its export action stays right-aligned. -->
            <div v-else-if="msg.content || msg.reasoning || msg.isThinking" class="flex w-full max-w-[95%] min-w-0 flex-col">
              <div class="w-full rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed [overflow-wrap:anywhere]">
                <div v-if="msg.reasoning || msg.isThinking" class="mb-2">
                  <button class="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors" @click="toggleReasoning()">
                    <ChevronRight class="h-3 w-3 transition-transform duration-200" :class="{ 'rotate-90': reasoningExpanded }" />
                    <Loader2 v-if="msg.isThinking" class="h-3 w-3 animate-spin" />
                    <span>{{ t("ai.reasoningProcess") }}</span>
                    <span v-if="shouldShowReasoningCharCount(msg.reasoning, reasoningExpanded)" :class="reasoningCharCountClass(!!msg.isThinking)">{{ msg.reasoning?.length ?? 0 }} {{ t("ai.chars") }}</span>
                  </button>
                  <div
                    class="overflow-hidden transition-[max-height,opacity] duration-200 ease-in-out"
                    :style="{
                      maxHeight: reasoningExpanded ? '20000px' : '0px',
                      opacity: reasoningExpanded ? '1' : '0',
                    }"
                  >
                    <div class="mt-1.5 pl-4 border-l-2 border-muted-foreground/20 text-[11px] text-muted-foreground whitespace-pre-wrap">
                      {{ msg.reasoning }}
                    </div>
                  </div>
                </div>
                <div v-if="msg.agentSteps?.length" class="mb-2 space-y-1">
                  <div v-for="step in msg.agentSteps" :key="step.key" class="rounded border text-[10px]" :class="agentStepClass(step.tone)">
                    <button class="flex w-full items-center gap-1 px-2 py-1.5 text-left" @click="step.toolResult || step.toolArgs?.sql ? toggleStep(step.key) : undefined">
                      <component :is="agentStepIcon(step.tone)" class="h-3 w-3 shrink-0" />
                      <span class="font-medium">{{ t(step.labelKey) }}</span>
                      <span v-if="step.toolName" class="text-muted-foreground">: {{ step.toolName }}</span>
                      <ChevronRight v-if="step.toolResult || step.toolArgs?.sql" class="ml-auto h-3 w-3 shrink-0 transition-transform duration-150" :class="{ 'rotate-90': expandedSteps.has(step.key) }" />
                    </button>
                    <div v-if="expandedSteps.has(step.key)" class="border-t border-current/10 px-2 pb-2 pt-1">
                      <div v-if="step.toolArgs?.sql" class="mb-1 rounded bg-background/50 px-2 py-1 font-mono text-[10px] text-foreground/80 whitespace-pre-wrap">{{ step.toolArgs.sql }}</div>
                      <Button v-if="step.toolName === 'explain_query' && step.toolArgs?.sql" size="sm" variant="outline" class="mb-1 h-6 gap-1 text-[10px]" @click="emit('openExplainPlan', step.toolArgs.sql as string)">
                        <GitBranch class="h-3 w-3" />
                        {{ t("explain.title") }}
                      </Button>
                      <div v-if="step.toolName === 'explain_query' && step.explainData && connection?.db_type" class="mb-1">
                        <ExplainPlanViewer :plan="parseExplainFromData(step.explainData, connection.db_type)" class="max-h-64" />
                      </div>
                      <div v-else-if="step.isError && step.toolResult" class="text-[10px] text-red-600 dark:text-red-400">{{ step.toolResult }}</div>
                      <div v-else-if="step.toolResult" class="max-h-48 overflow-auto text-[10px] text-muted-foreground whitespace-pre-wrap">{{ step.toolResult }}</div>
                    </div>
                  </div>
                </div>
                <template v-for="(seg, j) in renderMessageSegments(msg)" :key="j">
                  <div v-if="seg.type === 'text'" class="ai-markdown whitespace-normal" @click.capture="onMarkdownClick">
                    <div v-html="seg.html" />
                  </div>
                  <div v-else class="my-2 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-700/50 dark:bg-zinc-900">
                    <div class="flex items-center border-b border-zinc-200 px-3 py-1.5 text-[10px] font-medium text-zinc-600 dark:border-zinc-700/50 dark:text-zinc-400">
                      <component :is="seg.isSql ? Database : Terminal" class="h-3 w-3 mr-1.5" />
                      <span>{{ seg.lang }}</span>
                      <span class="flex-1" />
                      <!-- `pending` means the closing fence is still missing, so the code is truncated: never offer to run or apply it. -->
                      <Loader2 v-if="seg.pending && isGenerating" class="h-3 w-3 animate-spin text-zinc-400" />
                      <div class="flex items-center gap-1.5">
                        <button v-if="!seg.pending && seg.isSql && !isRedisConnection" class="rounded p-0.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200" :title="t('ai.tempRunSql')" @click="tempRunSql(seg.content)">
                          <FlaskConical class="h-3.5 w-3.5" />
                        </button>
                        <button v-if="!seg.pending && (seg.isSql || isRedisConnection)" class="rounded p-0.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200" :title="t('ai.executeSql')" @click="executeSql(seg.content)">
                          <Play class="h-3.5 w-3.5" />
                        </button>
                        <button v-if="!seg.pending && (seg.isSql || isRedisConnection)" class="rounded p-0.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200" :title="t('ai.apply')" @click="applySql(seg.content)">
                          <Replace class="h-3.5 w-3.5" />
                        </button>
                        <button
                          class="rounded p-0.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                          :title="copiedIndex === `${i}-${j}` ? t('ai.copied') : t(seg.isSql ? 'ai.copySql' : 'ai.copyCode')"
                          @click="copyCode(seg.content, `${i}-${j}`)"
                        >
                          <Check v-if="copiedIndex === `${i}-${j}`" class="h-3.5 w-3.5 text-green-400" />
                          <Copy v-else class="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <pre class="ai-code-block whitespace-pre-wrap break-words p-3 text-xs leading-relaxed text-zinc-900 dark:text-zinc-100"><code v-html="seg.html"></code></pre>
                  </div>
                </template>
                <div v-if="msg === proposalConfirmMessage" class="mt-2 flex gap-2" :title="t('ai.proposalConfirmTitle')">
                  <Button size="sm" variant="default" class="h-7 gap-1 text-[11px]" @click="sendProposalReply(true)">
                    <Check class="h-3 w-3" />
                    {{ t("ai.proposalConfirmYes") }}
                  </Button>
                  <Button size="sm" variant="outline" class="h-7 gap-1 text-[11px]" @click="sendProposalReply(false)">
                    <X class="h-3 w-3" />
                    {{ t("ai.proposalConfirmNo") }}
                  </Button>
                </div>
              </div>
              <div v-if="msg.content && !isGenerating" class="mt-1 flex items-center justify-between">
                <span v-if="msg.tokens" class="text-[10px] text-muted-foreground">&#8593;{{ msg.tokens.input.toLocaleString() }} &#8595;{{ msg.tokens.output.toLocaleString() }} tokens</span>
                <span v-else />
                <button class="rounded p-0.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200" :title="t('ai.exportMarkdown')" @click="exportMessageAsMarkdown(msg)">
                  <FileDown class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </template>

          <div v-if="isWaitingForFirstDelta" class="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 class="h-3.5 w-3.5 animate-spin" />
            <span>{{ t("ai.thinking") }}</span>
          </div>
        </div>
      </ScrollArea>
      <button
        v-if="showScrollToBottom"
        type="button"
        class="absolute bottom-3 right-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full border bg-background/95 text-foreground shadow-md backdrop-blur hover:bg-muted"
        :title="t('ai.scrollToBottom')"
        @click="scrollToBottom({ force: true })"
      >
        <ArrowDown class="h-4 w-4" />
        <span class="sr-only">{{ t("ai.scrollToBottom") }}</span>
      </button>
    </div>

    <div class="p-2">
      <div ref="promptPanelRef" class="relative rounded-[6px] border bg-background">
        <div class="resize-handle" @mousedown="startResize"></div>
        <div class="px-2 pb-2 pt-1">
          <div class="flex items-center gap-1 mb-1 text-xs text-foreground/80">
            <template v-if="connectionStore.connections.length">
              <DatabaseIcon v-if="connection" :db-type="connectionIconType(connection)" class="h-3 w-3 shrink-0" />
              <Server v-else class="h-3 w-3 shrink-0" />
              <Select
                :model-value="connection?.id || ''"
                @update:model-value="
                  (v) => {
                    if (typeof v === 'string') changeConnection(v);
                  }
                "
              >
                <SelectTrigger class="h-5 w-auto border-0 rounded-md bg-transparent dark:bg-transparent p-0 px-1 text-xs text-foreground/80 shadow-none focus:ring-0 focus-visible:ring-0 [&_svg]:size-3">
                  <SelectValue :placeholder="t('editor.selectConnection')">{{ connection?.name || t("editor.selectConnection") }}</SelectValue>
                </SelectTrigger>
                <SelectContent class="min-w-48">
                  <SelectItem v-for="conn in connectionStore.connections" :key="conn.id" :value="conn.id">
                    <div class="flex min-w-0 items-center gap-2">
                      <DatabaseIcon :db-type="connectionIconType(conn)" class="h-3.5 w-3.5 shrink-0" />
                      <ConnectionGroupBadge :connection-id="conn.id" />
                      <span class="truncate">{{ conn.name }}</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <template v-if="connection">
                <Database class="h-3 w-3 shrink-0 text-foreground/40" />
                <Select
                  :model-value="selectedDatabaseSelectValue"
                  @update:model-value="
                    (v) => {
                      if (typeof v === 'string') changeNamespace(v);
                    }
                  "
                  @update:open="
                    (open: boolean) => {
                      if (open) loadDatabases();
                    }
                  "
                >
                  <SelectTrigger class="h-5 w-auto border-0 rounded-md bg-transparent dark:bg-transparent p-0 px-1 text-xs text-foreground/80 shadow-none focus:ring-0 focus-visible:ring-0 [&_svg]:size-3">
                    <SelectValue :placeholder="t('editor.selectDatabase')">{{ selectedDatabaseLabel }}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="option in dbSelectOptions" :key="option.value" :value="option.value">{{ option.label }}</SelectItem>
                    <SelectItem v-if="!dbSelectOptions.length && connection && tab" :value="selectedDatabaseSelectValue">{{ selectedDatabaseLabel }}</SelectItem>
                  </SelectContent>
                </Select>
              </template>
            </template>
            <span class="min-w-0 flex-1" />
            <!-- Template selector -->
            <Popover v-model:open="showTemplateSelector">
              <PopoverTrigger as-child>
                <button type="button" class="flex min-w-0 max-w-[40%] items-center gap-1 rounded-[6px] border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" :aria-label="templateSelectorTriggerLabel" :title="templateSelectorTriggerLabel">
                  <FileCode class="h-3 w-3" />
                  <span class="truncate">{{ templateSelectorTriggerLabel }}</span>
                  <svg class="h-3 w-3 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg>
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" class="w-64 gap-0 p-1.5">
                <div class="max-h-64 overflow-auto">
                  <div v-if="!promptTemplateStore.isLoaded" class="px-3 py-4 text-center text-xs text-muted-foreground">
                    {{ t("ai.templateSelectorLoading") }}
                  </div>
                  <div v-else-if="promptTemplateStore.templates.length === 0" class="px-3 py-4 text-center text-xs text-muted-foreground">
                    {{ t("ai.templateSelectorEmpty") }}
                  </div>
                  <template v-else>
                    <template v-for="tpl in promptTemplateStore.templates" :key="tpl.id">
                      <button type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted" @click="toggleTemplateId(tpl.id)">
                        <div class="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border" :class="activeTemplateIds.includes(tpl.id) ? 'border-primary bg-primary text-primary-foreground' : ''">
                          <Check v-if="activeTemplateIds.includes(tpl.id)" class="h-3 w-3" />
                        </div>
                        <div class="flex-1 truncate text-left">
                          <div class="font-medium">{{ tpl.name }}</div>
                          <div class="text-[10px] text-muted-foreground truncate">{{ tpl.content.slice(0, 60) }}</div>
                        </div>
                      </button>
                    </template>
                  </template>
                </div>
                <div v-if="promptTemplateStore.isLoaded && promptTemplateStore.templates.length > 0" class="border-t mt-1 pt-1 px-1">
                  <button type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" @click="deselectAllTemplates">
                    {{ t("ai.templateSelectorDeselectAll") }}
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div v-if="mentionOpen" class="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-56 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
            <div v-if="mentionLoading" class="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <Loader2 class="h-3.5 w-3.5 animate-spin" />
              <span>{{ t("common.loading") }}</span>
            </div>
            <div v-else-if="mentionError" class="px-2 py-2 text-xs text-destructive">
              {{ mentionError }}
            </div>
            <div v-else-if="!mentionCandidates.length" class="px-2 py-2 text-xs text-muted-foreground">
              {{ t("ai.tableMentionEmpty") }}
            </div>
            <div v-else ref="mentionListRef" class="max-h-56 overflow-auto p-1">
              <button
                v-for="(candidate, index) in mentionCandidates"
                :key="candidate.kind === 'sqlFile' ? `sql-file:${candidate.id}` : `table:${candidate.schema || ''}.${candidate.name}`"
                type="button"
                :data-mention-index="index"
                class="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
                :class="{ 'bg-muted': index === mentionSelectedIndex }"
                @mousedown.prevent="insertMention(candidate)"
                @mouseenter="setMentionSelectedIndex(index, false)"
              >
                <FileCode v-if="candidate.kind === 'sqlFile'" class="h-3.5 w-3.5 shrink-0 text-primary" />
                <Table2 v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate">
                  {{ mentionCandidateName(candidate) }}
                </span>
                <span class="max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground">{{ formatMentionCandidateType(candidate) }}</span>
              </button>
            </div>
          </div>
          <div v-if="commandOpen && filteredCommands.length" class="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-56 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
            <div class="max-h-56 overflow-auto p-1">
              <button
                v-for="(cmd, index) in filteredCommands"
                :key="cmd.action"
                type="button"
                class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
                :class="{ 'bg-muted': index === commandSelectedIndex }"
                @mousedown.prevent="selectCommand(cmd)"
                @mouseenter="commandSelectedIndex = index"
              >
                <component :is="cmd.icon" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span class="font-medium">/{{ cmd.action }}</span>
                <span class="ml-auto text-[11px] text-muted-foreground">{{ t(cmd.key) }}</span>
              </button>
            </div>
          </div>
          <div v-if="promptMentionChips.length" class="mb-1.5 flex flex-wrap gap-1">
            <button
              v-for="mention in promptMentionChips"
              :key="mention.raw"
              type="button"
              class="group inline-flex max-w-full items-center gap-1 rounded border border-border/80 bg-muted/60 px-1.5 py-0.5 text-[11px] text-foreground/90 hover:bg-muted"
              :title="mentionDisplayName(mention)"
              @click="removeMentionChip(mention)"
            >
              <FileCode v-if="mention.kind === 'sqlFile'" class="h-3 w-3 shrink-0 text-primary" />
              <Table2 v-else class="h-3 w-3 shrink-0 text-primary" />
              <span class="truncate">{{ mentionDisplayName(mention) }}</span>
              <X class="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-foreground" />
            </button>
          </div>
          <textarea
            ref="promptTextareaRef"
            v-model="prompt"
            :style="{ height: `${textareaHeight}px`, maxHeight: `${maxTextareaHeight()}px` }"
            class="w-full resize-none bg-transparent text-xs outline-none placeholder:text-muted-foreground mb-1"
            :placeholder="activePlaceholder"
            @input="refreshMentionState"
            @click="refreshMentionState"
            @keyup="onPromptKeyup"
            @compositionstart="promptCompositionActive = true"
            @compositionend="promptCompositionActive = false"
            @keydown="onPromptKeydown"
          />
          <div class="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
            <!-- Combined mode + action selector -->
            <Popover v-model:open="modeActionOpen">
              <PopoverTrigger as-child>
                <button type="button" class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[6px] border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground" :aria-label="modeActionTriggerLabel">
                  <component :is="modeIcon" class="h-3 w-3" />
                  <span>{{ modeActionTriggerLabel }}</span>
                  <svg class="h-3 w-3 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg>
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-56 gap-0 p-1.5" @click.stop>
                <!-- Mode tabs -->
                <div class="flex items-center gap-1 mb-1.5 px-0.5">
                  <button
                    type="button"
                    class="flex-1 flex items-center justify-center gap-1.5 rounded-sm px-2 py-1 text-xs"
                    :class="assistantMode === 'ask' ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'"
                    @click="switchModeActionTab('ask')"
                  >
                    <MessageSquarePlus class="h-3 w-3" />
                    {{ t("ai.modes.ask") }}
                  </button>
                  <button
                    type="button"
                    class="flex-1 flex items-center justify-center gap-1.5 rounded-sm px-2 py-1 text-xs"
                    :class="assistantMode === 'agent' ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'"
                    @click="switchModeActionTab('agent')"
                  >
                    <Bot class="h-3 w-3" />
                    {{ t("ai.modes.agent") }}
                  </button>
                </div>
                <template v-if="showActionButtons">
                  <div class="border-t my-1" />
                  <!-- Action list -->
                  <div class="max-h-56 overflow-auto">
                    <button v-for="button in actionButtons" :key="button.action" type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs" :class="activeAction === button.action ? 'bg-accent' : 'hover:bg-muted'" @click="selectModeActionItem(button.action)">
                      <component :is="button.icon" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span class="flex-1 text-left">{{ t(button.key) }}</span>
                      <Check v-if="activeAction === button.action" class="h-3.5 w-3.5 shrink-0" />
                    </button>
                  </div>
                </template>
              </PopoverContent>
            </Popover>
            <span class="min-w-0 flex-1" />
            <template v-if="settings.aiConfigs.length > 0">
              <!-- Combined provider + model selector -->
              <Popover v-model:open="providerSelectorOpen">
                <PopoverTrigger as-child>
                  <button type="button" class="min-w-0 flex shrink items-center gap-1.5 max-w-[220px] rounded-[6px] border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
                    <AiProviderLogo
                      :provider="activeFullConfig?.provider ?? 'claude'"
                      :label="AI_PROVIDER_PRESETS[activeFullConfig?.provider ?? 'claude']?.label ?? activeFullConfig?.provider ?? 'claude'"
                      :icon-slug="AI_PROVIDER_PRESETS[activeFullConfig?.provider ?? 'claude']?.iconSlug"
                      class="h-3 w-3 shrink-0"
                    />
                    <span class="min-w-0 truncate">{{ activeFullConfig?.model || t("ai.selectModel") }}</span>
                    <svg class="h-3 w-3 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" class="max-h-(--reka-popover-content-available-height) w-80 gap-0 overflow-y-auto p-1.5" @open-auto-focus.prevent>
                  <div class="relative px-1 pb-1">
                    <Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input v-model="modelSearchQuery" type="text" :placeholder="t('ai.searchModels')" class="w-full rounded-sm border bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-primary" @click.stop />
                  </div>
                  <div class="max-h-80 overflow-auto">
                    <template v-for="config in configuredProviders" :key="config.id">
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted"
                        :class="config.id === settings.activeModel?.configId ? 'bg-accent text-accent-foreground' : 'text-foreground'"
                        :aria-expanded="!isModelConfigCollapsed(config.id)"
                        @click="toggleModelConfig(config.id)"
                      >
                        <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform" :class="{ 'rotate-90': !isModelConfigCollapsed(config.id) }" />
                        <AiProviderLogo :provider="config.provider" :label="AI_PROVIDER_PRESETS[config.provider]?.label ?? config.provider" :icon-slug="AI_PROVIDER_PRESETS[config.provider]?.iconSlug" class="h-3.5 w-3.5 shrink-0" />
                        <span class="min-w-0 flex-1 truncate font-medium">{{ config.name }}</span>
                        <Loader2 v-if="getModelCatalog(config.id).status === 'loading'" class="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                        <span v-if="config.isDefault" class="ml-auto text-[10px] text-muted-foreground">{{ t("ai.default") }}</span>
                      </button>
                      <div v-if="!isModelConfigCollapsed(config.id)">
                        <div v-if="getModelCatalog(config.id).status === 'loading' && !getModelsForConfig(config.id).length" class="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                          <Loader2 class="h-3.5 w-3.5 animate-spin" />
                          {{ t("ai.loadingModels") }}
                        </div>
                        <div v-else-if="getModelCatalog(config.id).status === 'error' && !getModelsForConfig(config.id).length" class="space-y-1 px-2 py-2 text-xs text-muted-foreground">
                          <div class="truncate" :title="getModelCatalog(config.id).error">{{ t("ai.modelLoadFailed") }}</div>
                          <button type="button" class="text-primary hover:underline" @click="loadModels(config, true)">{{ t("ai.retry") }}</button>
                        </div>
                        <div v-else-if="getModelCatalog(config.id).status === 'ready' && !getConfigModelOptions(config).length" class="px-2 py-2 text-xs text-muted-foreground">
                          {{ modelSearchQuery.trim() ? t("ai.noModelMatch") : t("ai.noModels") }}
                        </div>
                        <template v-if="getConfigModelOptions(config).length">
                          <button
                            v-for="model in getConfigModelOptions(config)"
                            :key="model.id"
                            type="button"
                            class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                            :class="model.id === settings.activeModel?.modelId && config.id === settings.activeModel?.configId ? 'bg-accent text-accent-foreground' : ''"
                            @click="handleModelSelect(config.id, model.id)"
                          >
                            <span class="min-w-0 flex-1 truncate">
                              {{ model.displayName || model.id }}
                              <span v-if="model.displayName && model.displayName !== model.id" class="ml-1 text-[10px] text-muted-foreground">{{ model.id }}</span>
                            </span>
                            <Check v-if="model.id === settings.activeModel?.modelId && config.id === settings.activeModel?.configId" class="h-3.5 w-3.5 shrink-0 text-primary" />
                          </button>
                        </template>
                        <div v-if="getModelCatalog(config.id).status === 'error' && getModelsForConfig(config.id).length" class="flex items-center justify-between gap-2 px-2 py-1 text-[10px] text-muted-foreground">
                          <span class="truncate" :title="getModelCatalog(config.id).error">{{ t("ai.modelLoadFailed") }}</span>
                          <button type="button" class="shrink-0 text-primary hover:underline" @click="loadModels(config, true)">{{ t("ai.retry") }}</button>
                        </div>
                        <form v-if="manualModelConfigId === config.id" class="flex items-center gap-1 px-2 py-1" @submit.prevent="applyManualModel(config.id)">
                          <input v-model="manualModelId" data-manual-model-input type="text" :placeholder="t('ai.manualModelPlaceholder')" class="min-w-0 flex-1 rounded-sm border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary" @click.stop />
                          <Button type="submit" size="sm" class="h-6 px-2 text-[10px]" :disabled="!manualModelId.trim()">{{ t("common.confirm") }}</Button>
                        </form>
                        <button v-else type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" @click="startManualModel(config.id)">
                          <Pencil class="h-3 w-3" />
                          {{ t("ai.manualModel") }}
                        </button>
                      </div>
                      <div class="my-1 border-t" />
                    </template>
                  </div>
                  <div v-if="settings.activeModel" class="border-t pt-1">
                    <Popover v-model:open="effortMenuOpen">
                      <PopoverAnchor as-child>
                        <button
                          type="button"
                          class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                          :aria-expanded="effortMenuOpen"
                          aria-haspopup="menu"
                          @mouseenter="openEffortMenu"
                          @mouseleave="scheduleEffortMenuClose"
                          @focus="openEffortMenu"
                          @click.stop="openEffortMenu"
                        >
                          <ChevronLeft class="h-3.5 w-3.5 shrink-0" />
                          <span>{{ t("ai.effort") }}</span>
                          <span class="ml-auto max-w-[160px] truncate text-muted-foreground">{{ effortSelectionLabel(settings.activeEffort) }}</span>
                        </button>
                      </PopoverAnchor>
                      <PopoverContent
                        side="left"
                        align="end"
                        :side-offset="6"
                        :collision-padding="8"
                        class="max-h-(--reka-popover-content-available-height) w-72 gap-1 overflow-y-auto p-2"
                        @mouseenter="openEffortMenu"
                        @mouseleave="scheduleEffortMenuClose"
                        @open-auto-focus.prevent
                        @close-auto-focus.prevent
                        @pointerdown.stop
                        @click.stop
                        @keydown.stop
                      >
                        <button
                          type="button"
                          class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                          :class="!settings.activeEffort || settings.activeEffort.kind === 'providerDefault' ? 'bg-accent text-accent-foreground' : ''"
                          @click="selectEffort({ kind: 'providerDefault' })"
                        >
                          <span class="flex-1">{{ t("ai.providerDefault") }}</span>
                          <Check v-if="!settings.activeEffort || settings.activeEffort.kind === 'providerDefault'" class="h-3.5 w-3.5 text-primary" />
                        </button>
                        <div v-if="activeEffortEntry?.status === 'loading'" class="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                          <Loader2 class="h-3.5 w-3.5 animate-spin" />
                          {{ t("ai.loadingEffort") }}
                        </div>
                        <div v-else-if="activeEffortEntry?.status === 'error'" class="flex items-center justify-between gap-2 py-2 text-xs text-muted-foreground">
                          <span class="truncate" :title="activeEffortEntry.error">{{ t("ai.effortLoadFailed") }}</span>
                          <button type="button" class="shrink-0 text-primary hover:underline" @click="retryActiveEffort">
                            {{ t("ai.retry") }}
                          </button>
                        </div>
                        <template v-else-if="activeEffortCapability?.kind === 'enum'">
                          <button
                            v-for="option in activeEffortCapability.options"
                            :key="option.id"
                            type="button"
                            class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                            :class="effortSelectionEquals(settings.activeEffort, option.selection) ? 'bg-accent text-accent-foreground' : ''"
                            @click="selectEffortOption(option)"
                          >
                            <span class="flex-1">{{ option.label }}</span>
                            <Check v-if="effortSelectionEquals(settings.activeEffort, option.selection)" class="h-3.5 w-3.5 text-primary" />
                          </button>
                        </template>
                        <template v-else-if="activeEffortCapability?.kind === 'integer'">
                          <button
                            v-for="option in activeEffortCapability.specialValues"
                            :key="option.id"
                            type="button"
                            class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
                            :class="effortSelectionEquals(settings.activeEffort, option.selection) ? 'bg-accent text-accent-foreground' : ''"
                            @click="selectEffortOption(option)"
                          >
                            <span class="flex-1">{{ option.label }}</span>
                            <Check v-if="effortSelectionEquals(settings.activeEffort, option.selection)" class="h-3.5 w-3.5 text-primary" />
                          </button>
                          <div class="flex items-center gap-2 py-1">
                            <input v-model.number="effortIntegerValue" type="range" class="min-w-0 flex-1" :min="activeEffortCapability.min" :max="activeEffortCapability.max" :step="activeEffortCapability.step" @change="commitIntegerEffort(activeEffortCapability)" />
                            <input
                              v-model.number="effortIntegerValue"
                              type="number"
                              class="w-20 rounded-sm border bg-background px-2 py-1 text-xs"
                              :min="activeEffortCapability.min"
                              :max="activeEffortCapability.max"
                              :step="activeEffortCapability.step"
                              @change="commitIntegerEffort(activeEffortCapability)"
                              @click.stop
                            />
                          </div>
                        </template>
                        <template v-else-if="activeEffortCapability?.kind === 'boolean'">
                          <button type="button" class="flex w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-accent" @click="selectEffort({ kind: 'boolean', value: true })">
                            <span class="flex-1 text-left">{{ t("ai.effortEnabled") }}</span>
                            <Check v-if="settings.activeEffort?.kind === 'boolean' && settings.activeEffort.value" class="h-3.5 w-3.5 text-primary" />
                          </button>
                          <button type="button" class="flex w-full items-center rounded-sm px-2 py-1.5 text-xs hover:bg-accent" @click="selectEffort({ kind: 'boolean', value: false })">
                            <span class="flex-1 text-left">{{ t("ai.effortDisabled") }}</span>
                            <Check v-if="settings.activeEffort?.kind === 'boolean' && !settings.activeEffort.value" class="h-3.5 w-3.5 text-primary" />
                          </button>
                        </template>
                        <form v-else-if="activeEffortCapability?.kind === 'freeText'" class="flex items-center gap-1 py-1" @submit.prevent="commitTextEffort">
                          <input
                            v-model="effortTextValue"
                            type="text"
                            maxlength="64"
                            :placeholder="activeEffortCapability.placeholder || t('ai.customEffortPlaceholder')"
                            class="min-w-0 flex-1 rounded-sm border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
                            @click.stop
                            @blur="commitTextEffort"
                          />
                          <Button type="submit" size="sm" class="h-6 px-2 text-[10px]">{{ t("common.confirm") }}</Button>
                        </form>
                        <div v-else-if="activeEffortCapability?.kind === 'unsupported'" class="px-2 py-2 text-xs text-muted-foreground">
                          {{ t("ai.effortUnsupported") }}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </PopoverContent>
              </Popover>
            </template>
            <button v-if="isGenerating" class="h-7 w-7 shrink-0 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center" :title="t('ai.stopGenerating')" @click="cancelStream">
              <Square class="h-3.5 w-3.5" />
            </button>
            <button v-else class="h-7 w-7 shrink-0 rounded-full bg-foreground text-background flex items-center justify-center disabled:opacity-30" :disabled="(!prompt.trim() && !selectedMentions.length && !selectedSqlFileMentions.length) || !props.tab?.database" @click="send">
              <ArrowUp class="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-markdown :deep(h1) {
  font-size: 1em;
  font-weight: 700;
  margin: 0.5em 0 0.25em;
}
.ai-markdown :deep(h2) {
  font-size: 0.95em;
  font-weight: 600;
  margin: 0.5em 0 0.25em;
}
.ai-markdown :deep(h3) {
  font-size: 0.9em;
  font-weight: 600;
  margin: 0.4em 0 0.2em;
}
.ai-markdown :deep(p) {
  margin: 0.3em 0;
}
.ai-markdown :deep(ul),
.ai-markdown :deep(ol) {
  padding-left: 1.4em;
  margin: 0.3em 0;
}
.ai-markdown :deep(ul) {
  list-style-type: disc;
}
.ai-markdown :deep(ol) {
  list-style-type: decimal;
}
.ai-markdown :deep(li) {
  margin: 0.15em 0;
}
.ai-markdown :deep(strong) {
  font-weight: 600;
}
.ai-markdown :deep(a) {
  color: var(--primary);
  text-decoration: underline;
}
.ai-markdown :deep(blockquote) {
  border-left: 2px solid color-mix(in srgb, var(--muted-foreground) 30%, transparent);
  padding-left: 0.75em;
  margin: 0.3em 0;
  color: var(--muted-foreground);
}
.ai-markdown :deep(code) {
  border-radius: 0.25rem;
  background: var(--muted);
  padding: 0.125rem 0.375rem;
  font-size: 11px;
  font-family: ui-monospace, monospace;
}
.ai-markdown :deep(pre) {
  background: var(--muted);
  border-radius: 0.375rem;
  padding: 0.5em 0.75em;
  margin: 0.3em 0;
  overflow-x: auto;
}
.ai-markdown :deep(pre code) {
  background: none;
  padding: 0;
}
.ai-markdown :deep(table) {
  border-collapse: collapse;
  margin: 0;
  width: max-content;
  min-width: 100%;
}
.ai-markdown :deep(.ai-markdown-table-wrap) {
  overflow-x: auto;
  max-height: 320px;
  overflow-y: auto;
  max-width: 100%;
  margin: 0.3em 0;
  border-radius: 0.375rem;
  border: 1px solid var(--border);
}
.ai-markdown :deep(.ai-markdown-table-wrap table) {
  border: none;
  margin: 0;
}
.ai-markdown :deep(th),
.ai-markdown :deep(td) {
  border: 1px solid var(--border);
  padding: 0.25em 0.5em;
  text-align: left;
  white-space: nowrap;
}
.ai-markdown :deep(th) {
  font-weight: 600;
  background: var(--muted);
  position: sticky;
  top: 0;
  z-index: 1;
}
.ai-code-block :deep(.line) {
  min-height: 1lh;
}

.ai-message-scroll :deep([data-slot="scroll-area-viewport"]) {
  overflow-anchor: none;
}

.resize-handle {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  z-index: 1;
  height: 9px;
  cursor: ns-resize;
}

.resize-handle::before {
  content: "";
  position: absolute;
  top: 3px;
  left: 0;
  right: 0;
  height: 1px;
  background-color: var(--border);
  transition: background-color 0.15s ease;
}

.resize-handle:hover::before {
  background-color: color-mix(in srgb, var(--foreground) 20%, transparent);
}
</style>
