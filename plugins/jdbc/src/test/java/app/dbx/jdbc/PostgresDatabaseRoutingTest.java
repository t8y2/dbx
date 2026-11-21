package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.*;

final class PostgresDatabaseRoutingTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final List<Physical> PHYSICAL = new CopyOnWriteArrayList<>();
    private final List<String> sessions = new ArrayList<>();

    @AfterEach
    void cleanup() throws Exception {
        for (String session : sessions) call("closeJdbcSession", params("a", null).put("jdbcSessionId", session));
        call("close", MAPPER.createObjectNode());
        var field = DbxJdbcPlugin.class.getDeclaredField("logicalDriverKey");
        field.setAccessible(true);
        field.set(null, null);
        PHYSICAL.clear();
    }

    @Test
    void metadataBindsTheRequestedPhysicalDatabaseAcrossAToBToA() throws Exception {
        for (String database : List.of("a", "b", "a")) {
            JsonNode result = ok(call("listSchemas", params("a", database)));
            assertEquals(List.of(database + "_only", "public"), MAPPER.convertValue(result, List.class));
        }
        assertEquals(List.of("a", "b", "a"), PHYSICAL.stream().map(physical -> physical.database).toList());
    }

    @Test
    void urlBindingPreservesEndpointsOptionsAndEscapesDatabaseNames() {
        String target = " sales/季度?&+#% ";
        ObjectNode config = config("jdbc:postgresql://[::1]:5433,standby:5434/a%20b?sslmode=require&user=u%40x&password=p%26x&dbname=old");
        config.put("database", target).put("url_params", "ApplicationName=dbx&PGDBNAME=also_old&options=-c%20search_path%3Dpublic");
        String url = DbxJdbcPlugin.jdbcUrl(config);
        assertEquals(target, database(url));
        assertTrue(url.startsWith("jdbc:postgresql://[::1]:5433,standby:5434/"));
        assertTrue(url.contains("sslmode=require&user=u%40x&password=p%26x"));
        assertTrue(url.contains("ApplicationName=dbx"));
        assertTrue(url.contains("options=-c%20search_path%3Dpublic"));
        assertFalse(url.contains("old"));
        assertFalse(url.contains("季度"));
    }

    @Test
    void targetConnectionKeepsRoutedEndpointCredentialsAndOptions() throws Exception {
        ObjectNode request = MAPPER.createObjectNode().put("database", "b");
        ObjectNode connection = config("jdbc:postgresql://127.0.0.1:25432/a?sslmode=require&user=url%40user&password=p%26%2Bword");
        connection.put("url_params", "ApplicationName=dbx&options=-c%20search_path%3Dpublic");
        request.set("connection", connection);
        ok(call("connect", request));
        Physical opened = PHYSICAL.getFirst();
        assertEquals("jdbc:postgresql://127.0.0.1:25432/b?sslmode=require&ApplicationName=dbx&options=-c%20search_path%3Dpublic", opened.url);
        assertEquals("url@user", opened.properties.getProperty("user"));
        assertEquals("p&+word", opened.properties.getProperty("password"));
        connection.put("username", "form@user").put("password", "form-password");
        ok(call("connect", request));
        assertEquals("form@user", PHYSICAL.getLast().properties.getProperty("user"));
        assertEquals("form-password", PHYSICAL.getLast().properties.getProperty("password"));
    }

    @Test
    void defaultAndUnspecifiedDatabasePreserveTheOriginalUrl() throws Exception {
        for (String url : List.of("jdbc:postgresql:a", "jdbc:postgresql:", "jdbc:postgresql://host/", "jdbc:postgresql://host/a?ApplicationName=dbx")) {
            assertEquals(url, DbxJdbcPlugin.jdbcUrl(config(url)));
            ObjectNode selected = config(url).put("database", "b");
            assertEquals("b", database(DbxJdbcPlugin.jdbcUrl(selected)));
        }
        assertEquals("a_only", ok(call("listSchemas", params("a", null))).get(0).asText());
        assertEquals("b_only", ok(call("listSchemas", params("b", null))).get(0).asText());
    }

    @Test
    void otherVendorsAndMalformedPostgresUrlsKeepTheirBoundaries() {
        for (String url : List.of("jdbc:h2:file:./sample", "jdbc:h2:tcp://host/sample", "jdbc:hive2://host/default", "jdbc:kingbase8://host/a")) {
            assertEquals(url, DbxJdbcPlugin.jdbcUrl(config(url).put("database", "b")));
        }
        for (String url : List.of("jdbc:postgresql://host", "jdbc:postgresql:/a", "jdbc:postgresql://host/a/b", "jdbc:postgresql://host/%xx")) {
            assertThrows(IllegalArgumentException.class, () -> DbxJdbcPlugin.jdbcUrl(config(url).put("database", "b")));
        }
    }

    @Test
    void missingAndDeniedTargetsNeverReturnTheOriginalDatabaseOrCloseIt() throws Exception {
        ok(call("listSchemas", params("a", "a")));
        Physical original = PHYSICAL.getFirst();
        for (String target : List.of("missing", "denied")) {
            JsonNode response = call("listSchemas", params("a", target));
            assertTrue(response.has("error"), response.toString());
            assertTrue(response.path("error").path("message").asText().contains(target));
            assertFalse(original.closed);
        }
        assertEquals("a_only", ok(call("listSchemas", params("a", "a"))).get(0).asText());
        assertEquals(1, PHYSICAL.size());
    }

    @Test
    void activeTransactionsRejectDatabaseChangesWithoutLosingTheirOwner() throws Exception {
        ok(call("beginManualTransaction", params("a", "a")));
        Physical owner = PHYSICAL.getFirst();
        assertFalse(owner.autoCommit);
        assertTrue(call("listSchemas", params("a", "b")).has("error"));
        assertTrue(call("executeInManualTransaction", params("a", "b").put("sql", "SELECT 1")).has("error"));
        assertFalse(owner.closed);
        assertFalse(owner.autoCommit);
        ok(call("rollbackManualTransaction", params("a", "a")));
        assertEquals(1, owner.rollbacks);
        assertEquals("b_only", ok(call("listSchemas", params("a", "b"))).get(0).asText());
    }

    @Test
    void concurrentLogicalSessionsKeepMetadataAndTransactionOwnersSeparate() throws Exception {
        List<CompletableFuture<JsonNode>> pending = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            String session = "postgres-" + i;
            sessions.add(session);
            ObjectNode request = params("a", i % 2 == 0 ? "a" : "b").put("jdbcSessionId", session);
            ok(call("openJdbcSession", request));
            pending.add(CompletableFuture.supplyAsync(() -> {
                try { return call("listSchemas", request); }
                catch (Exception error) { throw new RuntimeException(error); }
            }));
        }
        for (int i = 0; i < pending.size(); i++) {
            assertEquals((i % 2 == 0 ? "a" : "b") + "_only", ok(pending.get(i).get()).get(0).asText());
        }
        assertEquals(8, PHYSICAL.size());
        ok(call("beginManualTransaction", params("a", "a").put("jdbcSessionId", sessions.getFirst())));
        assertEquals(1, PHYSICAL.stream().filter(physical -> !physical.autoCommit).count());
        ok(call("closeJdbcSession", params("a", null).put("jdbcSessionId", sessions.getFirst())));
        assertEquals(1, PHYSICAL.stream().filter(physical -> physical.closed).count());
    }

    @Test
    void failedReconnectKeepsTheExistingLogicalSessionAndTransaction() throws Exception {
        String session = "reconnect";
        sessions.add(session);
        ObjectNode original = params("a", "a").put("jdbcSessionId", session);
        ok(call("openJdbcSession", original));
        ok(call("connect", original));
        Physical owner = PHYSICAL.getFirst();
        assertTrue(call("connect", params("a", "missing").put("jdbcSessionId", session)).has("error"));
        assertFalse(owner.closed);
        ok(call("beginManualTransaction", original));
        assertTrue(call("connect", params("a", "b").put("jdbcSessionId", session)).has("error"));
        assertFalse(owner.closed);
        ok(call("rollbackManualTransaction", original));
        assertEquals(1, owner.rollbacks);
        assertEquals("a_only", ok(call("listSchemas", original)).get(0).asText());
    }

    private static ObjectNode config(String url) {
        ObjectNode config = MAPPER.createObjectNode().put("connection_string", url)
            .put("jdbc_driver_class", FakeDriver.class.getName());
        config.putArray("jdbc_driver_paths");
        return config;
    }

    private static ObjectNode params(String savedDatabase, String target) {
        ObjectNode params = MAPPER.createObjectNode();
        params.set("connection", config("jdbc:postgresql://localhost/" + savedDatabase));
        if (target != null) params.put("database", target);
        return params;
    }

    private static JsonNode call(String method, ObjectNode params) throws Exception {
        ObjectNode request = MAPPER.createObjectNode().put("id", 1).put("method", method);
        request.set("params", params);
        var handler = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        handler.setAccessible(true);
        return (JsonNode) handler.invoke(null, request.toString());
    }

    private static JsonNode ok(JsonNode response) {
        assertFalse(response.has("error"), response.toString());
        return response.path("result");
    }

    private static String database(String url) {
        String location = url.substring("jdbc:postgresql:".length()).split("\\?", 2)[0];
        String value = location.startsWith("//") ? location.substring(location.indexOf('/', 2) + 1) : location;
        for (String part : url.substring(url.indexOf('?') + 1).split("&")) {
            if (part.startsWith("PGDBNAME=") || part.startsWith("dbname=")) value = part.substring(part.indexOf('=') + 1);
        }
        return URLDecoder.decode(value, StandardCharsets.UTF_8);
    }

    public static final class FakeDriver implements Driver {
        public Connection connect(String url, Properties properties) throws SQLException {
            if (!acceptsURL(url)) return null;
            String database = database(url);
            if (Set.of("missing", "denied").contains(database)) throw new SQLException(database + " database unavailable");
            Physical physical = new Physical(database, url, properties);
            PHYSICAL.add(physical);
            return physical.connection;
        }
        public boolean acceptsURL(String url) { return url.startsWith("jdbc:postgresql:"); }
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) { return new DriverPropertyInfo[0]; }
        public int getMajorVersion() { return 1; }
        public int getMinorVersion() { return 0; }
        public boolean jdbcCompliant() { return false; }
        public Logger getParentLogger() { return Logger.getGlobal(); }
    }

    private static final class Physical {
        final String database;
        final String url;
        final Properties properties;
        final Connection connection;
        boolean closed;
        boolean autoCommit = true;
        int rollbacks;

        Physical(String database, String url, Properties properties) {
            this.database = database;
            this.url = url;
            this.properties = properties;
            DatabaseMetaData metadata = proxy(DatabaseMetaData.class, (object, method, args) -> {
                if (method.getName().equals("supportsTransactions")) return true;
                if (method.getName().equals("getSchemas")) {
                    List<String> schemas = args == null || args[0] == null || database.equals(args[0])
                        ? List.of(database + "_only", "public") : List.of();
                    int[] row = {-1};
                    return proxy(ResultSet.class, (rs, operation, values) -> switch (operation.getName()) {
                        case "next" -> ++row[0] < schemas.size();
                        case "getString" -> "TABLE_CATALOG".equals(values[0]) ? database : schemas.get(row[0]);
                        default -> defaultValue(operation.getReturnType());
                    });
                }
                return defaultValue(method.getReturnType());
            });
            connection = proxy(Connection.class, (object, method, args) -> switch (method.getName()) {
                case "getMetaData" -> metadata;
                case "getCatalog" -> database;
                case "getAutoCommit" -> autoCommit;
                case "setAutoCommit" -> { autoCommit = (boolean) args[0]; yield null; }
                case "isClosed" -> closed;
                case "close" -> { closed = true; yield null; }
                case "rollback" -> { rollbacks++; yield null; }
                default -> defaultValue(method.getReturnType());
            });
        }
    }

    private static <T> T proxy(Class<T> type, java.lang.reflect.InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }
}
