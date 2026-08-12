<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/composables/useToast";
import { resolveSshPrompt } from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { apiUrl } from "@/lib/common/webPath";

interface SshPromptRequest {
  id: string;
  kind: "HostKeyVerify" | "SecretInput";
  host: string;
  port: number;
  key_type?: string | null;
  fingerprint?: string | null;
  prompt?: string | null;
  echo?: boolean;
}

interface SshHostKeyNotice {
  kind: "Changed" | "Rejected" | "LearnFailed" | string;
  host: string;
  port: number;
  message: string;
}

const { t } = useI18n();
const { toast } = useToast();

// Queue of pending prompts. A single `activePrompt` ref would let a second
// prompt arriving before the first is resolved overwrite it, orphaning the
// first responder (that connection would then hang until the 300s timeout).
// Using a queue keyed by request id means every prompt is shown and answered.
const queue = ref<SshPromptRequest[]>([]);
const current = computed<SshPromptRequest | null>(() => queue.value[0] ?? null);
const isSecretPrompt = computed(() => current.value?.kind === "SecretInput");
const visible = ref(false);

const remember = ref(true);
const secretCode = ref("");
const resolving = ref(false);
const unlisteners: Array<() => void> = [];
let webEventSource: EventSource | null = null;
let pendingTimer: ReturnType<typeof setInterval> | null = null;
let mounted = true;

function enqueuePrompt(request: SshPromptRequest) {
  if (queue.value.some((prompt) => prompt.id === request.id)) return;
  queue.value.push(request);
  visible.value = true;
}

function handleNotice(n: SshHostKeyNotice) {
  let message: string;
  if (n.kind === "Changed") {
    message = t("connection.sshHostKeyNoticeChanged", { host: n.host, port: n.port });
  } else if (n.kind === "Rejected") {
    message = t("connection.sshHostKeyNoticeRejected", { host: n.host, port: n.port });
  } else if (n.kind === "LearnFailed") {
    message = t("connection.sshHostKeyNoticeLearnFailed", { host: n.host, port: n.port });
  } else {
    message = n.message || t("connection.sshHostKeyNoticeGeneric");
  }
  toast(message, 6000);
}

function handleWebEvent(data: string) {
  try {
    const event = JSON.parse(data) as { type: "sync" | "prompt" | "notice" | "dismiss"; pendingIds?: string[]; request?: SshPromptRequest; notice?: SshHostKeyNotice; id?: string };
    if (event.type === "sync" && event.pendingIds) {
      const currentId = queue.value[0]?.id;
      queue.value = queue.value.filter((prompt) => event.pendingIds?.includes(prompt.id));
      if (currentId && !queue.value.some((prompt) => prompt.id === currentId)) resetPromptState();
      visible.value = queue.value.length > 0;
    } else if (event.type === "prompt" && event.request) enqueuePrompt(event.request);
    else if (event.type === "notice" && event.notice) handleNotice(event.notice);
    else if (event.type === "dismiss" && event.id) dismissPrompt(event.id);
  } catch (error) {
    console.error("[DBX] invalid SSH prompt event:", error);
  }
}

async function setupTauriPromptBridge() {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    if (!mounted) return;
    const promptHandle = await listen<SshPromptRequest>("ssh-prompt", (event) => {
      enqueuePrompt(event.payload);
    });
    if (!mounted) {
      promptHandle();
      return;
    }
    unlisteners.push(promptHandle);

    const noticeHandle = await listen<SshHostKeyNotice>("ssh-host-key-notice", (event) => {
      handleNotice(event.payload);
    });
    if (!mounted) {
      noticeHandle();
      return;
    }
    unlisteners.push(noticeHandle);

    // Backend tells the UI to drop a prompt it already gave up on (timeout,
    // cancellation, or event-delivery failure). Remove it by id so the queue
    // keeps progressing instead of stranding the dialog.
    const dismissHandle = await listen<string>("ssh-prompt-dismiss", (event) => {
      dismissPrompt(event.payload);
    });
    if (!mounted) {
      dismissHandle();
      return;
    }
    unlisteners.push(dismissHandle);

    // Do not let the backend emit prompts until every listener is installed;
    // Tauri events sent before a listener exists are not replayed.
    await invoke("ssh_prompt_ready");
    if (!mounted) {
      void invoke("ssh_prompt_not_ready").catch(() => undefined);
    }
  } catch {
    // The desktop bridge is unavailable, so the connection remains fail-closed.
  }
}

// Fallback delivery alongside the SSE stream. On first connect the dialog's
// EventSource may not be open yet when the backend fires a host-key prompt, so
// the SSE `Prompt` event is lost and (without this) the connection hangs until
// its timeout. Polling the pending endpoint recovers any lost prompt so the
// dialog still appears. `enqueuePrompt` dedupes by id, so repeated polls are
// harmless.
async function fetchPendingPrompts() {
  try {
    const res = await fetch(apiUrl("/api/ssh/prompts/pending"), { credentials: "include" });
    if (!res.ok) return;
    const pending = (await res.json()) as SshPromptRequest[];
    pending.forEach((req) => enqueuePrompt(req));
  } catch {
    // Transient failure — the next poll retries.
  }
}

function setupWebPromptBridge() {
  webEventSource = new EventSource(apiUrl("/api/ssh/prompts"));
  webEventSource.onmessage = (event) => handleWebEvent(event.data);
  webEventSource.onopen = () => {
    // The SSE stream is live; its replay already carries any prompt that fired
    // before the stream opened, so stop polling to avoid needless requests.
    if (pendingTimer) {
      clearInterval(pendingTimer);
      pendingTimer = null;
    }
  };
  webEventSource.onerror = () => {
    // EventSource reconnects automatically. While disconnected, fall back to
    // polling so a prompt fired during the outage is not lost.
    if (!pendingTimer) pendingTimer = setInterval(fetchPendingPrompts, 2000);
  };
  // First-connect fallback: the stream may not be open yet when the backend
  // fires a host-key prompt, so poll until it is.
  void fetchPendingPrompts();
  if (!pendingTimer) pendingTimer = setInterval(fetchPendingPrompts, 2000);
}

