package com.dbx.agent.ignite;

import com.dbx.agent.AbstractJdbcAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class IgniteAgent extends AbstractJdbcAgent {

    private String databaseName = "";

    @Override
    protected String driverClass() {
        return "org.apache.ignite.IgniteJdbcThinDriver";
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return buildUrl(params);
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
        return unchecked(() -> {
            DatabaseMetaData metadata = requireConnected().getMetaData();
            Set<String> primaryIndexNames = new LinkedHashSet<>();
            List<IndexColumn> primaryColumns = new ArrayList<>();
            try (ResultSet rs = metadata.getPrimaryKeys(null, schema, table)) {
                while (rs.next()) {
                    String name = rs.getString("PK_NAME");
                    if (name != null && !name.isBlank()) {
                        primaryIndexNames.add(name);
                    }
                    String column = rs.getString("COLUMN_NAME");
                    if (column != null && !column.isBlank()) {
                        primaryColumns.add(new IndexColumn(rs.getShort("KEY_SEQ"), column));
                    }
                }
            }

            List<IndexRow> rows = new ArrayList<>();
            try (ResultSet rs = metadata.getIndexInfo(null, schema, table, false, false)) {
                while (rs.next()) {
                    if (rs.getShort("TYPE") == DatabaseMetaData.tableIndexStatistic) {
                        continue;
                    }
                    String name = rs.getString("INDEX_NAME");
                    String column = rs.getString("COLUMN_NAME");
                    if (name == null || name.isBlank() || column == null || column.isBlank()) {
                        continue;
                    }
                    rows.add(new IndexRow(
                        name,
                        column,
                        rs.getShort("ORDINAL_POSITION"),
                        !rs.getBoolean("NON_UNIQUE"),
                        indexType(rs.getShort("TYPE"))
                    ));
                }
            }
            return assembleIndexes(rows, primaryIndexNames, primaryColumns);
        });
    }

    static List<IndexInfo> assembleIndexes(
        List<IndexRow> rows,
        Set<String> primaryIndexNames,
        List<IndexColumn> primaryColumns
    ) {
        Map<String, List<IndexRow>> grouped = new LinkedHashMap<>();
        for (IndexRow row : rows) {
            grouped.computeIfAbsent(row.name, ignored -> new ArrayList<>()).add(row);
        }
        List<IndexColumn> orderedPrimary = new ArrayList<>(primaryColumns);
        orderedPrimary.sort(Comparator.comparingInt(column -> column.ordinal));
        List<String> orderedPrimaryColumns = new ArrayList<>();
        for (IndexColumn column : orderedPrimary) {
            orderedPrimaryColumns.add(column.name);
        }

        List<IndexInfo> result = new ArrayList<>();
        for (Map.Entry<String, List<IndexRow>> entry : grouped.entrySet()) {
            List<IndexRow> indexRows = entry.getValue();
            indexRows.sort(Comparator.comparingInt(row -> row.ordinal));
            List<String> columns = new ArrayList<>();
            for (IndexRow row : indexRows) {
                columns.add(row.column);
            }
            IndexRow first = indexRows.get(0);
            boolean primary = primaryIndexNames.stream().anyMatch(name -> name.equalsIgnoreCase(entry.getKey()))
                || sameColumns(columns, orderedPrimaryColumns);
            result.add(new IndexInfo(
                entry.getKey(),
                columns,
                first.unique,
                primary,
                null,
                first.indexType,
                null,
                null
            ));
        }
        result.sort(Comparator.comparing(IndexInfo::getName));
        return result;
    }

    private static boolean sameColumns(List<String> left, List<String> right) {
        if (left.size() != right.size() || left.isEmpty()) {
            return false;
        }
        for (int index = 0; index < left.size(); index++) {
            if (!left.get(index).equalsIgnoreCase(right.get(index))) {
                return false;
            }
        }
        return true;
    }

    private static String indexType(short type) {
        if (type == DatabaseMetaData.tableIndexClustered) return "CLUSTERED";
        if (type == DatabaseMetaData.tableIndexHashed) return "HASHED";
        if (type == DatabaseMetaData.tableIndexOther) return "OTHER";
        return null;
    }

    static final class IndexRow {
        final String name;
        final String column;
        final int ordinal;
        final boolean unique;
        final String indexType;

        IndexRow(String name, String column, int ordinal, boolean unique, String indexType) {
            this.name = name;
            this.column = column;
            this.ordinal = ordinal;
            this.unique = unique;
            this.indexType = indexType;
        }
    }

    static final class IndexColumn {
        final int ordinal;
        final String name;

        IndexColumn(int ordinal, String name) {
            this.ordinal = ordinal;
            this.name = name;
        }
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
        // JdbcThinConnection implements Connection.setSchema, so no SQL switch is needed.
        return "";
    }

    private static String buildUrl(ConnectParams params) {
        String connectionString = params.getConnection_string();
        if (connectionString != null && !connectionString.trim().isEmpty()) {
            return connectionString.trim();
        }
        String base = "jdbc:ignite:thin://" + params.getHost() + ":" + params.getPort();
        String database = params.getDatabase();
        return database == null || database.isBlank() ? base : base + "/" + database;
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
        new MultiSessionJsonRpcServer(IgniteAgent::new).run();
    }
}
