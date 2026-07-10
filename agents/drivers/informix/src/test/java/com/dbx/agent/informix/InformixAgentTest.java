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
        String url = InformixAgent.buildJdbcUrl(
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
        String url = InformixAgent.buildJdbcUrl(
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
        String url = InformixAgent.buildJdbcUrl(
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

        String url = InformixAgent.buildJdbcUrl(params);

        Assertions.assertEquals(
            "jdbc:informix-sqli://172.26.128.159:20013/testdb:INFORMIXSERVER=ol_informix1410;CLIENT_LOCALE=en_US.utf8;DB_LOCALE=en_US.utf8",
            url
        );
    }

    @Test
    void usesSysmasterWhenDatabaseIsBlank() {
        String url = InformixAgent.buildJdbcUrl(
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
    void constrainedTableMetadataUsesInformixSkipFirstPushdown() {
        InformixAgent agent = new InformixAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTables("stores", new MetadataListConstraints("ord", 25, 50, List.of("TABLE")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.startsWith("SELECT SKIP 50 FIRST 25 tabname"), sql);
        Assertions.assertTrue(sql.contains("tabtype IN ('T')"), sql);
        Assertions.assertTrue(sql.contains("UPPER(tabname) LIKE ? ESCAPE '\\\\'"), sql);
        Assertions.assertTrue(sql.endsWith("ORDER BY tabname"), sql);
    }

    @Test
    void constrainedObjectMetadataUsesInformixUnionPushdown() {
        InformixAgent agent = new InformixAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listObjects("stores", new MetadataListConstraints("sync", 10, null, List.of("PROCEDURE", "FUNCTION")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.startsWith("SELECT FIRST 10 object_name, object_type FROM ("), sql);
        Assertions.assertTrue(sql.contains("FROM sysprocedures"), sql);
        Assertions.assertTrue(sql.contains("isproc = 'f'"), sql);
        Assertions.assertTrue(sql.contains("isproc = 't'"), sql);
        Assertions.assertTrue(sql.endsWith("ORDER BY object_order, object_name"), sql);
    }
}
