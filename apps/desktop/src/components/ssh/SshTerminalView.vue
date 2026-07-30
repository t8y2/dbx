<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, Search, RotateCw, Square, X, ChevronUp, ChevronDown } from "@lucide/vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { closeSshTerminal, openSshTerminal, resizeSshTerminal, writeSshTerminal } from "@/lib/backend/ssh-terminal-tauri";
import { copyToClipboard } from "@/lib/common/clipboard";
import { decodeSshTerminalData } from "@/lib/ssh/terminalData";
import { listSshProfiles } from "@/lib/backend/ssh-terminal-tauri";
import { setSshTerminalProfile, setSshTerminalStatus, setSshTerminalTranscript } from "@/lib/ssh/terminalRegistry";
import { useTheme } from "@/composables/useTheme";
import type { SshTerminalEvent, SshTerminalSize } from "@/types/ssh";

const props = defineProps<{
  profileId: string;
  active: boolean;
}>();

const { t } = useI18n();
const { isDark, themePalette } = useTheme();
const host = ref<HTMLElement | null>(null);
const searchInput = ref<ComponentPublicInstance | null>(null);
const status = ref<"connecting" | "connected" | "disconnected" | "error">("connecting");
const statusDetail = ref("");
const searchOpen = ref(false);
const searchText = ref("");
const hasSelection = ref(false);

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let searchAddon: SearchAddon | null = null;
let sessionId: string | null = null;
let resizeObserver: ResizeObserver | null = null;
let inputBuffer = "";
let inputTimer: ReturnType<typeof setTimeout> | null = null;
let connectGeneration = 0;
let active = props.active;

const statusLabel = computed(() => {
  if (status.value === "connecting") return t("sshTerminal.connecting");
  if (status.value === "connected") return t("sshTerminal.connected");
  if (status.value === "error") return t("sshTerminal.error");
  return t("sshTerminal.disconnected");
});

