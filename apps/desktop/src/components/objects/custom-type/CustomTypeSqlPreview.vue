<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronUp, Copy, Loader2 } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import type { CustomTypePlanIssue } from "@/types/database";

/**
 * The exact statements the backend will run, plus why it refuses to run them.
 *
 * The statements here are the backend's output, not something this panel
 * composes — the user is approving the plan that apply re-derives, which is why
 * a blocked plan must be visible and not just a disabled button.
 */
const props = withDefaults(
  defineProps<{
    statements: string[];
    warnings: CustomTypePlanIssue[];
    blockedChanges: CustomTypePlanIssue[];
    loading?: boolean;
    error?: string | null;
    collapsed?: boolean;
  }>(),
  { loading: false, error: null, collapsed: false },
);

const emit = defineEmits<{ "update:collapsed": [value: boolean] }>();
const { t } = useI18n();
const toast = useToast();
const copied = ref(false);

const script = computed(() => props.statements.join("\n"));

async function copyScript() {
  if (!script.value) return;
  try {
    await copyToClipboard(script.value);
    copied.value = true;
    toast.toast(t("contextMenu.ddlCopied"));
    window.setTimeout(() => (copied.value = false), 1500);
  } catch {
    toast.toast(t("grid.copyFailed", { message: t("common.copy") }));
  }
}
</script>

<template>
  <div class="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-md border" :class="collapsed ? '' : 'h-[26%] min-h-32 max-h-72'">
    <div class="flex h-7 shrink-0 items-center gap-1.5 border-b bg-muted/20 px-2">
      <button type="button" class="flex min-w-0 items-center gap-1 text-xs" @click="emit('update:collapsed', !collapsed)">
        <ChevronUp v-if="collapsed" class="h-3 w-3" />
        <ChevronDown v-else class="h-3 w-3" />
        <span class="truncate">{{ t("structureEditor.sqlPreview") }}</span>
      </button>
      <Badge v-if="!loading && statements.length" variant="outline" class="h-4 px-1 text-[10px]">{{ statements.length }}</Badge>
      <span class="flex-1" />
      <Loader2 v-if="loading" class="h-3 w-3 animate-spin text-muted-foreground" />
      <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!script" :title="t('grid.copyDdl')" @click="copyScript">
        <Copy class="h-3 w-3" />
      </Button>
      <span v-if="copied" class="text-[10px] text-muted-foreground">{{ t("contextMenu.ddlCopied") }}</span>
    </div>

    <div v-if="!collapsed" class="min-h-0 flex-1 overflow-auto">
      <div v-if="error" class="px-3 py-2 text-[11px] text-destructive">{{ error }}</div>
      <div v-for="issue in blockedChanges" :key="`blocked-${issue.code}-${issue.message}`" class="border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
        <span class="font-medium">{{ issue.code }}</span>
        <span> · {{ issue.message }}</span>
      </div>
      <div v-for="issue in warnings" :key="`warn-${issue.code}-${issue.message}`" class="border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
        <span class="font-medium">{{ issue.code }}</span>
        <span> · {{ issue.message }}</span>
      </div>
      <pre v-if="statements.length" class="select-text whitespace-pre-wrap break-words p-2.5 font-mono text-[11px] leading-5">{{ script }}</pre>
      <div v-else-if="loading" class="flex h-full items-center justify-center text-xs text-muted-foreground">{{ t("common.loading") }}</div>
      <div v-else class="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">{{ t("customType.editor.noChanges") }}</div>
    </div>
  </div>
</template>
