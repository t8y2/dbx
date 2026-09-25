package com.dbx.agent.iris;

import com.dbx.agent.ConnectParams;
import com.intersystems.jdbc.IRISConnection;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;

class IrisAgentQueryPrefetchTest {
    /** Records setQueryPrefetchSize calls without touching driver internals. */
    static final class RecordingIrisConnection extends IRISConnection {
        final List<Integer> prefetchSizes = new ArrayList<>();

        @Override
        public void setQueryPrefetchSize(int size) {
            prefetchSizes.add(size);
        }
    }

    static final class FailingIrisConnection extends IRISConnection {
        @Override
        public void setQueryPrefetchSize(int size) throws SQLException {
            throw new SQLException("server rejected prefetch size");
        }
    }

    @Test
    void afterConnectAppliesLargerQueryPrefetch() {
        RecordingIrisConnection connection = new RecordingIrisConnection();

        new IrisAgent().afterConnect(new ConnectParams(), connection);

        assertEquals(Collections.singletonList(IrisAgent.IRIS_QUERY_PREFETCH_SIZE), connection.prefetchSizes);
    }

    @Test
    void afterConnectKeepsNonIrisConnectionsUntouched() {
        Connection connection = proxyConnection();

        assertDoesNotThrow(() -> new IrisAgent().afterConnect(new ConnectParams(), connection));
    }

    @Test
    void prefetchFailureDoesNotBreakConnect() {
        FailingIrisConnection connection = new FailingIrisConnection();

        assertDoesNotThrow(() -> new IrisAgent().afterConnect(new ConnectParams(), connection));
    }

    @Test
    void directApplyIsBoundedToIrisConnections() {
        // A plain java.sql.Connection (for example a test or wrapper instance)
        // must not be cast or fail when the prefetch tuning runs.
        assertDoesNotThrow(() -> IrisAgent.applyQueryPrefetchSize(proxyConnection()));
    }

    private static Connection proxyConnection() {
        return (Connection) Proxy.newProxyInstance(
            IrisAgentQueryPrefetchTest.class.getClassLoader(),
            new Class<?>[] { Connection.class },
            new InvocationHandler() {
                @Override
                public Object invoke(Object proxy, Method method, Object[] args) {
                    Class<?> returnType = method.getReturnType();
                    if (returnType == boolean.class) {
                        return false;
                    }
                    if (returnType.isPrimitive() && returnType != void.class) {
                        return 0;
                    }
                    return null;
                }
            }
        );
    }
}
