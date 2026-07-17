package com.dbx.agent.neo4j;

import com.dbx.agent.BaseDatabaseAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TransactionExecutor;
import com.dbx.agent.TriggerInfo;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class Neo4jAgent extends BaseDatabaseAgent {
    private Connection connection;

    @Override
    public Connection getConnection() {
        return connection;
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "";
    }

    @Override
    public void connect(ConnectParams params) {
        uncheckedVoid(() -> {
            Class.forName("org.neo4j.jdbc.Neo4jDriver");
            String url = buildNeo4jUrl(params);
            connection = DriverManager.getConnection(url, params.getUsername(), params.getPassword());
        });
    }

    @Override
    public boolean testConnection(ConnectParams params) {
        return unchecked(() -> {
            Class.forName("org.neo4j.jdbc.Neo4jDriver");
            String url = buildNeo4jUrl(params);
            try (Connection conn = DriverManager.getConnection(url, params.getUsername(), params.getPassword())) {
                return conn.isValid(5);
            }
        });
    }

    private static String buildNeo4jUrl(ConnectParams params) {
        StringBuilder url = new StringBuilder();
        url.append("jdbc:neo4j://").append(params.getHost()).append(":").append(params.getPort());
        String database = params.getDatabase();
        if (database != null && !database.trim().isEmpty()) {
            url.append("?database=").append(database.trim());
        }
        return url.toString();
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            Connection conn = requireConnected();
            List<DatabaseInfo> result = new ArrayList<>();
            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery("SHOW DATABASES")) {
                while (rs.next()) {
                    result.add(new DatabaseInfo(rs.getString("name")));
                }
            }
            result.sort(Comparator.comparing(DatabaseInfo::getName));
            return result;
        });
    }

    @Override
    public List<String> listSchemas() {
        return Collections.emptyList();
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return unchecked(() -> {
            Connection conn = requireConnected();
            // Try JDBC metadata first — the driver handles version compatibility.
            List<TableInfo> result = new ArrayList<>();
            DatabaseMetaData meta = conn.getMetaData();
            try (ResultSet rs = meta.getTables(null, blankToNull(schema), "%", new String[]{"TABLE", "VIEW"})) {
                while (rs.next()) {
                    String name = rs.getString("TABLE_NAME");
                    String type = rs.getString("TABLE_TYPE");
                    String comment = getStringOrNull(rs, "REMARKS");
                    if (name != null && !name.isEmpty()) {
                        result.add(new TableInfo(name, type, comment));
                    }
                }
            } catch (Exception ignored) {
                // Fall through to Cypher fallback
            }
            // Fallback: use Cypher for drivers that don't implement getTables().
            if (result.isEmpty()) {
                try (Statement stmt = conn.createStatement();
                     ResultSet rs = stmt.executeQuery("CALL db.labels()")) {
                    while (rs.next()) {
                        String label = getStringOrDefault(rs, "label", "");
                        if (label.isEmpty()) {
                            label = rs.getString(1);
                        }
                        if (label != null && !label.isEmpty()) {
                            result.add(new TableInfo(label, "TABLE", null));
                        }
                    }
                } catch (Exception ignored) {
                    // Cypher fallback also failed
                }
            }
            result.sort(Comparator.comparing(TableInfo::getName));
            return result;
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            Connection conn = requireConnected();
            List<ColumnInfo> result = new ArrayList<>();
            // Try JDBC metadata first.
            DatabaseMetaData meta = conn.getMetaData();
            Set<String> primaryKeys = new LinkedHashSet<>();
            try (ResultSet rs = meta.getPrimaryKeys(null, blankToNull(schema), table)) {
                while (rs.next()) {
                    String pkColumn = rs.getString("COLUMN_NAME");
                    if (pkColumn != null) {
                        primaryKeys.add(pkColumn);
                    }
                }
            } catch (Exception ignored) {
                // Fall through
            }
            try (ResultSet rs = meta.getColumns(null, blankToNull(schema), table, "%")) {
                while (rs.next()) {
                    String name = rs.getString("COLUMN_NAME");
                    if (name == null || name.isEmpty()) {
                        continue;
                    }
                    String type = rs.getString("TYPE_NAME");
                    if (type == null) {
                        type = "Unknown";
                    }
                    boolean nullable = true;
                    try {
                        nullable = "YES".equals(rs.getString("IS_NULLABLE"));
                    } catch (Exception ignored) {
                        // keep default
                    }
                    String defaultValue = getStringOrNull(rs, "COLUMN_DEF");
                    String comment = getStringOrNull(rs, "REMARKS");
                    result.add(new ColumnInfo(
                        name, type, nullable, defaultValue,
                        primaryKeys.contains(name),
                        comment, null, null, null, null
                    ));
                }
            } catch (Exception ignored) {
                // Fall through to Cypher fallback
            }
            // Fallback: use Cypher for drivers that don't implement getColumns().
            if (result.isEmpty()) {
                try (Statement stmt = conn.createStatement();
                     ResultSet rs = stmt.executeQuery("CALL db.schema.nodeTypeProperties()")) {
                    while (rs.next()) {
                        String nodeLabels = rs.getString("nodeLabels");
                        if (nodeLabels == null) {
                            nodeLabels = "";
                        }
                        if (!nodeLabels.contains(table)) {
                            continue;
                        }
                        String propertyName = rs.getString("propertyName");
                        if (propertyName == null) {
                            continue;
                        }
                        String propertyTypes = rs.getString("propertyTypes");
                        if (propertyTypes == null) {
                            propertyTypes = "Unknown";
                        }
                        boolean isNullable;
                        try {
                            isNullable = !rs.getBoolean("mandatory");
                        } catch (Exception ignored) {
                            isNullable = true;
                        }
                        result.add(new ColumnInfo(
                            propertyName, propertyTypes, isNullable,
                            null, false, null, null, null, null, null
                        ));
                    }
                } catch (Exception ignored) {
                    // Cypher fallback also failed
                }
            }
            result.sort(Comparator.comparing(ColumnInfo::getName));
            return result;
        });
    }

    private static String blankToNull(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return unchecked(() -> {
            Connection conn = requireConnected();
            List<IndexInfo> result = new ArrayList<>();
            try (Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery("SHOW INDEXES")) {
                while (rs.next()) {
                    String labelsOrTypes = getStringOrDefault(rs, "labelsOrTypes", "");
                    if (!labelsOrTypes.contains(table)) {
                        continue;
                    }

                    String properties = getStringOrDefault(rs, "properties", "");
                    String uniqueness = getStringOrDefault(rs, "uniqueness", "");
                    result.add(new IndexInfo(
                        getStringOrDefault(rs, "name", ""),
                        parseProperties(properties),
                        "UNIQUE".equals(uniqueness.toUpperCase(Locale.ROOT)),
                        false,
                        null,
                        getStringOrNull(rs, "type"),
                        null,
                        null
                    ));
                }
            }
            result.sort(Comparator.comparing(IndexInfo::getName));
            return result;
        });
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return Collections.emptyList();
    }

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        return Collections.emptyList();
    }

    @Override
    public QueryResult executeTransaction(List<String> statements, String schema) {
        return TransactionExecutor.executeStatements(requireConnected(), statements, schema, this::setSchemaSQL, (stmt, sql) -> {
            stmt.execute(sql);
            return Math.max(stmt.getUpdateCount(), 0);
        });
    }

    public QueryResult executeQuery(String sql, String schema) {
        return executeQuery(sql, schema, new ExecuteQueryOptions());
    }

    @Override
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        return JdbcExecutor.current().execute(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            options.getMaxRows(),
            options.getFetchSize(),
            options.getTimeoutSecs(),
            this::stringResultValue
        );
    }

    @Override
    public void disconnect() {
        uncheckedVoid(() -> {
            if (connection != null) {
                connection.close();
            }
            connection = null;
        });
    }

    private Object stringResultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
            Object value = rs.getObject(index);
            return rs.wasNull() ? null : value == null ? null : value.toString();
        });
    }

    private static List<String> parseProperties(String properties) {
        String trimmed = properties;
        if (trimmed.startsWith("[") && trimmed.endsWith("]") && trimmed.length() >= 2) {
            trimmed = trimmed.substring(1, trimmed.length() - 1);
        }

        List<String> result = new ArrayList<>();
        for (String property : trimmed.split(",")) {
            String value = property.trim();
            if (value.startsWith("\"") && value.endsWith("\"") && value.length() >= 2) {
                value = value.substring(1, value.length() - 1);
            }
            if (!value.isEmpty()) {
                result.add(value);
            }
        }
        return result;
    }

    private static String getStringOrDefault(ResultSet rs, String column, String defaultValue) {
        try {
            String value = rs.getString(column);
            return value == null ? defaultValue : value;
        } catch (Exception ignored) {
            return defaultValue;
        }
    }

    private static String getStringOrNull(ResultSet rs, String column) {
        try {
            return rs.getString(column);
        } catch (Exception ignored) {
            return null;
        }
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(Neo4jAgent::new).run();
    }
}
