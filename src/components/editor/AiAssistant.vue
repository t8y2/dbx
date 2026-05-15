<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { uuid } from "@/lib/utils";
import { useI18n } from "vue-i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import {
  ArrowUp,
  ArrowRightLeft,
  Bot,
  Check,
  ChevronRight,
  Copy,
  Database,
  HelpCircle,
  History,
  Loader2,
  MessageSquarePlus,
  Replace,
  Server,
  Table2,
  Play,
  Square,
  Trash2,
  Wand2,
  Wrench,
  X,
  Zap,
  TestTube,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIconType } from "@/lib/connectionPresentation";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import { buildAiContext, runAiStream, type AiAction } from "@/lib/ai";
import { extractFirstSqlCodeBlock, shouldAttemptAiAutoExecute } from "@/lib/aiSqlExecutionPolicy";
import { Marked } from "marked";
import {
  aiCancelStream,
  saveAiConversation,
  loadAiConversations,
  deleteAiConversation,
  listSchemas,
  listTables,
  type AiConversation,
} from "@/lib/api";
import type { AiMessage } from "@/lib/api";
import type { ConnectionConfig, QueryTab, TableInfo } from "@/types/database";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { resolveDefaultDatabase } from "@/lib/defaultDatabase";
import { isSchemaAware } from "@/lib/databaseCapabilities";
import { formatAiTableMention, parseAiTableMentions, type AiTableMention } from "@/lib/aiTableMentions";

const { t } = useI18n();
const settings = useSettingsStore();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const { toast } = useToast();

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  isThinking?: boolean;
}

const props = defineProps<{
  tab?: QueryTab;
  connection?: ConnectionConfig;
}>();

