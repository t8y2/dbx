package com.dbx.agent.ignite3;

import com.dbx.agent.AbstractJdbcAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.sql.Connection;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Properties;
import java.util.Set;

public final class Ignite3Agent extends AbstractJdbcAgent {

    private static final String JDBC_USERNAME_PROPERTY = "ignite.jdbc.username";
    private static final String JDBC_PASSWORD_PROPERTY = "ignite.jdbc.password";

    private String databaseName = "";

    @Override
    protected String driverClass() {
        return "org.apache.ignite.jdbc.IgniteJdbcDriver";
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return buildUrl(params);
    }

    @Override
    protected Properties buildConnectionProperties(ConnectParams params) {
        Properties properties = new Properties();
        String username = params.getUsername();
        String password = params.getPassword();
        if ((username != null && !username.isEmpty()) || (password != null && !password.isEmpty())) {
            properties.setProperty(JDBC_USERNAME_PROPERTY, username == null ? "" : username);
            properties.setProperty(JDBC_PASSWORD_PROPERTY, password == null ? "" : password);
        }
        return properties;
    }

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) {
        // Ignite has no catalogs; name the virtual database after the connection's
        // real default schema (e.g. PUBLIC) so any database-as-schema context that
        // leaks into setSchema targets a schema that actually exists.
        try {
            String schema = connection.getSchema();
            databaseName = schema == null || schema.isBlank() ? params.getDatabase() : schema;
        } catch (Exception e) {
            databaseName = params.getDatabase();
        }
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        // Ignite has no catalogs; expose the connected schema group as a single
        // virtual database so the object browser stays schema-oriented like H2.
        return List.of(new DatabaseInfo(databaseName.isBlank() ? "default" : databaseName));
    }

    @Override
    public List<String> listSchemas() {
        return unchecked(() -> {
            List<String> result = new ArrayList<>();
            try (ResultSet rs = requireConnected().getMetaData().getSchemas()) {
                while (rs.next()) {
                    result.add(rs.getString("TABLE_SCHEM"));
                }
            }
            result.sort(Comparator.naturalOrder());
            return result;
        });
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            try (ResultSet rs = requireConnected().getMetaData().getTables(null, schema, null, null)) {
                while (rs.next()) {
                    result.add(new TableInfo(
                        rs.getString("TABLE_NAME"),
                        normalizeTableType(rs.getString("TABLE_TYPE")),
                        null
                    ));
                }
            }
            result.sort(Comparator.comparing(TableInfo::getName));
            return result;
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            Set<String> primaryKeys = new LinkedHashSet<>();
            try (ResultSet rs = requireConnected().getMetaData().getPrimaryKeys(null, schema, table)) {
                while (rs.next()) {
                    primaryKeys.add(rs.getString("COLUMN_NAME"));
                }
            }

            List<ColumnInfo> result = new ArrayList<>();
            try (ResultSet rs = requireConnected().getMetaData().getColumns(null, schema, table, null)) {
                while (rs.next()) {
                    String colName = rs.getString("COLUMN_NAME");
                    result.add(new ColumnInfo(
                        colName,
                        rs.getString("TYPE_NAME"),
                        "YES".equals(rs.getString("IS_NULLABLE")),
                        rs.getString("COLUMN_DEF"),
                        primaryKeys.contains(colName),
                        null,
                        emptyToNull(rs.getString("REMARKS")),
                        intOrNull(rs, "COLUMN_SIZE"),
                        intOrNull(rs, "DECIMAL_DIGITS"),
                        null
                    ));
                }
            }
            return result;
        });
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return Collections.emptyList();
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
    public String setSchemaSQL(String schema) {
        // JdbcConnection implements Connection.setSchema, so no SQL switch is needed.
        return "";
    }

    static String buildUrl(ConnectParams params) {
        String connectionString = params.getConnection_string();
        if (connectionString != null && !connectionString.trim().isEmpty()) {
            return connectionString.trim();
        }
        String base = "jdbc:ignite:thin://" + params.getHost() + ":" + params.getPort();
        String database = params.getDatabase();
        String url = database == null || database.isBlank() ? base : base + "/" + database;
        // Reuse the shared JDBC URL parameter mapping so advanced options
        // (timeouts, SSL, authentication) configured in the UI reach the driver.
        return JdbcAgentProfile.appendUrlParams(url, params.getUrl_params());
    }

    private static String normalizeTableType(String type) {
        if ("BASE TABLE".equals(type)) {
            return "TABLE";
        }
        return type;
    }

    private static Integer intOrNull(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value instanceof Number ? ((Number) value).intValue() : null;
    }

    private static String emptyToNull(String value) {
        return value == null || value.isEmpty() ? null : value;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(Ignite3Agent::new).run();
    }
}
