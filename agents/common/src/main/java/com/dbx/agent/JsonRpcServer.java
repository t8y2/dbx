package com.dbx.agent;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.reflect.TypeToken;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Type;
import java.sql.Connection;
import java.util.Collections;
import java.util.List;

public final class JsonRpcServer {
    private static final long CONNECTION_VALIDATION_INTERVAL_MILLIS = 5_000L;

    private final DatabaseAgent agent;
    private final Gson gson = new Gson();
    private ConnectParams lastConnectParams;
    private long lastConnectionValidationTimeMillis;

    public JsonRpcServer(DatabaseAgent agent) {
        this.agent = agent;
    }

    public void run() {
        System.out.println("{\"ready\":true}");
        System.out.flush();

        try {
            BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
            while (true) {
                String line = reader.readLine();
                if (line == null) {
                    break;
                }
                String response = handleRequest(line);
                System.out.println(response);
                System.out.flush();
            }
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    String handleRequest(String line) {
        JsonObject req = JsonParser.parseString(line).getAsJsonObject();
        JsonElement id = req.get("id");
        String method = req.get("method").getAsString();
        JsonObject params = paramsObject(req);

        JsonObject response = new JsonObject();
        response.addProperty("jsonrpc", "2.0");
        response.add("id", id);

        try {
            Object result = dispatch(method, params);
            response.add("result", gson.toJsonTree(result));
            return gson.toJson(response);
        } catch (Throwable e) {
            JsonObject error = new JsonObject();
            error.addProperty("code", -1);
            error.addProperty("message", e.getMessage() == null ? e.toString() : e.getMessage());
            response.add("error", error);
            return gson.toJson(response);
        }
    }

    private Object dispatch(String method, JsonObject params) throws Exception {
        if (AgentProtocol.METHOD_HANDSHAKE.equals(method)) {
            return AgentProtocol.handshakeResult();
        }
        if (AgentProtocol.METHOD_CONNECT.equals(method)) {
            lastConnectParams = gson.fromJson(params, ConnectParams.class);
            agent.connect(lastConnectParams);
            lastConnectionValidationTimeMillis = 0L;
            return Collections.singletonMap("ok", true);
        }
        if (AgentProtocol.METHOD_TEST_CONNECTION.equals(method)) {
            if (!agent.testConnection(gson.fromJson(params, ConnectParams.class))) {
                throw new RuntimeException("Connection failed");
            }
            return Collections.singletonMap("ok", true);
        }
        if (AgentProtocol.METHOD_VALIDATE_CONNECTION.equals(method)) {
            Connection conn = agent.getConnection();
            boolean valid = false;
            if (conn != null) {
                try {
                    valid = !conn.isClosed() && conn.isValid(2);
                } catch (Exception ignored) {
                }
            }
            if (!valid) {
                throw new IllegalStateException("Connection is not valid");
            }
            return Collections.singletonMap("ok", true);
        }
        ensureLiveConnection(method);
        if (AgentProtocol.METHOD_LIST_DATABASES.equals(method)) {
            return agent.listDatabases();
        }
        if (AgentProtocol.METHOD_LIST_SCHEMAS.equals(method)) {
            switchCatalog(params);
            return agent.listSchemas();
        }
        if (AgentProtocol.METHOD_LIST_TABLES.equals(method)) {
            switchCatalog(params);
            return agent.listTables(params.get("schema").getAsString());
        }
        if (AgentProtocol.METHOD_LIST_OBJECTS.equals(method)) {
            switchCatalog(params);
            return agent.listObjects(params.get("schema").getAsString());
        }
        if (AgentProtocol.METHOD_COMPLETION_ASSISTANT_SEARCH_V1.equals(method)) {
            switchCatalog(params);
            return agent.completionAssistantSearch(gson.fromJson(params, CompletionAssistantRequest.class));
        }
        if (AgentProtocol.METHOD_GET_OBJECT_SOURCE.equals(method)) {
            switchCatalog(params);
            return agent.getObjectSource(
                params.get("schema").getAsString(),
                params.get("name").getAsString(),
                params.get("object_type").getAsString()
            );
        }
        if (AgentProtocol.METHOD_GET_TABLE_DDL.equals(method)) {
            switchCatalog(params);
            return agent.getTableDdl(params.get("schema").getAsString(), params.get("table").getAsString());
        }
        if (AgentProtocol.METHOD_GET_COLUMNS.equals(method)) {
            switchCatalog(params);
            return agent.getColumns(params.get("schema").getAsString(), params.get("table").getAsString());
        }
        if (AgentProtocol.METHOD_LIST_INDEXES.equals(method)) {
            switchCatalog(params);
            return agent.listIndexes(params.get("schema").getAsString(), params.get("table").getAsString());
        }
        if (AgentProtocol.METHOD_LIST_FOREIGN_KEYS.equals(method)) {
            switchCatalog(params);
            return agent.listForeignKeys(params.get("schema").getAsString(), params.get("table").getAsString());
        }
        if (AgentProtocol.METHOD_LIST_TRIGGERS.equals(method)) {
            switchCatalog(params);
            return agent.listTriggers(params.get("schema").getAsString(), params.get("table").getAsString());
        }
        if (AgentProtocol.METHOD_EXECUTE_QUERY.equals(method)) {
            return agent.executeQuery(
                params.get("sql").getAsString(),
                stringOrNull(params, "schema"),
                new ExecuteQueryOptions(
                    intOrDefault(params, "maxRows", JdbcExecutor.DEFAULT_MAX_ROWS),
                    intOrNull(params, "fetchSize"),
                    intOrDefault(params, "timeoutSecs", 0)
                )
            );
        }
        if (AgentProtocol.METHOD_EXECUTE_QUERY_PAGE.equals(method)) {
            return agent.executeQueryPage(
                params.get("sql").getAsString(),
                stringOrNull(params, "schema"),
                new QueryPageOptions(
                    intOrDefault(params, "pageSize", 100),
                    intOrNull(params, "fetchSize"),
                    intOrDefault(params, "maxRows", JdbcExecutor.DEFAULT_MAX_ROWS),
                    intOrDefault(params, "timeoutSecs", 0)
                )
            );
        }
        if (AgentProtocol.METHOD_FETCH_QUERY_PAGE.equals(method)) {
            return agent.fetchQueryPage(
                params.get("sessionId").getAsString(),
                intOrDefault(params, "pageSize", 100)
            );
        }
        if (AgentProtocol.METHOD_CLOSE_QUERY_SESSION.equals(method)) {
            return agent.closeQuerySession(params.get("sessionId").getAsString());
        }
        if (AgentProtocol.METHOD_GET_EXPLAIN_INFO.equals(method)) {
            String plan = agent.getExplainInfo(
                params.get("sql").getAsString(),
                stringOrNull(params, "database"),
                stringOrNull(params, "schema"),
                intOrDefault(params, "timeoutSecs", -1),
                stringOrNull(params, "mode")
            );
            java.util.HashMap<String, Object> result = new java.util.HashMap<>();
            result.put("plan", plan);
            result.put("has_actual_stats", "autotrace".equals(stringOrNull(params, "mode")));
            return result;
        }
        if (AgentProtocol.METHOD_EXECUTE_TRANSACTION.equals(method)) {
            Type statementsType = new TypeToken<List<String>>() {}.getType();
            List<String> statements = gson.fromJson(params.get("statements"), statementsType);
            return agent.executeTransaction(statements, stringOrNull(params, "schema"));
        }
        if (AgentProtocol.METHOD_DISCONNECT.equals(method)) {
            JdbcExecutor.INSTANCE.closeAllQuerySessions();
            agent.disconnect();
            lastConnectParams = null;
            return Collections.singletonMap("ok", true);
        }
        if (AgentProtocol.METHOD_SHUTDOWN.equals(method)) {
            JdbcExecutor.INSTANCE.closeAllQuerySessions();
            agent.disconnect();
            lastConnectParams = null;
            System.exit(0);
            return Collections.singletonMap("ok", true);
        }
        throw new IllegalArgumentException("Unknown method: " + method);
    }

    private void switchCatalog(JsonObject params) throws Exception {
        String database = stringOrNull(params, "database");
        if (database != null && !database.trim().isEmpty() && agent.getConnection() != null) {
            String currentCatalog = null;
            try {
                currentCatalog = agent.getConnection().getCatalog();
            } catch (Exception ignored) {
            }
            if (currentCatalog == null || !currentCatalog.trim().equalsIgnoreCase(database.trim())) {
                try {
                    agent.getConnection().setCatalog(database);
                } catch (Exception ignored) {
                }
            }
        }
    }

    private void ensureLiveConnection(String method) {
        if (lastConnectParams == null || !shouldValidateConnection(method)) {
            return;
        }
        Connection conn = agent.getConnection();
        if (conn == null) {
            return;
        }
        long now = System.currentTimeMillis();
        if (lastConnectionValidationTimeMillis > 0
            && now - lastConnectionValidationTimeMillis < CONNECTION_VALIDATION_INTERVAL_MILLIS) {
            return;
        }
        boolean valid = false;
        try {
            valid = !conn.isClosed() && conn.isValid(2);
        } catch (Exception ignored) {
        }
        if (valid) {
            lastConnectionValidationTimeMillis = now;
            return;
        }

        JdbcExecutor.INSTANCE.closeAllQuerySessions();
        try {
            agent.disconnect();
        } catch (Exception ignored) {
        }
        agent.connect(lastConnectParams);
        lastConnectionValidationTimeMillis = System.currentTimeMillis();
    }

    private static boolean shouldValidateConnection(String method) {
        return !AgentProtocol.METHOD_HANDSHAKE.equals(method)
            && !AgentProtocol.METHOD_CONNECT.equals(method)
            && !AgentProtocol.METHOD_TEST_CONNECTION.equals(method)
            && !AgentProtocol.METHOD_VALIDATE_CONNECTION.equals(method)
            && !AgentProtocol.METHOD_FETCH_QUERY_PAGE.equals(method)
            && !AgentProtocol.METHOD_CLOSE_QUERY_SESSION.equals(method)
            && !AgentProtocol.METHOD_DISCONNECT.equals(method)
            && !AgentProtocol.METHOD_SHUTDOWN.equals(method);
    }

    private static JsonObject paramsObject(JsonObject req) {
        JsonElement params = req.get("params");
        if (params == null || params instanceof JsonNull || !params.isJsonObject()) {
            return new JsonObject();
        }
        return params.getAsJsonObject();
    }

    private static String stringOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        if (element == null || element instanceof JsonNull) {
            return null;
        }
        return element.getAsString();
    }

    private static Integer intOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        if (element == null || element instanceof JsonNull) {
            return null;
        }
        return element.getAsInt();
    }

    private static int intOrDefault(JsonObject object, String key, int defaultValue) {
        Integer value = intOrNull(object, key);
        return value == null ? defaultValue : value;
    }

}
