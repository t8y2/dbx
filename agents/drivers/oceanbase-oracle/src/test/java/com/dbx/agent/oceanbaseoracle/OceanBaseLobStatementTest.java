package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.JdbcExecutor;
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
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.locks.ReentrantLock;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class OceanBaseLobStatementTest {
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
            Object locator = binary ? proxy(Blob.class, (o, m, a) -> defaultValue(m.getReturnType()))
                : proxy(Clob.class, (o, m, a) -> defaultValue(m.getReturnType()));
            CallableStatement delegate = proxy(CallableStatement.class, (object, method, args) -> {
                switch (method.getName()) {
                    case "unwrap": return ((Class<?>) args[0]).cast(vendor);
                    case "isWrapperFor": return ((Class<?>) args[0]).isInstance(vendor);
                    case "setBlob", "setClob": assertSame(locator, args[1]); calls.add(method.getName()); return null;
                    case "setInt": assertEquals(3, args[1]); return null;
                    case "setLong": assertEquals(6L, args[1]); return null;
                    case "setQueryTimeout": assertEquals(20, args[0]); return null;
                    case "registerOutParameter": assertEquals((int) args[0] == 2 ? Types.INTEGER : Types.VARCHAR, args[1]); return null;
                    case "execute":
                        assertTrue(vendor.isInternal());
                        assertTrue(JdbcExecutor.current().hasActiveStatements());
                        JdbcExecutor.current().cancelActiveStatements();
                        calls.add("execute"); return false;
                    case "cancel", "close": calls.add(method.getName()); return null;
                    case "getInt": return 2;
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
        SQLException error = assertThrows(SQLException.class, () -> OceanBaseLobValues.read(connection, proxy(Clob.class, (o, m, a) -> null), 0, 1));
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
