<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { AlignLeft, Copy, ChevronDown } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/clipboard";
import { formatSqlText, type SqlFormatDialect } from "@/lib/sqlFormatter";
import type { Highlighter } from "shiki";

const props = defineProps<{
  sql: string;
  sqlFormatDialect?: SqlFormatDialect;
  loading?: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();
const { isDark } = useTheme();
const { toast } = useToast();

const isFormatted = ref(false);
const formattedSql = ref("");
const formatting = ref(false);
const highlightedHtml = ref("");
const highlighterReady = ref(false);

let highlighter: Highlighter | null = null;

const displaySql = computed(() => {
  if (isFormatted.value && formattedSql.value) {
    return formattedSql.value;
  }
  return props.sql;
});

const hasSql = computed(() => props.sql.trim().length > 0);

async function initHighlighter() {
  if (highlighter) return;
  try {
    const { createHighlighter } = await import("shiki");
    highlighter = await createHighlighter({
      themes: ["dark-plus", "min-light"],
      langs: ["sql"],
    });
    highlighterReady.value = true;
    await highlightSql();
  } catch (e) {
    console.error("[DBX][SqlPreviewPanel] Failed to init shiki:", e);
  }
}

async function highlightSql() {
  if (!highlighter || !displaySql.value) return;
  try {
    const theme = isDark.value ? "dark-plus" : "min-light";
    highlightedHtml.value = highlighter.codeToHtml(displaySql.value, {
      lang: "sql",
      theme,
    });
  } catch {
    // fallback to plain text
    highlightedHtml.value = "";
  }
}

async function toggleFormat() {
  if (formatting.value || !hasSql.value) return;
  if (isFormatted.value) {
    isFormatted.value = false;
    await highlightSql();
    return;
  }

  formatting.value = true;
  try {
    formattedSql.value = await formatSqlText(props.sql, props.sqlFormatDialect ?? "generic");
    isFormatted.value = true;
    await highlightSql();
  } catch {
    toast(t("toolbar.formatSqlFailed"), 3000);
  } finally {
    formatting.value = false;
  }
}

async function handleCopy() {
  const text = displaySql.value;
  if (!text.trim()) return;
  try {
    await copyToClipboard(text);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

watch(
  () => props.sql,
  async (newSql) => {
    isFormatted.value = false;
    formattedSql.value = "";
    if (highlighterReady.value && newSql.trim()) {
      await highlightSql();
    }
  },
);

watch(isDark, async () => {
  if (highlighterReady.value && displaySql.value) {
    await highlightSql();
  }
});

watch(displaySql, async () => {
  if (highlighterReady.value) {
    await highlightSql();
  }
});

onMounted(() => {
  nextTick(() => {
    void initHighlighter();
  });
});

onBeforeUnmount(() => {
  highlighter?.dispose();
  highlighter = null;
  highlighterReady.value = false;
});
</script>

<template>
  <div class="h-full flex flex-col bg-background border-t">
    <!-- Header bar -->
    <div class="h-8 shrink-0 border-b bg-muted/30 px-2 flex items-center gap-1 text-xs text-muted-foreground">
      <span class="font-medium text-muted-foreground/70 select-none">SQL</span>
      <span class="flex-1 min-w-0" />
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6" :class="isFormatted ? 'text-amber-600 bg-amber-500/10' : 'text-amber-600/60 hover:text-amber-700 hover:bg-amber-500/10'" :disabled="formatting || !hasSql" @click="toggleFormat">
            <AlignLeft class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.formatSql") }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6 text-muted-foreground/60 hover:text-foreground hover:bg-accent" :disabled="!hasSql" @click="handleCopy">
            <Copy class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("grid.copy") }}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-6 text-muted-foreground/60 hover:text-foreground hover:bg-accent" @click="emit('close')">
            <ChevronDown class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t("toolbar.hidePreviewSql") }}</TooltipContent>
      </Tooltip>
    </div>

    <!-- Content -->
    <div class="flex-1 min-h-0 overflow-auto">
      <!-- Loading -->
      <div v-if="loading" class="flex items-center justify-center h-full text-xs text-muted-foreground">
        {{ t("common.loading") }}
      </div>

      <!-- Empty -->
      <div v-else-if="!hasSql" class="flex items-center justify-center h-full text-xs text-muted-foreground">
        {{ t("editor.pressToExecute", { mod: "Cmd/Ctrl" }) }}
      </div>

      <!-- Shiki highlighted SQL -->
      <div v-else-if="highlightedHtml" class="p-3 text-xs leading-relaxed [&_pre]:!bg-transparent [&_pre]:!p-0 [&_code]:!font-mono [&_code]:text-xs" v-html="highlightedHtml" />

      <!-- Plain text fallback -->
      <pre v-else class="p-3 text-xs font-mono whitespace-pre-wrap select-text">{{ displaySql }}</pre>
    </div>
  </div>
</template>
