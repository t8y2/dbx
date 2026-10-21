<script setup lang="ts">
import { Check, ChevronDown, Loader2, RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const props = withDefaults(
  defineProps<{
    enabled: boolean;
    intervalSeconds: number;
    intervals: readonly number[];
    loading?: boolean;
    manualDisabled?: boolean;
    disabled?: boolean;
    label?: string;
    offLabel?: string;
    refreshLabel?: string;
    intervalLabel?: (seconds: number) => string;
    refreshButtonAttrs?: Record<string, string>;
    menuTriggerAttrs?: Record<string, string>;
  }>(),
  {
    loading: false,
    manualDisabled: false,
    disabled: false,
    label: "Auto-refresh",
    offLabel: "Off",
    refreshLabel: "Refresh",
    intervalLabel: (seconds: number) => `${seconds}s`,
    refreshButtonAttrs: () => ({}),
    menuTriggerAttrs: () => ({}),
  },
);

const emit = defineEmits<{
  refresh: [];
  disable: [];
  select: [seconds: number];
}>();

function selectInterval(seconds: number) {
  if (props.disabled) return;
  emit("select", seconds);
}
</script>

<template>
  <div class="flex h-7 shrink-0 overflow-hidden rounded-md border" :aria-label="label">
    <Button variant="ghost" size="icon" class="h-7 w-7 rounded-none px-0" :disabled="disabled || loading || manualDisabled" :title="refreshLabel" :aria-label="refreshLabel" v-bind="refreshButtonAttrs" @click="emit('refresh')">
      <Loader2 v-if="loading" class="auto-refresh-spinner h-3.5 w-3.5" />
      <RefreshCw v-else class="h-3.5 w-3.5" />
    </Button>
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          class="h-7 w-5 rounded-none border-l px-0"
          :class="enabled ? 'bg-primary/10 text-primary hover:bg-primary/15' : ''"
          :disabled="disabled"
          :title="enabled ? `${label}: ${intervalLabel(intervalSeconds)}` : label"
          :aria-label="enabled ? `${label}: ${intervalLabel(intervalSeconds)}` : label"
          v-bind="menuTriggerAttrs"
        >
          <ChevronDown class="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-40">
        <DropdownMenuLabel>{{ label }}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem class="gap-2" :disabled="disabled" @select="emit('disable')">
          <Check v-if="!enabled" class="h-3.5 w-3.5" />
          <span v-else class="h-3.5 w-3.5" />
          {{ offLabel }}
        </DropdownMenuItem>
        <DropdownMenuItem v-for="seconds in intervals" :key="seconds" class="gap-2" :disabled="disabled" @select="selectInterval(seconds)">
          <Check v-if="enabled && intervalSeconds === seconds" class="h-3.5 w-3.5" />
          <span v-else class="h-3.5 w-3.5" />
          {{ intervalLabel(seconds) }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>

<style scoped>
.auto-refresh-spinner {
  animation: auto-refresh-spin 1.5s linear infinite;
}

@keyframes auto-refresh-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}
</style>
