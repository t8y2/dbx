# DBX Agents

[English](README.md) | 简体中文

DBX 的 Agent 驱动 —— 通过 JDBC 和原生数据库驱动支持各种数据库。

每个 agent 作为独立进程运行，通过 stdin/stdout 与 DBX 进行 JSON-RPC 2.0 通信。

## 支持的数据库

| Agent | 数据库 | 驱动 |
|-------|----------|-------------|
| access | Microsoft Access | UCanAccess |
| dameng | 达梦 DM8 | DM JDBC |
| kingbase | 人大金仓 KingbaseES | gokb Go 原生 agent |
| vastbase | Vastbase | Vastbase JDBC |
| goldendb | GoldenDB | MySQL Connector/J |
| databend | Databend | Databend JDBC |
| databricks | Databricks SQL | Databricks JDBC |
| saphana | SAP HANA | SAP HANA JDBC |
| teradata | Teradata | Teradata JDBC |
| vertica | Vertica | Vertica JDBC |
| firebird | Firebird | Jaybird JDBC |
| exasol | Exasol | Exasol JDBC |
| oceanbase-oracle | OceanBase Oracle 模式 | OceanBase JDBC |
| gbase8a | GBase 8a | 外部 GBase 8a JDBC |
| gbase8s | GBase 8s | 外部 GBase 8s JDBC |
| oracle | Oracle 10g+ | go-ora 原生 agent |
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
| tdengine | TDengine | taos-jdbcdriver（WebSocket，REST 兜底） |
| yashandb | 崖山 YashanDB | YashanDB JDBC |
| xugu | 虚谷 XuguDB | XuguDB Go 原生 agent |
| iotdb | Apache IoTDB | IoTDB JDBC |
| etcd | etcd | jetcd |
| zookeeper | Apache ZooKeeper | Apache Curator |
| rabbitmq | RabbitMQ | RabbitMQ AMQP Java client |


## 多 JRE 支持

多数 Java agent 以 JRE 21 为目标。原生 agent（如 `oracle`、`kingbase` 和 `xugu`）不需要 JRE。对 Java agent，DBX 会自动下载并管理 JRE 21 安装。

## 选择驱动实现语言

对于新 agent，只要存在成熟、许可证兼容的原生驱动，优先选择**原生（Go 或 Rust）驱动**而非 Java/JDBC agent。原生 agent 以单一自包含可执行文件发布，无需 JRE，可显著降低内存占用和启动时间 —— 完全避开 Java agent 即便空闲也要付出的 JVM 基线开销。

- **原生（Go/Rust）** —— 存在可用原生驱动时首选。参考 `drivers/oracle-go`（go-ora）、`drivers/kingbase-go`（gokb）和 `drivers/xugu`。无需 JRE 下载与管理。
- **Java/JDBC** —— 当某数据库只有 JDBC 驱动，或原生驱动不成熟、缺乏维护时的默认兜底方案。多数 agent 仍属此类。

原生 agent 实现与 Java agent 相同的 JSON-RPC 契约和 `versions.json` 登记；它发布的是 `agent` 可执行文件而非 `agent.jar`。若同一数据库同时保留原生和 Java 源码实现，默认只发布原生产物；只有 Java 变体以独立兼容配置登记时才同时发布，例如 `oracle-legacy` / `oracle-10g`。

## 构建

需要 JDK 21（Gradle toolchain 会自动下载）。

```bash
./gradlew shadowJar
(cd drivers/oracle-go && go build -o agent .)
(cd drivers/kingbase-go && go build -o agent .)
(cd drivers/xugu && go build -o agent .)
```

产物 JAR 在 `drivers/{module}/build/libs/`。原生 agent 从 `drivers/oracle-go`、`drivers/kingbase-go` 和 `drivers/xugu` 构建。

### 本地 DBX 运行时测试

修改 `agents/drivers/<db_type>/` 下的 Java agent 或共享 Java agent 协议代码后，需重新构建目标 agent 并替换本地 DBX 应用使用的运行时 JAR：

```bash
./gradlew :<db_type>:shadowJar
cp ~/.dbx/agents/drivers/<db_type>/agent.jar ~/.dbx/agents/drivers/<db_type>/agent.jar.bak
cp agents/drivers/<db_type>/build/libs/*-all.jar ~/.dbx/agents/drivers/<db_type>/agent.jar
```

重启 DBX 或断开重连数据库，使新 agent 进程加载替换后的 JAR。

`oracle`、`kingbase` 和 `xugu` 等原生 agent 使用驱动目录下的 `agent` 可执行文件而非 `agent.jar`。

## 版本管理

Agent 模块的版本记录在 [`versions.json`](versions.json) 中，遵循以下规则：

- **修改现有驱动**：无需手动编辑 `versions.json`。发版 CI 会把每个 `drivers/<module>/` 目录与上一个 tag 做对比，对有变更的模块自动 bump patch 版本号（见 [`bump-agent-versions.mjs`](../.github/scripts/bump-agent-versions.mjs)）。若改动的是共享运行时 `agents/common`，所有依赖它的模块会一并 bump。
- **新增驱动**：在 `versions.json` 中新增一行，例如 `"rabbitmq": "0.1.0"`。CI 只 bump 文件里已存在的 key，所以新模块在登记到这里之前对版本管理完全不可见。同一次改动中，还要把模块加进 `settings.gradle` 并更新上方的支持表 —— `versions.json` 的 key 必须与 `settings.gradle` 声明的 agent 模块一致（不含 `common`、`test-support` 这类基础设施模块）。

## 开发

- Agent 编写指南：[docs/agent-authoring.md](docs/agent-authoring.md)
- JDBC agent 模板：[docs/examples/jdbc-agent-template](docs/examples/jdbc-agent-template)
- 发布检查清单：[docs/release-checklist.md](docs/release-checklist.md)

## 架构

```
DBX 主进程 (Rust/Tauri)
    │ stdin/stdout (JSON-RPC 2.0)
    ▼
agent / java -jar dbx-agent-{type}.jar
    │
    ▼
原生驱动 / JDBC → 数据库
```

## 许可证

[AGPL-3.0](https://github.com/t8y2/dbx/blob/main/LICENSE)
