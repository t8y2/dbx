<script setup lang="ts">
import { ShieldAlert } from "@lucide/vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

withDefaults(
  defineProps<{
    compact?: boolean;
  }>(),
  { compact: false },
);
</script>

<template>
  <span class="inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] border border-red-500/40 bg-red-500/10 px-1.5 font-mono text-[10px] font-semibold leading-none text-red-700 dark:text-red-300" :class="compact ? 'px-1' : ''" :title="t('production.title')">
    <ShieldAlert class="h-3 w-3" aria-hidden="true" />
    <span>PROD</span>
  </span>
</template>
