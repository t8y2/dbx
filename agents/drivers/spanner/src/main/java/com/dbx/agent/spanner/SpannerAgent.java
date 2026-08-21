package com.dbx.agent.spanner;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.CompletionAssistantCandidate;
import com.dbx.agent.CompletionAssistantCandidateKind;
import com.dbx.agent.CompletionAssistantMatchMode;
import com.dbx.agent.CompletionAssistantObjectKind;
import com.dbx.agent.CompletionAssistantRequest;
import com.dbx.agent.CompletionAssistantResponse;
import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.DdlBuilder;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.StandardJdbcMetadata;
import com.dbx.agent.TableInfo;
import com.google.cloud.spanner.Database;
import com.google.cloud.spanner.DatabaseId;
import com.google.cloud.spanner.Dialect;
import com.google.cloud.spanner.jdbc.CloudSpannerJdbcConnection;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Google Cloud Spanner agent.
 *
 * <p>The official driver already ships dialect-aware {@code DatabaseMetaData} implementations
 * (separate SQL resources for GoogleSQL and the PostgreSQL dialect), so no INFORMATION_SCHEMA SQL is
 * written here. What the shared {@code StandardJdbcMetadata} adapter cannot express is Spanner's
 * schema model: in GoogleSQL the user schema name <em>is</em> the empty string, while the shared
 * adapter maps blank schemas to {@code null} ("unspecified") and therefore leaks the 28+
 * INFORMATION_SCHEMA views into every listing. The thin adapter below passes the schema through
 * verbatim and fixes three field-level mismatches: the primary key index is named
 * {@code PRIMARY_KEY}, {@code ORDINAL_POSITION} is NULL for STORING/INCLUDE index columns, and
 * GoogleSQL reports INTERLEAVE parent links as unnamed foreign keys.
 */
public final class SpannerAgent extends ConfiguredJdbcAgent {
    /** GoogleSQL exposes user objects under the empty schema name. */
    private static final String GOOGLE_SQL_SCHEMA = "";
    /** The PostgreSQL dialect always reports {@code public}; used only if the driver stops telling us. */
    private static final String POSTGRES_FALLBACK_SCHEMA = "public";
    private static final String PRIMARY_KEY_INDEX = "PRIMARY_KEY";
    private static final String URL_PREFIX = "jdbc:cloudspanner:";
    /** A loopback endpoint is always the local emulator: the real service is addressed host-less. */
    private static final Set<String> LOOPBACK_HOSTS =
        new HashSet<>(Arrays.asList("localhost", "127.0.0.1", "::1", "[::1]"));
    private static final String PLAIN_TEXT_PARAM = "usePlainText=true";
    /**
     * Works verbatim in both dialects: the PostgreSQL dialect folds the unquoted upper-case
     * identifiers to lower case, so one statement serves GoogleSQL and PostgreSQL alike.
     */
    private static final String SCHEMATA_SQL = "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA";
    /**
     * The driver reports GoogleSQL spellings from {@code getTypeInfo()} for both dialects (only
     * JSON/JSONB differs), so the PostgreSQL-dialect names are substituted here. Every entry was
     * read back from {@code information_schema.columns} on a PostgreSQL-dialect database rather than
     * transcribed from documentation.
     */
    private static final Map<String, String> POSTGRES_DIALECT_TYPE_NAMES = postgresDialectTypeNames();

    private static Map<String, String> postgresDialectTypeNames() {
        Map<String, String> names = new LinkedHashMap<>();
        names.put("STRING", "character varying");
        names.put("INT64", "bigint");
        names.put("BYTES", "bytea");
        names.put("FLOAT32", "real");
        names.put("FLOAT64", "double precision");
        names.put("BOOL", "boolean");
        names.put("DATE", "date");
        names.put("TIMESTAMP", "timestamp with time zone");
        names.put("NUMERIC", "numeric");
        names.put("UUID", "uuid");
        // The driver already answers JSONB for the PostgreSQL dialect, but in upper case.
        names.put("JSON", "jsonb");
        names.put("JSONB", "jsonb");
        return Collections.unmodifiableMap(names);
    }
    private static final int DEFAULT_COMPLETION_LIMIT = 100;
    private static final int MAX_COMPLETION_LIMIT = 1000;

