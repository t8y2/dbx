<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import {
  ArrowUp,
  ArrowRightLeft,
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  CircleSlash,
  Copy,
  Database,
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore, AI_PROVIDER_PRESETS, type AiProvider } from "@/stores/settingsStore";
import AiProviderLogo from "@/components/icons/AiProviderLogo.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIconType } from "@/lib/connection/connectionPresentation";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import { buildAiContext, runAgentStream, isVectorDbType, defaultActionForMode, isValidActionForMode, type AiAction, type AiAssistantMode } from "@/lib/ai/ai";
import { formatAiModelOption } from "@/lib/ai/aiModelPresentation";
import type { AgentEvent } from "@/lib/backend/tauri";
import { buildAiAgentPlan } from "@/lib/ai/aiAgentPlan";
import { buildAiAgentStepItems, toolCallStepKey, upsertAgentStep, type AiAgentStepItem, type AiAgentStepTone } from "@/lib/ai/aiAgentStepPresentation";
import { createAiShikiCodeHighlighter, type AiCodeHighlighter } from "@/lib/ai/aiCodeHighlighter";
import { createAiMessageRenderer } from "@/lib/ai/aiMessageRender";
import { formatAiInlineMarkdown, handleAiMarkdownLinkClick } from "@/lib/ai/aiMarkdown";
import { aiCancelStream, aiListModels, saveAiConversation, loadAiConversations, deleteAiConversation, listSchemas, listTables, type AiConversation, type AiModelInfo } from "@/lib/backend/api";
import type { AiMessage } from "@/lib/backend/api";
import type { ConnectionConfig, QueryTab, TableInfo } from "@/types/database";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { decodeSelectableDatabaseValue, encodeSelectableDatabaseValue, formatDatabaseLabel, resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { isSchemaAware } from "@/lib/database/databaseCapabilities";
import ExplainPlanViewer from "@/components/explain/ExplainPlanViewer.vue";
import { parseExplainResult, type ParsedExplainPlan } from "@/lib/diagram/explainPlan";
import { copyToClipboard } from "@/lib/common/clipboard";
import { AI_TABLE_MENTION_CANDIDATE_LIMIT, AI_TABLE_MENTION_SCHEMA_LIMIT, filterAiTableMentionCandidates, formatAiTableMention, parseAiTableMentions, type AiTableMention } from "@/lib/ai/aiTableMentions";
import { isAiPromptImeCompositionEvent, shouldSubmitAiPromptOnKeydown } from "@/lib/ai/aiPromptKeyboard";
import { looksLikeActionProposal, containsChinese } from "@/lib/ai/aiProposalDetect";
import { visibleToActualIndex } from "@/lib/ai/aiMessageEdit";

const { t } = useI18n();
const settings = useSettingsStore();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const { toast } = useToast();
const { isDark } = useTheme();

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  isThinking?: boolean;
  agentSteps?: AiAgentStepItem[];
  /** Hidden system-generated context summary; not rendered in chat UI but included in LLM history. */
  kind?: "contextSummary";
}

const props = defineProps<{
  tab?: QueryTab;
  connection?: ConnectionConfig;
}>();

const emit = defineEmits<{
  replaceSql: [sql: string];
  executeSql: [sql: string];
  requestAutoExecuteSql: [sql: string];
  openExplainPlan: [sql: string];
  close: [];
}>();

const prompt = ref("");
const messages = ref<ChatMessage[]>([]);
const isGenerating = ref(false);
const scrollRef = ref<InstanceType<typeof ScrollArea> | null>(null);
const activeAction = ref<AiAction>("generate");
const assistantMode = ref<"ask" | "agent">("ask");
const currentSessionId = ref("");
const conversationId = ref("");
const conversations = ref<AiConversation[]>([]);
const showConversationList = ref(false);
const promptTextareaRef = ref<HTMLTextAreaElement | null>(null);
const promptCompositionActive = ref(false);
const shikiCodeHighlighter = ref<AiCodeHighlighter>();
const agentTokens = ref<{ input: number; output: number } | null>(null);
const promptHistory = ref<string[]>([]);
const historyIndex = ref(-1);
const draftBeforeHistory = ref("");