function cssColor(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function syncTheme() {
  if (!terminal) return;
  const dark = isDark.value;
  terminal.options.theme = {
    background: cssColor("--background", dark ? "rgb(19 20 22)" : "rgb(255 255 255)"),
    foreground: cssColor("--foreground", dark ? "rgb(215 215 219)" : "rgb(32 33 36)"),
    cursor: cssColor("--primary", "rgb(82 82 91)"),
    cursorAccent: cssColor("--primary-foreground", "rgb(250 250 250)"),
    selectionBackground: cssColor("--accent", "rgb(63 63 70)"),
    selectionForeground: cssColor("--accent-foreground", "rgb(250 250 250)"),
    black: dark ? "#202124" : "#30343b",
    red: dark ? "#e06c75" : "#b4232f",
    green: dark ? "#67b97a" : "#237a3b",
    yellow: dark ? "#d7a84f" : "#8a6200",
    blue: dark ? "#72a7e8" : "#245fa8",
    magenta: dark ? "#bc82cf" : "#7d3c98",
    cyan: dark ? "#5db8bd" : "#1d7378",
    white: dark ? "#d5d7db" : "#e5e7eb",
    brightBlack: dark ? "#74777d" : "#59616c",
    brightRed: dark ? "#f07b83" : "#d13a45",
    brightGreen: dark ? "#7dcc91" : "#2f914a",
    brightYellow: dark ? "#e5bd68" : "#a87800",
    brightBlue: dark ? "#8ab8ef" : "#3478c5",
    brightMagenta: dark ? "#ce9add" : "#9651ad",
    brightCyan: dark ? "#78c9cd" : "#278c91",
    brightWhite: dark ? "#f1f2f4" : "#ffffff",
  };
}

function publishTranscript() {
  if (!terminal) return;
  const buffer = terminal.buffer.active;
  const firstLine = Math.max(0, buffer.length - 200);
  const lines: string[] = [];
  for (let index = firstLine; index < buffer.length; index++) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  setSshTerminalTranscript(props.profileId, lines.join("\n").slice(-20_000));
}

function updateStatus(nextStatus: typeof status.value, detail = "") {
  status.value = nextStatus;
  statusDetail.value = detail;
  setSshTerminalStatus(props.profileId, nextStatus, detail);
}

function currentSize(): SshTerminalSize {
  const element = host.value;
  return {
    columns: Math.max(1, terminal?.cols ?? 80),
    rows: Math.max(1, terminal?.rows ?? 24),
    pixelWidth: Math.max(0, Math.round(element?.clientWidth ?? 0)),
    pixelHeight: Math.max(0, Math.round(element?.clientHeight ?? 0)),
  };
}

function handleEvent(event: SshTerminalEvent, generation: number) {
  if (generation !== connectGeneration || !terminal) return;
  if (event.type === "ready") {
    updateStatus("connected");
    if (active) terminal.focus();
    return;
  }
  if (event.type === "data") {
    terminal.write(decodeSshTerminalData(event.data), publishTranscript);
    return;
  }
  if (event.type === "error") {
    updateStatus("error", event.message);
    terminal.writeln(`\r\n\x1b[31m${event.message}\x1b[0m`);
    return;
  }
  updateStatus("disconnected", event.signal || "");
  sessionId = null;
  const suffix = event.exitCode == null ? "" : ` (${event.exitCode})`;
  terminal.writeln(`\r\n\x1b[90m${t("sshTerminal.sessionEnded", { suffix })}\x1b[0m`);
}

async function connect() {
  if (!terminal || !fitAddon) return;
  clearPendingInput();
  const generation = ++connectGeneration;
  const previousSession = sessionId;
  sessionId = null;
  if (previousSession) void closeSshTerminal(previousSession).catch(() => undefined);
  terminal.reset();
  updateStatus("connecting");
  await nextTick();
  fitAddon.fit();
  try {
    const openedSessionId = await openSshTerminal(props.profileId, currentSize(), (event) => handleEvent(event, generation));
    if (generation !== connectGeneration) {
      void closeSshTerminal(openedSessionId).catch(() => undefined);
      return;
    }
    sessionId = openedSessionId;
  } catch (error) {
    if (generation !== connectGeneration) return;
    const message = error instanceof Error ? error.message : String(error);
    updateStatus("error", message);
    terminal.writeln(`\x1b[31m${message}\x1b[0m`);
  }
}

function scheduleInput(data: string) {
  inputBuffer += data;
  if (inputTimer) return;
  inputTimer = setTimeout(() => {
    const payload = inputBuffer;
    inputBuffer = "";
    inputTimer = null;
    const targetSession = sessionId;
    if (targetSession && payload) void writeSshTerminal(targetSession, payload).catch((error) => (statusDetail.value = String(error)));
  }, 8);
}

function fitAndResize() {
  if (!terminal || !fitAddon || !host.value || host.value.clientWidth === 0 || host.value.clientHeight === 0) return;
  fitAddon.fit();
  const targetSession = sessionId;
  if (targetSession) void resizeSshTerminal(targetSession, currentSize()).catch(() => undefined);
}

async function disconnect() {
  clearPendingInput();
  const targetSession = sessionId;
  sessionId = null;
  ++connectGeneration;
  if (targetSession) await closeSshTerminal(targetSession).catch(() => false);
  updateStatus("disconnected");
}

async function copySelection() {
  const selection = terminal?.getSelection() ?? "";
  if (selection) await copyToClipboard(selection);
}

function openSearch() {
  searchOpen.value = true;
  nextTick(() => (searchInput.value?.$el as HTMLInputElement | undefined)?.focus());
}

function closeSearch() {
  searchOpen.value = false;
  searchAddon?.clearDecorations();
  terminal?.focus();
}

function findNext() {
  if (searchText.value) searchAddon?.findNext(searchText.value, { incremental: true, caseSensitive: false });
}

function findPrevious() {
  if (searchText.value) searchAddon?.findPrevious(searchText.value, { incremental: true, caseSensitive: false });
}

function handleKeydown(event: KeyboardEvent) {
  if (!active) return;
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openSearch();
  }
  if (event.key === "Escape" && searchOpen.value) {
    event.preventDefault();
    closeSearch();
  }
}

function clearPendingInput() {
  if (inputTimer) clearTimeout(inputTimer);
  inputTimer = null;
  inputBuffer = "";
}

