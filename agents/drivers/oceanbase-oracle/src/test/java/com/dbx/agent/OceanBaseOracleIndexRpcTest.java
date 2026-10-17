package com.dbx.agent;

import com.dbx.agent.oceanbaseoracle.OceanBaseOracleAgent;
import com.dbx.agent.test.TestSupport;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class OceanBaseOracleIndexRpcTest {
    @Test
    void returnsExpressionDirectionAndVisibilityThroughProductionRpc() {
        Fixture jdbc = new Fixture(List.of(
            row("IX_EVENT_EXPR", "SYS_NC00001$", "1", "NONUNIQUE", "I", "FUNCTION-BASED NORMAL", "NO", "LOWER(\"EVENT_NAME\")", "DESC", "INVISIBLE"),
            row("IX_EVENT_EXPR", "EVENT_TS", "2", "NONUNIQUE", "I", "FUNCTION-BASED NORMAL", "NO", null, "ASC", "INVISIBLE")
        ));

        JsonObject response = jdbc.request("APP", "EVENTS");

        assertFalse(response.has("error"), response.toString());
        var indexes = response.getAsJsonArray("result");
        assertEquals(1, indexes.size());
        JsonObject index = indexes.get(0).getAsJsonObject();
        assertEquals(List.of("LOWER(\"EVENT_NAME\")", "EVENT_TS"), index.getAsJsonArray("columns").asList()
            .stream().map(value -> value.getAsString()).toList());
        assertEquals(List.of(true, false), index.getAsJsonArray("key_is_expression").asList()
            .stream().map(value -> value.getAsBoolean()).toList());
        assertEquals(List.of("DESC", "ASC"), index.getAsJsonArray("key_directions").asList()
            .stream().map(value -> value.getAsString()).toList());
        assertEquals("INVISIBLE", index.get("visibility").getAsString());
        assertTrue(index.get("key_metadata_complete").getAsBoolean());
        assertTrue(jdbc.sql.get(0).toUpperCase().contains("ALL_IND_EXPRESSIONS"), jdbc.sql.get(0));
        assertTrue(jdbc.sql.get(0).toUpperCase().contains("DESCEND"), jdbc.sql.get(0));
        assertTrue(jdbc.sql.get(0).toUpperCase().contains("VISIBILITY"), jdbc.sql.get(0));
        assertTrue(jdbc.sql.get(0).toUpperCase().contains("PARTITIONED"), jdbc.sql.get(0));
        assertEquals(List.of("APP", "EVENTS"), jdbc.parameters);
    }

    @Test
    void marksUnsupportedIndexShapesIncompleteThroughProductionRpc() {
        for (Map<String, String> unsupported : List.of(
            row("IX_EVENT", "EVENT_TS", "1", "NONUNIQUE", "I", "NORMAL", "YES", null, "ASC", "VISIBLE"),
            row("IX_EVENT", "EVENT_TS", "1", "NONUNIQUE", "I", "FUNCTION-BASED BITMAP", "NO", null, "ASC", "VISIBLE")
        )) {
            JsonObject response = new Fixture(List.of(unsupported)).request("APP", "EVENTS");

            assertFalse(response.has("error"), response.toString());
            var indexes = response.getAsJsonArray("result");
            assertEquals(1, indexes.size());
            assertFalse(indexes.get(0).getAsJsonObject().get("key_metadata_complete").getAsBoolean());
        }
    }

    private static Map<String, String> row(String name, String column, String position, String uniqueness,
                                            String constraintType, String indexType, String partitioned, String expression,
                                            String descend, String visibility) {
        Map<String, String> row = new HashMap<>();
        row.put("INDEX_NAME", name);
        row.put("COLUMN_NAME", column);
        row.put("COLUMN_POSITION", position);
        row.put("UNIQUENESS", uniqueness);
        row.put("CONSTRAINT_TYPE", constraintType);
        row.put("INDEX_TYPE", indexType);
        row.put("PARTITIONED", partitioned);
        row.put("COLUMN_EXPRESSION", expression);
        row.put("DESCEND", descend);
        row.put("VISIBILITY", visibility);
        return row;
    }

    private static final class Fixture {
        final List<String> sql = new ArrayList<>();
        final List<String> parameters = new ArrayList<>();
        final JsonRpcServer server;

        Fixture(List<Map<String, String>> rows) {
            int[] index = {-1};
            ResultSet result = (ResultSet) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{ResultSet.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "next" -> ++index[0] < rows.size();
                    case "getString" -> rows.get(index[0]).get((String) args[0]);
                    case "getInt" -> Integer.parseInt(rows.get(index[0]).get((String) args[0]));
                    case "close" -> null;
                    default -> throw new UnsupportedOperationException(method.getName());
                });
            PreparedStatement statement = (PreparedStatement) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{PreparedStatement.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "setString" -> { parameters.add((String) args[1]); yield null; }
                    case "executeQuery" -> result;
                    case "close" -> null;
                    default -> throw new UnsupportedOperationException(method.getName());
                });
            Connection connection = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{Connection.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "prepareStatement" -> { sql.add((String) args[0]); yield statement; }
                    case "isClosed" -> false;
                    default -> throw new UnsupportedOperationException(method.getName());
                });
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent();
            TestSupport.setPrivateConnection(agent, connection);
            server = new JsonRpcServer(agent);
        }

        JsonObject request(String schema, String table) {
            JsonObject params = new JsonObject();
            params.addProperty("schema", schema);
            params.addProperty("table", table);
            JsonObject request = new JsonObject();
            request.addProperty("id", 1);
            request.addProperty("method", "list_indexes");
            request.add("params", params);
            return JsonParser.parseString(server.handleRequest(request.toString())).getAsJsonObject();
        }
    }
}
