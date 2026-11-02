<script setup lang="ts">
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import PluginIcon from "@/components/plugins/PluginIcon.vue";
import { connectionIconType } from "@/lib/connection/connectionPresentation";
import type { ConnectionConfig } from "@/types/database";

defineProps<{ connection?: ConnectionConfig }>();
</script>

<template>
  <PluginIcon v-if="connection?.db_type === 'plugin' && connection.plugin_id" :plugin-id="connection.plugin_id" :contribution-id="connection.plugin_connection_provider" />
  <DatabaseIcon v-else :db-type="connectionIconType(connection)" />
</template>
