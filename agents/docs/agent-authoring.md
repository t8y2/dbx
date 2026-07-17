# Agent Authoring Guide

This guide defines the expected shape of a DBX agent. Treat it as the checklist for adding or reviewing an agent.

## Agent Contract

Every agent is a standalone JVM process that:

- Implements `com.dbx.agent.DatabaseAgent`.
- Prefer extending `com.dbx.agent.ConfiguredJdbcAgent` for standard JDBC agents.
- Extend `com.dbx.agent.AbstractJdbcAgent` when the database needs custom metadata SQL but can still share lifecycle and execution behavior.
- Starts with `new JsonRpcServer(new <Agent>()).run()` in its `main` method.
- Talks to DBX over stdin/stdout JSON-RPC 2.0.
- Uses JDBC for database access unless the module is explicitly designed around a non-JDBC protocol.
- Produces one shadow JAR named `dbx-agent-<agent-name>.jar`.

The public behavior should be consistent across agents even when each database has different SQL dialects.

## Required Methods

Each agent must implement these capabilities:

- `connect(params)`: handled by the shared JDBC foundation for JDBC agents.
- `testConnection(params)`: handled by the shared JDBC foundation for JDBC agents.
- `listDatabases()`: return visible catalogs/databases when the database supports them; otherwise return one sensible default database.
- `listSchemas()`: return schemas in stable order.
- `listTables(schema)`: return table-like objects for the selected schema, with normalized `type` values where possible.
- `getColumns(schema, table)`: return column metadata, nullability, defaults, key flags, numeric precision/scale, character length, and comments when available.
- `listIndexes(schema, table)`: return one `IndexInfo` per index, preserving column order.
- `listForeignKeys(schema, table)`: return outbound foreign keys when available.
- `listTriggers(schema, table)`: return triggers when available; return an empty list if the database has no trigger metadata.
- `executeQuery(sql, schema, options)`: inherited from the shared JDBC foundation unless the agent has a documented custom execution behavior.
- `disconnect()`: inherited from the shared JDBC foundation.
- `getConnection()`: inherited from the shared JDBC foundation.

Throw `IllegalStateException("Not connected")` when a method requires a connection and none exists.

## SQL Execution Rules

Do not classify statements by SQL prefix inside individual agents.

For most JDBC agents, inherit this from `AbstractJdbcAgent` or `ConfiguredJdbcAgent`. Do not copy the execution method into the agent class. If a custom value reader is required, override `resultValue(...)`:

```java
@Override
protected Object resultValue(ResultSet rs, int index, int sqlType) {
    return unchecked(() -> rs.getString(index));
}
```

For simple standard JDBC metadata agents, start with a profile:

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

`JdbcExecutor` owns these behaviors:

- Trims a trailing semicolon before execution.
- Handles `BEGIN`, `COMMIT`, and `ROLLBACK`.
- Runs schema switching SQL before the user statement.
- Executes statements with `Statement.execute(...)`.
- Reads `ResultSet` output for any statement type, not only `SELECT`.
- Returns update counts for update statements.
- Caps result rows at `options.maxRows`, defaulting to `JdbcExecutor.DEFAULT_MAX_ROWS`.
- Applies `options.fetchSize` to the JDBC statement when provided.
- Marks `truncated = true` only when more rows exist beyond the cap.

An agent must not reintroduce local copies of:

- `QUERY_PREFIXES`
- `MAX_ROWS`
- `executeUpdate(trimmedSql)` in `executeQuery`
- result truncation based on `rows.size >= MAX_ROWS`
- `Class.forName(...)` / `DriverManager.getConnection(...)` lifecycle boilerplate outside shared foundation extension points
- local `disconnect()` copies for JDBC agents
- local `JdbcExecutor.INSTANCE.execute(...)` copies for standard query execution

## Schema And Identifier Rules

Override `setSchemaSQL(schema)` for the database dialect, or configure the profile dialect options when standard quoting is enough.

Use `JdbcIdentifiers` helpers when quoting identifiers:

```java
@Override
public String setSchemaSQL(String schema) {
    return "SET SCHEMA " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
}
```

If the database does not support a schema switching statement, return an empty string:

