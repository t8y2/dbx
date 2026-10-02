package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.QueryPageOptions;
import com.oceanbase.jdbc.OceanBaseConnection;
import com.oceanbase.jdbc.UrlParser;
import com.oceanbase.jdbc.internal.com.read.dao.Results;
import com.oceanbase.jdbc.internal.protocol.MasterProtocol;
import com.oceanbase.jdbc.internal.util.pool.GlobalStateInfo;
import org.junit.jupiter.api.Test;

import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.locks.ReentrantLock;

import static org.junit.jupiter.api.Assertions.*;

class OceanBaseOracleCursorTransportTest {
    @Test
    void connectorKeepsSqlAndAppliesCumulativeLimitIncludingLookahead() throws Exception {
        for (String sql : List.of("SELECT a.name, a.* FROM people a", "SELECT name, name FROM people",
            "SELECT a.*, b.* FROM people a JOIN people b ON a.id=b.id")) {
            for (int max : new int[]{0, 1, 10000, Integer.MAX_VALUE}) {
                for (boolean fallback : new boolean[]{false, true}) {
                    Capture protocol = new Capture(fallback);
                    OceanBaseConnection connection = new OceanBaseConnection(protocol);
                    JdbcExecutor executor = new JdbcExecutor();
                    RuntimeException error = assertThrows(RuntimeException.class, () -> executor.executeBoundedPage(
                        connection, sql, null, schema -> "", () -> "", new QueryPageOptions(2, null, max),
                        executor::defaultResultValue));
                    assertTrue(error.toString().contains("STOP_BEFORE_NETWORK"));
                    assertEquals("set @@_ORACLE_SQL_SELECT_LIMIT = " + JdbcExecutor.statementMaxRows(max), protocol.sent.get(0));
                    if (fallback) assertEquals("set @@SQL_SELECT_LIMIT = " + JdbcExecutor.statementMaxRows(max), protocol.sent.get(1));
                    assertEquals(sql, protocol.sent.get(protocol.sent.size() - 1));
                    assertFalse(executor.hasActiveStatements());
                    assertFalse(executor.hasOpenSessions());
                    protocol.sent.clear();
                    try (Statement statement = connection.createStatement()) {
                        assertThrows(SQLException.class, () -> statement.execute("SELECT 1 FROM DUAL"));
                    }
                    assertEquals("set @@_ORACLE_SQL_SELECT_LIMIT = DEFAULT", protocol.sent.get(0));
                    if (fallback) assertEquals("set @@SQL_SELECT_LIMIT = DEFAULT", protocol.sent.get(1));
                }
            }
        }
    }

    private static final class Capture extends MasterProtocol {
        final List<String> sent = new ArrayList<>();
        final boolean fallback;

        Capture(boolean fallback) throws Exception {
            super(UrlParser.parse("jdbc:oceanbase://localhost:1/test"), new GlobalStateInfo(), new ReentrantLock(), null);
            this.fallback = fallback;
            connected = true;
        }

        @Override
        public boolean isOracleMode() { return true; }

        @Override
        public boolean versionGreaterOrEqual(int major, int minor, int patch) { return false; }

        @Override
        public void executeQuery(String sql) throws SQLException {
            sent.add(sql);
            if (fallback && sql.contains("_ORACLE_SQL_SELECT_LIMIT")) throw new SQLException("unsupported variable fixture");
        }

        @Override
        public void executeQuery(boolean master, Results results, String sql) throws SQLException {
            sent.add(sql);
            throw new SQLException("STOP_BEFORE_NETWORK", "ZZZZZ");
        }
    }
}
