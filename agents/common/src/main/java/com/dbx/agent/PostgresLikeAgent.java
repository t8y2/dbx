package com.dbx.agent;

import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
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
            this::resetSchemaSQL,
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
            this::resetSchemaSQL,
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
            this::resetSchemaSQL,
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
                    return new SpatialValue(null, null);
                }
                return EwkbWktDecoder.decodeSpatial(raw);
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
            String sql = "SELECT datname FROM " + profile.catalogRelation("database") +
                " WHERE datistemplate = false ORDER BY datname";
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql);
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
                "FROM " + profile.catalogRelation("namespace") + " n " +
                "WHERE n.nspname NOT IN ('" + profile.getCatalogSchema() + "','information_schema','" + profile.getToastSchema() + "') " +
                "AND n.nspname NOT LIKE '" + profile.getToastTemporarySchemaPrefix() + "%' " +
                "AND n.nspname NOT LIKE '" + profile.getTemporarySchemaPrefix() + "%' " +
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
                profile.catalogBuiltinFunction("obj_description") + "(c.oid) AS table_comment " +
                "FROM " + profile.catalogRelation("class") + " c " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = c.relnamespace " +
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
                "FROM " + profile.catalogRelation("proc") + " p " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = p.pronamespace " +
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
                "FROM " + profile.catalogRelation("class") + " c " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = c.relnamespace " +
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
        TableAttributeCache attributeCache = profile.mapsCatalogAttributeArraysInJava()
            ? new TableAttributeCache(schema, table)
            : null;
        List<IndexInfo> indexes;
        try {
            indexes = attributeCache == null
                ? listIndexes(schema, table)
                : listIndexes(schema, table, attributeCache);
        } catch (RuntimeException e) {
            indexes = Collections.emptyList();
        }

        List<ForeignKeyInfo> foreignKeys;
        try {
            foreignKeys = attributeCache == null
                ? listForeignKeys(schema, table)
                : listForeignKeys(schema, table, attributeCache);
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
            attributeCache == null
                ? getColumns(schema, table)
                : getColumns(schema, table, attributeCache),
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
                "SELECT " + profile.catalogBuiltinFunction("obj_description") + "(c.oid) AS table_comment " +
                "FROM " + profile.catalogRelation("class") + " c " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = c.relnamespace " +
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
            String sql = "SELECT co.conname AS constraint_name, " +
                profile.catalogPrefixedFunction("get_constraintdef") + "(co.oid, true) AS constraint_definition " +
                "FROM " + profile.catalogRelation("constraint") + " co " +
                "JOIN " + profile.catalogRelation("class") + " c ON c.oid = co.conrelid " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = c.relnamespace " +
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
                sql = "SELECT " + profile.catalogPrefixedFunction("get_viewdef") + "(" +
                    profile.catalogBuiltinFunction("to_regclass") + "(?), true)";
            } else if ("FUNCTION".equals(upperType)) {
                sql = "SELECT " + profile.catalogPrefixedFunction("get_functiondef") + "(p.oid)\n" +
                    "FROM " + profile.catalogRelation("proc") + " p JOIN " +
                    profile.catalogRelation("namespace") + " n ON n.oid = p.pronamespace\n" +
                    "WHERE n.nspname = ? AND p.proname = ? AND p.prokind = 'f'\n" +
                    "ORDER BY p.oid LIMIT 1";
            } else if ("PROCEDURE".equals(upperType)) {
                sql = "SELECT " + profile.catalogPrefixedFunction("get_functiondef") + "(p.oid)\n" +
                    "FROM " + profile.catalogRelation("proc") + " p JOIN " +
                    profile.catalogRelation("namespace") + " n ON n.oid = p.pronamespace\n" +
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
        TableAttributeCache attributeCache = profile.mapsCatalogAttributeArraysInJava()
            ? new TableAttributeCache(schema, table)
            : null;
        return getColumns(schema, table, attributeCache);
    }

    private List<ColumnInfo> getColumns(
        String schema,
        String table,
        TableAttributeCache attributeCache
    ) {
        return unchecked(() -> {
            Set<String> primaryKeys = primaryKeys(schema, table, attributeCache);
            List<ColumnInfo> result = new ArrayList<>();
            String sql = "SELECT a.attname AS column_name, " +
                profile.catalogBuiltinFunction("format_type") + "(a.atttypid, a.atttypmod) AS data_type, " +
                "NOT a.attnotnull AS is_nullable, " +
                profile.catalogPrefixedFunction("get_expr") + "(ad.adbin, ad.adrelid) AS column_default, " +
                profile.catalogBuiltinFunction("col_description") + "(a.attrelid, a.attnum) AS column_comment, " +
                "CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 " +
                "THEN ((a.atttypmod - 4) >> 16) & 65535 ELSE NULL END AS numeric_precision, " +
                "CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 " +
                "THEN (a.atttypmod - 4) & 65535 ELSE NULL END AS numeric_scale, " +
                "CASE WHEN t.typname IN ('varchar', 'bpchar') AND a.atttypmod > 0 " +
                "THEN a.atttypmod - 4 ELSE NULL END AS character_maximum_length " +
                "FROM " + profile.catalogRelation("attribute") + " a " +
                "JOIN " + profile.catalogRelation("type") + " t ON t.oid = a.atttypid " +
                "JOIN " + profile.catalogRelation("class") + " c ON c.oid = a.attrelid " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = c.relnamespace " +
                "LEFT JOIN " + profile.catalogRelation("attrdef") + " ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum " +
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

    private Set<String> primaryKeys(
        String schema,
        String table,
        TableAttributeCache attributeCache
    ) {
        if (profile.mapsCatalogAttributeArraysInJava()) {
            return primaryKeysFromCatalogArrays(schema, table, attributeCache);
        }
        return unchecked(() -> {
            Set<String> primaryKeys = new LinkedHashSet<>();
            String sql = "SELECT a.attname AS column_name " +
                "FROM " + profile.catalogRelation("constraint") + " co " +
                "JOIN " + profile.catalogRelation("class") + " c ON c.oid = co.conrelid " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = c.relnamespace " +
                "JOIN LATERAL (SELECT unnest(co.conkey) AS attnum, generate_series(1, array_length(co.conkey, 1)) AS ord) AS pk_cols ON true " +
                "JOIN " + profile.catalogRelation("attribute") + " a ON a.attrelid = c.oid AND a.attnum = pk_cols.attnum " +
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

    private Set<String> primaryKeysFromCatalogArrays(
        String schema,
        String table,
        TableAttributeCache attributeCache
    ) {
        return unchecked(() -> {
            List<Integer> attributeNumbers = Collections.emptyList();
            String sql = "SELECT co.conkey AS column_numbers " +
                "FROM " + profile.catalogRelation("constraint") + " co " +
                "JOIN " + profile.catalogRelation("class") + " c ON c.oid = co.conrelid " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = c.relnamespace " +
                "WHERE co.contype = 'p' " +
                "AND n.nspname = ? " +
                "AND c.relname = ? " +
                "ORDER BY co.conname";
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    if (rs.next()) {
                        attributeNumbers = readAttributeNumbers(rs, "column_numbers");
                    }
                }
            }
            if (attributeNumbers.isEmpty()) {
                return new LinkedHashSet<>();
            }
            return new LinkedHashSet<>(mapRequiredAttributeNumbers(
                attributeNumbers,
                attributeCache.get()
            ));
        });
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        TableAttributeCache attributeCache = profile.mapsCatalogAttributeArraysInJava()
            ? new TableAttributeCache(schema, table)
            : null;
        return listIndexes(schema, table, attributeCache);
    }

    private List<IndexInfo> listIndexes(
        String schema,
        String table,
        TableAttributeCache attributeCache
    ) {
        if (profile.mapsCatalogAttributeArraysInJava()) {
            return listIndexesFromCatalogArrays(schema, table, attributeCache);
        }
        return unchecked(() -> {
            List<IndexInfo> result = new ArrayList<>();
            String sql = "SELECT i.relname AS index_name, am.amname AS index_type, " +
                "ix.indisunique AS is_unique, ix.indisprimary AS is_primary, " +
                "array_agg(a.attname ORDER BY k.n) AS columns " +
                "FROM " + profile.catalogRelation("index") + " ix " +
                "JOIN " + profile.catalogRelation("class") + " t ON t.oid = ix.indrelid " +
                "JOIN " + profile.catalogRelation("class") + " i ON i.oid = ix.indexrelid " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = t.relnamespace " +
                "JOIN " + profile.catalogRelation("am") + " am ON am.oid = i.relam " +
                "JOIN LATERAL (SELECT unnest(ix.indkey) AS attnum, generate_series(1, array_length(ix.indkey, 1)) AS n) AS k ON true " +
                "JOIN " + profile.catalogRelation("attribute") + " a ON a.attrelid = t.oid AND a.attnum = k.attnum " +
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

    private List<IndexInfo> listIndexesFromCatalogArrays(
        String schema,
        String table,
        TableAttributeCache attributeCache
    ) {
        return unchecked(() -> {
            List<CatalogIndex> catalogIndexes = new ArrayList<>();
            String sql = "SELECT i.relname AS index_name, am.amname AS index_type, " +
                "ix.indisunique AS is_unique, ix.indisprimary AS is_primary, " +
                "ix.indkey AS column_numbers " +
                "FROM " + profile.catalogRelation("index") + " ix " +
                "JOIN " + profile.catalogRelation("class") + " t ON t.oid = ix.indrelid " +
                "JOIN " + profile.catalogRelation("class") + " i ON i.oid = ix.indexrelid " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = t.relnamespace " +
                "JOIN " + profile.catalogRelation("am") + " am ON am.oid = i.relam " +
                "WHERE n.nspname = ? AND t.relname = ? " +
                "ORDER BY i.relname";
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        catalogIndexes.add(new CatalogIndex(
                            rs.getString("index_name"),
                            rs.getString("index_type"),
                            rs.getBoolean("is_unique"),
                            rs.getBoolean("is_primary"),
                            readAttributeNumbers(rs, "column_numbers")
                        ));
                    }
                }
            }
            if (catalogIndexes.isEmpty()) {
                return Collections.emptyList();
            }

            Map<Integer, String> attributes = attributeCache.get();
            List<IndexInfo> result = new ArrayList<>();
            for (CatalogIndex index : catalogIndexes) {
                List<String> columns = mapRequiredAttributeNumbers(index.attributeNumbers, attributes);
                if (columns.isEmpty()) {
                    continue;
                }
                result.add(new IndexInfo(
                    index.name,
                    columns,
                    index.unique,
                    index.primary,
                    null,
                    index.type,
                    null,
                    null
                ));
            }
            return result;
        });
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        TableAttributeCache attributeCache = profile.mapsCatalogAttributeArraysInJava()
            ? new TableAttributeCache(schema, table)
            : null;
        return listForeignKeys(schema, table, attributeCache);
    }

    private List<ForeignKeyInfo> listForeignKeys(
        String schema,
        String table,
        TableAttributeCache attributeCache
    ) {
        if (profile.mapsCatalogAttributeArraysInJava()) {
            return listForeignKeysFromCatalogArrays(schema, table, attributeCache);
        }
        return unchecked(() -> {
            List<ForeignKeyInfo> result = new ArrayList<>();
            String sql = "SELECT co.conname AS constraint_name, " +
                "a.attname AS column_name, " +
                "rc.relname AS ref_table, " +
                "ra.attname AS ref_column " +
                "FROM " + profile.catalogRelation("constraint") + " co " +
                "JOIN " + profile.catalogRelation("class") + " c ON c.oid = co.conrelid " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = c.relnamespace " +
                "JOIN " + profile.catalogRelation("class") + " rc ON rc.oid = co.confrelid " +
                "JOIN LATERAL (SELECT unnest(co.conkey) AS attnum, generate_series(1, array_length(co.conkey, 1)) AS ord) AS fk ON true " +
                "JOIN " + profile.catalogRelation("attribute") + " a ON a.attrelid = c.oid AND a.attnum = fk.attnum " +
                "JOIN LATERAL (SELECT unnest(co.confkey) AS attnum, generate_series(1, array_length(co.confkey, 1)) AS ord) AS pk ON pk.ord = fk.ord " +
                "JOIN " + profile.catalogRelation("attribute") + " ra ON ra.attrelid = rc.oid AND ra.attnum = pk.attnum " +
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

    private List<ForeignKeyInfo> listForeignKeysFromCatalogArrays(
        String schema,
        String table,
        TableAttributeCache attributeCache
    ) {
        return unchecked(() -> {
            List<CatalogForeignKey> catalogForeignKeys = new ArrayList<>();
            String sql = "SELECT co.conname AS constraint_name, " +
                "co.conkey AS column_numbers, co.confkey AS ref_column_numbers, " +
                "rc.relname AS ref_table, rc.oid AS ref_table_oid " +
                "FROM " + profile.catalogRelation("constraint") + " co " +
                "JOIN " + profile.catalogRelation("class") + " c ON c.oid = co.conrelid " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = c.relnamespace " +
                "JOIN " + profile.catalogRelation("class") + " rc ON rc.oid = co.confrelid " +
                "WHERE co.contype = 'f' " +
                "AND n.nspname = ? " +
                "AND c.relname = ? " +
                "ORDER BY co.conname";
            try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        Object refTableOid = rs.getObject("ref_table_oid");
                        catalogForeignKeys.add(new CatalogForeignKey(
                            rs.getString("constraint_name"),
                            rs.getString("ref_table"),
                            refTableOid instanceof Number
                                ? ((Number) refTableOid).longValue()
                                : Long.parseLong(String.valueOf(refTableOid)),
                            readAttributeNumbers(rs, "column_numbers"),
                            readAttributeNumbers(rs, "ref_column_numbers")
                        ));
                    }
                }
            }
            if (catalogForeignKeys.isEmpty()) {
                return Collections.emptyList();
            }

            Map<Integer, String> attributes = attributeCache.get();
            Set<Long> referencedRelationOids = new LinkedHashSet<>();
            for (CatalogForeignKey foreignKey : catalogForeignKeys) {
                if (!foreignKey.attributeNumbers.isEmpty()
                    && foreignKey.attributeNumbers.size() == foreignKey.refAttributeNumbers.size()) {
                    referencedRelationOids.add(foreignKey.refTableOid);
                }
            }
            Map<Long, Map<Integer, String>> referencedAttributes = relationAttributeNames(referencedRelationOids);
            List<ForeignKeyInfo> result = new ArrayList<>();
            for (CatalogForeignKey foreignKey : catalogForeignKeys) {
                if (foreignKey.attributeNumbers.isEmpty()
                    || foreignKey.attributeNumbers.size() != foreignKey.refAttributeNumbers.size()) {
                    continue;
                }
                Map<Integer, String> refAttributes = referencedAttributes.get(foreignKey.refTableOid);
                if (refAttributes == null) {
                    continue;
                }
                List<String> columns = mapRequiredAttributeNumbers(
                    foreignKey.attributeNumbers,
                    attributes
                );
                List<String> refColumns = mapRequiredAttributeNumbers(
                    foreignKey.refAttributeNumbers,
                    refAttributes
                );
                if (columns.isEmpty() || refColumns.isEmpty()) {
                    continue;
                }
                for (int columnIndex = 0; columnIndex < columns.size(); columnIndex++) {
                    result.add(new ForeignKeyInfo(
                        foreignKey.name,
                        columns.get(columnIndex),
                        foreignKey.refTable,
                        refColumns.get(columnIndex)
                    ));
                }
            }
            return result;
        });
    }

    private Map<Integer, String> tableAttributeNames(String schema, String table) throws java.sql.SQLException {
        Map<Integer, String> result = new LinkedHashMap<>();
        String sql = "SELECT a.attnum AS attribute_number, a.attname AS column_name " +
            "FROM " + profile.catalogRelation("attribute") + " a " +
            "JOIN " + profile.catalogRelation("class") + " c ON c.oid = a.attrelid " +
            "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = c.relnamespace " +
            "WHERE n.nspname = ? AND c.relname = ? " +
            "AND a.attnum > 0 AND NOT a.attisdropped " +
            "ORDER BY a.attnum";
        try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
            stmt.setString(1, schema);
            stmt.setString(2, table);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    result.put(rs.getInt("attribute_number"), rs.getString("column_name"));
                }
            }
        }
        return result;
    }

    private Map<Long, Map<Integer, String>> relationAttributeNames(Set<Long> relationOids)
        throws java.sql.SQLException {
        if (relationOids.isEmpty()) {
            return Collections.emptyMap();
        }

        StringBuilder placeholders = new StringBuilder();
        for (int relationIndex = 0; relationIndex < relationOids.size(); relationIndex++) {
            if (relationIndex > 0) {
                placeholders.append(", ");
            }
            placeholders.append("?");
        }

        Map<Long, Map<Integer, String>> result = new LinkedHashMap<>();
        String sql = "SELECT a.attrelid AS relation_oid, " +
            "a.attnum AS attribute_number, a.attname AS column_name " +
            "FROM " + profile.catalogRelation("attribute") + " a " +
            "WHERE a.attrelid IN (" + placeholders + ") " +
            "AND a.attnum > 0 AND NOT a.attisdropped " +
            "ORDER BY a.attrelid, a.attnum";
        try (java.sql.PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
            int parameterIndex = 1;
            for (Long relationOid : relationOids) {
                stmt.setLong(parameterIndex, relationOid);
                parameterIndex += 1;
            }
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    long relationOid = rs.getLong("relation_oid");
                    Map<Integer, String> attributes = result.get(relationOid);
                    if (attributes == null) {
                        attributes = new LinkedHashMap<>();
                        result.put(relationOid, attributes);
                    }
                    attributes.put(rs.getInt("attribute_number"), rs.getString("column_name"));
                }
            }
        }
        return result;
    }

    private static List<String> mapRequiredAttributeNumbers(
        List<Integer> attributeNumbers,
        Map<Integer, String> attributes
    ) {
        List<String> result = new ArrayList<>();
        for (Integer attributeNumber : attributeNumbers) {
            if (attributeNumber == null || attributeNumber <= 0) {
                return Collections.emptyList();
            }
            String attribute = attributes.get(attributeNumber);
            if (attribute == null) {
                return Collections.emptyList();
            }
            result.add(attribute);
        }
        return result.size() == attributeNumbers.size()
            ? result
            : Collections.emptyList();
    }

    private static List<Integer> readAttributeNumbers(ResultSet rs, String columnName)
        throws java.sql.SQLException {
        Object rawValue = null;
        java.sql.Array sqlArray = null;
        try {
            sqlArray = rs.getArray(columnName);
            if (sqlArray != null) {
                rawValue = sqlArray.getArray();
            }
        } catch (java.sql.SQLException | UnsupportedOperationException | IncompatibleClassChangeError ignored) {
        } finally {
            if (sqlArray != null) {
                freeSqlArray(sqlArray);
            }
        }
        if (rawValue == null) {
            try {
                rawValue = rs.getObject(columnName);
            } catch (java.sql.SQLException | UnsupportedOperationException | IncompatibleClassChangeError ignored) {
            }
        }
        if (rawValue == null) {
            rawValue = rs.getString(columnName);
        }
        return parseAttributeNumbers(rawValue);
    }

    private static List<Integer> parseAttributeNumbers(Object rawValue) throws java.sql.SQLException {
        if (rawValue == null) {
            return Collections.emptyList();
        }
        if (rawValue instanceof java.sql.Array) {
            java.sql.Array sqlArray = (java.sql.Array) rawValue;
            try {
                return parseAttributeNumbers(sqlArray.getArray());
            } finally {
                freeSqlArray(sqlArray);
            }
        }

        List<Integer> result = new ArrayList<>();
        if (rawValue.getClass().isArray()) {
            int length = java.lang.reflect.Array.getLength(rawValue);
            for (int arrayIndex = 0; arrayIndex < length; arrayIndex++) {
                appendAttributeNumbers(result, java.lang.reflect.Array.get(rawValue, arrayIndex));
            }
            return result;
        }
        appendAttributeNumbers(result, rawValue);
        return result;
    }

    private static void freeSqlArray(java.sql.Array sqlArray) {
        try {
            sqlArray.free();
        } catch (java.sql.SQLException | UnsupportedOperationException | IncompatibleClassChangeError ignored) {
        }
    }

    private static void appendAttributeNumbers(List<Integer> result, Object rawValue) {
        if (rawValue == null) {
            return;
        }
        if (rawValue instanceof Number) {
            result.add(((Number) rawValue).intValue());
            return;
        }
        java.util.regex.Matcher matcher = java.util.regex.Pattern
            .compile("-?\\d+")
            .matcher(String.valueOf(rawValue));
        while (matcher.find()) {
            result.add(Integer.parseInt(matcher.group()));
        }
    }

    private final class TableAttributeCache {
        private final String schema;
        private final String table;
        private Map<Integer, String> attributes;

        private TableAttributeCache(String schema, String table) {
            this.schema = schema;
            this.table = table;
        }

        private Map<Integer, String> get() throws java.sql.SQLException {
            if (attributes == null) {
                attributes = tableAttributeNames(schema, table);
            }
            return attributes;
        }
    }

    private static final class CatalogIndex {
        private final String name;
        private final String type;
        private final boolean unique;
        private final boolean primary;
        private final List<Integer> attributeNumbers;

        private CatalogIndex(
            String name,
            String type,
            boolean unique,
            boolean primary,
            List<Integer> attributeNumbers
        ) {
            this.name = name;
            this.type = type;
            this.unique = unique;
            this.primary = primary;
            this.attributeNumbers = attributeNumbers;
        }
    }

    private static final class CatalogForeignKey {
        private final String name;
        private final String refTable;
        private final long refTableOid;
        private final List<Integer> attributeNumbers;
        private final List<Integer> refAttributeNumbers;

        private CatalogForeignKey(
            String name,
            String refTable,
            long refTableOid,
            List<Integer> attributeNumbers,
            List<Integer> refAttributeNumbers
        ) {
            this.name = name;
            this.refTable = refTable;
            this.refTableOid = refTableOid;
            this.attributeNumbers = attributeNumbers;
            this.refAttributeNumbers = refAttributeNumbers;
        }
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
                "FROM " + profile.catalogRelation("trigger") + " tg " +
                "JOIN " + profile.catalogRelation("class") + " c ON c.oid = tg.tgrelid " +
                "JOIN " + profile.catalogRelation("namespace") + " n ON n.oid = c.relnamespace " +
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

    @Override
    public String resetSchemaSQL() {
        return "RESET search_path";
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
