<script setup lang="ts">
import { defineAsyncComponent, onErrorCaptured, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { X, LoaderCircle, FileCode2 } from "@lucide/vue";
import { WORKSPACE_STARTUP_ERROR_EVENT, type WorkspaceTransferInfo } from "@/lib/tabs/workspaceTabTransfer";

defineProps<{ localeReady?: Promise<void> }>();
const StartupGate = defineAsyncComponent(() => import("@/StartupGate.vue"));
const { t } = useI18n();
const id = new URLSearchParams(window.location.search).get("dbxWorkspaceTransfer")!;
const title = ref("");
const ready = ref(false);
const error = ref("");
const retrying = ref(false);
let disposed = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let unlisten: (() => void) | undefined;

async function inspect() {
  try {
    const info = await invoke<WorkspaceTransferInfo>("workspace_tab_transfer", { operation: "inspect", id });
    if (disposed) return;
    title.value = info.title ?? "";
    if (info.status === "committed") {
      ready.value = true;
      return;
    }
    if (info.status === "cancelled") {
      error.value ||= t("tabs.workspaceTransferCancelled");
      return;
    }
  } catch (cause) {
    if (!disposed) error.value ||= String(cause);
    return;
  }
  if (!disposed) timer = setTimeout(() => void inspect(), 250);
}

function fail(cause: unknown) {
  if (ready.value || disposed) return;
  error.value = cause instanceof Error ? cause.message : String(cause);
  // 原子拒绝：若目标已提交，则由正常窗口关闭流程负责，不能撤回已交接的标签。
  void invoke("workspace_tab_transfer", { operation: "reject", id })
    .then(() => inspect())
    .catch(() => {});
}
const onStartupError = (event: Event) => fail((event as CustomEvent).detail);
onErrorCaptured((cause) => {
  fail(cause);
  return false;
});

async function close() {
  try {
    await invoke("close_workspace_startup");
  } catch (cause) {
    error.value = String(cause);
    await inspect();
  }
}

async function retry() {
  if (retrying.value) return;
  retrying.value = true;
  try {
    await invoke("workspace_tab_transfer", { operation: "retry", id });
    if (disposed) return;
    retryTimer = setTimeout(() => {
      retrying.value = false;
      error.value = t("tabs.workspaceRetryUnavailable");
    }, 5000);
  } catch (cause) {
    retrying.value = false;
    error.value = String(cause);
  }
}

// 先安装错误监听，再让 StartupGate 启动完整工作区。
window.addEventListener(WORKSPACE_STARTUP_ERROR_EVENT, onStartupError);
onMounted(() => {
  void inspect();
  void getCurrentWebviewWindow()
    .listen<string>("dbx:workspace-retry-error", ({ payload }) => {
      clearTimeout(retryTimer);
      retrying.value = false;
      error.value = payload;
    })
    .then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    })
    .catch(fail);
});
onUnmounted(() => {
  disposed = true;
  clearTimeout(timer);
  clearTimeout(retryTimer);
  unlisten?.();
  window.removeEventListener(WORKSPACE_STARTUP_ERROR_EVENT, onStartupError);
});
</script>

<template>
  <div v-show="ready" :inert="!ready || undefined"><StartupGate :locale-ready="localeReady" /></div>
  <div v-if="!ready" data-workspace-startup class="fixed inset-0 z-[1200] flex flex-col bg-background text-foreground" :role="error ? 'alert' : 'status'" :aria-busy="!error || retrying" aria-live="polite">
    <header data-tauri-drag-region class="flex h-10 shrink-0 items-center justify-between border-b px-3">
      <span class="text-sm font-semibold">DBX</span>
      <button class="rounded p-1 hover:bg-muted" :aria-label="t('common.close')" @click="close"><X class="size-4" /></button>
    </header>
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
      <div class="flex max-w-full items-center gap-2 rounded-md border bg-muted/30 px-4 py-2 text-sm">
        <FileCode2 class="size-4 shrink-0" /><span class="truncate">{{ title || "DBX" }}</span>
      </div>
      <LoaderCircle v-if="!error || retrying" class="size-5 animate-spin motion-reduce:animate-none" />
      <p class="text-sm text-muted-foreground">{{ t(error ? "tabs.workspaceTransferFailed" : "tabs.workspaceOpening") }}</p>
      <p v-if="error" class="max-w-xl whitespace-pre-wrap break-words text-sm text-destructive">{{ error }}</p>
      <div v-if="error" class="flex gap-2">
        <button class="rounded border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50" :disabled="retrying" @click="retry">{{ t("common.retry") }}</button>
        <button class="rounded border px-4 py-2 text-sm hover:bg-muted" @click="close">{{ t("common.close") }}</button>
      </div>
    </div>
  </div>
</template>
