# Agent 编写指南

本指南定义了 DBX Agent 的预期形态，可作为新增或评审 Agent 时的清单使用。

## Agent 契约

每个 Agent 都是独立的 JVM 进程，需要满足：

- 实现 `com.dbx.agent.DatabaseAgent`。
- 标准 JDBC Agent 优先继承 `com.dbx.agent.ConfiguredJdbcAgent`。
- 当数据库需要自定义元数据 SQL 但仍可复用生命周期与执行行为时，继承 `com.dbx.agent.AbstractJdbcAgent`。
- 在 `main` 方法中以 `new JsonRpcServer(new <Agent>()).run()` 启动。
- 通过 stdin/stdout 与 DBX 通信，遵循 JSON-RPC 2.0 协议。
- 除非模块明确设计为非 JDBC 协议，否则使用 JDBC 访问数据库。
- 输出一个名为 `dbx-agent-<agent-name>.jar` 的 shadow JAR。

即使每个数据库的 SQL 方言不同，Agent 的对外行为也应保持一致。

## 必需方法

每个 Agent 必须实现以下能力：

- `connect(params)`：标准 JDBC Agent 由共享 JDBC 基础统一处理。
- `testConnection(params)`：标准 JDBC Agent 由共享 JDBC 基础统一处理。
- `listDatabases()`：当数据库支持 catalog/database 时返回可见列表，否则返回一个合理的默认数据库。
- `listSchemas()`：按稳定顺序返回 schema。
- `listTables(schema)`：返回所选 schema 下的表对象，尽可能对 `type` 做归一化。
- `getColumns(schema, table)`：返回列元数据、是否可空、默认值、键标志、数值精度/标度、字符长度以及可用时的注释。
- `listIndexes(schema, table)`：每个索引返回一个 `IndexInfo`，保留列顺序。
- `listForeignKeys(schema, table)`：可用时返回外键（出向）。
- `listTriggers(schema, table)`：可用时返回触发器；若数据库无触发器元数据，返回空列表。
- `executeQuery(sql, schema, options)`：除非 Agent 有文档化的自定义执行行为，否则继承共享 JDBC 基础。
- `disconnect()`：继承共享 JDBC 基础。
- `getConnection()`：继承共享 JDBC 基础。

当方法需要连接而当前没有连接时，抛出 `IllegalStateException("Not connected")`。

## SQL 执行规则

不要在各个 Agent 内部按 SQL 前缀分类语句。

对于大多数 JDBC Agent，从 `AbstractJdbcAgent` 或 `ConfiguredJdbcAgent` 继承即可，不要把执行方法复制到 Agent 类中。如果需要自定义值读取器，重写 `resultValue(...)`：

```java
@Override
protected Object resultValue(ResultSet rs, int index, int sqlType) {
    return unchecked(() -> rs.getString(index));
}
```

对于简单的标准 JDBC 元数据 Agent，可以从一个 profile 起步：

```java
public final class ExampleAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile EXAMPLE_PROFILE = new JdbcAgentProfile(
        "com.example.Driver",
        "jdbc:example://{host}:{port}/{database}",
        1234
    );

    public ExampleAgent() {
        super(EXAMPLE_PROFILE);
    }
}
```

`JdbcExecutor` 统一处理以下行为：

- 执行前去除语句末尾的分号。
- 处理 `BEGIN`、`COMMIT`、`ROLLBACK`。
- 在用户语句前运行 schema 切换 SQL。
- 使用 `Statement.execute(...)` 执行语句。
- 读取任意语句类型的 `ResultSet`，不仅限于 `SELECT`。
- 更新语句返回 update count。
- 将结果行数限制为 `options.maxRows`，默认 `JdbcExecutor.DEFAULT_MAX_ROWS`。
- 当提供 `options.fetchSize` 时应用到 JDBC Statement。
- 仅当超过上限仍有更多行时，将 `truncated` 标记为 `true`。

Agent 不得重新引入以下本地副本：

