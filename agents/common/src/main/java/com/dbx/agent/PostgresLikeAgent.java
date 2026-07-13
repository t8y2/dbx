package com.dbx.agent;

import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public abstract class PostgresLikeAgent extends AbstractJdbcAgent {
    private final PostgresLikeAgentProfile profile;
    private boolean mysqlCompatMode = false;

    protected PostgresLikeAgent(PostgresLikeAgentProfile profile) {
        this.profile = profile;
    }

    public PostgresLikeAgentProfile getProfile() {
        return profile;
    }

    public void setMysqlCompatMode(boolean mysqlCompatMode) {
        this.mysqlCompatMode = mysqlCompatMode;
    }

    public boolean isMysqlCompatMode() {
        return mysqlCompatMode;
    }

    @Override
    public String getIdentifierQuote() {
        return mysqlCompatMode ? "`" : super.getIdentifierQuote();
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
            geometryAwareResolver()
        );
    }

    @Override
    public QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        return JdbcExecutor.current().executePage(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            options,
            geometryAwareResolver()
        );
    }

    @Override
    public QueryPageResult startTableRead(String sql, String schema, QueryPageOptions options) {
        return JdbcExecutor.current().startTableRead(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            options,
            geometryAwareResolver()
        );
    }

    /**
     * Wrap {@link AbstractJdbcAgent#resultValue} so PostGIS-style {@code geometry}
     * and {@code geography} columns are decoded into WKT (matching the native
     * tokio_postgres path in {@code crates/dbx-core/src/db/postgres.rs}).
     */
    private JdbcExecutor.ColumnAwareResultValueReader geometryAwareResolver() {
        return (rs, index, sqlType, columnTypeName) -> {
            if (isPostgisGeometryTypeName(columnTypeName)) {
                Object raw = rs.getObject(index);
                if (rs.wasNull() || raw == null) {
                    return null;
                }
                return EwkbWktDecoder.decode(raw);
            }
            return resultValue(rs, index, sqlType, columnTypeName);
        };
    }

    protected Object resultValue(ResultSet rs, int index, int sqlType, String columnTypeName) {
        return resultValue(rs, index, sqlType);
    }

    static boolean isPostgisGeometryTypeName(String columnTypeName) {
        if (columnTypeName == null) {
            return false;
        }
        String trimmed = columnTypeName.trim().toLowerCase(Locale.ROOT);
        if (trimmed.isEmpty()) {
            return false;
        }
        // Strip optional schema prefix (e.g. "public.geometry") or "(srid,type)" suffix.
        int dot = trimmed.lastIndexOf('.');
        if (dot >= 0 && dot < trimmed.length() - 1) {
            trimmed = trimmed.substring(dot + 1);
        }
        int paren = trimmed.indexOf('(');
        if (paren >= 0) {
            trimmed = trimmed.substring(0, paren);
        }
        return "geometry".equals(trimmed) || "geography".equals(trimmed);
    }

    private String quoteIdentifier(String identifier) {
        return mysqlCompatMode
            ? JdbcIdentifiers.INSTANCE.backtick(identifier)
            : JdbcIdentifiers.INSTANCE.doubleQuote(identifier);
    }

    @Override
    protected String driverClass() {
        return profile.getDriverClass();
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return profile.buildUrl(params);
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            List<DatabaseInfo> result = new ArrayList<>();
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
                 ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    result.add(new DatabaseInfo(rs.getString("datname")));
                }
            }
            return result;
        });
    }

    @Override
    public List<String> listSchemas() {
        return unchecked(() -> {
            List<String> result = new ArrayList<>();
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(
                "SELECT n.nspname AS schema_name " +
                "FROM pg_catalog.pg_namespace n " +
                "WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') " +
                "AND n.nspname NOT LIKE 'pg_toast_temp_%' " +
                "AND n.nspname NOT LIKE 'pg_temp_%' " +
                "ORDER BY n.nspname"
            ); ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    result.add(rs.getString("schema_name"));
                }
            }
            return result;
        });
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(
                "SELECT c.relname AS table_name, " +
                "CASE c.relkind " +
                "WHEN 'r' THEN 'TABLE' " +
                "WHEN 'p' THEN 'TABLE' " +
                "WHEN 'v' THEN 'VIEW' " +
                "WHEN 'm' THEN 'MATERIALIZED VIEW' " +
                "WHEN 'f' THEN 'FOREIGN TABLE' " +
                "ELSE 'TABLE' END AS table_type, " +
                "obj_description(c.oid) AS table_comment " +
                "FROM pg_catalog.pg_class c " +
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
                "WHERE n.nspname = ? AND c.relkind IN ('r','p','v','m','f') " +
                "ORDER BY c.relname"
            )) {
                stmt.setString(1, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String tableType = normalizeTableType(rs.getString("table_type"));
                        result.add(new TableInfo(rs.getString("table_name"), tableType, rs.getString("table_comment")));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return unchecked(() -> {
            List<ObjectInfo> result = new ArrayList<>();
            for (TableInfo table : listTables(schema)) {
                result.add(new ObjectInfo(table.getName(), table.getTable_type(), schema, table.getComment()));
            }
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(
                "SELECT p.proname AS routine_name, " +
                "CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type " +
                "FROM pg_catalog.pg_proc p " +
                "JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace " +
                "WHERE n.nspname = ? AND p.prokind IN ('p','f') " +
                "ORDER BY p.proname"
            )) {
                stmt.setString(1, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString(1), rs.getString(2), schema, null));
                    }
                }
            }
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(
                "SELECT c.relname AS sequence_name, 'SEQUENCE' AS object_type " +
                "FROM pg_catalog.pg_class c " +
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
                "WHERE n.nspname = ? AND c.relkind = 'S' " +
                "ORDER BY c.relname"
            )) {
                stmt.setString(1, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString(1), rs.getString(2), schema, null));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public String getTableDdl(String schema, String table) {
        List<IndexInfo> indexes;
        try {
            indexes = listIndexes(schema, table);
        } catch (RuntimeException e) {
            indexes = Collections.emptyList();
        }

        List<ForeignKeyInfo> foreignKeys;
        try {
            foreignKeys = listForeignKeys(schema, table);
        } catch (RuntimeException e) {
            foreignKeys = Collections.emptyList();
        }

        List<CheckConstraintInfo> checkConstraints;
        try {
            checkConstraints = listCheckConstraints(schema, table);
        } catch (RuntimeException e) {
            // Some PostgreSQL-compatible databases expose incomplete catalog APIs.
            // DDL generation should still succeed with columns, indexes, and foreign keys.
            checkConstraints = Collections.emptyList();
        }

        String tableComment = null;
        try {
            tableComment = getTableComment(schema, table);
        } catch (RuntimeException e) {
            // Table comment is optional; DDL generation should still succeed without it.
        }

        return DdlBuilder.buildTableDdl(
            schema,
            table,
            getColumns(schema, table),
            indexes,
            foreignKeys,
            checkConstraints,
            mysqlCompatMode,
            true,
            tableComment
        );
    }

    @Override
    public String getTableComment(String schema, String table) {
        return unchecked(() -> {
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(
                "SELECT obj_description(c.oid) AS table_comment " +
                "FROM pg_catalog.pg_class c " +
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
                "WHERE n.nspname = ? AND c.relname = ? AND c.relkind IN ('r','m','f','p') " +
                "LIMIT 1"
            )) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    if (rs.next()) {
                        String comment = rs.getString("table_comment");
                        return (comment != null && !comment.trim().isEmpty()) ? comment : null;
                    }
                }
            }
            return null;
        });
    }

    protected List<CheckConstraintInfo> listCheckConstraints(String schema, String table) {
        return unchecked(() -> {
            List<CheckConstraintInfo> result = new ArrayList<>();
            String sql = "SELECT co.conname AS constraint_name, pg_catalog.pg_get_constraintdef(co.oid, true) AS constraint_definition " +
                "FROM pg_catalog.pg_constraint co " +
                "JOIN pg_catalog.pg_class c ON c.oid = co.conrelid " +
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
                "WHERE co.contype = 'c' AND n.nspname = ? AND c.relname = ? " +
                "ORDER BY co.conname";
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new CheckConstraintInfo(
                            rs.getString("constraint_name"),
                            rs.getString("constraint_definition")
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        return unchecked(() -> {
            String upperType = objectType.toUpperCase();
            String sql;
            if ("VIEW".equals(upperType) || "MATERIALIZED VIEW".equals(upperType)) {
                sql = "SELECT pg_get_viewdef(to_regclass(?), true)";
            } else if ("FUNCTION".equals(upperType)) {
                sql = "SELECT pg_get_functiondef(p.oid)\n" +
                    "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace\n" +
                    "WHERE n.nspname = ? AND p.proname = ? AND p.prokind = 'f'\n" +
                    "ORDER BY p.oid LIMIT 1";
            } else if ("PROCEDURE".equals(upperType)) {
                sql = "SELECT pg_get_functiondef(p.oid)\n" +
                    "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace\n" +
                    "WHERE n.nspname = ? AND p.proname = ? AND p.prokind = 'p'\n" +
                    "ORDER BY p.oid LIMIT 1";
            } else {
                throw new IllegalArgumentException("Unsupported object type: " + objectType);
            }

            String source;
            if ("VIEW".equals(upperType) || "MATERIALIZED VIEW".equals(upperType)) {
                try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                    stmt.setString(1, quoteQualifiedIdentifier(schema, name));
                    try (ResultSet rs = stmt.executeQuery()) {
                        source = rs.next() ? coalesce(rs.getString(1)) : "";
                    }
                }
            } else {
                try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                    stmt.setString(1, schema);
                    stmt.setString(2, name);
                    try (ResultSet rs = stmt.executeQuery()) {
                        source = rs.next() ? coalesce(rs.getString(1)) : "";
                    }
                }
            }
            return new ObjectSource(name, objectType, schema, source);
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            Set<String> primaryKeys = primaryKeys(schema, table);
            List<ColumnInfo> result = new ArrayList<>();
            String sql = "SELECT a.attname AS column_name, " +
                "format_type(a.atttypid, a.atttypmod) AS data_type, " +
                "NOT a.attnotnull AS is_nullable, " +
                "pg_get_expr(ad.adbin, ad.adrelid) AS column_default, " +
                "col_description(a.attrelid, a.attnum) AS column_comment, " +
                "CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 " +
                "THEN ((a.atttypmod - 4) >> 16) & 65535 ELSE NULL END AS numeric_precision, " +
                "CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 " +
                "THEN (a.atttypmod - 4) & 65535 ELSE NULL END AS numeric_scale, " +
                "CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 0 " +
                "THEN a.atttypmod - 4 ELSE NULL END AS character_maximum_length " +
                "FROM pg_catalog.pg_attribute a " +
                "JOIN pg_catalog.pg_type t ON t.oid = a.atttypid " +
                "JOIN pg_catalog.pg_class c ON c.oid = a.attrelid " +
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
                "LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum " +
                "WHERE n.nspname = ? AND c.relname = ? " +
                "AND a.attnum > 0 AND NOT a.attisdropped " +
                "ORDER BY a.attnum";
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String colName = rs.getString("column_name");
                        result.add(new ColumnInfo(
                            colName,
                            rs.getString("data_type"),
                            rs.getBoolean("is_nullable"),
                            rs.getString("column_default"),
                            primaryKeys.contains(colName),
                            null,
                            rs.getString("column_comment"),
                            intObject(rs, "numeric_precision"),
                            intObject(rs, "numeric_scale"),
                            intObject(rs, "character_maximum_length")
                        ));
                    }
                }
            }
            return result;
        });
    }

    private Set<String> primaryKeys(String schema, String table) {
        return unchecked(() -> {
            Set<String> primaryKeys = new LinkedHashSet<>();
            String sql = "SELECT a.attname AS column_name " +
                "FROM pg_catalog.pg_constraint co " +
                "JOIN pg_catalog.pg_class c ON c.oid = co.conrelid " +
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
                "JOIN LATERAL (SELECT unnest(co.conkey) AS attnum, generate_series(1, array_length(co.conkey, 1)) AS ord) AS pk_cols ON true " +
                "JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = pk_cols.attnum " +
                "WHERE co.contype = 'p' " +
                "AND n.nspname = ? " +
                "AND c.relname = ? " +
                "ORDER BY pk_cols.ord";
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        primaryKeys.add(rs.getString("column_name"));
                    }
                }
            }
            return primaryKeys;
        });
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return unchecked(() -> {
            List<IndexInfo> result = new ArrayList<>();
            String sql = "SELECT i.relname AS index_name, am.amname AS index_type, " +
                "ix.indisunique AS is_unique, ix.indisprimary AS is_primary, " +
                "array_agg(a.attname ORDER BY k.n) AS columns " +
                "FROM pg_index ix " +
                "JOIN pg_class t ON t.oid = ix.indrelid " +
                "JOIN pg_class i ON i.oid = ix.indexrelid " +
                "JOIN pg_namespace n ON n.oid = t.relnamespace " +
                "JOIN pg_am am ON am.oid = i.relam " +
                "JOIN LATERAL (SELECT unnest(ix.indkey) AS attnum, generate_series(1, array_length(ix.indkey, 1)) AS n) AS k ON true " +
                "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum " +
                "WHERE n.nspname = ? AND t.relname = ? " +
                "GROUP BY i.relname, am.amname, ix.indisunique, ix.indisprimary " +
                "ORDER BY i.relname";
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        Object[] columnArray = (Object[]) rs.getArray("columns").getArray();
                        List<String> columns = new ArrayList<>();
                        for (Object column : columnArray) {
                            columns.add(String.valueOf(column));
                        }
                        result.add(new IndexInfo(
                            rs.getString("index_name"),
                            columns,
                            rs.getBoolean("is_unique"),
                            rs.getBoolean("is_primary"),
                            null,
                            rs.getString("index_type"),
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
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return unchecked(() -> {
            List<ForeignKeyInfo> result = new ArrayList<>();
            String sql = "SELECT co.conname AS constraint_name, " +
                "a.attname AS column_name, " +
                "rc.relname AS ref_table, " +
                "ra.attname AS ref_column " +
                "FROM pg_catalog.pg_constraint co " +
                "JOIN pg_catalog.pg_class c ON c.oid = co.conrelid " +
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
                "JOIN pg_catalog.pg_class rc ON rc.oid = co.confrelid " +
                "JOIN LATERAL (SELECT unnest(co.conkey) AS attnum, generate_series(1, array_length(co.conkey, 1)) AS ord) AS fk ON true " +
                "JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = fk.attnum " +
                "JOIN LATERAL (SELECT unnest(co.confkey) AS attnum, generate_series(1, array_length(co.confkey, 1)) AS ord) AS pk ON pk.ord = fk.ord " +
                "JOIN pg_catalog.pg_attribute ra ON ra.attrelid = rc.oid AND ra.attnum = pk.attnum " +
                "WHERE co.contype = 'f' " +
                "AND n.nspname = ? " +
                "AND c.relname = ? " +
                "ORDER BY co.conname, fk.ord";
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ForeignKeyInfo(
                            rs.getString("constraint_name"),
                            rs.getString("column_name"),
                            rs.getString("ref_table"),
                            rs.getString("ref_column")
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        return unchecked(() -> {
            List<TriggerInfo> result = new ArrayList<>();
            String sql = "SELECT tg.tgname AS trigger_name, " +
                "trim(trailing ',' FROM (" +
                "CASE WHEN (tg.tgtype & 4) <> 0 THEN 'INSERT,' ELSE '' END || " +
                "CASE WHEN (tg.tgtype & 8) <> 0 THEN 'DELETE,' ELSE '' END || " +
                "CASE WHEN (tg.tgtype & 16) <> 0 THEN 'UPDATE,' ELSE '' END || " +
                "CASE WHEN (tg.tgtype & 32) <> 0 THEN 'TRUNCATE,' ELSE '' END" +
                ")) AS event_manipulation, " +
                "CASE WHEN (tg.tgtype & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS action_timing " +
                "FROM pg_catalog.pg_trigger tg " +
                "JOIN pg_catalog.pg_class c ON c.oid = tg.tgrelid " +
                "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
                "WHERE n.nspname = ? AND c.relname = ? AND NOT tg.tgisinternal " +
                "ORDER BY tg.tgname";
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TriggerInfo(
                            rs.getString("trigger_name"),
                            rs.getString("event_manipulation"),
                            rs.getString("action_timing")
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "SET search_path TO " + quoteIdentifier(schema);
    }

    private java.sql.Connection requireConnection() {
        return requireConnected();
    }

    private static String normalizeTableType(String type) {
        if (type == null || type.trim().isEmpty()) return "TABLE";
        if ("BASE TABLE".equals(type)) return "TABLE";
        return type;
    }

    private static String coalesce(String value) {
        return value == null ? "" : value;
    }

    private String quoteQualifiedIdentifier(String schema, String name) {
        return quoteIdentifier(schema) + "." + quoteIdentifier(name);
    }

    private static Integer intObject(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value instanceof Number ? ((Number) value).intValue() : null;
    }
}