onMounted(() => {
  void listSshProfiles()
    .then((profiles) => profiles.find((profile) => profile.id === props.profileId))
    .then((profile) => profile && setSshTerminalProfile(profile))
    .catch(() => undefined);
  terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.18,
    scrollback: 10_000,
    rightClickSelectsWord: true,
  });
  fitAddon = new FitAddon();
  searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  syncTheme();
  terminal.open(host.value!);
  terminal.onData(scheduleInput);
  terminal.onSelectionChange(() => (hasSelection.value = !!terminal?.hasSelection()));
  resizeObserver = new ResizeObserver(fitAndResize);
  resizeObserver.observe(host.value!);
  document.documentElement.addEventListener("keydown", handleKeydown);
  void connect();
});

watch([isDark, themePalette], () => nextTick(syncTheme));

watch(
  () => props.active,
  (value) => {
    active = value;
    if (!value) return;
    nextTick(() => {
      syncTheme();
      fitAndResize();
      terminal?.focus();
    });
  },
);

onBeforeUnmount(() => {
  ++connectGeneration;
  clearPendingInput();
  resizeObserver?.disconnect();
  document.documentElement.removeEventListener("keydown", handleKeydown);
  const targetSession = sessionId;
  sessionId = null;
  if (targetSession) void closeSshTerminal(targetSession).catch(() => undefined);
  setSshTerminalStatus(props.profileId, "disconnected");
  terminal?.dispose();
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col bg-background">
    <div class="relative flex h-8 shrink-0 items-center gap-1 border-b bg-muted/15 px-2">
      <span class="h-2 w-2 rounded-full" :class="status === 'connected' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-500' : status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/60'" />
      <span class="min-w-0 truncate text-[11px] text-muted-foreground" :title="statusDetail">{{ statusLabel }}</span>
      <span class="flex-1" />
      <template v-if="searchOpen">
        <Input ref="searchInput" v-model="searchText" class="h-6 w-52 text-xs" :placeholder="t('sshTerminal.searchPlaceholder')" @input="findNext" @keydown.enter.prevent="findNext" @keydown.shift.enter.prevent="findPrevious" />
        <LightTooltip :text="t('sshTerminal.previousMatch')" side="bottom" :delay="0" nowrap>
          <Button variant="ghost" size="icon" class="h-6 w-6" @click="findPrevious"><ChevronUp class="h-3.5 w-3.5" /></Button>
        </LightTooltip>
        <LightTooltip :text="t('sshTerminal.nextMatch')" side="bottom" :delay="0" nowrap>
          <Button variant="ghost" size="icon" class="h-6 w-6" @click="findNext"><ChevronDown class="h-3.5 w-3.5" /></Button>
        </LightTooltip>
        <LightTooltip :text="t('common.close')" side="bottom" :delay="0" nowrap>
          <Button variant="ghost" size="icon" class="h-6 w-6" @click="closeSearch"><X class="h-3.5 w-3.5" /></Button>
        </LightTooltip>
      </template>
      <template v-else>
        <LightTooltip :text="t('sshTerminal.copySelection')" side="bottom" :delay="0" nowrap>
          <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="!hasSelection" @click="copySelection"><Copy class="h-3.5 w-3.5" /></Button>
        </LightTooltip>
        <LightTooltip :text="t('sshTerminal.search')" side="bottom" :delay="0" nowrap>
          <Button variant="ghost" size="icon" class="h-6 w-6" @click="openSearch"><Search class="h-3.5 w-3.5" /></Button>
        </LightTooltip>
        <LightTooltip :text="t('sshTerminal.reconnect')" side="bottom" :delay="0" nowrap>
          <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="status === 'connecting'" @click="connect"><RotateCw class="h-3.5 w-3.5" /></Button>
        </LightTooltip>
        <LightTooltip :text="t('sshTerminal.disconnect')" side="bottom" :delay="0" nowrap>
          <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="!sessionId" @click="disconnect"><Square class="h-3.5 w-3.5" /></Button>
        </LightTooltip>
      </template>
    </div>
    <div ref="host" class="ssh-terminal-host min-h-0 flex-1 px-2 py-1" role="application" :aria-label="t('sshTerminal.terminal')" />
  </div>
</template>

<style scoped>
.ssh-terminal-host :deep(.xterm) {
  height: 100%;
}

.ssh-terminal-host :deep(.xterm-viewport) {
  scrollbar-color: color-mix(in srgb, var(--foreground) 25%, transparent) transparent;
}
</style>
