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
                            null,
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
