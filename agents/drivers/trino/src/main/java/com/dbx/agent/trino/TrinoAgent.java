package com.dbx.agent.trino;

import com.dbx.agent.AbstractJdbcAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.MetadataSqlSupport;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class TrinoAgent extends AbstractJdbcAgent {
    private static final Pattern NUMERIC_PRECISION_PATTERN = Pattern.compile("(?i)^(decimal|numeric)\\((\\d+)(?:,\\s*\\d+)?\\)");
    private static final Pattern NUMERIC_SCALE_PATTERN = Pattern.compile("(?i)^(decimal|numeric)\\(\\d+,\\s*(\\d+)\\)");
    private static final Pattern CHARACTER_LENGTH_PATTERN = Pattern.compile("(?i)^(char|varchar)\\((\\d+)\\)");

    @Override
    protected String driverClass() {
        return "io.trino.jdbc.TrinoDriver";
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
                 ResultSet rs = stmt.executeQuery("SHOW CATALOGS")) {
                while (rs.next()) {
                    result.add(new DatabaseInfo(rs.getString(1)));
                }
            }
            return result;
        });
    }

    @Override
    public List<String> listSchemas() {
        return unchecked(() -> {
            List<String> result = new ArrayList<>();
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery("SHOW SCHEMAS")) {
                while (rs.next()) {
                    result.add(rs.getString(1));
                }
            }
            return result;
        });
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            String sql = "SELECT table_name, table_type " +
                "FROM information_schema.tables " +
                "WHERE table_schema = ? " +
                "ORDER BY table_name";
            try (java.sql.PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(
                            rs.getString("table_name"),
                            normalizeTableType(rs.getString("table_type")),
                            null
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (isUnconstrained(normalized)) {
            return listTables(schema);
        }
        if (!normalized.includesTableLikeTypes()) {
            return List.of();
        }
        try {
            return queryConstrainedTables(schema, normalized);
        } catch (RuntimeException e) {
            return normalized.filterTables(listTables(schema));
        }
    }

    private List<TableInfo> queryConstrainedTables(String schema, MetadataListConstraints constraints) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            StringBuilder sql = new StringBuilder("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ?");
            args.add(schema);
            appendTrinoTableTypePredicate(sql, args, constraints);
            MetadataSqlSupport.appendNameFilter(sql, args, "table_name", constraints);
            sql.append(" ORDER BY table_name");
            MetadataSqlSupport.appendLiteralLimitOffset(sql, constraints);
            try (java.sql.PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                MetadataSqlSupport.bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(
                            rs.getString("table_name"),
                            normalizeTableType(rs.getString("table_type")),
                            null
                        ));
                    }
                }
            }
            return constraints.withoutPaging().filterTables(result);
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        Connection conn = requireConnected();
        List<ColumnInfo> metadataColumns;
        try {
            metadataColumns = getColumnsFromMetadata(conn, schema, table);
        } catch (RuntimeException e) {
            metadataColumns = Collections.emptyList();
        }
        return metadataColumns.isEmpty() ? getColumnsFromDescribe(conn, schema, table) : metadataColumns;
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
        return "USE " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    private List<ColumnInfo> getColumnsFromMetadata(Connection conn, String schema, String table) {
        return unchecked(() -> {
            List<ColumnInfo> result = new ArrayList<>();
            String catalog = blankToNull(conn.getCatalog());
            try (ResultSet rs = conn.getMetaData().getColumns(catalog, schema, table, null)) {
                while (rs.next()) {
                    int sqlType = rs.getInt("DATA_TYPE");
                    Integer size = intOrNull(rs, "COLUMN_SIZE");
                    Integer scale = intOrNull(rs, "DECIMAL_DIGITS");
                    result.add(new ColumnInfo(
                        rs.getString("COLUMN_NAME"),
                        coalesce(rs.getString("TYPE_NAME")),
                        rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls,
                        rs.getString("COLUMN_DEF"),
                        false,
                        null,
                        rs.getString("REMARKS"),
                        isNumericType(sqlType) ? size : null,
                        isNumericType(sqlType) ? scale : null,
                        isCharacterType(sqlType) ? size : null
                    ));
                }
            }
            return result;
        });
    }

    private List<ColumnInfo> getColumnsFromDescribe(Connection conn, String schema, String table) {
        return unchecked(() -> {
            List<ColumnInfo> result = new ArrayList<>();
            String sql = "DESCRIBE " + quoteIdentifier(schema) + "." + quoteIdentifier(table);
            try (java.sql.Statement stmt = conn.createStatement();
                 ResultSet rs = stmt.executeQuery(sql)) {
                while (rs.next()) {
                    String dataType = rs.getString(2);
                    String extra = rs.getString(3);
                    result.add(new ColumnInfo(
                        rs.getString(1),
                        dataType,
                        !coalesce(extra).toLowerCase(java.util.Locale.ROOT).contains("not null"),
                        null,
                        false,
                        extra,
                        rs.getString(4),
                        parseNumericPrecision(dataType),
                        parseNumericScale(dataType),
                        parseCharacterMaximumLength(dataType)
                    ));
                }
            }
            return result;
        });
    }

    @Override
    protected Object resultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
            Object value = rs.getObject(index);
            return rs.wasNull() ? null : value == null ? null : value.toString();
        });
    }

    private static String buildUrl(ConnectParams params) {
        if (params.getConnection_string() != null && !params.getConnection_string().isBlank()) {
            return params.getConnection_string();
        }
        return "jdbc:trino://" + params.getHost() + ":" + params.getPort() + "/" + params.getDatabase();
    }

    private static boolean isUnconstrained(MetadataListConstraints constraints) {
        return !constraints.hasFilter() && !constraints.hasLimit() && !constraints.hasOffset() && !constraints.hasObjectTypes();
    }

    private static void appendTrinoTableTypePredicate(StringBuilder sql, List<Object> args, MetadataListConstraints constraints) {
        if (!constraints.hasObjectTypes()) {
            return;
        }
        List<String> types = new ArrayList<>();
        if (constraints.tableTypeAllowed("TABLE")) {
            types.add("BASE TABLE");
        }
        if (constraints.tableTypeAllowed("VIEW")) {
            types.add("VIEW");
        }
        if (constraints.tableTypeAllowed("MATERIALIZED_VIEW")) {
            types.add("MATERIALIZED VIEW");
        }
        if (types.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND table_type IN (").append(MetadataSqlSupport.placeholders(types.size())).append(")");
        args.addAll(types);
    }

    private static String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private static boolean isNumericType(int sqlType) {
        switch (sqlType) {
            case Types.BIGINT:
            case Types.DECIMAL:
            case Types.DOUBLE:
            case Types.FLOAT:
            case Types.INTEGER:
            case Types.NUMERIC:
            case Types.REAL:
            case Types.SMALLINT:
            case Types.TINYINT:
                return true;
            default:
                return false;
        }
    }

    private static boolean isCharacterType(int sqlType) {
        switch (sqlType) {
            case Types.CHAR:
            case Types.LONGNVARCHAR:
            case Types.LONGVARCHAR:
            case Types.NCHAR:
            case Types.NVARCHAR:
            case Types.VARCHAR:
                return true;
            default:
                return false;
        }
    }

    private static Integer parseNumericPrecision(String dataType) {
        return firstIntGroup(NUMERIC_PRECISION_PATTERN, dataType, 2);
    }

    private static Integer parseNumericScale(String dataType) {
        return firstIntGroup(NUMERIC_SCALE_PATTERN, dataType, 1);
    }

    private static Integer parseCharacterMaximumLength(String dataType) {
        return firstIntGroup(CHARACTER_LENGTH_PATTERN, dataType, 2);
    }

    private static Integer firstIntGroup(Pattern pattern, String value, int group) {
        if (value == null) {
            return null;
        }
        Matcher matcher = pattern.matcher(value);
        if (!matcher.find()) {
            return null;
        }
        return Integer.valueOf(matcher.group(group));
    }

    private static Integer intOrNull(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value instanceof Number ? ((Number) value).intValue() : null;
    }

    private static String normalizeTableType(String type) {
        if ("BASE TABLE".equals(type)) {
            return "TABLE";
        }
        if ("MATERIALIZED VIEW".equals(type)) {
            return "MATERIALIZED_VIEW";
        }
        return type;
    }

    private static String blankToNull(String value) {
        return value == null || value.trim().isEmpty() ? null : value;
    }

    private static String coalesce(String value) {
        return value == null ? "" : value;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(TrinoAgent::new).run();
    }
}