onMounted(() => {
  if (isTauriRuntime()) void setupTauriPromptBridge();
  else setupWebPromptBridge();
});

onBeforeUnmount(() => {
  mounted = false;
  unlisteners.forEach((u) => u());
  webEventSource?.close();
  webEventSource = null;
  if (pendingTimer) {
    clearInterval(pendingTimer);
    pendingTimer = null;
  }
  if (isTauriRuntime()) void import("@tauri-apps/api/core").then(({ invoke }) => invoke("ssh_prompt_not_ready")).catch(() => undefined);
});

async function resolve(action: "accept" | "reject" | "secret") {
  const prompt = queue.value[0];
  if (!prompt || resolving.value) return;
  resolving.value = true;
  try {
    await resolveSshPrompt({
      id: prompt.id,
      action,
      remember: action === "accept" ? remember.value : undefined,
      secret: action === "secret" ? secretCode.value : undefined,
    });
    // Advance to the next queued prompt (if any) and reset per-prompt state.
    dismissPrompt(prompt.id);
  } catch (e) {
    console.error("[DBX] resolve_ssh_prompt failed:", e);
    // "No pending" / "already cancelled" mean the backend already dropped this
    // prompt (timeout or cancelled) — remove it from the queue and move on so
    // the dialog does not get stuck.
    dismissPrompt(prompt.id);
  } finally {
    resolving.value = false;
  }
}

// Remove a prompt by id (e.g. when the backend cancels it) and reset per-prompt
// state if we just dismissed the one the user was acting on.
function dismissPrompt(id: string) {
  const idx = queue.value.findIndex((p) => p.id === id);
  if (idx === -1) return;
  queue.value.splice(idx, 1);
  if (idx === 0) resetPromptState();
  if (queue.value.length === 0) visible.value = false;
}

function resetPromptState() {
  remember.value = true;
  secretCode.value = "";
}

function accept() {
  void resolve("accept");
}

function reject() {
  void resolve("reject");
}

function submitSecret() {
  void resolve("secret");
}
</script>

<template>
  <Dialog v-model:open="visible">
    <!-- Every dialog portal teleports into <body> when its component mounts, so
    body order (and therefore paint order at the shared z-50) is fixed by mount
    order, not by which dialog opened last. This prompt mounts once at app start,
    so a dialog mounted on demand later (e.g. the connection editor) paints over
    it while still being demoted to pointer-events:none as the lower modal layer
    — the prompt is invisible, the dialog is dead, and the window is stuck. This
    is a blocking prompt, so keep it above every other layer in the app (the
    tallest today are the image preview at 80/81 and the sidebar overlays at
    100). -->
    <DialogContent class="sm:max-w-[460px]" overlay-class="z-[200]" portal-class="z-[200]" :show-close-button="false" @interact-outside.prevent @escape-key-down.prevent>
      <DialogHeader>
        <DialogTitle>
          {{ t(isSecretPrompt ? "connection.sshInteractiveTitle" : "connection.sshHostKeyVerifyTitle") }}
        </DialogTitle>
        <DialogDescription class="text-muted-foreground">
          {{ t(isSecretPrompt ? "connection.sshInteractiveMessage" : "connection.sshHostKeyVerifyMessage", { host: current?.host ?? "", port: current?.port ?? "" }) }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="current" class="space-y-3 py-1">
        <div v-if="current.kind === 'HostKeyVerify'" class="rounded-md border border-border bg-muted/40 p-3 text-sm">
          <div class="flex items-center justify-between gap-3">
            <span class="text-muted-foreground">{{ t("connection.sshHostKeyVerifyKeyType") }}</span>
            <span class="font-medium">{{ current.key_type || "—" }}</span>
          </div>
          <div class="mt-2 flex items-start justify-between gap-3">
            <span class="shrink-0 text-muted-foreground">{{ t("connection.sshHostKeyVerifyFingerprint") }}</span>
            <span class="break-all text-right font-mono text-xs font-medium">{{ current.fingerprint || "—" }}</span>
          </div>
        </div>

        <label v-if="current.kind === 'HostKeyVerify'" class="flex items-center gap-2 text-sm">
          <input type="checkbox" v-model="remember" class="h-4 w-4 rounded border-border accent-primary" />
          <span>{{ t("connection.sshHostKeyVerifyRemember") }}</span>
        </label>

        <div v-else-if="current.kind === 'SecretInput'" class="space-y-2">
          <p class="whitespace-pre-wrap text-sm text-muted-foreground">
            {{ current.prompt || t("connection.sshInteractiveDefaultPrompt") }}
          </p>
          <input
            v-model="secretCode"
            :type="current.echo ? 'text' : 'password'"
            autocomplete="one-time-code"
            class="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            :placeholder="t('connection.sshInteractivePlaceholder')"
            @keydown.enter="submitSecret"
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="resolving" @click="reject">
          {{ t(isSecretPrompt ? "connection.sshInteractiveCancel" : "connection.sshHostKeyVerifyReject") }}
        </Button>
        <Button v-if="current?.kind !== 'SecretInput'" :disabled="resolving" @click="accept">
          {{ t("connection.sshHostKeyVerifyAccept") }}
        </Button>
        <Button v-else :disabled="resolving || !secretCode" @click="submitSecret">
          {{ t("connection.sshInteractiveSubmit") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
