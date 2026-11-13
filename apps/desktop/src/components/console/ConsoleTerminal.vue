<script setup lang="ts">
// Navicat-style 命令列界面: a terminal tab bound to the tab's connection.
// Types a line, Enter executes (or continues the statement with `->`),
// output echoes inline like the native clients. Execution reuses the same
// executeMulti path as the query editor, so console client commands (DESC,
// EXEC, SET, PROMPT, EXIT, \d, \dt, ...) work here too.
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { CONSOLE_CONTINUATION_PROMPT, consolePrompt, supportsSqlConsole } from "@/lib/console/consoleFormat";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import type { QueryTab } from "@/types/database";
import { Button } from "@/components/ui/button";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { copyToClipboard, hasNativeClipboardSelection, readTextFromClipboard } from "@/lib/common/clipboard";

const props = defineProps<{ tab: QueryTab }>();

const { t } = useI18n();
const queryStore = useQueryStore();
const connectionStore = useConnectionStore();

const session = computed(() => queryStore.consoleSessionFor(props.tab.id));
const connection = computed(() => connectionStore.getConfig(props.tab.connectionId));
const dbType = computed(() => effectiveDatabaseTypeForConnection(connection.value) ?? connection.value?.db_type);
const prompt = computed(() => consolePrompt(dbType.value));
const livePrompt = computed(() => (session.value.buffer ? CONSOLE_CONTINUATION_PROMPT : prompt.value));
const unsupported = computed(() => !supportsSqlConsole(dbType.value));

const input = computed({
  get: () => session.value.input,
  set: (value: string) => {
    session.value.input = value;
  },
});
const inputEl = ref<HTMLInputElement | null>(null);
const scrollEl = ref<HTMLDivElement | null>(null);
const contextMenuItems = ref<ContextMenuItem[]>([]);

const pendingLines = computed(() => {
  if (!session.value.buffer) return [];
  const lines = session.value.buffer.split("\n");
  return [`${prompt.value}${lines[0]}`, ...lines.slice(1).map((line) => `${CONSOLE_CONTINUATION_PROMPT}${line}`)];
});

function focusInput() {
  inputEl.value?.focus();
}

/// Terminal semantics: the input row is pinned below the scrollback, and the
/// scrollback follows the newest output. The double rAF guarantees the scroll
/// happens after Vue's DOM patch AND the browser's layout pass — a single
/// nextTick can read a stale scrollHeight when large tables just mounted.
function scrollToBottom() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = scrollEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  });
}

watch(
  () => [session.value.entries.length, session.value.buffer, session.value.isExecuting] as const,
  () => scrollToBottom(),
  { flush: "post" },
);

watch(
  () => session.value.isExecuting,
  (executing) => {
    if (!executing) focusInputUnlessTextSelected();
  },
);

onMounted(() => {
  focusInput();
  scrollToBottom();
});

async function submit() {
  if (session.value.isExecuting || unsupported.value) return;
  const line = input.value;
  input.value = "";
  if (!line.trim() && !session.value.buffer) {
    // Empty Enter echoes a fresh prompt like the native clients.
    session.value.entries.push({ kind: "command", text: prompt.value.trimEnd() });
    return;
  }
  await queryStore.executeConsoleStatement(props.tab.id, line);
  focusInputUnlessTextSelected();
}

function focusInputUnlessTextSelected() {
  if (window.getSelection()?.isCollapsed === false) return;
  focusInput();
}

