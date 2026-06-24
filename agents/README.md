# DBX Agents

Agent drivers for [DBX](https://github.com/t8y2/dbx) — database support via JDBC and native database drivers.

Each agent runs as a standalone process and communicates with DBX via stdin/stdout JSON-RPC 2.0.

## Supported Databases

| Agent | Database | JDBC Driver |
|-------|----------|-------------|
| access | Microsoft Access | UCanAccess |
| dameng | 达梦 DM8 | DM JDBC |
| kingbase | 人大金仓 KingbaseES | KingbaseES JDBC |
| vastbase | Vastbase | Vastbase JDBC |
| goldendb | GoldenDB | MySQL Connector/J |
| databend | Databend | Databend JDBC |
| databricks | Databricks SQL | Databricks JDBC |
| saphana | SAP HANA | SAP HANA JDBC |
| teradata | Teradata | Teradata JDBC |
| vertica | Vertica | Vertica JDBC |
| firebird | Firebird | Jaybird JDBC |
| exasol | Exasol | Exasol JDBC |
| oceanbase-oracle | OceanBase Oracle Mode | OceanBase JDBC |
| gbase8a | GBase 8a | External GBase 8a JDBC |
| gbase8s | GBase 8s | External GBase 8s JDBC |
| oracle | Oracle 10g+ | go-ora native agent |
| oracle-legacy | Oracle 11g/12c/18c/19c | ojdbc8 (compatibility fallback) |
| oracle-10g | Oracle 10g | ojdbc6 (compatibility fallback, JRE 8) |
| h2 | H2 | H2 JDBC |
| snowflake | Snowflake | Snowflake JDBC |
| trino | Trino (Presto) | Trino JDBC |
| hive | Apache Hive | Hive JDBC |
| db2 | IBM DB2 | DB2 JDBC |
| informix | IBM Informix | Informix JDBC |
| neo4j | Neo4j | Neo4j JDBC |
| cassandra | Apache Cassandra | Cassandra JDBC |
| bigquery | Google BigQuery | BigQuery JDBC |
| kylin | Apache Kylin | Kylin JDBC |
| sundb | SunDB | SunDB JDBC |
| gaussdb | GaussDB | GaussDB JDBC |
| tdengine | TDengine | taos-jdbcdriver (WebSocket, REST fallback) |
| yashandb | 崖山 YashanDB | YashanDB JDBC |
| xugu | 虚谷 XuguDB | XuguDB Go native agent |
| iotdb | Apache IoTDB | IoTDB JDBC |
| etcd | etcd | jetcd |
| zookeeper | Apache ZooKeeper | Apache Curator |


## Multi-JRE Support

Most Java agents target JRE 21. Native agents, such as `oracle` and `xugu`, do not require a JRE. Agents that still require legacy Java runtimes (e.g. compatibility fallback `oracle-10g` uses JRE 8) declare their JRE version in the registry. DBX downloads and manages multiple JRE installations automatically.

## Build

Requires JDK 8 and 21 (Gradle toolchain auto-downloads if needed).

```bash
./gradlew shadowJar
(cd drivers/oracle-go && go build -o agent .)
(cd drivers/xugu && go build -o agent .)
```

Output JARs are in `drivers/{module}/build/libs/`. Native agents build from `drivers/oracle-go` and `drivers/xugu`.

### Local DBX Runtime Test

When changing `agents/drivers/<db_type>/` or shared Java agent protocol code, rebuild the target agent and replace the runtime JAR used by the local DBX app:

```bash
./gradlew :<db_type>:shadowJar
cp ~/.dbx/agents/drivers/<db_type>/agent.jar ~/.dbx/agents/drivers/<db_type>/agent.jar.bak
cp agents/drivers/<db_type>/build/libs/*-all.jar ~/.dbx/agents/drivers/<db_type>/agent.jar
```

Restart DBX or disconnect and reconnect the database so the new agent process loads the replacement JAR.

## Development

- Agent authoring guide: [docs/agent-authoring.md](docs/agent-authoring.md)
- JDBC agent template: [docs/examples/jdbc-agent-template](docs/examples/jdbc-agent-template)
- Release checklist: [docs/release-checklist.md](docs/release-checklist.md)

## Architecture

```
DBX Main Process (Rust/Tauri)
    │ stdin/stdout (JSON-RPC 2.0)
    ▼
agent / java -jar dbx-agent-{type}.jar
    │
    ▼
Native driver / JDBC → Database
```

## License

[AGPL-3.0](https://github.com/t8y2/dbx/blob/main/LICENSE)
