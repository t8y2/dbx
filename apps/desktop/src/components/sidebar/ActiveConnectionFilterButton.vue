<script setup lang="ts">
import { useId } from "vue";
import { useI18n } from "vue-i18n";
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
      <span
        data-active-connection-filter-icon
        class="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] transition-[width,height,border-color,background-color] duration-200 ease-out"
        :class="activeConnectionCount > 0 ? 'h-1.5 w-1.5 border-green-500 bg-green-500' : 'h-3 w-3 border-current bg-transparent'"
        aria-hidden="true"
      />
      <span :id="activeConnectionStatusId" class="sr-only" aria-live="polite" aria-atomic="true">{{ t("sidebar.activeConnectionsStatus", { count: activeConnectionCount }) }}</span>
    </button>
  </LightTooltip>
</template>
