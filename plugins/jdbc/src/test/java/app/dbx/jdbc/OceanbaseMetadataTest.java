package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class OceanbaseMetadataTest {
    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }

    private static JsonNode metadata(String product, String[][] values, boolean fail, AtomicInteger statements) throws Exception {
        DatabaseMetaData jdbc = (DatabaseMetaData) Proxy.newProxyInstance(DatabaseMetaData.class.getClassLoader(), new Class<?>[]{DatabaseMetaData.class},
            (proxy, method, args) -> switch (method.getName()) {
                case "getDatabaseProductName" -> product;
                case "getDatabaseProductVersion" -> "4.2.5.7";
                default -> defaultValue(method.getReturnType());
            });
        AtomicInteger index = new AtomicInteger(-1);
        ResultSet rows = (ResultSet) Proxy.newProxyInstance(ResultSet.class.getClassLoader(), new Class<?>[]{ResultSet.class},
            (proxy, method, args) -> switch (method.getName()) {
                case "next" -> index.incrementAndGet() < values.length;
                case "getString" -> values[index.get()][(Integer) args[0] - 1];
                default -> defaultValue(method.getReturnType());
            });
        AtomicInteger timeout = new AtomicInteger();
        Statement statement = (Statement) Proxy.newProxyInstance(Statement.class.getClassLoader(), new Class<?>[]{Statement.class},
            (proxy, method, args) -> switch (method.getName()) {
                case "setQueryTimeout" -> { timeout.set((Integer) args[0]); yield null; }
                case "executeQuery" -> {
                    assertTrue(timeout.get() > 0 && timeout.get() <= 5);
                    assertEquals("SHOW VARIABLES LIKE 'ob_compatibility_mode'", args[0]);
                    if (fail) throw new SQLException("isolated metadata unavailable");
                    yield rows;
                }
                default -> defaultValue(method.getReturnType());
            });
        Connection connection = (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class},
            (proxy, method, args) -> switch (method.getName()) {
                case "getMetaData" -> jdbc;
                case "createStatement" -> { statements.incrementAndGet(); yield statement; }
                case "commit", "rollback", "setAutoCommit" -> throw new AssertionError("Metadata must not change transactions");
                default -> defaultValue(method.getReturnType());
            });
        Method reader = DbxJdbcPlugin.class.getDeclaredMethod("databaseInfo", Connection.class);
        reader.setAccessible(true);
        return (JsonNode) reader.invoke(null, connection);
    }

    @Test
    void actualOceanbaseModeIsReadFromTheSameConnection() throws Exception {
        for (String mode : new String[]{"ORACLE", "mysql"}) {
            AtomicInteger statements = new AtomicInteger();
            JsonNode info = metadata("OceanBase", new String[][]{{"ob_compatibility_mode", mode}}, false, statements);
            assertEquals(mode.toLowerCase(java.util.Locale.ROOT), info.path("compatibilityMode").asText());
            assertEquals("OceanBase", info.path("productName").asText());
            assertEquals(1, statements.get());
        }
    }

    @Test
    void absentAmbiguousUnknownOrDeniedModesKeepOrdinaryMetadata() throws Exception {
        for (String[][] values : new String[][][]{
            {}, {{"ob_compatibility_mode", "UNKNOWN"}}, {{"other_variable", "ORACLE"}},
            {{"ob_compatibility_mode", "ORACLE"}, {"ob_compatibility_mode", "ORACLE"}},
            {{"ob_compatibility_mode", null}}
        }) {
            JsonNode info = metadata("OceanBase", values, false, new AtomicInteger());
            assertFalse(info.has("compatibilityMode"));
            assertEquals("4.2.5.7", info.path("productVersion").asText());
        }
        JsonNode failed = metadata("OceanBase", new String[0][], true, new AtomicInteger());
        assertFalse(failed.has("compatibilityMode"));
        assertEquals("OceanBase", failed.path("productName").asText());
    }

    @Test
    void otherProductsDoNotReceiveOceanbaseSql() throws Exception {
        for (String product : new String[]{"Oracle", "H2", "MySQL"}) {
            AtomicInteger statements = new AtomicInteger();
            JsonNode info = metadata(product, new String[0][], false, statements);
            assertEquals(product, info.path("productName").asText());
            assertFalse(info.has("compatibilityMode"));
            assertEquals(0, statements.get());
        }
    }
}
