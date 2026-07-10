package com.dbx.agent;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
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

public final class StandardJdbcMetadata {
    public static final StandardJdbcMetadata INSTANCE = new StandardJdbcMetadata();

    private StandardJdbcMetadata() {
    }

    public List<DatabaseInfo> listDatabases(Connection conn, String configuredDatabase) {
        return unchecked(() -> {
            Set<String> names = new LinkedHashSet<>();
            try {
                try (ResultSet rs = conn.getMetaData().getCatalogs()) {
                    while (rs.next()) {
                        addNonBlank(names, rs.getString("TABLE_CAT"));
                    }
                }
            } catch (Exception ignored) {
            }
            addNonBlank(names, configuredDatabase);
            addNonBlank(names, conn.getCatalog());

            List<DatabaseInfo> result = new ArrayList<>();
            for (String name : names) {
                result.add(new DatabaseInfo(name));
            }
            return result;
        });
    }

    public List<String> listSchemas(Connection conn, JdbcAgentProfile profile) {
        return unchecked(() -> {
            Set<String> names = new LinkedHashSet<>();
            DatabaseMetaData meta = conn.getMetaData();
            try {
                appendSchemas(names, meta.getSchemas(null, null));
            } catch (Exception | AbstractMethodError first) {
                try {
                    appendSchemas(names, meta.getSchemas());
                } catch (Exception | AbstractMethodError ignored) {
                }
            }
            try {
                addNonBlank(names, conn.getSchema());
            } catch (Exception | AbstractMethodError ignored) {
            }

            List<String> result = new ArrayList<>();
            for (String name : names) {
                if (!profile.getExcludedSchemas().contains(name.toUpperCase(Locale.ROOT))) {
                    result.add(name);
                }
            }
            Collections.sort(result);
            return result;
        });
    }

    public List<TableInfo> listTables(Connection conn, JdbcAgentProfile profile, String configuredDatabase, String schema) {
        return listTables(conn, profile, configuredDatabase, schema, MetadataListConstraints.NONE);
    }

    public List<TableInfo> listTables(
        Connection conn,
        JdbcAgentProfile profile,
        String configuredDatabase,
        String schema,
        MetadataListConstraints constraints
    ) {
        return unchecked(() -> {
            MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
            if (!normalized.includesTableLikeTypes()) {
                return Collections.emptyList();
            }
            DatabaseMetaData meta = conn.getMetaData();
            List<TableInfo> result = new ArrayList<>();
            appendTables(result, meta, profile, null, schema, normalized);
            if (result.isEmpty() && profile.getCatalogFallbackEnabled() && !configuredDatabase.trim().isEmpty()) {
                appendTables(result, meta, profile, configuredDatabase, schema, normalized);
            }
            result.sort(Comparator.comparing(TableInfo::getName));
            return normalized.filterTables(result);
        });
    }

    public List<ObjectInfo> listObjects(List<TableInfo> tables, String schema) {
        return listObjects(tables, schema, MetadataListConstraints.NONE);
    }

    public List<ObjectInfo> listObjects(List<TableInfo> tables, String schema, MetadataListConstraints constraints) {
        List<ObjectInfo> result = new ArrayList<>();
        for (TableInfo table : tables) {
            result.add(new ObjectInfo(table.getName(), table.getTable_type(), schema, table.getComment()));
        }
        return MetadataListConstraints.orNone(constraints).filterObjects(result);
    }

    public List<String> listDataTypes(Connection conn) {
        return unchecked(() -> {
            Set<String> seen = new LinkedHashSet<>();
            List<String> names = new ArrayList<>();
            try (ResultSet rs = conn.getMetaData().getTypeInfo()) {
                while (rs.next()) {
                    String name = rs.getString("TYPE_NAME");
                    if (name == null || name.trim().isEmpty()) {
                        continue;
                    }
                    String trimmed = name.trim();
                    if (seen.add(trimmed.toLowerCase(Locale.ROOT))) {
                        names.add(trimmed);
                    }
                }
            }
            return names;
        });
    }

