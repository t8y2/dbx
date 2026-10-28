<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Copy } from "@lucide/vue";
import { copyToClipboard, eventTargetUsesNativeClipboard, isPlainClipboardShortcut } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import type { QueryMessage } from "@/types/database";

defineProps<{ messages: QueryMessage[] }>();

const { t } = useI18n();
const { toast } = useToast();
const messagesRef = ref<HTMLElement>();
const messageContentsRef = ref<HTMLElement>();

function focusMessages(event: MouseEvent) {
  if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button, a, input, textarea, [contenteditable]"))) return;
  messagesRef.value?.focus({ preventScroll: true });
}

function onKeydown(event: KeyboardEvent) {
  if (!isPlainClipboardShortcut(event, "a") || eventTargetUsesNativeClipboard(event)) return;
  const contents = messageContentsRef.value;
  if (!contents) return;
  // App's capture listener blocks page-wide select-all. Select this output
  // explicitly even when it has already prevented the browser default.
  event.preventDefault();
  event.stopPropagation();
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(contents);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copyShell(message: string) {
  await copyToClipboard(message);
  toast(t("toolbar.mongoShellCopied"));
}

type SeverityTone = "muted" | "warning" | "error";

function severityTone(severity: string): SeverityTone {
  const normalized = severity.toLowerCase();
  if (normalized === "error" || normalized === "fatal" || normalized === "panic") return "error";
  if (normalized.includes("warn")) return "warning";
  return "muted";
}

const severityBadgeClasses: Record<SeverityTone, string> = {
  muted: "border-border bg-muted/40 text-muted-foreground",
  warning: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
};
</script>

<template>
  <div ref="messagesRef" data-native-clipboard tabindex="0" class="h-full overflow-auto bg-background select-text outline-none" @mousedown="focusMessages" @keydown="onKeydown" @contextmenu.stop>
    <div v-if="messages.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">
      {{ t("queryMessages.empty") }}
    </div>
    <div v-else ref="messageContentsRef" class="overflow-hidden">
      <div v-for="(message, index) in messages" :key="index" class="flex items-start gap-2 border-b px-3 py-2 text-xs last:border-b-0">
        <Badge variant="secondary" class="mt-px shrink-0 select-none font-mono text-[10px] uppercase" :class="severityBadgeClasses[severityTone(message.severity)]">
          {{ message.severity }}
        </Badge>
        <div class="min-w-0 flex-1">
          <div v-if="message.code === 'mongo-shell'" class="mb-1 flex select-none items-center gap-2">
            <span class="text-muted-foreground">{{ t("queryMessages.mongoShell") }}</span>
            <Button variant="ghost" size="sm" class="h-5 gap-1 px-1.5 text-[10px]" @click="copyShell(message.message)">
              <Copy class="h-3 w-3" />
              {{ t("queryMessages.copyMongoShell") }}
            </Button>
          </div>
          <div class="font-mono text-[11px] whitespace-pre-wrap break-words text-foreground">{{ message.message }}</div>
          <div v-if="message.detail" class="mt-0.5 font-mono text-[11px] whitespace-pre-wrap break-words text-muted-foreground">{{ message.detail }}</div>
          <div v-if="message.hint" class="mt-0.5 font-mono text-[11px] whitespace-pre-wrap break-words text-muted-foreground">{{ message.hint }}</div>
          <div v-if="message.code && message.code !== 'mongo-shell'" class="mt-0.5 select-none font-mono text-[10px] text-muted-foreground">{{ t("queryMessages.code", { code: message.code }) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
