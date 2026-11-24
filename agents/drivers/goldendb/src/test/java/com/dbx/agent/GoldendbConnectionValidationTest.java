package com.dbx.agent;

import com.dbx.agent.goldendb.GoldendbAgent;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GoldendbConnectionValidationTest {
    @Test
    void validatesConnectionWithSqlWhenJdbcIsValidReturnsFalse() throws Exception {
        AbstractJdbcAgent agent = new GoldendbAgent();
        try (Connection connection = JdbcMetadataSqlFake.connection()) {
            assertFalse(connection.isValid(2));

            assertTrue(agent.isConnectionValid(connection, 2));
            assertEquals(List.of("SELECT 1"), JdbcMetadataSqlFake.statements);
        }
    }
}
