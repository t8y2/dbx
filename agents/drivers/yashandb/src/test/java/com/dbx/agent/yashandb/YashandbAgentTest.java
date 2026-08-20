package com.dbx.agent.yashandb;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.TestSupport;
import com.yashandb.udt.YasStruct;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Struct;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import javax.sql.rowset.serial.SerialBlob;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class YashandbAgentTest extends JdbcFakeExecutionBehaviorTest {
    private static final String UDT_STRING_ERROR =
        "Cannot convert an instance of COM.YASHANDB.PROTOCOL.ACCESSOR.UDTOBJECTACCESSOR to type STRING";

    @Override
    protected DatabaseAgent createAgent() {
        return new YashandbAgent();
    }

    @Override
    protected String resultSetSql() {
        return "SELECT 1 FROM DUAL";
    }

    @Test
    void declaresYashandbJdbcProfile() {
        JdbcAgentProfile profile = YashandbAgent.YASHANDB_PROFILE;

        Assertions.assertEquals("com.yashandb.jdbc.Driver", profile.getDriverClass());
        Assertions.assertEquals("jdbc:yasdb://{host}:{port}/{database}", profile.getUrlTemplate());
        Assertions.assertTrue(profile.getSkipExecutionContext());
        Assertions.assertEquals(Collections.emptySet(), profile.getExcludedSchemas());
    }

    @Test
    void readsFunctionSourceFromAllSourceInLineOrder() {
        YashandbAgent agent = new YashandbAgent();
        List<String> sql = new ArrayList<>();
        List<String> parameters = new ArrayList<>();
        TestSupport.setPrivateConnection(
            agent,
            objectSourceConnection(
                sql,
                parameters,
                "FUNCTION REFRESH_ORDERS RETURN NUMBER IS\n",
                "BEGIN\n",
                "  RETURN 1;\n",
                "END;\n"
            )
        );

        ObjectSource source = agent.getObjectSource("APP", "REFRESH_ORDERS", "function");

        Assertions.assertEquals(List.of(YashandbAgent.OBJECT_SOURCE_SQL), sql);
        Assertions.assertEquals(List.of("1=APP", "2=REFRESH_ORDERS", "3=FUNCTION"), parameters);
        Assertions.assertEquals("APP", source.getSchema());
        Assertions.assertEquals("REFRESH_ORDERS", source.getName());
        Assertions.assertEquals("FUNCTION", source.getObject_type());
        Assertions.assertEquals(
            "FUNCTION REFRESH_ORDERS RETURN NUMBER IS\nBEGIN\n  RETURN 1;\nEND;\n",
            source.getSource()
        );
        Assertions.assertFalse(source.isEditable());
    }

    @Test
    void readsProcedureSourceAndPreservesBoundIdentifierText() {
        YashandbAgent agent = new YashandbAgent();
        List<String> sql = new ArrayList<>();
        List<String> parameters = new ArrayList<>();
        TestSupport.setPrivateConnection(agent, objectSourceConnection(sql, parameters, "PROCEDURE SYNC_DATA IS\n", "BEGIN NULL; END;\n"));

        ObjectSource source = agent.getObjectSource("App\"Team", "Sync'Data", " PROCEDURE ");

        Assertions.assertEquals(List.of("1=App\"Team", "2=Sync'Data", "3=PROCEDURE"), parameters);
        Assertions.assertEquals("PROCEDURE SYNC_DATA IS\nBEGIN NULL; END;\n", source.getSource());
    }

    @Test
    void rejectsUnsupportedObjectSourceTypesBeforeQuerying() {
        YashandbAgent agent = new YashandbAgent();

        IllegalArgumentException error = Assertions.assertThrows(
            IllegalArgumentException.class,
            () -> agent.getObjectSource("APP", "ACTIVE_USERS", "VIEW")
        );

        Assertions.assertEquals("Unsupported object type: VIEW", error.getMessage());
    }

    @Test
    void readsStructuredGeometryWithoutChangingScalarAccessors() {
        List<String> calls = new ArrayList<>();
        ResultSet resultSet = queryRows(
            new String[]{"SHAPE", "NAME", "COUNT", "ACTIVE"},
            new int[]{Types.STRUCT, Types.VARCHAR, Types.INTEGER, Types.BOOLEAN},
            new String[]{"MDSYS.ST_GEOMETRY", "VARCHAR", "INTEGER", "BOOLEAN"},
            new Object[][]{
                {structValue("MDSYS.ST_GEOMETRY", new byte[]{1, 2, 3, 4}, null), "origin", 7, true},
                {null, "empty", 0, false}
            },
            null,
            calls
        );
        YashandbAgent agent = agentWithResultSet(resultSet);

        QueryResult result = agent.executeQuery("SELECT SHAPE, NAME, COUNT, ACTIVE FROM REST_ORIGIN", null, new ExecuteQueryOptions());

        Assertions.assertEquals(
            Arrays.asList(
                Arrays.asList("MDSYS.ST_GEOMETRY(0x01020304, null)", "origin", 7, true),
                Arrays.asList(null, "empty", 0, false)
            ),
            result.getRows()
        );
        Assertions.assertEquals(
            Arrays.asList("MDSYS.ST_GEOMETRY", "VARCHAR", "INTEGER", "BOOLEAN"),
            result.getColumn_types()
        );
        Assertions.assertTrue(calls.contains("getObject:1"));
        Assertions.assertFalse(calls.contains("getString:1"));
        Assertions.assertTrue(calls.contains("getString:2"));
        Assertions.assertTrue(calls.contains("getInt:3"));
        Assertions.assertTrue(calls.contains("getBoolean:4"));
    }

    @Test
    void pagedQueryReadsGeometryReportedAsVendorOtherType() {
        YashandbAgent agent = agentWithResultSet(singleStructuredRow(Types.OTHER, "ST_GEOMETRY", null));

        QueryPageResult result = agent.executeQueryPage(
            "SELECT SHAPE FROM REST_ORIGIN",
            null,
            new QueryPageOptions(10, null, 10)
        );

        Assertions.assertEquals(List.of(List.of("ST_GEOMETRY(0x01020304, null)")), result.getRows());
    }

    @Test
    void tableReadUsesObjectAccessForNonGeometryStructs() {
        YashandbAgent agent = agentWithResultSet(singleStructuredRow(Types.STRUCT, "APP.CUSTOM_UDT", null));

        QueryPageResult result = agent.startTableRead(
            "SELECT CUSTOM_VALUE FROM CUSTOM_TYPES",
            null,
            new QueryPageOptions(10, null, 10)
        );

        Assertions.assertEquals(List.of(List.of("APP.CUSTOM_UDT(0x01020304, null)")), result.getRows());
    }

    @Test
    void normalizesLobsAndNestedStructAttributesWithoutUsingObjectIdentity() throws SQLException {
        TestStruct nested = new TestStruct("APP.POINT", 3, 4);
        TestStruct value = new TestStruct(
            "APP.SHAPE",
            "line",
            new byte[]{10, 11},
            new SerialBlob(new byte[]{12, 13}),
            nested
        );
        YashandbAgent agent = agentWithResultSet(structuredRow(value));

        QueryResult result = agent.executeQuery("SELECT SHAPE FROM REST_ORIGIN", null, new ExecuteQueryOptions());

        Assertions.assertEquals(
            List.of(List.of("APP.SHAPE(line, 0x0a0b, 0x0c0d, APP.POINT(3, 4))")),
            result.getRows()
        );
        Assertions.assertFalse(result.getRows().get(0).get(0).toString().contains("@"));
    }

    @Test
    void expandsPublishedDriverYasStructInsteadOfItsObjectIdentityString() throws SQLException {
        YasStruct value = new YasStruct("MDSYS.ST_GEOMETRY");
        value.setAttributes(new Object[]{new byte[]{1, 2, 3, 4}, null});
        Assertions.assertTrue(value.toString().contains("@"));
        YashandbAgent agent = agentWithResultSet(structuredRow(value));

        QueryResult result = agent.executeQuery("SELECT SHAPE FROM REST_ORIGIN", null, new ExecuteQueryOptions());

        Assertions.assertEquals(
            List.of(List.of("MDSYS.ST_GEOMETRY(0x01020304, null)")),
            result.getRows()
        );
    }

    @Test
    void boundsCyclicAndDeeplyNestedStructAttributes() {
        TestStruct cyclic = new TestStruct("APP.NODE");
        cyclic.setAttributes("root", cyclic);
        YashandbAgent cyclicAgent = agentWithResultSet(structuredRow(cyclic));

        QueryResult cyclicResult = cyclicAgent.executeQuery(
            "SELECT NODE_VALUE FROM GRAPH_NODE",
            null,
            new ExecuteQueryOptions()
        );

        Assertions.assertEquals(
            List.of(List.of("APP.NODE(root, APP.NODE(<cycle>))")),
            cyclicResult.getRows()
        );

        Struct nested = new TestStruct("APP.NODE", "leaf");
        for (int i = 0; i < 9; i++) {
            nested = new TestStruct("APP.NODE", nested);
        }
        YashandbAgent deepAgent = agentWithResultSet(structuredRow(nested));

        QueryResult deepResult = deepAgent.executeQuery(
            "SELECT NODE_VALUE FROM GRAPH_NODE",
            null,
            new ExecuteQueryOptions()
        );

        Assertions.assertTrue(deepResult.getRows().get(0).get(0).toString().contains("APP.NODE(<max-depth>)"));
    }

    @Test
    void structuredObjectReadFailuresRemainVisible() {
        YashandbAgent agent = agentWithResultSet(
            singleStructuredRow(Types.STRUCT, "ST_GEOMETRY", new SQLException("structured getObject failed"))
        );

        RuntimeException error = Assertions.assertThrows(
            RuntimeException.class,
            () -> agent.executeQuery("SELECT SHAPE FROM REST_ORIGIN", null, new ExecuteQueryOptions())
        );

        Assertions.assertEquals("structured getObject failed", error.getCause().getMessage());
    }

    @Test
    void structuredAttributeReadFailuresRemainVisible() {
        TestStruct value = new TestStruct("ST_GEOMETRY", new byte[]{1, 2, 3, 4});
        value.setAttributeError(new SQLException("structured attributes failed"));
        YashandbAgent agent = agentWithResultSet(structuredRow(value));

        RuntimeException error = Assertions.assertThrows(
            RuntimeException.class,
            () -> agent.executeQuery("SELECT SHAPE FROM REST_ORIGIN", null, new ExecuteQueryOptions())
        );

        Assertions.assertEquals("structured attributes failed", error.getCause().getMessage());
    }

    private static Connection objectSourceConnection(List<String> sql, List<String> parameters, String... lines) {
        ResultSet resultSet = sourceRows(lines);
        PreparedStatement statement = proxy(PreparedStatement.class, (method, args) -> {
            if ("setString".equals(method.getName())) {
                parameters.add(args[0] + "=" + args[1]);
                return null;
            }
            if ("executeQuery".equals(method.getName())) {
                return resultSet;
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
        return proxy(Connection.class, (method, args) -> {
            if ("prepareStatement".equals(method.getName())) {
                sql.add(String.valueOf(args[0]));
                return statement;
            }
            if ("isClosed".equals(method.getName())) {
                return false;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet sourceRows(String[] lines) {
        int[] index = {-1};
        return proxy(ResultSet.class, (method, args) -> {
            if ("next".equals(method.getName())) {
                index[0] += 1;
                return index[0] < lines.length;
            }
            if ("getString".equals(method.getName())) {
                return lines[index[0]];
            }
            if ("close".equals(method.getName())) {
                return null;
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static YashandbAgent agentWithResultSet(ResultSet resultSet) {
        YashandbAgent agent = new YashandbAgent();
        TestSupport.setPrivateConnection(agent, queryConnection(resultSet));
        return agent;
    }

    private static ResultSet singleStructuredRow(int sqlType, String typeName, SQLException objectError) {
        return queryRows(
            new String[]{"SHAPE"},
            new int[]{sqlType},
            new String[]{typeName},
            new Object[][]{{structValue(typeName, new byte[]{1, 2, 3, 4}, null)}},
            objectError,
            new ArrayList<>()
        );
    }

    private static ResultSet structuredRow(Struct value) {
        return queryRows(
            new String[]{"VALUE"},
            new int[]{Types.STRUCT},
            new String[]{"STRUCT"},
            new Object[][]{{value}},
            null,
            new ArrayList<>()
        );
    }

    private static Connection queryConnection(ResultSet resultSet) {
        Statement statement = proxy(Statement.class, (method, args) -> {
            switch (method.getName()) {
                case "execute":
                    return true;
                case "getResultSet":
                    return resultSet;
                case "getUpdateCount":
                    return 0;
                case "setMaxRows":
                case "setFetchSize":
                case "setQueryTimeout":
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
        return proxy(Connection.class, (method, args) -> {
            switch (method.getName()) {
                case "createStatement":
                    return statement;
                case "getAutoCommit":
                    return true;
                case "isClosed":
                    return false;
                case "setAutoCommit":
                case "commit":
                case "rollback":
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static ResultSet queryRows(
        String[] labels,
        int[] sqlTypes,
        String[] typeNames,
        Object[][] rows,
        SQLException objectError,
        List<String> calls
    ) {
        ResultSetMetaData metadata = proxy(ResultSetMetaData.class, (method, args) -> {
            int columnIndex = args.length == 0 ? 0 : (Integer) args[0] - 1;
            switch (method.getName()) {
                case "getColumnCount":
                    return labels.length;
                case "getColumnLabel":
                    return labels[columnIndex];
                case "getColumnType":
                    return sqlTypes[columnIndex];
                case "getColumnTypeName":
                    return typeNames[columnIndex];
                default:
                    return defaultValue(method.getReturnType());
            }
        });
        int[] rowIndex = {-1};
        Object[] lastValue = {null};
        return proxy(ResultSet.class, (method, args) -> {
            switch (method.getName()) {
                case "next":
                    rowIndex[0] += 1;
                    return rowIndex[0] < rows.length;
                case "getMetaData":
                    return metadata;
                case "getObject":
                    calls.add("getObject:" + args[0]);
                    if (objectError != null) {
                        throw objectError;
                    }
                    lastValue[0] = currentValue(rows, rowIndex[0], args);
                    return lastValue[0];
                case "getString":
                    calls.add("getString:" + args[0]);
                    lastValue[0] = currentValue(rows, rowIndex[0], args);
                    if (lastValue[0] instanceof Struct) {
                        throw new SQLException(UDT_STRING_ERROR);
                    }
                    return lastValue[0] == null ? null : lastValue[0].toString();
                case "getInt":
                    calls.add("getInt:" + args[0]);
                    lastValue[0] = currentValue(rows, rowIndex[0], args);
                    return lastValue[0] == null ? 0 : ((Number) lastValue[0]).intValue();
                case "getBoolean":
                    calls.add("getBoolean:" + args[0]);
                    lastValue[0] = currentValue(rows, rowIndex[0], args);
                    return lastValue[0] != null && (Boolean) lastValue[0];
                case "wasNull":
                    return lastValue[0] == null;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        });
    }

    private static Object currentValue(Object[][] rows, int rowIndex, Object[] args) {
        return rows[rowIndex][(Integer) args[0] - 1];
    }

    private static Struct structValue(String typeName, Object... attributes) {
        return new TestStruct(typeName, attributes);
    }

    private static final class TestStruct implements Struct {
        private final String typeName;
        private Object[] attributes;
        private SQLException attributeError;

        private TestStruct(String typeName, Object... attributes) {
            this.typeName = typeName;
            this.attributes = attributes;
        }

        private void setAttributes(Object... attributes) {
            this.attributes = attributes;
        }

        private void setAttributeError(SQLException attributeError) {
            this.attributeError = attributeError;
        }

        @Override
        public String getSQLTypeName() {
            return typeName;
        }

        @Override
        public Object[] getAttributes() throws SQLException {
            if (attributeError != null) {
                throw attributeError;
            }
            return attributes;
        }

        @Override
        public Object[] getAttributes(Map<String, Class<?>> map) throws SQLException {
            return getAttributes();
        }
    }

    private static <T> T proxy(Class<T> type, MethodHandler handler) {
        InvocationHandler invocationHandler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                return handler.handle(method, args == null ? new Object[0] : args);
            }
        };
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, invocationHandler));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == Boolean.TYPE) return false;
        if (type == Byte.TYPE) return (byte) 0;
        if (type == Short.TYPE) return (short) 0;
        if (type == Integer.TYPE) return 0;
        if (type == Long.TYPE) return 0L;
        if (type == Float.TYPE) return 0f;
        if (type == Double.TYPE) return 0d;
        if (type == Character.TYPE) return (char) 0;
        return null;
    }

    private interface MethodHandler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}
