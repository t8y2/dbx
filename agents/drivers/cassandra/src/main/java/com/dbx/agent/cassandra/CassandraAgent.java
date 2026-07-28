package com.dbx.agent.cassandra;

import com.dbx.agent.AbstractJdbcAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class CassandraAgent extends AbstractJdbcAgent {
    private static final Pattern TARGET_PATTERN = Pattern.compile("target[\"']?\\s*[:=]\\s*[\"']?([\\w]+)");

    @Override
    protected String driverClass() {
        return "com.ing.data.cassandra.jdbc.CassandraDriver";
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return buildUrl(params);
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "USE " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            List<DatabaseInfo> result = new ArrayList<>();
            String sql = "SELECT keyspace_name FROM system_schema.keyspaces";
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery(sql)) {
                while (rs.next()) {
                    result.add(new DatabaseInfo(rs.getString(1)));
                }
            }
            result.sort(Comparator.comparing(DatabaseInfo::getName));
            return result;
        });
    }

    @Override
    public List<String> listSchemas() {
        List<String> result = new ArrayList<>();
        for (DatabaseInfo database : listDatabases()) {
            result.add(database.getName());
        }
        return result;
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            String sql = "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(rs.getString(1), "TABLE", null));
                    }
                }
            }
            result.sort(Comparator.comparing(TableInfo::getName));
            return result;
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            List<ColumnInfo> result = new ArrayList<>();
            String sql = "SELECT column_name, type, kind FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String kind = coalesce(rs.getString("kind"));
                        boolean isPrimaryKey = "partition_key".equals(kind) || "clustering".equals(kind);
                        result.add(new ColumnInfo(
                            rs.getString("column_name"),
                            coalesce(rs.getString("type"), "unknown"),
                            !isPrimaryKey,
                            null,
                            isPrimaryKey,
                            kind.trim().isEmpty() ? null : kind,
                            null,
                            null,
                            null,
                            null
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return unchecked(() -> {
            List<IndexInfo> result = new ArrayList<>();
            String sql = "SELECT index_name, options FROM system_schema.indexes WHERE keyspace_name = ? AND table_name = ?";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String indexName = coalesce(rs.getString("index_name"));
                        String options = coalesce(rs.getString("options"));
                        result.add(new IndexInfo(
                            indexName,
                            targetColumns(options),
                            false,
                            false,
                            null,
                            null,
                            null,
                            null
                        ));
                    }
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
    protected Object resultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
            Object value = rs.getObject(index);
            return rs.wasNull() ? null : value == null ? null : value.toString();
        });
    }

    static String buildUrl(ConnectParams params) {
        String baseUrl = "jdbc:cassandra://" + params.getHost() + ":" + params.getPort();
        String keyspace = coalesce(params.getDatabase()).trim();
        // Cassandra rejects an empty keyspace path; omit it so DBX can connect first and list keyspaces.
        String url = keyspace.isEmpty() ? baseUrl : baseUrl + "/" + keyspace;
        // Multi-DC clusters require localdatacenter=<dc>
        String extraParams = coalesce(params.getUrl_params()).trim();
        while (extraParams.startsWith("?") || extraParams.startsWith("&")) {
            extraParams = extraParams.substring(1);
        }
        return extraParams.isEmpty() ? url : url + "?" + extraParams;
    }

    private static List<String> targetColumns(String options) {
        Matcher matcher = TARGET_PATTERN.matcher(options);
        if (!matcher.find()) {
            return Collections.emptyList();
        }
        return Collections.singletonList(matcher.group(1));
    }

    private static String coalesce(String value) {
        return value == null ? "" : value;
    }

    private static String coalesce(String value, String fallback) {
        return value == null ? fallback : value;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(CassandraAgent::new).run();
    }
}
