package com.dbx.agent;

import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PostgresLikeAgentTest {
    @Test
    void metadataQueriesUsePgCatalogInsteadOfInformationSchema() {
        TestPostgresLikeAgent agent = new TestPostgresLikeAgent();
        agent.connect(new ConnectParams());

        agent.listSchemas();
        agent.listTables("app");
        agent.listObjects("app");
        agent.getColumns("app", "orders");
        agent.listCheckConstraintsForTest("app", "orders");
        agent.listForeignKeys("app", "orders");
        agent.listTriggers("app", "orders");

        String sql = String.join("\n", MetadataSqlFake.statements);

        assertFalse(sql.contains("FROM information_schema"), sql);
        assertFalse(sql.contains("JOIN information_schema"), sql);
        assertTrue(sql.contains("pg_catalog.pg_namespace"), sql);
        assertTrue(sql.contains("pg_catalog.pg_class"), sql);
        assertTrue(sql.contains("pg_catalog.pg_proc"), sql);
        assertTrue(sql.contains("pg_catalog.pg_attribute"), sql);
        assertTrue(sql.contains("pg_catalog.pg_constraint"), sql);
        assertTrue(sql.contains("pg_catalog.pg_get_constraintdef"), sql);
        assertTrue(sql.contains("pg_catalog.pg_trigger"), sql);
        assertFalse(sql.contains(" AS key "), sql);
        assertFalse(sql.contains(" key."), sql);
    }

    @Test
    void mapsPgCatalogBooleanNullableValues() {
        TestPostgresLikeAgent agent = new TestPostgresLikeAgent(preparedConnection(
            resultSet(
                new String[]{"column_name"},
                new Object[][]{{"id"}}
            ),
            resultSet(
                new String[]{
                    "column_name",
                    "data_type",
                    "is_nullable",
                    "column_default",
                    "column_comment",
                    "numeric_precision",
                    "numeric_scale",
                    "character_maximum_length"
                },
                new Object[][]{
                    {"id", "integer", false, null, null, null, null, null},
                    {"name", "character varying(255)", true, null, "display name", null, null, 255}
                }
            )
        ));
        agent.connect(new ConnectParams());

        List<ColumnInfo> columns = agent.getColumns("public", "base_airspace");

        assertEquals(2, columns.size());
        assertTrue(columns.get(0).getIs_primary_key());
        assertFalse(columns.get(0).getIs_nullable());
        assertEquals("name", columns.get(1).getName());
        assertTrue(columns.get(1).getIs_nullable());
        assertEquals(Integer.valueOf(255), columns.get(1).getCharacter_maximum_length());
    }

    @Test
    void tableDdlIncludesNamedCheckConstraints() {
        ConstraintDdlAgent agent = new ConstraintDdlAgent();

        String ddl = agent.getTableDdl("public", "orders");

        assertTrue(
            ddl.contains("CONSTRAINT \"chk_balance_status\" CHECK (status = ANY (ARRAY['PLAN'::text, 'EXECUTION'::text]))"),
            ddl
        );
    }

    @Test
    void tableDdlFallsBackWhenCheckConstraintCatalogIsUnavailable() {
        ConstraintDdlAgent agent = new ConstraintDdlAgent(true);

        String ddl = agent.getTableDdl("public", "orders");

        assertTrue(ddl.startsWith("CREATE TABLE \"public\".\"orders\""), ddl);
        assertFalse(ddl.contains("CHECK"), ddl);
    }

    @Test
    void postgisGeometryTypeNameDetection() {
        assertTrue(PostgresLikeAgent.isPostgisGeometryTypeName("geometry"));
        assertTrue(PostgresLikeAgent.isPostgisGeometryTypeName("GEOMETRY"));
        assertTrue(PostgresLikeAgent.isPostgisGeometryTypeName(" Geography "));
        assertTrue(PostgresLikeAgent.isPostgisGeometryTypeName("public.geometry"));
        assertTrue(PostgresLikeAgent.isPostgisGeometryTypeName("geometry(Point,4326)"));
        assertFalse(PostgresLikeAgent.isPostgisGeometryTypeName(""));
        assertFalse(PostgresLikeAgent.isPostgisGeometryTypeName(null));
        assertFalse(PostgresLikeAgent.isPostgisGeometryTypeName("text"));
        assertFalse(PostgresLikeAgent.isPostgisGeometryTypeName("vector"));
    }

    @Test
    void executeQueryDecodesGeometryColumnsToWktAndReportsColumnTypes() {
        TestPostgresLikeAgent agent = new TestPostgresLikeAgent();
        agent.connect(new ConnectParams());

        QueryResult result = JdbcExecutor.INSTANCE.readResultSet(
            GeometryResultSet.create(),
            5L,
            JdbcExecutor.DEFAULT_MAX_ROWS,
            agent.geometryAwareResolverForTest()
        );

        assertEquals(2, result.getColumns().size());
        assertEquals("id", result.getColumns().get(0));
        assertEquals("geom", result.getColumns().get(1));

        // column_types is reported via JDBC getColumnTypeName
        assertEquals(2, result.getColumn_types().size());
        assertEquals("int4", result.getColumn_types().get(0));
        assertEquals("geometry", result.getColumn_types().get(1));

        // The geometry cell is decoded to WKT (matches Rust ewkb_to_wkt fixture).
        assertEquals(1, result.getRows().size());
        assertEquals(1, result.getRows().get(0).get(0));
        assertEquals("POINT(116.397 39.908)", result.getRows().get(0).get(1));
    }

    private static final class TestPostgresLikeAgent extends PostgresLikeAgent {
        private final Connection connection;

        private TestPostgresLikeAgent() {
            this(null);
        }

        private TestPostgresLikeAgent(Connection connection) {
            super(new PostgresLikeAgentProfile(
                PostgresLikeAgentTest.class.getName(),
                "jdbc:test://{host}:{port}/{database}"
            ));
            this.connection = connection;
        }

        @Override
        protected Connection openConnection(ConnectParams params) {
            if (connection != null) {
                return connection;
            }
            return MetadataSqlFake.connection();
        }

        JdbcExecutor.ColumnAwareResultValueReader geometryAwareResolverForTest() {
            return (rs, index, sqlType, columnTypeName) -> {
                if (PostgresLikeAgent.isPostgisGeometryTypeName(columnTypeName)) {
                    Object raw = rs.getObject(index);
                    if (rs.wasNull() || raw == null) {
                        return null;
                    }
                    return EwkbWktDecoder.decode(raw);
                }
                if (sqlType == Types.INTEGER) {
                    return rs.getInt(index);
                }
                return rs.getObject(index);
            };
        }

        List<CheckConstraintInfo> listCheckConstraintsForTest(String schema, String table) {
            return listCheckConstraints(schema, table);
        }
    }

    private static final class ConstraintDdlAgent extends PostgresLikeAgent {
        private final boolean failCheckConstraintLookup;

        private ConstraintDdlAgent() {
            this(false);
        }

        private ConstraintDdlAgent(boolean failCheckConstraintLookup) {
            super(new PostgresLikeAgentProfile(
                PostgresLikeAgentTest.class.getName(),
                "jdbc:test://{host}:{port}/{database}"
            ));
            this.failCheckConstraintLookup = failCheckConstraintLookup;
        }

        @Override
        public List<ColumnInfo> getColumns(String schema, String table) {
            return java.util.Arrays.asList(
                new ColumnInfo("id", "bigint", false, null, true),
                new ColumnInfo("status", "character varying", false, "'PLAN'::character varying", false)
            );
        }

        @Override
        public List<IndexInfo> listIndexes(String schema, String table) {
            return java.util.Collections.emptyList();
        }

        @Override
        public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
            return java.util.Collections.emptyList();
        }

        @Override
        protected List<CheckConstraintInfo> listCheckConstraints(String schema, String table) {
            if (failCheckConstraintLookup) {
                throw new RuntimeException("pg_get_constraintdef is unavailable");
            }
            return java.util.Collections.singletonList(new CheckConstraintInfo(
                "chk_balance_status",
                "CHECK (status = ANY (ARRAY['PLAN'::text, 'EXECUTION'::text]))"
            ));
        }
    }

    private static Connection preparedConnection(ResultSet... resultSets) {
        int[] resultSetIndex = {0};
        return proxy(Connection.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("prepareStatement".equals(name)) {
                    return proxy(PreparedStatement.class, new MethodHandler() {
                        @Override
                        public Object handle(Method method, Object[] args) {
                            String name = method.getName();
                            if ("executeQuery".equals(name)) {
                                int current = Math.min(resultSetIndex[0], resultSets.length - 1);
                                resultSetIndex[0] += 1;
                                return resultSets[current];
                            }
                            if ("setString".equals(name) || "close".equals(name)) {
                                return null;
                            }
                            return defaultValue(method.getReturnType());
                        }
                    });
                }
                if ("isClosed".equals(name)) {
                    return false;
                }
                if ("close".equals(name)) {
                    return null;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSet resultSet(String[] columns, Object[][] rows) {
        int[] index = {-1};
        boolean[] wasNull = {false};
        return proxy(ResultSet.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String name = method.getName();
                if ("next".equals(name)) {
                    index[0] += 1;
                    return index[0] < rows.length;
                }
                if ("getString".equals(name)) {
                    Object value = columnValue(columns, rows[index[0]], args[0]);
                    wasNull[0] = value == null;
                    return value == null ? null : String.valueOf(value);
                }
                if ("getBoolean".equals(name)) {
                    Object value = columnValue(columns, rows[index[0]], args[0]);
                    wasNull[0] = value == null;
                    if (value instanceof Boolean) {
                        return value;
                    }
                    if (value instanceof Number) {
                        return ((Number) value).intValue() != 0;
                    }
                    String text = String.valueOf(value);
                    return "1".equals(text)
                        || "t".equalsIgnoreCase(text)
                        || "true".equalsIgnoreCase(text)
                        || "yes".equalsIgnoreCase(text);
                }
                if ("getInt".equals(name)) {
                    Object value = columnValue(columns, rows[index[0]], args[0]);
                    wasNull[0] = value == null;
                    if (value instanceof Number) {
                        return ((Number) value).intValue();
                    }
                    return value == null ? 0 : Integer.parseInt(String.valueOf(value));
                }
                if ("getObject".equals(name)) {
                    Object value = columnValue(columns, rows[index[0]], args[0]);
                    wasNull[0] = value == null;
                    return value;
                }
                if ("wasNull".equals(name)) {
                    return wasNull[0];
                }
                if ("close".equals(name)) {
                    return null;
                }
                return defaultValue(method.getReturnType());
            }
        });
    }

    private static Object columnValue(String[] columns, Object[] row, Object key) {
        if (key instanceof Number) {
            return row[((Number) key).intValue() - 1];
        }
        for (int i = 0; i < columns.length; i++) {
            if (columns[i].equalsIgnoreCase(String.valueOf(key))) {
                return row[i];
            }
        }
        return null;
    }

    private static <T> T proxy(Class<T> type, final MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) {
                return handler.handle(method, args);
            }
        };
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler));
    }

    private static Object defaultValue(Class<?> type) {
        if (Boolean.TYPE.equals(type)) {
            return false;
        }
        if (Byte.TYPE.equals(type)) {
            return (byte) 0;
        }
        if (Short.TYPE.equals(type)) {
            return (short) 0;
        }
        if (Integer.TYPE.equals(type)) {
            return 0;
        }
        if (Long.TYPE.equals(type)) {
            return 0L;
        }
        if (Float.TYPE.equals(type)) {
            return 0f;
        }
        if (Double.TYPE.equals(type)) {
            return 0.0d;
        }
        if (Character.TYPE.equals(type)) {
            return '\0';
        }
        return null;
    }

    private static final class GeometryResultSet {
        static ResultSet create() {
            ResultSetMetaData meta = (ResultSetMetaData) Proxy.newProxyInstance(
                GeometryResultSet.class.getClassLoader(),
                new Class<?>[]{ResultSetMetaData.class},
                (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getColumnCount":
                            return 2;
                        case "getColumnLabel":
                        case "getColumnName":
                            return ((Integer) args[0]) == 1 ? "id" : "geom";
                        case "getColumnType":
                            return ((Integer) args[0]) == 1 ? Types.INTEGER : Types.OTHER;
                        case "getColumnTypeName":
                            return ((Integer) args[0]) == 1 ? "int4" : "geometry";
                        default:
                            return null;
                    }
                }
            );

            // POINT(116.397 39.908) with SRID=4326, little-endian.
            String hex = "0101000020E6100000C520B07268195D404E62105839F44340";
            byte[] geomBytes = parseHex(hex);

            int[] cursor = new int[]{0}; // 0 = before first row
            return (ResultSet) Proxy.newProxyInstance(
                GeometryResultSet.class.getClassLoader(),
                new Class<?>[]{ResultSet.class},
                (proxy, method, args) -> {
                    String name = method.getName();
                    switch (name) {
                        case "getMetaData":
                            return meta;
                        case "next":
                            cursor[0] += 1;
                            return cursor[0] == 1;
                        case "getInt":
                            return cursor[0] == 1 ? 1 : 0;
                        case "getObject":
                            return ((Integer) args[0]) == 2 ? geomBytes : 1;
                        case "wasNull":
                            return false;
                        case "close":
                            return null;
                        default:
                            return defaultPrimitive(method.getReturnType());
                    }
                }
            );
        }

        private static byte[] parseHex(String s) {
            byte[] out = new byte[s.length() / 2];
            for (int i = 0; i < out.length; i++) {
                int hi = Character.digit(s.charAt(i * 2), 16);
                int lo = Character.digit(s.charAt(i * 2 + 1), 16);
                out[i] = (byte) ((hi << 4) | lo);
            }
            return out;
        }

        private static Object defaultPrimitive(Class<?> t) {
            if (Boolean.TYPE.equals(t)) return false;
            if (Integer.TYPE.equals(t)) return 0;
            if (Long.TYPE.equals(t)) return 0L;
            if (Double.TYPE.equals(t)) return 0.0;
            return null;
        }
    }

    private static final class MetadataSqlFake {
        private static final List<String> statements = new ArrayList<String>();

        private static Connection connection() {
            statements.clear();
            return proxy(Connection.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    String name = method.getName();
                    if ("prepareStatement".equals(name)) {
                        statements.add((String) args[0]);
                        return preparedStatement();
                    }
                    if ("isClosed".equals(name)) {
                        return false;
                    }
                    if ("close".equals(name)) {
                        return null;
                    }
                    return defaultValue(method.getReturnType());
                }
            });
        }

        private static PreparedStatement preparedStatement() {
            final ResultSet resultSet = emptyResultSet();
            return proxy(PreparedStatement.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    String name = method.getName();
                    if ("executeQuery".equals(name)) {
                        return resultSet;
                    }
                    if ("setString".equals(name)) {
                        statements.add("param:" + args[0] + "=" + args[1]);
                        return null;
                    }
                    if ("close".equals(name)) {
                        return null;
                    }
                    return defaultValue(method.getReturnType());
                }
            });
        }

        private static ResultSet emptyResultSet() {
            final ResultSetMetaData metadata = proxy(ResultSetMetaData.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    if ("getColumnCount".equals(method.getName())) {
                        return 0;
                    }
                    return defaultValue(method.getReturnType());
                }
            });
            return proxy(ResultSet.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    String name = method.getName();
                    if ("next".equals(name)) {
                        return false;
                    }
                    if ("getMetaData".equals(name)) {
                        return metadata;
                    }
                    if ("close".equals(name)) {
                        return null;
                    }
                    return defaultValue(method.getReturnType());
                }
            });
        }
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args);
    }
}
