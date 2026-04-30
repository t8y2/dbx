<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  Bot, Copy, Loader2, Replace, Send, Settings,
  Sparkles, Trash2, X,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSettingsStore, type AiProvider } from "@/stores/settingsStore";
import { buildAiContext, extractSql, runAiAction, type AiAction } from "@/lib/ai";
import type { AiMessage } from "@/lib/tauri";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const { t } = useI18n();
const settings = useSettingsStore();

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  action?: AiAction;
}

const props = defineProps<{
  tab?: QueryTab;
  connection?: ConnectionConfig;
}>();

const emit = defineEmits<{
  replaceSql: [sql: string];
  close: [];
}>();

const action = ref<AiAction>("generate");
const prompt = ref("");
const messages = ref<ChatMessage[]>([]);
const isGenerating = ref(false);
const showSettings = ref(false);
const scrollRef = ref<InstanceType<typeof ScrollArea> | null>(null);

const tempProvider = ref<AiProvider>(settings.aiConfig.provider);
const tempApiKey = ref(settings.aiConfig.apiKey);
const tempEndpoint = ref(settings.aiConfig.endpoint);
const tempModel = ref(settings.aiConfig.model);

const providerDefaults: Record<AiProvider, { endpoint: string; model: string }> = {
  claude: { endpoint: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-20250514" },
  openai: { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o" },
  custom: { endpoint: "", model: "" },
};

const actionLabels: Record<AiAction, string> = {
  generate: "ai.actions.generate",
  explain: "ai.actions.explain",
  optimize: "ai.actions.optimize",
  fix: "ai.actions.fix",
  convert: "ai.actions.convert",
  sampleData: "ai.actions.sampleData",
};

function openSettings() {
  tempProvider.value = settings.aiConfig.provider;
  tempApiKey.value = settings.aiConfig.apiKey;
  tempEndpoint.value = settings.aiConfig.endpoint;
  tempModel.value = settings.aiConfig.model;
  showSettings.value = true;
}

function saveSettings() {
  settings.updateAiConfig({
    provider: tempProvider.value,
    apiKey: tempApiKey.value,
    endpoint: tempEndpoint.value,
    model: tempModel.value,
  });
  showSettings.value = false;
}

function selectProvider(provider: AiProvider) {
  tempProvider.value = provider;
  tempEndpoint.value = providerDefaults[provider].endpoint;
  tempModel.value = providerDefaults[provider].model;
}

function scrollToBottom() {
  nextTick(() => {
    const el = scrollRef.value?.$el?.querySelector("[data-radix-scroll-area-viewport]");
    if (el) el.scrollTop = el.scrollHeight;
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

  messages.value.push({ role: "user", content: text, action: action.value });
  prompt.value = "";
  scrollToBottom();

  isGenerating.value = true;
  try {
    const context = await buildAiContext(props.tab, props.connection);
    const history: AiMessage[] = messages.value.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const result = await runAiAction({
      config: settings.aiConfig,
      action: action.value,
      instruction: text,
      context,
    }, history);
    messages.value.push({ role: "assistant", content: result });
  } catch (e: any) {
    messages.value.push({ role: "assistant", content: `Error: ${e.message || e}` });
  } finally {
    isGenerating.value = false;
    scrollToBottom();
  }
}

function applySql(text: string) {
  const sql = extractSql(text);
  if (sql) emit("replaceSql", sql);
}

async function copySql(text: string) {
  const sql = extractSql(text);
  if (sql) await navigator.clipboard.writeText(sql);
}

function clearMessages() {
  messages.value = [];
}

function hasSql(text: string): boolean {
  return /```(?:sql|mysql|postgresql|sqlite|tsql|clickhouse)?\s*[\s\S]*?```/i.test(text);
}

function formatMessageContent(text: string): string {
  return text
    .replace(/```(?:sql|mysql|postgresql|sqlite|tsql|clickhouse)?\s*([\s\S]*?)```/gi, '<pre class="my-2 rounded bg-black/30 p-2 text-xs overflow-x-auto"><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code class="rounded bg-black/20 px-1 py-0.5 text-xs">$1</code>')
    .replace(/\n/g, "<br>");
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-2 border-b px-3 py-2">
      <Sparkles class="h-4 w-4 text-primary shrink-0" />
      <span class="text-sm font-medium flex-1">AI</span>
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

    <ScrollArea ref="scrollRef" class="flex-1">
      <div class="flex flex-col gap-3 p-3">
        <div v-if="messages.length === 0" class="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
          <Bot class="h-10 w-10 mb-3 opacity-30" />
          <p class="text-sm">{{ t('ai.welcome') }}</p>
        </div>

        <template v-for="(msg, i) in messages" :key="i">
          <div v-if="msg.role === 'user'" class="flex justify-end">
            <div class="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground">
              {{ msg.content }}
            </div>
          </div>

          <div v-else class="flex flex-col gap-1">
            <div class="max-w-[95%] rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed">
              <div v-html="formatMessageContent(msg.content)" />
            </div>
            <div v-if="hasSql(msg.content)" class="flex gap-1">
              <Button variant="outline" size="xs" class="h-6 text-[10px]" @click="applySql(msg.content)">
                <Replace class="h-3 w-3" />
                {{ t('ai.apply') }}
              </Button>
              <Button variant="ghost" size="xs" class="h-6 text-[10px]" @click="copySql(msg.content)">
                <Copy class="h-3 w-3" />
                {{ t('ai.copySql') }}
              </Button>
            </div>
          </div>
        </template>

        <div v-if="isGenerating" class="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 class="h-3.5 w-3.5 animate-spin" />
          <span>{{ t('ai.thinking') }}</span>
        </div>
      </div>
    </ScrollArea>

    <div class="border-t p-2">
      <div class="flex items-center gap-1.5">
        <Select :model-value="action" @update:model-value="(v: any) => action = v">
          <SelectTrigger class="h-7 w-24 text-[10px] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="(label, key) in actionLabels" :key="key" :value="key">
              {{ t(label) }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Input
          v-model="prompt"
          class="h-7 flex-1 text-xs"
          :placeholder="t(`ai.placeholders.${action}`)"
          :disabled="isGenerating"
          @keydown.enter="send"
        />
        <Button variant="default" size="icon" class="h-7 w-7 shrink-0" :disabled="isGenerating || !prompt.trim()" @click="send">
          <Send class="h-3.5 w-3.5" />
        </Button>
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
          <Input v-model="tempEndpoint" class="col-span-2 h-8 text-xs" />
        </div>
        <div class="grid grid-cols-3 items-center gap-3">
          <Label class="text-right text-xs">Model</Label>
          <Input v-model="tempModel" class="col-span-2 h-8 text-xs" />
        </div>
      </div>
      <DialogFooter>
        <Button size="sm" @click="saveSettings">{{ t('grid.save') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
