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
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class OceanBaseOracleConstraintRpcTest {
    @Test
    void returnsCompositePrimaryKeyThroughProductionRpc() {
        Fixture jdbc = new Fixture(List.of(
            row("PK Orders", "P", null, "Second", "ENABLED", "VALIDATED"),
            row("PK Orders", "P", null, "First\"Id", "ENABLED", "VALIDATED")
        ));

        JsonObject response = jdbc.request("Mixed.Owner", "Orders");

        assertFalse(response.has("error"), response.toString());
        var constraints = response.getAsJsonArray("result");
        assertEquals(1, constraints.size());
        JsonObject key = constraints.get(0).getAsJsonObject();
        assertEquals("PK Orders", key.get("name").getAsString());
        assertEquals("PRIMARY KEY", key.get("constraint_type").getAsString());
        assertEquals(List.of("Second", "First\"Id"), key.getAsJsonArray("columns").asList()
            .stream().map(value -> value.getAsString()).toList());
        assertEquals("PRIMARY KEY (\"Second\", \"First\"\"Id\")", key.get("definition").getAsString());
        assertTrue(key.get("enabled").getAsBoolean());
        assertTrue(key.get("valid").getAsBoolean());
        assertEquals(List.of("Mixed.Owner", "Orders"), jdbc.parameters);
        assertTrue(jdbc.closed);
    }

    @Test
    void preservesMultilineChecksAndReportsUnknownStatesWithoutInventingValues() {
        String expression = "\"Amount\" > 0\nAND \"Note\" <> 'line\n two'";
        Map<String, String> unknown = row("CK_UNKNOWN", "C", null, null, null, "UNRECOGNIZED");
        unknown.put("DEFERRABLE", null);
        unknown.put("DEFERRED", null);
        Fixture jdbc = new Fixture(List.of(
            row("CK_MULTI", "C", expression, "Amount", "DISABLED", "NOT VALIDATED"),
            row("CK_MULTI", "C", expression, "Note", "DISABLED", "NOT VALIDATED"), unknown,
            row("UQ_CODE", "U", null, "Code", "ENABLED", "NOT VALIDATED")
        ));

        JsonObject response = jdbc.request("APP", "ORDERS");

        assertFalse(response.has("error"), response.toString());
        var constraints = response.getAsJsonArray("result");
        assertEquals(3, constraints.size());
        var check = constraints.get(0).getAsJsonObject();
        assertEquals(expression, check.get("definition").getAsString());
        assertFalse(check.get("enabled").getAsBoolean());
        assertFalse(check.get("valid").getAsBoolean());
        var unavailable = constraints.get(1).getAsJsonObject();
        assertEquals("", unavailable.get("definition").getAsString());
        for (String state : List.of("enabled", "valid", "deferrable", "initially_deferred")) {
            assertTrue(!unavailable.has(state) || unavailable.get(state).isJsonNull(), unavailable.toString());
        }
        assertEquals("UNIQUE (\"Code\")", constraints.get(2).getAsJsonObject().get("definition").getAsString());
    }

    @Test
    void emptyVisibleTableIsDifferentFromInaccessibleTableOrQueryFailure() {
        Fixture empty = new Fixture(List.of(Map.of()));
        assertEquals(0, empty.request("APP", "EMPTY").getAsJsonArray("result").size());
        JsonObject hidden = new Fixture(List.of()).request("OTHER", "EMPTY");
        assertFalse(hidden.has("result"));
        assertTrue(hidden.getAsJsonObject("error").get("message").getAsString().contains("not accessible"));
        Fixture denied = new Fixture(List.of());
        denied.failure = new SQLException("ORA-01031: insufficient privileges", "42000", 1031);
        JsonObject failure = denied.request("APP", "EMPTY");
        assertFalse(failure.has("result"));
        assertTrue(failure.getAsJsonObject("error").get("message").getAsString().contains("ORA-01031"));
    }

    @Test
    void excludesOnlyConfirmedSystemNotNullChecks() {
        Map<String, String> notNull = row("SYS_C01", "C", "\"Required\"\"Id\" IS NOT NULL",
            "Required\"Id", "ENABLED", "VALIDATED");
        notNull.put("GENERATED", "GENERATED NAME");
        notNull.put("NULLABLE", "N");
        Map<String, String> namedCheck = new java.util.HashMap<>(notNull);
        namedCheck.put("CONSTRAINT_NAME", "NAMED_NOT_NULL");
        namedCheck.put("GENERATED", "USER NAME");
        Map<String, String> userCheck = new java.util.HashMap<>(notNull);
        userCheck.put("CONSTRAINT_NAME", "SYS_C02");
        userCheck.put("SEARCH_CONDITION", "\"Required\"\"Id\" > 0");

        var constraints = new Fixture(List.of(notNull, namedCheck, userCheck))
            .request("APP", "ORDERS").getAsJsonArray("result");

        assertEquals(List.of("NAMED_NOT_NULL", "SYS_C02"), constraints.asList().stream()
            .map(value -> value.getAsJsonObject().get("name").getAsString()).toList());
    }

    private static Map<String, String> row(String name, String kind, String condition,
                                          String column, String status, String validated) {
        Map<String, String> row = new java.util.HashMap<>();
        row.put("CONSTRAINT_NAME", name);
        row.put("CONSTRAINT_TYPE", kind);
        row.put("SEARCH_CONDITION", condition);
        row.put("COLUMN_NAME", column);
        row.put("STATUS", status);
        row.put("VALIDATED", validated);
        row.put("DEFERRABLE", "NOT DEFERRABLE");
        row.put("DEFERRED", "IMMEDIATE");
        return row;
    }

    private static final class Fixture {
        final List<String> parameters = new ArrayList<>();
        final JsonRpcServer server;
        boolean closed;
        SQLException failure;

        Fixture(List<Map<String, String>> rows) {
            int[] index = {-1};
            ResultSet result = (ResultSet) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{ResultSet.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "next" -> ++index[0] < rows.size();
                    case "getString" -> rows.get(index[0]).get((String) args[0]);
                    case "close" -> { closed = true; yield null; }
                    default -> throw new UnsupportedOperationException(method.getName());
                });
            PreparedStatement statement = (PreparedStatement) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{PreparedStatement.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "setString" -> { parameters.add((String) args[1]); yield null; }
                    case "executeQuery" -> { if (failure != null) throw failure; yield result; }
                    case "close" -> null;
                    default -> throw new UnsupportedOperationException(method.getName());
                });
            Connection connection = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[]{Connection.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "prepareStatement" -> statement;
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
            request.addProperty("method", "list_constraints");
            request.add("params", params);
            return JsonParser.parseString(server.handleRequest(request.toString())).getAsJsonObject();
        }
    }
}