- `QUERY_PREFIXES`
- `MAX_ROWS`
- 在 `executeQuery` 中的 `executeUpdate(trimmedSql)`
- 基于 `rows.size >= MAX_ROWS` 的结果截断
- 共享基础扩展点之外的 `Class.forName(...)` / `DriverManager.getConnection(...)` 生命周期样板
- JDBC Agent 中 `disconnect()` 的本地副本
- 标准查询执行中的 `JdbcExecutor.INSTANCE.execute(...)` 本地副本

## Schema 与标识符规则

如果数据库方言特殊，重写 `setSchemaSQL(schema)`；如果标准引号足够，则在 profile 方言选项中配置。

需要为标识符加引号时使用 `JdbcIdentifiers` 辅助类：

```java
@Override
public String setSchemaSQL(String schema) {
    return "SET SCHEMA " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
}
```

如果数据库不支持 schema 切换语句，返回空字符串：

```java
@Override
public String setSchemaSQL(String schema) {
    return "";
}
```

除非目标数据库必须使用未加引号的标识符，并且该值已经过校验，否则不要把未经引号处理的、由用户提供的 schema 名拼接到 schema 切换 SQL 中。

对于元数据查询，优先对 `schema`、`table` 等用户可控值使用预编译语句。

## 共享 JDBC 基础

选择与数据库匹配的最小的共享基类：

- `ConfiguredJdbcAgent`：标准 JDBC 生命周期、执行与基于 `DatabaseMetaData` 的标准元数据。
- `PostgresLikeAgent`：PostgreSQL 系列的元数据，共享生命周期与执行。
- `AbstractJdbcAgent`：自定义元数据 SQL，共享生命周期、执行、分页、事务、结果转换以及 DDL 回退。

如果某个数据库暂时无法使用共享基础，需要将其加入校验白名单，并附带具体原因和覆盖自定义行为的测试。模块迁移后移除白名单条目。

## 驱动打包

每个模块从两种驱动模式中选择一种。

### 内置驱动

当驱动可以从 Maven Central 或其他允许的仓库再发行时使用：

```groovy
dependencies {
    implementation 'com.example:example-jdbc:1.2.3'
}
```

根 Gradle 约定会自动提供 `project(':common')`、`project(':test-support')`、JUnit、Java toolchain、Shadow 插件，以及已包含 Agent 模块的 `dbx-agent-<module>` 归档名。

无需 manifest 标志。

### 外部驱动

当驱动不能被再发行或必须由用户自行提供时使用：

```groovy
dependencies {
    implementation fileTree(dir: 'libs', include: ['*.jar'])
}

tasks.named('shadowJar') {
    manifest {
        attributes(
            'Agent-Label': 'Example DB',
            'Agent-External-Driver': 'true',
            'Main-Class': 'com.dbx.agent.example.ExampleAgent'
        )
    }
}
```

发布工作流会读取 `Agent-External-Driver: true`，并在 `agent-registry.json` 中输出 `external_driver_required: true`。

## 模块注册

新增名为 `exampledb` 的 Agent 时：

- 在 `drivers/exampledb` 下创建模块。
- 将 `exampledb` 加入 `settings.gradle` 的 `driverModules`。
- 在 `versions.json` 中添加 `"exampledb": "0.1.0"`。
- 将 `Agent-Label` 设置为面向用户的数据库名称。
- 将 `Main-Class` 设置为 Java Agent 类，通常是 `com.dbx.agent.exampledb.ExampledbAgent`。
- 将该数据库加入 README 的支持列表。

根 `build.gradle` 约定会根据模块名派生归档名，因此 `exampledb` 会自动构建出 `dbx-agent-exampledb.jar`，无需在每个模块单独配置归档名。

`versions.json` 只能包含 `settings.gradle` 中登记的模块，不包括 `common`、`test-support` 等基础设施模块。

## 运行时选择

默认配置如下：

```groovy
def java8Projects = ['common', 'test-support'] as Set

subprojects {
    java {
        toolchain {
            languageVersion = JavaLanguageVersion.of(java8Projects.contains(name) ? 8 : 21)
        }
    }
}
```

大多数 Agent 使用 JRE 21。如果某个 Agent 需要特殊的运行时，请更新根 Gradle 约定、发布工作流的 JRE 检测逻辑，并在该模块中记录原因。

## 测试

每个 JDBC Agent 至少应有一个执行路径回归测试。

