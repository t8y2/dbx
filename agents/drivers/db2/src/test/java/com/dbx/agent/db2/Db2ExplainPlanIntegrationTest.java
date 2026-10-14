package com.dbx.agent.db2;

import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.test.TestSupport;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import static org.junit.jupiter.api.Assertions.*;

/**
 * Opt-in real DB2 LUW checks. Credentials stay in DBX_DB2_JDBC_URL/USER/PASSWORD.
 * The sequence check needs CREATEIN/DROPIN on the connecting user's schema.
 */
@EnabledIfEnvironmentVariable(named = "DBX_DB2_JDBC_URL", matches = ".+")
class Db2ExplainPlanIntegrationTest {
    @Test
    void realPlansRoundTripAndRollbackWithoutChangingSessionSchema() throws Exception {
        try (Connection connection = connect()) {
            String originalSchema = scalar(connection, "VALUES CURRENT SCHEMA").trim();
            String explainSchema = explainSchema(connection);
            long before = requestCount(connection, explainSchema);
            Db2Agent agent = agent(connection);
            String businessSchema = System.getenv("DBX_DB2_SCHEMA");
            List<String> queries = List.of(
                "SELECT IBMREQD FROM SYSIBM.SYSDUMMY1;",
                "WITH x AS (SELECT IBMREQD FROM SYSIBM.SYSDUMMY1) SELECT * FROM x",
                "SELECT a.IBMREQD FROM SYSIBM.SYSDUMMY1 a JOIN SYSIBM.SYSDUMMY1 b ON a.IBMREQD = b.IBMREQD WHERE a.IBMREQD = 'Y'"
            );
            int index = 0;
            for (String sql : queries) {
                String raw = agent.getExplainInfo(sql, null, businessSchema, 30, "explain");
                JsonObject plan = JsonParser.parseString(raw).getAsJsonObject();
                assertFalse(plan.getAsJsonArray("operators").isEmpty());
                assertFalse(plan.getAsJsonArray("streams").isEmpty());
                assertEquals(originalSchema, scalar(connection, "VALUES CURRENT SCHEMA").trim());
                assertTrue(connection.getAutoCommit());
                assertEquals(before, requestCount(connection, explainSchema), "Explain rows must be rolled back");
                String directory = System.getenv("DBX_DB2_PROOF_DIR");
                if (directory != null && !directory.isBlank()) {
                    Path path = Path.of(directory);
                    Files.createDirectories(path);
                    Files.writeString(path.resolve("jdbc-plan-" + index + ".json"), raw);
                }
                index++;
            }
        }
    }

    @Test
    void explainDoesNotConsumeSequenceValueFromTheBusinessStatement() throws Exception {
        try (Connection connection = connect()) {
            String schema = scalar(connection, "VALUES SESSION_USER").trim();
            String name = "DBXEP_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase();
            String sequence = JdbcIdentifiers.INSTANCE.doubleQuote(schema) + "." + JdbcIdentifiers.INSTANCE.doubleQuote(name);
            try (Statement statement = connection.createStatement()) {
                statement.execute("CREATE SEQUENCE " + sequence + " AS BIGINT START WITH 1 INCREMENT BY 1 NO CACHE");
                try {
                    assertEquals("1", scalar(connection, "VALUES NEXT VALUE FOR " + sequence).trim());
                    agent(connection).getExplainInfo("SELECT NEXT VALUE FOR " + sequence + " FROM SYSIBM.SYSDUMMY1", null, null, 30, null);
                    assertEquals("2", scalar(connection, "VALUES NEXT VALUE FOR " + sequence).trim(),
                        "Generating the estimated plan must not execute the sequence expression");
                } finally {
                    statement.execute("DROP SEQUENCE " + sequence);
                }
            }
        }
    }

    @Test
    void concurrentConnectionsReturnDistinctRequestsAndLeaveNoPersistedExplainRows() throws Exception {
        String explainSchema;
        long before;
        try (Connection connection = connect()) {
            explainSchema = explainSchema(connection);
            before = requestCount(connection, explainSchema);
        }
        List<Callable<String>> tasks = new ArrayList<>();
        for (int index = 0; index < 16; index++) {
            int value = index;
            tasks.add(() -> {
                try (Connection connection = connect()) {
                    JsonObject plan = JsonParser.parseString(agent(connection).getExplainInfo(
                        "SELECT " + value + " AS MARKER FROM SYSIBM.SYSDUMMY1", null,
                        System.getenv("DBX_DB2_SCHEMA"), 30, null
                    )).getAsJsonObject();
                    assertFalse(plan.getAsJsonArray("operators").isEmpty());
                    return plan.get("requestTag").getAsString();
                }
            });
        }
        HashSet<String> tags = new HashSet<>();
        try (var executor = Executors.newFixedThreadPool(4)) {
            for (var future : executor.invokeAll(tasks)) tags.add(future.get());
        }
        assertEquals(tasks.size(), tags.size());
        try (Connection connection = connect()) {
            assertEquals(before, requestCount(connection, explainSchema));
        }
    }

    @Test
    void existingTransactionRemainsOpenWhenExplainIsRejected() throws Exception {
        try (Connection connection = connect()) {
            connection.setAutoCommit(false);
            assertThrows(IllegalStateException.class,
                () -> agent(connection).getExplainInfo("SELECT * FROM SYSIBM.SYSDUMMY1", null, null, 30, null));
            assertFalse(connection.getAutoCommit());
            assertEquals("Y", scalar(connection, "SELECT IBMREQD FROM SYSIBM.SYSDUMMY1").trim());
            connection.rollback();
        }
    }

    private static Db2Agent agent(Connection connection) {
        Db2Agent agent = new Db2Agent();
        TestSupport.setPrivateConnection(agent, connection);
        return agent;
    }

    private static Connection connect() throws Exception {
        return DriverManager.getConnection(System.getenv("DBX_DB2_JDBC_URL"),
            System.getenv("DBX_DB2_USER"), System.getenv("DBX_DB2_PASSWORD"));
    }

    private static String scalar(Connection connection, String sql) throws Exception {
        try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(sql)) {
            assertTrue(rows.next());
            return rows.getString(1);
        }
    }

    private static String explainSchema(Connection connection) throws Exception {
        String user = scalar(connection, "VALUES SESSION_USER").trim();
        try (var statement = connection.prepareStatement("SELECT TABSCHEMA FROM SYSCAT.TABLES "
            + "WHERE TABNAME = 'EXPLAIN_INSTANCE' AND TABSCHEMA IN (?, 'SYSTOOLS') "
            + "ORDER BY CASE WHEN TABSCHEMA = ? THEN 0 ELSE 1 END")) {
            statement.setString(1, user);
            statement.setString(2, user);
            try (ResultSet rows = statement.executeQuery()) {
                assertTrue(rows.next(), "The integration database must have Explain tables installed");
                return rows.getString(1).trim();
            }
        }
    }

    private static long requestCount(Connection connection, String schema) throws Exception {
        try (var statement = connection.prepareStatement("SELECT COUNT(*) FROM "
            + JdbcIdentifiers.INSTANCE.doubleQuote(schema) + ".EXPLAIN_INSTANCE WHERE EXPLAIN_REQUESTER = SESSION_USER");
             ResultSet rows = statement.executeQuery()) {
            assertTrue(rows.next());
            return rows.getLong(1);
        }
    }
}
