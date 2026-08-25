<script setup lang="ts">
import { useId } from "vue";
import { useI18n } from "vue-i18n";
import { CircleDot } from "@lucide/vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";

defineProps<{
  activeConnectionCount: number;
  pressed: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
}>();

const { t } = useI18n();
const activeConnectionStatusId = useId();
</script>

<template>
  <LightTooltip :text="t('sidebar.showActiveConnectionsOnly')" side="top" :delay="300" nowrap>
    <button
      type="button"
      data-active-connection-filter
      class="relative shrink-0 h-6 w-6 flex items-center justify-center rounded border hover:bg-accent"
      :class="pressed ? 'text-primary bg-primary/10 border-primary/30' : 'border-border text-muted-foreground hover:text-foreground'"
      :aria-label="t('sidebar.showActiveConnectionsOnly')"
      :aria-describedby="activeConnectionStatusId"
      :aria-pressed="pressed"
      @click="emit('toggle')"
    >
      <CircleDot data-active-connection-filter-icon class="h-3.5 w-3.5" />
      <span v-if="activeConnectionCount > 0" data-active-connection-badge class="pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-green-500 ring-1 ring-background" aria-hidden="true" />
      <span :id="activeConnectionStatusId" class="sr-only" aria-live="polite" aria-atomic="true">{{ t("sidebar.activeConnectionsStatus", { count: activeConnectionCount }) }}</span>
    </button>
  </LightTooltip>
</template>
