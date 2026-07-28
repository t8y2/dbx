package com.dbx.agent.spark;

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

// Spark Thrift Server speaks the HiveServer2 protocol, so the Spark agent reuses
// the Hive JDBC driver and mirrors the Hive agent's metadata queries (SHOW
// DATABASES / SHOW TABLES / DESCRIBE), which Spark SQL supports as well.
//
// Spark 3.4+ supports multiple catalogs (Paimon, Lance, Iceberg, ...). When the
// user supplies `catalog=<name>` in url_params, the agent switches to that catalog
// after connecting and uses `SHOW TABLES IN <catalog>` for listing — which works
// uniformly for catalogs that have databases (Paimon) and those that expose tables
// at the catalog root with no databases (Lance). Mirrors the StarRocks catalog flow.
public final class SparkAgent extends AbstractJdbcAgent {
    private String configuredCatalog;

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
    protected String driverClass() {
        return "org.apache.hive.jdbc.HiveDriver";
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return "jdbc:hive2://" + params.getHost() + ":" + params.getPort() + "/";
    }

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) throws Exception {
        String catalog = extractCatalogParam(params.getUrl_params());
        configuredCatalog = catalog;
        if (catalog != null && !catalog.isEmpty()) {
            try (java.sql.Statement stmt = connection.createStatement()) {
                stmt.execute("USE " + JdbcIdentifiers.INSTANCE.backtick(catalog));
            }
        }
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
            // Catalogs like Lance expose tables at the catalog root with no
            // databases — SHOW DATABASES returns nothing. Return the catalog
            // name itself as the database node so the sidebar can drill in.
            if (result.isEmpty() && configuredCatalog != null && !configuredCatalog.isEmpty()) {
                result.add(new DatabaseInfo(configuredCatalog));
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
            String sql = buildShowTablesSql(schema);
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery(sql)) {
                while (rs.next()) {
                    String name = readTableName(rs);
                    if (name != null && !name.isEmpty()) {
                        result.add(new TableInfo(name, "TABLE", null));
                    }
                }
            }
            result.sort(Comparator.comparing(TableInfo::getName));
            return result;
        });
    }

    // With a catalog configured, use `SHOW TABLES IN <catalog>[.<schema>]` which
    // works for both catalog-root tables (Lance) and catalog.schema tables (Paimon).
    // Without a catalog, fall back to the Hive-style `USE <schema>` + SHOW TABLES.
    private String buildShowTablesSql(String schema) throws Exception {
        if (configuredCatalog != null && !configuredCatalog.isEmpty()) {
            String target = JdbcIdentifiers.INSTANCE.backtick(configuredCatalog);
            if (schema != null && !schema.isEmpty() && !schema.equals(configuredCatalog)) {
                target += "." + JdbcIdentifiers.INSTANCE.backtick(schema);
            }
            return "SHOW TABLES IN " + target;
        }
        useSchema(schema);
        return "SHOW TABLES";
    }

    // `SHOW TABLES` (Hive style) returns a single tabName column, while
    // `SHOW TABLES IN <catalog>` (Spark SQL) returns (database, tableName,
    // isTemporary). Pick tableName from whichever column it lives in.
    private static String readTableName(ResultSet rs) throws Exception {
        int columns = rs.getMetaData().getColumnCount();
        return columns > 1 ? rs.getString(2) : rs.getString(1);
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
        // When a catalog is configured, qualify the USE statement with the
        // catalog so switching schemas does not reset the catalog back to the
        // default (spark_catalog).
        if (configuredCatalog != null && !configuredCatalog.isEmpty()) {
            if (schema == null || schema.isEmpty() || schema.equals(configuredCatalog)) {
                return "USE " + JdbcIdentifiers.INSTANCE.backtick(configuredCatalog);
            }
            return "USE " + JdbcIdentifiers.INSTANCE.backtick(configuredCatalog)
                + "." + JdbcIdentifiers.INSTANCE.backtick(schema);
        }
        return "USE " + JdbcIdentifiers.INSTANCE.backtick(schema);
    }

    private static String extractCatalogParam(String urlParams) {
        if (urlParams == null || urlParams.isEmpty()) {
            return null;
        }
        for (String segment : urlParams.split("&")) {
            int eq = segment.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            if (segment.substring(0, eq).trim().equalsIgnoreCase("catalog")) {
                String value = segment.substring(eq + 1).trim();
                return value.isEmpty() ? null : value;
            }
        }
        return null;
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
        // Use catalog-qualified DESCRIBE when a catalog is configured, avoiding
        // USE <schema> which would generate USE `catalog`.`catalog` when the
        // sidebar passes the catalog name as the schema (Lance case).
        String describeTarget;
        if (configuredCatalog != null && !configuredCatalog.isEmpty()) {
            describeTarget = JdbcIdentifiers.INSTANCE.backtick(configuredCatalog);
            if (schema != null && !schema.isEmpty() && !schema.equals(configuredCatalog)) {
                describeTarget += "." + JdbcIdentifiers.INSTANCE.backtick(schema);
            }
            describeTarget += "." + JdbcIdentifiers.INSTANCE.backtick(table);
        } else {
            useSchema(schema);
            describeTarget = JdbcIdentifiers.INSTANCE.backtick(table);
        }
        try (java.sql.Statement stmt = requireConnected().createStatement();
             ResultSet rs = stmt.executeQuery("DESCRIBE " + describeTarget)) {
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
        new MultiSessionJsonRpcServer(SparkAgent::new).run();
    }
}