function openContextMenu(event: MouseEvent, showMenu: (event: MouseEvent) => void) {
  const field = inputEl.value;
  if (!field) return;
  const targetSession = session.value;
  const tabId = props.tab.id;
  const originalInput = field.value;
  const start = field.selectionStart ?? originalInput.length;
  const end = field.selectionEnd ?? start;
  const selection = window.getSelection();
  const selectedOutput = selection && scrollEl.value?.contains(selection.anchorNode) && scrollEl.value?.contains(selection.focusNode);
  // Capture before the menu takes focus, which can collapse the native selection.
  const text = (event.target as Element).closest("[data-console-input-line]") ? originalInput.slice(start, end) : selectedOutput ? selection.toString() : "";
  const reportError = (error: unknown) => targetSession.entries.push({ kind: "error", text: t("console.clipboardFailed", { message: error instanceof Error ? error.message : String(error) }) });
  contextMenuItems.value = [
    { label: t("console.copy"), shortcut: "Mod+C", disabled: !text, action: () => void copyToClipboard(text).catch(reportError) },
    {
      label: t("console.paste"),
      shortcut: "Mod+V",
      disabled: targetSession.isExecuting || unsupported.value,
      action: async () => {
        try {
          const pasted = await readTextFromClipboard();
          if (props.tab.id !== tabId || session.value !== targetSession || targetSession.isExecuting || inputEl.value !== field || field.value !== originalInput) return;
          field.setRangeText(pasted, start, end, "end");
          field.dispatchEvent(new Event("input", { bubbles: true }));
          focusInput();
        } catch (error) {
          reportError(error);
        }
      },
    },
  ];
  showMenu(event);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    void submit();
    return;
  }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    if (session.value.isExecuting) return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? -1 : 1;
    const navigated = queryStore.consoleHistoryNavigate(props.tab.id, direction, input.value);
    input.value = navigated.text;
    return;
  }
  if (event.key.toLowerCase() === "c" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    if (hasNativeClipboardSelection() || inputEl.value?.selectionStart !== inputEl.value?.selectionEnd) return;
    event.preventDefault();
    if (session.value.isExecuting) {
      void queryStore.cancelConsoleStatement(props.tab.id);
      return;
    }
    if (input.value || session.value.buffer) {
      input.value = "";
      session.value.buffer = "";
    }
  }
}

defineExpose({ focusInput });
</script>

<template>
  <CustomContextMenu :items="() => contextMenuItems" v-slot="{ onContextMenu }">
    <div class="flex min-h-0 flex-1 flex-col bg-[#171b21] font-mono text-[13px] leading-5 text-slate-200" data-console-terminal role="region" :aria-label="t('console.title')" @click="focusInputUnlessTextSelected" @contextmenu="openContextMenu($event, onContextMenu)">
      <div ref="scrollEl" class="min-h-0 flex-1 select-text overflow-x-hidden overflow-y-auto px-4 py-3" data-console-scrollback data-native-clipboard>
        <div
          v-for="(entry, index) in session.entries"
          :key="index"
          class="whitespace-pre-wrap break-words"
          :class="[
            {
              'text-[#d7ba7d]': entry.kind === 'command',
              'text-slate-300': entry.kind === 'output',
              'text-[#ff6b6b]': entry.kind === 'error',
              'text-slate-500': entry.kind === 'notice',
            },
            entry.kind === 'command' && index > 0 ? 'mt-3' : '',
          ]"
        >
          {{ entry.text }}
        </div>
        <div v-for="(line, index) in pendingLines" :key="`pending:${index}`" class="whitespace-pre-wrap break-words text-[#d7ba7d]">{{ line }}</div>
      </div>
      <div class="flex shrink-0 items-center border-t border-slate-800/60 px-4 py-2" data-console-input-line>
        <span class="shrink-0 whitespace-pre text-[#d7ba7d]">{{ livePrompt }}</span>
        <input
          ref="inputEl"
          v-model="input"
          type="text"
          class="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] leading-5 text-slate-200 caret-slate-200 outline-none"
          :placeholder="unsupported ? t('console.unsupportedType') : ''"
          :aria-label="t('console.title')"
          :disabled="unsupported"
          :readonly="session.isExecuting"
          spellcheck="false"
          autocomplete="off"
          data-testid="console-input"
          @keydown="onKeydown"
        />
        <span v-if="session.isExecuting" class="shrink-0 pl-2 text-slate-500">{{ t("console.running") }}</span>
        <Button v-if="session.isExecuting" size="sm" variant="ghost" :disabled="tab.isCancelling" class="ml-2 shrink-0" data-console-cancel @click.stop="queryStore.cancelConsoleStatement(tab.id)">
          {{ t("toolbar.stopQuery") }}
        </Button>
      </div>
    </div>
  </CustomContextMenu>
</template>
