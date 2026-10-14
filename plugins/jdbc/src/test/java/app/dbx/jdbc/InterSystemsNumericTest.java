package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;

import static org.junit.jupiter.api.Assertions.*;

final class InterSystemsNumericTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @AfterEach
    void close() throws Exception {
        call("close", MAPPER.createObjectNode());
        set("registeredDriver", null);
        set("registeredDriverKey", "");
    }

    @Test
    void preservesIntegerPrecisionInQueriesAndCursorPages() throws Exception {
        String[] values = { "2147483648", "-2147483649", "9223372036854775807",
            "9223372036854775808", "-9223372036854775809", "0", null, "42" };
        for (String url : new String[] { "jdbc:Cache://localhost/USER", "jdbc:IRIS://localhost/USER" }) {
            for (int type : new int[] { Types.TINYINT, Types.SMALLINT, Types.INTEGER, Types.BIGINT }) {
                Fixture fixture = new Fixture(url, type, values, null);
                JsonNode query = fixture.query("executeQuery");
                assertFalse(query.has("error"), query.toString());
                for (int rowIndex = 0; rowIndex < values.length; rowIndex++) {
                    assertValue(values[rowIndex], query.path("result").path("rows").path(rowIndex).path(0));
                }
                JsonNode page = fixture.query("executeQueryPage");
                int row = 0;
                while (true) {
                    assertFalse(page.has("error"), page.toString());
                    for (JsonNode item : page.path("result").path("rows")) assertValue(values[row++], item.path(0));
                    if (!page.path("result").path("has_more").asBoolean()) break;
                    ObjectNode params = fixture.params();
                    params.put("sessionId", page.path("result").path("session_id").asText());
                    page = call("fetchQueryPage", params);
                }
                assertEquals(values.length, row);
                assertEquals(2, fixture.closedStatements);
                close();
            }
        }
    }

    @Test
    void preservesOtherTypesAndDoesNotTrustVendorNamesInUserText() throws Exception {
        for (int type : new int[] { Types.LONGVARCHAR, Types.DECIMAL, Types.BOOLEAN,
            Types.VARBINARY, Types.TIMESTAMP }) {
            Fixture fixture = new Fixture("jdbc:Cache://localhost/USER", type, new String[] { "42" }, null);
            JsonNode response = fixture.query("executeQuery");
            assertFalse(response.has("error"), response.toString());
            assertEquals(0, fixture.decimalReads);
            if (type == Types.LONGVARCHAR) assertEquals("42", response.path("result").path("rows").path(0).path(0).asText());
            if (type == Types.BOOLEAN) assertTrue(response.path("result").path("rows").path(0).path(0).asBoolean());
            close();
        }
        Fixture fixture = new Fixture("jdbc:other:cache", Types.INTEGER, new String[] { "2147483648" }, null);
        fixture.config.put("name", "InterSystems Caché");
        fixture.config.put("driver_profile", "cache");
        fixture.install();
        JsonNode response = fixture.query("executeQuery");
        assertEquals("Numeric value out of range", response.path("error").path("message").asText());
        assertEquals(0, fixture.decimalReads);
    }

    @Test
    void preservesDriverFailuresAndClosesFailedQueryStatements() throws Exception {
        for (String method : new String[] { "executeQuery", "executeQueryPage" }) {
            Fixture fixture = new Fixture("jdbc:Cache://localhost/USER", Types.INTEGER,
                new String[] { "42" }, new SQLException("numeric transport failed", "08006"));
            JsonNode response = fixture.query(method);
            assertEquals("numeric transport failed", response.path("error").path("message").asText());
            assertEquals(1, fixture.closedStatements);
            close();
        }
    }

    @Test
    void recognizesOnlyExactDriverClassesAndClosesCursorEarly() throws Exception {
        for (String driver : new String[] { "com.intersys.jdbc.CacheDriver", "com.intersystems.jdbc.IRISDriver" }) {
            Fixture fixture = new Fixture("jdbc:custom:local", Types.INTEGER,
                new String[] { "2147483648", "-2147483649", "42" }, null);
            fixture.config.put("jdbc_driver_class", driver);
            fixture.install();
            JsonNode page = fixture.query("executeQueryPage");
            assertFalse(page.has("error"), page.toString());
            String id = page.path("result").path("session_id").asText();
            ObjectNode params = fixture.params().put("sessionId", id);
            assertTrue(call("closeQuerySession", params).path("result").path("ok").asBoolean());
            assertTrue(call("fetchQueryPage", params).has("error"));
            assertEquals(1, fixture.closedStatements);
            close();
        }
    }

    private static void assertValue(String expected, JsonNode actual) {
        if (expected == null) assertTrue(actual.isNull());
        else {
            assertTrue(actual.isNumber(), actual.toString());
            assertEquals(0, new BigDecimal(expected).compareTo(actual.decimalValue()));
            assertEquals(expected, actual.toString());
        }
    }

    private static final class Fixture {
        final ObjectNode config = MAPPER.createObjectNode();
        final int type;
        final String[] values;
        final SQLException failure;
        int decimalReads;
        int closedStatements;

        Fixture(String url, int type, String[] values, SQLException failure) throws Exception {
            this.type = type;
            this.values = values;
            this.failure = failure;
            config.put("connection_string", url);
            install();
        }

        void install() throws Exception {
            Connection connection = proxy(Connection.class, (proxyInstance, invokedMethod, arguments) -> switch (invokedMethod.getName()) {
                case "createStatement" -> statement();
                case "getAutoCommit" -> true;
                default -> defaultValue(invokedMethod.getReturnType());
            });
            set("registeredDriver", proxy(Driver.class, (proxyInstance, invokedMethod, arguments) -> defaultValue(invokedMethod.getReturnType())));
            set("registeredDriverKey", key("driverKey"));
            set("sharedConnection", connection);
            set("sharedConnectionKey", key("connectionKey"));
        }

        Object key(String name) throws Exception {
            Method method = DbxJdbcPlugin.class.getDeclaredMethod(name, JsonNode.class);
            method.setAccessible(true);
            return method.invoke(null, config);
        }

        ObjectNode params() {
            ObjectNode params = MAPPER.createObjectNode();
            params.set("connection", config);
            params.put("sql", "SELECT value FROM sample");
            params.put("pageSize", 2);
            return params;
        }

        JsonNode query(String method) throws Exception { return call(method, params()); }

        Statement statement() {
            ResultSet result = resultSet();
            return proxy(Statement.class, (proxyInstance, invokedMethod, arguments) -> switch (invokedMethod.getName()) {
                case "execute" -> true;
                case "getResultSet", "executeQuery" -> result;
                case "close" -> { closedStatements++; yield null; }
                default -> defaultValue(invokedMethod.getReturnType());
            });
        }

        ResultSet resultSet() {
            int[] row = { -1 };
            ResultSetMetaData meta = proxy(ResultSetMetaData.class, (proxyInstance, invokedMethod, arguments) -> switch (invokedMethod.getName()) {
                case "getColumnCount" -> 1;
                case "getColumnType" -> type;
                case "getColumnLabel", "getColumnName" -> "value";
                default -> defaultValue(invokedMethod.getReturnType());
            });
            return proxy(ResultSet.class, (proxyInstance, invokedMethod, arguments) -> switch (invokedMethod.getName()) {
                case "next" -> ++row[0] < values.length;
                case "getMetaData" -> meta;
                case "getBigDecimal" -> {
                    decimalReads++;
                    if (failure != null) throw failure;
                    yield values[row[0]] == null ? null : new BigDecimal(values[row[0]]);
                }
                case "getObject" -> {
                    if (failure != null) throw failure;
                    String value = values[row[0]];
                    if (value == null) yield null;
                    if (type == Types.LONGVARCHAR) throw new AssertionError("LONGVARCHAR used getObject");
                    if (type == Types.TIMESTAMP) yield java.sql.Timestamp.valueOf("2026-10-02 00:00:00");
                    if (type == Types.VARBINARY) yield new byte[] { 1, 2 };
                    BigDecimal decimal = new BigDecimal(value);
                    if (type == Types.DECIMAL) yield decimal;
                    try { yield decimal.intValueExact(); }
                    catch (ArithmeticException error) { throw new SQLException("Numeric value out of range"); }
                }
                case "getString" -> values[row[0]];
                case "getBoolean" -> true;
                case "getBytes" -> new byte[] { 1, 2 };
                default -> defaultValue(invokedMethod.getReturnType());
            });
        }
    }

    private static JsonNode call(String method, ObjectNode params) throws Exception {
        Method handler = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        handler.setAccessible(true);
        ObjectNode request = MAPPER.createObjectNode().put("id", 1).put("method", method);
        request.set("params", params);
        return (JsonNode) handler.invoke(null, request.toString());
    }

    private static void set(String name, Object value) throws Exception {
        Object target = null;
        Class<?> owner = DbxJdbcPlugin.class;
        if (name.startsWith("sharedConnection")) {
            Method method = owner.getDeclaredMethod("connectionState");
            method.setAccessible(true);
            target = method.invoke(null);
            owner = target.getClass();
        }
        Field field = owner.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(InterSystemsNumericTest.class.getClassLoader(), new Class<?>[] { type }, handler));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }
}
