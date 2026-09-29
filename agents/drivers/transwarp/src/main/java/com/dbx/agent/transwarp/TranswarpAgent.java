package com.dbx.agent.transwarp;

import com.dbx.agent.AbstractJdbcAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.PartitionInfo;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import org.apache.hive.jdbc.HiveConnection;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public final class TranswarpAgent extends AbstractJdbcAgent {
    private static final String DRIVER_CLASS = "org.apache.hive.jdbc.HiveDriver";
    private boolean transactionStateUnknown;

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) {
        transactionStateUnknown = false;
    }

    @Override
    protected void beforePooledConnectionReturn(Connection connection) throws Exception {
        if (transactionStateUnknown) {
            throw new SQLException("Transwarp transaction state is unknown after rollback failure");
        }
    }

    @Override
    protected String connectionValidationQuery() {
        return "SELECT 1";
    }

    @Override
    protected String driverClass() {
        return DRIVER_CLASS;
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        String supplied = params.getConnection_string();
        if (supplied != null && !supplied.isBlank()) {
            return supplied.trim();
        }
        String host = params.getHost() == null ? "" : params.getHost().trim();
        if (host.isEmpty()) {
            throw new IllegalArgumentException("Transwarp host is required");
        }
        int port = params.getPort() > 0 ? params.getPort() : 10000;
        String database = database(params.getDatabase());
        StringBuilder url = new StringBuilder("jdbc:inceptor2://")
            .append(host).append(':').append(port).append('/').append(database);
        String options = params.getUrl_params();
        if (options != null && !options.isBlank()) {
            url.append(';').append(options.replaceFirst("^;+", ""));
        }
        if (params.isSsl() && (options == null || !options.toLowerCase(Locale.ROOT).contains("ssl="))) {
            url.append(";ssl=true");
        }
        return url.toString();
    }

    private static String database(String value) {
        return value == null || value.isBlank() ? "default" : value.trim();
    }

    private String schema(String value) {
        return value == null || value.isBlank() ? database(getConfiguredDatabase()) : value.trim();
    }

    @Override
    public String setSchemaSQL(String schema) {
        return schema == null || schema.isBlank() ? "" : "USE " + JdbcIdentifiers.INSTANCE.backtick(schema);
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return query("SELECT database_name FROM system.databases_v ORDER BY database_name", List.of(),
            row -> new DatabaseInfo(row.getString(1)));
    }

    @Override
    public List<String> listSchemas() {
        return listDatabases().stream().map(DatabaseInfo::getName).toList();
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return listTables(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        String catalog = schema(schema);
        MetadataListConstraints requested = MetadataListConstraints.orNone(constraints);
        List<TableInfo> tables = new ArrayList<>();
        if (!requested.hasObjectTypes() || requested.tableTypeAllowed("TABLE") || requested.tableTypeAllowed("MATERIALIZED_VIEW")) {
            tables.addAll(query(
                "SELECT table_name, table_type, commentstring FROM system.tables_v WHERE database_name=? ORDER BY table_name",
                List.of(catalog), row -> new TableInfo(row.getString(1), tableType(row.getString(2)), row.getString(3))));
        }
        if (!requested.hasObjectTypes() || requested.tableTypeAllowed("VIEW")) {
            tables.addAll(query("SELECT view_name FROM system.views_v WHERE database_name=? ORDER BY view_name",
                List.of(catalog), row -> new TableInfo(row.getString(1), "VIEW", null)));
        }
        tables.sort(Comparator.comparing(TableInfo::getName));
        return requested.filterTables(tables);
    }

    private static String tableType(String value) {
        if (value == null) return "TABLE";
        String normalized = value.toUpperCase(Locale.ROOT).replace(' ', '_');
        if (normalized.contains("MATERIALIZED") && normalized.contains("VIEW")) return "MATERIALIZED_VIEW";
        return normalized.contains("VIEW") ? "VIEW" : "TABLE";
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return listObjects(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<ObjectInfo> listObjects(String schema, MetadataListConstraints constraints) {
        String catalog = schema(schema);
        MetadataListConstraints requested = MetadataListConstraints.orNone(constraints);
        List<ObjectInfo> objects = new ArrayList<>();
        if (requested.includesTableLikeTypes()) {
            for (TableInfo table : listTables(catalog, requested.withoutPaging())) {
                objects.add(new ObjectInfo(table.getName(), table.getTable_type(), catalog, table.getComment()));
            }
        }
        if (!requested.hasObjectTypes() || requested.objectTypeAllowed("PROCEDURE")) {
            objects.addAll(namedObjects(catalog, "system.procedures_v", "procedure_name", "PROCEDURE"));
        }
        if (!requested.hasObjectTypes() || requested.objectTypeAllowed("FUNCTION")) {
            objects.addAll(namedObjects(catalog, "system.functions_v", "function_name", "FUNCTION"));
        }
        if (!requested.hasObjectTypes() || requested.objectTypeAllowed("PACKAGE") || requested.objectTypeAllowed("PACKAGE_BODY")) {
            objects.addAll(optionalCatalogQuery(
                "SELECT package_name, package_body FROM system.packages_v WHERE database_name=? ORDER BY package_name",
                List.of(catalog), row -> {
                    List<ObjectInfo> entries = new ArrayList<>();
                    String name = row.getString(1);
                    entries.add(new ObjectInfo(name, "PACKAGE", catalog, null));
                    if (row.getString(2) != null) {
                        entries.add(new ObjectInfo(name, "PACKAGE_BODY", catalog, null));
                    }
                    return entries;
                }).stream().flatMap(List::stream).toList());
        }
        objects.sort(Comparator.comparing(ObjectInfo::getName).thenComparing(ObjectInfo::getObject_type));
        return requested.filterObjects(objects);
    }

    private List<ObjectInfo> namedObjects(String schema, String view, String nameColumn, String type) {
        return optionalCatalogQuery("SELECT " + nameColumn + " FROM " + view + " WHERE database_name=? ORDER BY " + nameColumn,
            List.of(schema), row -> new ObjectInfo(row.getString(1), type, schema, null));
    }

    @Override
    public List<String> listDataTypes() {
        return unchecked(() -> {
            Set<String> types = new LinkedHashSet<>();
            try (ResultSet rows = requireConnected().getMetaData().getTypeInfo()) {
                while (rows.next()) {
                    String name = rows.getString("TYPE_NAME");
                    if (name != null && !name.isBlank()) types.add(name);
                }
            }
            return types.stream().sorted().toList();
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        String catalog = schema(schema);
        Set<String> primaryKeys = unchecked(() -> {
            Set<String> keys = new HashSet<>();
            DatabaseMetaData metadata = requireConnected().getMetaData();
            String metadataSchema = metadata.storesUpperCaseIdentifiers() ? catalog.toUpperCase(Locale.ROOT)
                : metadata.storesLowerCaseIdentifiers() ? catalog.toLowerCase(Locale.ROOT) : catalog;
            String metadataTable = metadata.storesUpperCaseIdentifiers() ? table.toUpperCase(Locale.ROOT)
                : metadata.storesLowerCaseIdentifiers() ? table.toLowerCase(Locale.ROOT) : table;
            try (ResultSet rows = metadata.getPrimaryKeys(null, metadataSchema, metadataTable)) {
                while (rows.next()) keys.add(rows.getString("COLUMN_NAME").toLowerCase(Locale.ROOT));
            } catch (SQLException ignored) {
                // The system catalog still provides column metadata on SDKs without PK metadata.
            }
            return keys;
        });
        Map<String, int[]> dimensions = unchecked(() -> {
            Map<String, int[]> sizes = new HashMap<>();
            DatabaseMetaData metadata = requireConnected().getMetaData();
            String metadataSchema = metadata.storesUpperCaseIdentifiers() ? catalog.toUpperCase(Locale.ROOT)
                : metadata.storesLowerCaseIdentifiers() ? catalog.toLowerCase(Locale.ROOT) : catalog;
            String metadataTable = metadata.storesUpperCaseIdentifiers() ? table.toUpperCase(Locale.ROOT)
                : metadata.storesLowerCaseIdentifiers() ? table.toLowerCase(Locale.ROOT) : table;
            try (ResultSet rows = metadata.getColumns(null, metadataSchema, metadataTable, null)) {
                while (rows.next()) {
                    String column = rows.getString("COLUMN_NAME");
                    int size = rows.getInt("COLUMN_SIZE");
                    int scale = rows.getInt("DECIMAL_DIGITS");
                    sizes.put(column.toLowerCase(Locale.ROOT), new int[]{size, scale});
                }
            } catch (SQLException ignored) {
                // The system catalog remains the source for type names and other attributes.
            }
            return sizes;
        });
        return query("SELECT column_name, column_type, nullable, default_value, commentstring "
                + "FROM system.columns_v WHERE database_name=? AND table_name=? ORDER BY column_id",
            List.of(catalog, table), row -> {
                String name = row.getString(1);
                String type = row.getString(2);
                int[] size = dimensions.get(name.toLowerCase(Locale.ROOT));
                boolean numeric = type != null && type.matches("(?i)^(decimal|numeric|number)(\\(.*)?$");
                boolean character = type != null && type.matches("(?i)^(char|varchar|character)(\\(.*)?$");
                return new ColumnInfo(name, type, nullable(row.getObject(3)), row.getString(4),
                    primaryKeys.contains(name.toLowerCase(Locale.ROOT)), null, row.getString(5),
                    numeric && size != null ? size[0] : null, numeric && size != null ? size[1] : null,
                    character && size != null ? size[0] : null);
            });
    }

    private static boolean nullable(Object value) {
        if (value == null) return true;
        if (value instanceof Boolean flag) return flag;
        if (value instanceof Number number) return number.intValue() != 0;
        String text = value.toString().trim().toUpperCase(Locale.ROOT);
        return !text.equals("NO") && !text.equals("N") && !text.equals("FALSE") && !text.equals("0") && !text.equals("NOT NULL");
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        // Waterdrop exposes no index list, and the SDK's getIndexInfo throws SQLException.
        return List.of();
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return List.of();
    }

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        String catalog = schema(schema);
        return optionalCatalogQuery("SELECT * FROM system.triggers_v WHERE database_name=? AND table_name=?",
            List.of(catalog, table), row -> new TriggerInfo(
                firstColumn(row, "trigger_name", "name", "trigger"),
                firstColumn(row, "event", "event_type", "trigger_event"),
                firstColumn(row, "timing", "trigger_timing", "action_timing")))
            .stream()
            .filter(trigger -> trigger.getName() != null && !trigger.getName().isBlank())
            .toList();
    }

    @Override
    public List<PartitionInfo> listPartitions(String schema, String table) {
        String catalog = schema(schema);
        List<PartitionInfo> partitions = new ArrayList<>();
        partitions.addAll(query("SELECT partition_name, partition_value, partition_key FROM system.partitions_v "
                + "WHERE database_name=? AND table_name=? ORDER BY partition_id",
            List.of(catalog, table), row -> new PartitionInfo(row.getString(1), 0, row.getString(2), "LIST", row.getString(3))));
        partitions.addAll(optionalCatalogQuery("SELECT partition_name, partition_range, partition_key FROM system.range_partitions_v "
                + "WHERE database_name=? AND table_name=? ORDER BY partition_id",
            List.of(catalog, table), row -> new PartitionInfo(row.getString(1), 0, row.getString(2), "RANGE", row.getString(3))));
        partitions.addAll(optionalCatalogQuery("SELECT * FROM system.buckets_v WHERE database_name=? AND table_name=?",
            List.of(catalog, table), row -> new PartitionInfo(
                firstColumn(row, "bucket_name", "name", "bucket"),
                0,
                firstColumn(row, "bucket_value", "value", "bucket_count", "count", "bucket_number"),
                "BUCKET",
                firstColumn(row, "bucket_key", "bucket_column", "column_name", "key"))));
        List<PartitionInfo> numbered = new ArrayList<>();
        for (int index = 0; index < partitions.size(); index++) {
            PartitionInfo partition = partitions.get(index);
            String name = partition.name();
            if (name == null || name.isBlank()) {
                name = partition.partition_type().equals("BUCKET") ? "bucket-" + (index + 1) : "partition-" + (index + 1);
            }
            numbered.add(new PartitionInfo(name, index + 1, partition.value(),
                partition.partition_type(), partition.partition_key()));
        }
        return numbered;
    }

    @Override
    public String getTableDdl(String schema, String table) {
        String sql = "SHOW CREATE TABLE " + JdbcIdentifiers.INSTANCE.backtick(schema(schema))
            + "." + JdbcIdentifiers.INSTANCE.backtick(table);
        return unchecked(() -> {
            List<String> lines = new ArrayList<>();
            try (Statement statement = requireConnected().createStatement(); ResultSet rows = statement.executeQuery(sql)) {
                while (rows.next()) {
                    String line = rows.getString(1);
                    if (line != null && !line.isBlank()) lines.add(line);
                }
            }
            return String.join("\n", lines);
        });
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String catalog = schema(schema);
        String type = objectType.toUpperCase(Locale.ROOT);
        if (type.equals("TABLE")) {
            return new ObjectSource(name, type, catalog, getTableDdl(catalog, name));
        }
        String view;
        String nameColumn;
        String sourceColumn;
        switch (type) {
            case "VIEW" -> { view = "system.views_v"; nameColumn = "view_name"; sourceColumn = "origin_text"; }
            case "PROCEDURE" -> { view = "system.procedures_v"; nameColumn = "procedure_name"; sourceColumn = "full_text"; }
            case "FUNCTION" -> { view = "system.functions_v"; nameColumn = "function_name"; sourceColumn = "full_text"; }
            case "PACKAGE" -> { view = "system.packages_v"; nameColumn = "package_name"; sourceColumn = "full_text"; }
            case "PACKAGE_BODY" -> { view = "system.packages_v"; nameColumn = "package_name"; sourceColumn = "package_body"; }
            default -> throw new UnsupportedOperationException("Unsupported Transwarp object type: " + type);
        }
        List<String> source = query("SELECT " + sourceColumn + " FROM " + view + " WHERE database_name=? AND "
            + nameColumn + "=?", List.of(catalog, name), row -> row.getString(1));
        if (source.isEmpty() || source.stream().allMatch(value -> value == null || value.isBlank())) {
            throw new IllegalArgumentException(type + " source not found: " + catalog + "." + name);
        }
        return new ObjectSource(name, type, catalog,
            String.join("\n", source.stream().filter(value -> value != null && !value.isBlank()).toList()));
    }

    @Override
    public QueryResult executeTransaction(List<String> statements, String schema) {
        return unchecked(() -> {
            long started = System.currentTimeMillis();
            long affected = 0;
            Connection connection = requireConnected();
            applySchemaContext(connection, schema);
            try (Statement statement = connection.createStatement()) {
                if (connection instanceof HiveConnection) {
                    statement.execute("SET transaction.type = inceptor");
                }
                statement.execute("BEGIN TRANSACTION");
                try {
                    for (String sql : statements) {
                        if (sql != null && !sql.isBlank()) {
                            statement.execute(sql);
                            affected += Math.max(statement.getUpdateCount(), 0);
                        }
                    }
                    statement.execute("COMMIT");
                } catch (Exception error) {
                    try {
                        statement.execute("ROLLBACK");
                    } catch (Exception rollbackError) {
                        transactionStateUnknown = true;
                        error.addSuppressed(rollbackError);
                    }
                    throw error;
                }
            }
            return new QueryResult(List.of(), List.of(), affected, System.currentTimeMillis() - started);
        });
    }

    private interface RowReader<T> {
        T read(ResultSet row) throws Exception;
    }

    private <T> List<T> query(String sql, List<String> parameters, RowReader<T> reader) {
        return unchecked(() -> {
            List<T> values = new ArrayList<>();
            try (PreparedStatement statement = requireConnected().prepareStatement(sql)) {
                for (int index = 0; index < parameters.size(); index++) {
                    statement.setString(index + 1, parameters.get(index));
                }
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) values.add(reader.read(rows));
                }
            }
            return values;
        });
    }

    private <T> List<T> optionalCatalogQuery(String sql, List<String> parameters, RowReader<T> reader) {
        try {
            return query(sql, parameters, reader);
        } catch (RuntimeException error) {
            Throwable cause = error;
            while (cause != null) {
                if (cause instanceof SQLException sqlError) {
                    if ("42S02".equals(sqlError.getSQLState()) || "42P01".equals(sqlError.getSQLState())) {
                        return List.of();
                    }
                    break;
                }
                cause = cause.getCause();
            }
            throw error;
        }
    }

    private static String firstColumn(ResultSet row, String... candidates) throws SQLException {
        ResultSetMetaData metadata = row.getMetaData();
        for (String candidate : candidates) {
            for (int index = 1; index <= metadata.getColumnCount(); index++) {
                String label = metadata.getColumnLabel(index);
                String name = metadata.getColumnName(index);
                if (candidate.equalsIgnoreCase(label) || candidate.equalsIgnoreCase(name)) {
                    Object value = row.getObject(index);
                    return value == null ? null : value.toString();
                }
            }
        }
        return null;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(TranswarpAgent::new).run();
    }
}
