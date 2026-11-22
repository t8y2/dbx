<script setup lang="ts">
import { computed } from "vue";
import { Database } from "@lucide/vue";
import ConnectionIcon from "@/components/icons/ConnectionIcon.vue";
import { webPath } from "@/lib/common/webPath";
import { connectionBadge } from "@/lib/sidebar/connectionBadge";
import type { ConnectionConfig } from "@/types/database";

const props = defineProps<{
  connection?: ConnectionConfig;
  connected: boolean;
}>();

const badge = computed(() => connectionBadge(props.connection));
const badgeStyle = computed(() => ({
  backgroundColor: props.connected ? badge.value?.color : "#737373",
  "--connection-badge-mask": badge.value?.src ? `url("${webPath(badge.value.src)}")` : undefined,
}));
</script>

<template>
  <span v-if="badge" class="connection-badge" :style="badgeStyle" :data-connection-badge="badge.asset" :data-basic-adaptation="badge.basic" :data-connected="connected" aria-hidden="true">
    <span v-if="badge.src" class="connection-badge__mark" />
    <Database v-else class="connection-badge__fallback" />
  </span>
  <ConnectionIcon v-else :connection="connection" class="h-3.5 w-3.5 shrink-0" :class="connected ? '' : 'saturate-50 opacity-70'" />
</template>

<style scoped>
.connection-badge {
  position: relative;
  display: inline-flex;
  width: 100%;
  height: 100%;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 4px;
}

.connection-badge__mark {
  position: absolute;
  inset: 2px;
  background-color: #fff;
  mask: var(--connection-badge-mask) center / contain no-repeat;
}

.connection-badge__fallback {
  position: absolute;
  inset: 3px;
  width: calc(100% - 6px);
  height: calc(100% - 6px);
  color: #fff;
}

.connection-badge[data-connection-badge="sqlserver"] .connection-badge__mark {
  inset: 1px 2px;
}

.connection-badge[data-connection-badge="redis"] .connection-badge__mark {
  inset: 20%;
}
</style>
