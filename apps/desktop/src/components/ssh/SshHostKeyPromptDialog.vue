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
const visible = ref(false);

const remember = ref(true);
const secretCode = ref("");
const resolving = ref(false);
const unlisteners: Array<() => void> = [];
let webEventSource: EventSource | null = null;
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

function setupWebPromptBridge() {
  webEventSource = new EventSource(apiUrl("/api/ssh/prompts"));
  webEventSource.onmessage = (event) => handleWebEvent(event.data);
  webEventSource.onerror = () => {
    // EventSource automatically retries. Do not close it while the app is mounted.
  };
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
  <Dialog v-model:open="visible" :dismissible="false">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t("connection.sshHostKeyVerifyTitle") }}</DialogTitle>
        <DialogDescription class="text-muted-foreground">
          {{ t("connection.sshHostKeyVerifyMessage", { host: current?.host ?? "", port: current?.port ?? "" }) }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="current" class="space-y-3 py-1">
        <div class="rounded-md border border-border bg-muted/40 p-3 text-sm">
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
          <p class="text-sm text-muted-foreground">{{ current.prompt || "Enter verification code" }}</p>
          <input v-model="secretCode" type="text" autocomplete="off" class="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring" :placeholder="'••••••'" />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="resolving" @click="reject">{{ t("connection.sshHostKeyVerifyReject") }}</Button>
        <Button v-if="current?.kind !== 'SecretInput'" :disabled="resolving" @click="accept">
          {{ t("connection.sshHostKeyVerifyAccept") }}
        </Button>
        <Button v-else :disabled="resolving || !secretCode" @click="submitSecret">
          {{ t("connection.sshHostKeyVerifyAccept") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
