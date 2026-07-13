package com.dbx.agent;

import java.sql.Connection;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public abstract class BaseDatabaseAgent implements DatabaseAgent {
    @Override
    public List<ObjectInfo> listObjects(String schema) {
        List<ObjectInfo> result = new ArrayList<>();
        for (TableInfo table : listTables(schema)) {
            result.add(new ObjectInfo(table.getName(), table.getTable_type(), schema, table.getComment()));
        }
        return result;
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        throw new UnsupportedOperationException("Object source is not supported");
    }

    @Override
    public CompletionAssistantResponse completionAssistantSearch(CompletionAssistantRequest request) {
        throw new UnsupportedOperationException("Completion assistant search is not supported by this agent");
    }

    @Override
    public String getTableDdl(String schema, String table) {
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

    @Override
    public QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        Connection conn = requireConnected();
        return JdbcExecutor.current().executePage(
            conn,
            sql,
            schema,
            this::setSchemaSQL,
            options,
            JdbcExecutor.current()::defaultResultValue
        );
    }

    @Override
    public QueryPageResult fetchQueryPage(String sessionId, int pageSize) {
        return JdbcExecutor.current().fetchPage(sessionId, pageSize);
    }

    @Override
    public boolean closeQuerySession(String sessionId) {
        return JdbcExecutor.current().closeQuerySession(sessionId);
    }

    @Override
    public QueryPageResult startTableRead(String sql, String schema, QueryPageOptions options) {
        return JdbcExecutor.current().startTableRead(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            options,
            JdbcExecutor.current()::defaultResultValue
        );
    }

    @Override
    public QueryPageResult fetchTableReadPage(String sessionId, int pageSize) {
        return JdbcExecutor.current().fetchTableReadPage(sessionId, pageSize);
    }

    @Override
    public boolean closeTableReadSession(String sessionId) {
        return JdbcExecutor.current().closeTableReadSession(sessionId);
    }

    @Override
    public QueryResult executeTransaction(List<String> statements, String schema) {
        return TransactionExecutor.executeUpdateStatements(requireConnected(), statements, schema, this::setSchemaSQL);
    }

    @Override
    public QueryResult executeBatch(List<String> statements, String schema) {
        return BatchExecutor.executeBatchStatements(requireConnected(), statements, schema, this::setSchemaSQL);
    }

    protected Connection requireConnected() {
        Connection conn = getConnection();
        if (conn == null) {
            throw new IllegalStateException("Not connected");
        }
        return conn;
    }

    protected static <T> T unchecked(ThrowingSupplier<T> supplier) {
        try {
            return supplier.get();
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    protected static void uncheckedVoid(ThrowingRunnable runnable) {
        unchecked(() -> {
            runnable.run();
            return null;
        });
    }

    protected interface ThrowingSupplier<T> {
        T get() throws Exception;
    }

    protected interface ThrowingRunnable {
        void run() throws Exception;
    }
}
