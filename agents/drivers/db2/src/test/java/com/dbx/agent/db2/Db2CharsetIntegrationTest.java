package com.dbx.agent.db2;

import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.TestSupport;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Opt-in real DB2 LUW checks for catalog decoding and write encoding.
 *
 * <p>Set {@code DBX_DB2_JDBC_URL/USER/PASSWORD} to run. Set {@code DBX_DB2_BAD_COMMENT_SCHEMA}
 * to a schema whose catalog comments contain bytes that are invalid for the database encoding
 * (ERRORCODE=-4220) to exercise the catalog fallback.
 */
@EnabledIfEnvironmentVariable(named = "DBX_DB2_JDBC_URL", matches = ".+")
class Db2CharsetIntegrationTest {
    @Test
    void listsCatalogMetadataWhenCommentsCannotBeDecoded() throws Exception {
        String schema = System.getenv("DBX_DB2_BAD_COMMENT_SCHEMA");
        assumeTrue(schema != null && !schema.isBlank(),
            "Set DBX_DB2_BAD_COMMENT_SCHEMA to a schema with undecodable catalog comments");
        try (Connection connection = connect()) {
            Db2Agent agent = agent(connection);

            List<TableInfo> tables = agent.listTables(schema);
            assertFalse(tables.isEmpty());
            for (TableInfo table : tables) {
                assertNotNull(table.getName());
                assertFalse(table.getName().isBlank());
            }
            assertDoesNotThrow(() -> agent.listObjects(schema));
            assertDoesNotThrow(() -> agent.getColumns(schema, tables.get(0).getName()));
        }
    }

    @Test
    void rejectsUnrepresentableWriteWithoutChangingStoredValue() throws Exception {
        try (Connection connection = connect()) {
            String schema = scalar(connection, "VALUES SESSION_USER").trim();
            String name = "DBXCS_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase();
            String table = JdbcIdentifiers.INSTANCE.doubleQuote(schema) + "." + JdbcIdentifiers.INSTANCE.doubleQuote(name);
            try (Statement statement = connection.createStatement()) {
                statement.execute("CREATE TABLE " + table + " (ID INTEGER NOT NULL, VALUE VARCHAR(64))");
                try {
                    statement.executeUpdate("INSERT INTO " + table + " VALUES (1, 'before')");
                    // A lone surrogate is not encodable in any DB2 database code page.
                    assertThrows(RuntimeException.class, () -> agent(connection).executeQuery(
                        "UPDATE " + table + " SET VALUE = '\uD800' WHERE ID = 1", null, new ExecuteQueryOptions()));
                    assertEquals("before", scalar(connection, "SELECT VALUE FROM " + table + " WHERE ID = 1"));
                } finally {
                    statement.execute("DROP TABLE " + table);
                }
            }
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
            if (!rows.next()) {
                return null;
            }
            return rows.getString(1);
        }
    }
}
