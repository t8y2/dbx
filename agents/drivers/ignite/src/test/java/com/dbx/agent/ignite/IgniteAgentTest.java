package com.dbx.agent.ignite;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import java.sql.DatabaseMetaData;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class IgniteAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new IgniteAgent();
    }

    @Override
    protected String resultSetSql() {
        return "SELECT 1";
    }

    @Test
    void aggregatesOrdinalColumnsAndPrimaryStatus() {
        List<IndexInfo> indexes = IgniteAgent.assembleIndexes(
            List.of(
                new IgniteAgent.IndexRow("IDX_NAME", "last_name", 2, false, "OTHER"),
                new IgniteAgent.IndexRow("PK_PERSON", "tenant_id", 1, true, "HASHED"),
                new IgniteAgent.IndexRow("IDX_NAME", "first_name", 1, false, "OTHER"),
                new IgniteAgent.IndexRow("PK_PERSON", "person_id", 2, true, "HASHED")
            ),
            Set.of("PK_PERSON"),
            List.of(
                new IgniteAgent.IndexColumn(2, "person_id"),
                new IgniteAgent.IndexColumn(1, "tenant_id")
            )
        );

        assertEquals(2, indexes.size());
        IndexInfo secondary = indexes.get(0);
        assertEquals("IDX_NAME", secondary.getName());
        assertEquals(List.of("first_name", "last_name"), secondary.getColumns());
        assertFalse(secondary.getIs_unique());
        assertFalse(secondary.getIs_primary());

        IndexInfo primary = indexes.get(1);
        assertEquals("PK_PERSON", primary.getName());
        assertEquals(List.of("tenant_id", "person_id"), primary.getColumns());
        assertTrue(primary.getIs_unique());
        assertTrue(primary.getIs_primary());
        assertEquals("HASHED", primary.getIndex_type());
    }
}
