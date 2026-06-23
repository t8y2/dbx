package com.dbx.agent;

import java.sql.Connection;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public interface DatabaseAgent {
    void connect(ConnectParams params);

    boolean testConnection(ConnectParams params);

    List<DatabaseInfo> listDatabases();

    List<String> listSchemas();

    List<TableInfo> listTables(String schema);

    default List<ObjectInfo> listObjects(String schema) {
        List<ObjectInfo> result = new ArrayList<>();
        for (TableInfo table : listTables(schema)) {
            result.add(new ObjectInfo(table.getName(), table.getTable_type(), schema, table.getComment()));
        }
        return result;
    }

    default CompletionAssistantResponse completionAssistantSearch(CompletionAssistantRequest request) {
        throw new UnsupportedOperationException("Completion assistant search is not supported by this agent");
    }

    List<ColumnInfo> getColumns(String schema, String table);

    default ObjectSource getObjectSource(String schema, String name, String objectType) {
        throw new UnsupportedOperationException("Object source is not supported");
    }

    default String getTableDdl(String schema, String table) {
        List<IndexInfo> indexes;
        try {
            indexes = listIndexes(schema, table);
        } catch (RuntimeException e) {
            indexes = Collections.emptyList();
        }

        List<ForeignKeyInfo> foreignKeys;
        try {
            foreignKeys = listForeignKeys(schema, table);
        } catch (RuntimeException e) {
            foreignKeys = Collections.emptyList();
        }

        return buildTableDdl(schema, table, getColumns(schema, table), indexes, foreignKeys);
    }

    List<IndexInfo> listIndexes(String schema, String table);

    List<ForeignKeyInfo> listForeignKeys(String schema, String table);

    List<TriggerInfo> listTriggers(String schema, String table);

    default QueryResult executeQuery(String sql, String schema) {
        return executeQuery(sql, schema, new ExecuteQueryOptions());
    }

    QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options);

    default QueryPageResult executeQueryPage(String sql, String schema) {
        return executeQueryPage(sql, schema, new QueryPageOptions());
    }

    default QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        Connection conn = getConnection();
        if (conn == null) {
            throw new IllegalStateException("Not connected");
        }
        return JdbcExecutor.INSTANCE.executePage(
            conn,
            sql,
            schema,
            this::setSchemaSQL,
            options,
            JdbcExecutor.INSTANCE::defaultResultValue
        );
    }

    default QueryPageResult fetchQueryPage(String sessionId, int pageSize) {
        return JdbcExecutor.INSTANCE.fetchPage(sessionId, pageSize);
    }

    default boolean closeQuerySession(String sessionId) {
        return JdbcExecutor.INSTANCE.closeQuerySession(sessionId);
    }

    /**
     * Get DM execution plan. Supports two modes:
     *   mode="explain" (default) — direct plan, no execution
     *   mode="autotrace"         — enable MONITOR_SQL_EXEC, execute SQL, then get plan with actual stats
     * @return plan text
     */
    default String getExplainInfo(String sql, String database, String schema, int timeoutSecs, String mode) {
        throw new UnsupportedOperationException("getExplainInfo is not supported by this agent");
    }

    void disconnect();

    Connection getConnection();

    default QueryResult executeTransaction(List<String> statements, String schema) {
        Connection conn = getConnection();
        if (conn == null) {
            throw new IllegalStateException("Not connected");
        }
        return TransactionExecutor.executeUpdateStatements(conn, statements, schema, this::setSchemaSQL);
    }

    default String setSchemaSQL(String schema) {
        return "SET SCHEMA " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    static String buildTableDdl(
        String schema,
        String table,
        List<ColumnInfo> columns,
        List<IndexInfo> indexes,
        List<ForeignKeyInfo> foreignKeys
    ) {
        return DdlBuilder.buildTableDdl(schema, table, columns, indexes, foreignKeys);
    }

    static String trimSql(String sql) {
        String trimmed = sql.trim();
        while (trimmed.endsWith(";")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1).trim();
        }
        return trimmed;
    }

    static <T> T unchecked(ThrowingSupplier<T> supplier) {
        try {
            return supplier.get();
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    interface ThrowingSupplier<T> {
        T get() throws Exception;
    }
}
