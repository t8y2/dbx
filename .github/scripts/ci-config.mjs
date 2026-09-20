export const rustGroups = {
  foundation: ["dbx-types", "dbx-platform", "dbx-sql", "dbx-formats", "dbx-ai-provider", "dbx-plugin-runtime"],
  drivers: ["dbx-drivers", "dbx-sqlite-worker"],
  application: ["dbx", "dbx-core", "dbx-web", "dbx-cli", "dbx-mcp"],
};

export const goAgents = [
  { driver: "oracle-go", binary: "oracle", race: false },
  { driver: "xugu", binary: "xugu", race: false },
  { driver: "rabbitmq", binary: "rabbitmq", race: false },
  { driver: "rocketmq", binary: "rocketmq", race: true },
  { driver: "zookeeper", binary: "zookeeper", race: true },
  { driver: "cassandra-go", binary: "cassandra", race: false },
  { driver: "hive-go", binary: "hive", race: false },
  { driver: "vastbase-go", binary: "vastbase", race: false },
  { driver: "neo4j-go", binary: "neo4j", race: false },
  { driver: "iotdb", binary: "iotdb", race: false },
];

export const rustAgents = ["duckdb", "tdengine"];

export const integrationCases = [
  ...["3.4.14", "3.5.5", "3.7.0", "3.9.5"].map((version) => ({ driver: "zookeeper", scenario: "zookeeper", version })),
  { driver: "zookeeper", scenario: "zookeeper-sasl", version: "3.7.0" },
  ...["4.9.8", "5.3.1"].map((version) => ({ driver: "rocketmq", scenario: "rocketmq", version })),
  ...["2.4.0.14", "2.6.0.34", "3.0.7.1", "3.3.6.13", "3.4.2.2"].map((version) => ({
    driver: "tdengine", scenario: "tdengine", version,
    image: `tdengine/${version === "3.4.2.2" ? "tsdb" : "tdengine"}:${version}`,
  })),
  ...["3.11.19", "5.0.6"].map((version) => ({ driver: "cassandra-go", scenario: "cassandra", version })),
  ...["3.13", "4.3"].map((version) => ({ driver: "rabbitmq", scenario: "rabbitmq", version })),
];
