package com.dbx.agent.db2;

import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.JdbcExecutor;
import com.google.gson.Gson;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Reads a single, tagged DB2 LUW estimated plan on an isolated connection. */
final class Db2ExplainPlan {
    private static final Gson JSON = new Gson();
    private static final int MAX_ROWS = 10_000;
    private static final String[] REQUEST_KEYS = {
        "EXPLAIN_REQUESTER", "EXPLAIN_TIME", "SOURCE_NAME", "SOURCE_SCHEMA",
        "SOURCE_VERSION", "EXPLAIN_LEVEL", "STMTNO", "SECTNO"
    };

    private Db2ExplainPlan() {
    }

    static String read(Connection connection, String sql, String schema, int timeoutSecs, String mode)
        throws SQLException {
        if (mode != null && !mode.isBlank() && !"explain".equalsIgnoreCase(mode)) {
            throw new IllegalArgumentException("DB2 supports estimated execution plans only");
        }
        JdbcExecutor executor = JdbcExecutor.current();
        String source = singleQuery(sql);
        // Do not risk committing or rolling back an existing business transaction.
        if (!connection.getAutoCommit()) {
            throw new IllegalStateException("DB2 execution plans require an isolated connection with autocommit enabled");
        }
        try (var operation = executor.beginNativeOperation()) {
            return readPlan(connection, source, schema, timeoutSecs, executor, operation);
        }
    }

    private static String readPlan(Connection connection, String source, String schema, int timeoutSecs,
        JdbcExecutor executor, JdbcExecutor.NativeOperation operation) throws SQLException {
        String originalSchema = null;
        boolean schemaChanged = false;
        Throwable failure = null;
        connection.setAutoCommit(false);
        try {
            String requester;
            try (var tracked = statement(connection, timeoutSecs, executor, operation);
                 ResultSet rows = tracked.statement().executeQuery("SELECT SESSION_USER, CURRENT SCHEMA FROM SYSIBM.SYSDUMMY1")) {
                if (!rows.next()) {
                    throw new SQLException("DB2 did not return the session authorization ID");
                }
                requester = rows.getString(1).trim();
                originalSchema = rows.getString(2).trim();
            }
            String explainSchema = findExplainSchema(connection, requester, timeoutSecs, executor, operation);
            if (schema != null && !schema.isBlank() && !schema.equals(originalSchema)) {
                // SET SCHEMA is a session register: rollback alone does not restore it.
                schemaChanged = true;
                execute(connection, "SET SCHEMA " + quote(schema), timeoutSecs, executor, operation);
            }
            String tag = UUID.randomUUID().toString().replace("-", "").substring(0, 20);
            execute(connection, "EXPLAIN PLAN SET QUERYTAG = '" + tag + "' FOR " + source, timeoutSecs, executor, operation);
            Map<String, Object> plan = new LinkedHashMap<>();
            plan.put("version", 1);
            plan.put("databaseType", "db2");
            plan.put("requestTag", tag);
            plan.put("statement", readStatement(connection, explainSchema, requester, tag, timeoutSecs, executor, operation));
            plan.put("operators", readRows(connection, explainSchema, "EXPLAIN_OPERATOR",
                "r.OPERATOR_ID, r.OPERATOR_TYPE, r.TOTAL_COST, r.IO_COST, r.CPU_COST, r.FIRST_ROW_COST",
                "r.OPERATOR_ID", requester, tag, timeoutSecs,
                new String[]{"id", "type", "totalCost", "ioCost", "cpuCost", "firstRowCost"}, executor, operation));
            plan.put("streams", readRows(connection, explainSchema, "EXPLAIN_STREAM",
                "r.STREAM_ID, r.SOURCE_TYPE, r.SOURCE_ID, r.TARGET_TYPE, r.TARGET_ID, r.STREAM_COUNT, r.OBJECT_SCHEMA, r.OBJECT_NAME",
                "r.STREAM_ID", requester, tag, timeoutSecs,
                new String[]{"id", "sourceType", "sourceId", "targetType", "targetId", "rowCount", "objectSchema", "objectName"}, executor, operation));
            plan.put("predicates", readRows(connection, explainSchema, "EXPLAIN_PREDICATE",
                "r.OPERATOR_ID, r.PREDICATE_TEXT, r.HOW_APPLIED",
                "r.OPERATOR_ID, r.PREDICATE_ID", requester, tag, timeoutSecs,
                new String[]{"operatorId", "text", "howApplied"}, executor, operation));
            if (((List<?>) plan.get("operators")).isEmpty()) {
                throw new SQLException("DB2 returned no operators for this execution plan");
            }
            return JSON.toJson(plan);
        } catch (SQLException error) {
            SQLException diagnostic = diagnostic(error);
            failure = diagnostic;
            throw diagnostic;
        } catch (RuntimeException | Error error) {
            failure = error;
            throw error;
        } finally {
            SQLException cleanupFailure = null;
            try {
                connection.rollback();
                if (schemaChanged && originalSchema != null) {
                    execute(connection, "SET SCHEMA " + quote(originalSchema), timeoutSecs, executor, null);
                    connection.rollback();
                }
                // Never switch autocommit back on when rollback failed: that could commit Explain rows.
                connection.setAutoCommit(true);
            } catch (SQLException error) {
                cleanupFailure = error;
                try {
                    connection.close();
                } catch (SQLException closeError) {
                    error.addSuppressed(closeError);
                }
            }
            if (cleanupFailure != null) {
                if (failure != null) {
                    failure.addSuppressed(cleanupFailure);
                } else {
                    throw cleanupFailure;
                }
            }
        }
    }