const editingMessageIndex = ref<number | null>(null);
const editingContent = ref("");
const editCompositionActive = ref(false);

function startEditMessage(visibleIndex: number) {
  if (isGenerating.value) return;
  editingMessageIndex.value = visibleIndex;
  editingContent.value = visibleMessages.value[visibleIndex].content;
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
}

function submitEdit(visibleIndex: number) {
  const content = editingContent.value.trim();
  if (!content) return;
  const actualIndex = visibleToActualIndex(messages.value, visibleIndex);
  if (actualIndex < 0) return;
  if (!props.connection || !props.tab) return;
  if (!settings.isConfigured()) {
    toast(t("ai.noConfig"));
    return;
  }
  messages.value = messages.value.slice(0, actualIndex);
  editingMessageIndex.value = null;
  editingContent.value = "";
  selectedMentions.value = [];
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
const modelOptions = ref<AiModelInfo[]>([]);
const modelLoading = ref(false);
let modelRequestToken = 0;
const providerSelectorOpen = ref(false);

// Configured providers for quick switching
const configuredProviders = computed(() => (Object.keys(AI_PROVIDER_PRESETS) as AiProvider[]).filter((p) => p !== settings.aiConfig.provider && settings.isAiProviderConfigured(p)));

function handleProviderSwitch(provider: AiProvider) {
  settings.updateAiConfig({ provider });
  modelOptions.value = [];
  providerSelectorOpen.value = false;
}

function normalizeModelOptions(models: AiModelInfo[]): AiModelInfo[] {
  const seen = new Set<string>();
  const normalized: AiModelInfo[] = [];
  for (const model of models) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, displayName: model.displayName?.trim() || undefined });
  }
  return normalized;
}

async function fetchModelOptions() {
  if (modelLoading.value) return;
  if (!settings.isConfigured()) return;
  const token = ++modelRequestToken;
  modelLoading.value = true;
  try {
    const models = normalizeModelOptions(await aiListModels(settings.aiConfig));
    if (token !== modelRequestToken) return;
    modelOptions.value = models;
  } catch {
    if (token !== modelRequestToken) return;
    modelOptions.value = [];
  } finally {
    if (token === modelRequestToken) modelLoading.value = false;
  }
}

function handleModelSelect(modelId: string) {
  settings.updateAiConfig({ model: modelId });
}

const modelOptionIds = computed(() => {
  const currentModel = settings.aiConfig.model;
  const ids = modelOptions.value.map((model) => model.id);
  if (currentModel && !ids.includes(currentModel)) {
    return [currentModel, ...ids];
  }
  return ids;
});

function displayModelName(modelId: string) {
  return modelOptions.value.find((model) => model.id === modelId)?.displayName || modelId;
}

function modelOptionPresentation(modelId: string, label = displayModelName(modelId)) {
  return formatAiModelOption(label, modelId);
}

