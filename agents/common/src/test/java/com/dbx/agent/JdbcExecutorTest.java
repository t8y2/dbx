package com.dbx.agent;

import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLWarning;
import java.sql.Statement;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.rowset.serial.SerialBlob;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class JdbcExecutorTest {
    @Test
    void stringResultValueFormatsBlobWithoutUsingStringConversion() throws Exception {
        ResultSet rs = resultSet(
            new byte[]{0x01, 0x2A, (byte) 0xFF},
            () -> {
                throw new AssertionError("BLOB columns should not be read with getString");
            }
        );

        assertEquals("0x012aff", JdbcExecutor.stringResultValue(rs, 1, Types.BLOB));
    }

    @Test
    void defaultResultValueReadsClobColumnsAsText() throws Exception {
        ResultSet rs = resultSet(null, () -> "hello clob");

        assertEquals("hello clob", JdbcExecutor.INSTANCE.defaultResultValue(rs, 1, Types.CLOB));
    }

    @Test
    void defaultResultValueNormalizesBlobObjectsFromFallbackTypes() throws Exception {
        ResultSet rs = resultSet(new SerialBlob(new byte[]{0x0A, 0x0B}), null, false);

        assertEquals("0x0a0b", JdbcExecutor.INSTANCE.defaultResultValue(rs, 1, Types.OTHER));
    }

    @Test
    void readResultSetCachesColumnTypeMetadataAcrossRows() {
        CountingResultSetFixture fixture = countingResultSet(new Object[][]{
            {1, "Ada"},
            {2, "Grace"}
        });

        QueryResult result = JdbcExecutor.INSTANCE.readResultSet(
            fixture.resultSet(),
            12L,
            10,
            JdbcExecutor.INSTANCE::defaultResultValue
        );

        assertEquals(Arrays.asList("id", "name"), result.getColumns());
        assertEquals(Arrays.asList("INTEGER", "VARCHAR"), result.getColumn_types());
        assertEquals(Arrays.asList(Arrays.asList(1, "Ada"), Arrays.asList(2, "Grace")), result.getRows());
        assertEquals(1, fixture.getMetaDataCalls());
        assertEquals(2, fixture.getColumnTypeCalls());
    }

    @Test
    void executeReturnsMultipleStatementWarningsForNoResultStatements() {
        SQLWarning first = new SQLWarning("identity value is 443", "S0003", 7998);
        first.setNextWarning(new SQLWarning("DBCC execution completed", "S0001", 2528));
        AtomicInteger clearWarningsCalls = new AtomicInteger();

        QueryResult result = JdbcExecutor.INSTANCE.execute(
            executionConnection(false, -1, first, clearWarningsCalls, null, null),
            "DBCC CHECKIDENT ('dbo.tVillage', RESEED)",
            "",
            schema -> ""
        );

        assertEquals(Arrays.asList("Message"), result.getColumns());
        assertEquals(Arrays.asList("nvarchar"), result.getColumn_types());
        assertEquals(
            Arrays.asList(Arrays.asList("identity value is 443"), Arrays.asList("DBCC execution completed")),
            result.getRows()
        );
        assertEquals(1, clearWarningsCalls.get());
    }

    @Test
    void executeKeepsEmptyNoResultStatementsUnchangedWithoutWarnings() {
        QueryResult result = JdbcExecutor.INSTANCE.execute(
            executionConnection(false, 3, null, new AtomicInteger(), null, null),
            "UPDATE people SET active = 1",
            "",
            schema -> ""
        );

        assertEquals(Collections.emptyList(), result.getColumns());
        assertEquals(Collections.emptyList(), result.getRows());
        assertEquals(3L, result.getAffected_rows());
    }

    @Test
    void executeDoesNotReplaceOrdinaryResultSetsWithWarnings() {
        CountingResultSetFixture fixture = countingResultSet(new Object[][]{{1, "Ada"}});
        QueryResult result = JdbcExecutor.INSTANCE.execute(
            executionConnection(true, -1, new SQLWarning("informational"), new AtomicInteger(), fixture.resultSet(), null),
            "SELECT id, name FROM people",
            "",
            schema -> ""
        );

        assertEquals(Arrays.asList("id", "name"), result.getColumns());
        assertEquals(Arrays.asList(Arrays.asList(1, "Ada")), result.getRows());
    }

    @Test
    void executeStillPropagatesStatementErrors() {
        SQLException failure = new SQLException("permission denied", "42000", 229);
        RuntimeException thrown = assertThrows(
            RuntimeException.class,
            () -> JdbcExecutor.INSTANCE.execute(
                executionConnection(false, -1, null, new AtomicInteger(), null, failure),
                "DBCC CHECKIDENT ('dbo.tVillage', RESEED)",
                "",
                schema -> ""
            )
        );

        assertEquals(failure, thrown.getCause());
    }

    @Test
    void schemaSwitcherPrefersDriverSpecificSql() throws Exception {
        List<String> calls = new ArrayList<>();

        JdbcSchemaSwitcher.apply(schemaConnection(calls, false), "APP", schema -> "USE " + schema);

        assertEquals(Arrays.asList("execute:USE APP"), calls);
    }

    @Test
    void schemaSwitcherFallsBackToSetSchemaWhenSqlFails() throws Exception {
        List<String> calls = new ArrayList<>();

        JdbcSchemaSwitcher.apply(schemaConnection(calls, true), "APP", schema -> "USE " + schema);

        assertEquals(Arrays.asList("execute:USE APP", "setSchema:APP"), calls);
    }

    @Test
    void schemaSwitcherRestoresOriginalContextWhenNextQueryHasNoSchema() throws Exception {
        List<String> calls = new ArrayList<>();
        Connection connection = schemaConnection(calls, false);

        JdbcSchemaSwitcher.apply(connection, "APP", schema -> "SET search_path TO " + schema, () -> "RESET search_path");
        JdbcSchemaSwitcher.apply(connection, null, schema -> "SET search_path TO " + schema, () -> "RESET search_path");

        assertEquals(Arrays.asList("execute:SET search_path TO APP", "execute:RESET search_path"), calls);
    }

    private static ResultSet resultSet(byte[] bytes, StringSupplier stringSupplier) {
        return resultSet(bytes, stringSupplier, false);
    }

    private static Connection schemaConnection(List<String> calls, boolean failSchemaSql) {
        InvocationHandler handler = (Object unused, Method method, Object[] args) -> {
            switch (method.getName()) {
                case "createStatement":
                    return schemaStatement(calls, failSchemaSql);
                case "setSchema":
                    calls.add("setSchema:" + args[0]);
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        };
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, handler);
    }

    private static Statement schemaStatement(List<String> calls, boolean failSchemaSql) {
        InvocationHandler handler = (Object unused, Method method, Object[] args) -> {
            switch (method.getName()) {
                case "execute":
                    calls.add("execute:" + args[0]);
                    if (failSchemaSql) {
                        throw new SQLException("unsupported schema SQL");
                    }
                    return false;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        };
        return (Statement) Proxy.newProxyInstance(Statement.class.getClassLoader(), new Class<?>[]{Statement.class}, handler);
    }

    private static CountingResultSetFixture countingResultSet(Object[][] rows) {
        String[] labels = {"id", "name"};
        int[] sqlTypes = {Types.INTEGER, Types.VARCHAR};
        String[] typeNames = {"INTEGER", "VARCHAR"};
        AtomicInteger cursor = new AtomicInteger(-1);
        AtomicInteger getMetaDataCalls = new AtomicInteger();
        AtomicInteger getColumnTypeCalls = new AtomicInteger();

        InvocationHandler metaHandler = (Object unused, Method method, Object[] args) -> {
            switch (method.getName()) {
                case "getColumnCount":
                    return labels.length;
                case "getColumnLabel":
                    return labels[(Integer) args[0] - 1];
                case "getColumnType":
                    getColumnTypeCalls.incrementAndGet();
                    return sqlTypes[(Integer) args[0] - 1];
                case "getColumnTypeName":
                    return typeNames[(Integer) args[0] - 1];
                default:
                    return defaultValue(method.getReturnType());
            }
        };
        ResultSetMetaData metadata = (ResultSetMetaData) Proxy.newProxyInstance(
            ResultSetMetaData.class.getClassLoader(),
            new Class<?>[]{ResultSetMetaData.class},
            metaHandler
        );

        InvocationHandler resultSetHandler = (Object unused, Method method, Object[] args) -> {
            switch (method.getName()) {
                case "getMetaData":
                    getMetaDataCalls.incrementAndGet();
                    return metadata;
                case "next":
                    return cursor.incrementAndGet() < rows.length;
                case "getInt":
                    return ((Number) currentCell(rows, cursor.get(), (Integer) args[0])).intValue();
                case "getString":
                    Object value = currentCell(rows, cursor.get(), (Integer) args[0]);
                    return value == null ? null : value.toString();
                case "wasNull":
                    return false;
                default:
                    return defaultValue(method.getReturnType());
            }
        };
        ResultSet resultSet = (ResultSet) Proxy.newProxyInstance(
            ResultSet.class.getClassLoader(),
            new Class<?>[]{ResultSet.class},
            resultSetHandler
        );
        return new CountingResultSetFixture(resultSet, getMetaDataCalls, getColumnTypeCalls);
    }

    private static Object currentCell(Object[][] rows, int rowIndex, int columnIndex) {
        return rows[rowIndex][columnIndex - 1];
    }

    private static ResultSet resultSet(Object objectValue, StringSupplier stringSupplier, boolean wasNull) {
        InvocationHandler handler = (Object unused, Method method, Object[] args) -> {
            switch (method.getName()) {
                case "getObject":
                    return objectValue;
                case "getBytes":
                    return objectValue instanceof byte[] ? objectValue : null;
                case "getString":
                    return stringSupplier == null ? null : stringSupplier.get();
                case "wasNull":
                    return wasNull;
                default:
                    return defaultValue(method.getReturnType());
            }
        };
        return (ResultSet) Proxy.newProxyInstance(
            ResultSet.class.getClassLoader(),
            new Class<?>[]{ResultSet.class},
            handler
        );
    }

    private static Connection executionConnection(
        boolean hasResultSet,
        int updateCount,
        SQLWarning warning,
        AtomicInteger clearWarningsCalls,
        ResultSet resultSet,
        SQLException executeFailure
    ) {
        InvocationHandler statementHandler = (Object unused, Method method, Object[] args) -> {
            switch (method.getName()) {
                case "execute":
                    if (executeFailure != null) {
                        throw executeFailure;
                    }
                    return hasResultSet;
                case "getResultSet":
                    return resultSet;
                case "getUpdateCount":
                    return updateCount;
                case "getWarnings":
                    return warning;
                case "clearWarnings":
                    clearWarningsCalls.incrementAndGet();
                    return null;
                case "close":
                    return null;
                default:
                    return defaultValue(method.getReturnType());
            }
        };
        Statement statement = (Statement) Proxy.newProxyInstance(
            Statement.class.getClassLoader(),
            new Class<?>[]{Statement.class},
            statementHandler
        );
        InvocationHandler connectionHandler = (Object unused, Method method, Object[] args) -> {
            if (method.getName().equals("createStatement")) {
                return statement;
            }
            return defaultValue(method.getReturnType());
        };
        return (Connection) Proxy.newProxyInstance(
            Connection.class.getClassLoader(),
            new Class<?>[]{Connection.class},
            connectionHandler
        );
    }

    private static Object defaultValue(Class<?> type) {
        if (type == Boolean.TYPE) {
            return false;
        }
        if (type == Byte.TYPE) {
            return (byte) 0;
        }
        if (type == Short.TYPE) {
            return (short) 0;
        }
        if (type == Integer.TYPE) {
            return 0;
        }
        if (type == Long.TYPE) {
            return 0L;
        }
        if (type == Float.TYPE) {
            return 0f;
        }
        if (type == Double.TYPE) {
            return 0.0d;
        }
        if (type == Character.TYPE) {
            return '\0';
        }
        return null;
    }

    private interface StringSupplier {
        String get() throws Exception;
    }

    private static final class CountingResultSetFixture {
        private final ResultSet resultSet;
        private final AtomicInteger getMetaDataCalls;
        private final AtomicInteger getColumnTypeCalls;

        private CountingResultSetFixture(
            ResultSet resultSet,
            AtomicInteger getMetaDataCalls,
            AtomicInteger getColumnTypeCalls
        ) {
            this.resultSet = resultSet;
            this.getMetaDataCalls = getMetaDataCalls;
            this.getColumnTypeCalls = getColumnTypeCalls;
        }

        private ResultSet resultSet() {
            return resultSet;
        }

        private int getMetaDataCalls() {
            return getMetaDataCalls.get();
        }

        private int getColumnTypeCalls() {
            return getColumnTypeCalls.get();
        }
    }
}