    private static String findExplainSchema(Connection connection, String requester, int timeoutSecs, JdbcExecutor executor, JdbcExecutor.NativeOperation operation)
        throws SQLException {
        String sql = "SELECT TABSCHEMA FROM SYSCAT.TABLES WHERE TABNAME = 'EXPLAIN_INSTANCE' "
            + "AND TABSCHEMA IN (?, 'SYSTOOLS') ORDER BY CASE WHEN TABSCHEMA = ? THEN 0 ELSE 1 END";
        try (var tracked = prepared(connection, sql, timeoutSecs, executor, operation)) {
            PreparedStatement statement = tracked.statement();
            statement.setString(1, requester);
            statement.setString(2, requester);
            operation.checkCancelled();
            try (ResultSet rows = statement.executeQuery()) {
                // SYSCAT.TABLES includes aliases, so qualify reads through the user's aliases.
                if (rows.next()) {
                    return rows.getString(1).trim();
                }
            }
        }
        // Let EXPLAIN produce native SQL0219N when neither location exists, preserving its
        // SQLCODE/SQLSTATE. The diagnostic below adds initialization guidance without fabricating a code.
        return requester;
    }

    private static Map<String, String> readStatement(Connection connection, String schema, String requester,
        String tag, int timeoutSecs, JdbcExecutor executor, JdbcExecutor.NativeOperation operation) throws SQLException {
        String sql = "SELECT " + String.join(", ", REQUEST_KEYS) + " FROM "
            + qualified(schema, "EXPLAIN_STATEMENT") + " WHERE EXPLAIN_REQUESTER = ? AND QUERYTAG = ? AND EXPLAIN_LEVEL = 'P'";
        try (var tracked = prepared(connection, sql, timeoutSecs, executor, operation)) {
            PreparedStatement statement = tracked.statement();
            statement.setString(1, requester);
            statement.setString(2, tag);
            operation.checkCancelled();
            try (ResultSet rows = statement.executeQuery()) {
                if (!rows.next()) {
                    throw new SQLException("DB2 returned no tagged plan-selection statement");
                }
                Map<String, String> result = new LinkedHashMap<>();
                for (int index = 0; index < REQUEST_KEYS.length; index++) {
                    result.put(REQUEST_KEYS[index], rows.getString(index + 1));
                }
                if (rows.next()) {
                    throw new SQLException("DB2 returned multiple statements for one execution plan request");
                }
                return result;
            }
        }
    }

