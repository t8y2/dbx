<script setup lang="ts">
import { AlertTriangle, CalendarClock, Code2, Database, Gauge, KeyRound, Network, PencilRuler, ShieldCheck, Table2, TableProperties } from "@lucide/vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { tabDatabaseIconType } from "@/lib/tabs/tabPresentation";
import type { QueryTab } from "@/types/database";

// Mirrors EditorGroupTabBar's per-mode tab icon chain so surfaces outside the
// group bar (e.g. the special-page strip's return tabs) render identical icons.
defineProps<{ tab: QueryTab }>();
</script>

<template>
  <AlertTriangle v-if="tab.externalSqlFileMissing" />
  <Table2 v-else-if="tab.mode === 'data' || tab.mode === 'mongo' || tab.mode === 'redis' || tab.mode === 'hbase'" />
  <DatabaseIcon v-else-if="tab.mode === 'mq'" :db-type="tabDatabaseIconType(tab)" />
  <TableProperties v-else-if="tab.mode === 'vector'" />
  <KeyRound v-else-if="tab.mode === 'etcd' || tab.mode === 'zookeeper' || tab.mode === 'consul'" />
  <Gauge v-else-if="tab.mode === 'consul-overview' || tab.mode === 'etcd-dashboard' || tab.mode === 'mysql-dashboard' || tab.mode === 'postgres-dashboard' || tab.mode === 'nacos-dashboard'" />
  <ShieldCheck v-else-if="tab.mode === 'etcd-access-control'" />
  <Network v-else-if="tab.mode === 'nacos'" />
  <Database v-else-if="tab.mode === 'databases'" />
  <TableProperties v-else-if="tab.mode === 'objects'" />
  <PencilRuler v-else-if="tab.mode === 'structure'" />
  <CalendarClock v-else-if="tab.mode === 'dameng-jobs'" />
  <Activity v-else-if="tab.mode === 'processlist' || tab.mode === 'sqlserver-trace'" />
  <Gauge v-else-if="tab.mode === 'dolt-version-control'" />
  <Code2 v-else />
</template>
