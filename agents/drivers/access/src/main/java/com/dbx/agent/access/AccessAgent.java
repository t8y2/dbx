package com.dbx.agent.access;

import com.dbx.agent.BaseDatabaseAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public final class AccessAgent extends BaseDatabaseAgent {
    private static final String ENCRYPTED_ACCESS_OPENER = EncryptedAccessOpener.class.getName();
    private Connection connection;
    private String databaseFile = "";

    @Override
    public Connection getConnection() {
        return connection;
    }

    @Override
    public void connect(ConnectParams params) {
        uncheckedVoid(() -> {
            Class.forName("net.ucanaccess.jdbc.UcanaccessDriver");
            String file = databasePath(params);
            String url = jdbcUrl(params, true);
            connection = DriverManager.getConnection(url, params.getUsername(), params.getPassword());
            databaseFile = file;
        });
    }

    @Override
    public boolean testConnection(ConnectParams params) {
        return unchecked(() -> {
            Class.forName("net.ucanaccess.jdbc.UcanaccessDriver");
            String file = databasePath(params);
            if (file.isBlank() || !Files.exists(Path.of(file))) {
                return false;
            }
            try (Connection conn = DriverManager.getConnection(jdbcUrl(params, false), params.getUsername(), params.getPassword())) {
                return conn.isValid(5);
            }
        });
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        String name = "default";
        if (!databaseFile.isBlank()) {
            Path fileName = Path.of(databaseFile).getFileName();
            if (fileName != null && !fileName.toString().isBlank()) {
                name = fileName.toString();
            }
        }
        return Collections.singletonList(new DatabaseInfo(name));
    }

    @Override
    public List<String> listSchemas() {
        return Collections.emptyList();
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return unchecked(() -> {
            DatabaseMetaData meta = requireConnected().getMetaData();
            List<TableInfo> result = new ArrayList<>();
            try (ResultSet rs = meta.getTables(null, null, "%", new String[]{"TABLE", "VIEW"})) {
                while (rs.next()) {
                    String name = rs.getString("TABLE_NAME");
                    if (name == null || startsWithIgnoreCase(name, "MSys")) {
                        continue;
                    }
                    result.add(new TableInfo(name, normalizeTableType(rs.getString("TABLE_TYPE")), null));
                }
            }
            result.sort(Comparator.comparing(table -> table.getName().toLowerCase(Locale.ROOT)));
            return result;
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        List<ObjectInfo> result = new ArrayList<>();
        for (TableInfo table : listTables(schema)) {
            result.add(new ObjectInfo(table.getName(), table.getTable_type(), null, table.getComment()));
        }
        return result;
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            DatabaseMetaData meta = requireConnected().getMetaData();
            Set<String> primaryKeys = primaryKeyColumns(meta, table);
            List<ColumnInfo> result = new ArrayList<>();
            try (ResultSet rs = meta.getColumns(null, null, table, "%")) {
                while (rs.next()) {
                    String name = rs.getString("COLUMN_NAME");
                    result.add(new ColumnInfo(
                        name,
                        typeName(rs),
                        rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls,
                        rs.getString("COLUMN_DEF"),
                        primaryKeys.contains(name),
                        null,
                        rs.getString("REMARKS"),
                        intObject(rs, "COLUMN_SIZE"),
                        intObject(rs, "DECIMAL_DIGITS"),
                        intObject(rs, "COLUMN_SIZE")
                    ));
                }
            }
            result.sort(Comparator.comparingInt(column -> columnOrder(meta, table, column.getName())));
            return result;
        });
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return unchecked(() -> {
            DatabaseMetaData meta = requireConnected().getMetaData();
            Set<String> primaryKeys = primaryKeyColumns(meta, table);
            Map<String, List<OrdinalColumn>> columnsByIndex = new LinkedHashMap<>();
            Map<String, Boolean> uniqueByIndex = new LinkedHashMap<>();
            Map<String, Boolean> primaryByIndex = new LinkedHashMap<>();
            Map<String, String> typeByIndex = new LinkedHashMap<>();

            try (ResultSet rs = meta.getIndexInfo(null, null, table, false, false)) {
                while (rs.next()) {
                    if (rs.getShort("TYPE") == DatabaseMetaData.tableIndexStatistic) {
                        continue;
                    }
                    String indexName = rs.getString("INDEX_NAME");
                    String columnName = rs.getString("COLUMN_NAME");
                    if (indexName == null || columnName == null) {
                        continue;
                    }
                    short ordinal = rs.getShort("ORDINAL_POSITION");

                    columnsByIndex.computeIfAbsent(indexName, ignored -> new ArrayList<>()).add(new OrdinalColumn(ordinal, columnName));
                    uniqueByIndex.put(indexName, !rs.getBoolean("NON_UNIQUE"));
                    primaryByIndex.put(indexName, primaryKeys.contains(columnName) || indexName.equalsIgnoreCase("PrimaryKey"));
                    typeByIndex.put(indexName, indexTypeName(rs.getShort("TYPE")));
                }
            }

            List<IndexInfo> result = new ArrayList<>();
            for (Map.Entry<String, List<OrdinalColumn>> entry : columnsByIndex.entrySet()) {
                String name = entry.getKey();
                List<OrdinalColumn> pairs = entry.getValue();
                pairs.sort(Comparator.comparingInt(pair -> pair.ordinal));
                List<String> columns = new ArrayList<>();
                for (OrdinalColumn pair : pairs) {
                    columns.add(pair.column);
                }
                result.add(new IndexInfo(
                    name,
                    columns,
                    uniqueByIndex.getOrDefault(name, false),
                    primaryByIndex.getOrDefault(name, false),
                    null,
                    typeByIndex.get(name),
                    null,
                    null
                ));
            }
            return result;
        });
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return unchecked(() -> {
            DatabaseMetaData meta = requireConnected().getMetaData();
            List<ForeignKeyInfo> result = new ArrayList<>();
            try (ResultSet rs = meta.getImportedKeys(null, null, table)) {
                while (rs.next()) {
                    String name = rs.getString("FK_NAME");
                    result.add(new ForeignKeyInfo(
                        name == null ? "" : name,
                        rs.getString("FKCOLUMN_NAME"),
                        rs.getString("PKTABLE_NAME"),
                        rs.getString("PKCOLUMN_NAME")
                    ));
                }
            }
            return result;
        });
    }

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        return Collections.emptyList();
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
            JdbcExecutor.current()::defaultResultValue
        );
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "";
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

    private Set<String> primaryKeyColumns(DatabaseMetaData meta, String table) throws Exception {
        Set<String> result = new LinkedHashSet<>();
        try (ResultSet rs = meta.getPrimaryKeys(null, null, table)) {
            while (rs.next()) {
                result.add(rs.getString("COLUMN_NAME"));
            }
        }
        return result;
    }

    private int columnOrder(DatabaseMetaData meta, String table, String column) {
        return unchecked(() -> {
            try (ResultSet rs = meta.getColumns(null, null, table, column)) {
                return rs.next() ? rs.getInt("ORDINAL_POSITION") : Integer.MAX_VALUE;
            }
        });
    }

    private static String databasePath(ConnectParams params) {
        if (startsWithIgnoreCase(params.getConnection_string(), "jdbc:ucanaccess:")) {
            return stripJdbcPrefix(params.getConnection_string());
        }
        if (startsWithIgnoreCase(params.getDatabase(), "jdbc:ucanaccess:")) {
            return stripJdbcPrefix(params.getDatabase());
        }
        if (!params.getHost().isBlank()) {
            return params.getHost();
        }
        return params.getDatabase();
    }

    static String jdbcUrl(ConnectParams params, boolean createIfMissing) {
        String rawUrl;
        if (startsWithIgnoreCase(params.getConnection_string(), "jdbc:ucanaccess:")) {
            rawUrl = params.getConnection_string();
        } else if (startsWithIgnoreCase(params.getDatabase(), "jdbc:ucanaccess:")) {
            rawUrl = params.getDatabase();
        } else {
            rawUrl = "jdbc:ucanaccess://" + databasePath(params);
        }
        rawUrl = appendUCanAccessParams(rawUrl, params.getUrl_params());

        // The codec opener is safe for regular files and enables encrypted Access files when a password is supplied.
        if (!containsIgnoreCase(rawUrl, "jackcessOpener=")) {
            rawUrl += (rawUrl.endsWith(";") ? "" : ";") + "jackcessOpener=" + ENCRYPTED_ACCESS_OPENER;
        }

        if (!createIfMissing || Files.exists(Path.of(databasePath(params)))) {
            return rawUrl;
        }
        if (containsIgnoreCase(rawUrl, "newDatabaseVersion=")) {
            return rawUrl;
        }
        return rawUrl + ";newDatabaseVersion=V2010";
    }

    private static String appendUCanAccessParams(String url, String urlParams) {
        String params = trimUCanAccessParams(urlParams);
        if (params.isEmpty()) {
            return url;
        }
        return url + (url.endsWith(";") ? "" : ";") + params;
    }

    private static String trimUCanAccessParams(String urlParams) {
        String value = urlParams == null ? "" : urlParams.trim();
        while (value.startsWith("?") || value.startsWith("&") || value.startsWith(";")) {
            value = value.substring(1);
        }
        return value;
    }

    private static String normalizeTableType(String value) {
        if (value != null && value.toUpperCase(Locale.ROOT).equals("BASE TABLE")) {
            return "TABLE";
        }
        return value == null ? "TABLE" : value;
    }

    private static String indexTypeName(short value) {
        if (value == DatabaseMetaData.tableIndexClustered) {
            return "CLUSTERED";
        }
        if (value == DatabaseMetaData.tableIndexHashed) {
            return "HASHED";
        }
        if (value == DatabaseMetaData.tableIndexOther) {
            return "OTHER";
        }
        return "";
    }

    private static String typeName(ResultSet rs) throws Exception {
        String value = rs.getString("TYPE_NAME");
        return value == null ? Integer.toString(rs.getInt("DATA_TYPE")) : value;
    }

    private static Integer intObject(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value instanceof Number number ? number.intValue() : null;
    }

    private static String stripJdbcPrefix(String value) {
        return substringBefore(value.replaceFirst("(?i)^jdbc:ucanaccess://", ""), ';');
    }

    private static String substringBefore(String value, char delimiter) {
        int index = value.indexOf(delimiter);
        return index >= 0 ? value.substring(0, index) : value;
    }

    private static boolean startsWithIgnoreCase(String value, String prefix) {
        return value.regionMatches(true, 0, prefix, 0, prefix.length());
    }

    private static boolean containsIgnoreCase(String value, String needle) {
        return value.toLowerCase(Locale.ROOT).contains(needle.toLowerCase(Locale.ROOT));
    }

    private record OrdinalColumn(short ordinal, String column) {
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(AccessAgent::new).run();
    }
}
