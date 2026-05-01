<script setup lang="ts">
import { computed } from "vue";
import { Database } from "lucide-vue-next";

const props = defineProps<{
  dbType: string;
}>();

const assetIcons: Record<string, string> = {
  mysql: "mysql",
  postgres: "postgres",
  postgresql: "postgres",
  sqlite: "sqlite",
  redis: "redis",
  mongodb: "mongodb",
  clickhouse: "clickhouse",
  duckdb: "duckdb",
  mariadb: "mariadb",
  tidb: "tidb",
  elasticsearch: "elasticsearch",
  oracle: "oracle",
  sqlserver: "sqlserver",
  oceanbase: "oceanbase",
  opengauss: "opengauss",
  gaussdb: "gaussdb",
  kingbase: "kingbase",
  snowflake: "snowflake",
  h2: "h2",
  dm: "dm",
  presto: "presto",
  hive: "hive",
  apache_kylin: "apache_kylin",
  sundb: "sundb",
  cockroachdb: "cockroachdb",
  db2: "db2",
  bigquery: "bigquery",
  cassandra: "cassandra",
  doris: "doris",
  selectdb: "selectdb",
  tdengine: "tdengine",
  starrocks: "starrocks",
  redshift: "redshift",
  neo4j: "neo4j",
  informix: "informix",
};

const letterIcons: Record<string, { letter: string; color: string }> = {
  goldendb: { letter: "G", color: "#F59E0B" },
  vastbase: { letter: "V", color: "#6D28D9" },
};

const normalizedType = computed(() => props.dbType.toLowerCase().replace(/[\s-]+/g, "_"));
const assetName = computed(() => assetIcons[normalizedType.value]);
const letter = computed(() => letterIcons[normalizedType.value]);
</script>

<template>
  <img
    v-if="assetName"
    :src="`/icons/database/${assetName}.svg`"
    alt=""
    class="database-logo object-contain"
    aria-hidden="true"
  >
  <svg v-else-if="letter" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="12" :fill="letter.color" />
    <text x="12" y="16.5" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="system-ui, sans-serif">{{ letter.letter }}</text>
  </svg>
  <Database v-else class="text-blue-400" />
</template>

<style scoped>
.database-logo {
  transform: scale(1.35);
  transform-origin: center;
}
</style>
