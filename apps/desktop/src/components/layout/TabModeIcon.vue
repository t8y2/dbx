<script setup lang="ts">
import { Activity, AlertTriangle, CalendarClock, Code2, Database, Eye, FunctionSquare, Gauge, KeyRound, ListOrdered, Network, PencilRuler, ShieldCheck, Table, TableProperties, Zap } from "@lucide/vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { tabDatabaseIconType } from "@/lib/tabs/tabPresentation";
import type { QueryTab } from "@/types/database";

// Mirrors EditorGroupTabBar's per-mode tab icon chain so surfaces outside the
// group bar (e.g. the special-page strip's return tabs) render identical icons.
defineProps<{ tab: QueryTab }>();
</script>

<template>
  <AlertTriangle v-if="tab.externalSqlFileMissing" />
  <Eye v-else-if="tab.objectSource?.objectType === 'VIEW' || tab.objectSource?.objectType === 'MATERIALIZED_VIEW' || tab.tableMeta?.tableType?.toUpperCase() === 'VIEW' || tab.tableMeta?.tableType?.toUpperCase() === 'MATERIALIZED_VIEW'" />
  <Database v-else-if="tab.mode === 'redis'" />
  <Table v-else-if="tab.mode === 'data' || tab.mode === 'mongo' || tab.mode === 'hbase'" />
  <DatabaseIcon v-else-if="tab.mode === 'mq'" :db-type="tabDatabaseIconType(tab)" />
  <TableProperties v-else-if="tab.mode === 'vector'" />
  <KeyRound v-else-if="tab.mode === 'etcd' || tab.mode === 'zookeeper' || tab.mode === 'consul'" />
  <Gauge v-else-if="tab.mode === 'consul-overview' || tab.mode === 'etcd-dashboard' || tab.mode === 'mysql-dashboard' || tab.mode === 'postgres-dashboard' || tab.mode === 'nacos-dashboard'" />
  <ShieldCheck v-else-if="tab.mode === 'etcd-access-control'" />
  <Network v-else-if="tab.mode === 'nacos'" />
  <Database v-else-if="tab.mode === 'databases'" />
  <TableProperties v-else-if="tab.mode === 'objects'" />
  <PencilRuler v-else-if="tab.mode === 'structure'" />
  <FunctionSquare v-else-if="tab.objectSource?.objectType === 'PROCEDURE' || tab.objectSource?.objectType === 'FUNCTION'" />
  <Zap v-else-if="tab.objectSource?.objectType === 'TRIGGER'" />
  <CalendarClock v-else-if="tab.objectSource?.objectType === 'EVENT' || tab.objectSource?.objectType === 'JOB'" />
  <ListOrdered v-else-if="tab.objectSource?.objectType === 'SEQUENCE'" />
  <CalendarClock v-else-if="tab.mode === 'dameng-jobs'" />
  <Activity v-else-if="tab.mode === 'processlist' || tab.mode === 'sqlserver-trace'" />
  <Gauge v-else-if="tab.mode === 'dolt-version-control'" />
  <Code2 v-else />
</template>