function modelOptionSecondary(modelId: string, label = displayModelName(modelId)) {
  return modelOptionPresentation(modelId, label).secondary;
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

interface AiMentionCandidate {
  schema?: string;
  name: string;
  tableType: string;
}

const mentionOpen = ref(false);
const mentionLoading = ref(false);
const mentionError = ref("");
const mentionStart = ref(0);
const mentionSelectedIndex = ref(0);
const mentionCandidates = ref<AiMentionCandidate[]>([]);
const mentionCache = ref<Record<string, AiMentionCandidate[]>>({});
const mentionListRef = ref<HTMLElement | null>(null);
const selectedMentions = ref<AiTableMention[]>([]);
let mentionTimer: ReturnType<typeof setTimeout> | undefined;
let mentionRequestId = 0;

interface AiActionButton {
  action: AiAction;
  icon: Component;
  /** i18n key for the menu label. */
  key: string;
}

/** Ask-mode actions: SQL-producing, never auto-run. */
const askActionButtons: AiActionButton[] = [
  { action: "generate", icon: Wand2, key: "ai.actions.generate" },
  { action: "explain", icon: HelpCircle, key: "ai.actions.explain" },
  { action: "optimize", icon: Zap, key: "ai.actions.optimize" },
  { action: "fix", icon: Wrench, key: "ai.actions.fix" },
  { action: "convert", icon: ArrowRightLeft, key: "ai.actions.convert" },
  { action: "sampleData", icon: TestTube, key: "ai.actions.sampleData" },
];

/** Agent-mode actions: task-oriented, drive tool use and real results. */
const agentActionButtons: AiActionButton[] = [
  { action: "query", icon: Search, key: "ai.actions.query" },
  { action: "exploreSchema", icon: Table2, key: "ai.actions.exploreSchema" },
  { action: "executeAndExplain", icon: Play, key: "ai.actions.executeAndExplain" },
  // `generate` is shared with Ask so users can still request SQL-only output without execution.
  { action: "generate", icon: Wand2, key: "ai.actions.generateNoExec" },
];

const actionButtons = computed<AiActionButton[]>(() => (assistantMode.value === "agent" ? agentActionButtons : askActionButtons));

// Vector DBs hide the action menu and only expose collection tools (list_collections /
// browse_collection), never SQL tools. Keep their action at `generate` so the task contract
// doesn't tell the LLM to call execute_query / produce SQL — neither applies to vector stores.
function resolveDefaultAction(mode: AiAssistantMode): AiAction {
  if (props.connection && isVectorDbType(props.connection.db_type)) return "generate";
  return defaultActionForMode(mode);
}

// Switching mode is a deliberate context change: land on that mode's default action so the
// menu and behavior match the new intent (Ask → generate, Agent → query). The shared
// `generate` action is not carried across because its label/semantics differ per mode
// ("生成 SQL" vs "生成但不执行").
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

function selectAction(action: AiAction) {
  activeAction.value = action;
  if (action === "fix" && props.tab?.result) {
    const cols = props.tab.result.columns;
    if (cols.includes("Error")) {
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
    return historyMessages.map((m) => ({ role: m.role, content: m.content }));
  }
  const compactedHistory = historyMessages.slice(latestSummaryIndex);
  const firstMsg = historyMessages[0];
  if (firstMsg && firstMsg.role === "user" && firstMsg.kind !== "contextSummary") {
    return [{ role: "user" as const, content: firstMsg.content }, ...compactedHistory.map((m) => ({ role: m.role, content: m.content }))];
  }
  return compactedHistory.map((m) => ({ role: m.role, content: m.content }));
}

const chatTitle = computed(() => {
  const first = messages.value.find((m) => m.role === "user" && m.kind !== "contextSummary");
  return first ? first.content.slice(0, 30) : t("ai.newChat");
});

const promptMentionChips = computed(() => selectedMentions.value);

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

function sendProposalReply(positive: boolean) {
  // Disable while a stream is in flight or no proposal is currently active.
  if (isGenerating.value) return;
  const target = proposalConfirmMessage.value;
  if (!target) return;
  const isZh = containsChinese(target.content || "");
  const replyZh = positive ? "请执行上面你刚提议的操作，不要再反问确认。" : "不用执行上面提到的操作，继续当前对话。";
  const replyEn = positive ? "Execute the action you just proposed above; do not ask for confirmation again." : "Do not execute the action mentioned above; continue the current conversation.";
  prompt.value = isZh ? replyZh : replyEn;
  // Use the existing send pipeline so the message is added to history, persisted, etc.
  send();
}

const activePlaceholder = computed(() => `${t(`ai.placeholders.${activeAction.value}`)} ${t("ai.tableMentionPlaceholderHint")}`);
const activeModeHint = computed(() => t(`ai.modeHints.${assistantMode.value}`));
const assistantModeItems = computed(() => [
  {
    value: "ask",
    label: t("ai.modes.ask"),
    title: t("ai.modeHints.ask"),
    icon: MessageSquarePlus,
  },
  {
    value: "agent",
    label: t("ai.modes.agent"),
    title: t("ai.modeHints.agent"),
    icon: Bot,
  },
]);
const actionMenuItems = computed(() =>
  actionButtons.value.map((button) => ({
    value: button.action,
    label: t(button.key),
    icon: button.icon,
  })),
);
const aiCodeAppearance = computed(() => (isDark.value ? "dark" : "light"));

const showActionButtons = computed(() => {
  if (!props.connection) return true;
  return !isVectorDbType(props.connection.db_type);
});

const { databaseOptions: allDbOptions, loadDatabaseOptions } = useDatabaseOptions();

const dbOptions = computed(() => {
  if (!props.connection) return [];
  return allDbOptions.value[props.connection.id] || [];
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

const selectedDatabaseSelectValue = computed(() => (props.connection ? encodeSelectableDatabaseValue(props.connection.db_type, props.tab?.database || "") : ""));

const selectedDatabaseLabel = computed(() => {
  if (!props.connection) return t("editor.selectDatabase");
  if (!props.tab) return t("editor.selectDatabase");
  return formatDatabaseLabel(props.connection, props.tab.database || "", {
    defaultDatabase: t("editor.defaultDatabase"),
    noDatabase: t("editor.noDatabase"),
  });
});

async function loadDatabases() {
  if (!props.connection) return;
  await loadDatabaseOptions(props.connection.id);
}

async function changeConnection(connectionId: string) {
  const conn = connectionStore.getConfig(connectionId);
  if (!conn) return;
  connectionStore.activeConnectionId = connectionId;
  const tab = props.tab;
  if (tab) {
    queryStore.updateConnection(tab.id, connectionId, resolveDefaultDatabase(conn, []));
  } else {
    queryStore.createTab(connectionId, resolveDefaultDatabase(conn, []));
  }
  try {
    await loadDatabaseOptions(connectionId);
    const database = resolveDefaultDatabase(conn, allDbOptions.value[connectionId] || []);
    if (tab) {
      queryStore.updateDatabase(tab.id, database);
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    toast(t("connection.connectFailed", { message: translateBackendError(t, message) }), 5000);
  }
}

function changeDatabase(value: string) {
  const tab = props.tab;
  const connection = props.connection;
  if (!tab || !connection) return;
  queryStore.updateDatabase(tab.id, decodeSelectableDatabaseValue(connection.db_type, value));
}

function appendAssistantDelta(assistantIdx: number, delta: string) {
  const msg = messages.value[assistantIdx];
  if (msg.isThinking) msg.isThinking = false;
  msg.content += delta;
  scrollToBottom();
}

function appendAssistantReasoning(assistantIdx: number, delta: string) {
  const msg = messages.value[assistantIdx];
  if (!msg.reasoning) msg.reasoning = "";
  msg.reasoning += delta;
  msg.isThinking = true;
  scrollToBottom();
}

const expandedReasoning = ref<Set<number>>(new Set());
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

function toggleReasoning(index: number) {
  const next = new Set(expandedReasoning.value);
  if (next.has(index)) {
    next.delete(index);
  } else {
    next.add(index);
  }
  expandedReasoning.value = next;
}

function scrollToBottom() {
  nextTick(() => {
    const root = scrollRef.value?.$el as HTMLElement | undefined;
    const el = root?.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  });
}

function mentionCacheKey(connectionId: string, database: string, query: string) {
  return `${connectionId}:${database}:${query.toLowerCase()}`;
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

  try {
    await connectionStore.ensureConnected(props.tab.connectionId);
    let candidates: AiMentionCandidate[] = [];
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
      candidates = filterAiTableMentionCandidates(results.flat(), "", AI_TABLE_MENTION_CANDIDATE_LIMIT);
    } else {
      const schema = props.tab.database || props.connection.database || "main";
      const tables = await listTables(props.tab.connectionId, props.tab.database, schema, tableFilter || undefined, AI_TABLE_MENTION_CANDIDATE_LIMIT);
      candidates = filterAiTableMentionCandidates(
        tables.map((table) => mentionCandidateFromTable(table)),
        tableFilter,
        AI_TABLE_MENTION_CANDIDATE_LIMIT,
      );
    }

    if (requestId !== mentionRequestId) return;
    mentionCache.value[key] = candidates.slice(0, AI_TABLE_MENTION_CANDIDATE_LIMIT);
    mentionCandidates.value = mentionCache.value[key];
    setMentionSelectedIndex(0);
  } catch (e: unknown) {
    if (requestId !== mentionRequestId) return;
    const message = e instanceof Error ? e.message : String(e);
    mentionError.value = translateBackendError(t, message);
    mentionCandidates.value = [];
  } finally {
    if (requestId === mentionRequestId) mentionLoading.value = false;
  }
}

function mentionCandidateFromTable(table: TableInfo, schema?: string): AiMentionCandidate {
  return { schema, name: table.name, tableType: table.table_type };
}

function mentionDisplayName(mention: AiTableMention) {
  return [mention.schema, mention.table].filter(Boolean).join(".");
}

function removeMentionChip(mention: AiTableMention) {
  selectedMentions.value = selectedMentions.value.filter((item) => item.raw !== mention.raw);
  nextTick(() => promptTextareaRef.value?.focus());
}

function addSelectedMention(candidate: AiMentionCandidate) {
  const raw = formatAiTableMention(candidate.schema, candidate.name);
  const key = `${candidate.schema || ""}.${candidate.name}`.toLowerCase();
  if (selectedMentions.value.some((mention) => `${mention.schema || ""}.${mention.table}`.toLowerCase() === key)) return;
  selectedMentions.value.push({ raw, schema: candidate.schema, table: candidate.name });
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

async function send() {
  const text = prompt.value.trim();
  if ((!text && !selectedMentions.value.length) || isGenerating.value) return;

  if (!props.connection || !props.tab) return;
  if (!settings.isConfigured()) {
    toast(t("ai.noConfig"));
    return;
  }

  const mentionedTables = [...selectedMentions.value, ...parseAiTableMentions(text)];
  const displayText = [selectedMentions.value.map((mention) => mention.raw).join(" "), text].filter(Boolean).join(" ");

  messages.value.push({ role: "user", content: displayText });
  // Save to prompt history (deduplicate consecutive duplicates)
  if (displayText && promptHistory.value[0] !== displayText) {
    promptHistory.value.unshift(displayText);
    if (promptHistory.value.length > 100) promptHistory.value.length = 100;
  }
  historyIndex.value = -1;
  draftBeforeHistory.value = "";
  prompt.value = "";
  selectedMentions.value = [];
  scrollToBottom();

  const requestedAction = activeAction.value;
  const requestedMode = assistantMode.value;
  isGenerating.value = true;
  messages.value.push({ role: "assistant", content: "" });
  const assistantIdx = messages.value.length - 1;
  const sessionId = uuid();
  currentSessionId.value = sessionId;
  const agentEvents: AgentEvent[] = [];
  agentTokens.value = null;
  try {
    const context = await buildAiContext(props.tab, props.connection, {
      mentionedTables,
    });
    const history: AiMessage[] = messagesForAgentHistory(messages.value.slice(0, -2));
    await runAgentStream(
      {
        config: settings.aiConfig,
        action: activeAction.value,
        mode: requestedMode,
        instruction: displayText,
        context,
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
            agentTokens.value = { input: event.input_tokens ?? 0, output: event.output_tokens ?? 0 };
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
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    messages.value[assistantIdx].content = `Error: ${message}`;
  } finally {
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
        instruction: displayText,
        assistantContent: msg?.content || "",
        connection: props.connection,
      });
      if (msg && requestedMode === "agent") msg.agentSteps = buildAiAgentStepItems(agentPlan);
      if (agentPlan.handoffSql) emit("requestAutoExecuteSql", agentPlan.handoffSql);
    }
    activeAction.value = resolveDefaultAction(assistantMode.value);
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
  emit("replaceSql", code);
}

function executeSql(code: string) {
  emit("replaceSql", code);
  emit("executeSql", code);
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

function clearMessages() {
  messages.value = [];
  conversationId.value = "";
  historyIndex.value = -1;
  draftBeforeHistory.value = "";
}

async function persistConversation() {
  if (!messages.value.length || !props.connection) return;
  if (!conversationId.value) conversationId.value = uuid();
  const first = messages.value.find((m) => m.role === "user" && m.kind !== "contextSummary");
  await saveAiConversation({
    id: conversationId.value,
    title: first ? first.content.slice(0, 50) : "Untitled",
    connectionName: props.connection.name,
    database: props.tab?.database || "",
    messages: messages.value.map((m) => ({
      role: m.role,
      content: m.content,
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
  messages.value = conv.messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
    reasoning: m.reasoning,
    kind: m.kind,
  }));
  agentTokens.value = null;
  pendingCompaction.value = null;
  showConversationList.value = false;
  scrollToBottom();
}

async function deleteConversation(id: string) {
  await deleteAiConversation(id).catch(() => {});
  conversations.value = conversations.value.filter((c) => c.id !== id);
  if (conversationId.value === id) clearMessages();
}

function startNewChat() {
  clearMessages();
  showConversationList.value = false;
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

  // Load available AI models for inline selector
  fetchModelOptions();

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
  clearTimeout(mentionTimer);
  cancelStream();
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

defineExpose({ triggerAction });

const messageRenderer = computed(() => {
  const appearance = aiCodeAppearance.value;
  const highlightCode = shikiCodeHighlighter.value;
  return createAiMessageRenderer({
    markdown: formatAiInlineMarkdown,
    highlightCode: highlightCode ? (content, lang) => highlightCode(content, lang, appearance) : undefined,
  });
});

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
    <ScrollArea v-else ref="scrollRef" class="min-h-0 flex-1 overflow-hidden">
      <div class="flex flex-col gap-3 p-3">
        <template v-for="(msg, i) in visibleMessages" :key="i">
          <div v-if="msg.role === 'user'" class="group flex justify-end">
            <div class="max-w-[85%]">
              <template v-if="editingMessageIndex === i">
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
                <div class="flex items-start gap-1">
                  <button v-if="!isGenerating" class="mt-1 hidden h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground group-hover:flex" :title="t('ai.editMessage')" @click="startEditMessage(i)">
                    <Pencil class="h-3 w-3" />
                  </button>
                  <div class="whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground">
                    {{ msg.content }}
                  </div>
                </div>
              </template>
            </div>
          </div>

          <div v-else-if="msg.content || msg.reasoning || msg.isThinking" class="flex">
            <div class="max-w-[95%] min-w-0 rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed">
              <div v-if="msg.reasoning || msg.isThinking" class="mb-2">
                <button class="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors" @click="toggleReasoning(i)">
                  <ChevronRight class="h-3 w-3 transition-transform duration-200" :class="{ 'rotate-90': expandedReasoning.has(i) || msg.isThinking }" />
                  <Loader2 v-if="msg.isThinking" class="h-3 w-3 animate-spin" />
                  <span>{{ t("ai.reasoningProcess") }}</span>
                </button>
                <div
                  class="overflow-hidden transition-[max-height,opacity] duration-200 ease-in-out"
                  :style="{
                    maxHeight: expandedReasoning.has(i) || msg.isThinking ? '20000px' : '0px',
                    opacity: expandedReasoning.has(i) || msg.isThinking ? '1' : '0',
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
              <template v-for="(seg, j) in messageRenderer.render(msg.content)" :key="j">
                <div v-if="seg.type === 'text'" class="ai-markdown whitespace-normal" @click.capture="onMarkdownClick">
                  <div v-html="seg.html" />
                </div>
                <div v-else class="my-2 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-700/50 dark:bg-zinc-900">
                  <div class="flex items-center border-b border-zinc-200 px-3 py-1.5 text-[10px] font-medium text-zinc-600 dark:border-zinc-700/50 dark:text-zinc-400">
                    <component :is="seg.isSql ? Database : Terminal" class="h-3 w-3 mr-1.5" />
                    <span>{{ seg.lang }}</span>
                    <span class="flex-1" />
                    <div class="flex items-center gap-1.5">
                      <button v-if="seg.isSql" class="rounded p-0.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200" :title="t('ai.executeSql')" @click="executeSql(seg.content)">
                        <Play class="h-3.5 w-3.5" />
                      </button>
                      <button v-if="seg.isSql" class="rounded p-0.5 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200" :title="t('ai.apply')" @click="applySql(seg.content)">
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
          </div>
        </template>

        <div v-if="isWaitingForFirstDelta" class="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 class="h-3.5 w-3.5 animate-spin" />
          <span>{{ t("ai.thinking") }}</span>
        </div>
        <div v-if="agentTokens && !isGenerating" class="flex items-center gap-1 text-[10px] text-muted-foreground px-2 pb-1">
          <span>&#8593;{{ agentTokens.input.toLocaleString() }} &#8595;{{ agentTokens.output.toLocaleString() }} tokens</span>
        </div>
      </div>
    </ScrollArea>

    <div class="p-2">
      <div ref="promptPanelRef" class="relative rounded-[6px] border bg-background">
        <div class="resize-handle" @mousedown="startResize"></div>
        <div class="px-2 pb-2 pt-1">
          <div v-if="connectionStore.connections.length" class="flex items-center gap-1 mb-1 text-xs text-foreground/80">
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
                    if (typeof v === 'string') changeDatabase(v);
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
                :key="`${candidate.schema || ''}.${candidate.name}`"
                type="button"
                :data-mention-index="index"
                class="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
                :class="{ 'bg-muted': index === mentionSelectedIndex }"
                @mousedown.prevent="insertMention(candidate)"
                @mouseenter="setMentionSelectedIndex(index, false)"
              >
                <Table2 class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate">
                  <template v-if="candidate.schema">{{ candidate.schema }}.</template>{{ candidate.name }}
                </span>
                <span class="shrink-0 text-[10px] text-muted-foreground">{{ formatMentionTableType(candidate.tableType) }}</span>
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
              <Table2 class="h-3 w-3 shrink-0 text-primary" />
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
            <LightDropdown
              v-model="assistantMode"
              :items="assistantModeItems"
              :aria-label="activeModeHint"
              trigger-class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[6px] border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              item-class="text-xs px-2"
            />
            <LightDropdown
              v-if="showActionButtons"
              :model-value="activeAction"
              :items="actionMenuItems"
              content-class="w-max min-w-0"
              trigger-class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[6px] border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              item-class="text-xs px-2"
              @update:model-value="(value) => selectAction(value as AiAction)"
            />
            <span class="min-w-0 flex-1" />
            <template v-if="settings.isConfigured()">
              <!-- Combined provider + model selector -->
              <Popover v-model:open="providerSelectorOpen">
                <PopoverTrigger as-child>
                  <button type="button" class="min-w-0 flex shrink items-center gap-1.5 max-w-[220px] rounded-[6px] border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
                    <AiProviderLogo :provider="settings.aiConfig.provider" :label="AI_PROVIDER_PRESETS[settings.aiConfig.provider]?.label ?? settings.aiConfig.provider" :icon-slug="AI_PROVIDER_PRESETS[settings.aiConfig.provider]?.iconSlug" class="h-3 w-3 shrink-0" />
                    <span class="min-w-0 truncate">{{ modelLoading ? t("ai.loadingModels") : settings.aiConfig.model }}</span>
                    <svg class="h-3 w-3 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" class="w-72 gap-0 p-1.5" @open-auto-focus.prevent>
                  <!-- Configured providers section -->
                  <template v-if="configuredProviders.length">
                    <p class="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{{ t("ai.switchProvider") }}</p>
                    <button v-for="p in configuredProviders" :key="p" type="button" class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground" @click="handleProviderSwitch(p)">
                      <AiProviderLogo :provider="p" :label="AI_PROVIDER_PRESETS[p]?.label ?? p" :icon-slug="AI_PROVIDER_PRESETS[p]?.iconSlug" class="h-3.5 w-3.5 shrink-0" />
                      <span class="font-medium">{{ AI_PROVIDER_PRESETS[p]?.label ?? p }}</span>
                      <span class="ml-auto min-w-0 truncate text-[11px] text-muted-foreground">{{ settings.aiProviderConfigs[p]?.model }}</span>
                    </button>
                    <div class="my-1 border-t" />
                  </template>
                  <!-- Model list for current provider -->
                  <p class="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {{ AI_PROVIDER_PRESETS[settings.aiConfig.provider]?.label ?? settings.aiConfig.provider }}
                  </p>
                  <SearchableSelect
                    :model-value="settings.aiConfig.model"
                    :options="modelOptionIds"
                    :placeholder="t('ai.browseModels')"
                    :search-placeholder="t('ai.searchModels')"
                    :empty-text="t('ai.modelListHint')"
                    :loading-text="t('ai.loadingModels')"
                    :loading="modelLoading"
                    :display-name="displayModelName"
                    trigger-class="w-full max-w-full justify-start rounded-sm px-2 py-1.5 text-xs text-foreground hover:bg-accent"
                    content-class="w-72"
                    item-class="h-auto min-h-8 px-2 py-1.5 text-xs"
                    @update:model-value="handleModelSelect"
                    @update:open="(open: boolean) => open && fetchModelOptions()"
                  >
                    <template #trigger-label="{ label, loading }">
                      <AiProviderLogo :provider="settings.aiConfig.provider" :label="AI_PROVIDER_PRESETS[settings.aiConfig.provider]?.label ?? settings.aiConfig.provider" :icon-slug="AI_PROVIDER_PRESETS[settings.aiConfig.provider]?.iconSlug" class="h-3.5 w-3.5 shrink-0" />
                      <span class="min-w-0 truncate">{{ loading ? t("ai.loadingModels") : label }}</span>
                    </template>
                    <template #option-label="{ option, label }">
                      <span class="flex min-w-0 flex-col leading-tight">
                        <span class="truncate">{{ modelOptionPresentation(option, label).primary }}</span>
                        <span v-if="modelOptionSecondary(option, label)" class="mt-0.5 truncate text-[11px] text-muted-foreground">{{ modelOptionSecondary(option, label) }}</span>
                      </span>
                    </template>
                  </SearchableSelect>
                </PopoverContent>
              </Popover>
            </template>
            <button v-if="isGenerating" class="h-7 w-7 shrink-0 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center" :title="t('ai.stopGenerating')" @click="cancelStream">
              <Square class="h-3.5 w-3.5" />
            </button>
            <button v-else class="h-7 w-7 shrink-0 rounded-full bg-foreground text-background flex items-center justify-center disabled:opacity-30" :disabled="!prompt.trim() || !props.tab?.database" @click="send">
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
  color: hsl(var(--primary));
  text-decoration: underline;
}
.ai-markdown :deep(blockquote) {
  border-left: 2px solid hsl(var(--muted-foreground) / 0.3);
  padding-left: 0.75em;
  margin: 0.3em 0;
  color: hsl(var(--muted-foreground));
}
.ai-markdown :deep(code) {
  border-radius: 0.25rem;
  background: hsl(var(--muted));
  padding: 0.125rem 0.375rem;
  font-size: 11px;
  font-family: ui-monospace, monospace;
}
.ai-markdown :deep(pre) {
  background: hsl(var(--muted));
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
  border: 1px solid hsl(var(--border));
}
.ai-markdown :deep(.ai-markdown-table-wrap table) {
  border: none;
  margin: 0;
}
.ai-markdown :deep(th),
.ai-markdown :deep(td) {
  border: 1px solid hsl(var(--border));
  padding: 0.25em 0.5em;
  text-align: left;
  white-space: nowrap;
}
.ai-markdown :deep(th) {
  font-weight: 600;
  background: hsl(var(--muted));
  position: sticky;
  top: 0;
  z-index: 1;
}
.ai-code-block :deep(.line) {
  min-height: 1lh;
}

.resize-handle {
  height: 4px;
  width: 100%;
  cursor: ns-resize;
  background-color: hsl(var(--border));
  transition: background-color 0.15s ease;
}

.resize-handle:hover {
  background-color: hsl(var(--foreground) / 0.2);
}
</style>
