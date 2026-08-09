import fs from "node:fs";

const extraAliases = {
  mysql: [
    "mariadb",
    "percona",
    "tidb",
    "greatsql",
    "oceanbase mysql",
    "oceanbase mysql mode",
    "oceanbase mysql 模式",
    "tdsql mysql",
    "tdsql-mysql",
    "polardb mysql",
    "polardb for mysql",
    "polardb-x",
    "polardbx",
  ],
  postgres: [
    "postgresql",
    "postgres",
    "pgsql",
    "pg",
    "hologres",
    "cloudberry",
    "apache cloudberry",
    "cockroachdb",
    "cockroach db",
    "polardb postgresql",
    "polardb for postgresql",
    "polardb postgres",
    "polardb for postgres",
  ],
  sqlite: ["sqlite3", "sql lite"],
  clickhouse: ["click house", "ch"],
  sqlserver: ["sql server", "mssql", "microsoft sql server", "sqlservice"],
  mongodb: ["mongo", "mongodb"],
  oracle: ["oracle database"],
  elasticsearch: ["elastic search"],
  chromadb: ["chroma"],
  doris: ["selectdb"],
  manticoresearch: ["manticore"],
  dameng: ["dm8", "dameng", "达梦"],
  kingbase: ["kingbasees", "kingbase", "人大金仓", "金仓"],
  highgo: ["瀚高"],
  yashandb: ["yashan", "崖山"],
  saphana: ["hana", "sap hana"],
  opengauss: ["open gauss"],
  "oceanbase-oracle": ["oceanbase oracle", "oceanbase oracle mode", "oceanbase oracle 模式"],
  gbase: ["gbase 8a", "gbase8a", "gbase 8s", "gbase8s"],
  access: ["microsoft access", "ms access"],
  vastbase: ["vastbase g", "vastbaseg"],
  prestosql: ["presto", "presto sql"],
  hive: ["apache hive"],
  db2: ["ibm db2"],
  informix: ["ibm informix"],
  bigquery: ["google bigquery"],
  kylin: ["apache kylin"],
  oscar: ["shentong", "oscar", "神通"],
  xugu: ["xugudb", "xugu", "虚谷"],
  zookeeper: ["zoo keeper", "apache zookeeper"],
  mq: ["message queue", "pulsar", "kafka", "rabbitmq", "rocketmq"],
  iotdb: ["apache iotdb"],
  iris: ["intersystems iris", "intersystems cache", "intersystems caché", "cache", "caché", "ensemble"],
  jdbc: ["dremio", "jdbcx"],
  spark: ["apache spark"],
};

const supplementalDrivers = [
  { dbType: "turso", label: "Turso", aliases: ["libsql", "lib sql"] },
  { dbType: "nacos", label: "Nacos", aliases: ["r-nacos", "rnacos"] },
  { dbType: "consul", label: "Consul", aliases: ["hashicorp consul"] },
  { dbType: "cloudberry", label: "Apache Cloudberry" },
  { dbType: "mariadb", label: "MariaDB" },
  { dbType: "tidb", label: "TiDB" },
  { dbType: "oceanbase", label: "OceanBase" },
  { dbType: "tdsql", label: "TDSQL" },
  { dbType: "polardb", label: "PolarDB", aliases: ["polardb-x", "polardbx"] },
  { dbType: "greatsql", label: "GreatSQL" },
  { dbType: "selectdb", label: "SelectDB" },
  { dbType: "cockroachdb", label: "CockroachDB", aliases: ["cockroach db"] },
  { dbType: "dremio", label: "Dremio" },
  { dbType: "jdbcx", label: "JDBCX" },
  { dbType: "pulsar", label: "Apache Pulsar" },
  { dbType: "kafka", label: "Apache Kafka" },
  { dbType: "rocketmq", label: "Apache RocketMQ" },
  { dbType: "rabbitmq", label: "RabbitMQ" },
  { dbType: "mqtt", label: "MQTT", aliases: ["emqx", "hivemq", "mosquitto"] },
];

const manifestUrl = new URL("../../crates/dbx-core/assets/database-drivers.manifest.json", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8"));
const catalogEntries = [...manifest.drivers, ...supplementalDrivers];
const duplicateDbTypes = catalogEntries
  .map((driver) => driver.dbType)
  .filter((dbType, index, values) => values.indexOf(dbType) !== index);

if (duplicateDbTypes.length > 0) {
  throw new Error(`Duplicate database issue catalog entries: ${[...new Set(duplicateDbTypes)].join(", ")}`);
}

export const databaseIssueDrivers = catalogEntries.map((driver) => ({
  dbType: driver.dbType,
  label: driver.label,
  aliases: [
    ...new Set([
      driver.dbType,
      driver.label,
      ...(driver.aliases || []),
      ...(extraAliases[driver.dbType] || []),
    ]),
  ],
}));
