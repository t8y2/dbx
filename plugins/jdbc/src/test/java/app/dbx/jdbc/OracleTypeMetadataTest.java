package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.Properties;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class OracleTypeMetadataTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String OWNER = "Mixed Owner";
    private static final String NAME = "Mixed Type";

    @Test
    void listsTypesAndBodiesThroughTheRpcWithExactOwnerAndPaging() throws Exception {
        for (String dialect : new String[] { "oracle", "dm", "oceanbase-oracle" }) {
            try (Fixture fixture = new Fixture(dialect)) {
                fixture.object(OWNER, NAME, "TYPE");
                fixture.object(OWNER, NAME, "TYPE BODY");
                fixture.object(OWNER.toUpperCase(), "Wrong owner", "TYPE");
                fixture.object(OWNER, "Unrelated", "PACKAGE");

                JsonNode all = fixture.list(OWNER, "TYPE", "TYPE_BODY");
                assertFalse(all.has("error"), all.toString());
                assertEquals(2, all.path("result").size());
                assertEquals("TYPE", all.path("result").path(0).path("object_type").asText());
                assertEquals("TYPE_BODY", all.path("result").path(1).path("object_type").asText());
                assertEquals(NAME, all.path("result").path(1).path("name").asText());
                assertEquals(OWNER, all.path("result").path(1).path("schema").asText());

                ObjectNode page = fixture.params(OWNER);
                page.putArray("object_types").add("TYPE").add("TYPE_BODY");
                page.put("filter", "Mixed");
                page.put("offset", 1);
                page.put("limit", 1);
                JsonNode paged = fixture.request("listObjects", page);
                assertFalse(paged.has("error"), paged.toString());
                assertEquals(1, paged.path("result").size());
                assertEquals("TYPE_BODY", paged.path("result").path(0).path("object_type").asText());
            }
        }
    }

    @Test
    void doesNotResolveMissingQuotedTypeOwnersToUppercase() throws Exception {
        try (Fixture fixture = new Fixture("oracle")) {
            fixture.object(OWNER.toUpperCase(), NAME, "TYPE");
            fixture.ddl(OWNER.toUpperCase(), NAME, "TYPE", "upper owner source");
            JsonNode listed = fixture.list(OWNER, "TYPE");
            assertFalse(listed.has("error"), listed.toString());
            assertEquals(0, listed.path("result").size());
            assertTrue(fixture.source(OWNER, NAME, "TYPE").has("error"));
        }
    }

    @Test
    void reportsTypeCatalogFailureWithoutBreakingTableOnlyFallback() throws Exception {
        try (Fixture fixture = new Fixture("oracle")) {
            fixture.catalog.createStatement().execute("DROP TABLE all_objects");
            fixture.catalog.createStatement().execute("CREATE TABLE sample_table(id INT)");
            assertTrue(fixture.list(OWNER, "TYPE").has("error"));
            fixture.catalog.createStatement().execute("DROP TABLE all_tab_comments");
            JsonNode tables = fixture.list("PUBLIC", "TABLE");
            assertFalse(tables.has("error"), tables.toString());
            boolean found = false;
            for (JsonNode table : tables.path("result")) {
                found |= "SAMPLE_TABLE".equals(table.path("name").asText());
            }
            assertTrue(found);
        }
    }

    @Test
    void readsCompleteTypeAndBodyClobsAsReadonlyWithoutMixingKinds() throws Exception {
        for (String dialect : new String[] { "oracle", "oceanbase-oracle" }) {
            try (Fixture fixture = new Fixture(dialect)) {
                String body = "CREATE TYPE BODY \"Mixed Type\" AS\n" + "-- long body\n".repeat(8000) + "END;";
                fixture.ddl(OWNER, NAME, "TYPE", "CREATE TYPE \"Mixed Type\" AS OBJECT(id NUMBER)");
                fixture.ddl(OWNER, NAME, "TYPE_BODY", body);
                JsonNode type = fixture.source(OWNER, NAME, "TYPE");
                JsonNode result = fixture.source(OWNER, NAME, "TYPE BODY");
                assertFalse(type.has("error"), type.toString());
                assertFalse(result.has("error"), result.toString());
                assertFalse(type.path("result").path("editable").asBoolean(true));
                assertFalse(result.path("result").path("editable").asBoolean(true));
                assertEquals(body, result.path("result").path("source").asText());
                assertFalse(type.path("result").path("source").asText().contains("BODY"));
            }
        }
    }

    @Test
    void fallsBackFromNullEmptyOrBlankDdlToOrderedExactTypeSource() throws Exception {
        for (String ddl : new String[] { null, "", "  \n" }) {
            for (String kind : new String[] { "TYPE", "TYPE_BODY" }) {
                for (String dialect : new String[] { "dm", "oceanbase-oracle" }) {
                    try (Fixture fixture = new Fixture(dialect)) {
                        String dictionaryKind = kind.replace('_', ' ');
                        fixture.ddl(OWNER, NAME, kind, ddl);
                        fixture.line(OWNER, NAME, dictionaryKind, 2, "END;\n");
                        fixture.line(OWNER, NAME, dictionaryKind, 1, dictionaryKind + " \"Mixed Type\" AS\n");
                        fixture.line(OWNER, NAME, kind.equals("TYPE") ? "TYPE BODY" : "TYPE", 1, "WRONG KIND");
                        fixture.line(OWNER.toUpperCase(), NAME, dictionaryKind, 1, "WRONG OWNER");
                        JsonNode source = fixture.source(OWNER, NAME, kind);
                        assertFalse(source.has("error"), source.toString());
                        assertEquals(dictionaryKind + " \"Mixed Type\" AS\nEND;\n", source.path("result").path("source").asText());
                        assertFalse(source.path("result").path("editable").asBoolean(true));
                    }
                }
            }
        }
    }

    @Test
    void doesNotApplyOracleTypeMetadataToOrdinaryOceanBaseOrMysqlUrls() throws Exception {
        for (String dialect : new String[] { "oceanbase", "mysql" }) {
            try (Fixture fixture = new Fixture(dialect)) {
                fixture.object(OWNER, NAME, "TYPE");
                fixture.ddl(OWNER, NAME, "TYPE", "CREATE TYPE should_not_be_read");
                JsonNode listed = fixture.list(OWNER, "TYPE", "TYPE_BODY");
                assertFalse(listed.has("error"), listed.toString());
                assertEquals(0, listed.path("result").size());
                assertTrue(fixture.source(OWNER, NAME, "TYPE").has("error"));
            }
        }
    }

    @Test
    void explicitOceanbaseOracleModeKeepsSchemaDiscoveryAndSqlPageBoundaries() throws Exception {
        try (Fixture fixture = new Fixture("oceanbase-oracle")) {
            JsonNode schemas = fixture.request("listSchemas", fixture.params(null));
            assertFalse(schemas.has("error"), schemas.toString());
            assertEquals(OWNER.toUpperCase(), schemas.path("result").path(0).asText());
            assertEquals(0, fixture.request("listDatabases", fixture.params(null)).path("result").size());

            ObjectNode query = fixture.params(null).put("database", "APP").put("maxRows", 2);
            query.put("sql", "SELECT X FROM SYSTEM_RANGE(1, 5) ORDER BY X");
            JsonNode first = fixture.request("executeQuery", query);
            assertFalse(first.has("error"), first.toString());
            assertEquals(2, first.path("result").path("rows").size());
            assertTrue(first.path("result").path("truncated").asBoolean());
            query.put("sql", "SELECT X FROM (SELECT X, ROWNUM rn FROM (SELECT X FROM SYSTEM_RANGE(1, 5) ORDER BY X)) WHERE rn > 2 AND rn <= 4");
            JsonNode second = fixture.request("executeQuery", query);
            assertFalse(second.has("error"), second.toString());
            assertEquals(3, second.path("result").path("rows").path(0).path(0).asInt());
            assertEquals(4, second.path("result").path("rows").path(1).path(0).asInt());
            assertFalse(second.path("result").path("truncated").asBoolean());
        }
    }

    @Test
    void fallsBackAfterDdlFailureButReportsMissingOrFailedSource() throws Exception {
        try (Fixture fixture = new Fixture("oracle")) {
            fixture.catalog.createStatement().execute("DROP TABLE type_ddl");
            String full = "TYPE BODY \"Mixed Type\" AS\n" + "-- source\n".repeat(8000) + "END;";
            fixture.line(OWNER, NAME, "TYPE BODY", 1, full);
            JsonNode source = fixture.source(OWNER, NAME, "TYPE_BODY");
            assertFalse(source.has("error"), source.toString());
            assertEquals(full, source.path("result").path("source").asText());
            assertTrue(fixture.source(OWNER, NAME, "TYPE").has("error"));
            fixture.catalog.createStatement().execute("DROP TABLE all_source");
            assertTrue(fixture.source(OWNER, NAME, "TYPE_BODY").has("error"));
        }
    }

    @Test
    void preservesRoutineOwnerResolutionAndSourceContract() throws Exception {
        try (Fixture fixture = new Fixture("oracle")) {
            fixture.ddl(OWNER.toUpperCase(), "PROC", "PROCEDURE", "CREATE PROCEDURE PROC AS BEGIN NULL; END;");
            JsonNode source = fixture.source(OWNER, "PROC", "PROCEDURE");
            assertFalse(source.has("error"), source.toString());
            assertEquals(OWNER.toUpperCase(), source.path("result").path("schema").asText());
            assertFalse(source.path("result").has("editable"));
        }
    }

    private static final class Fixture implements AutoCloseable, Driver {
        private final String url;
        private final String h2Url;
        private final ObjectNode connection;
        final Connection catalog;

        Fixture(String dialect) throws Exception {
            String id = UUID.randomUUID().toString().replace("-", "");
            url = switch (dialect) {
                case "oceanbase-oracle" -> "jdbc:oceanbase:oracle://localhost/dbx-types-" + id;
                case "oceanbase" -> "jdbc:oceanbase://localhost/dbx-types-" + id;
                default -> "jdbc:" + dialect + ":dbx-types:" + id;
            };
            h2Url = "jdbc:h2:mem:dbx_types_" + id;
            catalog = DriverManager.getConnection(h2Url, "sa", "");
            try (var statement = catalog.createStatement()) {
                statement.execute("CREATE TABLE all_users(username VARCHAR(128))");
                statement.execute("CREATE TABLE all_objects(owner VARCHAR(128), object_name VARCHAR(128), object_type VARCHAR(32))");
                statement.execute("CREATE TABLE all_tab_comments(owner VARCHAR(128), table_name VARCHAR(128), table_type VARCHAR(32), comments VARCHAR(128))");
                statement.execute("CREATE TABLE all_procedures(owner VARCHAR(128), object_name VARCHAR(128), object_type VARCHAR(32), procedure_name VARCHAR(128))");
                statement.execute("CREATE TABLE all_sequences(sequence_owner VARCHAR(128), sequence_name VARCHAR(128))");
                statement.execute("CREATE TABLE all_synonyms(owner VARCHAR(128), synonym_name VARCHAR(128))");
                statement.execute("CREATE TABLE all_source(owner VARCHAR(128), name VARCHAR(128), type VARCHAR(32), line INT, text CLOB)");
                statement.execute("CREATE TABLE type_ddl(ddl_owner VARCHAR(128), ddl_name VARCHAR(128), ddl_type VARCHAR(32), source CLOB)");
            }
            try (PreparedStatement ps = catalog.prepareStatement("INSERT INTO all_users VALUES (?)")) {
                ps.setString(1, OWNER.toUpperCase());
                ps.executeUpdate();
            }
            connection = MAPPER.createObjectNode().put("connection_string", url).put("username", "sa");
            DriverManager.registerDriver(this);
        }

        void object(String owner, String name, String type) throws SQLException {
            try (PreparedStatement ps = catalog.prepareStatement("INSERT INTO all_objects VALUES (?, ?, ?)")) {
                ps.setString(1, owner);
                ps.setString(2, name);
                ps.setString(3, type);
                ps.executeUpdate();
            }
        }

        void ddl(String owner, String name, String type, String source) throws SQLException {
            try (PreparedStatement ps = catalog.prepareStatement("INSERT INTO type_ddl VALUES (?, ?, ?, ?)")) {
                ps.setString(1, owner);
                ps.setString(2, name);
                ps.setString(3, type);
                ps.setString(4, source);
                ps.executeUpdate();
            }
        }

        void line(String owner, String name, String type, int line, String text) throws SQLException {
            try (PreparedStatement ps = catalog.prepareStatement("INSERT INTO all_source VALUES (?, ?, ?, ?, ?)")) {
                ps.setString(1, owner);
                ps.setString(2, name);
                ps.setString(3, type);
                ps.setInt(4, line);
                ps.setString(5, text);
                ps.executeUpdate();
            }
        }

        ObjectNode params(String schema) {
            ObjectNode params = MAPPER.createObjectNode();
            params.set("connection", connection);
            params.put("schema", schema);
            return params;
        }

        JsonNode list(String schema, String... kinds) throws Exception {
            ObjectNode params = params(schema);
            var types = params.putArray("object_types");
            for (String kind : kinds) types.add(kind);
            return request("listObjects", params);
        }

        JsonNode source(String schema, String name, String type) throws Exception {
            return request("getObjectSource", params(schema).put("name", name).put("object_type", type));
        }

        JsonNode request(String method, JsonNode params) throws Exception {
            Method handle = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
            handle.setAccessible(true);
            ObjectNode request = MAPPER.createObjectNode().put("id", 1).put("method", method);
            request.set("params", params);
            return MAPPER.valueToTree(handle.invoke(null, request.toString()));
        }

        @Override
        public Connection connect(String candidate, Properties properties) throws SQLException {
            if (!acceptsURL(candidate)) return null;
            Connection delegate = DriverManager.getConnection(h2Url, "sa", "");
            return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] { Connection.class }, (proxy, method, args) -> {
                if (method.getName().equals("prepareStatement") && args[0].equals("SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL")) {
                    return delegate.prepareStatement("SELECT source FROM type_ddl WHERE ddl_type = ? AND ddl_name = ? AND ddl_owner = ?");
                }
                try {
                    return method.invoke(delegate, args);
                } catch (InvocationTargetException e) {
                    throw e.getCause();
                }
            });
        }

        @Override public boolean acceptsURL(String candidate) { return url.equals(candidate); }
        @Override public DriverPropertyInfo[] getPropertyInfo(String candidate, Properties properties) { return new DriverPropertyInfo[0]; }
        @Override public int getMajorVersion() { return 1; }
        @Override public int getMinorVersion() { return 0; }
        @Override public boolean jdbcCompliant() { return false; }
        @Override public java.util.logging.Logger getParentLogger() { return java.util.logging.Logger.getGlobal(); }

        @Override
        public void close() throws Exception {
            try {
                request("close", params(null));
            } finally {
                DriverManager.deregisterDriver(this);
                catalog.close();
            }
        }
    }
}