对于可以使用嵌入式或内存数据库运行的 Agent，建议同时采用以下两个共享行为契约：

```java
import java.util.List;

class H2ExecutionBehaviorTest extends JdbcExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createConnectedAgent(String databaseName) {
        return H2AgentFixtures.createConnectedAgent(databaseName);
    }

    @Override
    protected String resultSetSql() {
        return "CALL 42";
    }

    @Override
    protected List<String> expectedResultSetColumns() {
        return List.of("42");
    }

    @Override
    protected List<List<Object>> expectedResultSetRows() {
        return List.of(List.of(42));
    }

    @Override
    protected String rowsSql(int rowCount) {
        return "SELECT X FROM SYSTEM_RANGE(1, " + rowCount + ")";
    }
}

class H2MetadataBehaviorTest extends JdbcMetadataBehaviorTest {
    @Override
    protected DatabaseAgent createConnectedAgent(String databaseName) {
        return H2AgentFixtures.createConnectedAgent(databaseName);
    }

    @Override
    protected List<String> metadataFixtureSql() {
        return List.of(
            "CREATE TABLE BETA_TABLE (ID INT PRIMARY KEY)",
            "CREATE TABLE ALPHA_TABLE (ID INT PRIMARY KEY)",
            "CREATE TABLE COLUMN_ORDER_SAMPLE (ID INT PRIMARY KEY, NAME VARCHAR(64), CREATED_AT TIMESTAMP)"
        );
    }

    @Override
    protected String metadataSchema() {
        return "PUBLIC";
    }

    @Override
    protected List<String> expectedTablesInOrder() {
        return List.of("ALPHA_TABLE", "BETA_TABLE", "COLUMN_ORDER_SAMPLE");
    }

    @Override
    protected String metadataColumnsTable() {
        return "COLUMN_ORDER_SAMPLE";
    }

    @Override
    protected List<String> expectedColumnsInOrder() {
        return List.of("ID", "NAME", "CREATED_AT");
    }
}

final class H2AgentFixtures {
    private H2AgentFixtures() {
    }

    static DatabaseAgent createConnectedAgent(String databaseName) {
        H2Agent agent = new H2Agent();
        agent.connect(new ConnectParams("mem:" + databaseName + ";DB_CLOSE_DELAY=-1"));
        return agent;
    }
}
```

`JdbcExecutionBehaviorTest` 验证非 `SELECT` 结果集执行、最大行截断边界以及事务控制语句。`JdbcMetadataBehaviorTest` 验证稳定的元数据排序。本地测试基础设施受限的 Agent 可以先采用执行契约，事后补充元数据契约。

对于无法使用商业或外部驱动的 Agent，请使用 fake 执行契约：

```java
class ExampleAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new ExampleAgent();
    }

    @Override
    protected String resultSetSql() {
        return "SHOW TABLES";
    }
}
```

`JdbcFakeExecutionBehaviorTest` 注入一个 fake JDBC 连接，验证 `executeQuery` 使用 `Statement.execute`、读取返回的 `ResultSet`，并且不会回退到 `executeQuery` 或 `executeUpdate`。该契约需要 `testImplementation project(':test-support')`。

## 评审清单

在打开 PR 或发布前确认：

- `executeQuery` 委托给 `JdbcExecutor.execute`。
- 不存在本地 SQL 前缀分类器。
- 除数据库特定原因并在代码中注释外，不存在本地结果行上限。
- 元数据方法对用户可控的 schema/table 输入使用预编译语句。
- `setSchemaSQL` 会为标识符加引号或返回空字符串。
- `disconnect` 关闭并清除连接。
- `testConnection` 关闭其临时连接。
- 根 `build.gradle` 约定覆盖了 Java 插件、toolchain、JUnit、common/test-support 依赖、Shadow 插件以及归档名。
- 模块的 `build.gradle` 配置了正确的驱动依赖、`Agent-Label`、`Main-Class` 以及外部驱动标志。
- `settings.gradle`、`versions.json`、README 同步更新。
- 至少有一个执行路径回归测试。
- `python3 scripts/validate_agents.py` 通过。
- `./gradlew test shadowJar --continue` 通过。