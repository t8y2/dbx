package com.dbx.agent.hive;

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
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

public final class HiveAgent extends AbstractJdbcAgent {

    @Override
    protected String driverClass() {
        return "org.apache.hive.jdbc.HiveDriver";
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return buildUrl(params);
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            List<DatabaseInfo> result = new ArrayList<>();
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery("SHOW DATABASES")) {
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
            useSchema(schema);
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery("SHOW TABLES")) {
                while (rs.next()) {
                    result.add(new TableInfo(rs.getString(1), "TABLE", null));
                }
            }
            result.sort(Comparator.comparing(TableInfo::getName));
            return result;
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            try {
                return getColumnsFromDescribe(schema, table);
            } catch (Exception ignored) {
                return getColumnsFromMetadata(requireConnected(), schema, table);
            }
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
        return "USE " + JdbcIdentifiers.INSTANCE.backtick(schema);
    }

    @Override
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        // Hive JDBC fetches rows via Thrift FetchResults in batches controlled
        // by fetchSize. A large fetchSize can fail with "Error retrieving next
        // row" when the result contains large binary/struct columns. Use a
        // small fetchSize (50) so each Thrift batch stays within limits.
        return super.executeQuery(sql, schema, new ExecuteQueryOptions(
            options.getMaxRows(),
            50,
            options.getTimeoutSecs()
        ));
    }

    @Override
    public QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        return super.executeQueryPage(sql, schema, withSmallFetchSize(options));
    }

    @Override
    public QueryPageResult startTableRead(String sql, String schema, QueryPageOptions options) {
        return super.startTableRead(sql, schema, withSmallFetchSize(options));
    }

    private static QueryPageOptions withSmallFetchSize(QueryPageOptions options) {
        return new QueryPageOptions(
            options.getPageSize(), 50, options.getMaxRows(), options.getTimeoutSecs()
        );
    }

    @Override
    protected Object resultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
            Object value = rs.getObject(index);
            return rs.wasNull() ? null : value == null ? null : value.toString();
        });
    }

    private void useSchema(String schema) throws Exception {
        try (java.sql.Statement stmt = requireConnected().createStatement()) {
            stmt.execute(setSchemaSQL(schema));
        }
    }

    private List<ColumnInfo> getColumnsFromDescribe(String schema, String table) throws Exception {
        List<ColumnInfo> result = new ArrayList<>();
        useSchema(schema);
        try (java.sql.Statement stmt = requireConnected().createStatement();
             ResultSet rs = stmt.executeQuery("DESCRIBE " + JdbcIdentifiers.INSTANCE.backtick(table))) {
            while (rs.next()) {
                String colName = trimToNull(rs.getString(1));
                if (colName == null || colName.startsWith("#")) {
                    continue;
                }
                result.add(new ColumnInfo(
                    colName,
                    trimToEmpty(rs.getString(2)),
                    true,
                    null,
                    false,
                    null,
                    optionalComment(rs),
                    null,
                    null,
                    null
                ));
            }
        }
        return result;
    }

    private static List<ColumnInfo> getColumnsFromMetadata(Connection conn, String schema, String table) throws Exception {
        List<ColumnInfo> result = new ArrayList<>();
        DatabaseMetaData meta = conn.getMetaData();
        try (ResultSet rs = meta.getColumns(null, trimToNull(schema), table, "%")) {
            while (rs.next()) {
                String name = rs.getString("COLUMN_NAME");
                if (trimToNull(name) == null) {
                    continue;
                }
                result.add(new ColumnInfo(
                    name,
                    trimToEmpty(rs.getString("TYPE_NAME")),
                    rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls,
                    rs.getString("COLUMN_DEF"),
                    false,
                    null,
                    rs.getString("REMARKS"),
                    intOrNull(rs, "COLUMN_SIZE"),
                    intOrNull(rs, "DECIMAL_DIGITS"),
                    characterLength(rs)
                ));
            }
        }
        return result;
    }

    static String buildUrl(ConnectParams params) {
        String connectionString = trimToEmpty(params.getConnection_string());
        if (!connectionString.isEmpty()) {
            return connectionString;
        }
        String url = "jdbc:hive2://" + params.getHost() + ":" + params.getPort() + "/" + params.getDatabase();
        return appendHiveUrlParams(url, params.getUrl_params());
    }

    private static String appendHiveUrlParams(String url, String urlParams) {
        String params = trimHiveUrlParams(urlParams);
        if (params.isEmpty()) {
            return url;
        }
        // Hive JDBC authentication options use semicolon-separated URL properties.
        return url + (url.endsWith(";") ? "" : ";") + params;
    }

    private static String trimHiveUrlParams(String urlParams) {
        String value = trimToEmpty(urlParams);
        while (value.startsWith("?") || value.startsWith("&") || value.startsWith(";")) {
            value = value.substring(1);
        }
        return value;
    }

    private static String trimToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static String trimToEmpty(String value) {
        return value == null ? "" : value.trim();
    }

    private static Integer intOrNull(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value instanceof Number ? ((Number) value).intValue() : null;
    }

    private static Integer characterLength(ResultSet rs) throws Exception {
        String typeName = rs.getString("TYPE_NAME");
        if (typeName == null) {
            return null;
        }
        String normalized = typeName.toLowerCase(Locale.ROOT);
        if (!normalized.contains("char") && !normalized.contains("text") && !normalized.contains("string")) {
            return null;
        }
        return intOrNull(rs, "COLUMN_SIZE");
    }

    private static String optionalComment(ResultSet rs) {
        return unchecked(() -> {
            try {
                String comment = trimToNull(rs.getString(3));
                return comment;
            } catch (Exception e) {
                return null;
            }
        });
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(HiveAgent::new).run();
    }
}