    public static final JdbcAgentProfile SPANNER_PROFILE = new JdbcAgentProfile(
        "com.google.cloud.spanner.jdbc.JdbcDriver",
        URL_PREFIX + "//{host}:{port}/{database}",
        443,
        // Spanner has no SQL-level schema switch statement; SET SCHEMA and set search_path are both
        // rejected as unknown statements, so setSchemaSQL must resolve to an empty string.
        true,
        new HashSet<>(Arrays.asList("INFORMATION_SCHEMA", "SPANNER_SYS", "PG_CATALOG")),
        Arrays.asList("TABLE", "VIEW"),
        "`",
        "SET SCHEMA",
        // The catalog is the empty string in GoogleSQL and the database name in the PostgreSQL
        // dialect; retrying metadata with it only adds unrelated rows.
        false,
        false,
        false,
        false
    );

    private volatile boolean postgresDialect;
    private volatile String defaultSchema = GOOGLE_SQL_SCHEMA;

    public SpannerAgent() {
        super(SPANNER_PROFILE);
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return spannerUrl(params);
    }

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) {
        super.afterConnect(params, connection);
        detectDialect(connection);
    }

    @Override
    public String getIdentifierQuote() {
        return postgresDialect ? "\"" : "`";
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        // JDBC alone cannot enumerate an instance (and in the PostgreSQL dialect getCatalogs() plus
        // the configured resource path would duplicate the current entry), but the bundled driver
        // ships the Admin API and the connection already carries the credentials, so ask it.
        List<DatabaseInfo> databases = adminListDatabases();
        return databases.isEmpty() ? Collections.singletonList(new DatabaseInfo(configuredDatabaseName())) : databases;
    }

    /**
     * Lists the sibling databases through {@code DatabaseAdminClient}, which the JDBC connection
     * exposes via {@code getSpanner()}. Returns an empty list — never throws — when the caller lacks
     * {@code spanner.databases.list}, when the driver is loaded from a classloader that cannot see
     * the admin classes, or when anything else about the unwrap fails; {@link #listDatabases()} then
     * falls back to the connected database alone, which is what shipped before.
     */
    private List<DatabaseInfo> adminListDatabases() {
        try {
            CloudSpannerJdbcConnection connection = requireConnection().unwrap(CloudSpannerJdbcConnection.class);
            DatabaseId databaseId = connection.getDatabaseId();
            String instance = databaseId.getInstanceId().getInstance();
            List<DatabaseInfo> result = new ArrayList<>();
            for (Database database : connection.getSpanner().getDatabaseAdminClient().listDatabases(instance).iterateAll()) {
                // getName(), not getDatabase(): the reported name round-trips as
                // ConnectParams.database, and only the full resource path builds a valid JDBC URL.
                // The sidebar shortens it for display through `spannerDisplayDatabase`.
                result.add(new DatabaseInfo(database.getId().getName()));
            }
            result.sort(Comparator.comparing(DatabaseInfo::getName));
            return result;
        } catch (Throwable ignored) {
            return Collections.emptyList();
        }
    }

    @Override
    public List<String> listDataTypes() {
        // The driver reports GoogleSQL spellings for both dialects except JSON/JSONB, so a
        // PostgreSQL-dialect database would otherwise offer INT64/STRING/BOOL in the schema-diff
        // field mapping. Substitute the PostgreSQL names for the types the driver enumerates.
        List<String> types = super.listDataTypes();
        if (!postgresDialect) {
            return types;
        }
        List<String> result = new ArrayList<>(types.size());
        for (String type : types) {
            result.add(POSTGRES_DIALECT_TYPE_NAMES.getOrDefault(type.toUpperCase(Locale.ROOT), type));
        }
        return result;
    }

    @Override
    public String getTableDdl(String schema, String table) {
        String resolved = resolveSchema(schema);
        List<IndexInfo> indexes;
        try {
            indexes = listIndexes(resolved, table);
        } catch (RuntimeException e) {
            indexes = Collections.emptyList();
        }
        List<ForeignKeyInfo> foreignKeys;
        try {
            foreignKeys = listForeignKeys(resolved, table);
        } catch (RuntimeException e) {
            foreignKeys = Collections.emptyList();
        }
        String tableComment = null;
        try {
            tableComment = getTableComment(resolved, table);
        } catch (RuntimeException e) {
            // Optional; DDL generation should still succeed without it.
        }
        // Same as the inherited implementation except for the quote: it hardcodes ANSI double quotes,
        // which GoogleSQL reads as a string literal rather than an identifier.
        return DdlBuilder.buildTableDdl(
            resolved,
            table,
            getColumns(resolved, table),
            indexes,
            foreignKeys,
            Collections.emptyList(),
            !postgresDialect,
            false,
            tableComment
        );
    }

    @Override
    public List<String> listSchemas() {
        // Not getSchemas(): the shared adapter drops blank names, and GoogleSQL's user schema *is*
        // the empty string, so the default schema would disappear and take the object tree with it.
        // Query the catalog directly instead, the way H2, DB2, Trino and Snowflake already do.
        Connection connection = requireConnection();
        Set<String> names = new LinkedHashSet<>();
        names.add(defaultSchema);
        List<String> named = new ArrayList<>();
        try (java.sql.Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(SCHEMATA_SQL)) {
            while (rs.next()) {
                String name = rs.getString(1);
                if (name == null || name.equals(defaultSchema)) {
                    continue;
                }
                // Upper-cased before the comparison because the PostgreSQL dialect reports its
                // system schemas in lower case.
                if (SPANNER_PROFILE.getExcludedSchemas().contains(name.toUpperCase(Locale.ROOT))) {
                    continue;
                }
                named.add(name);
            }
        } catch (Exception ignored) {
            // A database that cannot be queried still browses under its default schema.
            return new ArrayList<>(names);
        }
        Collections.sort(named);
        names.addAll(named);
        return new ArrayList<>(names);
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return listTables(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<TableInfo> listTables(String schema, List<String> objectTypes) {
        return listTables(schema, new MetadataListConstraints(null, null, null, objectTypes));
    }

    @Override
    public List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (!normalized.includesTableLikeTypes()) {
            return Collections.emptyList();
        }
        return normalized.filterTables(spannerTables(requireConnection(), resolveSchema(schema)));
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return listObjects(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<ObjectInfo> listObjects(String schema, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        // Spanner has no stored procedures or functions, so table-like objects are the whole set.
        String resolved = resolveSchema(schema);
        List<TableInfo> tables = spannerTables(requireConnection(), resolved);
        return normalized.filterObjects(StandardJdbcMetadata.INSTANCE.listObjects(tables, resolved));
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return spannerColumns(requireConnection(), resolveSchema(schema), table);
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return spannerIndexes(requireConnection(), resolveSchema(schema), table);
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return spannerForeignKeys(requireConnection(), resolveSchema(schema), table);
    }


    @Override
    public CompletionAssistantResponse completionAssistantSearch(CompletionAssistantRequest request) {
        Connection conn = requireConnection();
        String schema = resolveSchema(completionSchema(request));
        int limit = completionLimit(request.getMax_results());
        List<CompletionAssistantObjectKind> kinds = completionKinds(request);
        List<CompletionAssistantCandidate> candidates = new ArrayList<>();

        if (kinds.contains(CompletionAssistantObjectKind.SCHEMA)
            && !schema.isEmpty()
            && completionMatches(schema, request)) {
            candidates.add(new CompletionAssistantCandidate(
                schema,
                CompletionAssistantCandidateKind.SCHEMA,
                request.getDatabase(),
                schema,
                null,
                null,
                null,
                null
            ));
        }

        if (kinds.contains(CompletionAssistantObjectKind.TABLE) || kinds.contains(CompletionAssistantObjectKind.VIEW)) {
            for (TableInfo table : spannerTables(conn, schema)) {
                if (candidates.size() >= limit) {
                    break;
                }
                boolean view = "VIEW".equalsIgnoreCase(table.getTable_type());
                CompletionAssistantObjectKind requiredKind = view
                    ? CompletionAssistantObjectKind.VIEW
                    : CompletionAssistantObjectKind.TABLE;
                if (!kinds.contains(requiredKind) || !completionMatches(table.getName(), request)) {
                    continue;
                }
                candidates.add(new CompletionAssistantCandidate(
                    table.getName(),
                    view ? CompletionAssistantCandidateKind.VIEW : CompletionAssistantCandidateKind.TABLE,
                    request.getDatabase(),
                    schema,
                    null,
                    null,
                    table.getComment(),
                    null
                ));
            }
        }

        String parentName = request.getParent_name();
        if (kinds.contains(CompletionAssistantObjectKind.COLUMN)
            && parentName != null
            && !parentName.trim().isEmpty()) {
            for (ColumnInfo column : spannerColumns(conn, schema, parentName)) {
                if (candidates.size() >= limit) {
                    break;
                }
                if (!completionMatches(column.getName(), request)) {
                    continue;
                }
                candidates.add(new CompletionAssistantCandidate(
                    column.getName(),
                    CompletionAssistantCandidateKind.COLUMN,
                    request.getDatabase(),
                    schema,
                    schema,
                    parentName,
                    column.getComment(),
                    column.getData_type()
                ));
            }
        }

        return new CompletionAssistantResponse(candidates, candidates.size() >= limit, false);
    }

    /**
     * Builds the Spanner JDBC URL. The profile template cannot express the endpoint-less form used
     * for the real service, where the URL is {@code jdbc:cloudspanner:/<resource path>} without any
     * {@code //host:port} authority.
     */
    static String spannerUrl(ConnectParams params) {
        if (!params.getConnection_string().trim().isEmpty()) {
            return params.getConnection_string();
        }
        String host = trimmed(params.getHost());
        StringBuilder url = new StringBuilder(URL_PREFIX);
        if (!host.isEmpty()) {
            int port = params.getPort() > 0 ? params.getPort() : SPANNER_PROFILE.getDefaultPort();
            url.append("//").append(host).append(':').append(port);
        }
        // params.database carries the full resource path projects/{p}/instances/{i}/databases/{d}.
        url.append('/').append(stripLeadingSlashes(trimmed(params.getDatabase())));
        return appendUrlParams(url.toString(), emulatorAwareUrlParams(host, params.getUrl_params()));
    }

    /**
     * The emulator speaks plaintext gRPC, but the driver defaults to TLS plus Application Default
     * Credentials because nothing in the URL distinguishes an emulator endpoint from a private one.
     * Pointing a connection at localhost without a plaintext flag therefore burns the whole connect
     * timeout while gRPC retries a TLS handshake against a plaintext port, and reports only
     * {@code UNAVAILABLE: io exception} — so a loopback host opts into plaintext by default.
     *
     * <p>An explicit {@code usePlainText} or {@code autoConfigEmulator} always wins, including
     * {@code usePlainText=false}. {@code autoConfigEmulator} implies plaintext but additionally
     * creates a missing instance and database, which is a choice only the user should make.
     */
    private static String emulatorAwareUrlParams(String host, String urlParams) {
        String configured = trimmed(urlParams);
        if (!LOOPBACK_HOSTS.contains(host.toLowerCase(Locale.ROOT))) {
            return configured;
        }
        if (hasUrlParam(configured, "usePlainText") || hasUrlParam(configured, "autoConfigEmulator")) {
            return configured;
        }
        return configured.isEmpty() ? PLAIN_TEXT_PARAM : configured + ";" + PLAIN_TEXT_PARAM;
    }

    /**
     * Matches a property name at a separator boundary so that {@code usePlainText} is not reported
     * for an unrelated property that merely ends with it. Spanner property names are
     * case-insensitive.
     */
    private static boolean hasUrlParam(String urlParams, String name) {
        String haystack = urlParams.toLowerCase(Locale.ROOT);
        String needle = name.toLowerCase(Locale.ROOT);
        for (int from = 0; from <= haystack.length() - needle.length(); ) {
            int index = haystack.indexOf(needle, from);
            if (index < 0) {
                return false;
            }
            boolean startsToken = index == 0 || "?;&".indexOf(haystack.charAt(index - 1)) >= 0;
            int after = index + needle.length();
            boolean endsToken = after >= haystack.length() || haystack.charAt(after) == '=';
            if (startsToken && endsToken) {
                return true;
            }
            from = index + 1;
        }
        return false;
    }

    static List<TableInfo> spannerTables(Connection conn, String schema) {
        return unchecked(() -> {
            String[] tableTypes = SPANNER_PROFILE.getTableTypes().toArray(new String[0]);
            List<TableInfo> result = new ArrayList<>();
            // The schema is passed through verbatim: an empty string is GoogleSQL's user schema, and
            // mapping it to null would return every INFORMATION_SCHEMA/SPANNER_SYS view as well.
            try (ResultSet rs = conn.getMetaData().getTables(null, schema, "%", tableTypes)) {
                while (rs.next()) {
                    result.add(new TableInfo(
                        rs.getString("TABLE_NAME"),
                        normalizeTableType(rs.getString("TABLE_TYPE")),
                        rs.getString("REMARKS")
                    ));
                }
            }
            result.sort(Comparator.comparing(TableInfo::getName));
            return result;
        });
    }

    static List<ColumnInfo> spannerColumns(Connection conn, String schema, String table) {
        return unchecked(() -> {
            DatabaseMetaData meta = conn.getMetaData();
            Set<String> primaryKeys = new LinkedHashSet<>();
            try (ResultSet rs = meta.getPrimaryKeys(null, schema, table)) {
                while (rs.next()) {
                    String name = rs.getString("COLUMN_NAME");
                    if (name != null) {
                        primaryKeys.add(name);
                    }
                }
            }
            List<ColumnInfo> result = new ArrayList<>();
            try (ResultSet rs = meta.getColumns(null, schema, table, "%")) {
                while (rs.next()) {
                    String name = rs.getString("COLUMN_NAME");
                    // TYPE_NAME already carries the native Spanner type (STRING(100), ARRAY<INT64>).
                    String typeName = rs.getString("TYPE_NAME");
                    result.add(new ColumnInfo(
                        name,
                        typeName,
                        rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls,
                        rs.getString("COLUMN_DEF"),
                        primaryKeys.contains(name),
                        null,
                        rs.getString("REMARKS"),
                        intOrNull(rs, "COLUMN_SIZE"),
                        intOrNull(rs, "DECIMAL_DIGITS"),
                        characterLength(typeName, intOrNull(rs, "COLUMN_SIZE"))
                    ));
                }
            }
            return result;
        });
    }

    static List<IndexInfo> spannerIndexes(Connection conn, String schema, String table) {
        return unchecked(() -> {
            Map<String, Boolean> uniqueByIndex = new LinkedHashMap<>();
            Map<String, List<IndexColumn>> keyColumns = new LinkedHashMap<>();
            Map<String, List<String>> storingColumns = new LinkedHashMap<>();
            try (ResultSet rs = conn.getMetaData().getIndexInfo(null, schema, table, false, false)) {
                while (rs.next()) {
                    String name = rs.getString("INDEX_NAME");
                    String column = rs.getString("COLUMN_NAME");
                    if (name == null || column == null) {
                        continue;
                    }
                    uniqueByIndex.putIfAbsent(name, !rs.getBoolean("NON_UNIQUE"));
                    Integer ordinal = intOrNull(rs, "ORDINAL_POSITION");
                    if (ordinal == null) {
                        // Spanner reports STORING (GoogleSQL) / INCLUDE (PostgreSQL) columns with a
                        // NULL ORDINAL_POSITION. Reading them with getShort() would turn them into
                        // key column 0 and put a non-key column in front of the real key columns.
                        storingColumns.computeIfAbsent(name, ignored -> new ArrayList<>()).add(column);
                        continue;
                    }
                    keyColumns.computeIfAbsent(name, ignored -> new ArrayList<>())
                        .add(new IndexColumn(ordinal, column));
                }
            }

            List<IndexInfo> result = new ArrayList<>();
            for (Map.Entry<String, Boolean> entry : uniqueByIndex.entrySet()) {
                String name = entry.getKey();
                List<IndexColumn> ordered = keyColumns.getOrDefault(name, new ArrayList<>());
                ordered.sort(Comparator.comparingInt(IndexColumn::getOrdinal));
                List<String> columns = new ArrayList<>();
                for (IndexColumn column : ordered) {
                    columns.add(column.getName());
                }
                result.add(new IndexInfo(
                    name,
                    columns,
                    Boolean.TRUE.equals(entry.getValue()),
                    // Spanner names the primary key index PRIMARY_KEY, not PRIMARY.
                    PRIMARY_KEY_INDEX.equalsIgnoreCase(name),
                    null,
                    null,
                    storingColumns.get(name),
                    null
                ));
            }
            return result;
        });
    }

    static List<ForeignKeyInfo> spannerForeignKeys(Connection conn, String schema, String table) {
        return unchecked(() -> {
            List<ForeignKeyInfo> result = new ArrayList<>();
            try (ResultSet rs = conn.getMetaData().getImportedKeys(null, schema, table)) {
                while (rs.next()) {
                    String name = rs.getString("FK_NAME");
                    if (name == null || name.trim().isEmpty()) {
                        // GoogleSQL reports INTERLEAVE IN PARENT links as unnamed imported keys while
                        // the PostgreSQL dialect omits them. Skipping keeps both dialects consistent
                        // and avoids showing an interleaving relationship as a nameless foreign key.
                        continue;
                    }
                    result.add(new ForeignKeyInfo(
                        name,
                        rs.getString("FKCOLUMN_NAME"),
                        rs.getString("PKTABLE_NAME"),
                        rs.getString("PKCOLUMN_NAME")
                    ));
                }
            }
            return result;
        });
    }

    /** Probes the database dialect once per connection; visible for testing. */
    void detectDialect(Connection connection) {
        boolean postgres = isPostgresDialect(connection);
        postgresDialect = postgres;
        defaultSchema = postgres ? postgresSchema(connection) : GOOGLE_SQL_SCHEMA;
    }

    static boolean isPostgresDialect(Connection connection) {
        Boolean fromDriver = driverDialectIsPostgres(connection);
        if (fromDriver != null) {
            return fromDriver.booleanValue();
        }
        return productNameIsPostgres(connection);
    }

    private static Boolean driverDialectIsPostgres(Connection connection) {
        try {
            CloudSpannerJdbcConnection spannerConnection =
                unwrapConnection(connection, CloudSpannerJdbcConnection.class);
            if (spannerConnection == null) {
                return null;
            }
            Dialect dialect = spannerConnection.getDialect();
            if (dialect == null) {
                return null;
            }
            return Boolean.valueOf(dialect == Dialect.POSTGRESQL);
        } catch (Throwable ignored) {
            // Linking the driver interface is not always possible, so this probe stays optional:
            // the published fat jar carries stale BouncyCastle signatures that only the shadow jar
            // strips (a plain classpath, for example the unit tests, throws SecurityException while
            // loading any driver class), and a user-supplied driver jar is loaded through a child
            // class loader whose interface is a different type. Both cases use the product name.
            return null;
        }
    }

    private static boolean productNameIsPostgres(Connection connection) {
        try {
            // GoogleSQL reports "Google Cloud Spanner", the PostgreSQL dialect appends " PostgreSQL".
            String product = connection.getMetaData().getDatabaseProductName();
            return product != null && product.contains("PostgreSQL");
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String postgresSchema(Connection connection) {
        try {
            String schema = connection.getSchema();
            if (schema != null && !schema.trim().isEmpty()) {
                return schema;
            }
        } catch (Exception ignored) {
            // Fall through to the dialect default.
        }
        return POSTGRES_FALLBACK_SCHEMA;
    }

    private String configuredDatabaseName() {
        String database = trimmed(getConfiguredDatabase());
        if (!database.isEmpty()) {
            return database;
        }
        try {
            return trimmed(requireConnection().getCatalog());
        } catch (Exception ignored) {
            return "";
        }
    }

    /**
     * Never maps a blank schema to {@code null}: GoogleSQL's user schema name is the empty string,
     * and the PostgreSQL dialect needs the literal {@code public}.
     *
     * <p>A value that cannot be a Spanner schema name is treated as "unspecified" as well. Hosts
     * that have no schema level commonly send the database identifier as the metadata schema, and
     * for Spanner that identifier is the resource path {@code projects/{p}/instances/{i}/databases/{d}}.
     * Passing it through would make every metadata lookup match nothing, and a Spanner schema name
     * can never contain a slash (identifiers are letters, digits and underscores).
     */
    private String resolveSchema(String schema) {
        if (schema == null || schema.trim().isEmpty() || schema.indexOf('/') >= 0) {
            return defaultSchema;
        }
        return schema;
    }

    private static List<CompletionAssistantObjectKind> completionKinds(CompletionAssistantRequest request) {
        List<CompletionAssistantObjectKind> kinds = request.getObject_kinds();
        if (kinds.isEmpty()) {
            return Arrays.asList(CompletionAssistantObjectKind.TABLE, CompletionAssistantObjectKind.VIEW);
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

    private static int completionLimit(Integer requested) {
        if (requested == null) {
            return DEFAULT_COMPLETION_LIMIT;
        }
        return Math.max(1, Math.min(MAX_COMPLETION_LIMIT, requested));
    }

    private static boolean completionMatches(String name, CompletionAssistantRequest request) {
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

    private static String normalizeTableType(String type) {
        if (type == null || type.trim().isEmpty()) {
            return "TABLE";
        }
        if ("BASE TABLE".equalsIgnoreCase(type.trim())) {
            return "TABLE";
        }
        return type;
    }

    private static Integer characterLength(String typeName, Integer columnSize) {
        if (typeName == null) {
            return null;
        }
        String normalized = typeName.toLowerCase(Locale.ROOT);
        if (!normalized.contains("char") && !normalized.contains("text")) {
            return null;
        }
        return columnSize;
    }

    private static Integer intOrNull(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value instanceof Number ? ((Number) value).intValue() : null;
    }

    private static String appendUrlParams(String url, String urlParams) {
        String params = trimmed(urlParams);
        while (params.startsWith("?") || params.startsWith(";") || params.startsWith("&")) {
            params = params.substring(1);
        }
        if (params.isEmpty()) {
            return url;
        }
        // Spanner takes properties as ?name=value;name=value.
        return url + (url.indexOf('?') >= 0 ? ";" : "?") + params;
    }

    private static String stripLeadingSlashes(String value) {
        String result = value;
        while (result.startsWith("/")) {
            result = result.substring(1);
        }
        return result;
    }

    private static String trimmed(String value) {
        return value == null ? "" : value.trim();
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

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(SpannerAgent::new).run();
    }
}
