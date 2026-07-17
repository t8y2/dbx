package com.dbx.agent.snowflake;

import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.test.TestSupport;
import com.dbx.agent.test.JdbcAgentFake;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class SnowflakeAgentMetadataTest {
    @Test
    void quotesSchemaAndTableIdentifiersInKeyMetadataSql() {
        SnowflakeAgent agent = new SnowflakeAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.getColumns("bad\"schema", "bad\"table");
        agent.listForeignKeys("bad\"schema", "bad\"table");

        Assertions.assertTrue(
            JdbcMetadataSqlFake.statements.contains(
                "SHOW PRIMARY KEYS IN TABLE \"bad\"\"schema\".\"bad\"\"table\""
            )
        );
        Assertions.assertTrue(
            JdbcMetadataSqlFake.statements.contains(
                "SHOW IMPORTED KEYS IN TABLE \"bad\"\"schema\".\"bad\"\"table\""
            )
        );
    }

    @Test
    void constrainedTableMetadataPushesFilterTypesAndPaging() {
        SnowflakeAgent agent = new SnowflakeAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTables("PUBLIC", new MetadataListConstraints("ord", 25, 50, List.of("TABLE", "VIEW")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.contains("FROM INFORMATION_SCHEMA.TABLES"), sql);
        Assertions.assertTrue(sql.contains("TABLE_TYPE IN (?, ?)"), sql);
        Assertions.assertTrue(sql.contains("UPPER(TABLE_NAME) LIKE ? ESCAPE '\\\\'"), sql);
        Assertions.assertTrue(sql.endsWith("LIMIT 25 OFFSET 50"), sql);
    }

    @Test
    void constrainedObjectMetadataPushesProcedureSearchAndPaging() {
        SnowflakeAgent agent = new SnowflakeAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listObjects("PUBLIC", new MetadataListConstraints("sync", 10, null, List.of("PROCEDURE")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.contains("FROM INFORMATION_SCHEMA.PROCEDURES"), sql);
        Assertions.assertTrue(sql.contains("UPPER(PROCEDURE_NAME) LIKE ? ESCAPE '\\\\'"), sql);
        Assertions.assertTrue(sql.contains("ORDER BY CASE OBJECT_TYPE"), sql);
        Assertions.assertTrue(sql.endsWith("LIMIT 10"), sql);
    }
}
