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

public abstract class ConfiguredJdbcAgent extends AbstractJdbcAgent {
    private final JdbcAgentProfile profile;
    private String configuredDatabase = "";

    protected ConfiguredJdbcAgent(JdbcAgentProfile profile) {
        this.profile = profile;
    }

    public JdbcAgentProfile getProfile() {
        return profile;
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
    protected void afterConnect(ConnectParams params, Connection connection) {
        configuredDatabase = params.getDatabase();
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return StandardJdbcMetadata.INSTANCE.listDatabases(requireConnection(), configuredDatabase);
    }

    @Override
    public List<String> listSchemas() {
        return StandardJdbcMetadata.INSTANCE.listSchemas(requireConnection(), profile);
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return StandardJdbcMetadata.INSTANCE.listTables(requireConnection(), profile, configuredDatabase, schema);
    }

    @Override
    public List<TableInfo> listTables(String schema, List<String> objectTypes) {
        return listTables(schema, new MetadataListConstraints(null, null, null, objectTypes));
    }

    @Override
    public List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        return StandardJdbcMetadata.INSTANCE.listTables(
            requireConnection(),
            profile,
            configuredDatabase,
            schema,
            constraints
        );
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return StandardJdbcMetadata.INSTANCE.listObjects(
            requireConnection(),
            profile,
            configuredDatabase,
            schema,
            MetadataListConstraints.NONE
        );
    }

    @Override
    public List<ObjectInfo> listObjects(String schema, MetadataListConstraints constraints) {
        return StandardJdbcMetadata.INSTANCE.listObjects(
            requireConnection(),
            profile,
            configuredDatabase,
            schema,
            constraints
        );
    }

    @Override
    public List<String> listDataTypes() {
        return StandardJdbcMetadata.INSTANCE.listDataTypes(requireConnection());
    }

    @Override
    public CompletionAssistantResponse completionAssistantSearch(CompletionAssistantRequest request) {
        return StandardJdbcMetadata.INSTANCE.completionAssistantSearch(requireConnection(), profile, configuredDatabase, request);
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        throw new UnsupportedOperationException("Object source is not supported");
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return StandardJdbcMetadata.INSTANCE.getColumns(requireConnection(), profile, configuredDatabase, schema, table);
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return StandardJdbcMetadata.INSTANCE.listIndexes(requireConnection(), schema, table);
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return StandardJdbcMetadata.INSTANCE.listForeignKeys(requireConnection(), schema, table);
    }

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        return StandardJdbcMetadata.INSTANCE.listTriggers(schema, table);
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

        String tableComment = null;
        try {
            tableComment = getTableComment(schema, table);
        } catch (RuntimeException e) {
            // Table comment is optional; DDL generation should still succeed without it.
        }

        return DdlBuilder.buildTableDdl(schema, table, getColumns(schema, table), indexes, foreignKeys, Collections.emptyList(), false, false, tableComment);
    }

    @Override
    public String setSchemaSQL(String schema) {
        if (profile.getSkipExecutionContext()) {
            return "";
        }
        return StandardJdbcMetadata.schemaSwitchSql(requireConnection(), profile, schema);
    }

    protected Connection requireConnection() {
        return requireConnected();
    }

    @Override
    protected Object resultValue(ResultSet rs, int index, int sqlType) {
        return super.resultValue(rs, index, sqlType);
    }

    private static String normalizeTableType(String type) {
        if (type == null || type.trim().isEmpty()) {
            return "TABLE";
        }
        if ("BASE TABLE".equals(type.toUpperCase(Locale.ROOT))) {
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

}
