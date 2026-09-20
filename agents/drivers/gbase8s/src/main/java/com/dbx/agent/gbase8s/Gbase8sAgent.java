package com.dbx.agent.gbase8s;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class Gbase8sAgent extends ConfiguredJdbcAgent {
    private static final long METADATA_CACHE_TTL_MILLIS = 10_000L;

    // Whitelist for a JDBC locale value (language_territory.codeset). The value is concatenated
    // into the connection URL, so reject anything outside ordinary identifier characters to guard
    // against a malformed or hostile server-reported collation.
    private static final Pattern SAFE_DATABASE_LOCALE = Pattern.compile("[A-Za-z0-9_.\\-]{1,64}");
    // Upper bound on the sysmaster locale-probe connection so a hung probe cannot stall connect.
    private static final int LOCALE_PROBE_LOGIN_TIMEOUT_SECS = 10;

    /**
     * Leading directive comment emitted by the Rust admin-SQL layer for GBase 8s / Informix
     * "Create Database" when the user picks a character set, e.g.
     * {@code -- DBX_DB_LOCALE=zh_CN.utf8\nCREATE DATABASE mydb;}. Informix cannot express a new
     * database's codeset in {@code CREATE DATABASE} — it inherits the creating session's DB_LOCALE —
     * so the chosen locale is carried out-of-band and honored here by opening a sysmaster session
     * pinned to that DB_LOCALE.
     */
    private static final Pattern CREATE_DATABASE_LOCALE_DIRECTIVE = Pattern.compile(
        "^\\s*--\\s*DBX_DB_LOCALE\\s*=\\s*(\\S+)\\s*\\r?\\n(.*)$", Pattern.DOTALL);

    // A bare `DROP DATABASE <name>` (unquoted identifier, optional trailing semicolon). The target
    // database's own locale is resolvable (it exists in sysdbslocale), so the drop is routed here
    // without a directive.
    private static final Pattern DROP_DATABASE_STATEMENT = Pattern.compile(
        "^\\s*DROP\\s+DATABASE\\s+([A-Za-z0-9_]+)\\s*;?\\s*$", Pattern.CASE_INSENSITIVE);

    public static final JdbcAgentProfile GBASE8S_PROFILE = new JdbcAgentProfile(
        "com.gbasedbt.jdbc.Driver",
        "jdbc:gbasedbt-sqli://{host}:{port}/{database}:GBASEDBTSERVER=gbase8s",
        9088,
        true
    );

    private final Object metadataCacheLock = new Object();
    private long databaseCacheTimeMillis;
    private List<DatabaseInfo> databaseCache = Collections.emptyList();
    private String schemaCacheCatalog = "";
    private long schemaCacheTimeMillis;
    private List<String> schemaCache = Collections.emptyList();
    private String tableCacheCatalog = "";
    private String tableCacheSchema = "";
    private long tableCacheTimeMillis;
    private List<TableInfo> tableCache = Collections.emptyList();
    private ConnectParams databaseListParams;
    private final Map<String, String> collateByDatabase = new ConcurrentHashMap<>();

    public Gbase8sAgent() {
        super(GBASE8S_PROFILE);
    }

    @Override
    public boolean supportsConnectionPooling() {
        return false;
    }

    public static String buildUrl(ConnectParams params) {
        if (!params.getConnection_string().trim().isEmpty()) {
            return params.getConnection_string();
        }
        String extraParams = trimEnd(trimStart(params.getUrl_params().trim(), ':', ';'), ';');
        String database = params.getDatabase().trim().isEmpty() ? "sysmaster" : params.getDatabase().trim();
        String serverParam = containsIgnoreCase(extraParams, "GBASEDBTSERVER=")
            ? ""
            : "GBASEDBTSERVER=" + getGbaseServer(params);
        List<String> jdbcParams = new ArrayList<>();
        if (!serverParam.isBlank()) {
            jdbcParams.add(serverParam);
        }
        if (!extraParams.isBlank()) {
            jdbcParams.add(extraParams);
        }
        return "jdbc:gbasedbt-sqli://" + params.getHost() + ":" + port(params) + "/" + database + ":"
            + String.join(";", jdbcParams);
    }

    private static String getGbaseServer(ConnectParams params) {
        if (params.getGbase_server() != null && !params.getGbase_server().trim().isEmpty()) {
            return params.getGbase_server().trim();
        }
        return defaultGbaseServer(params.getHost());
    }

    static String buildUrlForDatabase(ConnectParams params, String database) {
        return buildUrl(paramsForDatabase(params, database));
    }

    private static ConnectParams paramsForDatabase(ConnectParams params, String database) {
        String connectionString = trim(params.getConnection_string());
        if (!connectionString.isEmpty()) {
            int schemeEnd = connectionString.indexOf("://");
            int databaseStart = schemeEnd < 0 ? -1 : connectionString.indexOf('/', schemeEnd + 3);
            if (databaseStart >= 0) {
                int paramsStart = connectionString.indexOf(':', databaseStart + 1);
                String suffix = paramsStart >= 0 ? connectionString.substring(paramsStart) : "";
                connectionString = connectionString.substring(0, databaseStart + 1) + database + suffix;
            }
        }

        ConnectParams databaseParams = new ConnectParams(
            params.getHost(),
            params.getPort(),
            database,
            params.getUsername(),
            params.getPassword(),
            params.getUrl_params(),
            connectionString,
            params.isMysql_compat_mode(),
            params.getJdbc_driver_class(),
            params.getJdbc_driver_paths()
        );
        databaseParams.setGbase_server(getGbaseServer(params));
        return databaseParams;
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return buildUrl(params);
    }

    @Override
    protected Connection openConnection(ConnectParams params) throws Exception {
        return super.openConnection(withResolvedDatabaseLocale(params));
    }

    /**
     * Return a copy of {@code params} whose {@code CLIENT_LOCALE}/{@code DB_LOCALE} match the real
     * collation of the target database, so one connection profile can open every database on the
     * instance regardless of locale. Falls back to the configured parameters whenever the collation
     * cannot be resolved (custom connection string, catalog unavailable, or lookup error).
     */
    private ConnectParams withResolvedDatabaseLocale(ConnectParams params) {
        if (!params.getConnection_string().trim().isEmpty()) {
            return params;
        }
        String database = params.getDatabase().trim().isEmpty() ? "sysmaster" : params.getDatabase().trim();
        String collate = resolveCollate(params, database);
        if (collate.isEmpty() || collate.equalsIgnoreCase(currentLocaleOf(params))) {
            return params;
        }
        ConnectParams localized = new ConnectParams(
            params.getHost(),
            params.getPort(),
            params.getDatabase(),
            params.getUsername(),
            params.getPassword(),
            overrideLocaleParams(params.getUrl_params(), collate),
            params.getConnection_string(),
            params.isMysql_compat_mode(),
            params.getJdbc_driver_class(),
            params.getJdbc_driver_paths()
        );
        localized.setGbase_server(getGbaseServer(params));
        return localized;
    }

    private static String collateCacheKey(ConnectParams params, String database) {
        return params.getHost() + "|" + params.getPort() + "|" + getGbaseServer(params)
            + "|" + database.toLowerCase(Locale.ROOT);
    }

    private String resolveCollate(ConnectParams params, String database) {
        String key = collateCacheKey(params, database);
        String cached = collateByDatabase.get(key);
        if (cached != null) {
            return cached;
        }
        String collate = "";
        try (Connection connection = super.openConnection(withProbeLoginTimeout(paramsForDatabase(params, "sysmaster")));
             PreparedStatement stmt = connection.prepareStatement(
                 "SELECT dbs_collate FROM sysmaster:sysdbslocale WHERE LOWER(dbs_dbsname) = ?")) {
            stmt.setString(1, database.toLowerCase(Locale.ROOT));
            try (ResultSet rs = stmt.executeQuery()) {
                if (rs.next()) {
                    collate = trim(rs.getString(1));
                }
            }
        } catch (Exception ignored) {
            // Keep the configured locale when the collation catalog is unreachable.
        }
        // Only cache a successful lookup. Caching an empty result would pin a transient failure —
        // or a database that was just created and is not yet listed in sysdbslocale — to the stale
        // fallback until disconnect, so leave failures uncached to retry on the next connect.
        if (!collate.isEmpty()) {
            collateByDatabase.put(key, collate);
        }
        return collate;
    }

    /**
     * Return a copy of {@code params} with a bounded {@code LOGIN_TIMEOUT} appended to its JDBC
     * parameters (unless one is already configured), so the sysmaster locale probe can never hang
     * the connect path.
     */
    private static ConnectParams withProbeLoginTimeout(ConnectParams params) {
        String urlParams = params.getUrl_params() == null ? "" : params.getUrl_params();
        if (containsIgnoreCase(urlParams, "LOGIN_TIMEOUT=")) {
            return params;
        }
        String joined = urlParams.isEmpty()
            ? "LOGIN_TIMEOUT=" + LOCALE_PROBE_LOGIN_TIMEOUT_SECS
            : urlParams + ";LOGIN_TIMEOUT=" + LOCALE_PROBE_LOGIN_TIMEOUT_SECS;
        ConnectParams copy = new ConnectParams(
            params.getHost(),
            params.getPort(),
            params.getDatabase(),
            params.getUsername(),
            params.getPassword(),
            joined,
            params.getConnection_string(),
            params.isMysql_compat_mode(),
            params.getJdbc_driver_class(),
            params.getJdbc_driver_paths()
        );
        copy.setGbase_server(params.getGbase_server());
        return copy;
    }

    private static String currentLocaleOf(ConnectParams params) {
        return connectionParameterValue(params.getUrl_params(), "DB_LOCALE");
    }

    private static String connectionParameterValue(String parameters, String parameterName) {
        for (String segment : trim(parameters).split(";")) {
            int equals = segment.indexOf('=');
            if (equals < 0) {
                continue;
            }
            String key = segment.substring(0, equals).trim();
            int urlPrefix = key.lastIndexOf(':');
            if (urlPrefix >= 0) {
                key = key.substring(urlPrefix + 1).trim();
            }
            if (key.equalsIgnoreCase(parameterName)) {
                return segment.substring(equals + 1).trim();
            }
        }
        return "";
    }

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) {
        super.afterConnect(params, connection);
        databaseListParams = paramsForDatabase(params, "sysmaster");
        clearMetadataCache();
    }

    @Override
    protected void afterDisconnect() {
        databaseListParams = null;
        collateByDatabase.clear();
        clearMetadataCache();
    }

    @Override
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        CreateDatabaseLocaleDirective directive = parseCreateDatabaseLocaleDirective(sql);
        if (directive != null) {
            runDdlOnSysmasterWithLocale(directive.statement(), directive.locale());
            clearMetadataCache();
            return new QueryResult(Collections.emptyList(), Collections.emptyList(), 0, 0);
        }
        String dropTarget = parseDropDatabaseName(sql);
        if (dropTarget != null && databaseListParams != null) {
            // Informix cannot drop a database from a session whose DB_LOCALE differs, nor the
            // current database; run it from sysmaster pinned to the target database's own locale.
            String collate = resolveCollate(databaseListParams, dropTarget);
            runDdlOnSysmasterWithLocale("DROP DATABASE " + dropTarget, collate);
            invalidateCollateCache(dropTarget);
            clearMetadataCache();
            return new QueryResult(Collections.emptyList(), Collections.emptyList(), 0, 0);
        }
        QueryResult result = super.executeQuery(sql, schema, options);
        if (mayChangeMetadata(sql)) {
            clearMetadataCache();
        }
        return result;
    }

    /**
     * Parse {@code sql} as a bare {@code DROP DATABASE <name>} statement, returning the (unquoted)
     * target database name or {@code null} for anything else. Package visible so the routing
     * decision is testable without a live connection.
     */
    static String parseDropDatabaseName(String sql) {
        if (sql == null) {
            return null;
        }
        Matcher drop = DROP_DATABASE_STATEMENT.matcher(sql);
        return drop.matches() ? drop.group(1) : null;
    }

    private void invalidateCollateCache(String database) {
        ConnectParams base = databaseListParams;
        if (base == null) {
            return;
        }
        collateByDatabase.remove(collateCacheKey(base, database));
    }

    /**
     * A {@code CREATE DATABASE} statement plus the DB_LOCALE carried by its leading directive
     * comment. Package visible so the routing decision is directly testable without a live
     * connection.
     */
    record CreateDatabaseLocaleDirective(String locale, String statement) {
    }

    /**
     * Parse {@code sql} as a directive-prefixed {@code CREATE DATABASE} (as emitted by the Rust
     * admin-SQL layer), returning {@code null} for anything else so it falls through to the
     * normal query path.
     */
    static CreateDatabaseLocaleDirective parseCreateDatabaseLocaleDirective(String sql) {
        Matcher directive = sql == null ? null : CREATE_DATABASE_LOCALE_DIRECTIVE.matcher(sql);
        if (directive == null || !directive.matches()) {
            return null;
        }
        String statement = directive.group(2).trim();
        if (!statement.regionMatches(true, 0, "CREATE DATABASE", 0, "CREATE DATABASE".length())) {
            return null;
        }
        return new CreateDatabaseLocaleDirective(directive.group(1).trim(), statement);
    }

    /**
     * Run a DDL statement (e.g. {@code CREATE DATABASE} / {@code DROP DATABASE}) on a sysmaster
     * session whose {@code DB_LOCALE} is pinned to {@code locale}. Informix has no charset clause
     * in {@code CREATE DATABASE} (the new database inherits the creating session's DB_LOCALE) and
     * cannot drop a database from a session whose locale differs, or drop the current database —
     * so both run from sysmaster with the relevant locale. Falls back to the configured locale when
     * {@code locale} is blank or unsafe.
     */
    private void runDdlOnSysmasterWithLocale(String statement, String locale) {
        ConnectParams base = databaseListParams;
        if (base == null) {
            throw new IllegalStateException("Not connected");
        }
        ConnectParams pinned = base;
        if (locale != null && SAFE_DATABASE_LOCALE.matcher(locale).matches()) {
            pinned = new ConnectParams(
                base.getHost(),
                base.getPort(),
                base.getDatabase(),
                base.getUsername(),
                base.getPassword(),
                overrideLocaleParams(base.getUrl_params(), locale),
                base.getConnection_string(),
                base.isMysql_compat_mode(),
                base.getJdbc_driver_class(),
                base.getJdbc_driver_paths()
            );
            pinned.setGbase_server(base.getGbase_server());
        }
        try (Connection connection = super.openConnection(pinned);
             Statement stmt = connection.createStatement()) {
            stmt.execute(stripTrailingSemicolon(statement));
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static String stripTrailingSemicolon(String sql) {
        String trimmed = sql.trim();
        return trimmed.endsWith(";") ? trimmed.substring(0, trimmed.length() - 1).trim() : trimmed;
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        List<DatabaseInfo> cached = cachedDatabases();
        if (cached != null) {
            return cached;
        }
        List<String> names = queryDatabaseNamesFromSysmaster();
        if (names.isEmpty()) {
            return super.listDatabases();
        }
        List<DatabaseInfo> result = new ArrayList<>();
        for (String name : names) {
            result.add(new DatabaseInfo(name));
        }
        cacheDatabases(result);
        return result;
    }

    @Override
    public List<String> listSchemas() {
        try {
            String catalog = currentCatalog();
            List<String> cached = cachedSchemas(catalog);
            if (cached != null) {
                return cached;
            }
            Connection connection = requireConnection();
            if (!connection.getMetaData().supportsSchemasInDataManipulation()) {
                List<String> schemas = Collections.emptyList();
                cacheSchemas(catalog, schemas);
                return schemas;
            }
            Set<String> schemas = new LinkedHashSet<>();
            try (PreparedStatement stmt = connection.prepareStatement(
                "SELECT DISTINCT owner FROM systables WHERE tabid >= 100 AND tabtype IN ('T', 'V') ORDER BY owner"
            ); ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    String owner = trim(rs.getString("owner"));
                    if (!owner.isEmpty()) {
                        schemas.add(owner);
                    }
                }
            }
            List<String> result = new ArrayList<>(schemas);
            Collections.sort(result);
            cacheSchemas(catalog, result);
            return result;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        try {
            String catalog = currentCatalog();
            List<TableInfo> cached = cachedTables(catalog, schema);
            if (cached != null) {
                return cached;
            }
            List<TableInfo> result = new ArrayList<>();
            String owner = trim(schema);
            String sql = """
                SELECT t.tabname, t.tabtype, c.comments
                FROM systables t
                LEFT JOIN syscomms c ON c.tabid = t.tabid
                WHERE t.tabid >= 100 AND t.tabtype IN ('T', 'V')
                """.stripIndent().trim();
            if (!owner.isEmpty()) {
                sql += " AND t.owner = ?";
            }
            sql += " ORDER BY tabname";
            try (PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                if (!owner.isEmpty()) {
                    stmt.setString(1, owner);
                }
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(
                            trim(rs.getString("tabname")),
                            tableType(rs.getString("tabtype")),
                            emptyToNull(trim(rs.getString("comments")))
                        ));
                    }
                }
            }
            result.sort(Comparator.comparing(TableInfo::getName));
            cacheTables(catalog, schema, result);
            return result;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @Override
    public List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        if (isUnconstrained(normalized)) {
            return listTables(schema);
        }
        return queryConstrainedTables(schema, normalized);
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        try {
            Connection conn = requireConnection();
            String owner = trim(schema);
            Set<Integer> primaryKeyColumns = getPrimaryKeyColumnNumbers(conn, owner, table);
            boolean mysqlCompatMode = isMysqlCompatMode(databaseListParams);
            Map<String, String> columnDefaults = loadColumnDefaults(conn, owner, table, mysqlCompatMode);
            List<Object> args = new ArrayList<>();
            args.add(table);
            StringBuilder sql = new StringBuilder("""
                SELECT c.colname, c.coltype, c.colno, c.collength, cc.comments
                FROM syscolumns c
                JOIN systables t ON t.tabid = c.tabid
                LEFT JOIN syscolcomms cc ON cc.tabid = c.tabid AND cc.colno = c.colno
                WHERE t.tabid >= 100 AND t.tabname = ?
                """.stripIndent().trim());
            if (!owner.isEmpty()) {
                sql.append(" AND t.owner = ?");
                args.add(owner);
            }
            sql.append(" ORDER BY c.colno");

            List<ColumnInfo> result = new ArrayList<>();
            try (PreparedStatement stmt = conn.prepareStatement(sql.toString())) {
                bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String name = trim(rs.getString("colname"));
                        int coltype = rs.getInt("coltype");
                        int baseType = baseColType(coltype);
                        int length = rs.getInt("collength");
                        result.add(new ColumnInfo(
                            name,
                            mapColType(baseType),
                            (coltype & 256) == 0,
                            columnDefaults.get(name),
                            primaryKeyColumns.contains(rs.getInt("colno")),
                            null,
                            emptyToNull(trim(rs.getString("comments"))),
                            numericPrecision(baseType, length),
                            numericScale(baseType, length),
                            characterMaximumLength(baseType, length)
                        ));
                    }
                }
            }
            return result;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static Map<String, String> loadColumnDefaults(
        Connection conn,
        String owner,
        String table,
        boolean mysqlCompatMode
    ) {
        List<Object> args = new ArrayList<>();
        args.add(table);
        StringBuilder sql = new StringBuilder("""
            SELECT c.colname, %s AS column_default
            FROM systables t
            JOIN syscolumns c ON t.tabid = c.tabid
            JOIN sysdefaultsexpr e ON c.tabid = e.tabid AND c.colno = e.colno
            WHERE t.tabname = ? AND e.type = 'T'
            """.formatted(mysqlCompatMode ? "e.`default`" : "e.default").stripIndent().trim());
        if (!owner.isEmpty()) {
            sql.append(" AND t.owner = ?");
            args.add(owner);
        }

        Map<String, String> defaults = new LinkedHashMap<>();
        try (PreparedStatement stmt = conn.prepareStatement(sql.toString())) {
            bind(stmt, args);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    String value = rs.getString("column_default");
                    if (value != null) {
                        defaults.put(trim(rs.getString("colname")), value);
                    }
                }
            }
        } catch (SQLException ignored) {
            return Collections.emptyMap();
        }
        return defaults;
    }

    private static boolean isMysqlCompatMode(ConnectParams params) {
        if (params == null) {
            return false;
        }
        if (params.isMysql_compat_mode()) {
            return true;
        }
        String sqlMode = connectionParameterValue(buildUrl(params), "SQLMODE");
        return sqlMode.equalsIgnoreCase("mysql");
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        try {
            String owner = trim(schema);
            List<Object> args = new ArrayList<>();
            args.add(table);
            StringBuilder sql = new StringBuilder("""
                SELECT i.idxname, i.idxtype, c.constrtype,
                       i.part1, i.part2, i.part3, i.part4, i.part5, i.part6, i.part7, i.part8,
                       i.part9, i.part10, i.part11, i.part12, i.part13, i.part14, i.part15, i.part16
                FROM sysindexes i
                JOIN systables t ON t.tabid = i.tabid
                LEFT JOIN sysconstraints c ON c.tabid = i.tabid AND c.idxname = i.idxname
                WHERE t.tabid >= 100 AND t.tabname = ?
                """.stripIndent().trim());
            if (!owner.isEmpty()) {
                sql.append(" AND t.owner = ?");
                args.add(owner);
            }
            sql.append(" ORDER BY i.idxname");

            Map<Integer, String> columnNames = loadColumnNamesByNumber(owner, table);
            List<IndexInfo> result = new ArrayList<>();
            try (PreparedStatement stmt = requireConnection().prepareStatement(sql.toString())) {
                bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String name = trim(rs.getString("idxname"));
                        if (name.isEmpty()) {
                            continue;
                        }
                        List<Integer> parts = readIndexParts(rs);
                        List<String> columns = resolveIndexColumns(parts, columnNames);
                        String indexType = trim(rs.getString("idxtype"));
                        String constraintType = trim(rs.getString("constrtype"));
                        result.add(new IndexInfo(
                            name,
                            columns,
                            indexType.toUpperCase(Locale.ROOT).startsWith("U"),
                            "P".equalsIgnoreCase(constraintType),
                            null,
                            indexType,
                            null,
                            null
                        ));
                    }
                }
            }
            return result;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String normalizedType = objectType == null ? "" : objectType.trim().toUpperCase(Locale.ROOT);
        if (!"VIEW".equals(normalizedType)) {
            throw new UnsupportedOperationException("Object source is not supported");
        }
        return new ObjectSource(name, "VIEW", emptyToNull(trim(schema)), viewSource(schema, name), isEditableView(schema, name));
    }

    @Override
    public String getTableDdl(String schema, String table) {
        if ("VIEW".equals(tableType(schema, table))) {
            return viewSource(schema, table);
        }
        return super.getTableDdl(schema, table);
    }

    private List<TableInfo> queryConstrainedTables(String schema, MetadataListConstraints constraints) {
        if (!constraints.includesTableLikeTypes()) {
            return List.of();
        }
        try {
            List<TableInfo> result = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            String owner = trim(schema);
            // GBase 8s follows Informix-style SKIP/FIRST pagination in the SELECT list.
            StringBuilder sql = new StringBuilder("SELECT ");
            if (constraints.hasOffset()) {
                sql.append("SKIP ").append(constraints.getOffset()).append(' ');
            }
            if (constraints.hasLimit()) {
                sql.append("FIRST ").append(constraints.getLimit()).append(' ');
            }
            sql.append("t.tabname, t.tabtype, c.comments FROM systables t LEFT JOIN syscomms c ON c.tabid = t.tabid WHERE t.tabid >= 100");
            appendGbase8sTableTypePredicate(sql, constraints);
            if (!owner.isEmpty()) {
                sql.append(" AND t.owner = ?");
                args.add(owner);
            }
            if (constraints.hasFilter()) {
                sql.append(" AND UPPER(t.tabname) LIKE ? ESCAPE '\\\\'");
                args.add(constraints.fuzzyLikePattern().toUpperCase(Locale.ROOT));
            }
            sql.append(" ORDER BY t.tabname");
            try (PreparedStatement stmt = requireConnection().prepareStatement(sql.toString())) {
                bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(
                            trim(rs.getString("tabname")),
                            tableType(rs.getString("tabtype")),
                            emptyToNull(trim(rs.getString("comments")))
                        ));
                    }
                }
            }
            result.sort(Comparator.comparing(TableInfo::getName));
            return constraints.withoutPaging().filterTables(result);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(Gbase8sAgent::new).run();
    }

    private static int port(ConnectParams params) {
        return params.getPort() > 0 ? params.getPort() : GBASE8S_PROFILE.getDefaultPort();
    }

    private static String defaultGbaseServer(String host) {
        return isIpAddress(host) ? "gbase8s" : host;
    }

    private static boolean isIpAddress(String host) {
        return host.matches("\\d{1,3}(\\.\\d{1,3}){3}") || host.contains(":");
    }

    private static String trimStart(String value, char... chars) {
        int start = 0;
        while (start < value.length() && contains(chars, value.charAt(start))) {
            start++;
        }
        return value.substring(start);
    }

    private static String trimEnd(String value, char... chars) {
        int end = value.length();
        while (end > 0 && contains(chars, value.charAt(end - 1))) {
            end--;
        }
        return value.substring(0, end);
    }

    private static boolean contains(char[] chars, char value) {
        for (char ch : chars) {
            if (ch == value) {
                return true;
            }
        }
        return false;
    }

    private static boolean containsIgnoreCase(String value, String needle) {
        return value.toLowerCase(Locale.ROOT).contains(needle.toLowerCase(Locale.ROOT));
    }

    /**
     * Force {@code CLIENT_LOCALE} and {@code DB_LOCALE} in a {@code ;}-separated JDBC parameter
     * string to {@code collate}, leaving every other parameter (and their order) untouched.
     *
     * <p>A GBase 8s / Informix instance can host databases with different locales, and the JDBC
     * driver rejects a connection whose {@code DB_LOCALE} does not match the target database's real
     * locale with "database locale information mismatch" (数据库地点信息不匹配). A single connection
     * profile only pins one locale, so reusing it to open a differently-locale database fails. The
     * agent therefore resolves each database's real collation from {@code sysmaster.sysdbslocale}
     * and rewrites both locale parameters to it, so every database under the connection opens with
     * its own locale. Setting {@code CLIENT_LOCALE} to the same value keeps client and database
     * codesets identical, which avoids the cross-codeset conversion the bundled client cannot load.
     */
    static String overrideLocaleParams(String jdbcParams, String collate) {
        if (collate == null || collate.trim().isEmpty()) {
            return jdbcParams;
        }
        String value = collate.trim();
        // The value is concatenated into the JDBC URL; only accept an ordinary locale token so a
        // malformed or hostile server-reported collation cannot inject extra parameters.
        if (!SAFE_DATABASE_LOCALE.matcher(value).matches()) {
            return jdbcParams;
        }
        List<String> segments = new ArrayList<>();
        if (jdbcParams != null && !jdbcParams.isEmpty()) {
            for (String segment : jdbcParams.split(";")) {
                int equals = segment.indexOf('=');
                String key = (equals >= 0 ? segment.substring(0, equals) : segment).trim();
                if (key.equalsIgnoreCase("CLIENT_LOCALE")) {
                    segments.add("CLIENT_LOCALE=" + value);
                } else if (key.equalsIgnoreCase("DB_LOCALE")) {
                    segments.add("DB_LOCALE=" + value);
                } else {
                    segments.add(segment);
                }
            }
        }
        boolean hasClient = false;
        boolean hasDb = false;
        for (String segment : segments) {
            String key = segment.substring(0, Math.max(segment.indexOf('='), 0)).trim();
            if (key.equalsIgnoreCase("CLIENT_LOCALE")) {
                hasClient = true;
            } else if (key.equalsIgnoreCase("DB_LOCALE")) {
                hasDb = true;
            }
        }
        if (!hasClient) {
            segments.add("CLIENT_LOCALE=" + value);
        }
        if (!hasDb) {
            segments.add("DB_LOCALE=" + value);
        }
        return String.join(";", segments);
    }

    private List<String> queryDatabaseNamesFromSysmaster() {
        ConnectParams params = databaseListParams;
        if (params == null) {
            return Collections.emptyList();
        }
        try (Connection connection = openInitializedConnection(params)) {
            return queryDatabaseNames(connection, "SELECT name FROM sysdatabases ORDER BY name");
        } catch (Exception ignored) {
            return Collections.emptyList();
        }
    }

    private static List<String> queryDatabaseNames(Connection connection, String sql) throws Exception {
        Set<String> names = new LinkedHashSet<>();
        try (PreparedStatement stmt = connection.prepareStatement(sql); ResultSet rs = stmt.executeQuery()) {
            while (rs.next()) {
                String name = trim(rs.getString(1));
                if (!name.isEmpty()) {
                    names.add(name);
                }
            }
        }
        List<String> result = new ArrayList<>(names);
        Collections.sort(result);
        return result;
    }

    private static String tableType(String tabtype) {
        return "V".equalsIgnoreCase(trim(tabtype)) ? "VIEW" : "TABLE";
    }

    private String tableType(String schema, String table) {
        try {
            String owner = trim(schema);
            List<Object> args = new ArrayList<>();
            args.add(table);
            StringBuilder sql = new StringBuilder("SELECT tabtype FROM systables WHERE tabid >= 100 AND tabname = ?");
            if (!owner.isEmpty()) {
                sql.append(" AND owner = ?");
                args.add(owner);
            }
            try (PreparedStatement stmt = requireConnection().prepareStatement(sql.toString())) {
                bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    return rs.next() ? tableType(rs.getString("tabtype")) : "";
                }
            }
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private String viewSource(String schema, String name) {
        try {
            String owner = trim(schema);
            List<Object> args = new ArrayList<>();
            args.add(name);
            StringBuilder sql = new StringBuilder("""
                SELECT v.viewtext
                FROM sysviews v
                JOIN systables t ON t.tabid = v.tabid
                WHERE t.tabname = ?
                """.stripIndent().trim());
            if (!owner.isEmpty()) {
                sql.append(" AND t.owner = ?");
                args.add(owner);
            }
            sql.append(" ORDER BY v.seqno");
            StringBuilder source = new StringBuilder();
            try (PreparedStatement stmt = requireConnection().prepareStatement(sql.toString())) {
                bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String chunk = rs.getString("viewtext");
                        source.append(chunk == null ? "" : chunk);
                    }
                }
            }
            String result = stripTrailing(source.toString());
            if (result.isEmpty()) {
                throw new IllegalArgumentException("View source not found: " + name);
            }
            return result;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private boolean isEditableView(String schema, String name) {
        try {
            String owner = trim(schema);
            List<Object> args = new ArrayList<>();
            args.add(name);
            StringBuilder sql = new StringBuilder("""
                SELECT t.tabid, t.owner,
                       (SELECT v.tabid FROM systables v WHERE UPPER(TRIM(v.tabname)) = 'VERSION') AS system_boundary_tabid
                FROM systables t
                WHERE t.tabtype = 'V' AND t.tabname = ?
                """.stripIndent().trim());
            if (!owner.isEmpty()) {
                sql.append(" AND t.owner = ?");
                args.add(owner);
            }
            try (PreparedStatement stmt = requireConnection().prepareStatement(sql.toString())) {
                bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    if (!rs.next()) {
                        return true;
                    }
                    int systemBoundaryTabid = rs.getInt("system_boundary_tabid");
                    Integer boundary = rs.wasNull() ? null : systemBoundaryTabid;
                    return !isSystemCatalogView(rs.getInt("tabid"), rs.getString("owner"), boundary);
                }
            }
        } catch (Exception ignored) {
            return true;
        }
    }

    private static boolean isSystemCatalogView(int tabid, String owner, Integer systemBoundaryTabid) {
        if (!"gbasedbt".equalsIgnoreCase(trim(owner))) {
            return false;
        }
        // GBase 8s marks system catalog tables before/at VERSION; avoid a fixed tabid threshold
        // so ordinary gbasedbt-owned user views are still editable.
        if (systemBoundaryTabid != null && systemBoundaryTabid > 0) {
            return tabid <= systemBoundaryTabid;
        }
        return tabid < 100;
    }

    public static String mapColType(int coltype) {
        return switch (baseColType(coltype)) {
            case 0 -> "CHAR";
            case 1 -> "SMALLINT";
            case 2 -> "INTEGER";
            case 3 -> "FLOAT";
            case 4 -> "SMALLFLOAT";
            case 5 -> "DECIMAL";
            case 6 -> "SERIAL";
            case 7 -> "DATE";
            case 8 -> "MONEY";
            case 9 -> "NULL";
            case 10 -> "DATETIME";
            case 11 -> "BYTE";
            case 12 -> "TEXT";
            case 13 -> "VARCHAR";
            case 14 -> "INTERVAL";
            case 15 -> "NCHAR";
            case 16 -> "NVARCHAR";
            case 17 -> "INT8";
            case 18 -> "SERIAL8";
            case 19 -> "SET";
            case 20 -> "MULTISET";
            case 21 -> "LIST";
            case 22 -> "ROW";
            case 23 -> "COLLECTION";
            case 40 -> "LVARCHAR";
            case 41 -> "BOOLEAN";
            case 43, 52 -> "BIGINT";
            case 44, 53 -> "BIGSERIAL";
            // MySQL-compat extended types (SQLMODE=mysql); codes match the
            // 3.6.5+ driver's IfxBigIntUnsigned/IfxTinyInt/IfxMediumInt/IfxBit.
            case 66 -> "BIGINT UNSIGNED";
            case 67 -> "TINYINT";
            case 68 -> "MEDIUMINT";
            case 69 -> "BIT";
            default -> "UNKNOWN(" + baseColType(coltype) + ")";
        };
    }

    public static Set<Integer> primaryKeyColumnNumbers(List<Integer> parts) {
        Set<Integer> result = new HashSet<>();
        for (Integer part : parts) {
            if (part == null) {
                continue;
            }
            int value = Math.abs(part);
            if (value > 0) {
                result.add(value);
            }
        }
        return result;
    }

    static List<String> resolveIndexColumns(List<Integer> parts, Map<Integer, String> columnNames) {
        List<String> result = new ArrayList<>();
        for (Integer part : parts) {
            if (part == null || part == 0) {
                continue;
            }
            // Informix-compatible catalogs encode descending index columns as negative column numbers.
            String columnName = columnNames.get(Math.abs(part));
            if (columnName != null && !columnName.isEmpty()) {
                result.add(columnName);
            }
        }
        return result;
    }

    private Map<Integer, String> loadColumnNamesByNumber(String owner, String table) throws Exception {
        List<Object> args = new ArrayList<>();
        args.add(table);
        StringBuilder sql = new StringBuilder("""
            SELECT c.colno, c.colname
            FROM syscolumns c
            JOIN systables t ON t.tabid = c.tabid
            WHERE t.tabid >= 100 AND t.tabname = ?
            """.stripIndent().trim());
        if (!owner.isEmpty()) {
            sql.append(" AND t.owner = ?");
            args.add(owner);
        }

        Map<Integer, String> result = new LinkedHashMap<>();
        try (PreparedStatement stmt = requireConnection().prepareStatement(sql.toString())) {
            bind(stmt, args);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    result.put(rs.getInt("colno"), trim(rs.getString("colname")));
                }
            }
        }
        return result;
    }

    private static List<Integer> readIndexParts(ResultSet rs) throws Exception {
        List<Integer> parts = new ArrayList<>();
        for (int index = 1; index <= 16; index += 1) {
            int value = rs.getInt("part" + index);
            parts.add(rs.wasNull() ? null : value);
        }
        return parts;
    }

    private Set<Integer> getPrimaryKeyColumnNumbers(Connection conn, String owner, String table) throws Exception {
        List<Object> args = new ArrayList<>();
        args.add(table);
        StringBuilder sql = new StringBuilder("""
            SELECT i.part1, i.part2, i.part3, i.part4, i.part5, i.part6, i.part7, i.part8,
                   i.part9, i.part10, i.part11, i.part12, i.part13, i.part14, i.part15, i.part16
            FROM sysconstraints c
            JOIN sysindexes i ON i.idxname = c.idxname AND i.tabid = c.tabid
            JOIN systables t ON t.tabid = c.tabid
            WHERE t.tabname = ? AND c.constrtype = 'P'
            """.stripIndent().trim());
        if (!owner.isEmpty()) {
            sql.append(" AND t.owner = ?");
            args.add(owner);
        }

        try (PreparedStatement stmt = conn.prepareStatement(sql.toString())) {
            bind(stmt, args);
            try (ResultSet rs = stmt.executeQuery()) {
                if (!rs.next()) {
                    return Collections.emptySet();
                }
                List<Integer> parts = new ArrayList<>();
                for (int index = 1; index <= 16; index += 1) {
                    int value = rs.getInt(index);
                    parts.add(rs.wasNull() ? null : value);
                }
                return primaryKeyColumnNumbers(parts);
            }
        }
    }

    private static int baseColType(int coltype) {
        return coltype % 256;
    }

    private static Integer numericPrecision(int baseType, int length) {
        if (baseType == 5 || baseType == 8) {
            return (length >> 8) & 0xff;
        }
        return null;
    }

    private static Integer numericScale(int baseType, int length) {
        if (baseType == 5 || baseType == 8) {
            return length & 0xff;
        }
        return null;
    }

    private static Integer characterMaximumLength(int baseType, int length) {
        return switch (baseType) {
            case 0, 13, 15, 16, 40 -> length;
            default -> null;
        };
    }

    private static void appendGbase8sTableTypePredicate(StringBuilder sql, MetadataListConstraints constraints) {
        if (!constraints.hasObjectTypes()) {
            sql.append(" AND tabtype IN ('T', 'V')");
            return;
        }
        List<String> tabTypes = new ArrayList<>();
        if (constraints.tableTypeAllowed("TABLE")) {
            tabTypes.add("'T'");
        }
        if (constraints.tableTypeAllowed("VIEW")) {
            tabTypes.add("'V'");
        }
        if (tabTypes.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND tabtype IN (").append(String.join(", ", tabTypes)).append(")");
    }

    private static void bind(PreparedStatement stmt, List<Object> args) throws SQLException {
        for (int index = 0; index < args.size(); index += 1) {
            stmt.setString(index + 1, String.valueOf(args.get(index)));
        }
    }

    private static boolean isUnconstrained(MetadataListConstraints constraints) {
        return !constraints.hasFilter()
            && !constraints.hasLimit()
            && !constraints.hasOffset()
            && !constraints.hasObjectTypes();
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    private static String emptyToNull(String value) {
        return value.isEmpty() ? null : value;
    }

    private static String stripTrailing(String value) {
        return value == null ? "" : value.stripTrailing();
    }

    private String currentCatalog() {
        try {
            return trim(requireConnection().getCatalog());
        } catch (Exception ignored) {
            return "";
        }
    }

    private List<DatabaseInfo> cachedDatabases() {
        synchronized (metadataCacheLock) {
            if (cacheFresh(databaseCacheTimeMillis) && !databaseCache.isEmpty()) {
                return new ArrayList<>(databaseCache);
            }
        }
        return null;
    }

    private void cacheDatabases(List<DatabaseInfo> databases) {
        synchronized (metadataCacheLock) {
            databaseCache = new ArrayList<>(databases);
            databaseCacheTimeMillis = System.currentTimeMillis();
        }
    }

    private List<String> cachedSchemas(String catalog) {
        synchronized (metadataCacheLock) {
            if (cacheFresh(schemaCacheTimeMillis) && schemaCacheCatalog.equals(catalog)) {
                return new ArrayList<>(schemaCache);
            }
        }
        return null;
    }

    private void cacheSchemas(String catalog, List<String> schemas) {
        synchronized (metadataCacheLock) {
            schemaCacheCatalog = catalog;
            schemaCache = new ArrayList<>(schemas);
            schemaCacheTimeMillis = System.currentTimeMillis();
        }
    }

    private List<TableInfo> cachedTables(String catalog, String schema) {
        String owner = trim(schema);
        synchronized (metadataCacheLock) {
            if (cacheFresh(tableCacheTimeMillis) && tableCacheCatalog.equals(catalog) && tableCacheSchema.equals(owner)) {
                return new ArrayList<>(tableCache);
            }
        }
        return null;
    }

    private void cacheTables(String catalog, String schema, List<TableInfo> tables) {
        synchronized (metadataCacheLock) {
            tableCacheCatalog = catalog;
            tableCacheSchema = trim(schema);
            tableCache = new ArrayList<>(tables);
            tableCacheTimeMillis = System.currentTimeMillis();
        }
    }

    private boolean cacheFresh(long timeMillis) {
        return timeMillis > 0 && System.currentTimeMillis() - timeMillis <= METADATA_CACHE_TTL_MILLIS;
    }

    private void clearMetadataCache() {
        synchronized (metadataCacheLock) {
            databaseCacheTimeMillis = 0;
            databaseCache = Collections.emptyList();
            schemaCacheCatalog = "";
            schemaCacheTimeMillis = 0;
            schemaCache = Collections.emptyList();
            tableCacheCatalog = "";
            tableCacheSchema = "";
            tableCacheTimeMillis = 0;
            tableCache = Collections.emptyList();
        }
    }

    private static boolean mayChangeMetadata(String sql) {
        String normalized = trim(sql).toLowerCase(Locale.ROOT);
        return normalized.startsWith("create ")
            || normalized.startsWith("drop ")
            || normalized.startsWith("alter ")
            || normalized.startsWith("rename ")
            || normalized.startsWith("truncate ");
    }
}
