package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.DdlBuilder;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

public final class OceanBaseOracleAgent extends ConfiguredJdbcAgent {
    private static final long MICROS_PER_SECOND = 1_000_000L;
    private static final String COMPATIBLE_OJDBC_VERSION = "compatibleOjdbcVersion";
    private static final String DEFAULT_COMPATIBLE_OJDBC_VERSION = "compatibleOjdbcVersion=8";
    private static final Set<String> SYSTEM_SCHEMAS = Set.of(
        "SYS", "SYSTEM", "SYSMAN", "DBSNMP", "SYSBACKUP", "SYSDG", "SYSKM", "OUTLN",
        "AUDSYS", "LBACSYS", "DVF", "DVSYS", "APPQOSSYS", "CTXSYS", "MDSYS", "MDDATA",
        "ORDSYS", "ORDDATA", "ORDPLUGINS", "XDB", "ANONYMOUS", "DIP", "EXFSYS",
        "GSMADMIN_INTERNAL", "GSMCATUSER", "GSMUSER", "OJVMSYS", "OLAPSYS",
        "ORACLE_OCM", "SI_INFORMTN_SCHEMA", "WMSYS", "XS$NULL", "DBSFWUSER",
        "REMOTE_SCHEDULER_AGENT", "PDBADMIN", "DGPDB_INT", "OPS$ORACLE",
        "GGSYS", "FLOWS_FILES", "APEX_PUBLIC_USER", "GSMROOTUSER", "SYSRAC"
    );

    public static final JdbcAgentProfile OCEANBASE_ORACLE_PROFILE = new JdbcAgentProfile(
        "com.oceanbase.jdbc.Driver",
        "jdbc:oceanbase://{host}:{port}/{database}",
        2883,
        false,
        SYSTEM_SCHEMAS,
        List.of("TABLE", "VIEW", "BASE TABLE")
    ) {
        @Override
        public String schemaSwitchSql(String schema, String quote) {
            return "ALTER SESSION SET CURRENT_SCHEMA = " + quote + schema.replace(quote, quote + quote) + quote;
        }
    };

    public OceanBaseOracleAgent() {
        super(OCEANBASE_ORACLE_PROFILE);
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return buildUrl(params);
    }

    static String buildUrl(ConnectParams params) {
        return appendDefaultCompatibilityOption(OCEANBASE_ORACLE_PROFILE.buildUrl(params));
    }

    @Override
    protected void beforeQueryExecution(Connection connection, int timeoutSecs) throws SQLException {
        // Connector/J's Statement timeout does not update OceanBase's stricter
        // session variable, so synchronize both limits before every execution.
        try (var stmt = connection.createStatement()) {
            stmt.execute(queryTimeoutSql(timeoutSecs));
        }
    }

