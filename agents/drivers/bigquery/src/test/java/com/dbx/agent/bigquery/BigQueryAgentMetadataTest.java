package com.dbx.agent.bigquery;

import com.dbx.agent.test.TestSupport;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.test.JdbcAgentFake;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import java.sql.Connection;
import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class BigQueryAgentMetadataTest {
    @Test
    void quotesSchemaIdentifiersInMetadataSql() {
        BigQueryAgent agent = new BigQueryAgent();
        Connection fake = JdbcMetadataSqlFake.connection();
        TestSupport.setPrivateConnection(agent, fake);

        agent.listTables("bad`schema");
        agent.getColumns("bad`schema", "sample");

        Assertions.assertTrue(
            JdbcMetadataSqlFake.statements.stream()
                .anyMatch(statement -> statement.contains("FROM `bad``schema`.INFORMATION_SCHEMA.TABLES"))
        );
        Assertions.assertTrue(
            JdbcMetadataSqlFake.statements.stream()
                .anyMatch(statement -> statement.contains("FROM `bad``schema`.INFORMATION_SCHEMA.COLUMNS"))
        );
    }

    @Test
    void buildUrlAppendsAuthenticationUrlParams() {
        ConnectParams params = new ConnectParams(
            "https://www.googleapis.com/bigquery/v2",
            443,
            "demo-project",
            "",
            "",
            "OAuthType=0;OAuthServiceAcctEmail=svc@demo.iam.gserviceaccount.com;OAuthPvtKeyPath=C:\\keys\\demo.json",
            "",
            false
        );

        Assertions.assertEquals(
            "jdbc:bigquery://https://www.googleapis.com/bigquery/v2:443;ProjectId=demo-project;OAuthType=0;OAuthServiceAcctEmail=svc@demo.iam.gserviceaccount.com;OAuthPvtKeyPath=C:\\keys\\demo.json",
            BigQueryAgent.buildUrl(params)
        );
    }

    @Test
    void constrainedTableMetadataPushesFilterTypesAndPaging() {
        BigQueryAgent agent = new BigQueryAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTables("demo`dataset", new MetadataListConstraints("ord", 25, 50, List.of("TABLE", "VIEW")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.contains("FROM `demo``dataset`.INFORMATION_SCHEMA.TABLES"), sql);
        Assertions.assertTrue(sql.contains("table_type IN (?, ?)"), sql);
        Assertions.assertTrue(sql.contains("UPPER(table_name) LIKE ?"), sql);
        Assertions.assertTrue(sql.endsWith("LIMIT 25 OFFSET 50"), sql);
    }
}
