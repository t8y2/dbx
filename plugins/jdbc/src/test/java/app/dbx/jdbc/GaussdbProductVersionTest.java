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

class GaussdbProductVersionTest {
    private static final String PRODUCT_VERSION_SQL = "SELECT setting FROM pg_settings WHERE name = 'product_version'";
    private static final String HOTPATCH_VERSION_SQL = "SELECT setting FROM pg_settings WHERE name = 'hotpatch_version'";

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }

    /**
     * A single-row ResultSet proxy: {@code next()} succeeds once, {@code getString(1)}
     * returns {@code value}, mirroring {@code SELECT setting FROM pg_settings ...}.
     */
    private static ResultSet result(String value) throws Exception {
        AtomicInteger index = new AtomicInteger(-1);
        return (ResultSet) Proxy.newProxyInstance(ResultSet.class.getClassLoader(), new Class<?>[]{ResultSet.class},
            (proxy, method, args) -> switch (method.getName()) {
                case "next" -> index.incrementAndGet() < 1;
                case "getString" -> value;
                default -> defaultValue(method.getReturnType());
            });
    }

    private static JsonNode info(String product, String serverVersion, String hotpatchVersion, boolean fail, AtomicInteger statements) throws Exception {
        DatabaseMetaData jdbc = (DatabaseMetaData) Proxy.newProxyInstance(DatabaseMetaData.class.getClassLoader(), new Class<?>[]{DatabaseMetaData.class},
            (proxy, method, args) -> switch (method.getName()) {
                case "getDatabaseProductName" -> product;
                case "getDatabaseProductVersion" -> "9.2.4";
                default -> defaultValue(method.getReturnType());
            });
        Statement statement = (Statement) Proxy.newProxyInstance(Statement.class.getClassLoader(), new Class<?>[]{Statement.class},
            (proxy, method, args) -> switch (method.getName()) {
                case "setQueryTimeout" -> null;
                case "executeQuery" -> {
                    if (fail) throw new SQLException("pg_settings unavailable");
                    yield switch (String.valueOf(args[0])) {
                        case PRODUCT_VERSION_SQL -> result(serverVersion);
                        case HOTPATCH_VERSION_SQL -> result(hotpatchVersion);
                        default -> throw new AssertionError("Unexpected query: " + args[0]);
                    };
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
    void productVersionComesFromPgSettingsWithoutHotpatchVersion() throws Exception {
        AtomicInteger statements = new AtomicInteger();
        JsonNode value = info("GaussDB", "V2.0-9.0.0.SPC0900", null, false, statements);
        assertEquals("GaussDB", value.path("productName").asText());
        assertEquals("V2.0-9.0.0.SPC0900", value.path("productVersion").asText());
        assertEquals(2, statements.get());
    }

    @Test
    void productVersionIncludesHotpatchVersionWhenPresent() throws Exception {
        JsonNode value = info("GaussDB", "V2.0-9.0.0.SPC0900", "1.0.0", false, new AtomicInteger());
        assertEquals("V2.0-9.0.0.SPC0900 (1.0.0)", value.path("productVersion").asText());
    }

    @Test
    void blankHotpatchVersionIsOmitted() throws Exception {
        JsonNode value = info("GaussDB", "V2.0-9.0.0.SPC0900", "   ", false, new AtomicInteger());
        assertEquals("V2.0-9.0.0.SPC0900", value.path("productVersion").asText());
    }

    @Test
    void unavailablePgSettingsKeepsTheJdbcReportedVersion() throws Exception {
        JsonNode value = info("GaussDB", null, null, false, new AtomicInteger());
        assertEquals("9.2.4", value.path("productVersion").asText());
        JsonNode failed = info("GaussDB", "V2.0-9.0.0.SPC0900", null, true, new AtomicInteger());
        assertEquals("9.2.4", failed.path("productVersion").asText());
    }

    @Test
    void nonGaussdbProductsAreNotQueried() throws Exception {
        for (String product : new String[]{"PostgreSQL", "H2", "openGauss"}) {
            AtomicInteger statements = new AtomicInteger();
            JsonNode value = info(product, "V2.0-9.0.0.SPC0900", null, false, statements);
            assertEquals("9.2.4", value.path("productVersion").asText());
            assertEquals(0, statements.get());
        }
    }
}
