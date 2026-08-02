package com.dbx.agent.vastbase;

import com.dbx.agent.AbstractJdbcAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

class VastbaseAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new VastbaseAgent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL sample_proc()";
    }

    @Test
    void declaresVastbasePostgresLikeProfile() {
        VastbaseAgent agent = new VastbaseAgent();

        Assertions.assertEquals("cn.com.vastbase.Driver", agent.getProfile().getDriverClass());
        Assertions.assertEquals("jdbc:vastbase://{host}:{port}/{database}", agent.getProfile().getUrlTemplate());
        Assertions.assertTrue(agent.getProfile().mapsCatalogAttributeArraysInJava());
    }

    @Test
    void mapsTablesWithoutPrimaryKeysFromCatalogArrays() throws Exception {
        VastbaseMetadataFake metadata = new VastbaseMetadataFake(null);
        VastbaseAgent agent = agentWithConnection(metadata.connection());

        List<ColumnInfo> columns = agent.getColumns("avatar_asset", "app_config_info");

        Assertions.assertFalse(column(columns, "id").getIs_primary_key());
        Assertions.assertFalse(column(columns, "tenant_id").getIs_primary_key());
        metadata.assertUsesPostgres92CompatibleSql();
    }

    @Test
    void mapsSinglePrimaryKeysFromCatalogArrays() throws Exception {
        VastbaseMetadataFake metadata = new VastbaseMetadataFake(new Short[]{1});
        VastbaseAgent agent = agentWithConnection(metadata.connection());

        List<ColumnInfo> columns = agent.getColumns("avatar_asset", "app_config_info");

        Assertions.assertTrue(column(columns, "id").getIs_primary_key());
        Assertions.assertFalse(column(columns, "tenant_id").getIs_primary_key());
        metadata.assertUsesPostgres92CompatibleSql();
    }

    @Test
    void rejectsEntirePrimaryKeyWhenAnyAttributeNumberIsUnknown() throws Exception {
        VastbaseMetadataFake metadata = new VastbaseMetadataFake(new Short[]{1, 99});
        VastbaseAgent agent = agentWithConnection(metadata.connection());

        List<ColumnInfo> columns = agent.getColumns("avatar_asset", "app_config_info");

        Assertions.assertFalse(column(columns, "id").getIs_primary_key());
        Assertions.assertFalse(column(columns, "tenant_id").getIs_primary_key());
        Assertions.assertFalse(column(columns, "payload").getIs_primary_key());
        metadata.assertUsesPostgres92CompatibleSql();
    }

    @Test
    void mapsCompositeKeysIndexesAndForeignKeysInCatalogOrder() throws Exception {
        VastbaseMetadataFake metadata = new VastbaseMetadataFake(new Short[]{2, 1});
        VastbaseAgent agent = agentWithConnection(metadata.connection());

        List<ColumnInfo> columns = agent.getColumns("avatar_asset", "app_config_info");
        List<IndexInfo> indexes = agent.listIndexes("avatar_asset", "app_config_info");
        List<ForeignKeyInfo> foreignKeys = agent.listForeignKeys("avatar_asset", "app_config_info");
        metadata.assertSqlArraysFreed();
        metadata.clearRecordedOperations();
        String ddl = agent.getTableDdl("avatar_asset", "app_config_info");

        Assertions.assertTrue(column(columns, "id").getIs_primary_key());
        Assertions.assertTrue(column(columns, "tenant_id").getIs_primary_key());
        Assertions.assertFalse(column(columns, "payload").getIs_primary_key());
        Assertions.assertEquals(Arrays.asList(
            new IndexInfo("idx_payload", Arrays.asList("payload"), false, false, null, "btree", null, null),
            new IndexInfo("idx_tenant_id", Arrays.asList("tenant_id", "id"), true, false, null, "btree", null, null),
            new IndexInfo("idx_primitive", Arrays.asList("id", "payload"), false, false, null, "btree", null, null),
            new IndexInfo("idx_object_array_null", Arrays.asList("tenant_id", "payload"), false, false, null, "btree", null, null),
            new IndexInfo("idx_object_array_unsupported", Arrays.asList("id", "tenant_id"), false, false, null, "btree", null, null),
            new IndexInfo("app_config_info_pkey", Arrays.asList("tenant_id", "id"), true, true, null, "btree", null, null)
        ), indexes);
        Assertions.assertEquals(Arrays.asList(
            new ForeignKeyInfo("fk_account_region", "tenant_id", "accounts", "account_id"),
            new ForeignKeyInfo("fk_account_region", "id", "accounts", "region_id"),
            new ForeignKeyInfo("fk_owner", "id", "users", "user_id")
        ), foreignKeys);
        Assertions.assertTrue(ddl.contains("PRIMARY KEY (\"tenant_id\", \"id\")"), ddl);
        Assertions.assertTrue(
            ddl.contains("CONSTRAINT \"fk_account_region\" FOREIGN KEY (\"tenant_id\", \"id\") REFERENCES \"accounts\"(\"account_id\", \"region_id\")"),
            ddl
        );
        Assertions.assertEquals(1, occurrences(ddl, "CONSTRAINT \"fk_account_region\""), ddl);
        Assertions.assertFalse(ddl.contains("fk_length_mismatch"), ddl);
        Assertions.assertFalse(ddl.contains("fk_unknown_ref"), ddl);
        Assertions.assertTrue(
            ddl.contains("CREATE UNIQUE INDEX \"idx_tenant_id\" ON \"avatar_asset\".\"app_config_info\" USING btree (\"tenant_id\", \"id\")"),
            ddl
        );
        Assertions.assertEquals(8, metadata.queryCount(), metadata.sql());
        Assertions.assertEquals(1, metadata.tableAttributeQueryCount(), metadata.sql());
        Assertions.assertEquals(1, metadata.referencedAttributeQueryCount(), metadata.sql());
        Assertions.assertTrue(metadata.sql().contains("WHERE a.attrelid IN (?, ?)"), metadata.sql());
        metadata.assertSqlArraysFreed();
        metadata.assertUsesPostgres92CompatibleSql();
        Assertions.assertTrue(metadata.sql().contains("co.conkey AS column_numbers"), metadata.sql());
        Assertions.assertTrue(metadata.sql().contains("co.confkey AS ref_column_numbers"), metadata.sql());
        Assertions.assertTrue(metadata.sql().contains("ix.indkey AS column_numbers"), metadata.sql());
    }

    private static int occurrences(String value, String fragment) {
        int result = 0;
        int offset = 0;
        while (true) {
            int found = value.indexOf(fragment, offset);
            if (found < 0) {
                return result;
            }
            result += 1;
            offset = found + fragment.length();
        }
    }

    private static VastbaseAgent agentWithConnection(Connection connection) throws Exception {
        VastbaseAgent agent = new VastbaseAgent();
        Field connectionField = AbstractJdbcAgent.class.getDeclaredField("connection");
        connectionField.setAccessible(true);
        connectionField.set(agent, connection);
        return agent;
    }

    private static ColumnInfo column(List<ColumnInfo> columns, String name) {
        for (ColumnInfo column : columns) {
            if (name.equals(column.getName())) {
                return column;
            }
        }
        throw new AssertionError("Missing column: " + name);
    }

    private static final class VastbaseMetadataFake {
        private final Object primaryKeyNumbers;
        private final List<String> statements = new ArrayList<>();
        private final List<TrackingSqlArray> sqlArrays = new ArrayList<>();

        private VastbaseMetadataFake(Object primaryKeyNumbers) {
            this.primaryKeyNumbers = primaryKeyNumbers;
        }

        private Connection connection() {
            return proxy(Connection.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    String methodName = method.getName();
                    if ("prepareStatement".equals(methodName)) {
                        String sql = (String) args[0];
                        statements.add(sql);
                        return preparedStatement(sql);
                    }
                    if ("isClosed".equals(methodName)) {
                        return false;
                    }
                    if ("close".equals(methodName)) {
                        return null;
                    }
                    return defaultValue(method.getReturnType());
                }
            });
        }

        private PreparedStatement preparedStatement(String sql) {
            return proxy(PreparedStatement.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    String methodName = method.getName();
                    if ("executeQuery".equals(methodName)) {
                        return resultFor(sql);
                    }
                    if ("setLong".equals(methodName)) {
                        return null;
                    }
                    if ("setString".equals(methodName) || "close".equals(methodName)) {
                        return null;
                    }
                    return defaultValue(method.getReturnType());
                }
            });
        }

        private ResultSet resultFor(String sql) {
            if (sql.contains("co.contype = 'p'")) {
                if (primaryKeyNumbers == null) {
                    return resultSet(new String[]{"column_numbers"}, new Object[0][]);
                }
                return resultSet(
                    new String[]{"column_numbers"},
                    new Object[][]{{primaryKeyNumbers}}
                );
            }
            if (sql.contains("ix.indkey AS column_numbers")) {
                return resultSet(
                    new String[]{"index_name", "index_type", "is_unique", "is_primary", "column_numbers"},
                    new Object[][]{
                        {"idx_payload", "btree", false, false, sqlArray(new int[]{3})},
                        {"idx_tenant_id", "btree", true, false, "2 1"},
                        {"idx_primitive", "btree", false, false, new short[]{1, 3}},
                        {"idx_object_array_null", "btree", false, false, objectSqlArray(new int[]{2, 3}, false)},
                        {"idx_object_array_unsupported", "btree", false, false, objectSqlArray(new int[]{1, 2}, true)},
                        {"app_config_info_pkey", "btree", true, true, new Short[]{2, 1}},
                        {"idx_expression", "btree", false, false, new short[]{0, 3}},
                        {"idx_unknown", "btree", false, false, "{2,99}"}
                    }
                );
            }
            if (sql.contains("co.confkey AS ref_column_numbers")) {
                return resultSet(
                    new String[]{
                        "constraint_name",
                        "column_numbers",
                        "ref_column_numbers",
                        "ref_table",
                        "ref_table_oid"
                    },
                    new Object[][]{
                        {"fk_account_region", "{2,1}", "{1,3}", "accounts", 42L},
                        {"fk_length_mismatch", "{1,2}", "{1}", "accounts", 42L},
                        {"fk_owner", new Short[]{1}, new Short[]{1}, "users", 43L},
                        {"fk_unknown_ref", "{1}", "{99}", "users", 43L}
                    }
                );
            }
            if (sql.contains("WHERE a.attrelid IN (")) {
                return resultSet(
                    new String[]{"relation_oid", "attribute_number", "column_name"},
                    new Object[][]{
                        {42L, 1, "account_id"},
                        {42L, 3, "region_id"},
                        {43L, 1, "user_id"}
                    }
                );
            }
            if (sql.contains("a.attnum AS attribute_number")) {
                return attributeResult(new Object[][]{
                    {1, "id"},
                    {2, "tenant_id"},
                    {3, "payload"}
                });
            }
            if (sql.contains("AS constraint_definition")) {
                return resultSet(
                    new String[]{"constraint_name", "constraint_definition"},
                    new Object[0][]
                );
            }
            if (sql.contains("AS table_comment")) {
                return resultSet(new String[]{"table_comment"}, new Object[][]{{null}});
            }
            if (sql.contains("AS data_type")) {
                return resultSet(
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
                        {"id", "bigint", false, null, null, null, null, null},
                        {"tenant_id", "bigint", false, null, null, null, null, null},
                        {"payload", "text", true, null, null, null, null, null}
                    }
                );
            }
            throw new AssertionError("Unexpected SQL: " + sql);
        }

        private ResultSet attributeResult(Object[][] rows) {
            return resultSet(new String[]{"attribute_number", "column_name"}, rows);
        }

        private String sql() {
            return String.join("\n", statements);
        }

        private java.sql.Array sqlArray(Object values) {
            TrackingSqlArray sqlArray = new TrackingSqlArray(values);
            sqlArrays.add(sqlArray);
            return sqlArray.value();
        }

        private Object objectSqlArray(Object values, boolean unsupported) {
            TrackingSqlArray sqlArray = new TrackingSqlArray(values);
            sqlArrays.add(sqlArray);
            return new ObjectSqlArray(sqlArray.value(), unsupported);
        }

        private void clearRecordedOperations() {
            statements.clear();
            sqlArrays.clear();
        }

        private int queryCount() {
            return statements.size();
        }

        private int tableAttributeQueryCount() {
            int result = 0;
            for (String statement : statements) {
                if (statement.contains("a.attnum AS attribute_number")
                    && statement.contains("JOIN pg_catalog.pg_class c")) {
                    result += 1;
                }
            }
            return result;
        }

        private int referencedAttributeQueryCount() {
            int result = 0;
            for (String statement : statements) {
                if (statement.contains("a.attrelid AS relation_oid")) {
                    result += 1;
                }
            }
            return result;
        }

        private void assertSqlArraysFreed() {
            Assertions.assertFalse(sqlArrays.isEmpty());
            for (TrackingSqlArray sqlArray : sqlArrays) {
                Assertions.assertTrue(sqlArray.freed);
            }
        }

        private void assertUsesPostgres92CompatibleSql() {
            Assertions.assertFalse(sql().contains("LATERAL"), sql());
            Assertions.assertFalse(sql().contains("WITH ORDINALITY"), sql());
        }
    }

    private static ResultSet resultSet(String[] columns, Object[][] rows) {
        int[] rowIndex = {-1};
        boolean[] wasNull = {false};
        return proxy(ResultSet.class, new MethodHandler() {
            @Override
            public Object handle(Method method, Object[] args) {
                String methodName = method.getName();
                if ("next".equals(methodName)) {
                    rowIndex[0] += 1;
                    return rowIndex[0] < rows.length;
                }
                if ("getString".equals(methodName)) {
                    Object value = columnValue(columns, rows[rowIndex[0]], args[0]);
                    wasNull[0] = value == null;
                    return value == null ? null : String.valueOf(value);
                }
                if ("getBoolean".equals(methodName)) {
                    Object value = columnValue(columns, rows[rowIndex[0]], args[0]);
                    wasNull[0] = value == null;
                    return value instanceof Boolean && (Boolean) value;
                }
                if ("getInt".equals(methodName)) {
                    Object value = columnValue(columns, rows[rowIndex[0]], args[0]);
                    wasNull[0] = value == null;
                    return value == null ? 0 : ((Number) value).intValue();
                }
                if ("getLong".equals(methodName)) {
                    Object value = columnValue(columns, rows[rowIndex[0]], args[0]);
                    wasNull[0] = value == null;
                    return value == null ? 0L : ((Number) value).longValue();
                }
                if ("getObject".equals(methodName)) {
                    Object value = columnValue(columns, rows[rowIndex[0]], args[0]);
                    if (value instanceof ObjectSqlArray) {
                        value = ((ObjectSqlArray) value).value;
                    }
                    wasNull[0] = value == null;
                    return value;
                }
                if ("getArray".equals(methodName)) {
                    Object value = columnValue(columns, rows[rowIndex[0]], args[0]);
                    if (value instanceof ObjectSqlArray) {
                        ObjectSqlArray objectSqlArray = (ObjectSqlArray) value;
                        if (objectSqlArray.unsupported) {
                            throw new UnsupportedOperationException();
                        }
                        return null;
                    }
                    wasNull[0] = value == null;
                    return value instanceof java.sql.Array ? value : null;
                }
                if ("wasNull".equals(methodName)) {
                    return wasNull[0];
                }
                if ("close".equals(methodName)) {
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
        for (int columnIndex = 0; columnIndex < columns.length; columnIndex++) {
            if (columns[columnIndex].equalsIgnoreCase(String.valueOf(key))) {
                return row[columnIndex];
            }
        }
        return null;
    }

    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) {
                return handler.handle(method, args);
            }
        };
        return type.cast(Proxy.newProxyInstance(
            type.getClassLoader(),
            new Class<?>[]{type},
            invocationHandler
        ));
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
            return 0.0f;
        }
        if (Double.TYPE.equals(type)) {
            return 0.0;
        }
        return null;
    }

    private static final class TrackingSqlArray {
        private final Object values;
        private boolean freed;

        private TrackingSqlArray(Object values) {
            this.values = values;
        }

        private java.sql.Array value() {
            return proxy(java.sql.Array.class, new MethodHandler() {
                @Override
                public Object handle(Method method, Object[] args) {
                    String methodName = method.getName();
                    if ("getArray".equals(methodName) && (args == null || args.length == 0)) {
                        return values;
                    }
                    if ("free".equals(methodName)) {
                        freed = true;
                        return null;
                    }
                    if ("getBaseType".equals(methodName)) {
                        return java.sql.Types.SMALLINT;
                    }
                    if ("getBaseTypeName".equals(methodName)) {
                        return "int2";
                    }
                    return defaultValue(method.getReturnType());
                }
            });
        }
    }

    private static final class ObjectSqlArray {
        private final java.sql.Array value;
        private final boolean unsupported;

        private ObjectSqlArray(java.sql.Array value, boolean unsupported) {
            this.value = value;
            this.unsupported = unsupported;
        }
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args);
    }
}
