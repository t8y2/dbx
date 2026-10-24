package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.*;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class OceanbaseTemporalValueTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }

    private static ResultSetMetaData metadata(int code, String name) {
        return (ResultSetMetaData) Proxy.newProxyInstance(ResultSetMetaData.class.getClassLoader(), new Class<?>[]{ResultSetMetaData.class},
            (proxy, method, args) -> switch (method.getName()) {
                case "getColumnCount" -> 1;
                case "getColumnType" -> code;
                case "getColumnTypeName" -> name;
                case "getColumnLabel", "getColumnName" -> "VALUE";
                default -> defaultValue(method.getReturnType());
            });
    }

    private static ResultSet rows(int code, String name, String[] values, List<String> calls, boolean fail) {
        AtomicInteger position = new AtomicInteger(-1);
        return (ResultSet) Proxy.newProxyInstance(ResultSet.class.getClassLoader(), new Class<?>[]{ResultSet.class},
            (proxy, method, args) -> switch (method.getName()) {
                case "next" -> position.incrementAndGet() < values.length;
                case "getMetaData" -> metadata(code, name);
                case "getString" -> {
                    calls.add("getString");
                    if (fail) throw new SQLException("temporal_text_unavailable", "HY000", 701);
                    yield values[Math.max(position.get(), 0)];
                }
                case "getObject" -> { calls.add("getObject"); yield new Object(); }
                default -> defaultValue(method.getReturnType());
            });
    }

    private static Object read(ResultSet rs, int code, String name) throws Exception {
        Method method = DbxJdbcPlugin.class.getDeclaredMethod("readValue", ResultSet.class, ResultSetMetaData.class, int.class, boolean.class);
        method.setAccessible(true);
        return method.invoke(null, rs, metadata(code, name), 1, false);
    }

    @Test
    void preservesKnownPrivateTemporalTextPrecisionOffsetRegionAndNullWithoutMaterializingVendorObjects() throws Exception {
        for (int code : new int[]{-101, -102}) {
            String name = code == -101 ? "  timestamp with time zone " : "TIMESTAMP WITH LOCAL TIME ZONE";
            for (String value : new String[]{"2032-01-01 23:54:25.123456789 +5:30", "2032-01-01 23:54:25.987654321 -3:30", "2032-01-02 07:54:25.123456 Asia/Shanghai", null}) {
                for (int repeated = 0; repeated < 2; repeated++) {
                    List<String> calls = new ArrayList<>();
                    assertEquals(value, read(rows(code, name, new String[]{value}, calls, false), code, name));
                    assertEquals(List.of("getString"), calls);
                }
            }
        }
    }

    @Test
    void propagatesKnownTemporalTextFailuresRatherThanReturningHashOrNull() {
        for (int code : new int[]{-101, -102}) {
            String name = code == -101 ? "TIMESTAMP WITH TIME ZONE" : "TIMESTAMP WITH LOCAL TIME ZONE";
            List<String> calls = new ArrayList<>();
            InvocationTargetException error = assertThrows(InvocationTargetException.class, () -> read(rows(code, name, new String[]{"unused"}, calls, true), code, name));
            assertInstanceOf(SQLException.class, error.getCause());
            assertEquals(701, ((SQLException) error.getCause()).getErrorCode());
            assertEquals(List.of("getString"), calls);
        }
    }

    @Test
    void leavesMismatchedUnknownAndStandardTemporalObjectsOnTheirExistingPath() throws Exception {
        for (Object[] type : new Object[][]{{-101, "TIMESTAMP WITH LOCAL TIME ZONE"}, {-102, "TIMESTAMP WITH TIME ZONE"}, {-101, "OTHER"}, {-102, null}, {Types.OTHER, "TIMESTAMP WITH TIME ZONE"}, {Types.TIMESTAMP_WITH_TIMEZONE, "TIMESTAMP WITH TIME ZONE"}}) {
            AtomicInteger objects = new AtomicInteger();
            OffsetDateTime value = OffsetDateTime.parse("2032-01-01T23:54:25.123456789-03:30");
            ResultSet rs = (ResultSet) Proxy.newProxyInstance(ResultSet.class.getClassLoader(), new Class<?>[]{ResultSet.class}, (proxy, method, args) -> {
                if (method.getName().equals("getObject")) { objects.incrementAndGet(); return value; }
                if (method.getName().equals("getString")) throw new AssertionError("Unexpected private temporal mapping");
                return defaultValue(method.getReturnType());
            });
            assertEquals(value.toString(), read(rs, (int) type[0], (String) type[1]));
            assertEquals(1, objects.get());
        }
    }

    private static JsonNode request(String method, String params) throws Exception {
        Method handler = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        handler.setAccessible(true);
        return MAPPER.valueToTree(handler.invoke(null, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"" + method + "\",\"params\":" + params + "}"));
    }

    @Test
    void ordinaryAndPagedQueriesConsumeTheSameStableTemporalReader() throws Exception {
        List<String> calls = new ArrayList<>();
        String[] values = {"2032-01-01 23:54:25.123456789 +5:30", null, "2032-01-01 23:54:25.987654 -3:30"};
        Driver driver = new Driver() {
            public Connection connect(String url, Properties info) {
                if (!acceptsURL(url)) return null;
                return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> switch (method.getName()) {
                    case "createStatement" -> {
                        ResultSet result = rows(-101, "TIMESTAMP WITH TIME ZONE", values, calls, false);
                        yield Proxy.newProxyInstance(Statement.class.getClassLoader(), new Class<?>[]{Statement.class}, (statement, invoked, parameters) -> switch (invoked.getName()) {
                            case "execute" -> true;
                            case "getResultSet" -> result;
                            case "getUpdateCount" -> -1;
                            default -> defaultValue(invoked.getReturnType());
                        });
                    }
                    default -> defaultValue(method.getReturnType());
                });
            }
            public boolean acceptsURL(String url) { return url != null && url.startsWith("jdbc:dbx-temporal:"); }
            public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) { return new DriverPropertyInfo[0]; }
            public int getMajorVersion() { return 1; }
            public int getMinorVersion() { return 0; }
            public boolean jdbcCompliant() { return false; }
            public java.util.logging.Logger getParentLogger() { return java.util.logging.Logger.getGlobal(); }
        };
        DriverManager.registerDriver(driver);
        String connection = "{\"connection_string\":\"jdbc:dbx-temporal:stable\",\"username\":\"test\"}";
        try {
            JsonNode ordinary = request("executeQuery", "{\"connection\":" + connection + ",\"sql\":\"SELECT VALUE\",\"maxRows\":10}");
            assertFalse(ordinary.has("error"), ordinary.toString());
            assertEquals(values[0], ordinary.path("result").path("rows").get(0).get(0).asText());
            assertTrue(ordinary.path("result").path("rows").get(1).get(0).isNull());
            JsonNode first = request("executeQueryPage", "{\"connection\":" + connection + ",\"sql\":\"SELECT VALUE\",\"pageSize\":1}");
            assertFalse(first.has("error"), first.toString());
            assertEquals(values[0], first.path("result").path("rows").get(0).get(0).asText());
            String cursor = first.path("result").path("session_id").asText();
            assertFalse(cursor.isEmpty());
            JsonNode next = request("fetchQueryPage", "{\"connection\":" + connection + ",\"sessionId\":\"" + cursor + "\",\"pageSize\":2}");
            assertFalse(next.has("error"), next.toString());
            assertTrue(next.path("result").path("rows").get(0).get(0).isNull());
            assertEquals(values[2], next.path("result").path("rows").get(1).get(0).asText());
            assertFalse(calls.contains("getObject"));
        } finally {
            request("close", "{\"connection\":" + connection + "}");
            DriverManager.deregisterDriver(driver);
        }
    }
}
