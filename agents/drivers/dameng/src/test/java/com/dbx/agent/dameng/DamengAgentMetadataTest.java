package com.dbx.agent.dameng;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.io.StringReader;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

class DamengAgentMetadataTest {
    @Test
    void usesColumnCommentsMetadataQuery() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.getColumns("APP", "USERS");

        String columnsSql = JdbcMetadataSqlFake.statements.stream()
            .filter(sql -> sql.contains("ALL_TAB_COLUMNS"))
            .findFirst()
            .orElseThrow();
        Assertions.assertTrue(columnsSql.contains("LEFT JOIN ALL_COL_COMMENTS"), columnsSql);
        Assertions.assertTrue(columnsSql.contains("c.CHAR_USED"), columnsSql);
        Assertions.assertTrue(columnsSql.startsWith("SELECT /*+ PARALLEL(1) */"), columnsSql);
    }

    @Test
    void disablesParallelExecutionForIndexMetadataQuery() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listIndexes("APP", "USERS");

        String indexesSql = JdbcMetadataSqlFake.statements.stream()
            .filter(sql -> sql.contains("ALL_INDEXES"))
            .findFirst()
            .orElseThrow();
        Assertions.assertTrue(indexesSql.startsWith("SELECT /*+ PARALLEL(1) */"), indexesSql);
    }

    @Test
    void usesTableCommentsMetadataQuery() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTables("APP");

        String tablesSql = JdbcMetadataSqlFake.statements.stream()
            .filter(sql -> sql.contains("ALL_TAB_COMMENTS"))
            .findFirst()
            .orElseThrow();
        String allTablesSql = String.join("\n", JdbcMetadataSqlFake.statements);
        Assertions.assertTrue(tablesSql.contains("COMMENTS"), tablesSql);
        Assertions.assertTrue(allTablesSql.contains("ALL_OBJECTS"), allTablesSql);
        Assertions.assertTrue(allTablesSql.contains("USER_MVIEWS"), allTablesSql);
        Assertions.assertFalse(allTablesSql.contains("ALL_MVIEWS"), allTablesSql);
        Assertions.assertFalse(tablesSql.contains("ALL_TABLES"), tablesSql);
        Assertions.assertFalse(tablesSql.contains("ALL_VIEWS"), tablesSql);
    }

    @Test
    void mapsTableCommentFromMetadata() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, metadataConnection());

        List<TableInfo> tables = agent.listTables("APP");

        Assertions.assertEquals(1, tables.size());
        Assertions.assertEquals("USERS", tables.get(0).getName());
        Assertions.assertEquals("用户示例表", tables.get(0).getComment());
    }

    @Test
    void mapsTableCommentToObjectMetadata() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, metadataConnection());

        List<ObjectInfo> objects = agent.listObjects("APP");

        Assertions.assertEquals(1, objects.size());
        Assertions.assertEquals("USERS", objects.get(0).getName());
        Assertions.assertEquals("用户示例表", objects.get(0).getComment());
    }

    @Test
    void listSchemasIncludesSchemaObjectsWithoutChildren() {
        DamengAgent agent = new DamengAgent();
        List<String> sqls = new ArrayList<>();
        TestSupport.setPrivateConnection(agent, metadataConnection("id comment", null, false, List.of(), sqls, ""));

        List<String> schemas = agent.listSchemas();

        Assertions.assertEquals(List.of("APP", "EMPTY_SCHEMA"), schemas);
        Assertions.assertTrue(sqls.stream().anyMatch(sql -> sql.contains("SYS.SYSOBJECTS") && sql.contains("TYPE$ = 'SCH'")), String.join("\n", sqls));
        Assertions.assertTrue(sqls.stream().noneMatch(sql -> sql.contains("ALL_USERS")), String.join("\n", sqls));
        Assertions.assertTrue(sqls.stream().noneMatch(sql -> sql.contains("ALL_OBJECTS")), String.join("\n", sqls));
    }

    @Test
    void mapsMaterializedViewsFromMetadata() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, metadataConnection("id comment", null, true));

        List<TableInfo> tables = agent.listTables("APP");
        List<ObjectInfo> objects = agent.listObjects("APP");

        Assertions.assertTrue(tables.stream().anyMatch(table ->
            "USER_SUMMARY_MV".equals(table.getName()) && "MATERIALIZED_VIEW".equals(table.getTable_type())
        ));
        Assertions.assertFalse(tables.stream().anyMatch(table ->
            "USER_SUMMARY_MV".equals(table.getName()) && "VIEW".equals(table.getTable_type())
        ));
        Assertions.assertTrue(objects.stream().anyMatch(object ->
            "USER_SUMMARY_MV".equals(object.getName()) && "MATERIALIZED_VIEW".equals(object.getObject_type())
        ));
    }

    @Test
    void filtersTableListingByRequestedObjectTypes() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, metadataConnection("id comment", null, true));
        setConnectedUsername(agent, "APP");

        List<TableInfo> views = agent.listTables("APP", List.of("VIEW"));
        List<TableInfo> materializedViews = agent.listTables("APP", List.of("MATERIALIZED_VIEW"));

        Assertions.assertTrue(views.stream().noneMatch(table -> "MATERIALIZED_VIEW".equals(table.getTable_type())));
        Assertions.assertTrue(views.stream().noneMatch(table -> "USER_SUMMARY_MV".equals(table.getName())));
        Assertions.assertEquals(List.of("USER_SUMMARY_MV"), materializedViews.stream().map(TableInfo::getName).toList());
    }

    @Test
    void readsMaterializedViewSourceWithDbmsMetadataType() {
        DamengAgent agent = new DamengAgent();
        List<String> params = new ArrayList<>();
        TestSupport.setPrivateConnection(
            agent,
            objectSourceConnection(params, "CREATE MATERIALIZED VIEW \"APP\".\"USER_SUMMARY_MV\" AS SELECT 1 AS ID FROM DUAL")
        );

        ObjectSource source = agent.getObjectSource("APP", "USER_SUMMARY_MV", "MATERIALIZED_VIEW");

        Assertions.assertEquals(List.of("MATERIALIZED_VIEW", "USER_SUMMARY_MV", "APP"), params);
        Assertions.assertEquals("MATERIALIZED_VIEW", source.getObject_type());
        Assertions.assertTrue(source.getSource().contains("CREATE MATERIALIZED VIEW"), source.getSource());
    }

    @Test
    void triggerMetadataDoesNotRequireOracleTriggerTypeColumn() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTriggers("APP", "USERS");

        String triggersSql = JdbcMetadataSqlFake.statements.stream()
            .filter(sql -> sql.contains("ALL_TRIGGERS"))
            .findFirst()
            .orElseThrow();
        Assertions.assertFalse(triggersSql.contains("TRIGGERING_EVENT, TRIGGER_TYPE"), triggersSql);
        Assertions.assertTrue(triggersSql.contains("'' AS TRIGGER_TYPE"), triggersSql);
    }

    @Test
    void mapsColumnCommentFromMetadata() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, metadataConnection());

        List<ColumnInfo> columns = agent.getColumns("APP", "USERS");

        Assertions.assertEquals(1, columns.size());
        Assertions.assertEquals("id comment", columns.get(0).getComment());
    }

    @Test
    void mapsColumnCommentFromFallbackMetadataViews() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, metadataConnection(null, "fallback id comment"));

        List<ColumnInfo> columns = agent.getColumns("APP", "USERS");

        Assertions.assertEquals(1, columns.size());
        Assertions.assertEquals("fallback id comment", columns.get(0).getComment());
    }

    @Test
    void mapsIdentityColumnExtraFromSysColumns() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, metadataConnection());

        List<ColumnInfo> columns = agent.getColumns("APP", "USERS");

        Assertions.assertEquals(1, columns.size());
        Assertions.assertEquals("identity", columns.get(0).getExtra());
    }

    @Test
    void preservesCharacterLengthUnitsFromMetadata() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, metadataConnectionForColumns(List.of(
            Arrays.asList("BYTE_VALUE", "VARCHAR2", "Y", null, null, 256, 64, "B", "byte length"),
            Arrays.asList("CHAR_VALUE", "VARCHAR", "Y", null, null, 256, 64, "C", "character length"),
            Arrays.asList("FIXED_VALUE", "CHAR", "Y", null, null, 40, 10, "C", "fixed length"),
            Arrays.asList("DEFAULT_VALUE", "VARCHAR2", "Y", null, null, 80, 20, null, "default length"),
            Arrays.asList("WORD_VALUE", "VARCHAR2", "Y", null, null, 128, 32, "BYTE", "word byte length"),
            Arrays.asList("NATIONAL_VALUE", "NVARCHAR2", "Y", null, null, 80, 20, "C", "national length"),
            Arrays.asList("NATIONAL_FIXED", "NCHAR", "Y", null, null, 40, 10, "B", "national fixed length")
        )));

        List<ColumnInfo> columns = agent.getColumns("APP", "USERS");

        Assertions.assertEquals("VARCHAR2(256 BYTE)", columns.get(0).getData_type());
        Assertions.assertEquals("VARCHAR(64 CHAR)", columns.get(1).getData_type());
        Assertions.assertEquals("CHAR(10 CHAR)", columns.get(2).getData_type());
        Assertions.assertEquals("VARCHAR2(20)", columns.get(3).getData_type());
        Assertions.assertEquals("VARCHAR2(128 BYTE)", columns.get(4).getData_type());
        Assertions.assertEquals("NVARCHAR2(20)", columns.get(5).getData_type());
        Assertions.assertEquals("NCHAR(10)", columns.get(6).getData_type());
    }

    @Test
    void appendsTableAndColumnCommentsToTableDdl() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, metadataConnection());

        String ddl = agent.getTableDdl("APP", "USERS");

        Assertions.assertTrue(ddl.contains("CREATE TABLE \"APP\".\"USERS\""), ddl);
        Assertions.assertTrue(ddl.contains("COMMENT ON TABLE \"APP\".\"USERS\" IS '用户示例表';"), ddl);
        Assertions.assertTrue(ddl.contains("COMMENT ON COLUMN \"APP\".\"USERS\".\"ID\" IS 'id comment';"), ddl);
    }

    @Test
    void closesDbmsMetadataResultBeforeLoadingSupplementalDdlMetadata() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, metadataConnection());

        Assertions.assertDoesNotThrow(() -> agent.getTableDdl("APP", "USERS"));
    }

    @Test
    void disablesParallelExecutionForTableDdlMetadataQueries() {
        DamengAgent agent = new DamengAgent();
        List<String> sqls = new ArrayList<>();
        TestSupport.setPrivateConnection(agent, metadataConnection(
            "id comment",
            null,
            false,
            List.of(),
            sqls
        ));

        agent.getTableDdl("APP", "USERS");

        List<String> ddlMetadataSql = sqls.stream()
            .filter(sql -> sql.contains("DBMS_METADATA.GET_DDL")
                || sql.contains("ALL_TAB_COLUMNS")
                || sql.contains("ALL_CONS_COLUMNS")
                || sql.contains("SYS.SYSCOLUMNS")
                || sql.contains("ALL_TAB_COMMENTS")
                || sql.contains("ALL_INDEXES"))
            .toList();
        Assertions.assertFalse(ddlMetadataSql.isEmpty());
        Assertions.assertTrue(
            ddlMetadataSql.stream().allMatch(sql -> sql.startsWith("SELECT /*+ PARALLEL(1) */")),
            String.join("\n", ddlMetadataSql)
        );
    }

    @Test
    void readsFullTableDdlFromCharacterStreamWhenGetStringIsTruncated() {
        DamengAgent agent = new DamengAgent();
        String fullDdl = "CREATE TABLE \"APP\".\"USERS\" (\n  \"ID\" NUMBER,\n  \"PAYLOAD\" VARCHAR2(2000)\n);\n-- "
            + "x".repeat(5000)
            + "\n-- DBX_FULL_DDL_END";
        TestSupport.setPrivateConnection(agent, metadataConnection(
            "id comment",
            null,
            false,
            List.of(),
            null,
            fullDdl
        ));

        String ddl = agent.getTableDdl("APP", "USERS");

        Assertions.assertTrue(ddl.contains("DBX_FULL_DDL_END"), ddl);
    }

    @Test
    void appendsIndependentIndexesToTableDdl() {
        DamengAgent agent = new DamengAgent();
        List<String> sqls = new ArrayList<>();
        TestSupport.setPrivateConnection(agent, metadataConnectionWithIndexes(sqls));

        String ddl = agent.getTableDdl("APP", "USERS");

        Assertions.assertTrue(
            ddl.contains("CREATE INDEX \"APP\".\"IDX_USERS_NAME\" ON \"APP\".\"USERS\" (\"NAME\");"),
            ddl
        );
        Assertions.assertTrue(
            ddl.contains("CREATE UNIQUE INDEX \"APP\".\"UX_USERS_EMAIL\" ON \"APP\".\"USERS\" (\"EMAIL\");"),
            ddl
        );
        Assertions.assertFalse(ddl.contains("PK_USERS"), ddl);
        String indexSql = sqls.stream().filter(sql -> sql.contains("ALL_INDEXES")).findFirst().orElseThrow();
        Assertions.assertTrue(indexSql.contains("CONSTRAINT_TYPE IN ('P', 'U')"), indexSql);
        long dbmsMetadataCalls = sqls.stream().filter(sql -> sql.contains("DBMS_METADATA.GET_DDL")).count();
        Assertions.assertEquals(1, dbmsMetadataCalls);
    }

    @Test
    void skipsDamengInternalIndexesWhenAppendingTableDdl() {
        DamengAgent agent = new DamengAgent();
        List<String> sqls = new ArrayList<>();
        TestSupport.setPrivateConnection(agent, metadataConnection(
            "id comment",
            null,
            false,
            List.of(
                indexRow("IDX_USERS_NAME", "NAME", "NONUNIQUE", "NORMAL"),
                indexRow("SYS_INTERNAL_DDL", "ID", "NONUNIQUE", "INNER CLUSTER INDEX")
            ),
            sqls
        ));

        String ddl = agent.getTableDdl("APP", "USERS");

        Assertions.assertTrue(
            ddl.contains("CREATE INDEX \"APP\".\"IDX_USERS_NAME\" ON \"APP\".\"USERS\" (\"NAME\");"),
            ddl
        );
        Assertions.assertFalse(ddl.contains("SYS_INTERNAL_DDL"), ddl);
        Assertions.assertFalse(ddl.contains("INNER CLUSTER INDEX"), ddl);
        long dbmsMetadataCalls = sqls.stream().filter(sql -> sql.contains("DBMS_METADATA.GET_DDL")).count();
        Assertions.assertEquals(1, dbmsMetadataCalls);
    }

    private static Connection metadataConnection() {
        return metadataConnection("id comment", null);
    }

    private static Connection metadataConnection(String allColumnComment, String fallbackColumnComment) {
        return metadataConnection(allColumnComment, fallbackColumnComment, false);
    }

    private static Connection metadataConnection(String allColumnComment, String fallbackColumnComment, boolean includeMaterializedView) {
        return metadataConnection(allColumnComment, fallbackColumnComment, includeMaterializedView, List.of(), null);
    }

    private static Connection metadataConnectionWithIndexes(List<String> sqls) {
        return metadataConnection(
            "id comment",
            null,
            false,
            List.of(
                indexRow("IDX_USERS_NAME", "NAME", "NONUNIQUE", "NORMAL"),
                indexRow("UX_USERS_EMAIL", "EMAIL", "UNIQUE", "NORMAL")
            ),
            sqls
        );
    }

    private static Connection metadataConnection(
        String allColumnComment,
        String fallbackColumnComment,
        boolean includeMaterializedView,
        List<List<Object>> independentIndexes,
        List<String> sqls
    ) {
        return metadataConnection(allColumnComment, fallbackColumnComment, includeMaterializedView, independentIndexes, sqls, "CREATE TABLE \"APP\".\"USERS\" (\n  \"ID\" NUMBER\n);");
    }

    private static Connection metadataConnection(
        String allColumnComment,
        String fallbackColumnComment,
        boolean includeMaterializedView,
        List<List<Object>> independentIndexes,
        List<String> sqls,
        String dbmsMetadataDdl
    ) {
        return metadataConnection(
            allColumnComment,
            fallbackColumnComment,
            includeMaterializedView,
            independentIndexes,
            sqls,
            dbmsMetadataDdl,
            defaultColumnMetadataRows(allColumnComment)
        );
    }

    private static Connection metadataConnectionForColumns(List<List<Object>> columnRows) {
        return metadataConnection(
            "id comment",
            null,
            false,
            List.of(),
            null,
            "CREATE TABLE \"APP\".\"USERS\" (\n  \"ID\" NUMBER\n);",
            columnRows
        );
    }

    private static Connection metadataConnection(
        String allColumnComment,
        String fallbackColumnComment,
        boolean includeMaterializedView,
        List<List<Object>> independentIndexes,
        List<String> sqls,
        String dbmsMetadataDdl,
        List<List<Object>> columnRows
    ) {
        boolean[] dbmsMetadataResultOpen = {false};
        return proxy(Connection.class, (method, args) -> {
            String name = method.getName();
            if ("prepareStatement".equals(name)) {
                String sql = (String) args[0];
                if (dbmsMetadataResultOpen[0]) {
                    throw new AssertionError("Supplemental metadata query started before DBMS_METADATA ResultSet closed: " + sql);
                }
                if (sqls != null) {
                    sqls.add(sql);
                }
                if (sql.contains("DBMS_METADATA.GET_DDL")) {
                    return dbmsMetadataStatement(dbmsMetadataDdl, dbmsMetadataResultOpen);
                }
                if (sql.contains("SYS.SYSOBJECTS") && sql.contains("TYPE$ = 'SCH'")) {
                    return metadataStatement(List.of(List.of("APP"), List.of("EMPTY_SCHEMA")));
                }
                if (sql.contains("ALL_CONS_COLUMNS")) {
                    return metadataStatement(List.of(List.of("ID")));
                }
                if (sql.contains("SYS.SYSCOLUMNS")) {
                    return metadataStatement(List.of(List.of("ID")));
                }
                if (sql.contains("SELECT /*+ PARALLEL(1) */ COMMENTS")) {
                    return metadataStatement(List.of(List.of("用户示例表")));
                }
                if (sql.contains("USER_COL_COMMENTS")) {
                    return metadataStatement(fallbackColumnComment == null ? List.of() : List.of(List.of("ID", fallbackColumnComment)));
                }
                if (sql.contains("SYSCOLUMNCOMMENTS")) {
                    return metadataStatement(List.of());
                }
                if (sql.contains("ALL_OBJECTS") && sql.contains("OBJECT_TYPE = 'TABLE'")) {
                    return metadataStatement(List.of(List.of("USERS", "用户示例表")));
                }
                if (sql.contains("ALL_OBJECTS") && sql.contains("OBJECT_TYPE = 'VIEW'")) {
                    return metadataStatement(
                        includeMaterializedView
                            ? List.of(Arrays.asList("USER_SUMMARY_MV", "mv comment"))
                            : List.of()
                    );
                }
                if (sql.contains("USER_MVIEWS") && sql.contains("ALL_OBJECTS")) {
                    return metadataStatement(
                        includeMaterializedView ? List.of(Arrays.asList("USER_SUMMARY_MV", "mv comment")) : List.of()
                    );
                }
                if (sql.contains("ALL_OBJECTS")) {
                    return metadataStatement(List.of());
                }
                if (sql.contains("ALL_INDEXES")) {
                    return metadataStatement(independentIndexes);
                }
                if (sql.contains("ALL_TAB_COMMENTS")) {
                    List<List<Object>> rows = new ArrayList<>();
                    rows.add(List.of("USERS", "TABLE", "用户示例表"));
                    if (includeMaterializedView) {
                        rows.add(Arrays.asList("USER_SUMMARY_MV", "VIEW", "mv comment"));
                    }
                    return metadataStatement(rows);
                }
                if (sql.contains("USER_MVIEWS")) {
                    return metadataStatement(
                        includeMaterializedView
                            ? List.of(List.of("USER_SUMMARY_MV"))
                            : List.of()
                    );
                }
                if (sql.contains("ALL_COL_COMMENTS") && !sql.contains("ALL_TAB_COLUMNS")) {
                    return metadataStatement(List.of());
                }
                if (sql.contains("ALL_TAB_COLUMNS")) {
                    return metadataStatement(columnRows);
                }
            }
            if ("close".equals(name)) {
                return null;
            }
            if ("isClosed".equals(name)) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static List<List<Object>> defaultColumnMetadataRows(String allColumnComment) {
        return List.of(Arrays.asList(
            "ID",
            "NUMBER",
            "N",
            Integer.valueOf(10),
            Integer.valueOf(0),
            Integer.valueOf(22),
            Integer.valueOf(10),
            null,
            allColumnComment
        ));
    }

    private static List<Object> indexRow(String name, String columns, String uniqueness, String indexType) {
        return List.of(name, columns, uniqueness, indexType);
    }

    private static PreparedStatement dbmsMetadataStatement(String ddl, boolean[] resultOpen) {
        List<String> params = new ArrayList<>();
        return proxy(PreparedStatement.class, (method, args) -> {
            String name = method.getName();
            if ("executeQuery".equals(name)) {
                String objectType = params.isEmpty() ? "" : params.get(0);
                if ("INDEX".equals(objectType)) {
                    throw new AssertionError("Dameng table DDL should generate index DDL from metadata");
                }
                resultOpen[0] = true;
                return metadataResultSet(
                    List.of(List.of(new LongText(ddl, ddl.substring(0, Math.min(ddl.length(), 64))))),
                    () -> resultOpen[0] = false
                );
            }
            if ("setString".equals(name)) {
                int index = ((Integer) args[0]) - 1;
                while (params.size() <= index) {
                    params.add("");
                }
                params.set(index, String.valueOf(args[1]));
                return null;
            }
            if ("close".equals(name)) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static void setConnectedUsername(DamengAgent agent, String username) {
        try {
            Field field = DamengAgent.class.getDeclaredField("connectedUsername");
            field.setAccessible(true);
            field.set(agent, username);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("Unable to set connected username", e);
        }
    }

    private static Connection objectSourceConnection(List<String> params, String source) {
        return proxy(Connection.class, (method, args) -> {
            String name = method.getName();
            if ("prepareStatement".equals(name)) {
                return metadataStatement(List.of(List.of(source)), params);
            }
            if ("close".equals(name)) {
                return null;
            }
            if ("isClosed".equals(name)) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static PreparedStatement metadataStatement(List<List<Object>> rows) {
        return metadataStatement(rows, null);
    }

    private static PreparedStatement metadataStatement(List<List<Object>> rows, List<String> params) {
        return proxy(PreparedStatement.class, (method, args) -> {
            String name = method.getName();
            if ("executeQuery".equals(name)) {
                return metadataResultSet(rows);
            }
            if ("setString".equals(name)) {
                if (params != null) {
                    params.add(String.valueOf(args[1]));
                }
                return null;
            }
            if ("close".equals(name)) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet metadataResultSet(List<List<Object>> rows) {
        return metadataResultSet(rows, () -> {});
    }

    private static ResultSet metadataResultSet(List<List<Object>> rows, Runnable onClose) {
        int[] index = {-1};
        return proxy(ResultSet.class, (method, args) -> {
            String name = method.getName();
            if ("next".equals(name)) {
                index[0] += 1;
                return index[0] < rows.size();
            }
            if ("getString".equals(name)) {
                if (args[0] instanceof Integer columnIndex) {
                    Object value = rows.get(index[0]).get(columnIndex - 1);
                    if (value instanceof LongText longText) {
                        return longText.truncated;
                    }
                    return value == null ? null : value.toString();
                }
                return switch (((String) args[0]).toUpperCase()) {
                    case "COLUMN_NAME" -> string(rows, index[0], 0);
                    case "DATA_TYPE" -> string(rows, index[0], 1);
                    case "NULLABLE" -> string(rows, index[0], 2);
                    case "DATA_DEFAULT" -> null;
                    case "CHAR_USED" -> string(rows, index[0], 7);
                    case "COMMENTS", "COMMENT$" -> string(rows, index[0], rows.get(index[0]).size() - 1);
                    case "COLNAME" -> string(rows, index[0], 0);
                    default -> null;
                };
            }
            if ("getCharacterStream".equals(name) && args[0] instanceof Integer columnIndex) {
                Object value = rows.get(index[0]).get(columnIndex - 1);
                if (value instanceof LongText longText) {
                    return new StringReader(longText.full);
                }
            }
            if ("getObject".equals(name)) {
                return switch (((String) args[0]).toUpperCase()) {
                    case "DATA_PRECISION" -> rows.get(index[0]).get(3);
                    case "DATA_SCALE" -> rows.get(index[0]).get(4);
                    case "DATA_LENGTH" -> rows.get(index[0]).get(5);
                    case "CHAR_LENGTH" -> rows.get(index[0]).get(6);
                    default -> null;
                };
            }
            if ("close".equals(name)) {
                onClose.run();
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static String string(List<List<Object>> rows, int rowIndex, int columnIndex) {
        Object value = rows.get(rowIndex).get(columnIndex);
        if (value instanceof LongText longText) {
            return longText.full;
        }
        return value == null ? null : value.toString();
    }

    private static final class LongText {
        private final String full;
        private final String truncated;

        private LongText(String full, String truncated) {
            this.full = full;
            this.truncated = truncated;
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                return handler.handle(method, args);
            }
        };
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler);
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

    private interface MethodHandler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}
