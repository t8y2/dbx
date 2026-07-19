<script setup lang="ts">
import { useConnectionGroupLabel } from "@/composables/useConnectionGroupLabel";

const props = defineProps<{ connectionId: string }>();

const { connectionGroupLabel } = useConnectionGroupLabel();
</script>

<template>
  <span class="min-w-0 max-w-28 shrink-0 truncate rounded-sm bg-muted/70 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground" :title="connectionGroupLabel(props.connectionId)">
    {{ connectionGroupLabel(props.connectionId) }}
  </span>
</template>
