<script setup lang="ts">
import { computed } from "vue";
import { Loader2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { redisQueryResultsToConsoleEntries } from "@/lib/redis/redisQueryResult";
import type { QueryResult } from "@/types/database";

const props = withDefaults(
  defineProps<{
    result?: QueryResult;
    results?: QueryResult[];
    loading?: boolean;
  }>(),
  { loading: false },
);

const { t } = useI18n();
const entries = computed(() => redisQueryResultsToConsoleEntries(props.results?.length ? props.results : props.result ? [props.result] : []));
</script>

<template>
  <div data-redis-query-console role="region" class="dbx-editor-font-family flex min-h-0 flex-1 flex-col bg-[#171b21] text-[13px] leading-5 text-slate-200" :aria-label="t('redis.commandLine')">
    <div class="min-h-0 flex-1 overflow-auto px-4 py-4">
      <div v-for="(entry, index) in entries" :key="`${index}:${entry.command}`" class="mb-4 last:mb-0">
        <div v-if="entry.command" class="flex min-w-0 items-start gap-2 whitespace-pre-wrap break-words">
          <span class="shrink-0 text-[#d7ba7d]">redis&gt;</span>
          <span class="min-w-0 text-slate-200">{{ entry.command }}</span>
        </div>
        <pre data-native-clipboard class="m-0 whitespace-pre-wrap break-words" :class="entry.error ? 'text-[#ff6b6b]' : 'text-slate-300'">{{ entry.output }}</pre>
      </div>
      <div v-if="loading && entries.length === 0" class="flex h-full items-center justify-center text-slate-400">
        <Loader2 class="h-4 w-4 animate-spin" />
      </div>
      <div v-else-if="entries.length === 0" class="flex h-full items-center justify-center text-slate-400">
        {{ t("redis.commandEmptyResult") }}
      </div>
    </div>
  </div>
</template>
