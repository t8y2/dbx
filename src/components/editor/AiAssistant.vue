<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  ArrowUp, Bot, Check, Copy, Database, Loader2, Replace, Server, Settings,
  Play, Trash2, X,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSettingsStore, type AiProvider, type AiApiStyle } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { buildAiContext, runAiStream } from "@/lib/ai";
import { listDatabases, redisListDatabases, mongoListDatabases, aiTestConnection } from "@/lib/tauri";
import type { AiMessage } from "@/lib/tauri";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const { t } = useI18n();
const settings = useSettingsStore();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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

const chatTitle = computed(() => {
  const first = messages.value.find((m) => m.role === "user");
  return first ? first.content.slice(0, 30) : t("ai.newChat");
});

const isWaitingForFirstDelta = computed(() => {
  const last = messages.value[messages.value.length - 1];
  return isGenerating.value && last?.role === "assistant" && !last.content;
});


const databaseOptions = ref<string[]>([]);

async function loadDatabases() {
  if (!props.connection) return;
  try {
    if (props.connection.db_type === "redis") {
      const dbs = await redisListDatabases(props.connection.id);
      databaseOptions.value = dbs.map(String);
    } else if (props.connection.db_type === "mongodb") {
      databaseOptions.value = await mongoListDatabases(props.connection.id);
    } else {
      const list = await listDatabases(props.connection.id);
      databaseOptions.value = list.map((d: { name: string }) => d.name);
    }
  } catch {
    databaseOptions.value = [];
  }
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
  messages.value[assistantIdx].content += delta;
  scrollToBottom();
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
  try {
    const context = await buildAiContext(props.tab, props.connection);
    const history: AiMessage[] = messages.value.slice(0, -2).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    await runAiStream({
      config: settings.aiConfig,
      action: "generate",
      instruction: text,
      context,
    }, history, (delta) => {
      appendAssistantDelta(assistantIdx, delta);
    });
  } catch (e: any) {
    messages.value[assistantIdx].content = `Error: ${e.message || e}`;
  } finally {
    isGenerating.value = false;
    scrollToBottom();
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
}

interface MessageSegment {
  type: "text" | "code";
  content: string;
  lang?: string;
}

function parseMessage(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const regex = /```(sql|mysql|postgresql|sqlite|tsql|clickhouse)?\s*([\s\S]*?)```/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "code", lang: (match[1] || "sql").toUpperCase(), content: match[2].trim() });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    const unclosed = remaining.match(/```(sql|mysql|postgresql|sqlite|tsql|clickhouse)?\s*([\s\S]*)/i);
    if (unclosed) {
      const before = remaining.slice(0, unclosed.index);
      if (before.trim()) segments.push({ type: "text", content: before });
      if (unclosed[2].trim()) {
        segments.push({ type: "code", lang: (unclosed[1] || "sql").toUpperCase(), content: unclosed[2].trim() });
      }
    } else {
      segments.push({ type: "text", content: remaining });
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
      <Bot class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span class="flex-1 truncate text-xs font-medium">{{ chatTitle }}</span>
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

          <div v-else-if="msg.content" class="flex">
            <div class="max-w-[95%] rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed">
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
          <Server class="h-3 w-3 shrink-0" />
          <Select :model-value="connection?.id || ''" @update:model-value="(v: any) => changeConnection(v)">
            <SelectTrigger class="h-5 w-auto border-0 rounded-none bg-transparent p-0 text-xs text-foreground/80 shadow-none focus:ring-0 focus-visible:ring-0 [&_svg]:size-3">
              <SelectValue :placeholder="t('editor.selectConnection')">{{ connection?.name || t('editor.selectConnection') }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="conn in connectionStore.connections" :key="conn.id" :value="conn.id">
                {{ conn.name }}
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
                <SelectItem v-for="db in databaseOptions" :key="db" :value="db">{{ db }}</SelectItem>
                <SelectItem v-if="!databaseOptions.length && tab?.database" :value="tab.database">{{ tab.database }}</SelectItem>
              </SelectContent>
            </Select>
          </template>
        </div>
        <div class="flex items-end gap-1.5">
          <textarea
            v-model="prompt"
            rows="4"
            class="flex-1 resize-none bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            :placeholder="t('ai.placeholder')"
            :disabled="isGenerating || !props.tab?.database"
            @keydown.enter.exact="send"
          />
          <button
            class="h-7 w-7 shrink-0 rounded-full bg-foreground text-background flex items-center justify-center disabled:opacity-30"
            :disabled="isGenerating || !prompt.trim() || !props.tab?.database"
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
          <Input v-model="tempApiKey" type="password" class="col-span-2 h-8 text-xs" />
        </div>
        <div class="grid grid-cols-3 items-center gap-3">
          <Label class="text-right text-xs">Endpoint</Label>
          <Input v-model="tempEndpoint" placeholder="https://api.openai.com/v1" class="col-span-2 h-8 text-xs" />
        </div>
        <div class="grid grid-cols-3 items-center gap-3">
          <Label class="text-right text-xs">Model</Label>
          <Input v-model="tempModel" class="col-span-2 h-8 text-xs" />
        </div>
        <div v-if="tempProvider !== 'claude'" class="grid grid-cols-3 items-center gap-3">
          <Label class="text-right text-xs">API</Label>
          <div class="col-span-2 flex gap-2">
            <Button size="sm" variant="outline" class="h-8 flex-1 text-xs" :class="{ 'bg-accent': tempApiStyle === 'completions' }" @click="tempApiStyle = 'completions'">/chat/completions</Button>
            <Button size="sm" variant="outline" class="h-8 flex-1 text-xs" :class="{ 'bg-accent': tempApiStyle === 'responses' }" @click="tempApiStyle = 'responses'">/responses</Button>
          </div>
        </div>
      </div>
      <DialogFooter class="flex items-center gap-2">
        <div class="flex-1 flex items-center gap-2">
          <Button size="sm" variant="outline" :disabled="testingAi || !tempApiKey.trim() || !tempEndpoint.trim() || !tempModel.trim()" @click="testAiConnection">
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
