<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/backend/api";
import type { PluginEvent } from "@/types/database";
import {
  parsePluginConnectionChallenge,
  pluginConnectionChallengeKey,
  PLUGIN_CONNECTION_CHALLENGE_RESOLVE_METHOD,
  type PluginConnectionChallenge,
} from "@/lib/plugins/pluginConnectionChallenge";

const { t } = useI18n();
const queue = ref<PluginConnectionChallenge[]>([]);
const current = computed(() => queue.value[0] ?? null);
const visible = computed({
  get: () => current.value !== null,
  set: (open) => {
    if (!open) void resolve(false);
  },
});
const remember = ref(true);
const resolving = ref(false);
const seen = new Set<string>();
let unsubscribe: (() => void) | undefined;
let mounted = true;

onMounted(async () => {
  const stop = await api.subscribePluginEvents((event: PluginEvent) => {
    const challenge = parsePluginConnectionChallenge(event);
    if (!challenge) return;
    const key = pluginConnectionChallengeKey(challenge);
    if (seen.has(key)) return;
    seen.add(key);
    queue.value.push(challenge);
  });
  if (!mounted) stop();
  else unsubscribe = stop;
});

onBeforeUnmount(() => {
  mounted = false;
  unsubscribe?.();
});

async function resolve(accept: boolean) {
  const challenge = current.value;
  if (!challenge || resolving.value) return;
  resolving.value = true;
  try {
    await api.invokePlugin(challenge.pluginId, PLUGIN_CONNECTION_CHALLENGE_RESOLVE_METHOD, {
      operationId: challenge.operationId,
      challengeId: challenge.challengeId,
      accept,
      remember: accept && remember.value,
    });
  } catch (error) {
    console.error("[DBX] failed to resolve plugin connection challenge:", error);
  } finally {
    seen.delete(pluginConnectionChallengeKey(challenge));
    if (queue.value[0] === challenge) queue.value.shift();
    else queue.value = queue.value.filter((item) => item !== challenge);
    remember.value = true;
    resolving.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="visible">
    <DialogContent class="sm:max-w-[460px]" :show-close-button="false" @interact-outside.prevent @escape-key-down.prevent>
      <DialogHeader>
        <DialogTitle>{{ current?.title || t("connection.sshHostKeyVerifyTitle") }}</DialogTitle>
        <DialogDescription>{{ current?.message || t("connection.sshHostKeyVerifyMessage", { host: current?.host || "", port: current?.port || "" }) }}</DialogDescription>
      </DialogHeader>
      <div v-if="current" class="space-y-3 py-1">
        <div class="rounded-md border border-border bg-muted/40 p-3 text-sm">
          <div v-if="current.host" class="flex items-center justify-between gap-3">
            <span class="text-muted-foreground">{{ current.host }}{{ current.port ? `:${current.port}` : "" }}</span>
          </div>
          <div class="mt-2 flex items-center justify-between gap-3">
            <span class="text-muted-foreground">{{ t("connection.sshHostKeyVerifyKeyType") }}</span>
            <span class="font-medium">{{ current.keyType || "—" }}</span>
          </div>
          <div class="mt-2 flex items-start justify-between gap-3">
            <span class="shrink-0 text-muted-foreground">{{ t("connection.sshHostKeyVerifyFingerprint") }}</span>
            <span class="break-all text-right font-mono text-xs font-medium">{{ current.fingerprint }}</span>
          </div>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="remember" type="checkbox" class="h-4 w-4 rounded border-border accent-primary" />
          <span>{{ t("connection.sshHostKeyVerifyRemember") }}</span>
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="resolving" @click="resolve(false)">{{ t("connection.sshHostKeyVerifyReject") }}</Button>
        <Button :disabled="resolving" @click="resolve(true)">{{ t("connection.sshHostKeyVerifyAccept") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
