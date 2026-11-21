<script setup lang="ts">
import DatabaseJobAdmin from "@/components/admin/DatabaseJobAdmin.vue";
import type { ConnectionConfig } from "@/types/database";
import type { NativeJobAdminSelection } from "@/lib/database/nativeJobAdmin";
defineProps<{ connection: ConnectionConfig; initialSelection?: NativeJobAdminSelection }>();
</script>

<template><DatabaseJobAdmin :connection="connection" :initial-selection="initialSelection" /></template>
