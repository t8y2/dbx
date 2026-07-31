<script setup lang="ts">
import { computed } from "vue";
import { Database } from "@lucide/vue";
import { useTheme } from "@/composables/useTheme";
import { webPath } from "@/lib/common/webPath";

const props = defineProps<{
  dbType: string;
}>();
const { isDark } = useTheme();

const assetIcons: Record<string, string> = {
  mysql: "mysql",
  postgres: "postgres",
  postgresql: "postgres",
  cloudberry: "cloudberry",
  sqlite: "sqlite",
  rqlite: "rqlite.png",
  turso: "turso.png",
  cloudflare_d1: "cloudflare-d1",
  redis: "redis",
  mongodb: "mongodb",
  mongodb_legacy: "mongodb",
  clickhouse: "clickhouse",
  duckdb: "duckdb",
  mariadb: "mariadb",
  tidb: "tidb",
  elasticsearch: "elasticsearch",
  easysearch: "easysearch",
  oracle: "oracle",
  "oracle-10g": "oracle",
  "oracle-legacy": "oracle",
  oracle_10g: "oracle",
  oracle_legacy: "oracle",
  sqlserver: "sqlserver",
  access: "access.png",
  oceanbase: "oceanbase",
  opengauss: "opengauss",
  gaussdb: "gaussdb",
  questdb: "questdb",
  kwdb: "kwdb",
  kingbase: "kingbase",
  highgo: "highgo.png",
  uxdb: "uxdb",
  goldendb: "goldendb.png",
  databend: "databend",
  vastbase: "vastbase",
  yashandb: "yashandb.png",
  snowflake: "snowflake",
  h2: "h2",
  dm: "dm",
  dameng: "dm",
  presto: "presto",
  prestosql: "presto",
  hive: "hive",
  hbase: "hbase",
  spark: "spark-logo.png",
  apache_kylin: "apache_kylin",
  sundb: "sundb",
  trino: "trino",
  kylin: "apache_kylin",
  cockroachdb: "cockroachdb",
  db2: "db2",
  dremio: "dremio",
  bigquery: "bigquery",
  cassandra: "cassandra",
  doris: "doris",
  manticoresearch: "manticoresearch.png",
  selectdb: "selectdb",
  tdengine: "tdengine",
  starrocks: "starrocks",
  redshift: "redshift",
  neo4j: "neo4j",
  informix: "informix",
  databricks: "databricks",
  saphana: "saphana",
  teradata: "teradata",
  vertica: "vertica.webp",
  firebird: "firebird",
  exasol: "exasol",
  gbase: "gbase.png",
  gbase8a: "gbase.png",
  gbase8s: "gbase.png",
  tdsql: "tdsql",
  polardb: "polardb.webp",
  greatsql: "greatsql.webp",
  xugu: "xugu.png",
  iotdb: "iotdb",
  etcd: "etcd",
  qdrant: "qdrant",
  milvus: "milvus.png",
  weaviate: "weaviate",
  chromadb: "chromadb",
  mq: "pulsar",
  pulsar: "pulsar",
  kafka: "kafka",
  rocketmq: "rocketmq",
  rabbitmq: "rabbitmq",
  nacos: "nacos.png",
  iris: "iris",
  influxdb: "influxdb",
  zookeeper: "zookeeper",
  oscar: "oscar.png",
  jdbcx: "jdbcx",
};

const normalizedType = computed(() => props.dbType.toLowerCase().replace(/[\s-]+/g, "_"));
const assetName = computed(() => assetIcons[normalizedType.value]);
const useLightIconInDarkMode = computed(() => normalizedType.value === "easysearch" && isDark.value);
const assetSrc = computed(() => {
  if (!assetName.value) return "";
  if (normalizedType.value === "uxdb" && isDark.value) return webPath("/icons/database/uxdb-dark.svg");
  return webPath(assetName.value.includes(".") ? `/icons/database/${assetName.value}` : `/icons/database/${assetName.value}.svg`);
});
</script>

<template>
  <img v-if="assetName" :src="assetSrc" alt="" class="database-logo object-contain" :class="{ 'database-logo-light': useLightIconInDarkMode }" aria-hidden="true" />
  <Database v-else class="text-blue-400" />
</template>

<style scoped>
.database-logo {
  transform: scale(1.35);
  transform-origin: center;
}

.database-logo-light {
  filter: brightness(0) invert(82%);
}
</style>
