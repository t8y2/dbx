package com.dbx.agent.test;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.TableInfo;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

public abstract class JdbcMetadataBehaviorTest extends JdbcConnectedAgentTest {
    protected abstract List<String> metadataFixtureSql();

    protected abstract String metadataSchema();

    protected abstract List<String> expectedTablesInOrder();

    protected abstract String metadataColumnsTable();

    protected abstract List<String> expectedColumnsInOrder();

    @Test
    void returnsMetadataInStableOrder() {
        withAgent("dbx-agent-metadata", agent -> {
            for (String sql : metadataFixtureSql()) {
                agent.executeQuery(sql, metadataSchema(), new com.dbx.agent.ExecuteQueryOptions());
            }

            List<String> expectedTables = expectedTablesInOrder();
            List<String> tableNames = new ArrayList<String>();
            for (TableInfo table : agent.listTables(metadataSchema())) {
                if (expectedTables.contains(table.getName())) {
                    tableNames.add(table.getName());
                }
            }
            assertEquals(expectedTables, tableNames);

            List<String> expectedColumns = expectedColumnsInOrder();
            List<String> columnNames = new ArrayList<String>();
            for (ColumnInfo column : agent.getColumns(metadataSchema(), metadataColumnsTable())) {
                if (expectedColumns.contains(column.getName())) {
                    columnNames.add(column.getName());
                }
            }
            assertEquals(expectedColumns, columnNames);
        });
    }

    @Test
    void buildsTableDdlFromMetadata() {
        withAgent("dbx-agent-ddl", agent -> {
            for (String sql : metadataFixtureSql()) {
                agent.executeQuery(sql, metadataSchema(), new com.dbx.agent.ExecuteQueryOptions());
            }

            String ddl = agent.getTableDdl(metadataSchema(), metadataColumnsTable());

            for (String column : expectedColumnsInOrder()) {
                assertTrue(ddl.contains("\"" + column + "\""), "DDL should include column " + column + ": " + ddl);
            }
            assertTrue(ddl.contains("CREATE TABLE"), "DDL should include CREATE TABLE: " + ddl);
            assertTrue(ddl.contains(metadataColumnsTable()), "DDL should include table name: " + ddl);
        });
    }
}