    public CompletionAssistantResponse completionAssistantSearch(
        Connection conn,
        JdbcAgentProfile profile,
        String configuredDatabase,
        CompletionAssistantRequest request
    ) {
        return unchecked(() -> {
            int limit = boundedLimit(request.getMax_results());
            List<CompletionAssistantCandidate> candidates = new ArrayList<>();
            List<CompletionAssistantObjectKind> kinds = normalizedObjectKinds(request);
            DatabaseMetaData meta = conn.getMetaData();
            String catalog = blankToNull(request.getDatabase());
            String schema = completionSchema(request);

            if (containsKind(kinds, CompletionAssistantObjectKind.SCHEMA)) {
                appendCompletionSchemas(candidates, meta, profile, request, limit);
            }
            if (candidates.size() < limit && containsTableLike(kinds)) {
                appendCompletionTables(candidates, meta, profile, catalog, schema, request, kinds, limit);
                if (candidates.isEmpty() && profile.getCatalogFallbackEnabled() && configuredDatabase != null && !configuredDatabase.trim().isEmpty()) {
                    appendCompletionTables(candidates, meta, profile, configuredDatabase, schema, request, kinds, limit);
                }
            }
            if (candidates.size() < limit && containsKind(kinds, CompletionAssistantObjectKind.COLUMN)) {
                appendCompletionColumns(candidates, meta, catalog, schema, request, limit);
                if (candidates.isEmpty() && profile.getCatalogFallbackEnabled() && configuredDatabase != null && !configuredDatabase.trim().isEmpty()) {
                    appendCompletionColumns(candidates, meta, configuredDatabase, schema, request, limit);
                }
            }

            return new CompletionAssistantResponse(candidates, candidates.size() >= limit, false);
        });
    }

    public List<ColumnInfo> getColumns(Connection conn, JdbcAgentProfile profile, String configuredDatabase, String schema, String table) {
        return unchecked(() -> {
            DatabaseMetaData meta = conn.getMetaData();
            Set<String> primaryKeys = primaryKeys(meta, null, schema, table);
            List<ColumnInfo> result = new ArrayList<>();
            appendColumns(result, meta, null, schema, table, primaryKeys);
            if (!result.isEmpty() && primaryKeys.isEmpty() && profile.getCatalogFallbackEnabled() && hasConfiguredDatabase(configuredDatabase)) {
                Set<String> fallbackPrimaryKeys = primaryKeys(meta, configuredDatabase, schema, table);
                markPrimaryKeys(result, fallbackPrimaryKeys);
            }
            if (result.isEmpty() && profile.getCatalogFallbackEnabled() && hasConfiguredDatabase(configuredDatabase)) {
                Set<String> fallbackPrimaryKeys = primaryKeys(meta, configuredDatabase, schema, table);
                appendColumns(result, meta, configuredDatabase, schema, table, fallbackPrimaryKeys);
            }
            return result;
        });
    }

    public List<IndexInfo> listIndexes(Connection conn, String schema, String table) {
        return unchecked(() -> {
            DatabaseMetaData meta = conn.getMetaData();
            Map<String, List<IndexColumn>> indexes = new LinkedHashMap<>();
            Map<String, Boolean> unique = new LinkedHashMap<>();
            try (ResultSet rs = meta.getIndexInfo(null, blankToNull(schema), table, false, false)) {
                while (rs.next()) {
                    String name = rs.getString("INDEX_NAME");
                    String column = rs.getString("COLUMN_NAME");
                    if (name == null || column == null) {
                        continue;
                    }
                    indexes.computeIfAbsent(name, ignored -> new ArrayList<>()).add(
                        new IndexColumn(rs.getShort("ORDINAL_POSITION"), column)
                    );
                    unique.put(name, !rs.getBoolean("NON_UNIQUE"));
                }
            }

            List<IndexInfo> result = new ArrayList<>();
            for (Map.Entry<String, List<IndexColumn>> entry : indexes.entrySet()) {
                List<IndexColumn> orderedColumns = entry.getValue();
                orderedColumns.sort(Comparator.comparingInt(IndexColumn::getOrdinal));
                List<String> columns = new ArrayList<>();
                for (IndexColumn column : orderedColumns) {
                    columns.add(column.getName());
                }
                String name = entry.getKey();
                result.add(new IndexInfo(
                    name,
                    columns,
                    Boolean.TRUE.equals(unique.get(name)),
                    "PRIMARY".equalsIgnoreCase(name),
                    null,
                    null,
                    null,
                    null
                ));
            }
            return result;
        });
    }

