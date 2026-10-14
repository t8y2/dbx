package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.BlobBoundExecutor;
import com.dbx.agent.BlobBoundStatement;
import com.oceanbase.jdbc.OceanBaseConnection;
import com.oceanbase.jdbc.OceanBaseStatement;
import com.oceanbase.jdbc.internal.protocol.Protocol;
import com.oceanbase.jdbc.util.Options;
import com.zaxxer.hikari.HikariDataSource;
import java.lang.reflect.Proxy;
import java.sql.Blob;
import java.sql.CallableStatement;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.locks.ReentrantLock;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class OceanBaseLobStatementTest {
    @Test void onlyConfirmedObBusinessErrorIsEligibleForSavepointKeep() {
        assertTrue(OceanBaseLobStatements.BINDING.isRollbackConfirmedBusinessError(new java.sql.SQLTransientConnectionException("ORA-20001: stale", "HY000", 20001)));
        assertFalse(OceanBaseLobStatements.BINDING.isRollbackConfirmedBusinessError(new java.sql.SQLTransientConnectionException("connection lost", "08006", 20001)));
        assertFalse(OceanBaseLobStatements.BINDING.isRollbackConfirmedBusinessError(new java.sql.SQLTransientConnectionException("other error", "HY000", 600)));
        assertFalse(OceanBaseLobStatements.BINDING.isRollbackConfirmedBusinessError(new java.sql.SQLRecoverableException("lost", "HY000", 20001)));
        assertFalse(OceanBaseLobStatements.BINDING.isRollbackConfirmedBusinessError(new java.sql.SQLTimeoutException("timeout", "HY000", 20001)));
        assertFalse(OceanBaseLobStatements.BINDING.isRollbackConfirmedBusinessError(new java.sql.SQLTransientConnectionException("stale", "HY000", 20001, new SQLException("lost", "08006"))));
        assertTrue(OceanBaseLobStatements.BINDING.isUnsupportedSavepointRelease(new SQLException("unsupported", "99999", 17023)));
        assertFalse(OceanBaseLobStatements.BINDING.isUnsupportedSavepointRelease(new java.sql.SQLTransientConnectionException("lost", "08006", 17023)));
        assertFalse(OceanBaseLobStatements.BINDING.isUnsupportedSavepointRelease(new java.sql.SQLTimeoutException("timeout", "99999", 17023)));
    }
    @Test
    void boundPreparedAndCallableInitializeNativeModeBeforeStreamBindingThroughPool() throws Exception {
        for (boolean callable : new boolean[]{false, true}) {
            List<String> calls = new ArrayList<>();
            Options options = new Options();
            Protocol protocol = proxy(Protocol.class, (object, method, args) -> {
                if (method.getName().equals("getOptions")) return options;
                if (method.getName().equals("getLock")) return new ReentrantLock();
                return defaultValue(method.getReturnType());
            });
            OceanBaseStatement vendor = new OceanBaseStatement(new OceanBaseConnection(protocol), 1003, 1007, null);
            java.lang.reflect.InvocationHandler handler = (object, method, args) -> {
                switch (method.getName()) {
                    case "unwrap": return ((Class<?>) args[0]).cast(vendor);
                    case "isWrapperFor": return ((Class<?>) args[0]).isInstance(vendor);
                    case "setBlob":
                        assertTrue(vendor.isInternal(), "native mode must precede the first stream binding");
                        assertEquals(3L, args[2]);
                        assertArrayEquals(new byte[]{0, (byte)255, (byte)128}, ((java.io.InputStream) args[1]).readAllBytes());
                        calls.add("bind"); return null;
                    case "execute": assertTrue(JdbcExecutor.current().hasActiveStatements()); calls.add("execute"); return false;
                    case "getUpdateCount": return 1;
                    case "close": calls.add("close"); return null;
                    default: return defaultValue(method.getReturnType());
                }
            };
            PreparedStatement delegate = callable ? proxy(CallableStatement.class, handler) : proxy(PreparedStatement.class, handler);
            Connection physical = proxy(Connection.class, (object, method, args) -> {
                if (method.getName().equals(callable ? "prepareCall" : "prepareStatement")) return delegate;
                if (method.getName().equals("getMetaData")) return proxy(java.sql.DatabaseMetaData.class, (o,m,a) -> m.getName().equals("supportsTransactions") ? true : defaultValue(m.getReturnType()));
                if (method.getName().equals("getAutoCommit") || method.getName().equals("isValid")) return true;
                if (method.getName().equals("getTransactionIsolation")) return Connection.TRANSACTION_READ_COMMITTED;
                return defaultValue(method.getReturnType());
            });
            DataSource source = proxy(DataSource.class, (object, method, args) -> method.getName().equals("getConnection") ? physical : defaultValue(method.getReturnType()));
            String sql = callable ? "BEGIN UPDATE t SET b = ?; END;" : "UPDATE t SET b = ?";
            try (HikariDataSource pool = new HikariDataSource()) {
                pool.setDataSource(source); pool.setMaximumPoolSize(1); pool.setMinimumIdle(0);
                try (Connection connection = pool.getConnection()) {
                    BlobBoundExecutor.execute(connection, List.of("preview"),
                        List.of(new BlobBoundStatement("preview", sql, List.of("00ff80"))),
                        null, ignored -> null, () -> null, 20, false, OceanBaseLobStatements::configure);
                }
            }
            assertEquals(List.of("bind", "execute", "close"), calls);
            assertFalse(JdbcExecutor.current().hasActiveStatements());
        }
    }

    @Test
    void boundNativeInitializationFailureClosesEntirePreparedBatchBeforeAnyWrite() {
        List<String> calls = new ArrayList<>();
        Options options = new Options();
        Protocol protocol = proxy(Protocol.class, (object, method, args) -> {
            if (method.getName().equals("getOptions")) return options;
            if (method.getName().equals("getLock")) return new ReentrantLock();
            return defaultValue(method.getReturnType());
        });
        OceanBaseStatement vendor = new OceanBaseStatement(new OceanBaseConnection(protocol), 1003, 1007, null);
        int[] prepared = {0};
        Connection connection = proxy(Connection.class, (object, method, args) -> {
            if (method.getName().equals("getAutoCommit")) return true;
            if (method.getName().equals("getMetaData")) return proxy(java.sql.DatabaseMetaData.class, (o,m,a) -> m.getName().equals("supportsTransactions") ? true : defaultValue(m.getReturnType()));
            if (method.getName().equals("prepareStatement")) {
                int index = ++prepared[0];
                return proxy(PreparedStatement.class, (o, m, a) -> {
                    if (m.getName().equals("unwrap")) {
                        if (index == 2) throw new SQLException("unsupported native wrapper");
                        return vendor;
                    }
                    if (m.getName().equals("close")) calls.add("close" + index);
                    if (m.getName().equals("execute")) calls.add("write" + index);
                    return defaultValue(m.getReturnType());
                });
            }
            return defaultValue(method.getReturnType());
        });
        RuntimeException error = assertThrows(RuntimeException.class, () -> BlobBoundExecutor.execute(connection,
            List.of("first", "second"), List.of(new BlobBoundStatement("first", "UPDATE t SET b = ?", List.of("00")),
                new BlobBoundStatement("second", "UPDATE t SET b = ?", List.of("01"))),
            null, ignored -> null, () -> null, 20, false, OceanBaseLobStatements::configure));
        assertEquals("Unsupported OceanBase LOB statement", error.getCause().getMessage());
        assertEquals(2, calls.size());
        assertTrue(calls.containsAll(List.of("close1", "close2")));
        assertFalse(JdbcExecutor.current().hasActiveStatements());
    }

    @Test
    void serverLengthMarksExactLastChunkAndPastEndWithoutHidingReadErrors() throws Exception {
        for (boolean binary : new boolean[]{false, true}) {
        for (String scenario : List.of("exact", "past-end", "beyond-end", "full-interior", "read-error")) {
            Options options = new Options();
            Protocol protocol = proxy(Protocol.class, (object, method, args) -> {
                if (method.getName().equals("getOptions")) return options;
                if (method.getName().equals("getLock")) return new ReentrantLock();
                return defaultValue(method.getReturnType());
            });
            OceanBaseStatement vendor = new OceanBaseStatement(new OceanBaseConnection(protocol), 1003, 1007, null);
            // JDBC UTF-16 length deliberately differs from the server's code-point length.
            Object locator = binary ? proxy(Blob.class, (o, m, a) -> m.getName().equals("length") ? 10L : defaultValue(m.getReturnType()))
                : proxy(Clob.class, (o, m, a) -> m.getName().equals("length") ? 10L : defaultValue(m.getReturnType()));
            SQLException failure = new SQLException("ORA-06502: real read failure", "HY000", 6502);
            CallableStatement call = proxy(CallableStatement.class, (object, method, args) -> {
                switch (method.getName()) {
                    case "unwrap": return vendor;
                    case "execute": if (scenario.equals("read-error")) throw failure; return false;
                    case "getInt": return scenario.equals("past-end") || scenario.equals("beyond-end") ? 0 : 3;
                    case "getLong": return scenario.equals("full-interior") ? 9L : 8L;
                    case "getBytes": return scenario.equals("past-end") || scenario.equals("beyond-end") ? null : binary ? new byte[]{0, (byte) 255, 1} : "中😀末".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    default: return defaultValue(method.getReturnType());
                }
            });
            Connection connection = proxy(Connection.class, (object, method, args) -> method.getName().equals("prepareCall") ? call : defaultValue(method.getReturnType()));
            if (scenario.equals("read-error")) {
                assertSame(failure, assertThrows(SQLException.class, () -> OceanBaseLobValues.read(connection, locator, 5, 3)));
            } else {
                var chunk = OceanBaseLobValues.read(connection, locator, scenario.equals("beyond-end") ? 9 : scenario.equals("past-end") ? 8 : 5, 3);
                assertEquals(scenario.equals("past-end") || scenario.equals("beyond-end") ? "" : binary ? "00ff01" : "中😀末", chunk.data());
                assertEquals(scenario.equals("beyond-end") ? 9 : 8, chunk.next_offset());
                assertEquals(!scenario.equals("full-interior"), chunk.eof(), "EOF must use server length, not JDBC UTF-16 length");
            }
            assertFalse(JdbcExecutor.current().hasActiveStatements());
        }
        }
    }

    @Test
    void emptyLocatorReturnsEmptyEofWithoutCallingDbmsLobRead() throws Exception {
        for (boolean binary : new boolean[]{false, true}) {
        java.lang.reflect.InvocationHandler handler = (object, method, args) -> {
            if (method.getName().equals("length")) return 0L;
            throw new AssertionError("Empty LOB must not be materialized");
        };
        Object locator = binary ? proxy(Blob.class, handler) : proxy(Clob.class, handler);
        Connection connection = proxy(Connection.class, (object, method, args) -> {
            if (method.getName().equals("prepareCall")) throw new SQLException("ORA-06502: no data found", "HY000", 6502);
            throw new AssertionError("Empty LOB must not execute a statement");
        });
        var chunk = OceanBaseLobValues.read(connection, locator, 0, 257);
        assertEquals("", chunk.data());
        assertEquals(0, chunk.next_offset());
        assertTrue(chunk.eof());
        assertEquals(binary ? "binary" : "text", chunk.value_kind());
        assertFalse(JdbcExecutor.current().hasActiveStatements());
        }
    }

    @Test
    void pooledCallableUnwrapsVendorOnlyForInternalFlagAndKeepsLifecycleOnProxy() throws Exception {
        for (boolean binary : new boolean[]{false, true}) {
            List<String> calls = new ArrayList<>();
            Options options = new Options();
            Protocol protocol = proxy(Protocol.class, (object, method, args) -> {
                if (method.getName().equals("getOptions")) return options;
                if (method.getName().equals("getLock")) return new ReentrantLock();
                return defaultValue(method.getReturnType());
            });
            OceanBaseStatement vendor = new OceanBaseStatement(new OceanBaseConnection(protocol), 1003, 1007, null);
            Object locator = binary ? proxy(Blob.class, (o, m, a) -> m.getName().equals("length") ? 8L : defaultValue(m.getReturnType()))
                : proxy(Clob.class, (o, m, a) -> m.getName().equals("length") ? 8L : defaultValue(m.getReturnType()));
            CallableStatement delegate = proxy(CallableStatement.class, (object, method, args) -> {
                switch (method.getName()) {
                    case "unwrap": return ((Class<?>) args[0]).cast(vendor);
                    case "isWrapperFor": return ((Class<?>) args[0]).isInstance(vendor);
                    case "setBlob", "setClob": assertSame(locator, args[1]); calls.add(method.getName()); return null;
                    case "setInt": assertEquals(3, args[1]); return null;
                    case "setLong": assertEquals(6L, args[1]); return null;
                    case "setQueryTimeout": assertEquals(20, args[0]); return null;
                    case "registerOutParameter": assertEquals((int) args[0] == 4 ? Types.INTEGER : (int) args[0] == 5 ? (binary ? Types.VARBINARY : Types.VARCHAR) : Types.BIGINT, args[1]); return null;
                    case "execute":
                        assertTrue(vendor.isInternal());
                        assertTrue(JdbcExecutor.current().hasActiveStatements());
                        JdbcExecutor.current().cancelActiveStatements();
                        calls.add("execute"); return false;
                    case "cancel", "close": calls.add(method.getName()); return null;
                    case "getInt": return 2;
                    case "getLong": return 7L;
                    case "getBytes": return binary ? new byte[]{0, (byte) 255} : "中😀".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    default: return defaultValue(method.getReturnType());
                }
            });
            Connection physical = proxy(Connection.class, (object, method, args) -> {
                if (method.getName().equals("prepareCall")) return delegate;
                if (method.getName().equals("getAutoCommit") || method.getName().equals("isValid")) return true;
                if (method.getName().equals("getTransactionIsolation")) return Connection.TRANSACTION_READ_COMMITTED;
                return defaultValue(method.getReturnType());
            });
            DataSource source = proxy(DataSource.class, (object, method, args) -> method.getName().equals("getConnection") ? physical : defaultValue(method.getReturnType()));
            try (HikariDataSource pool = new HikariDataSource()) {
                pool.setDataSource(source);
                pool.setMaximumPoolSize(1);
                pool.setMinimumIdle(0);
                try (Connection connection = pool.getConnection()) {
                    var chunk = OceanBaseLobValues.read(connection, locator, 5, 3);
                    assertEquals(binary ? "00ff" : "中😀", chunk.data());
                    assertEquals(7, chunk.next_offset());
                    assertTrue(chunk.eof());
                    assertEquals(binary ? "binary" : "text", chunk.value_kind());
                }
            }
            assertEquals(List.of(binary ? "setBlob" : "setClob", "cancel", "execute", "close"), calls);
            assertFalse(JdbcExecutor.current().hasActiveStatements());
        }
    }

    @Test
    void nonOceanBaseCallableIsRejectedAndClosedBeforeExecuting() {
        List<String> calls = new ArrayList<>();
        CallableStatement call = proxy(CallableStatement.class, (object, method, args) -> {
            if (method.getName().equals("unwrap")) throw new SQLException("Not a vendor wrapper");
            if (method.getName().equals("close") || method.getName().equals("execute")) calls.add(method.getName());
            return defaultValue(method.getReturnType());
        });
        Connection connection = proxy(Connection.class, (object, method, args) -> method.getName().equals("prepareCall") ? call : defaultValue(method.getReturnType()));
        SQLException error = assertThrows(SQLException.class, () -> OceanBaseLobValues.read(connection, proxy(Clob.class, (o, m, a) -> m.getName().equals("length") ? 1L : null), 0, 1));
        assertEquals("Unsupported OceanBase LOB statement", error.getMessage());
        assertEquals(List.of("close"), calls);
        assertFalse(JdbcExecutor.current().hasActiveStatements());
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }

    private static <T> T proxy(Class<T> type, java.lang.reflect.InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }
}
