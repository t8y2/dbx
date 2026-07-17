package com.dbx.agent.cassandra;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class CassandraAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new CassandraAgent();
    }

    @Override
    protected String resultSetSql() {
        return "LIST ROLES";
    }

    @Test
    void buildsServerUrlWhenKeyspaceIsEmpty() {
        ConnectParams params = new ConnectParams("127.0.0.1", 9042, "", "cassandra", "cassandra", "", "", false);

        assertEquals("jdbc:cassandra://127.0.0.1:9042", CassandraAgent.buildUrl(params));
    }

    @Test
    void buildsKeyspaceUrlWhenKeyspaceIsSet() {
        ConnectParams params = new ConnectParams("127.0.0.1", 9042, "app_keyspace", "cassandra", "cassandra", "", "", false);

        assertEquals("jdbc:cassandra://127.0.0.1:9042/app_keyspace", CassandraAgent.buildUrl(params));
    }

    @Test
    void appendsUrlParamsForMultiDcLocalDatacenter() {
        ConnectParams params = new ConnectParams(
            "127.0.0.1", 9042, "app_keyspace", "cassandra", "cassandra", "localdatacenter=dc1", "", false
        );

        assertEquals("jdbc:cassandra://127.0.0.1:9042/app_keyspace?localdatacenter=dc1", CassandraAgent.buildUrl(params));
    }

    @Test
    void stripsLeadingQuestionMarkFromUrlParams() {
        ConnectParams params = new ConnectParams(
            "127.0.0.1", 9042, "", "cassandra", "cassandra", "?localdatacenter=dc1", "", false
        );

        assertEquals("jdbc:cassandra://127.0.0.1:9042?localdatacenter=dc1", CassandraAgent.buildUrl(params));
    }
}
