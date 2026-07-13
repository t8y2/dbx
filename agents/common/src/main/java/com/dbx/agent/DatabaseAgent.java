package com.dbx.agent;

import java.sql.Connection;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

public interface DatabaseAgent {
    void connect(ConnectParams params);

    boolean testConnection(ConnectParams params);

    default String getIdentifierQuote() {
        return "";
    }

    List<DatabaseInfo> listDatabases();

    List<String> listSchemas();

    default List<String> listSchemas(List<String> visibleSchemas) {
        if (visibleSchemas == null) {
            return listSchemas();
        }
        Set<String> visible = new HashSet<>(visibleSchemas);
        return listSchemas().stream().filter(visible::contains).collect(Collectors.toList());
    }

    List<TableInfo> listTables(String schema);

    default List<TableInfo> listTables(String schema, List<String> objectTypes) {
        return listTables(schema);
    }

    default List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        // Keep old driver overrides for object type filtering, then apply the new optional constraints locally.
        return normalized.filterTables(listTables(schema, normalized.getObjectTypes()));
    }

    default List<ObjectInfo> listObjects(String schema) {
        List<ObjectInfo> result = new ArrayList<>();
        for (TableInfo table : listTables(schema)) {
            result.add(new ObjectInfo(table.getName(), table.getTable_type(), schema, table.getComment()));
        }
        return result;
    }

    default List<ObjectInfo> listObjects(String schema, MetadataListConstraints constraints) {
        return MetadataListConstraints.orNone(constraints).filterObjects(listObjects(schema));
    }

    default List<String> listDataTypes() {
        return Collections.emptyList();
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

        String tableComment = null;
        try {
            tableComment = getTableComment(schema, table);
        } catch (RuntimeException e) {
            // Table comment is optional; DDL generation should still succeed without it.
        }

        return DdlBuilder.buildTableDdl(schema, table, getColumns(schema, table), indexes, foreignKeys, Collections.emptyList(), false, false, tableComment);
    }

    /**
     * Returns the comment/description for a table, or null if not available.
     * Default implementation looks up the comment from listTables results.
     * Subclasses can override for more efficient queries.
     */
    default String getTableComment(String schema, String table) {
        try {
            String caseInsensitiveComment = null;
            int caseInsensitiveMatches = 0;
            for (TableInfo info : listTables(schema)) {
                if (!info.getName().equalsIgnoreCase(table)) {
                    continue;
                }
                if (info.getName().equals(table)) {
                    return nonBlankComment(info.getComment());
                }
                caseInsensitiveMatches++;
                caseInsensitiveComment = nonBlankComment(info.getComment());
            }
            // Case-insensitive databases may normalize metadata names, but quoted
            // mixed-case objects must never borrow a sibling table's comment.
            if (caseInsensitiveMatches == 1) {
                return caseInsensitiveComment;
            }
        } catch (RuntimeException e) {
            // Ignore; table comment is optional.
        }
        return null;
    }

    static String nonBlankComment(String comment) {
        if (comment != null && !comment.trim().isEmpty()) {
            return comment;
        }
        return null;
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
        return AgentExecutionContext.jdbcExecutor().executePage(
            conn,
            sql,
            schema,
            this::setSchemaSQL,
            options,
            AgentExecutionContext.jdbcExecutor()::defaultResultValue
        );
    }

    default QueryPageResult fetchQueryPage(String sessionId, int pageSize) {
        return AgentExecutionContext.jdbcExecutor().fetchPage(sessionId, pageSize);
    }

    default boolean closeQuerySession(String sessionId) {
        return AgentExecutionContext.jdbcExecutor().closeQuerySession(sessionId);
    }

    default QueryPageResult startTableRead(String sql, String schema, QueryPageOptions options) {
        Connection conn = getConnection();
        if (conn == null) {
            throw new IllegalStateException("Not connected");
        }
        return AgentExecutionContext.jdbcExecutor().startTableRead(
            conn,
            sql,
            schema,
            this::setSchemaSQL,
            options,
            AgentExecutionContext.jdbcExecutor()::defaultResultValue
        );
    }

    default QueryPageResult fetchTableReadPage(String sessionId, int pageSize) {
        return AgentExecutionContext.jdbcExecutor().fetchTableReadPage(sessionId, pageSize);
    }

    default boolean closeTableReadSession(String sessionId) {
        return AgentExecutionContext.jdbcExecutor().closeTableReadSession(sessionId);
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

    default QueryResult executeBatch(List<String> statements, String schema) {
        Connection conn = getConnection();
        if (conn == null) {
            throw new IllegalStateException("Not connected");
        }
        return BatchExecutor.executeBatchStatements(conn, statements, schema, this::setSchemaSQL);
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