const emit = defineEmits<{
  replaceSql: [sql: string];
  executeSql: [sql: string];
  requestAutoExecuteSql: [sql: string];
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
const selectedMentions = ref<AiTableMention[]>([]);
let mentionTimer: ReturnType<typeof setTimeout> | undefined;
let mentionRequestId = 0;

const actionButtons: { action: AiAction; icon: any; key: string }[] = [
  { action: "generate", icon: Wand2, key: "ai.actions.generate" },
  { action: "explain", icon: HelpCircle, key: "ai.actions.explain" },
  { action: "optimize", icon: Zap, key: "ai.actions.optimize" },
  { action: "fix", icon: Wrench, key: "ai.actions.fix" },
  { action: "convert", icon: ArrowRightLeft, key: "ai.actions.convert" },
  { action: "sampleData", icon: TestTube, key: "ai.actions.sampleData" },
];

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

const chatTitle = computed(() => {
  const first = messages.value.find((m) => m.role === "user");
  return first ? first.content.slice(0, 30) : t("ai.newChat");
});

const promptMentionChips = computed(() => selectedMentions.value);

const isWaitingForFirstDelta = computed(() => {
  const last = messages.value[messages.value.length - 1];
  return isGenerating.value && last?.role === "assistant" && !last.content && !last.reasoning;
});

const activePlaceholder = computed(
  () => `${t(`ai.placeholders.${activeAction.value}`)} ${t("ai.tableMentionPlaceholderHint")}`,
);
const activeModeHint = computed(() => t(`ai.modeHints.${assistantMode.value}`));

const { databaseOptions: allDbOptions, loadDatabaseOptions } = useDatabaseOptions();

const dbOptions = computed(() => {
  if (!props.connection) return [];
  return allDbOptions.value[props.connection.id] || [];
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
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

function changeDatabase(database: string) {
  const tab = props.tab;
  if (!tab) return;
  queryStore.updateDatabase(tab.id, database);
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
      const filteredSchemas = schemaPrefix
        ? schemas.filter((schema) => schema.toLowerCase().includes(schemaPrefix.toLowerCase()))
        : schemas;
      const results = await Promise.all(
        filteredSchemas.slice(0, 8).map(async (schema) => {
          const tables = await listTables(
            props.tab!.connectionId,
            props.tab!.database,
            schema,
            tableFilter || undefined,
            20,
          );
          return filterMentionCandidates(
            tables.map((table) => mentionCandidateFromTable(table, schema)),
            tableFilter,
            20,
          );
        }),
      );
      candidates = results.flat();
    } else {
      const schema = props.tab.database || props.connection.database || "main";
      const tables = await listTables(props.tab.connectionId, props.tab.database, schema, tableFilter || undefined, 40);
      candidates = filterMentionCandidates(
        tables.map((table) => mentionCandidateFromTable(table)),
        tableFilter,
        40,
      );
    }

    if (requestId !== mentionRequestId) return;
    mentionCache.value[key] = candidates.slice(0, 40);
    mentionCandidates.value = mentionCache.value[key];
    mentionSelectedIndex.value = 0;
  } catch (e: any) {
    if (requestId !== mentionRequestId) return;
    mentionError.value = translateBackendError(t, e?.message || String(e));
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
  if (selectedMentions.value.some((mention) => `${mention.schema || ""}.${mention.table}`.toLowerCase() === key))
    return;
  selectedMentions.value.push({ raw, schema: candidate.schema, table: candidate.name });
}

function formatMentionTableType(tableType: string) {
  const normalized = tableType.toUpperCase().replace(/\s+/g, "_");
  if (normalized.includes("VIEW")) return t("ai.tableMentionTypes.view");
  if (normalized.includes("SYSTEM")) return t("ai.tableMentionTypes.systemTable");
  if (normalized.includes("TEMP")) return t("ai.tableMentionTypes.temporaryTable");
  return t("ai.tableMentionTypes.table");
}

function filterMentionCandidates(
  candidates: AiMentionCandidate[],
  tableFilter: string,
  limit: number,
): AiMentionCandidate[] {
  const normalizedFilter = tableFilter.toLowerCase();
  return candidates
    .filter((candidate) => !normalizedFilter || candidate.name.toLowerCase().includes(normalizedFilter))
    .slice(0, limit);
}

function refreshMentionState() {
  clearTimeout(mentionTimer);
  const mention = activeMentionAtCursor();
  if (!mention || !props.connection || !props.tab?.database || isGenerating.value) {
    mentionOpen.value = false;
    return;
  }

  mentionOpen.value = true;
  mentionStart.value = mention.start;
  mentionTimer = setTimeout(() => {
    loadMentionCandidates(mention.query).catch(() => {});
  }, 120);
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
  if (mentionOpen.value) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      mentionSelectedIndex.value = Math.min(
        mentionSelectedIndex.value + 1,
        Math.max(mentionCandidates.value.length - 1, 0),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      mentionSelectedIndex.value = Math.max(mentionSelectedIndex.value - 1, 0);
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

  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
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
  prompt.value = "";
  selectedMentions.value = [];
  scrollToBottom();

  const requestedAction = activeAction.value;
  const shouldAutoExecute = assistantMode.value === "agent" && shouldAttemptAiAutoExecute(displayText, requestedAction);
  isGenerating.value = true;
  messages.value.push({ role: "assistant", content: "" });
  const assistantIdx = messages.value.length - 1;
  const sessionId = uuid();
  currentSessionId.value = sessionId;
  try {
    const context = await buildAiContext(props.tab, props.connection, {
      mentionedTables,
    });
    const history: AiMessage[] = messages.value.slice(0, -2).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    await runAiStream(
      {
        config: settings.aiConfig,
        action: activeAction.value,
        instruction: displayText,
        context,
      },
      history,
      (delta) => {
        appendAssistantDelta(assistantIdx, delta);
      },
      sessionId,
      (reasoningDelta) => {
        appendAssistantReasoning(assistantIdx, reasoningDelta);
      },
    );
  } catch (e: any) {
    messages.value[assistantIdx].content = `Error: ${e.message || e}`;
  } finally {
    const msg = messages.value[assistantIdx];
    if (msg) msg.isThinking = false;
    isGenerating.value = false;
    if (shouldAutoExecute) {
      const sql = extractFirstSqlCodeBlock(msg?.content || "");
      if (sql) emit("requestAutoExecuteSql", sql);
    }
    activeAction.value = "generate";
    currentSessionId.value = "";
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
  emit("executeSql", code);
}

const copiedIndex = ref("");

async function copyCode(code: string, key: string) {
  await navigator.clipboard.writeText(code);
  copiedIndex.value = key;
  setTimeout(() => {
    if (copiedIndex.value === key) copiedIndex.value = "";
  }, 2000);
}

function clearMessages() {
  messages.value = [];
  conversationId.value = "";
}

async function persistConversation() {
  if (!messages.value.length || !props.connection) return;
  if (!conversationId.value) conversationId.value = uuid();
  const first = messages.value.find((m) => m.role === "user");
  await saveAiConversation({
    id: conversationId.value,
    title: first ? first.content.slice(0, 50) : "Untitled",
    connectionName: props.connection.name,
    database: props.tab?.database || "",
    messages: messages.value.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
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
  }));
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
  conversations.value = await loadAiConversations().catch(() => []);
});

onUnmounted(() => {
  clearTimeout(mentionTimer);
});

function triggerAction(action: AiAction, instruction?: string) {
  activeAction.value = action;
  if (instruction) prompt.value = instruction;
  send();
}

defineExpose({ triggerAction });

interface MessageSegment {
  type: "text" | "code";
  content: string;
  lang?: string;
}

function parseMessage(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const fenceMatch = lines[i].match(/^```(sql|mysql|postgresql|sqlite|tsql|clickhouse)?\s*$/i);
    if (fenceMatch) {
      const lang = (fenceMatch[1] || "sql").toUpperCase();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const content = codeLines.join("\n").trim();
      if (content) segments.push({ type: "code", lang, content });
    } else {
      const textLines: string[] = [];
      while (i < lines.length && !/^```(sql|mysql|postgresql|sqlite|tsql|clickhouse)?\s*$/i.test(lines[i])) {
        textLines.push(lines[i]);
        i++;
      }
      const content = textLines.join("\n");
      if (content.trim()) segments.push({ type: "text", content });
    }
  }

  return segments;
}

