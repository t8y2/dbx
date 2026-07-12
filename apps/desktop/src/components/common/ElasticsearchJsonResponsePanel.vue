<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Code2, Copy } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { copyToClipboard } from "@/lib/common/clipboard";
import { parseJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";
import { createShikiJsonHighlighter, type JsonHighlighter } from "@/lib/common/shikiJsonHighlighter";
import JsonTree from "./JsonTree.vue";

const props = defineProps<{
  status: number;
  body: string;
}>();

const { t } = useI18n();
const { toast } = useToast();
const { isDark } = useTheme();
const responseView = ref<"raw" | "json">("json");
const jsonTreeRef = ref<{ refresh: () => void }>();
const jsonHighlighter = ref<JsonHighlighter>();

const parsedBody = computed(() => {
  try {
    return { valid: true, value: parseJsonPreservingLargeNumbers(props.body) };
  } catch {
    return { valid: false, value: null };
  }
});

const statusClass = computed(() => {
  if (props.status >= 500) return "border-destructive/40 bg-destructive/10 text-destructive";
  if (props.status >= 400) return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (props.status >= 300) return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
});

const statusLabel = computed(() => `HTTP ${props.status}`);
const jsonAppearance = computed(() => (isDark.value ? "dark" : "light"));

watch(
  () => props.body,
  () => {
    responseView.value = parsedBody.value.valid ? "json" : "raw";
  },
  { immediate: true },
);

watch(responseView, (view) => {
  if (view === "json") void nextTick(() => jsonTreeRef.value?.refresh());
});

async function copyResponse() {
  try {
    await copyToClipboard(props.body);
    toast(t("grid.copied"), 2000);
  } catch (error: any) {
    toast(t("grid.copyFailed", { message: error?.message || String(error) }), 5000);
  }
}

function highlightJson(value: string): string {
  return jsonHighlighter.value?.(value, jsonAppearance.value) ?? escapeHtml(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

onMounted(() => {
  void createShikiJsonHighlighter({ appearance: () => jsonAppearance.value })
    .then((highlight) => {
      jsonHighlighter.value = highlight;
    })
    .catch(() => {
      jsonHighlighter.value = undefined;
    });
});
</script>

<template>
  <section data-elasticsearch-json-response-root class="flex h-full min-h-0 flex-col bg-background" :aria-label="t('redis.jsonView')">
    <header class="flex min-h-11 shrink-0 items-center gap-2 border-b bg-muted/25 px-3 py-1.5 text-xs">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-sm" aria-hidden="true">
          <Code2 class="h-3.5 w-3.5" />
        </span>
        <div class="inline-flex h-7 items-center rounded-md border bg-muted/45 p-0.5">
          <button type="button" class="h-6 rounded-[4px] px-2 text-xs transition-colors" :class="responseView === 'raw' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" :aria-pressed="responseView === 'raw'" @click="responseView = 'raw'">
            {{ t("redis.rawContent") }}
          </button>
          <button
            type="button"
            class="h-6 rounded-[4px] px-2 text-xs transition-colors"
            :class="responseView === 'json' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="responseView === 'json'"
            :disabled="!parsedBody.valid"
            @click="responseView = 'json'"
          >
            {{ t("redis.jsonView") }}
          </button>
        </div>
      </div>
      <span class="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums" :class="statusClass" role="status" :aria-label="statusLabel">
        {{ statusLabel }}
      </span>
      <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :title="t('grid.copyJson')" :aria-label="t('grid.copyJson')" @click="copyResponse">
        <Copy class="h-3.5 w-3.5" />
      </Button>
    </header>
    <div class="min-h-0 flex-1 overflow-hidden bg-background p-4">
      <pre v-show="responseView === 'raw' || !parsedBody.valid" class="m-0 h-full overflow-auto bg-transparent p-0 font-mono text-sm leading-6 whitespace-pre-wrap break-words">{{ body }}</pre>
      <div v-if="parsedBody.valid" v-show="responseView === 'json'" class="h-full min-h-0">
        <JsonTree ref="jsonTreeRef" :value="parsedBody.value" :highlight-json="highlightJson" :virtualized="true" class="dbx-editor-font-family text-sm leading-6" />
      </div>
    </div>
  </section>
</template>