    private static List<Map<String, String>> readRows(Connection connection, String schema, String table,
        String columns, String order, String requester, String tag, int timeoutSecs, String[] fields, JdbcExecutor executor, JdbcExecutor.NativeOperation operation)
        throws SQLException {
        List<String> join = new ArrayList<>();
        for (String key : REQUEST_KEYS) {
            join.add("r." + key + " = s." + key);
        }
        String sql = "SELECT " + columns + " FROM " + qualified(schema, table) + " r JOIN "
            + qualified(schema, "EXPLAIN_STATEMENT") + " s ON " + String.join(" AND ", join)
            + " WHERE s.EXPLAIN_REQUESTER = ? AND s.QUERYTAG = ? AND s.EXPLAIN_LEVEL = 'P' ORDER BY " + order;
        try (var tracked = prepared(connection, sql, timeoutSecs, executor, operation)) {
            PreparedStatement statement = tracked.statement();
            statement.setMaxRows(MAX_ROWS + 1);
            statement.setString(1, requester);
            statement.setString(2, tag);
            operation.checkCancelled();
            try (ResultSet rows = statement.executeQuery()) {
                List<Map<String, String>> result = new ArrayList<>();
                while (rows.next()) {
                    if (result.size() >= MAX_ROWS) {
                        throw new SQLException("DB2 execution plan exceeds the limit of " + MAX_ROWS + " " + table + " rows");
                    }
                    Map<String, String> row = new LinkedHashMap<>();
                    for (int index = 0; index < fields.length; index++) {
                        String value = rows.getString(index + 1);
                        if (value != null) {
                            // Preserve predicate text; CHAR fields and numeric strings have no useful padding.
                            row.put(fields[index], "text".equals(fields[index]) ? value : value.stripTrailing());
                        }
                    }
                    result.add(row);
                }
                return result;
            }
        }
    }

    private static SQLException diagnostic(SQLException error) {
        String hint = "";
        for (SQLException current = error; current != null; current = current.getNextException()) {
            if (current.getErrorCode() == -219) {
                hint = " DB2 Explain tables are missing or incompatible. Ask an administrator to create them for the connecting user with CALL SYSPROC.SYSINSTALLOBJECTS('EXPLAIN', 'C', '', CURRENT USER), or migrate existing Explain tables and grant INSERT/SELECT privileges.";
                break;
            }
            if (current.getErrorCode() == -551 || current.getErrorCode() == -552) {
                hint = " Ask an administrator to grant Explain/object privileges and INSERT/SELECT access to the Explain tables.";
                break;
            }
        }
        if (hint.isEmpty()) {
            return error;
        }
        SQLException result = new SQLException(error.getMessage() + hint, error.getSQLState(), error.getErrorCode(), error);
        result.setNextException(error);
        return result;
    }

    private static JdbcExecutor.TrackedStatement<Statement> statement(Connection connection, int timeoutSecs,
        JdbcExecutor executor, JdbcExecutor.NativeOperation operation) throws SQLException {
        if (operation != null) operation.checkCancelled();
        return configure(executor.trackStatement(connection.createStatement()), timeoutSecs, operation);
    }

    private static JdbcExecutor.TrackedStatement<PreparedStatement> prepared(Connection connection, String sql,
        int timeoutSecs, JdbcExecutor executor, JdbcExecutor.NativeOperation operation) throws SQLException {
        operation.checkCancelled();
        return configure(executor.trackStatement(connection.prepareStatement(sql)), timeoutSecs, operation);
    }

