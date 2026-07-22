<script setup lang="ts">
import { computed } from "vue";
import { Database } from "@lucide/vue";
import { webPath } from "@/lib/common/webPath";

const props = defineProps<{
  dbType: string;
}>();

const assetIcons: Record<string, string> = {
  mysql: "mysql",
  postgres: "postgres",
  postgresql: "postgres",
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
  goldendb: "goldendb.png",
  databend: "databend",
  vastbase: "vastbase.png",
  yashandb: "yashandb.png",
  snowflake: "snowflake",
  h2: "h2",
  dm: "dm",
  dameng: "dm",
  presto: "presto",
  prestosql: "presto",
  hive: "hive",
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
  databricks: "databricks.webp",
  saphana: "saphana.webp",
  teradata: "teradata.webp",
  vertica: "vertica.webp",
  firebird: "firebird.webp",
  exasol: "exasol.webp",
  gbase: "gbase.webp",
  gbase8a: "gbase.webp",
  gbase8s: "gbase.webp",
  tdsql: "tdsql.webp",
  polardb: "polardb.webp",
  greatsql: "greatsql.webp",
  xugu: "xugu.png",
  iotdb: "iotdb",
  etcd: "etcd",
  qdrant: "qdrant",
  milvus: "milvus.png",
  weaviate: "weaviate.png",
  chromadb: "chromadb",
  mq: "pulsar",
  pulsar: "pulsar",
  kafka: "kafka",
  rocketmq: "rocketmq",
  rabbitmq: "rabbitmq",
  nacos: "nacos.png",
  iris: "iris.png",
  influxdb: "influxdb",
  zookeeper: "zookeeper",
  jdbcx: "jdbcx",
};

const letterIcons: Record<string, { letter: string; color: string }> = {
  oscar: { letter: "O", color: "#2563eb" },
};

const normalizedType = computed(() => props.dbType.toLowerCase().replace(/[\s-]+/g, "_"));
const assetName = computed(() => assetIcons[normalizedType.value]);
const assetSrc = computed(() => {
  if (!assetName.value) return "";
  return webPath(assetName.value.includes(".") ? `/icons/database/${assetName.value}` : `/icons/database/${assetName.value}.svg`);
});
const letter = computed(() => letterIcons[normalizedType.value]);
</script>

<template>
  <img v-if="assetName" :src="assetSrc" alt="" class="database-logo object-contain" aria-hidden="true" />
  <svg v-else-if="letter" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="12" :fill="letter.color" />
    <text x="12" y="16.5" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="system-ui, sans-serif">
      {{ letter.letter }}
    </text>
  </svg>
  <Database v-else class="text-blue-400" />
</template>

<style scoped>
.database-logo {
  transform: scale(1.35);
  transform-origin: center;
}
</style>
