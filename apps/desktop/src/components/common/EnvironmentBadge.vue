<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { connectionEnvironmentPreset } from "@/lib/connection/connectionEnvironment";

const props = defineProps<{
  environment?: string;
}>();

const { t } = useI18n();

const preset = computed(() => connectionEnvironmentPreset(props.environment));
</script>

<template>
  <span v-if="preset" class="inline-flex h-4 shrink-0 items-center rounded-[3px] px-1 font-mono text-[9px] font-semibold leading-none" :class="preset.badgeClass" :title="t(preset.labelKey)">
    {{ t(preset.badgeKey) }}
  </span>
</template>