```java
@Override
public String setSchemaSQL(String schema) {
    return "";
}
```

Never concatenate unquoted user-provided schema names into schema-switching SQL unless the target database requires unquoted identifiers and the value has already been validated.

For metadata queries, prefer prepared statements for `schema`, `table`, and other user-controlled values.

## Shared JDBC Foundation

Use the smallest shared base that matches the database:

- `ConfiguredJdbcAgent`: standard JDBC lifecycle, execution, and standard `DatabaseMetaData`-based metadata.
- `PostgresLikeAgent`: PostgreSQL-family metadata with shared lifecycle and execution.
- `AbstractJdbcAgent`: custom metadata SQL with shared lifecycle, execution, paging, transactions, result conversion, and DDL fallback.

If a database cannot yet use the shared foundation, add it to the validation allowlist with a specific reason and tests covering the custom behavior. Remove the allowlist entry when the module migrates.

## Driver Packaging

Each module chooses one of two driver modes.

### Bundled Driver

Use this when the driver is redistributable from Maven Central or another permitted repository:

```groovy
dependencies {
    implementation 'com.example:example-jdbc:1.2.3'
}
```

The root Gradle convention supplies `project(':common')`, `project(':test-support')`, JUnit, Java toolchains, the Shadow plugin, and the `dbx-agent-<module>` archive name for included agent modules.

No manifest flag is needed.

### External Driver

Use this when the driver cannot be redistributed or must be supplied by the user:

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

The release workflow reads `Agent-External-Driver: true` and emits `external_driver_required: true` in `agent-registry.json`.

## Module Registration

When adding an agent named `exampledb`:

- Create the module under `drivers/exampledb`.
- Add `exampledb` to `driverModules` in `settings.gradle`.
- Add `"exampledb": "0.1.0"` to `versions.json`.
- Set `Agent-Label` to the user-facing database name.
- Set `Main-Class` to the Java agent class, usually `com.dbx.agent.exampledb.ExampledbAgent`.
- Add the database to the README support table.

The root `build.gradle` convention derives the archive name from the module name, so `exampledb` builds `dbx-agent-exampledb.jar` without per-module archive configuration.

`versions.json` must contain only modules included in `settings.gradle`, excluding infrastructure modules such as `common` and `test-support`.

## Runtime Selection

Default to:

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

Most agents use JRE 21. If an agent needs a special runtime, update the root Gradle convention, the release workflow JRE detection logic, and document the reason in the module.

## Tests

Every JDBC agent should have at least one execution-path regression test.

For agents that can run with an embedded or in-memory database, prefer both shared behavior contracts:

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

`JdbcExecutionBehaviorTest` verifies non-`SELECT` result set execution, max-row truncation boundaries, and transaction control statements. `JdbcMetadataBehaviorTest` verifies stable metadata ordering. Agents with limited local test infrastructure can adopt the execution contract first and add the metadata contract later.

For agents that need unavailable commercial or external drivers, use the fake execution contract:

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

`JdbcFakeExecutionBehaviorTest` injects a fake JDBC connection and verifies that `executeQuery` uses `Statement.execute`, reads the returned `ResultSet`, and does not fall back to `executeQuery` or `executeUpdate`. Use `testImplementation project(':test-support')` for this contract.

## Review Checklist

Before opening a PR or release:

- `executeQuery` delegates to `JdbcExecutor.execute`.
- No local SQL-prefix classifier exists.
- No local result row cap exists unless there is a database-specific reason documented in code.
- Metadata methods use prepared statements for user-controlled schema/table inputs.
- `setSchemaSQL` quotes identifiers or returns an empty string.
- `disconnect` closes and clears the connection.
- `testConnection` closes its temporary connection.
- Root `build.gradle` conventions cover Java plugin, toolchain, JUnit, common/test-support dependencies, Shadow plugin, and archive name.
- Module `build.gradle` has correct driver dependencies, `Agent-Label`, `Main-Class`, and external driver flag.
- `settings.gradle`, `versions.json`, and README are updated together.
- At least one execution-path regression test exists.
- `python3 scripts/validate_agents.py` passes.
- `./gradlew test shadowJar --continue` passes.
