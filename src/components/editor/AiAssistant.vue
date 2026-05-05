<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  ArrowUp, ArrowRightLeft, Bot, Check, ChevronRight, Copy, Database, HelpCircle, History,
  Loader2, MessageSquarePlus, Replace, Server, Settings, Play, Square, Trash2,
  Wand2, Wrench, X, Zap, TestTube,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSettingsStore, type AiProvider, type AiApiStyle } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIconType } from "@/lib/connectionPresentation";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { useQueryStore } from "@/stores/queryStore";
import { buildAiContext, runAiStream, type AiAction } from "@/lib/ai";
import {
  aiTestConnection, aiCancelStream,
  saveAiConversation, loadAiConversations, deleteAiConversation, type AiConversation,
} from "@/lib/api";
import type { AiMessage } from "@/lib/api";
import type { ConnectionConfig, QueryTab } from "@/types/database";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";

const { t } = useI18n();
const settings = useSettingsStore();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();

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
  close: [];
}>();

const prompt = ref("");
const messages = ref<ChatMessage[]>([]);
const isGenerating = ref(false);
const showSettings = ref(false);
const scrollRef = ref<InstanceType<typeof ScrollArea> | null>(null);
const activeAction = ref<AiAction>("generate");
const currentSessionId = ref("");
const conversationId = ref("");
const conversations = ref<AiConversation[]>([]);
const showConversationList = ref(false);

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

const isWaitingForFirstDelta = computed(() => {
  const last = messages.value[messages.value.length - 1];
  return isGenerating.value && last?.role === "assistant" && !last.content && !last.reasoning;
});

const activePlaceholder = computed(() => t(`ai.placeholders.${activeAction.value}`));


const { databaseOptions: allDbOptions, loadDatabaseOptions } = useDatabaseOptions();

const dbOptions = computed(() => {
  if (!props.connection) return [];
  return allDbOptions.value[props.connection.id] || [];
});

async function loadDatabases() {
  if (!props.connection) return;
  await loadDatabaseOptions(props.connection.id);
}

function changeConnection(connectionId: string) {
  const conn = connectionStore.getConfig(connectionId);
  if (!conn) return;
  connectionStore.activeConnectionId = connectionId;
  const tab = props.tab;
  if (tab) {
    queryStore.updateConnection(tab.id, connectionId, conn.database || "");
  } else {
    queryStore.createTab(connectionId, conn.database || "");
  }
}

function changeDatabase(database: string) {
  const tab = props.tab;
  if (!tab) return;
  queryStore.updateDatabase(tab.id, database);
}

const tempProvider = ref<AiProvider>(settings.aiConfig.provider);
const tempApiKey = ref(settings.aiConfig.apiKey);
const tempEndpoint = ref(settings.aiConfig.endpoint);
const tempModel = ref(settings.aiConfig.model);
const tempApiStyle = ref<AiApiStyle>(settings.aiConfig.apiStyle || "completions");

