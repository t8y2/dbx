package com.dbx.agent;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CommonJavaCompatibilityTest {
    @Test
    void definesSharedAgentProtocolContract() {
        assertEquals("handshake", AgentProtocol.METHOD_HANDSHAKE);
        assertEquals(1, AgentProtocol.PROTOCOL_VERSION);
        assertTrue(AgentProtocol.CAPABILITIES.contains(AgentProtocol.CAPABILITY_CONNECT));
        assertTrue(AgentProtocol.CAPABILITIES.contains(AgentProtocol.CAPABILITY_QUERY));
        assertTrue(AgentProtocol.CAPABILITIES.contains(AgentProtocol.CAPABILITY_METADATA));
    }

    @Test
    void agentProtocolMatchesContractResource() {
        JsonObject contract = protocolContract("/agent-protocol-v1.json");

        assertEquals(AgentProtocol.PROTOCOL_VERSION, contract.get("protocolVersion").getAsInt());
        assertEquals(AgentProtocol.METHOD_HANDSHAKE, contract.get("handshakeMethod").getAsString());
        assertEquals(
            Arrays.asList("protocolVersion", "agentProtocolVersion", "capabilities"),
            strings(contract.getAsJsonArray("handshakeResponseFields"))
        );
        assertEquals(AgentProtocol.ALL_CAPABILITIES, strings(contract.getAsJsonArray("allCapabilities")));
        assertEquals(AgentProtocol.CAPABILITIES, strings(contract.getAsJsonArray("capabilities")));
        assertEquals(AgentProtocol.CAPABILITIES, strings(contract.getAsJsonArray("defaultSqlCapabilities")));
        assertEquals(AgentProtocol.COMMON_METHODS, strings(contract.getAsJsonArray("commonMethods")));
        assertEquals(AgentProtocol.MONGO_LEGACY_METHODS, strings(contract.getAsJsonArray("mongoLegacyMethods")));
        assertEquals(AgentProtocol.KV_METHODS, strings(contract.getAsJsonArray("kvMethods")));
    }

    @Test
    void multiSessionAgentProtocolMatchesV2ContractResource() {
        JsonObject contract = protocolContract("/agent-protocol-v2.json");

        assertEquals(AgentProtocol.MULTI_SESSION_PROTOCOL_VERSION, contract.get("protocolVersion").getAsInt());
        assertEquals(AgentProtocol.MULTI_SESSION_METHODS, strings(contract.getAsJsonArray("commonMethods")));
    }

    @Test
    void jsonRpcServerExposesProtocolHandshake() {
        JsonRpcServer server = new JsonRpcServer(new MinimalAgent());

        String response = server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"" + AgentProtocol.METHOD_HANDSHAKE + "\",\"params\":{\"appVersion\":\"0.5.13\",\"supportedProtocolVersions\":[1]}}"
        );

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        JsonObject result = json.getAsJsonObject("result");
        assertEquals("2.0", json.get("jsonrpc").getAsString());
        assertEquals(7, json.get("id").getAsInt());
        assertEquals(1, result.get("protocolVersion").getAsInt());
        assertEquals(1, result.get("agentProtocolVersion").getAsInt());
        assertTrue(containsCapability(result.getAsJsonArray("capabilities"), "connect"));
        assertTrue(containsCapability(result.getAsJsonArray("capabilities"), "query"));
        assertTrue(containsCapability(result.getAsJsonArray("capabilities"), "metadata"));
    }

    @Test
    void multiSessionServerCreatesAndClosesIndependentAgents() {
        java.util.List<TrackingAgent> created = new java.util.ArrayList<>();
        MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(() -> {
            TrackingAgent agent = new TrackingAgent();
            created.add(agent);
            return agent;
        });

        JsonObject handshake = JsonParser.parseString(server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"handshake\",\"params\":{}}"
        )).getAsJsonObject().getAsJsonObject("result");
        assertEquals(2, handshake.get("protocolVersion").getAsInt());
        assertTrue(containsCapability(handshake.getAsJsonArray("capabilities"), "multi_session"));

        server.handleRequest("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"open_session\",\"params\":{\"agentSessionId\":\"a\"}}");
        server.handleRequest("{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"open_session\",\"params\":{\"agentSessionId\":\"b\"}}");
        assertEquals(2, created.size());
        assertEquals(1, created.get(0).connectCount);
        assertEquals(1, created.get(1).connectCount);

        server.handleRequest("{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"close_session\",\"params\":{\"agentSessionId\":\"a\"}}");
        assertEquals(1, created.get(0).disconnectCount);
        assertEquals(0, created.get(1).disconnectCount);
    }

    @Test
    void multiSessionCancellationOnlyCancelsTargetSession() throws Exception {
        List<CancelTrackingAgent> created = Collections.synchronizedList(new ArrayList<>());
        MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(() -> {
            CancelTrackingAgent agent = new CancelTrackingAgent();
            created.add(agent);
            return agent;
        });

        server.handleRequest("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"open_session\",\"params\":{\"agentSessionId\":\"a\"}}");
        server.handleRequest("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"open_session\",\"params\":{\"agentSessionId\":\"b\"}}");

        Thread queryA = new Thread(() -> server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"execute_query\",\"params\":{\"agentSessionId\":\"a\",\"sql\":\"SELECT 1\"}}"
        ));
        Thread queryB = new Thread(() -> server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"execute_query\",\"params\":{\"agentSessionId\":\"b\",\"sql\":\"SELECT 1\"}}"
        ));
        queryA.start();
        queryB.start();
        assertTrue(created.get(0).statementStarted.await(5, TimeUnit.SECONDS));
        assertTrue(created.get(1).statementStarted.await(5, TimeUnit.SECONDS));

        server.handleRequest("{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"cancel_session\",\"params\":{\"agentSessionId\":\"a\"}}");
        assertTrue(created.get(0).canceled.get());
        assertFalse(created.get(1).canceled.get());

        created.get(1).release.countDown();
        queryA.join(5_000L);
        queryB.join(5_000L);
        assertFalse(queryA.isAlive());
        assertFalse(queryB.isAlive());
    }

    @Test
    void cancelActiveStatementsClosesOnlyThatExecutorPagedSessions() {
        JdbcExecutor target = new JdbcExecutor();
        JdbcExecutor other = new JdbcExecutor();
        List<String> targetCalls = new ArrayList<>();
        List<String> otherCalls = new ArrayList<>();

        QueryPageResult targetPage = target.executePage(
            pagedConnection(targetCalls),
            "SELECT 1",
            null,
            ignored -> null,
            new QueryPageOptions(1, null, 10, 0),
            target::defaultResultValue
        );
        QueryPageResult otherPage = other.executePage(
            pagedConnection(otherCalls),
            "SELECT 1",
            null,
            ignored -> null,
            new QueryPageOptions(1, null, 10, 0),
            other::defaultResultValue
        );

        target.cancelActiveStatements();

        assertThrows(IllegalArgumentException.class, () -> target.fetchPage(targetPage.getSession_id(), 1));
        assertNotNull(other.fetchPage(otherPage.getSession_id(), 1));
        assertTrue(targetCalls.contains("resultSet.close"));
        assertTrue(targetCalls.contains("statement.close"));
        assertFalse(otherCalls.contains("resultSet.close"));
    }

    @Test
    void jsonRpcServerSerializesArbitraryPrecisionNumbersAsStrings() {
        JsonRpcServer server = new JsonRpcServer(new PreciseNumberAgent());

        String response = server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"" + AgentProtocol.METHOD_EXECUTE_QUERY + "\",\"params\":{\"sql\":\"select n from t\"}}"
        );

        JsonArray row = JsonParser.parseString(response)
            .getAsJsonObject()
            .getAsJsonObject("result")
            .getAsJsonArray("rows")
            .get(0)
            .getAsJsonArray();
        assertEquals("12345678901234567890.1234", row.get(0).getAsString());
        assertTrue(row.get(0).getAsJsonPrimitive().isString());
        assertEquals("12345678901234567890", row.get(1).getAsString());
        assertTrue(row.get(1).getAsJsonPrimitive().isString());
        assertEquals(42, row.get(2).getAsInt());
        assertTrue(row.get(2).getAsJsonPrimitive().isNumber());
    }

    @Test
    void jsonRpcServerReconnectsWhenStoredJdbcConnectionIsStale() {
        ReconnectingAgent agent = new ReconnectingAgent();
        JsonRpcServer server = new JsonRpcServer(agent);

        server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"connect\",\"params\":{\"host\":\"db.example.com\",\"port\":1521,\"database\":\"ORCL\",\"username\":\"u\",\"password\":\"p\"}}"
        );
        String response = server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"list_databases\",\"params\":{}}"
        );

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(json.has("result"));
        assertEquals(2, agent.connectCount);
        assertEquals(1, agent.disconnectCount);
        assertEquals(1, agent.firstConnectionValidChecks);
    }

    @Test
    void jsonRpcServerValidatesCurrentJdbcConnection() {
        ReconnectingAgent agent = new ReconnectingAgent();
        JsonRpcServer server = new JsonRpcServer(agent);

        server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"connect\",\"params\":{\"host\":\"db.example.com\",\"port\":1521,\"database\":\"ORCL\",\"username\":\"u\",\"password\":\"p\"}}"
        );
        String response = server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"" + AgentProtocol.METHOD_VALIDATE_CONNECTION + "\",\"params\":{}}"
        );

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(json.has("error"));
        assertEquals(1, agent.connectCount);
        assertEquals(1, agent.firstConnectionValidChecks);
    }

    @Test
    void jsonRpcServerSwitchesCatalogBeforeMetadataCalls() {
        CatalogSwitchAgent agent = new CatalogSwitchAgent();
        JsonRpcServer server = new JsonRpcServer(agent);

        String response = server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"" + AgentProtocol.METHOD_LIST_TABLES + "\",\"params\":{\"database\":\"sales\",\"schema\":\"app\"}}"
        );

        JsonObject json = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(json.has("result"));
        assertEquals("sales", agent.catalogs.get(0));
        assertEquals("app", agent.lastSchema);
    }

    @Test
    void jsonRpcServerAppliesConstrainedTableMetadataRequests() {
        MetadataConstraintAgent agent = new MetadataConstraintAgent();
        JsonRpcServer server = new JsonRpcServer(agent);

        String response = server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"" + AgentProtocol.METHOD_LIST_TABLES + "\",\"params\":{\"schema\":\"app\",\"filter\":\"us\",\"limit\":1,\"offset\":1,\"object_types\":[\"TABLE\"]}}"
        );

        JsonArray result = JsonParser.parseString(response).getAsJsonObject().getAsJsonArray("result");
        assertEquals(1, result.size());
        assertEquals("user_settings", result.get(0).getAsJsonObject().get("name").getAsString());
        assertEquals("app", agent.lastSchema);
    }

    @Test
    void jsonRpcServerAppliesConstrainedObjectMetadataRequests() {
        MetadataConstraintAgent agent = new MetadataConstraintAgent();
        JsonRpcServer server = new JsonRpcServer(agent);

        String response = server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"" + AgentProtocol.METHOD_LIST_OBJECTS + "\",\"params\":{\"schema\":\"app\",\"filter\":\"fn\",\"limit\":1,\"offset\":1,\"object_types\":[\"FUNCTION\"]}}"
        );

        JsonArray result = JsonParser.parseString(response).getAsJsonObject().getAsJsonArray("result");
        assertEquals(1, result.size());
        assertEquals("fetch_name", result.get(0).getAsJsonObject().get("name").getAsString());
        assertEquals("FUNCTION", result.get(0).getAsJsonObject().get("object_type").getAsString());
    }

    @Test
    void jsonRpcServerDispatchesTableReadSessionMethods() {
        TableReadDispatchAgent agent = new TableReadDispatchAgent();
        JsonRpcServer server = new JsonRpcServer(agent);

        String startResponse = server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"" + AgentProtocol.METHOD_START_TABLE_READ + "\",\"params\":{\"sql\":\"select * from orders\",\"schema\":\"public\",\"pageSize\":2,\"fetchSize\":8,\"maxRows\":20,\"timeoutSecs\":3}}"
        );
        JsonObject startJson = JsonParser.parseString(startResponse).getAsJsonObject();

        assertTrue(startJson.has("result"));
        assertEquals("select * from orders", agent.lastSql);
        assertEquals("public", agent.lastSchema);
        assertEquals(new QueryPageOptions(2, 8, 20, 3), agent.lastOptions);
        assertEquals("table-session", startJson.getAsJsonObject("result").get("session_id").getAsString());

        String fetchResponse = server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"" + AgentProtocol.METHOD_FETCH_TABLE_READ_PAGE + "\",\"params\":{\"sessionId\":\"table-session\",\"pageSize\":4}}"
        );
        JsonObject fetchJson = JsonParser.parseString(fetchResponse).getAsJsonObject();

        assertTrue(fetchJson.has("result"));
        assertEquals("table-session", agent.fetchedSessionId);
        assertEquals(4, agent.fetchedPageSize);
        assertFalse(fetchJson.getAsJsonObject("result").get("has_more").getAsBoolean());

        String closeResponse = server.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":13,\"method\":\"" + AgentProtocol.METHOD_CLOSE_TABLE_READ_SESSION + "\",\"params\":{\"sessionId\":\"table-session\"}}"
        );
        JsonObject closeJson = JsonParser.parseString(closeResponse).getAsJsonObject();

        assertTrue(closeJson.get("result").getAsBoolean());
        assertEquals("table-session", agent.closedSessionId);
    }


    @Test
    void exposesJavaFriendlyDefaultsAndModels() {
        ConnectParams params = new ConnectParams("localhost", 5432, "demo", "user", "secret", "ssl=false", "", false);
        assertEquals("localhost", params.getHost());
        assertEquals("ssl=false", params.getUrl_params());

        TableInfo table = new TableInfo("orders", "TABLE");
        assertEquals("TABLE", table.getTable_type());

        QueryResult result = new QueryResult(
            Collections.singletonList("id"),
            Collections.singletonList(Collections.singletonList(1)),
            2L,
            3L
        );
        assertEquals(2L, result.getAffected_rows());
        assertEquals(3L, result.getExecution_time_ms());
        assertFalse(result.getTruncated());

        QueryPageResult page = new QueryPageResult(
            Collections.singletonList("id"),
            Collections.emptyList(),
            0L,
            1L,
            false,
            "session-1",
            true
        );
        assertEquals("session-1", page.getSession_id());
        assertEquals(true, page.getHas_more());

        assertEquals(JdbcExecutor.DEFAULT_MAX_ROWS, new ExecuteQueryOptions().getMaxRows());
        assertEquals(100, new QueryPageOptions().getPageSize());
        assertNotNull(JdbcExecutor.INSTANCE);
    }

    @Test
    void exposesDatabaseAgentDefaultMethodsToJavaImplementors() {
        DatabaseAgent agent = new MinimalAgent();

        assertEquals(1, agent.listObjects("public").size());
        assertThrows(UnsupportedOperationException.class, () ->
            agent.getObjectSource("public", "orders", "TABLE")
        );
        assertEquals("SET SCHEMA \"public\"", agent.setSchemaSQL("public"));
        assertThrows(IllegalStateException.class, () ->
            agent.executeQueryPage("select 1", "public")
        );
        assertThrows(IllegalStateException.class, () ->
            agent.startTableRead("select 1", "public", new QueryPageOptions())
        );
        assertEquals(0L, agent.executeQuery("select 1", "public").getAffected_rows());

        String ddl = DatabaseAgent.buildTableDdl(
            "public",
            "orders",
            Collections.singletonList(new ColumnInfo("id", "integer", false, null, true)),
            Collections.singletonList(new IndexInfo("orders_name_idx", Collections.singletonList("name"), false, false)),
            Collections.singletonList(new ForeignKeyInfo("orders_customer_fk", "customer_id", "customers", "id"))
        );
        assertEquals(
            "CREATE TABLE \"public\".\"orders\" (\n" +
                "  \"id\" integer NOT NULL,\n" +
                "  PRIMARY KEY (\"id\"),\n" +
                "  CONSTRAINT \"orders_customer_fk\" FOREIGN KEY (\"customer_id\") REFERENCES \"customers\"(\"id\")\n" +
                ");\n\n" +
                "CREATE INDEX \"orders_name_idx\" ON \"public\".\"orders\" (\"name\");",
            ddl
        );
    }

    @Test
    void databaseAgentDefaultConstraintsFilterLegacyMetadataOverrides() {
        DatabaseAgent agent = new LegacyObjectTypeAgent();

        List<TableInfo> tables = agent.listTables(
            "public",
            new MetadataListConstraints("us", 1, 1, Collections.singletonList("TABLE"))
        );
        assertEquals(1, tables.size());
        assertEquals("user_settings", tables.get(0).getName());

        List<ObjectInfo> objects = agent.listObjects(
            "public",
            new MetadataListConstraints("us", 1, 0, Collections.singletonList("VIEW"))
        );
        assertEquals(1, objects.size());
        assertEquals("usage_view", objects.get(0).getName());
    }

    @Test
    void metadataConstraintsTreatTdengineStableAsTable() {
        MetadataListConstraints constraints =
            new MetadataListConstraints(null, null, null, Collections.singletonList("TABLE"));
        TableInfo stable = new TableInfo("meters", "STABLE", null, null, null);

        List<TableInfo> tables = constraints.filterTables(Collections.singletonList(stable));

        assertEquals(Collections.singletonList(stable), tables);
    }

    @Test
    void metadataConstraintsMatchTableAndObjectComments() {
        MetadataListConstraints tableConstraints =
            new MetadataListConstraints("account", null, null, Collections.singletonList("TABLE"));
        List<TableInfo> tables = tableConstraints.filterTables(Arrays.asList(
            new TableInfo("orders", "TABLE", "sales archive"),
            new TableInfo("profile", "TABLE", "customer account data"),
            new TableInfo("account_view", "VIEW", "ignored by type")
        ));
        assertEquals(1, tables.size());
        assertEquals("profile", tables.get(0).getName());

        MetadataListConstraints objectConstraints =
            new MetadataListConstraints("revenue", null, null, Collections.singletonList("VIEW"));
        List<ObjectInfo> objects = objectConstraints.filterObjects(Arrays.asList(
            new ObjectInfo("order_view", "VIEW", "public", "monthly revenue summary"),
            new ObjectInfo("sync_user", "PROCEDURE", "public", "sync revenue data"),
            new ObjectInfo("audit_log", "TABLE", "public", "audit records")
        ));
        assertEquals(1, objects.size());
        assertEquals("order_view", objects.get(0).getName());
    }

    @Test
    void tableCommentPrefersExactNameAndPreservesWhitespace() {
        DatabaseAgent agent = new TableCommentAgent(Arrays.asList(
            new TableInfo("users", "TABLE", "lowercase comment"),
            new TableInfo("Users", "TABLE", "  exact comment  ")
        ));

        assertEquals("  exact comment  ", agent.getTableComment("public", "Users"));
    }

    @Test
    void tableCommentUsesOnlyUniqueCaseInsensitiveFallback() {
        DatabaseAgent unique = new TableCommentAgent(Collections.singletonList(
            new TableInfo("USERS", "TABLE", "  normalized comment  ")
        ));
        DatabaseAgent ambiguous = new TableCommentAgent(Arrays.asList(
            new TableInfo("Users", "TABLE", "first"),
            new TableInfo("USERS", "TABLE", "second")
        ));

        assertEquals("  normalized comment  ", unique.getTableComment("public", "users"));
        assertEquals(null, ambiguous.getTableComment("public", "users"));
    }

    @Test
    void executesTransactionsOneByOneWhenJdbcDriverDoesNotSupportTransactions() {
        List<String> calls = new ArrayList<>();
        DatabaseAgent agent = new TransactionAgent(nonTransactionalConnection(calls));

        QueryResult result = agent.executeTransaction(Arrays.asList("UPDATE A SET ID = 1", "UPDATE B SET ID = 2"), "APP");

        assertEquals(2L, result.getAffected_rows());
        assertEquals(
            Arrays.asList("supportsTransactions", "execute:SET SCHEMA \"APP\"", "executeUpdate:UPDATE A SET ID = 1", "executeUpdate:UPDATE B SET ID = 2"),
            calls
        );
    }

    @Test
    void buildsTableDdlWithoutSchemaQualifierWhenSchemaIsBlank() {
        String ddl = DatabaseAgent.buildTableDdl(
            "",
            "orders",
            Collections.singletonList(new ColumnInfo("id", "integer", false, null, true)),
            Collections.emptyList(),
            Collections.emptyList()
        );

        assertEquals(
                "CREATE TABLE \"orders\" (\n" +
                "  \"id\" integer NOT NULL,\n" +
                "  PRIMARY KEY (\"id\")\n" +
                ");\n",
            ddl
        );
    }

    @Test
    void buildsTableDdlWithColumnComments() {
        String ddl = DdlBuilder.buildTableDdl(
            "public",
            "orders",
            Collections.singletonList(new ColumnInfo(
                "display_name",
                "varchar",
                true,
                null,
                false,
                null,
                "User's display name",
                null,
                null,
                64
            )),
            Collections.emptyList(),
            Collections.emptyList(),
            false,
            true
        );

        assertEquals(
            "CREATE TABLE \"public\".\"orders\" (\n" +
                "  \"display_name\" varchar(64)\n" +
                ");\n\n" +
                "COMMENT ON COLUMN \"public\".\"orders\".\"display_name\" IS 'User''s display name';",
            ddl
        );
    }

    private static class MinimalAgent implements DatabaseAgent {
        @Override
        public void connect(ConnectParams params) {
        }

        @Override
        public boolean testConnection(ConnectParams params) {
            return true;
        }

        @Override
        public List<DatabaseInfo> listDatabases() {
            return Collections.emptyList();
        }

        @Override
        public List<String> listSchemas() {
            return Collections.singletonList("public");
        }

        @Override
        public List<TableInfo> listTables(String schema) {
            return Collections.singletonList(new TableInfo("orders", "TABLE"));
        }

        @Override
        public List<ColumnInfo> getColumns(String schema, String table) {
            return Arrays.asList(
                new ColumnInfo("id", "integer", false, null, true),
                new ColumnInfo("name", "character varying", true, null, false, null, null, null, null, 255)
            );
        }

        @Override
        public List<IndexInfo> listIndexes(String schema, String table) {
            return Collections.emptyList();
        }

        @Override
        public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
            return Collections.emptyList();
        }

        @Override
        public List<TriggerInfo> listTriggers(String schema, String table) {
            return Collections.emptyList();
        }

        @Override
        public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
            return new QueryResult(Collections.emptyList(), Collections.emptyList(), 0L, 0L);
        }

        @Override
        public void disconnect() {
        }

        @Override
        public Connection getConnection() {
            return null;
        }
    }

    private static final class TrackingAgent extends MinimalAgent {
        private int connectCount;
        private int disconnectCount;

        @Override
        public void connect(ConnectParams params) {
            connectCount += 1;
        }

        @Override
        public void disconnect() {
            disconnectCount += 1;
        }
    }

    private static final class CancelTrackingAgent extends MinimalAgent {
        private final CountDownLatch statementStarted = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private final AtomicBoolean canceled = new AtomicBoolean();
        private final Connection connection = proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) {
                return proxy(java.sql.Statement.class, (statementMethod, statementArgs) -> {
                    if ("execute".equals(statementMethod.getName())) {
                        statementStarted.countDown();
                        try {
                            release.await(5, TimeUnit.SECONDS);
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            throw new RuntimeException(interrupted);
                        }
                        return false;
                    }
                    if ("cancel".equals(statementMethod.getName())) {
                        canceled.set(true);
                        release.countDown();
                        return null;
                    }
                    return defaultValue(statementMethod.getReturnType());
                });
            }
            return defaultValue(method.getReturnType());
        });

        @Override
        public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
            return JdbcExecutor.current().execute(
                connection,
                sql,
                schema,
                ignored -> null,
                options.getMaxRows(),
                options.getFetchSize(),
                options.getTimeoutSecs(),
                JdbcExecutor.current()::defaultResultValue
            );
        }

        @Override
        public Connection getConnection() {
            return connection;
        }
    }

    private static final class TableCommentAgent extends MinimalAgent {
        private final List<TableInfo> tables;

        private TableCommentAgent(List<TableInfo> tables) {
            this.tables = tables;
        }

        @Override
        public List<TableInfo> listTables(String schema) {
            return tables;
        }
    }

    private static final class TransactionAgent extends MinimalAgent {
        private final Connection connection;

        private TransactionAgent(Connection connection) {
            this.connection = connection;
        }

        @Override
        public Connection getConnection() {
            return connection;
        }
    }

    private static final class LegacyObjectTypeAgent extends MinimalAgent {
        @Override
        public List<TableInfo> listTables(String schema) {
            return Arrays.asList(
                new TableInfo("orders", "TABLE"),
                new TableInfo("usage_view", "VIEW"),
                new TableInfo("users", "TABLE"),
                new TableInfo("user_settings", "TABLE")
            );
        }

        @Override
        public List<TableInfo> listTables(String schema, List<String> objectTypes) {
            List<TableInfo> result = listTables(schema);
            if (objectTypes == null || objectTypes.isEmpty()) {
                return result;
            }
            List<TableInfo> filtered = new ArrayList<>();
            for (TableInfo table : result) {
                if (objectTypes.contains(table.getTable_type())) {
                    filtered.add(table);
                }
            }
            return filtered;
        }
    }

    private static final class PreciseNumberAgent extends MinimalAgent {
        @Override
        public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
            return new QueryResult(
                Arrays.asList("decimal_value", "integer_value", "safe_int"),
                Collections.singletonList(Arrays.asList(
                    new BigDecimal("12345678901234567890.1234"),
                    new BigInteger("12345678901234567890"),
                    42
                )),
                0L,
                0L
            );
        }
    }

    private static final class ReconnectingAgent extends MinimalAgent {
        private int connectCount;
        private int disconnectCount;
        private int firstConnectionValidChecks;
        private Connection connection;

        @Override
        public void connect(ConnectParams params) {
            connectCount += 1;
            final int connectionNumber = connectCount;
            connection = proxy(Connection.class, (method, args) -> {
                String name = method.getName();
                if ("isClosed".equals(name)) {
                    return false;
                }
                if ("isValid".equals(name)) {
                    if (connectionNumber == 1) {
                        firstConnectionValidChecks += 1;
                        return false;
                    }
                    return true;
                }
                if ("close".equals(name)) {
                    return null;
                }
                return defaultValue(method.getReturnType());
            });
        }

        @Override
        public void disconnect() {
            disconnectCount += 1;
        }

        @Override
        public Connection getConnection() {
            return connection;
        }
    }

    private static final class CatalogSwitchAgent extends MinimalAgent {
        private final List<String> catalogs = new ArrayList<>();
        private String lastSchema = "";

        @Override
        public Connection getConnection() {
            return proxy(Connection.class, (method, args) -> {
                if ("setCatalog".equals(method.getName())) {
                    catalogs.add(String.valueOf(args[0]));
                    return null;
                }
                return defaultValue(method.getReturnType());
            });
        }

        @Override
        public List<TableInfo> listTables(String schema) {
            lastSchema = schema;
            return super.listTables(schema);
        }
    }

    private static final class MetadataConstraintAgent extends MinimalAgent {
        private String lastSchema = "";

        @Override
        public Connection getConnection() {
            return proxy(Connection.class, (method, args) -> {
                if ("isClosed".equals(method.getName())) {
                    return false;
                }
                if ("isValid".equals(method.getName())) {
                    return true;
                }
                return defaultValue(method.getReturnType());
            });
        }

        @Override
        public List<TableInfo> listTables(String schema) {
            lastSchema = schema;
            return Arrays.asList(
                new TableInfo("orders", "TABLE"),
                new TableInfo("users", "TABLE"),
                new TableInfo("usage_view", "VIEW"),
                new TableInfo("user_settings", "TABLE")
            );
        }

        @Override
        public List<ObjectInfo> listObjects(String schema) {
            return Arrays.asList(
                new ObjectInfo("orders", "TABLE", schema, null),
                new ObjectInfo("find_user", "FUNCTION", schema, null),
                new ObjectInfo("fetch_name", "FUNCTION", schema, null),
                new ObjectInfo("cleanup_user", "PROCEDURE", schema, null)
            );
        }
    }

    private static final class TableReadDispatchAgent extends MinimalAgent {
        private String lastSql;
        private String lastSchema;
        private QueryPageOptions lastOptions;
        private String fetchedSessionId;
        private int fetchedPageSize;
        private String closedSessionId;

        @Override
        public QueryPageResult startTableRead(String sql, String schema, QueryPageOptions options) {
            lastSql = sql;
            lastSchema = schema;
            lastOptions = options;
            return new QueryPageResult(
                Collections.singletonList("id"),
                Collections.singletonList(Collections.singletonList(1)),
                0L,
                5L,
                false,
                "table-session",
                true
            );
        }

        @Override
        public QueryPageResult fetchTableReadPage(String sessionId, int pageSize) {
            fetchedSessionId = sessionId;
            fetchedPageSize = pageSize;
            return new QueryPageResult(
                Collections.singletonList("id"),
                Collections.singletonList(Collections.singletonList(2)),
                0L,
                0L,
                false,
                null,
                false
            );
        }

        @Override
        public boolean closeTableReadSession(String sessionId) {
            closedSessionId = sessionId;
            return "table-session".equals(sessionId);
        }
    }

    private static Connection nonTransactionalConnection(List<String> calls) {
        return proxy(Connection.class, (method, args) -> {
            String name = method.getName();
            if ("getMetaData".equals(name)) {
                return proxy(java.sql.DatabaseMetaData.class, (metaMethod, metaArgs) -> {
                    if ("supportsTransactions".equals(metaMethod.getName())) {
                        calls.add("supportsTransactions");
                        return false;
                    }
                    return defaultValue(metaMethod.getReturnType());
                });
            }
            if ("createStatement".equals(name)) {
                return proxy(java.sql.Statement.class, (stmtMethod, stmtArgs) -> {
                    if ("execute".equals(stmtMethod.getName())) {
                        calls.add("execute:" + stmtArgs[0]);
                        return false;
                    }
                    if ("executeUpdate".equals(stmtMethod.getName())) {
                        calls.add("executeUpdate:" + stmtArgs[0]);
                        return 1;
                    }
                    return defaultValue(stmtMethod.getReturnType());
                });
            }
            if ("setSchema".equals(name)) {
                calls.add("setSchema:" + args[0]);
                return null;
            }
            if ("setCatalog".equals(name)) {
                calls.add("setCatalog:" + args[0]);
                return null;
            }
            if ("setAutoCommit".equals(name) || "commit".equals(name) || "rollback".equals(name)) {
                calls.add(name);
                return null;
            }
            if ("getAutoCommit".equals(name)) {
                return true;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static Connection pagedConnection(List<String> calls) {
        java.sql.ResultSetMetaData metadata = proxy(java.sql.ResultSetMetaData.class, (method, args) -> {
            if ("getColumnCount".equals(method.getName())) return 1;
            if ("getColumnLabel".equals(method.getName())) return "value";
            if ("getColumnType".equals(method.getName())) return java.sql.Types.INTEGER;
            if ("getColumnTypeName".equals(method.getName())) return "integer";
            return defaultValue(method.getReturnType());
        });
        int[] row = {0};
        java.sql.ResultSet resultSet = proxy(java.sql.ResultSet.class, (method, args) -> {
            if ("getMetaData".equals(method.getName())) return metadata;
            if ("next".equals(method.getName())) return ++row[0] <= 3;
            if ("getInt".equals(method.getName())) return row[0];
            if ("wasNull".equals(method.getName())) return false;
            if ("close".equals(method.getName())) {
                calls.add("resultSet.close");
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        java.sql.Statement statement = proxy(java.sql.Statement.class, (method, args) -> {
            if ("execute".equals(method.getName())) return true;
            if ("getResultSet".equals(method.getName())) return resultSet;
            if ("close".equals(method.getName())) {
                calls.add("statement.close");
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("createStatement".equals(method.getName())) return statement;
            return defaultValue(method.getReturnType());
        });
    }

    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) {
                return handler.handle(method, args == null ? new Object[0] : args);
            }
        };
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler));
    }

    private static Object defaultValue(Class<?> type) {
        if (Boolean.TYPE.equals(type)) {
            return false;
        }
        if (Integer.TYPE.equals(type)) {
            return 0;
        }
        if (Long.TYPE.equals(type)) {
            return 0L;
        }
        return null;
    }

    private static boolean containsCapability(JsonArray capabilities, String expected) {
        for (int i = 0; i < capabilities.size(); i++) {
            if (expected.equals(capabilities.get(i).getAsString())) {
                return true;
            }
        }
        return false;
    }

    private static JsonObject protocolContract(String resourcePath) {
        InputStream stream = CommonJavaCompatibilityTest.class.getResourceAsStream(resourcePath);
        if (stream == null) {
            throw new AssertionError(resourcePath + " resource missing");
        }
        return JsonParser.parseReader(new InputStreamReader(stream, StandardCharsets.UTF_8)).getAsJsonObject();
    }

    private static List<String> strings(JsonArray array) {
        List<String> result = new ArrayList<>();
        for (int i = 0; i < array.size(); i++) {
            result.add(array.get(i).getAsString());
        }
        return result;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args);
    }
}
