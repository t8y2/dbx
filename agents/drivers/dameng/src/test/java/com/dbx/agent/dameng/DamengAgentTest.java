package com.dbx.agent.dameng;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.JdbcAgentFake;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
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
    void executeQueryReturnsPlanRowsForExplainStatements() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        QueryResult result = agent.executeQuery(
            "/* inspect */ EXPLAIN SELECT 1 FROM DUAL;",
            null,
            new ExecuteQueryOptions()
        );

        assertEquals(List.of("PLAN"), result.getColumns());
        assertEquals(List.of(List.of("row-value")), result.getRows());
        assertEquals(List.of("executeQuery"), JdbcAgentFake.calls);
    }

    @Test
    void executeQueryPageReturnsPlanRowsForExplainStatements() {
        DamengAgent agent = new DamengAgent();
        TestSupport.setPrivateConnection(agent, JdbcAgentFake.connection());

        QueryPageResult result = agent.executeQueryPage(
            "EXPLAIN SELECT 1 FROM DUAL",
            null,
            new QueryPageOptions(100, 100, 1000)
        );

        assertEquals(List.of("PLAN"), result.getColumns());
        assertEquals(List.of(List.of("row-value")), result.getRows());
        assertNull(result.getSession_id());
        assertFalse(result.getHas_more());
        assertEquals(List.of("executeQuery"), JdbcAgentFake.calls);
    }

    @Test
    void explainTargetSqlOnlyMatchesStandaloneLeadingKeyword() {
        assertEquals("SELECT 1 FROM DUAL", DamengAgent.explainTargetSql("-- comment\n explain SELECT 1 FROM DUAL;;"));
        assertNull(DamengAgent.explainTargetSql("EXPLAINER SELECT 1"));
        assertNull(DamengAgent.explainTargetSql("SELECT 'EXPLAIN' FROM DUAL"));
    }

    @Test
    void objectSourceTypesMapToDamengMetadataTypes() {
        assertEquals("VIEW", DamengAgent.damengDdlObjectType("VIEW"));
        assertEquals("MATERIALIZED_VIEW", DamengAgent.damengDdlObjectType("MATERIALIZED VIEW"));
        assertEquals("MATERIALIZED_VIEW", DamengAgent.damengDdlObjectType("MATERIALIZED_VIEW"));
        assertEquals("PROCEDURE", DamengAgent.damengDdlObjectType("PROCEDURE"));
        assertEquals("FUNCTION", DamengAgent.damengDdlObjectType("function"));
        assertEquals("SEQUENCE", DamengAgent.damengDdlObjectType("sequence"));
        assertEquals("PKG_SPEC", DamengAgent.damengDdlObjectType("package"));
        assertEquals("PKG_BODY", DamengAgent.damengDdlObjectType("package body"));
        assertEquals("PKG_BODY", DamengAgent.damengDdlObjectType("PACKAGE_BODY"));
        assertEquals("TRIGGER", DamengAgent.damengDdlObjectType("trigger"));
        assertThrows(IllegalArgumentException.class, () -> DamengAgent.damengDdlObjectType("TABLE"));
    }

    @Test
    void spatialIndexDdlPreservesDamengIndexType() {
        IndexInfo index = new IndexInfo(
            "IDX_TEST_LINESTRING",
            List.of("LINESTRING"),
            false,
            false,
            null,
            "SPATIAL",
            null,
            null
        );

        assertEquals(
            "CREATE SPATIAL INDEX \"SYSDBA\".\"IDX_TEST_LINESTRING\" ON \"SYSDBA\".\"TEST\" (\"LINESTRING\");",
            DamengAgent.indexDdl("SYSDBA", "TEST", index)
        );
    }

    @Test
    void ordinaryIndexDdlKeepsExistingSyntax() {
        IndexInfo index = new IndexInfo(
            "IDX_TEST_NAME",
            List.of("NAME"),
            false,
            false,
            null,
            "NORMAL",
            null,
            null
        );

        assertEquals(
            "CREATE INDEX \"SYSDBA\".\"IDX_TEST_NAME\" ON \"SYSDBA\".\"TEST\" (\"NAME\");",
            DamengAgent.indexDdl("SYSDBA", "TEST", index)
        );

        index.setIs_unique(true);
        assertEquals(
            "CREATE UNIQUE INDEX \"SYSDBA\".\"IDX_TEST_NAME\" ON \"SYSDBA\".\"TEST\" (\"NAME\");",
            DamengAgent.indexDdl("SYSDBA", "TEST", index)
        );
    }

    @Test
    void constrainedTableQueryPushesFilterTypeAndPagingToDameng() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedTablesQuery(
            "APP",
            new MetadataListConstraints("ord", 50, 100, List.of("TABLE", "VIEW"))
        );

        assertTrue(query.sql().contains("FROM ALL_OBJECTS o"));
        assertTrue(query.sql().contains("FROM SYS.SYSOBJECTS materialized_view"));
        assertTrue(query.sql().contains("schema_object.NAME AS OWNER"));
        assertTrue(query.sql().contains("o.OBJECT_TYPE = 'MATERIALIZED VIEW'"));
        assertTrue(query.sql().contains("mv.MVIEW_NAME IS NOT NULL"));
        assertTrue(query.sql().contains("IN (?, ?)"));
        assertTrue(query.sql().contains("UPPER(o.OBJECT_NAME) LIKE ? ESCAPE '~'"));
        assertTrue(query.sql().endsWith("LIMIT ? OFFSET ?"));
        assertEquals(List.of("APP", "TABLE", "VIEW", "%O%R%D%", 50, 100), query.args());
    }

    @Test
    void constrainedTableQueryClassifiesMaterializedViewsForAnotherOwner() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedTablesQuery(
            "REPORTING",
            new MetadataListConstraints(null, 20, null, List.of("MATERIALIZED_VIEW"))
        );

        assertTrue(query.sql().contains("MATERIALIZED_VIEW"));
        assertTrue(query.sql().contains("schema_object.ID = materialized_view.SCHID"));
        assertTrue(query.sql().contains("mv.OWNER = o.OWNER"));
        assertEquals(List.of("REPORTING", "MATERIALIZED_VIEW", 20), query.args());
    }

    @Test
    void constrainedTableOnlyQuerySkipsMaterializedViewCatalog() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedTablesQuery(
            "APP",
            new MetadataListConstraints(null, 20, null, List.of("TABLE"))
        );

        assertFalse(query.sql().contains("SYS.SYSOBJECTS materialized_view"));
        assertFalse(query.sql().contains("USER_MVIEWS"));
        assertFalse(query.sql().contains("mv.MVIEW_NAME"));
        assertTrue(query.sql().contains("o.OBJECT_TYPE IN (?)"));
        assertEquals(List.of("APP", "TABLE", 20), query.args());
    }

    @Test
    void accessibleTableQueryBulkClassifiesViewsAndPreservesPaging() {
        DamengAgent.MetadataQuery query = DamengAgent.buildAccessibleConstrainedTablesQuery(
            "REPORTING",
            new MetadataListConstraints("sales", 20, 40, List.of("VIEW", "MATERIALIZED_VIEW"))
        );

        assertTrue(query.sql().contains("FROM ALL_OBJECTS o"));
        assertTrue(query.sql().contains("FROM ALL_DEPENDENCIES"));
        assertTrue(query.sql().contains("TYPE IN ('MATERIALIZED VIEW', 'MATERIALIZED_VIEW')"));
        assertFalse(query.sql().contains("SYS.SYSOBJECTS"));
        assertFalse(query.sql().contains("USER_MVIEWS"));
        assertFalse(query.sql().contains("DBMS_METADATA.GET_DDL"));
        assertTrue(query.sql().contains("mv.MVIEW_NAME IS NOT NULL"));
        assertTrue(query.sql().contains("UPPER(o.OBJECT_NAME) LIKE ? ESCAPE '~'"));
        assertTrue(query.sql().endsWith("LIMIT ? OFFSET ?"));
        assertEquals(List.of("REPORTING", "VIEW", "MATERIALIZED_VIEW", "%S%A%L%E%S%", 20, 40), query.args());
    }

    @Test
    void constrainedObjectQueryClassifiesMaterializedViewsBeforeFiltering() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedObjectsQuery(
            "APP",
            new MetadataListConstraints(null, 20, null, List.of("VIEW", "MATERIALIZED_VIEW"))
        );

        assertTrue(query.sql().contains("FROM SYS.SYSOBJECTS materialized_view"));
        assertTrue(query.sql().contains("mv.MVIEW_NAME IS NOT NULL"));
        assertTrue(query.sql().contains("WHEN 'MATERIALIZED_VIEW' THEN 2"));
        assertEquals(List.of("APP", "VIEW", "MATERIALIZED_VIEW", 20), query.args());
    }

    @Test
    void constrainedObjectQueryPushesRoutineOnlySearchToDameng() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedObjectsQuery(
            "APP",
            new MetadataListConstraints("sync", 20, null, List.of("PROCEDURE", "FUNCTION"))
        );

        assertFalse(query.sql().contains("SYS.SYSOBJECTS materialized_view"));
        assertFalse(query.sql().contains("USER_MVIEWS"));
        assertFalse(query.sql().contains("mv.MVIEW_NAME"));
        assertTrue(query.sql().contains("o.OBJECT_TYPE IN (?, ?)"));
        assertTrue(query.sql().contains("WHEN 'PROCEDURE' THEN 3"));
        assertTrue(query.sql().endsWith("LIMIT ?"));
        assertEquals(List.of("APP", "PROCEDURE", "FUNCTION", "%S%Y%N%C%", 20), query.args());
    }

    @Test
    void constrainedObjectQueryIncludesSequencesAndPackages() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedObjectsQuery(
            "APP",
            new MetadataListConstraints(null, 20, null, List.of("SEQUENCE", "PACKAGE", "PACKAGE_BODY"))
        );

        assertFalse(query.sql().contains("SYS.SYSOBJECTS materialized_view"));
        assertTrue(query.sql().contains("o.OBJECT_TYPE IN (?, ?, ?)"));
        assertEquals(List.of("APP", "SEQUENCE", "PACKAGE", "PACKAGE BODY", 20), query.args());
    }

    @Test
    void rawObjectQueryIncludesDamengPackageBodyCatalogType() {
        DamengAgent.MetadataQuery query = DamengAgent.buildRawConstrainedObjectsQuery(
            "APP",
            new MetadataListConstraints(null, null, null, List.of("SEQUENCE", "PACKAGE", "PACKAGE_BODY"))
        );

        assertTrue(query.sql().contains("o.OBJECT_TYPE IN (?, ?, ?)"));
        assertEquals(List.of("APP", "SEQUENCE", "PACKAGE", "PACKAGE BODY"), query.args());
    }

    @Test
    void constrainedTableQueryEscapesDamengLikeWildcardsWithSingleCharacter() {
        DamengAgent.MetadataQuery query = DamengAgent.buildConstrainedTablesQuery(
            "APP",
            new MetadataListConstraints("a_%~\\", 20, null, List.of("TABLE"))
        );

        assertTrue(query.sql().contains("UPPER(o.OBJECT_NAME) LIKE ? ESCAPE '~'"));
        assertEquals(List.of("APP", "TABLE", "%A%~_%~%%~~%\\%", 20), query.args());
    }

    @Test
    void accessibleObjectQueryBulkClassifiesViewsAndPreservesPaging() {
        DamengAgent.MetadataQuery query = DamengAgent.buildAccessibleConstrainedObjectsQuery(
            "REPORTING",
            new MetadataListConstraints("sales", 10, 30, List.of("VIEW", "MATERIALIZED_VIEW"))
        );

        assertTrue(query.sql().contains("FROM ALL_DEPENDENCIES"));
        assertTrue(query.sql().contains("TYPE IN ('MATERIALIZED VIEW', 'MATERIALIZED_VIEW')"));
        assertFalse(query.sql().contains("SYS.SYSOBJECTS"));
        assertFalse(query.sql().contains("USER_MVIEWS"));
        assertFalse(query.sql().contains("DBMS_METADATA.GET_DDL"));
        assertTrue(query.sql().contains("mv.MVIEW_NAME IS NOT NULL"));
        assertTrue(query.sql().endsWith("LIMIT ? OFFSET ?"));
        assertEquals(List.of("REPORTING", "VIEW", "MATERIALIZED_VIEW", "%S%A%L%E%S%", 10, 30), query.args());
    }
}
