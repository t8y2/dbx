package com.dbx.agent.gbase8s;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.JsonRpcServer;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public final class Gbase8sAgent extends ConfiguredJdbcAgent {
    private static final long METADATA_CACHE_TTL_MILLIS = 10_000L;

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

    public Gbase8sAgent() {
        super(GBASE8S_PROFILE);
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

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return buildUrl(params);
    }

    @Override
    protected void afterConnect(ConnectParams params, Connection connection) {
        super.afterConnect(params, connection);
        clearMetadataCache();
    }

    @Override
    public void disconnect() {
        clearMetadataCache();
        super.disconnect();
    }

    @Override
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        QueryResult result = super.executeQuery(sql, schema, options);
        if (mayChangeMetadata(sql)) {
            clearMetadataCache();
        }
        return result;
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        List<DatabaseInfo> cached = cachedDatabases();
        if (cached != null) {
            return cached;
        }
        List<String> names = queryDatabaseNamesInCatalog("sysmaster", "SELECT name FROM sysdatabases ORDER BY name");
        if (names.isEmpty()) {
            names = queryDatabaseNames("SELECT name FROM sysmaster:sysdatabases ORDER BY name");
        }
        if (names.isEmpty()) {
            names = queryDatabaseNames("SELECT name FROM sysdatabases ORDER BY name");
        }
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
            Set<String> schemas = new LinkedHashSet<>();
            try (PreparedStatement stmt = requireConnection().prepareStatement(
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
            String sql = "SELECT tabname, tabtype FROM systables WHERE tabid >= 100 AND tabtype IN ('T', 'V')";
            if (!owner.isEmpty()) {
                sql += " AND owner = ?";
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
                            tableType(rs.getString("tabtype"))
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
            sql.append("tabname, tabtype FROM systables WHERE tabid >= 100");
            appendGbase8sTableTypePredicate(sql, constraints);
            if (!owner.isEmpty()) {
                sql.append(" AND owner = ?");
                args.add(owner);
            }
            if (constraints.hasFilter()) {
                sql.append(" AND UPPER(tabname) LIKE ? ESCAPE '\\\\'");
                args.add(constraints.fuzzyLikePattern().toUpperCase(Locale.ROOT));
            }
            sql.append(" ORDER BY tabname");
            try (PreparedStatement stmt = requireConnection().prepareStatement(sql.toString())) {
                bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(
                            trim(rs.getString("tabname")),
                            tableType(rs.getString("tabtype"))
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
        new JsonRpcServer(new Gbase8sAgent()).run();
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

    private List<String> queryDatabaseNames(String sql) {
        try {
            return queryDatabaseNames(requireConnection(), sql);
        } catch (Exception ignored) {
            return Collections.emptyList();
        }
    }

    private List<String> queryDatabaseNamesInCatalog(String catalog, String sql) {
        try {
            Connection connection = requireConnection();
            String previousCatalog = "";
            try {
                previousCatalog = trim(connection.getCatalog());
            } catch (Exception ignored) {
            }
            connection.setCatalog(catalog);
            try {
                return queryDatabaseNames(connection, sql);
            } finally {
                if (!previousCatalog.isEmpty()) {
                    try {
                        connection.setCatalog(previousCatalog);
                    } catch (Exception ignored) {
                    }
                }
            }
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

    private static void bind(PreparedStatement stmt, List<Object> args) throws Exception {
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
