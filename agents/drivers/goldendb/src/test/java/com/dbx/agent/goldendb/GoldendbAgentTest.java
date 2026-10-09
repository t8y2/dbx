package com.dbx.agent.goldendb;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.Types;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class GoldendbAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new GoldendbAgent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL sample_proc()";
    }

    @Test
    void binaryResultsPreserveBytesInsteadOfReturningAmbiguousText() {
        GoldendbAgent agent = new GoldendbAgent();
        byte[][] values = {
            "deadbeef".getBytes(StandardCharsets.US_ASCII),
            "0x00ff".getBytes(StandardCharsets.US_ASCII),
            new byte[]{0, (byte) 0xff, (byte) 0x80},
            new byte[0]
        };
        String[] expected = {"0x6465616462656566", "0x307830306666", "0x00ff80", "0x"};
        for (int sqlType : new int[]{Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY, Types.BLOB}) {
            for (int i = 0; i < values.length; i++) {
                assertEquals(expected[i], agent.resultValue(binaryResultSet(values[i]), 1, sqlType));
            }
            assertNull(agent.resultValue(binaryResultSet(null), 1, sqlType));
        }
    }

    private static ResultSet binaryResultSet(byte[] bytes) {
        return (ResultSet) Proxy.newProxyInstance(
            GoldendbAgentTest.class.getClassLoader(),
            new Class<?>[]{ResultSet.class},
            (proxy, method, args) -> {
                if ("getBytes".equals(method.getName())) {
                    assertEquals(1, args[0]);
                    return bytes;
                }
                if ("wasNull".equals(method.getName())) return bytes == null;
                throw new AssertionError("Unexpected ResultSet call: " + method.getName());
            }
        );
    }
}
