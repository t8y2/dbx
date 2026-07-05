package com.dbx.agent.sundb;

import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.test.TestSupport;
import com.dbx.agent.test.JdbcAgentFake;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class SundbAgentMetadataTest {
    @Test
    void quotesSchemaAndTableIdentifiersInIndexMetadataSql() {
        SundbAgent agent = new SundbAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listIndexes("bad`schema", "bad`table");

        Assertions.assertEquals(
            Collections.singletonList("SHOW INDEX FROM `bad``table` FROM `bad``schema`"),
            JdbcMetadataSqlFake.statements
        );
    }

    @Test
    void constrainedTableMetadataPushesFilterTypesAndPaging() {
        SundbAgent agent = new SundbAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTables("app", new MetadataListConstraints("ord", 25, 50, List.of("TABLE", "VIEW")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.contains("FROM information_schema.TABLES"), sql);
        Assertions.assertTrue(sql.contains("TABLE_TYPE IN (?, ?)"), sql);
        Assertions.assertTrue(sql.contains("UPPER(TABLE_NAME) LIKE ? ESCAPE '\\\\'"), sql);
        Assertions.assertTrue(sql.endsWith("LIMIT 25 OFFSET 50"), sql);
    }

    @Test
    void constrainedObjectMetadataPushesRoutineTypesAndPaging() {
        SundbAgent agent = new SundbAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listObjects("app", new MetadataListConstraints("sync", 10, null, List.of("PROCEDURE", "FUNCTION")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.contains("FROM information_schema.ROUTINES"), sql);
        Assertions.assertTrue(sql.contains("ROUTINE_TYPE IN (?, ?)"), sql);
        Assertions.assertTrue(sql.contains("ORDER BY CASE OBJECT_TYPE"), sql);
        Assertions.assertTrue(sql.endsWith("LIMIT 10"), sql);
    }
}
