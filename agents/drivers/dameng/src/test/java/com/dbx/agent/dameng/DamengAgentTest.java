package com.dbx.agent.dameng;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DamengAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new DamengAgent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL SP_SAMPLE()";
    }

    @Test
    void constrainedTableQueryPushesFilterTypeAndPagingToDameng() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedTablesQuery(
            "APP",
            new MetadataListConstraints("ord", 50, 100, List.of("TABLE", "VIEW"))
        );

        assertTrue(query.sql().contains("FROM ALL_OBJECTS o"));
        assertTrue(query.sql().contains("o.OBJECT_TYPE IN (?, ?)"));
        assertTrue(query.sql().contains("UPPER(o.OBJECT_NAME) LIKE ? ESCAPE '\\\\'"));
        assertTrue(query.sql().endsWith("LIMIT ? OFFSET ?"));
        assertEquals(List.of("APP", "TABLE", "VIEW", "%O%R%D%", 50, 100), query.args());
    }

    @Test
    void constrainedTableQueryMapsMaterializedViewTypeToDamengCatalogName() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedTablesQuery(
            "APP",
            new MetadataListConstraints(null, 20, null, List.of("MATERIALIZED_VIEW"))
        );

        assertTrue(query.sql().contains("MATERIALIZED_VIEW"));
        assertEquals(List.of("APP", "MATERIALIZED VIEW", 20), query.args());
    }

    @Test
    void constrainedObjectQueryPushesRoutineOnlySearchToDameng() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedObjectsQuery(
            "APP",
            new MetadataListConstraints("sync", 20, null, List.of("PROCEDURE", "FUNCTION"))
        );

        assertTrue(query.sql().contains("o.OBJECT_TYPE IN (?, ?)"));
        assertTrue(query.sql().contains("WHEN 'PROCEDURE' THEN 3"));
        assertTrue(query.sql().endsWith("LIMIT ?"));
        assertEquals(List.of("APP", "PROCEDURE", "FUNCTION", "%S%Y%N%C%", 20), query.args());
    }
}