const markedInstance = new Marked({
  breaks: true,
  gfm: true,
  renderer: {
    code({ text }: { text: string }) {
      return `<code class="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono">${text}</code>`;
    },
  },
});

function formatInlineText(text: string): string {
  return markedInstance.parse(text) as string;
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div
      class="flex items-center gap-2 border-b px-3 shrink-0"
      :class="settings.editorSettings.appLayout === 'classic' ? 'h-9' : 'h-10'"
    >
      <span class="flex-1 truncate text-xs font-medium">{{ chatTitle }}</span>
      <Button variant="ghost" size="icon" class="h-6 w-6" @click="startNewChat" :title="t('ai.newChat')">
        <MessageSquarePlus class="h-3.5 w-3.5" />
      </Button>
      <Popover :open="showConversationList" @update:open="setConversationListOpen">
        <PopoverTrigger as-child>
          <Button
            variant="ghost"
            size="icon"
            class="h-6 w-6"
            :class="{ 'bg-accent': showConversationList }"
            :title="t('history.title')"
          >
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
            <div
              v-for="conv in conversations"
              :key="conv.id"
              class="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted"
              :class="{ 'bg-muted': conv.id === conversationId }"
              @click="selectConversation(conv)"
            >
              <span class="min-w-0 flex-1 truncate">{{ conv.title }}</span>
              <button
                class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-destructive"
                @click.stop="deleteConversation(conv.id)"
              >
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

    <div
      v-if="messages.length === 0"
      class="flex-1 min-h-0 flex flex-col items-center justify-center text-center text-muted-foreground"
    >
      <Bot class="h-10 w-10 mb-3 opacity-30" />
      <p class="text-sm">{{ t("ai.welcome") }}</p>
    </div>
    <ScrollArea v-else ref="scrollRef" class="min-h-0 flex-1 overflow-hidden">
      <div class="flex flex-col gap-3 p-3">
        <template v-for="(msg, i) in messages" :key="i">
          <div v-if="msg.role === 'user'" class="flex justify-end">
            <div class="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground">
              {{ msg.content }}
            </div>
          </div>

          <div v-else-if="msg.content || msg.reasoning || msg.isThinking" class="flex">
            <div class="max-w-[95%] rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed">
              <div v-if="msg.reasoning || msg.isThinking" class="mb-2">
                <button
                  class="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                  @click="toggleReasoning(i)"
                >
                  <ChevronRight
                    class="h-3 w-3 transition-transform duration-200"
                    :class="{ 'rotate-90': expandedReasoning.has(i) || msg.isThinking }"
                  />
                  <Loader2 v-if="msg.isThinking" class="h-3 w-3 animate-spin" />
                  <span>{{ t("ai.reasoningProcess") }}</span>
                </button>
                <div
                  class="overflow-hidden transition-all duration-200 ease-in-out"
                  :style="{
                    maxHeight: expandedReasoning.has(i) || msg.isThinking ? '2000px' : '0px',
                    opacity: expandedReasoning.has(i) || msg.isThinking ? '1' : '0',
                  }"
                >
                  <div
                    class="mt-1.5 pl-4 border-l-2 border-muted-foreground/20 text-[11px] text-muted-foreground whitespace-pre-wrap"
                  >
                    {{ msg.reasoning }}
                  </div>
                </div>
              </div>
              <template v-for="(seg, j) in parseMessage(msg.content)" :key="j">
                <div v-if="seg.type === 'text'" class="ai-markdown whitespace-normal">
                  <div v-html="formatInlineText(seg.content)" />
                </div>
                <div v-else class="my-2 rounded-md overflow-hidden bg-zinc-900 dark:bg-zinc-900">
                  <div
                    class="flex items-center px-3 py-1.5 text-[10px] text-zinc-400 font-medium border-b border-zinc-700/50"
                  >
                    <Database class="h-3 w-3 mr-1.5" />
                    <span>{{ seg.lang }}</span>
                    <span class="flex-1" />
                    <div class="flex items-center gap-1.5">
                      <button
                        class="rounded p-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                        :title="t('ai.executeSql')"
                        @click="executeSql(seg.content)"
                      >
                        <Play class="h-3.5 w-3.5" />
                      </button>
                      <button
                        class="rounded p-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                        :title="t('ai.apply')"
                        @click="applySql(seg.content)"
                      >
                        <Replace class="h-3.5 w-3.5" />
                      </button>
                      <button
                        class="rounded p-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                        :title="copiedIndex === `${i}-${j}` ? t('ai.copied') : t('ai.copySql')"
                        @click="copyCode(seg.content, `${i}-${j}`)"
                      >
                        <Check v-if="copiedIndex === `${i}-${j}`" class="h-3.5 w-3.5 text-green-400" />
                        <Copy v-else class="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <pre
                    class="whitespace-pre-wrap break-words p-3 text-xs leading-relaxed text-zinc-100"
                  ><code>{{ seg.content }}</code></pre>
                </div>
              </template>
            </div>
          </div>
        </template>

        <div v-if="isWaitingForFirstDelta" class="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 class="h-3.5 w-3.5 animate-spin" />
          <span>{{ t("ai.thinking") }}</span>
        </div>
      </div>
    </ScrollArea>

    <div class="p-2">
      <div class="relative rounded-lg border bg-background px-2 pb-2 pt-1">
        <div v-if="connectionStore.connections.length" class="flex items-center gap-1 mb-1 text-xs text-foreground/80">
          <DatabaseIcon v-if="connection" :db-type="connectionIconType(connection)" class="h-3 w-3 shrink-0" />
          <Server v-else class="h-3 w-3 shrink-0" />
          <Select :model-value="connection?.id || ''" @update:model-value="(v: any) => changeConnection(v)">
            <SelectTrigger
              class="h-5 w-auto border-0 rounded-md bg-transparent dark:bg-transparent p-0 px-1 text-xs text-foreground/80 shadow-none focus:ring-0 focus-visible:ring-0 [&_svg]:size-3"
            >
              <SelectValue :placeholder="t('editor.selectConnection')">{{
                connection?.name || t("editor.selectConnection")
              }}</SelectValue>
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
              :model-value="tab?.database || ''"
              @update:model-value="(v: any) => changeDatabase(v)"
              @update:open="
                (open: boolean) => {
                  if (open) loadDatabases();
                }
              "
            >
              <SelectTrigger
                class="h-5 w-auto border-0 rounded-md bg-transparent dark:bg-transparent p-0 px-1 text-xs text-foreground/80 shadow-none focus:ring-0 focus-visible:ring-0 [&_svg]:size-3"
              >
                <SelectValue :placeholder="t('editor.selectDatabase')">{{
                  tab?.database || t("editor.selectDatabase")
                }}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="db in dbOptions" :key="db" :value="db">{{ db }}</SelectItem>
                <SelectItem v-if="!dbOptions.length && tab?.database" :value="tab.database">{{
                  tab.database
                }}</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </div>
        <div
          v-if="mentionOpen"
          class="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-56 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
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
          <div v-else class="max-h-56 overflow-auto p-1">
            <button
              v-for="(candidate, index) in mentionCandidates"
              :key="`${candidate.schema || ''}.${candidate.name}`"
              type="button"
              class="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
              :class="{ 'bg-muted': index === mentionSelectedIndex }"
              @mousedown.prevent="insertMention(candidate)"
              @mouseenter="mentionSelectedIndex = index"
            >
              <Table2 class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate">
                <template v-if="candidate.schema">{{ candidate.schema }}.</template>{{ candidate.name }}
              </span>
              <span class="shrink-0 text-[10px] text-muted-foreground">{{
                formatMentionTableType(candidate.tableType)
              }}</span>
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
          rows="3"
          class="w-full resize-none bg-transparent text-xs outline-none placeholder:text-muted-foreground mb-1"
          :placeholder="activePlaceholder"
          :disabled="isGenerating"
          @input="refreshMentionState"
          @click="refreshMentionState"
          @keyup="refreshMentionState"
          @keydown="onPromptKeydown"
        />
        <div class="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                :title="activeModeHint"
              >
                <Bot class="h-3 w-3" />
                <span>{{ t(`ai.modes.${assistantMode}`) }}</span>
                <svg
                  class="h-3 w-3 opacity-50"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-40">
              <DropdownMenuItem class="text-xs gap-1.5" :title="t('ai.modeHints.ask')" @click="assistantMode = 'ask'">
                <Check class="h-3 w-3" :class="{ 'opacity-0': assistantMode !== 'ask' }" />
                <span>{{ t("ai.modes.ask") }}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                class="text-xs gap-1.5"
                :title="t('ai.modeHints.agent')"
                @click="assistantMode = 'agent'"
              >
                <Check class="h-3 w-3" :class="{ 'opacity-0': assistantMode !== 'agent' }" />
                <span>{{ t("ai.modes.agent") }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <component :is="actionButtons.find((b) => b.action === activeAction)?.icon" class="h-3 w-3" />
                <span>{{ t(`ai.actions.${activeAction}`) }}</span>
                <svg
                  class="h-3 w-3 opacity-50"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-max min-w-0">
              <DropdownMenuItem
                v-for="btn in actionButtons"
                :key="btn.action"
                class="text-xs gap-1.5"
                @click="selectAction(btn.action)"
              >
                <component :is="btn.icon" class="h-3 w-3" />
                <span>{{ t(btn.key) }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <span class="flex-1" />
          <button
            v-if="isGenerating"
            class="h-7 w-7 shrink-0 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center"
            :title="t('ai.stopGenerating')"
            @click="cancelStream"
          >
            <Square class="h-3.5 w-3.5" />
          </button>
          <button
            v-else
            class="h-7 w-7 shrink-0 rounded-full bg-foreground text-background flex items-center justify-center disabled:opacity-30"
            :disabled="!prompt.trim() || !props.tab?.database"
            @click="send"
          >
            <ArrowUp class="h-4 w-4" />
          </button>
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
  margin: 0.3em 0;
  width: 100%;
}
.ai-markdown :deep(th),
.ai-markdown :deep(td) {
  border: 1px solid hsl(var(--border));
  padding: 0.25em 0.5em;
  text-align: left;
}
.ai-markdown :deep(th) {
  font-weight: 600;
  background: hsl(var(--muted));
}
</style>
