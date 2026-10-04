<script setup lang="ts">
// Floating plugin window root — the whole document of a frameless, always-on-top
// desktop window that hosts exactly one plugin workbench (§8.3 surface "window").
// main.ts mounts this instead of the workbench shell when the window URL carries
// the plugin-window parameters, so a widget never boots or paints the tab strip,
// dock, and panels it does not contain. Shell-bound navigation is forwarded to
// the main window (see pluginFloatingWindow.forwardFloatingToMainWindow).
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Loader2, X } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { useTheme } from "@/composables/useTheme";
import { resolveWindowContext } from "@/lib/app/windowContext";
import { createFrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import { closeFloatingWindows, FLOATING_OPEN_FILESYSTEM_EVENT, FLOATING_OPEN_WORKBENCH_EVENT, FLOATING_WEBVIEW_HELLO_EVENT, FLOATING_WEBVIEW_READY_EVENT, forwardFloatingToMainWindow, resumeFloatingDock, revealFloatingWindow } from "@/lib/plugins/pluginFloatingWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { PluginWorkbenchContext } from "@/lib/plugins/pluginHostBridge";
import PluginWorkbenchHost from "@/components/plugins/PluginWorkbenchHost.vue";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";

const props = defineProps<{ localeReady?: Promise<void> }>();
const { locale } = useI18n();
const { applyTheme } = useTheme();

const windowContext = resolveWindowContext();
const identity = windowContext.kind === "plugin-window" ? windowContext : null;

const plugins = ref<InstalledPlugin[]>([]);
const plugin = ref<InstalledPlugin | null>(null);
const contribution = ref<PluginWorkbenchContribution | null>(null);
const failure = ref("");
let revealed = false;
let revealFallback: ReturnType<typeof setTimeout> | undefined;
// A floating window whose plugin never talks back paints a blank page on the
// desktop — no capsule, no buttons, nothing to click. The iframe's `load` event
// fires even when the plugin's own boot dies afterwards, so "ready" is not
// proof of life: bridge traffic is. If none arrives, fall back to the error
// card, which at least can be read and dismissed.
let pluginTalked = false;
let silenceWatchdog: ReturnType<typeof setTimeout> | undefined;
const PLUGIN_SILENCE_TIMEOUT_MS = 10_000;

const hostContext = computed<PluginWorkbenchContext>(() => ({
  ...identity?.pluginContext,
  workbenchId: identity?.windowLabel ?? "",
  restored: false,
  surface: "window",
}));

const zh = computed(() => locale.value.startsWith("zh"));
const statusText = computed(() => (failure.value ? `${zh.value ? "插件浮窗无法加载" : "The plugin window could not load"}: ${failure.value}` : zh.value ? "正在加载插件…" : "Loading plugin…"));

async function reveal() {
  if (revealed) return;
  revealed = true;
  clearTimeout(revealFallback);
  await revealFloatingWindow();
}

async function closeWindow() {
  if (!identity) return;
  await closeFloatingWindows([identity.windowLabel]);
}

function armSilenceWatchdog() {
  clearTimeout(silenceWatchdog);
  silenceWatchdog = setTimeout(() => {
    if (!pluginTalked && !failure.value) failure.value = zh.value ? "插件没有响应" : "the plugin did not respond";
  }, PLUGIN_SILENCE_TIMEOUT_MS);
}

function onHostReady() {
  void reveal();
  armSilenceWatchdog();
}

function onHostError(message: string) {
  if (!failure.value) failure.value = message || (zh.value ? "插件加载失败" : "the plugin failed to load");
  void reveal();
}

function onPluginMessage(event: MessageEvent) {
  if (pluginTalked) return;
  const frames = Array.from(document.querySelectorAll("iframe"));
  if (frames.some((frame) => frame.contentWindow === event.source)) {
    pluginTalked = true;
    clearTimeout(silenceWatchdog);
  }
}

function registry() {
  return createFrontendPluginRegistry(plugins.value, locale.value);
}

async function onOpenWorkbench(pluginId: string, contributionId: string, context?: PluginWorkbenchContext, options?: { forceNew?: boolean }) {
  const target = registry().findWorkbench(pluginId, contributionId);
  await forwardFloatingToMainWindow(FLOATING_OPEN_WORKBENCH_EVENT, {
    pluginId,
    contributionId,
    title: target?.contribution.label,
    ...(context ? { context } : {}),
    forceNew: options?.forceNew === true,
  });
}

async function onOpenFilesystem(pluginId: string, providerId: string, context?: PluginWorkbenchContext) {
  const target = registry()
    .listFilesystemProviders()
    .find((entry) => entry.plugin.manifest.id === pluginId && entry.contribution.id === providerId);
  await forwardFloatingToMainWindow(FLOATING_OPEN_FILESYSTEM_EVENT, {
    pluginId,
    providerId,
    title: target?.contribution.label,
    ...(target?.contribution.root_uri ? { rootUri: target.contribution.root_uri } : {}),
    ...(context ? { context } : {}),
  });
}

onMounted(async () => {
  applyTheme();
  window.addEventListener("message", onPluginMessage);
  // Report liveness to the window that created this one. A floating window is
  // created hidden, so a webview that dies during boot leaves no visible trace;
  // the creator waits for this event and retires windows that never send it.
  const reportReady = (to: string) => emitTo(to, FLOATING_WEBVIEW_READY_EVENT, { label: identity?.windowLabel }).catch(() => undefined);
  if (identity) void reportReady(identity.creatorLabel);
  void listen<{ from?: unknown }>(FLOATING_WEBVIEW_HELLO_EVENT, (message) => {
    const from = message.payload && typeof message.payload.from === "string" ? message.payload.from : "";
    if (from && identity) void reportReady(from);
  });
  // The window is created hidden and reveals itself on the plugin's first paint;
  // the fallback covers a plugin that never reports ready, so a broken widget
  // cannot stay invisible on the desktop with no way to dismiss it.
  revealFallback = setTimeout(() => void reveal(), 2500);
  // If the user parked this widget docked to a screen edge, it opens tucked and
  // the hover poll brings it back; the poll lives here, in this window.
  void resumeFloatingDock();
  try {
    await props.localeReady?.catch(() => undefined);
    if (!identity) {
      failure.value = zh.value ? "缺少插件窗口参数" : "missing plugin window parameters";
      return;
    }
    plugins.value = await api.listPlugins();
    const definition = plugins.value.find((candidate) => candidate.manifest.id === identity.pluginId) ?? null;
    if (!definition) {
      failure.value = identity.pluginId;
      return;
    }
    const target = (definition.manifest.contributions || []).find((candidate): candidate is PluginWorkbenchContribution => candidate.type === "workbench" && candidate.id === identity.contributionId) ?? null;
    if (!target) {
      failure.value = identity.contributionId;
      return;
    }
    plugin.value = definition;
    contribution.value = target;
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (failure.value) void reveal();
  }
});

onBeforeUnmount(() => {
  clearTimeout(revealFallback);
  clearTimeout(silenceWatchdog);
  window.removeEventListener("message", onPluginMessage);
});
</script>

<template>
  <div class="floating-plugin-window relative size-full overflow-hidden bg-transparent">
    <PluginWorkbenchHost v-if="plugin && contribution && !failure" :plugin="plugin" :contribution="contribution" :context="hostContext" @ready="onHostReady()" @error="onHostError($event)" @close-tab="void closeWindow()" @open-workbench="onOpenWorkbench" @open-filesystem="onOpenFilesystem" />
    <div v-else class="absolute inset-0 flex items-center justify-center p-3">
      <!-- Opaque card: an error inside a transparent window would be unreadable
           over whatever the user is working on. -->
      <div class="flex max-w-xs items-start gap-2 rounded-lg border border-border bg-background p-3 text-xs text-foreground shadow-lg">
        <AlertTriangle v-if="failure" class="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <Loader2 v-else class="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
        <span class="flex-1 break-words">{{ statusText }}</span>
        <button v-if="failure" class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" :aria-label="zh ? '关闭' : 'Close'" @click="void closeWindow()">
          <X class="size-3.5" />
        </button>
      </div>
    </div>
  </div>
</template>