    public List<ForeignKeyInfo> listForeignKeys(Connection conn, String schema, String table) {
        return unchecked(() -> {
            DatabaseMetaData meta = conn.getMetaData();
            List<ForeignKeyInfo> result = new ArrayList<>();
            try (ResultSet rs = meta.getImportedKeys(null, blankToNull(schema), table)) {
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

    public List<TriggerInfo> listTriggers(String schema, String table) {
        return Collections.emptyList();
    }

    private static String[] getDriverTableTypes(DatabaseMetaData meta, JdbcAgentProfile profile) throws Exception {
        Set<String> configuredTypes = new LinkedHashSet<>();
        for (String type : profile.getTableTypes()) {
            if (type != null) {
                configuredTypes.add(type.toUpperCase(Locale.ROOT));
            }
        }
        try (ResultSet rs = meta.getTableTypes()) {
            List<String> types = new ArrayList<>();
            while (rs.next()) {
                String type = rs.getString("TABLE_TYPE");
                if (type != null && configuredTypes.contains(type.toUpperCase(Locale.ROOT))) {
                    types.add(type);
                }
            }
            if (!types.isEmpty()) {
                return types.toArray(new String[0]);
            }
        } catch (Exception ignored) {
        }
        return profile.getTableTypes().toArray(new String[profile.getTableTypes().size()]);
    }

    public static String getIdentifierQuote(Connection conn, JdbcAgentProfile profile) {
        try {
            String quote = conn.getMetaData().getIdentifierQuoteString();
            if (quote != null && !quote.trim().isEmpty()) {
                return quote.trim();
            }
        } catch (Exception ignored) {
        }
        return profile.getIdentifierQuote();
    }

    public static String quoteIdentifier(String identifier, String quote) {
        return quote + identifier.replace(quote, quote + quote) + quote;
    }

    public static String schemaSwitchSql(Connection conn, JdbcAgentProfile profile, String schema) {
        if (profile.getSkipExecutionContext()) {
            return profile.schemaSwitchSql(schema);
        }
        String quote = getIdentifierQuote(conn, profile);
        return profile.schemaSwitchSql(schema, quote);
    }

    private void appendTables(
        List<TableInfo> result,
        DatabaseMetaData meta,
        JdbcAgentProfile profile,
        String catalog,
        String schema,
        MetadataListConstraints constraints
    ) throws Exception {
        String[] tableTypes = constrainedTableTypes(getDriverTableTypes(meta, profile), constraints);
        if (tableTypes.length == 0) {
            return;
        }
        // JDBC has no portable metadata limit/offset. Use table types for safe pushdown and filter/page locally.
        try (ResultSet rs = meta.getTables(catalog, blankToNull(schema), "%", tableTypes)) {
            while (rs.next()) {
                result.add(new TableInfo(
                    rs.getString("TABLE_NAME"),
                    normalizeTableType(rs.getString("TABLE_TYPE")),
                    rs.getString("REMARKS")
                ));
            }
        }
    }

    private static String[] constrainedTableTypes(String[] tableTypes, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (!normalized.hasObjectTypes()) {
            return tableTypes;
        }
        List<String> result = new ArrayList<>();
        for (String tableType : tableTypes) {
            if (normalized.tableTypeAllowed(tableType)) {
                result.add(tableType);
            }
        }
        return result.toArray(new String[0]);
    }

    private void appendCompletionSchemas(
        List<CompletionAssistantCandidate> result,
        DatabaseMetaData meta,
        JdbcAgentProfile profile,
        CompletionAssistantRequest request,
        int limit
    ) throws Exception {
        Set<String> names = new LinkedHashSet<>();
        try {
            appendSchemas(names, meta.getSchemas(null, null));
        } catch (Exception | AbstractMethodError first) {
            try {
                appendSchemas(names, meta.getSchemas());
            } catch (Exception | AbstractMethodError ignored) {
            }
        }
        List<String> sorted = new ArrayList<>(names);
        Collections.sort(sorted);
        for (String name : sorted) {
            if (result.size() >= limit) {
                return;
            }
            if (profile.getExcludedSchemas().contains(name.toUpperCase(Locale.ROOT)) || !completionNameMatches(name, request)) {
                continue;
            }
            result.add(new CompletionAssistantCandidate(
                name,
                CompletionAssistantCandidateKind.SCHEMA,
                request.getDatabase(),
                name,
                null,
                null,
                null,
                null
            ));
        }
    }

    private void appendCompletionTables(
        List<CompletionAssistantCandidate> result,
        DatabaseMetaData meta,
        JdbcAgentProfile profile,
        String catalog,
        String schema,
        CompletionAssistantRequest request,
        List<CompletionAssistantObjectKind> kinds,
        int limit
    ) throws Exception {
        String[] tableTypes = getDriverTableTypes(meta, profile);
        try (ResultSet rs = meta.getTables(catalog, blankToNull(schema), completionPattern(request), tableTypes)) {
            while (rs.next() && result.size() < limit) {
                String name = rs.getString("TABLE_NAME");
                String type = normalizeTableType(rs.getString("TABLE_TYPE"));
                CompletionAssistantCandidateKind kind = completionTableKind(type);
                if (!completionTableKindAllowed(kind, kinds) || !completionNameMatches(name, request)) {
                    continue;
                }
                result.add(new CompletionAssistantCandidate(
                    name,
                    kind,
                    request.getDatabase(),
                    schema,
                    null,
                    null,
                    rs.getString("REMARKS"),
                    null
                ));
            }
        }
        result.sort(Comparator.comparing(CompletionAssistantCandidate::getName));
    }

    private void appendCompletionColumns(
        List<CompletionAssistantCandidate> result,
        DatabaseMetaData meta,
        String catalog,
        String schema,
        CompletionAssistantRequest request,
        int limit
    ) throws Exception {
        String table = request.getParent_name();
        if (table == null || table.trim().isEmpty()) {
            return;
        }
        try (ResultSet rs = meta.getColumns(catalog, blankToNull(schema), table, completionPattern(request))) {
            while (rs.next() && result.size() < limit) {
                String name = rs.getString("COLUMN_NAME");
                if (!completionNameMatches(name, request)) {
                    continue;
                }
                result.add(new CompletionAssistantCandidate(
                    name,
                    CompletionAssistantCandidateKind.COLUMN,
                    request.getDatabase(),
                    schema,
                    schema,
                    table,
                    rs.getString("REMARKS"),
                    rs.getString("TYPE_NAME")
                ));
            }
        }
    }

    private static List<CompletionAssistantObjectKind> normalizedObjectKinds(CompletionAssistantRequest request) {
        List<CompletionAssistantObjectKind> kinds = request.getObject_kinds();
        if (kinds.isEmpty()) {
            kinds = new ArrayList<>();
            kinds.add(CompletionAssistantObjectKind.TABLE);
            kinds.add(CompletionAssistantObjectKind.VIEW);
        }
        return kinds;
    }

    private static String completionSchema(CompletionAssistantRequest request) {
        String parentSchema = request.getParent_schema();
        if (parentSchema != null && !parentSchema.trim().isEmpty()) {
            return parentSchema;
        }
        return request.getSchema();
    }

    private static String completionPattern(CompletionAssistantRequest request) {
        String mask = request.getMask();
        if (mask.trim().isEmpty()) {
            return "%";
        }
        String escaped = mask.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
        if (request.getMatch_mode() == CompletionAssistantMatchMode.CONTAINS) {
            return "%" + escaped + "%";
        }
        return escaped + "%";
    }

    private static boolean completionNameMatches(String name, CompletionAssistantRequest request) {
        if (name == null) {
            return false;
        }
        String mask = request.getMask();
        if (mask.trim().isEmpty()) {
            return true;
        }
        String candidate = request.getCase_sensitive() ? name : name.toLowerCase(Locale.ROOT);
        String expected = request.getCase_sensitive() ? mask : mask.toLowerCase(Locale.ROOT);
        if (request.getMatch_mode() == CompletionAssistantMatchMode.CONTAINS) {
            return candidate.contains(expected);
        }
        return candidate.startsWith(expected);
    }

    private static int boundedLimit(Integer requested) {
        if (requested == null) {
            return 100;
        }
        return Math.max(1, Math.min(1000, requested));
    }

    private static boolean containsKind(List<CompletionAssistantObjectKind> kinds, CompletionAssistantObjectKind kind) {
        return kinds.contains(kind);
    }

    private static boolean containsTableLike(List<CompletionAssistantObjectKind> kinds) {
        return kinds.contains(CompletionAssistantObjectKind.TABLE) || kinds.contains(CompletionAssistantObjectKind.VIEW);
    }

    private static CompletionAssistantCandidateKind completionTableKind(String type) {
        if ("VIEW".equalsIgnoreCase(type)) {
            return CompletionAssistantCandidateKind.VIEW;
        }
        return CompletionAssistantCandidateKind.TABLE;
    }

    private static boolean completionTableKindAllowed(
        CompletionAssistantCandidateKind kind,
        List<CompletionAssistantObjectKind> requestedKinds
    ) {
        if (kind == CompletionAssistantCandidateKind.VIEW) {
            return requestedKinds.contains(CompletionAssistantObjectKind.VIEW);
        }
        return requestedKinds.contains(CompletionAssistantObjectKind.TABLE);
    }

    private Set<String> primaryKeys(DatabaseMetaData meta, String catalog, String schema, String table) {
        Set<String> keys = new LinkedHashSet<>();
        try (ResultSet rs = meta.getPrimaryKeys(catalog, blankToNull(schema), table)) {
            while (rs.next()) {
                String name = rs.getString("COLUMN_NAME");
                if (name != null) {
                    keys.add(name);
                }
            }
        } catch (Exception ignored) {
        }
        return keys;
    }

    private static boolean hasConfiguredDatabase(String configuredDatabase) {
        return configuredDatabase != null && !configuredDatabase.trim().isEmpty();
    }

    private static void markPrimaryKeys(List<ColumnInfo> columns, Set<String> primaryKeys) {
        if (primaryKeys.isEmpty()) {
            return;
        }
        for (ColumnInfo column : columns) {
            if (primaryKeys.contains(column.getName())) {
                column.setIs_primary_key(true);
            }
        }
    }

    private static void appendSchemas(Set<String> names, ResultSet rs) throws Exception {
        try (ResultSet closeable = rs) {
            while (closeable.next()) {
                addNonBlank(names, closeable.getString("TABLE_SCHEM"));
            }
        }
    }

    private void appendColumns(
        List<ColumnInfo> result,
        DatabaseMetaData meta,
        String catalog,
        String schema,
        String table,
        Set<String> primaryKeys
    ) throws Exception {
        try (ResultSet rs = meta.getColumns(catalog, blankToNull(schema), table, "%")) {
            while (rs.next()) {
                String name = rs.getString("COLUMN_NAME");
                result.add(new ColumnInfo(
                    name,
                    rs.getString("TYPE_NAME"),
                    rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls,
                    rs.getString("COLUMN_DEF"),
                    primaryKeys.contains(name),
                    null,
                    rs.getString("REMARKS"),
                    intOrNull(rs, "COLUMN_SIZE"),
                    intOrNull(rs, "DECIMAL_DIGITS"),
                    characterLength(rs)
                ));
            }
        }
    }

    private static String normalizeTableType(String type) {
        if (type == null || type.trim().isEmpty()) {
            return "TABLE";
        }
        String normalized = type.toUpperCase(Locale.ROOT);
        if ("BASE TABLE".equals(normalized) || "COLUMN TABLE".equals(normalized) || "ROW TABLE".equals(normalized)) {
            return "TABLE";
        }
        return type;
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
        if (!normalized.contains("char") && !normalized.contains("text")) {
            return null;
        }
        return intOrNull(rs, "COLUMN_SIZE");
    }

    private static String blankToNull(String value) {
        return value == null || value.trim().isEmpty() ? null : value;
    }

    private static void addNonBlank(Set<String> values, String value) {
        if (value != null && !value.trim().isEmpty()) {
            values.add(value);
        }
    }

    private static <T> T unchecked(ThrowingSupplier<T> supplier) {
        try {
            return supplier.get();
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static final class IndexColumn {
        private final int ordinal;
        private final String name;

        private IndexColumn(int ordinal, String name) {
            this.ordinal = ordinal;
            this.name = name;
        }

        private int getOrdinal() {
            return ordinal;
        }

        private String getName() {
            return name;
        }
    }

    private interface ThrowingSupplier<T> {
        T get() throws Exception;
    }
}
