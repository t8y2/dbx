package com.dbx.agent.trino;

import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.test.JdbcFakeExecutionBehaviorTest;
import com.dbx.agent.test.JdbcMetadataSqlFake;
import com.dbx.agent.test.TestSupport;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

import java.util.List;

class TrinoAgentTest extends JdbcFakeExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createAgent() {
        return new TrinoAgent();
    }

    @Override
    protected String resultSetSql() {
        return "CALL system.runtime.nodes()";
    }

    @Test
    void constrainedTableMetadataPushesFilterTypesAndPaging() {
        TrinoAgent agent = new TrinoAgent();
        TestSupport.setPrivateConnection(agent, JdbcMetadataSqlFake.connection());

        agent.listTables("public", new MetadataListConstraints("ord", 25, 50, List.of("TABLE", "VIEW")));

        String sql = JdbcMetadataSqlFake.statements.get(0);
        Assertions.assertTrue(sql.contains("FROM information_schema.tables"), sql);
        Assertions.assertTrue(sql.contains("table_type IN (?, ?)"), sql);
        Assertions.assertTrue(sql.contains("UPPER(table_name) LIKE ? ESCAPE '\\\\'"), sql);
        Assertions.assertTrue(sql.endsWith("LIMIT 25 OFFSET 50"), sql);
    }
}
