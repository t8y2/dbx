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
        JsonObject contract = protocolContract();

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
    void executesTransactionsOneByOneWhenJdbcDriverDoesNotSupportTransactions() {
        List<String> calls = new ArrayList<>();
        DatabaseAgent agent = new TransactionAgent(nonTransactionalConnection(calls));

        QueryResult result = agent.executeTransaction(Arrays.asList("UPDATE A SET ID = 1", "UPDATE B SET ID = 2"), "APP");

        assertEquals(2L, result.getAffected_rows());
        assertEquals(
            Arrays.asList("supportsTransactions", "setSchema:APP", "executeUpdate:UPDATE A SET ID = 1", "executeUpdate:UPDATE B SET ID = 2"),
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

    private static JsonObject protocolContract() {
        InputStream stream = CommonJavaCompatibilityTest.class.getResourceAsStream("/agent-protocol-v1.json");
        if (stream == null) {
            throw new AssertionError("agent-protocol-v1.json resource missing");
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