const providerDefaults: Record<AiProvider, { endpoint: string; model: string }> = {
  claude: { endpoint: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-20250514" },
  openai: { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o" },
  custom: { endpoint: "", model: "" },
};

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

function openSettings() {
  tempProvider.value = settings.aiConfig.provider;
  tempApiKey.value = settings.aiConfig.apiKey;
  tempEndpoint.value = settings.aiConfig.endpoint;
  tempModel.value = settings.aiConfig.model;
  tempApiStyle.value = settings.aiConfig.apiStyle || "completions";
  showSettings.value = true;
}

function saveSettings() {
  settings.updateAiConfig({
    provider: tempProvider.value,
    apiKey: tempApiKey.value,
    endpoint: tempEndpoint.value,
    model: tempModel.value,
    apiStyle: tempApiStyle.value,
  });
  showSettings.value = false;
}

const testingAi = ref(false);
const testResult = ref<"" | "success" | "error">("");
const testError = ref("");

async function testAiConnection() {
  testingAi.value = true;
  testResult.value = "";
  testError.value = "";
  try {
    await aiTestConnection({
      provider: tempProvider.value,
      apiKey: tempApiKey.value,
      endpoint: tempEndpoint.value,
      model: tempModel.value,
      apiStyle: tempApiStyle.value,
    });
    testResult.value = "success";
  } catch (e: any) {
    testResult.value = "error";
    testError.value = e?.message || String(e);
  } finally {
    testingAi.value = false;
  }
}

function selectProvider(provider: AiProvider) {
  tempProvider.value = provider;
  tempEndpoint.value = providerDefaults[provider].endpoint;
  tempModel.value = providerDefaults[provider].model;
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

async function send() {
  const text = prompt.value.trim();
  if (!text || isGenerating.value) return;

  if (!props.connection || !props.tab) return;
  if (!settings.isConfigured()) {
    openSettings();
    return;
  }

  messages.value.push({ role: "user", content: text });
  prompt.value = "";
  scrollToBottom();

  isGenerating.value = true;
  messages.value.push({ role: "assistant", content: "" });
  const assistantIdx = messages.value.length - 1;
  const sessionId = crypto.randomUUID();
  currentSessionId.value = sessionId;
  try {
    const context = await buildAiContext(props.tab, props.connection);
    const history: AiMessage[] = messages.value.slice(0, -2).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    await runAiStream({
      config: settings.aiConfig,
      action: activeAction.value,
      instruction: text,
      context,
    }, history, (delta) => {
      appendAssistantDelta(assistantIdx, delta);
    }, sessionId, (reasoningDelta) => {
      appendAssistantReasoning(assistantIdx, reasoningDelta);
    });
  } catch (e: any) {
    messages.value[assistantIdx].content = `Error: ${e.message || e}`;
  } finally {
    const msg = messages.value[assistantIdx];
    if (msg) msg.isThinking = false;
    isGenerating.value = false;
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
  setTimeout(() => { if (copiedIndex.value === key) copiedIndex.value = ""; }, 2000);
}

function clearMessages() {
  messages.value = [];
  conversationId.value = "";
}

async function persistConversation() {
  if (!messages.value.length || !props.connection) return;
  if (!conversationId.value) conversationId.value = crypto.randomUUID();
  const first = messages.value.find((m) => m.role === "user");
  await saveAiConversation({
    id: conversationId.value,
    title: first ? first.content.slice(0, 50) : "Untitled",
    connectionName: props.connection.name,
    database: props.tab?.database || "",
    messages: messages.value.map((m) => ({ role: m.role, content: m.content, ...(m.reasoning ? { reasoning: m.reasoning } : {}) })),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).catch(() => {});
}

async function loadConversationList() {
  conversations.value = await loadAiConversations().catch(() => []);
  showConversationList.value = true;
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

function formatInlineText(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono">$1</code>')
    .replace(/\n/g, "<br>");
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="h-9 flex items-center gap-2 border-b px-3 shrink-0">
      <span class="flex-1 truncate text-xs font-medium">{{ chatTitle }}</span>
      <Button variant="ghost" size="icon" class="h-6 w-6" @click="startNewChat" :title="t('ai.newChat')">
        <MessageSquarePlus class="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" class="h-6 w-6" :class="{ 'bg-accent': showConversationList }" @click="loadConversationList" :title="t('history.title')">
        <History class="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" class="h-6 w-6" @click="clearMessages" :title="t('ai.clear')">
        <Trash2 class="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" class="h-6 w-6" @click="openSettings">
        <Settings class="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" class="h-6 w-6" @click="emit('close')">
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>

    <div v-if="showConversationList" class="border-b max-h-48 overflow-auto">
      <div v-if="!conversations.length" class="p-3 text-xs text-muted-foreground text-center">
        {{ t('history.empty') }}
      </div>
      <div
        v-for="conv in conversations"
        :key="conv.id"
        class="flex items-center gap-2 px-3 py-1.5 hover:bg-muted cursor-pointer text-xs"
        :class="{ 'bg-muted': conv.id === conversationId }"
        @click="selectConversation(conv)"
      >
        <span class="flex-1 truncate">{{ conv.title }}</span>
        <button class="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive" @click.stop="deleteConversation(conv.id)">
          <X class="h-3 w-3" />
        </button>
      </div>
    </div>

    <div v-if="messages.length === 0" class="flex-1 min-h-0 flex flex-col items-center justify-center text-center text-muted-foreground">
      <Bot class="h-10 w-10 mb-3 opacity-30" />
      <p class="text-sm">{{ t('ai.welcome') }}</p>
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
                  <span>{{ t('ai.reasoningProcess') }}</span>
                </button>
                <div
                  class="overflow-hidden transition-all duration-200 ease-in-out"
                  :style="{
                    maxHeight: (expandedReasoning.has(i) || msg.isThinking) ? '2000px' : '0px',
                    opacity: (expandedReasoning.has(i) || msg.isThinking) ? '1' : '0',
                  }"
                >
                  <div class="mt-1.5 pl-4 border-l-2 border-muted-foreground/20 text-[11px] text-muted-foreground whitespace-pre-wrap">{{ msg.reasoning }}</div>
                </div>
              </div>
              <template v-for="(seg, j) in parseMessage(msg.content)" :key="j">
                <div v-if="seg.type === 'text'" class="whitespace-normal">
                  <span v-html="formatInlineText(seg.content)" />
                </div>
                <div v-else class="my-2 rounded-md overflow-hidden bg-zinc-900 dark:bg-zinc-900">
                  <div class="flex items-center px-3 py-1.5 text-[10px] text-zinc-400 font-medium border-b border-zinc-700/50">
                    <Database class="h-3 w-3 mr-1.5" />
                    <span>{{ seg.lang }}</span>
                    <span class="flex-1" />
                    <div class="flex items-center gap-1.5">
                      <button class="rounded p-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200" :title="t('ai.executeSql')" @click="executeSql(seg.content)">
                        <Play class="h-3.5 w-3.5" />
                      </button>
                      <button class="rounded p-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200" :title="t('ai.apply')" @click="applySql(seg.content)">
                        <Replace class="h-3.5 w-3.5" />
                      </button>
                      <button class="rounded p-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200" :title="copiedIndex === `${i}-${j}` ? t('ai.copied') : t('ai.copySql')" @click="copyCode(seg.content, `${i}-${j}`)">
                        <Check v-if="copiedIndex === `${i}-${j}`" class="h-3.5 w-3.5 text-green-400" />
                        <Copy v-else class="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <pre class="whitespace-pre-wrap break-words p-3 text-xs leading-relaxed text-zinc-100"><code>{{ seg.content }}</code></pre>
                </div>
              </template>
            </div>
          </div>
        </template>

        <div v-if="isWaitingForFirstDelta" class="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 class="h-3.5 w-3.5 animate-spin" />
          <span>{{ t('ai.thinking') }}</span>
        </div>
      </div>
    </ScrollArea>

    <div class="p-2">
      <div class="rounded-lg border bg-background px-2 pb-2 pt-1">
        <div v-if="connectionStore.connections.length" class="flex items-center gap-1 mb-1 text-xs text-foreground/80">
          <DatabaseIcon v-if="connection" :db-type="connectionIconType(connection)" class="h-3 w-3 shrink-0" />
          <Server v-else class="h-3 w-3 shrink-0" />
          <Select :model-value="connection?.id || ''" @update:model-value="(v: any) => changeConnection(v)">
            <SelectTrigger class="h-5 w-auto border-0 rounded-none bg-transparent p-0 text-xs text-foreground/80 shadow-none focus:ring-0 focus-visible:ring-0 [&_svg]:size-3">
              <SelectValue :placeholder="t('editor.selectConnection')">{{ connection?.name || t('editor.selectConnection') }}</SelectValue>
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
            <Select :model-value="tab?.database || ''" @update:model-value="(v: any) => changeDatabase(v)" @update:open="(open: boolean) => { if (open) loadDatabases() }">
              <SelectTrigger class="h-5 w-auto border-0 rounded-none bg-transparent p-0 text-xs text-foreground/80 shadow-none focus:ring-0 focus-visible:ring-0 [&_svg]:size-3">
                <SelectValue :placeholder="t('editor.selectDatabase')">{{ tab?.database || t('editor.selectDatabase') }}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="db in dbOptions" :key="db" :value="db">{{ db }}</SelectItem>
                <SelectItem v-if="!dbOptions.length && tab?.database" :value="tab.database">{{ tab.database }}</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </div>
        <textarea
          v-model="prompt"
          rows="3"
          class="w-full resize-none bg-transparent text-xs outline-none placeholder:text-muted-foreground mb-1"
          :placeholder="activePlaceholder"
          :disabled="isGenerating"
          @keydown.enter.exact="send"
        />
        <div class="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
                <component :is="actionButtons.find(b => b.action === activeAction)?.icon" class="h-3 w-3" />
                <span>{{ t(`ai.actions.${activeAction}`) }}</span>
                <svg class="h-3 w-3 opacity-50" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-max min-w-0">
              <DropdownMenuItem v-for="btn in actionButtons" :key="btn.action" class="text-xs gap-1.5" @click="selectAction(btn.action)">
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

  <Dialog v-model:open="showSettings">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ t('ai.settings') }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3 py-2">
        <div class="grid grid-cols-3 items-center gap-3">
          <Label class="text-right text-xs">{{ t('ai.provider') }}</Label>
          <Select :model-value="tempProvider" @update:model-value="(v: any) => selectProvider(v)">
            <SelectTrigger class="col-span-2 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="claude">Claude</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid grid-cols-3 items-center gap-3">
          <Label class="text-right text-xs">API Key</Label>
          <Input v-model="tempApiKey" type="password" autocomplete="off" class="col-span-2 h-8 text-xs" />
        </div>
        <div class="grid grid-cols-3 items-center gap-3">
          <Label class="text-right text-xs">Endpoint</Label>
          <Input v-model="tempEndpoint" placeholder="https://api.openai.com/v1" autocomplete="off" class="col-span-2 h-8 text-xs" />
        </div>
        <div class="grid grid-cols-3 items-center gap-3">
          <Label class="text-right text-xs">Model</Label>
          <Input v-model="tempModel" autocomplete="off" class="col-span-2 h-8 text-xs" />
        </div>
        <div v-if="tempProvider !== 'claude'" class="grid grid-cols-3 items-center gap-3">
          <Label class="text-right text-xs">API</Label>
          <div class="col-span-2 flex gap-2">
            <Button size="sm" variant="outline" class="h-8 flex-1 text-xs" :class="{ 'border-blue-300 border-2 ring-2 ring-blue-300/50': tempApiStyle === 'completions' }" @click="tempApiStyle = 'completions'">/chat/completions</Button>
            <Button size="sm" variant="outline" class="h-8 flex-1 text-xs" :class="{ 'border-blue-300 border-2 ring-2 ring-blue-300/50': tempApiStyle === 'responses' }" @click="tempApiStyle = 'responses'">/responses</Button>
          </div>
        </div>
      </div>
      <DialogFooter class="flex items-center gap-2">
        <div class="flex-1 flex items-center gap-2">
          <Button size="sm" variant="outline" :disabled="testingAi || !tempApiKey?.trim() || !tempEndpoint?.trim() || !tempModel?.trim()" @click="testAiConnection">
            <Loader2 v-if="testingAi" class="h-3 w-3 animate-spin mr-1" />
            {{ t('connection.test') }}
          </Button>
          <span v-if="testResult === 'success'" class="text-xs text-green-500">{{ t('connection.testSuccess') }}</span>
          <span v-else-if="testResult === 'error'" class="text-xs text-destructive truncate max-w-[200px]" :title="testError">{{ testError }}</span>
        </div>
        <Button size="sm" @click="saveSettings">{{ t('grid.save') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