    static String queryTimeoutSql(int timeoutSecs) {
        if (timeoutSecs < 0) {
            throw new IllegalArgumentException("Query timeout cannot be negative: " + timeoutSecs);
        }
        return "ALTER SESSION SET ob_query_timeout = " + timeoutSecs * MICROS_PER_SECOND;
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            List<DatabaseInfo> result = new ArrayList<>();
            for (String schema : querySchemas()) {
                result.add(new DatabaseInfo(schema));
            }
            return result;
        });
    }

    @Override
    public List<String> listSchemas() {
        return unchecked(this::querySchemas);
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return queryTables(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        return queryTables(schema, MetadataListConstraints.orNone(constraints));
    }

    private List<TableInfo> queryTables(String schema, MetadataListConstraints constraints) {
        return unchecked(() -> {
            String owner = normalizeSchema(schema);
            List<String> objectTypes = oceanBaseTableTypes(constraints);
            if (objectTypes.isEmpty()) {
                return List.of();
            }
            String baseSql = """
                SELECT o.OBJECT_NAME,
                    CASE o.OBJECT_TYPE WHEN 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS TABLE_TYPE,
                    c.COMMENTS
                FROM ALL_OBJECTS o
                LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME
                WHERE o.OWNER = ? AND o.OBJECT_TYPE IN (%s)
                """.stripIndent().trim();
            MetadataSql query = oceanBaseMetadataSql(
                String.format(baseSql, placeholders(objectTypes.size())),
                "OBJECT_NAME, TABLE_TYPE, COMMENTS",
                "o.OBJECT_NAME",
                "ORDER BY OBJECT_NAME",
                owner,
                objectTypes,
                constraints
            );

            List<TableInfo> result = new ArrayList<>();
            try (var stmt = requireConnection().prepareStatement(query.sql)) {
                bind(stmt, query.args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(rs.getString(1), rs.getString(2), rs.getString(3)));
                    }
                }
            }
            return constraints.withoutPaging().filterTables(result);
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return queryObjects(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<ObjectInfo> listObjects(String schema, MetadataListConstraints constraints) {
        return queryObjects(schema, MetadataListConstraints.orNone(constraints));
    }

    private List<ObjectInfo> queryObjects(String schema, MetadataListConstraints constraints) {
        return unchecked(() -> {
            String owner = normalizeSchema(schema);
            List<String> objectTypes = oceanBaseObjectTypes(constraints);
            if (objectTypes.isEmpty()) {
                return List.of();
            }
            String baseSql = """
                SELECT OBJECT_NAME, OBJECT_TYPE
                FROM ALL_OBJECTS
                WHERE OWNER = ? AND OBJECT_TYPE IN (%s)
                """.stripIndent().trim();
            MetadataSql query = oceanBaseMetadataSql(
                String.format(baseSql, placeholders(objectTypes.size())),
                "OBJECT_NAME, OBJECT_TYPE",
                "OBJECT_NAME",
                """
                ORDER BY CASE OBJECT_TYPE
                    WHEN 'TABLE' THEN 0
                    WHEN 'VIEW' THEN 1
                    WHEN 'PROCEDURE' THEN 2
                    WHEN 'FUNCTION' THEN 3
                    WHEN 'PACKAGE' THEN 4
                    WHEN 'SEQUENCE' THEN 5
                    ELSE 6
                END, OBJECT_NAME
                """.stripIndent().trim(),
                owner,
                objectTypes,
                constraints
            );

            List<ObjectInfo> result = new ArrayList<>();
            try (var stmt = requireConnection().prepareStatement(query.sql)) {
                bind(stmt, query.args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString(1), rs.getString(2), owner, null));
                    }
                }
            }
            return constraints.withoutPaging().filterObjects(result);
        });
    }

    private static MetadataSql oceanBaseMetadataSql(
        String baseSql,
        String selectList,
        String nameColumn,
        String orderSql,
        String owner,
        List<String> objectTypes,
        MetadataListConstraints constraints
    ) {
        List<Object> args = new ArrayList<>();
        args.add(owner);
        args.addAll(objectTypes);
        String sql = baseSql;
        if (constraints.hasFilter()) {
            sql += " AND UPPER(" + nameColumn + ") LIKE ? ESCAPE '\\'";
            args.add(constraints.fuzzyLikePattern().toUpperCase(Locale.ROOT));
        }
        sql += "\n" + orderSql;
        if (constraints.hasLimit()) {
            // OceanBase Oracle mode is safest with the classic ordered ROWNUM wrapper for paged metadata.
            int offset = constraints.getOffset() == null ? 0 : constraints.getOffset();
            sql = "SELECT " + selectList + "\nFROM (\n  SELECT DBX_Q.*, ROWNUM AS DBX_RN\n  FROM (\n"
                + sql
                + "\n  ) DBX_Q\n  WHERE ROWNUM <= ?\n)\nWHERE DBX_RN > ?";
            args.add(offset + constraints.getLimit());
            args.add(offset);
        } else if (constraints.hasOffset()) {
            sql = "SELECT " + selectList + "\nFROM (\n  SELECT DBX_Q.*, ROWNUM AS DBX_RN\n  FROM (\n"
                + sql
                + "\n  ) DBX_Q\n)\nWHERE DBX_RN > ?";
            args.add(constraints.getOffset());
        }
        return new MetadataSql(sql, args);
    }

    private static List<String> oceanBaseTableTypes(MetadataListConstraints constraints) {
        if (!constraints.hasObjectTypes()) {
            return List.of("TABLE", "VIEW");
        }
        List<String> result = new ArrayList<>();
        if (constraints.tableTypeAllowed("TABLE")) {
            result.add("TABLE");
        }
        if (constraints.tableTypeAllowed("VIEW")) {
            result.add("VIEW");
        }
        return result;
    }

    private static List<String> oceanBaseObjectTypes(MetadataListConstraints constraints) {
        List<String> supported = List.of("TABLE", "VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "SEQUENCE", "SYNONYM");
        if (!constraints.hasObjectTypes()) {
            return supported;
        }
        List<String> result = new ArrayList<>();
        for (String objectType : supported) {
            if (constraints.objectTypeAllowed(objectType)) {
                result.add(objectType);
            }
        }
        return result;
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        return unchecked(() -> {
            String owner = normalizeSchema(schema);
            String normalizedType = normalizeObjectSourceType(objectType);
            String source;
            SQLException metadataError = null;
            try {
                source = queryDbmsMetadataSource(owner, name, normalizedType);
            } catch (SQLException e) {
                metadataError = e;
                source = null;
            }

            if ((source == null || source.trim().isEmpty()) && supportsDictionarySource(normalizedType)) {
                try {
                    // OceanBase versions and tenant privileges differ in DBMS_METADATA coverage.
                    // Oracle-compatible dictionary views keep schema compare and source editing usable.
                    source = queryDictionarySource(owner, name, normalizedType);
                } catch (SQLException fallbackError) {
                    if (metadataError != null) {
                        metadataError.addSuppressed(fallbackError);
                        throw metadataError;
                    }
                    throw fallbackError;
                }
            }
            if (metadataError != null && (source == null || source.trim().isEmpty())) {
                throw metadataError;
            }
            return new ObjectSource(name, normalizedType, owner, source == null ? "" : source);
        });
    }

    private String queryDbmsMetadataSource(String owner, String name, String objectType) throws SQLException {
        String sql = "SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL";
        try (var stmt = requireConnection().prepareStatement(sql)) {
            stmt.setString(1, objectType);
            stmt.setString(2, name);
            stmt.setString(3, owner);
            try (ResultSet rs = stmt.executeQuery()) {
                return rs.next() ? rs.getString(1) : null;
            }
        }
    }

    private String queryDictionarySource(String owner, String name, String objectType) throws SQLException {
        if ("VIEW".equals(objectType)) {
            String sql = "SELECT TEXT FROM ALL_VIEWS WHERE OWNER = ? AND VIEW_NAME = ?";
            try (var stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, owner);
                stmt.setString(2, name);
                try (ResultSet rs = stmt.executeQuery()) {
                    return rs.next() ? rs.getString(1) : null;
                }
            }
        }

        String sourceType = switch (objectType) {
            case "PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE" -> objectType;
            case "PACKAGE_BODY" -> "PACKAGE BODY";
            case "TYPE_BODY" -> "TYPE BODY";
            default -> throw new IllegalArgumentException("Unsupported object type: " + objectType);
        };
        String sql = "SELECT TEXT FROM ALL_SOURCE WHERE OWNER = ? AND NAME = ? AND TYPE = ? ORDER BY LINE";
        StringBuilder source = new StringBuilder();
        try (var stmt = requireConnection().prepareStatement(sql)) {
            stmt.setString(1, owner);
            stmt.setString(2, name);
            stmt.setString(3, sourceType);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    String line = rs.getString(1);
                    if (line != null) {
                        source.append(line);
                    }
                }
            }
        }
        return editableOracleSource(source.toString());
    }

    private static String normalizeObjectSourceType(String objectType) {
        String normalized = objectType == null
            ? ""
            : objectType.trim().toUpperCase(Locale.ROOT).replace(' ', '_');
        return switch (normalized) {
            case "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE",
                "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY" -> normalized;
            default -> throw new IllegalArgumentException("Unsupported object type: " + objectType);
        };
    }

    private static boolean supportsDictionarySource(String objectType) {
        return switch (objectType) {
            case "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY" -> true;
            default -> false;
        };
    }

    private static String editableOracleSource(String source) {
        String trimmed = source.trim();
        if (trimmed.isEmpty() || trimmed.regionMatches(true, 0, "CREATE ", 0, "CREATE ".length())) {
            return trimmed;
        }
        return "CREATE OR REPLACE " + trimmed;
    }

    private static String placeholders(int count) {
        return String.join(", ", java.util.Collections.nCopies(count, "?"));
    }

    private static void bind(java.sql.PreparedStatement stmt, List<Object> args) throws SQLException {
        for (int index = 0; index < args.size(); index += 1) {
            Object arg = args.get(index);
            if (arg instanceof Integer) {
                stmt.setInt(index + 1, (Integer) arg);
            } else {
                stmt.setString(index + 1, String.valueOf(arg));
            }
        }
    }

    private static final class MetadataSql {
        private final String sql;
        private final List<Object> args;

        private MetadataSql(String sql, List<Object> args) {
            this.sql = sql;
            this.args = args;
        }
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            String owner = normalizeSchema(schema);
            String sql = """
                SELECT c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, c.DATA_PRECISION, c.DATA_SCALE,
                    c.DATA_LENGTH, c.CHAR_LENGTH, c.DATA_DEFAULT, cc.COMMENTS,
                    CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS IS_PK
                FROM ALL_TAB_COLUMNS c
                LEFT JOIN ALL_COL_COMMENTS cc
                    ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME
                LEFT JOIN (
                    SELECT cols.COLUMN_NAME
                    FROM ALL_CONS_COLUMNS cols
                    JOIN ALL_CONSTRAINTS cons
                        ON cols.CONSTRAINT_NAME = cons.CONSTRAINT_NAME AND cols.OWNER = cons.OWNER
                    WHERE cons.CONSTRAINT_TYPE = 'P' AND cons.OWNER = ? AND cons.TABLE_NAME = ?
                ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
                WHERE c.OWNER = ? AND c.TABLE_NAME = ?
                ORDER BY c.COLUMN_ID
                """.stripIndent().trim();

            List<ColumnInfo> result = new ArrayList<>();
            try (var stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, owner);
                stmt.setString(2, table);
                stmt.setString(3, owner);
                stmt.setString(4, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        // Oracle-compatible DATA_DEFAULT is LONG-like; read it before other metadata fields.
                        String defaultValue = rs.getString("DATA_DEFAULT");
                        String name = rs.getString("COLUMN_NAME");
                        String baseType = rs.getString("DATA_TYPE");
                        Integer numPrec = intOrNull(rs, "DATA_PRECISION");
                        Integer numScale = intOrNull(rs, "DATA_SCALE");
                        Integer dataLen = intOrNull(rs, "DATA_LENGTH");
                        Integer charLen = intOrNull(rs, "CHAR_LENGTH");
                        result.add(new ColumnInfo(
                            name,
                            formatDataType(baseType, numPrec, numScale, dataLen, charLen),
                            "Y".equalsIgnoreCase(rs.getString("NULLABLE")),
                            defaultValue,
                            rs.getInt("IS_PK") == 1,
                            null,
                            rs.getString("COMMENTS"),
                            numPrec,
                            numScale,
                            charLen
                        ));
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

        String tableComment = null;
        try {
            tableComment = getTableComment(schema, table);
        } catch (RuntimeException e) {
            // Table comment is optional; DDL generation should still succeed without it.
        }

        return DdlBuilder.buildTableDdl(schema, table, getColumns(schema, table), indexes, foreignKeys, java.util.Collections.emptyList(), false, true, tableComment);
    }

    @Override
    public String getTableComment(String schema, String table) {
        return unchecked(() -> {
            String owner = normalizeSchema(schema);
            String sql = "SELECT COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'TABLE'";
            try (var stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, owner);
                stmt.setString(2, table);
                try (var rs = stmt.executeQuery()) {
                    if (rs.next()) {
                        String comment = rs.getString("COMMENTS");
                        return (comment != null && !comment.trim().isEmpty()) ? comment : null;
                    }
                }
            }
            return null;
        });
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return unchecked(() -> {
            String owner = normalizeSchema(schema);
            String sql = """
                SELECT i.INDEX_NAME, ic.COLUMN_NAME, ic.COLUMN_POSITION, i.UNIQUENESS,
                    c.CONSTRAINT_TYPE, i.INDEX_TYPE
                FROM ALL_INDEXES i
                JOIN ALL_IND_COLUMNS ic
                    ON i.INDEX_NAME = ic.INDEX_NAME
                    AND i.OWNER = ic.INDEX_OWNER
                    AND i.TABLE_OWNER = ic.TABLE_OWNER
                    AND i.TABLE_NAME = ic.TABLE_NAME
                LEFT JOIN ALL_CONSTRAINTS c
                    ON i.INDEX_NAME = c.INDEX_NAME
                    AND i.TABLE_OWNER = c.OWNER
                    AND i.TABLE_NAME = c.TABLE_NAME
                    AND c.CONSTRAINT_TYPE = 'P'
                WHERE i.TABLE_OWNER = ? AND i.TABLE_NAME = ?
                ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION
                """.stripIndent().trim();

            Map<String, List<String>> columnsByIndex = new LinkedHashMap<>();
            Map<String, Boolean> uniqueByIndex = new LinkedHashMap<>();
            Map<String, Boolean> primaryByIndex = new LinkedHashMap<>();
            Map<String, String> typeByIndex = new LinkedHashMap<>();
            try (var stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, owner);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String indexName = rs.getString("INDEX_NAME");
                        columnsByIndex.computeIfAbsent(indexName, ignored -> new ArrayList<>()).add(rs.getString("COLUMN_NAME"));
                        uniqueByIndex.put(indexName, "UNIQUE".equalsIgnoreCase(rs.getString("UNIQUENESS")));
                        primaryByIndex.put(indexName, "P".equalsIgnoreCase(rs.getString("CONSTRAINT_TYPE")));
                        typeByIndex.put(indexName, rs.getString("INDEX_TYPE"));
                    }
                }
            }

            List<IndexInfo> result = new ArrayList<>();
            for (Map.Entry<String, List<String>> entry : columnsByIndex.entrySet()) {
                String name = entry.getKey();
                result.add(new IndexInfo(
                    name,
                    entry.getValue(),
                    Boolean.TRUE.equals(uniqueByIndex.get(name)),
                    Boolean.TRUE.equals(primaryByIndex.get(name)),
                    null,
                    typeByIndex.get(name),
                    null,
                    null
                ));
            }
            return result;
        });
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return unchecked(() -> {
            String owner = normalizeSchema(schema);
            String sql = """
                SELECT c.CONSTRAINT_NAME, cc.COLUMN_NAME, rc.TABLE_NAME, rcc.COLUMN_NAME
                FROM ALL_CONSTRAINTS c
                JOIN ALL_CONS_COLUMNS cc ON c.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND c.OWNER = cc.OWNER
                JOIN ALL_CONSTRAINTS rc ON c.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND c.R_OWNER = rc.OWNER
                JOIN ALL_CONS_COLUMNS rcc
                    ON rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME
                    AND rc.OWNER = rcc.OWNER
                    AND cc.POSITION = rcc.POSITION
                WHERE c.CONSTRAINT_TYPE = 'R' AND c.OWNER = ? AND c.TABLE_NAME = ?
                ORDER BY c.CONSTRAINT_NAME, cc.POSITION
                """.stripIndent().trim();

            List<ForeignKeyInfo> result = new ArrayList<>();
            try (var stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, owner);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ForeignKeyInfo(
                            rs.getString(1),
                            rs.getString(2),
                            rs.getString(3),
                            rs.getString(4)
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
            String owner = normalizeSchema(schema);
            String sql = """
                SELECT TRIGGER_NAME, TRIGGERING_EVENT, TRIGGER_TYPE
                FROM ALL_TRIGGERS
                WHERE OWNER = ? AND TABLE_NAME = ?
                ORDER BY TRIGGER_NAME
                """.stripIndent().trim();

            List<TriggerInfo> result = new ArrayList<>();
            try (var stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, owner);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TriggerInfo(rs.getString(1), rs.getString(2), rs.getString(3)));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "ALTER SESSION SET CURRENT_SCHEMA = " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    private List<String> querySchemas() throws SQLException {
        try {
            return querySchemaNames();
        } catch (SQLException primaryError) {
            String current;
            try {
                current = currentSchema();
            } catch (SQLException ignored) {
                throw primaryError;
            }
            if (current == null || current.isBlank()) {
                throw primaryError;
            }
            return List.of(current);
        }
    }

    private List<String> querySchemaNames() throws SQLException {
        String placeholders = SYSTEM_SCHEMAS.stream()
            .map(schema -> "'" + schema + "'")
            .collect(Collectors.joining(","));
        String sql = """
            SELECT username
            FROM ALL_USERS
            WHERE username IS NOT NULL
              AND username NOT IN (%s)
              AND username NOT LIKE 'APEX_%%'
              AND username NOT LIKE 'FLOWS_%%'
              AND username NOT LIKE '%%$%%'
            ORDER BY CASE
                WHEN username = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') THEN 0
                WHEN username = SYS_CONTEXT('USERENV', 'SESSION_USER') THEN 1
                ELSE 2
            END, username
            """.formatted(placeholders).stripIndent().trim();

        List<String> result = new ArrayList<>();
        try (var stmt = requireConnection().createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            while (rs.next()) {
                String schema = rs.getString(1);
                if (schema != null && !schema.isBlank()) {
                    result.add(schema);
                }
            }
        }
        return result;
    }

    private String normalizeSchema(String schema) throws SQLException {
        String value = schema == null ? "" : schema.trim();
        return value.isEmpty() ? currentSchema() : value;
    }

    private String currentSchema() throws SQLException {
        try (var stmt = requireConnection().createStatement();
             ResultSet rs = stmt.executeQuery("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL")) {
            if (rs.next()) {
                String schema = rs.getString(1);
                if (schema != null && !schema.isBlank()) {
                    return schema;
                }
            }
        }
        return "";
    }

    private static String appendDefaultCompatibilityOption(String url) {
        if (hasQueryKey(url, COMPATIBLE_OJDBC_VERSION)) {
            return url;
        }
        return url + (url.contains("?") ? "&" : "?") + DEFAULT_COMPATIBLE_OJDBC_VERSION;
    }

    private static boolean hasQueryKey(String url, String key) {
        int queryStart = url.indexOf('?');
        if (queryStart < 0) {
            return false;
        }
        String query = url.substring(queryStart + 1);
        int fragmentStart = query.indexOf('#');
        if (fragmentStart >= 0) {
            query = query.substring(0, fragmentStart);
        }
        for (String part : query.split("[&;]")) {
            String normalized = part.trim();
            if (normalized.isEmpty()) {
                continue;
            }
            int equals = normalized.indexOf('=');
            String paramKey = equals >= 0 ? normalized.substring(0, equals) : normalized;
            if (paramKey.trim().equalsIgnoreCase(key)) {
                return true;
            }
        }
        return false;
    }

    private static String formatDataType(String base, Integer numPrec, Integer numScale, Integer dataLen, Integer charLen) {
        if (base == null || base.isBlank()) {
            return "";
        }
        return switch (base.toUpperCase(Locale.ROOT)) {
            case "VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR" -> {
                Integer len = charLen == null ? dataLen : charLen;
                yield len == null ? base : base + "(" + len + ")";
            }
            case "NUMBER" -> {
                if (numPrec != null && numScale != null && numScale > 0) {
                    yield base + "(" + numPrec + "," + numScale + ")";
                }
                if (numPrec != null && numPrec > 0) {
                    yield base + "(" + numPrec + ")";
                }
                yield base;
            }
            case "RAW" -> dataLen == null ? "RAW" : "RAW(" + dataLen + ")";
            default -> base;
        };
    }

    private static Integer intOrNull(ResultSet rs, String column) throws SQLException {
        Object value = rs.getObject(column);
        return value instanceof Number ? ((Number) value).intValue() : null;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(OceanBaseOracleAgent::new).run();
    }
}
