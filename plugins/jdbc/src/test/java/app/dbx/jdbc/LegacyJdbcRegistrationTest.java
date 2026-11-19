package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class LegacyJdbcRegistrationTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @AfterEach
    void closeConnection() throws Exception {
        request("close", configuration("org.h2.Driver"), null);
    }

    @Test
    void legacyAliasesAndExplicitOrDefaultClassesReachTheProductionQueryPath() throws Exception {
        for (String driverClass : new String[] {"h2_embedded", "h2_embedded_v2", "org.h2.Driver", ""}) {
            ObjectNode connection = configuration(driverClass);
            JsonNode connected = request("connect", connection, null);
            assertFalse(connected.has("error"), connected.toString());
            JsonNode result = request("executeQuery", connection, "SELECT 1");
            assertFalse(result.has("error"), result.toString());
            assertEquals(1, result.path("result").path("rows").path(0).path(0).asInt());
            request("close", connection, null);
        }
    }

    @Test
    void cachedLegacyAliasCannotBypassUrlValidationAndRecoversAfterAnError() throws Exception {
        ObjectNode connection = configuration("h2_embedded_v2");
        JsonNode connected = request("connect", connection, null);
        assertFalse(connected.has("error"), connected.toString());

        ObjectNode mismatched = connection.deepCopy();
        mismatched.put("connection_string", "jdbc:postgresql://127.0.0.1/unused");
        JsonNode rejected = request("connect", mismatched, null);
        assertTrue(rejected.has("error"), rejected.toString());
        assertTrue(rejected.path("error").toString().contains("Missing Java class h2_embedded_v2."), rejected.toString());

        JsonNode recovered = request("executeQuery", connection, "SELECT 2");
        assertFalse(recovered.has("error"), recovered.toString());
        assertEquals(2, recovered.path("result").path("rows").path(0).path(0).asInt());
    }

    private static ObjectNode configuration(String driverClass) {
        ObjectNode connection = MAPPER.createObjectNode();
        connection.put("connection_string", "jdbc:h2:mem:legacy_registration_test");
        connection.put("username", "sa");
        connection.put("password", "");
        connection.put("jdbc_driver_class", driverClass);
        return connection;
    }

    private static JsonNode request(String method, ObjectNode connection, String sql) throws Exception {
        ObjectNode message = MAPPER.createObjectNode();
        message.put("id", 1);
        message.put("method", method);
        ObjectNode params = message.putObject("params");
        params.set("connection", connection);
        if (sql != null) params.put("sql", sql);
        Method handler = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        handler.setAccessible(true);
        return (JsonNode) handler.invoke(null, MAPPER.writeValueAsString(message));
    }
}
