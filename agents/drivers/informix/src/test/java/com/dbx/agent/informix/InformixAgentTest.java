package com.dbx.agent.informix;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import com.dbx.agent.test.TestSupport;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class InformixAgentTest {
    @Test
    void buildsJdbcUrlWithExplicitInformixServerAndLocaleParameters() {
        String url = InformixAgent.jdbcUrl(
            new ConnectParams(
                "172.26.128.159",
                20013,
                "testdb",
                "",
                "",
                "INFORMIXSERVER=informix;CLIENT_LOCALE=en_US.utf8;DB_LOCALE=en_US.utf8",
                "",
                false
            )
        );

        Assertions.assertEquals(
            "jdbc:informix-sqli://172.26.128.159:20013/testdb:INFORMIXSERVER=informix;CLIENT_LOCALE=en_US.utf8;DB_LOCALE=en_US.utf8",
            url
        );
    }

    @Test
    void fallsBackToHostAsInformixServerWhenNoExplicitServerIsConfigured() {
        String url = InformixAgent.jdbcUrl(
            new ConnectParams(
                "informix-host",
                9088,
                "sysmaster",
                "",
                "",
                "",
                "",
                false
            )
        );

        Assertions.assertEquals(
            "jdbc:informix-sqli://informix-host:9088/sysmaster:INFORMIXSERVER=informix-host;CLIENT_LOCALE=en_US.utf8;DB_LOCALE=en_US.utf8",
            url
        );
    }

    @Test
    void fallsBackToInformixServerNameWhenHostIsAnIpAddress() {
        String url = InformixAgent.jdbcUrl(
            new ConnectParams(
                "172.26.128.159",
                20013,
                "sysmaster",
                "",
                "",
                "",
                "",
                false
            )
        );

        Assertions.assertEquals(
            "jdbc:informix-sqli://172.26.128.159:20013/sysmaster:INFORMIXSERVER=informix;CLIENT_LOCALE=en_US.utf8;DB_LOCALE=en_US.utf8",
            url
        );
    }

    @Test
    void usesInformixServerFromDedicatedFieldWhenProvided() {
        ConnectParams params = new ConnectParams(
            "172.26.128.159",
            20013,
            "testdb",
            "",
            "",
            "CLIENT_LOCALE=en_US.utf8",
            "",
            false
        );
        params.setInformix_server("ol_informix1410");

        String url = InformixAgent.jdbcUrl(params);

        Assertions.assertEquals(
            "jdbc:informix-sqli://172.26.128.159:20013/testdb:INFORMIXSERVER=ol_informix1410;CLIENT_LOCALE=en_US.utf8;DB_LOCALE=en_US.utf8",
            url
        );
    }

    @Test
    void usesSysmasterWhenDatabaseIsBlank() {
        String url = InformixAgent.jdbcUrl(
            new ConnectParams(
                "informix-host",
                9088,
                "",
                "",
                "",
                "INFORMIXSERVER=informix",
                "",
                false
            )
        );

        Assertions.assertEquals(
            "jdbc:informix-sqli://informix-host:9088/sysmaster:INFORMIXSERVER=informix;CLIENT_LOCALE=en_US.utf8;DB_LOCALE=en_US.utf8",
            url
        );
    }

    @Test
    void extractsPrimaryKeyColumnNumbersFromInformixIndexParts() {
        Assertions.assertEquals(
            Set.of(1, 3, 5),
            InformixAgent.primaryKeyColumnNumbers(Arrays.asList(1, -3, 0, 5, null))
        );
    }

    @Test
    void listsDatabasesFromSysmasterCatalog() {
        Assertions.assertEquals("SELECT name FROM sysmaster:sysdatabases ORDER BY name", InformixAgent.databaseCatalogSql());
    }

    @Test
    void listsSchemasFromUserObjectOwnersAndExcludesSystemVersionRow() {
        InformixAgent agent = new InformixAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listSchemas();

        Assertions.assertEquals(
            List.of("SELECT DISTINCT owner FROM systables "
                    + "WHERE tabid >= 100 AND owner IS NOT NULL ORDER BY owner"),
            JdbcMetadataSqlFake.statements
        );
        Assertions.assertNotEquals(InformixAgent.databaseCatalogSql(), InformixAgent.schemaCatalogSql());
    }

    @Test
    void unconstrainedTableMetadataFiltersByRequestedOwner() {
        InformixAgent agent = new InformixAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTables("xtdpcky");

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.contains("FROM systables"), sql);
        Assertions.assertTrue(sql.contains("AND owner = ?"), sql);
        Assertions.assertEquals("param:1=xtdpcky", JdbcMetadataSqlFake.statements.get(1));
    }

    @Test
    void constrainedTableMetadataUsesInformixSkipFirstPushdown() {
        InformixAgent agent = new InformixAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTables("xtdpcky", new MetadataListConstraints("ord", 25, 50, List.of("TABLE")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.startsWith("SELECT SKIP 50 FIRST 25 tabname"), sql);
        Assertions.assertTrue(sql.contains("tabtype IN ('T')"), sql);
        Assertions.assertTrue(sql.contains("AND owner = ?"), sql);
        Assertions.assertTrue(sql.contains("UPPER(tabname) LIKE ? ESCAPE '\\\\'"), sql);
        Assertions.assertTrue(sql.endsWith("ORDER BY tabname"), sql);
        Assertions.assertEquals(
            List.of("param:1=xtdpcky", "param:2=%O%R%D%"),
            JdbcMetadataSqlFake.statements.subList(1, 3)
        );
    }

    @Test
    void constrainedObjectMetadataUsesInformixUnionPushdown() {
        InformixAgent agent = new InformixAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listObjects("xtdpcky", new MetadataListConstraints("sync", 10, null, List.of("PROCEDURE", "FUNCTION")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.startsWith("SELECT FIRST 10 object_name, object_type FROM ("), sql);
        Assertions.assertTrue(sql.contains("FROM sysprocedures"), sql);
        Assertions.assertTrue(sql.contains("isproc = 'f' AND owner = ?"), sql);
        Assertions.assertTrue(sql.contains("isproc = 't' AND owner = ?"), sql);
        Assertions.assertTrue(sql.endsWith("ORDER BY object_order, object_name"), sql);
        Assertions.assertEquals(
            List.of("param:1=xtdpcky", "param:2=%S%Y%N%C%", "param:3=xtdpcky", "param:4=%S%Y%N%C%"),
            JdbcMetadataSqlFake.statements.subList(1, 5)
        );
    }

    @Test
    void columnAndPrimaryKeyMetadataFilterDuplicateTableNamesByOwner() {
        InformixAgent agent = new InformixAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.getColumns("xtdpcky", "orders");

        String primaryKeySql = JdbcMetadataSqlFake.statements.get(0);
        String columnsSql = JdbcMetadataSqlFake.statements.get(3);
        Assertions.assertTrue(primaryKeySql.contains("WHERE t.tabname = ? AND c.constrtype = 'P' AND t.owner = ?"), primaryKeySql);
        Assertions.assertTrue(columnsSql.contains("WHERE t.tabname = ? AND t.owner = ?"), columnsSql);
        Assertions.assertEquals(
            List.of(
                "param:1=orders",
                "param:2=xtdpcky",
                "param:1=orders",
                "param:2=xtdpcky"
            ),
            List.of(
                JdbcMetadataSqlFake.statements.get(1),
                JdbcMetadataSqlFake.statements.get(2),
                JdbcMetadataSqlFake.statements.get(4),
                JdbcMetadataSqlFake.statements.get(5)
            )
        );
    }

    @Test
    void routineSourceAndTriggerMetadataUseRequestedOwner() {
        InformixAgent agent = new InformixAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.getObjectSource("xtdpcky", "sync_orders", "PROCEDURE");
        agent.listTriggers("xtdpcky", "orders");

        String sourceSql = JdbcMetadataSqlFake.statements.get(0);
        String triggerSql = JdbcMetadataSqlFake.statements.get(3);
        Assertions.assertTrue(sourceSql.contains("AND p.owner = ?"), sourceSql);
        Assertions.assertTrue(triggerSql.contains("WHERE s.tabname = ? AND s.owner = ?"), triggerSql);
        Assertions.assertEquals("param:2=xtdpcky", JdbcMetadataSqlFake.statements.get(2));
        Assertions.assertEquals("param:2=xtdpcky", JdbcMetadataSqlFake.statements.get(5));
    }
}