    private static <S extends Statement> JdbcExecutor.TrackedStatement<S> configure(
        JdbcExecutor.TrackedStatement<S> tracked, int timeoutSecs, JdbcExecutor.NativeOperation operation) throws SQLException {
        try {
            if (operation != null) operation.checkCancelled();
            timeout(tracked.statement(), timeoutSecs);
            return tracked;
        } catch (SQLException | RuntimeException error) {
            try {
                tracked.close();
            } catch (SQLException closeError) {
                error.addSuppressed(closeError);
            }
            throw error;
        }
    }
    private static void timeout(Statement statement, int timeoutSecs) throws SQLException {
        if (timeoutSecs >= 0) {
            statement.setQueryTimeout(timeoutSecs);
        }
    }

    private static void execute(Connection connection, String sql, int timeoutSecs, JdbcExecutor executor,
        JdbcExecutor.NativeOperation operation) throws SQLException {
        try (var tracked = statement(connection, timeoutSecs, executor, operation)) {
            if (operation != null) operation.checkCancelled();
            tracked.statement().execute(sql);
        }
    }
    private static String qualified(String schema, String table) {
        return quote(schema) + "." + quote(table);
    }

    private static String quote(String value) {
        return JdbcIdentifiers.INSTANCE.doubleQuote(value);
    }

    /** Rust checks read-only SQL too; this protects direct Agent/RPC callers and trailing terminators. */
    static String singleQuery(String sql) {
        if (sql == null || sql.isBlank()) {
            throw new IllegalArgumentException("DB2 execution plan SQL must not be empty");
        }
        StringBuilder significant = new StringBuilder();
        int terminator = -1;
        for (int index = 0; index < sql.length(); index++) {
            char ch = sql.charAt(index);
            if (Character.isWhitespace(ch)) {
                significant.append(' ');
            } else if (ch == '-' && index + 1 < sql.length() && sql.charAt(index + 1) == '-') {
                index += 2;
                while (index < sql.length() && sql.charAt(index) != '\n' && sql.charAt(index) != '\r') {
                    index++;
                }
                significant.append(' ');
            } else if (ch == '/' && index + 1 < sql.length() && sql.charAt(index + 1) == '*') {
                int depth = 1;
                index += 2;
                while (index < sql.length() && depth > 0) {
                    if (index + 1 < sql.length() && sql.charAt(index) == '/' && sql.charAt(index + 1) == '*') {
                        depth++;
                        index += 2;
                    } else if (index + 1 < sql.length() && sql.charAt(index) == '*' && sql.charAt(index + 1) == '/') {
                        depth--;
                        index += 2;
                    } else {
                        index++;
                    }
                }
                if (depth != 0) {
                    throw new IllegalArgumentException("Unterminated DB2 SQL comment");
                }
                index--;
                significant.append(' ');
            } else {
                if (terminator >= 0) {
                    throw new IllegalArgumentException("DB2 execution plans require a single SQL statement");
                }
                if (ch == ';') {
                    terminator = index;
                } else if (ch == '\'' || ch == '"') {
                    char quote = ch;
                    significant.append(" quoted ");
                    boolean closed = false;
                    while (++index < sql.length()) {
                        if (sql.charAt(index) == quote) {
                            if (index + 1 < sql.length() && sql.charAt(index + 1) == quote) {
                                index++;
                            } else {
                                closed = true;
                                break;
                            }
                        }
                    }
                    if (!closed) {
                        throw new IllegalArgumentException("Unterminated DB2 SQL quoted value");
                    }
                } else {
                    significant.append(ch);
                }
            }
        }
        String code = significant.toString().stripLeading();
        if (!code.matches("(?is)^(SELECT|WITH|VALUES)\\b.*")) {
            throw new IllegalArgumentException("DB2 estimated execution plans accept SELECT, WITH, or VALUES queries");
        }
        // End a possible trailing line comment before SQL assembled around the source can continue.
        return (terminator >= 0 ? sql.substring(0, terminator) : sql).trim() + "\n";
    }
}
