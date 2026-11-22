import { connectionIconType } from "@/lib/connection/connectionPresentation";
import { databaseIconAssetName, databaseIconAssetPath } from "@/lib/database/databaseIconAssets";
import { databaseIconColors } from "@/lib/sidebar/databaseIconColors";
import type { SidebarConnectionIconStyle } from "@/stores/settingsStore";
import type { ConnectionConfig, TreeNode } from "@/types/database";

const badges = {
  mysql: { asset: "mysql", color: "#28d43b" },
  redis: { asset: "redis", color: "#983d48" },
  oracle: { asset: "oracle", color: "#ff003b" },
  sqlserver: { asset: "sqlserver", color: "#ffa600" },
  postgres: { asset: "postgres", color: "#3d6087" },
  sqlite: { asset: "sqlite", color: "#24566b" },
  mariadb: { asset: "mariadb", color: "#6b617c" },
  mongodb: { asset: "mongodb", color: "#286746" },
  snowflake: { asset: "snowflake", color: "#287f9e" },
  duckdb: { asset: "duckdb", color: "#79691c" },
  clickhouse: { asset: "clickhouse", color: "#927b18" },
  elasticsearch: { asset: "elasticsearch", color: "#216f72" },
  dynamodb: { asset: "dynamodb", color: "#654193" },
  tidb: { asset: "tidb", color: "#a9314b" },
  oceanbase: { asset: "oceanbase", color: "#346ace" },
  dm: { asset: "dm", color: "#374b99" },
  kingbase: { asset: "kingbase", color: "#a63943" },
  opengauss: { asset: "opengauss", color: "#28669b" },
  gaussdb: { asset: "gaussdb", color: "#70499f" },
  doris: { asset: "doris", color: "#2d7e95" },
  starrocks: { asset: "starrocks", color: "#286d75" },
  db2: { asset: "db2", color: "#315f9b" },
  h2: { asset: "h2", color: "#3a54a0" },
  neo4j: { asset: "neo4j", color: "#276e61" },
  bigquery: { asset: "bigquery", color: "#315ca8" },
  cassandra: { asset: "cassandra", color: "#24677f" },
  redshift: { asset: "redshift", color: "#3a5397" },
  databricks: { asset: "databricks", color: "#bd4935" },
  hive: { asset: "hive", color: "#8b711f" },
  trino: { asset: "trino", color: "#a04e7a" },
  influxdb: { asset: "influxdb", color: "#963b78" },
  cockroachdb: { asset: "cockroachdb", color: "#6553a2" },
  qdrant: { asset: "qdrant", color: "#a42b4c" },
  meilisearch: { asset: "meilisearch", color: "#8e4e91" },
  couchdb: { asset: "couchdb", color: "#b33945" },
  kafka: { asset: "kafka", color: "#43556c" },
  pulsar: { asset: "pulsar", color: "#285e9b" },
  spanner: { asset: "spanner", color: "#4769a4" },
  tdengine: { asset: "tdengine", color: "#386dad" },
} as const;

// Original assets with opaque panels or differently colored foreground details
// need a small mask adaptation instead of treating their entire alpha as white.
const basicAssetVariants: Readonly<Record<string, string>> = {
  "highgo.png": "highgo",
  "access.png": "access",
  "nebula.png": "nebula",
  "vertica.webp": "vertica",
  "gbase.png": "gbase",
  rabbitmq: "rabbitmq",
  rocketmq: "rocketmq",
  chromadb: "chromadb",
};

export type ConnectionBadgePresentation = {
  asset: string;
  color: string;
  src?: string;
  basic: boolean;
};

export function connectionBadge(connection?: Pick<ConnectionConfig, "db_type" | "driver_profile">): ConnectionBadgePresentation | undefined {
  if (!connection || connection.db_type === "plugin") return undefined;
  const type = connectionIconType(connection);
  // A provider such as MariaDB or Kafka has its own artwork. Unknown legacy
  // profiles fall back to their native database, rather than a generic icon.
  const resolvedType = databaseIconAssetName(type) ? type : connection.db_type;
  const asset = databaseIconAssetName(resolvedType);
  if (asset && Object.prototype.hasOwnProperty.call(badges, asset)) {
    const badge = badges[asset as keyof typeof badges];
    return { ...badge, src: `/icons/database/sidebar/${badge.asset}.svg`, basic: false };
  }
  const variant = asset && basicAssetVariants[asset];
  return {
    asset: asset?.replace(/\.[^.]+$/, "") || "generic",
    color: (asset && databaseIconColors[asset]) || "#315f9b",
    src: variant ? `/icons/database/sidebar/${variant}.svg` : databaseIconAssetPath(resolvedType),
    basic: true,
  };
}

export function sidebarTreeIconSize(nodeType: TreeNode["type"], connection: Pick<ConnectionConfig, "db_type"> | undefined, style: SidebarConnectionIconStyle): number {
  if (nodeType === "connection-group") return 16;
  if (nodeType !== "connection" || style !== "badge" || !connection || connection.db_type === "plugin") return 14;
  return 16;
}
