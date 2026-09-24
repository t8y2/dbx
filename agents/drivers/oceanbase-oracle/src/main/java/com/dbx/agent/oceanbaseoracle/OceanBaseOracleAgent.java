package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.AgentProtocol;
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
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.OracleObjectPrivilege;
import com.dbx.agent.PartitionInfo;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import com.dbx.agent.QueryTiming;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.Matcher;

public final class OceanBaseOracleAgent extends ConfiguredJdbcAgent {
    private static final long MICROS_PER_SECOND = 1_000_000L;
    private static final long UNLIMITED_QUERY_TIMEOUT_MICROS = 3_216_672_000_000_000L;
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
    private boolean queryTimeoutChanged;

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
    public boolean supportsQueryTiming() { return true; }

    @Override
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        try (QueryTiming timing = QueryTiming.begin()) {
            QueryResult result = super.executeQuery(sql, schema, options);
            result.setQuery_timings_ms(timing.finish());
            return result;
        }
    }

    @Override
    public QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        try (QueryTiming timing = QueryTiming.begin()) {
            QueryPageResult result = super.executeQueryPage(sql, schema, options);
            result.setQuery_timings_ms(timing.finish());
            return result;
        }
    }

    @Override
    public QueryPageResult fetchQueryPage(String sessionId, int pageSize) {
        try (QueryTiming timing = QueryTiming.begin()) {
            QueryPageResult result = super.fetchQueryPage(sessionId, pageSize);
            result.setQuery_timings_ms(timing.finish());
            return result;
        }
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
            try {
                stmt.execute(queryTimeoutSql(timeoutSecs));
            } catch (SQLException error) {
                if (isReadOnlyTransactionError(error)) {
                    return;
                }
                throw error;
            }
            queryTimeoutChanged = true;
        }
    }

    @Override
    protected void beforePooledConnectionReturn(Connection connection) throws SQLException {
        if (!queryTimeoutChanged) {
            return;
        }
        try (var stmt = connection.createStatement()) {
            stmt.execute(queryTimeoutSql(0));
            queryTimeoutChanged = false;
        }
    }

    @Override
    protected Object resultValue(ResultSet rs, int index, int sqlType) {
        switch (sqlType) {
            case Types.BINARY:
            case Types.VARBINARY:
            case Types.LONGVARBINARY:
            case Types.BLOB:
                return unchecked(() -> JdbcExecutor.stringResultValue(rs, index, sqlType));
            default:
                return super.resultValue(rs, index, sqlType);
        }
    }

    static String queryTimeoutSql(int timeoutSecs) {
        if (timeoutSecs < 0) {
            throw new IllegalArgumentException("Query timeout cannot be negative: " + timeoutSecs);
        }
        long timeoutMicros = timeoutSecs == 0
            ? UNLIMITED_QUERY_TIMEOUT_MICROS
            : timeoutSecs * MICROS_PER_SECOND;
        return "ALTER SESSION SET ob_query_timeout = " + timeoutMicros;
    }

    private static boolean isReadOnlyTransactionError(SQLException error) {
        Deque<Throwable> pending = new ArrayDeque<>();
        Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        pending.add(error);
        while (!pending.isEmpty()) {
            Throwable current = pending.removeFirst();
            if (!seen.add(current)) {
                continue;
            }
            if (current instanceof SQLException) {
                SQLException sqlError = (SQLException) current;
                String message = sqlError.getMessage();
                if ("25006".equals(sqlError.getSQLState())
                    || sqlError.getErrorCode() == 1456
                    || message != null && containsReadOnlyTransactionCode(message)) {
                    return true;
                }
                SQLException next = sqlError.getNextException();
                if (next != null) {
                    pending.addLast(next);
                }
            }
            Throwable cause = current.getCause();
            if (cause != null) {
                pending.addLast(cause);
            }
        }
        return false;
    }

    private static boolean containsReadOnlyTransactionCode(String message) {
        String normalized = message.toUpperCase(Locale.ROOT);
        return normalized.contains("OBE-01456") || normalized.contains("ORA-01456");
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

    @Override
    public CompletionAssistantResponse completionAssistantSearch(CompletionAssistantRequest request) {
        if (hasTableLikeCompletionKind(request.getObject_kinds())) {
            return unchecked(() -> completionAssistantTables(request));
        }
        return super.completionAssistantSearch(request);
    }

    private CompletionAssistantResponse completionAssistantTables(CompletionAssistantRequest request) throws SQLException {
        int limit = boundedCompletionLimit(request.getMax_results());
        int scanLimit = Math.min(1000, Math.max(limit * 3, limit + 1));
        String preferredSchema = preferredCompletionSchema(request);
        CompletionTablesQuery query = buildCompletionTablesQuery(request, preferredSchema, scanLimit + 1);
        List<CompletionTableRow> rows = new ArrayList<>();
        try (PreparedStatement stmt = requireConnection().prepareStatement(query.sql)) {
            bindCompletionArgs(stmt, query.args);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    rows.add(new CompletionTableRow(
                        rs.getString(1),
                        rs.getString(2),
                        rs.getString(3),
                        rs.getString(4),
                        rs.getString(5)
                    ));
                }
            }
        }
        Set<CompletionSynonymTarget> validTargets = validCompletionSynonymTargets(
            rows,
            completionTableObjectTypes(request.getObject_kinds())
        );
        List<CompletionAssistantCandidate> candidates = new ArrayList<>();
        for (CompletionTableRow row : rows) {
            if (row.name == null || row.name.isBlank()) {
                continue;
            }
            if ("SYNONYM".equalsIgnoreCase(row.objectType)
                && (row.targetOwner == null || row.targetName == null
                    || !validTargets.contains(new CompletionSynonymTarget(row.targetOwner, row.targetName)))) {
                continue;
            }
            CompletionAssistantCandidateKind kind = "VIEW".equalsIgnoreCase(row.objectType)
                ? CompletionAssistantCandidateKind.VIEW
                : CompletionAssistantCandidateKind.TABLE;
            candidates.add(new CompletionAssistantCandidate(
                row.name,
                kind,
                blankToNull(request.getDatabase()),
                row.owner,
                null,
                null,
                null,
                row.objectType
            ));
        }
        boolean incomplete = candidates.size() > limit;
        if (incomplete) {
            candidates = new ArrayList<>(candidates.subList(0, limit));
        }
        return new CompletionAssistantResponse(candidates, incomplete, false);
    }

    static CompletionTablesQuery buildCompletionTablesQuery(
        CompletionAssistantRequest request,
        String preferredSchema,
        int limit
    ) {
        List<String> objectTypes = completionTableObjectTypes(request.getObject_kinds());
        boolean caseSensitive = request.getCase_sensitive();
        String pattern = completionLikePattern(request.getMask(), request.getMatch_mode());
        // OceanBase Oracle matches metadata the same way as listTables: fold the
        // bind value in Java and compare UPPER(column) LIKE ?. UPPER(?) on binds
        // is unreliable for fuzzy/lowercase masks in this driver.
        if (!caseSensitive) {
            pattern = pattern.toUpperCase(Locale.ROOT);
        }
        List<Object> args = new ArrayList<>();
        String namePredicate = completionNamePredicate("o.OBJECT_NAME", caseSensitive);
        String synonymNamePredicate = completionNamePredicate("s.SYNONYM_NAME", caseSensitive);
        args.add(pattern);

        String ownerPredicate = "";
        String synonymOwnerPredicate = "";
        String owner = "";
        if (!request.getGlobal_search()) {
            owner = firstNonBlank(request.getParent_schema(), request.getSchema(), preferredSchema);
            if (owner == null) {
                owner = "";
            }
            owner = owner.toUpperCase(Locale.ROOT);
            args.add(owner);
            ownerPredicate = " AND UPPER(o.OWNER) = ?";
        }

        args.add(pattern);
        if (!owner.isEmpty()) {
            args.add(owner);
            synonymOwnerPredicate = " AND UPPER(s.OWNER) = ?";
        }

        String preferred = preferredSchema == null ? "" : preferredSchema.trim();
        String preferredFolded = caseSensitive ? preferred : preferred.toUpperCase(Locale.ROOT);
        String exactMask = request.getMask() == null ? "" : request.getMask().trim();
        String exactFolded = caseSensitive ? exactMask : exactMask.toUpperCase(Locale.ROOT);
        args.add(preferredFolded);
        args.add(exactFolded);
        args.add(limit);

        String typeList = String.join(", ", objectTypes);
        String baseSql = """
            SELECT o.OWNER,
                   o.OBJECT_NAME,
                   o.OBJECT_TYPE,
                   CAST(NULL AS VARCHAR2(128)) AS TARGET_OWNER,
                   CAST(NULL AS VARCHAR2(128)) AS TARGET_NAME
              FROM ALL_OBJECTS o
             WHERE o.OBJECT_TYPE IN (%s)
               AND %s%s
            UNION ALL
            SELECT s.OWNER,
                   s.SYNONYM_NAME AS OBJECT_NAME,
                   'SYNONYM' AS OBJECT_TYPE,
                   s.TABLE_OWNER AS TARGET_OWNER,
                   s.TABLE_NAME AS TARGET_NAME
              FROM ALL_SYNONYMS s
             WHERE s.DB_LINK IS NULL
               AND %s%s
            """.formatted(typeList, namePredicate, ownerPredicate, synonymNamePredicate, synonymOwnerPredicate)
            .stripIndent()
            .trim();

        String preferredOwnerPredicate = caseSensitive ? "OWNER = ?" : "UPPER(OWNER) = ?";
        String exactNamePredicate = caseSensitive
            ? "OBJECT_NAME = ?"
            : "UPPER(OBJECT_NAME) = ?";
        String orderedSql = """
            SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, TARGET_OWNER, TARGET_NAME
              FROM (
            %s
              )
            ORDER BY CASE
                       WHEN %s THEN 0
                       WHEN OWNER = 'PUBLIC' THEN 1
                       WHEN OWNER IN ('SYS','SYSTEM','SYSMAN','DBSNMP','OUTLN','XDB','MDSYS','CTXSYS','WMSYS') THEN 3
                       ELSE 2
                     END,
                     CASE WHEN %s THEN 0 ELSE 1 END,
                     CASE OBJECT_TYPE WHEN 'TABLE' THEN 0 WHEN 'VIEW' THEN 1 WHEN 'SYNONYM' THEN 3 ELSE 4 END,
                     OBJECT_NAME,
                     OWNER
            """.formatted(baseSql, preferredOwnerPredicate, exactNamePredicate).stripIndent().trim();

        String sql = """
            SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, TARGET_OWNER, TARGET_NAME
              FROM (
            %s
              )
             WHERE ROWNUM <= ?
            """.formatted(orderedSql).stripIndent().trim();

        return new CompletionTablesQuery(sql, args);
    }

    private static List<String> completionTableObjectTypes(List<CompletionAssistantObjectKind> kinds) {
        List<String> objectTypes = new ArrayList<>();
        boolean any = kinds == null || kinds.isEmpty();
        if (any || kinds.contains(CompletionAssistantObjectKind.TABLE)) {
            objectTypes.add("'TABLE'");
        }
        if (any || kinds.contains(CompletionAssistantObjectKind.VIEW)) {
            objectTypes.add("'VIEW'");
        }
        if (objectTypes.isEmpty()) {
            objectTypes.add("'TABLE'");
            objectTypes.add("'VIEW'");
        }
        return objectTypes;
    }

    private static boolean hasTableLikeCompletionKind(List<CompletionAssistantObjectKind> kinds) {
        if (kinds == null || kinds.isEmpty()) {
            return true;
        }
        for (CompletionAssistantObjectKind kind : kinds) {
            if (kind == CompletionAssistantObjectKind.TABLE || kind == CompletionAssistantObjectKind.VIEW) {
                return true;
            }
        }
        return false;
    }

    private String preferredCompletionSchema(CompletionAssistantRequest request) throws SQLException {
        String preferred = firstNonBlank(request.getSchema());
        if (preferred != null && !preferred.isBlank()) {
            return preferred;
        }
        String current = currentSchema();
        return current == null ? "" : current;
    }

    private static String completionLikePattern(String mask, CompletionAssistantMatchMode matchMode) {
        String escaped = escapeLikePattern(mask == null ? "" : mask.trim());
        if (matchMode == CompletionAssistantMatchMode.CONTAINS) {
            return "%" + escaped + "%";
        }
        return escaped + "%";
    }

    private static String escapeLikePattern(String mask) {
        return mask.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    private static String completionNamePredicate(String column, boolean caseSensitive) {
        if (caseSensitive) {
            return column + " LIKE ? ESCAPE '\\'";
        }
        return "UPPER(" + column + ") LIKE ? ESCAPE '\\'";
    }

    private static int boundedCompletionLimit(Integer requested) {
        if (requested == null || requested <= 0) {
            return 100;
        }
        return Math.min(requested, 1000);
    }

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return null;
        }
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        return null;
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static void bindCompletionArgs(PreparedStatement stmt, List<Object> args) throws SQLException {
        for (int i = 0; i < args.size(); i++) {
            Object arg = args.get(i);
            if (arg instanceof Integer integer) {
                stmt.setInt(i + 1, integer);
            } else {
                stmt.setString(i + 1, arg == null ? null : String.valueOf(arg));
            }
        }
    }

    private Set<CompletionSynonymTarget> validCompletionSynonymTargets(
        List<CompletionTableRow> rows,
        List<String> objectTypes
    ) throws SQLException {
        Set<CompletionSynonymTarget> targets = new LinkedHashSet<>();
        for (CompletionTableRow row : rows) {
            if ("SYNONYM".equalsIgnoreCase(row.objectType) && row.targetOwner != null && row.targetName != null) {
                targets.add(new CompletionSynonymTarget(row.targetOwner, row.targetName));
            }
        }
        Set<CompletionSynonymTarget> valid = new HashSet<>();
        if (targets.isEmpty()) {
            return valid;
        }
        String typeList = String.join(", ", objectTypes);
        List<CompletionSynonymTarget> ordered = new ArrayList<>(targets);
        for (int start = 0; start < ordered.size(); start += 100) {
            List<CompletionSynonymTarget> batch = ordered.subList(start, Math.min(start + 100, ordered.size()));
            List<Object> args = new ArrayList<>();
            List<String> predicates = new ArrayList<>();
            for (CompletionSynonymTarget target : batch) {
                args.add(target.owner());
                args.add(target.name());
                predicates.add("(o.OWNER = ? AND o.OBJECT_NAME = ?)");
            }
            String sql = "SELECT DISTINCT o.OWNER, o.OBJECT_NAME"
                + " FROM ALL_OBJECTS o"
                + " WHERE o.OBJECT_TYPE IN (" + typeList + ")"
                + " AND (" + String.join(" OR ", predicates) + ")";
            try (PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                bindCompletionArgs(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        valid.add(new CompletionSynonymTarget(rs.getString(1), rs.getString(2)));
                    }
                }
            }
        }
        return valid;
    }

    record CompletionSynonymTarget(String owner, String name) {
    }

    static final class CompletionTableRow {
        final String owner;
        final String name;
        final String objectType;
        final String targetOwner;
        final String targetName;

        CompletionTableRow(String owner, String name, String objectType, String targetOwner, String targetName) {
            this.owner = owner;
            this.name = name;
            this.objectType = objectType;
            this.targetOwner = targetOwner;
            this.targetName = targetName;
        }
    }

    static final class CompletionTablesQuery {
        final String sql;
        final List<Object> args;

        CompletionTablesQuery(String sql, List<Object> args) {
            this.sql = sql;
            this.args = List.copyOf(args);
        }
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
            String objectName = normalizeObjectName(name);
            String normalizedType = normalizeObjectSourceType(objectType);
            String source;
            SQLException metadataError = null;
            try {
                source = queryDbmsMetadataSource(owner, objectName, normalizedType);
            } catch (SQLException e) {
                metadataError = e;
                source = null;
            }

            if ((source == null || source.trim().isEmpty()) && supportsDictionarySource(normalizedType)) {
                try {
                    // OceanBase versions and tenant privileges differ in DBMS_METADATA coverage.
                    // Oracle-compatible dictionary views keep schema compare and source editing usable.
                    source = queryDictionarySource(owner, objectName, normalizedType);
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
            return new ObjectSource(objectName, normalizedType, owner, source == null ? "" : source);
        });
    }

    private String queryDbmsMetadataSource(String owner, String name, String objectType) throws SQLException {
        if ("SYNONYM".equals(objectType)) {
            // GET_DDL does not cover synonyms on every supported OB version.
            return OceanBaseSchemaObjects.synonymSource(requireConnection(), owner, name);
        }
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
        if ("SEQUENCE".equals(objectType)) {
            return OceanBaseSchemaObjects.sequenceSource(requireConnection(), owner, name);
        }
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
            case "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "SYNONYM",
                "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY" -> normalized;
            default -> throw new IllegalArgumentException("Unsupported object type: " + objectType);
        };
    }

    private static boolean supportsDictionarySource(String objectType) {
        return switch (objectType) {
            case "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY", "SEQUENCE" -> true;
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
            String tableName = normalizeObjectName(table);
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
                stmt.setString(2, tableName);
                stmt.setString(3, owner);
                stmt.setString(4, tableName);
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
        return unchecked(() -> {
            String owner = normalizeSchema(schema);
            String tableName = normalizeObjectName(table);
            String ddl = queryDbmsMetadataSource(owner, tableName, "TABLE");
            if (ddl == null || ddl.isBlank()) {
                throw new SQLException("DBMS_METADATA.GET_DDL returned empty DDL for " + owner + "." + tableName);
            }
            // OceanBase 4.2.5 omits the owner from CREATE TABLE, even for another schema.
            var header = Pattern.compile("(?i)^(\\s*CREATE\\s+(?:GLOBAL\\s+TEMPORARY\\s+)?TABLE\\s+)"
                + Pattern.quote(quoteIdentifier(tableName)) + "(?=\\s*\\()").matcher(ddl);
            if (header.find()) {
                ddl = header.replaceFirst(Matcher.quoteReplacement(header.group(1) + quoteIdentifier(owner) + "." + quoteIdentifier(tableName)));
            }
            ddl = ddl.strip();
            if (!ddl.endsWith(";")) ddl += ";";

            // GET_DDL(TABLE) includes constraints/partitioning, but not secondary indexes or comments.
            String indexSql = """
                SELECT i.INDEX_NAME FROM ALL_INDEXES i
                WHERE i.TABLE_OWNER = ? AND i.TABLE_NAME = ?
                  AND NOT EXISTS (SELECT 1 FROM ALL_CONSTRAINTS c
                    WHERE c.OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME
                      AND c.CONSTRAINT_TYPE IN ('P', 'U'))
                  AND NOT (i.INDEX_NAME = 'IDX_FOR_HEAP_GTT_' || i.TABLE_NAME
                    AND EXISTS (SELECT 1 FROM ALL_TABLES t WHERE t.OWNER = i.TABLE_OWNER
                      AND t.TABLE_NAME = i.TABLE_NAME AND t.TEMPORARY = 'Y')
                    AND EXISTS (SELECT 1 FROM ALL_IND_COLUMNS c WHERE c.INDEX_OWNER = i.OWNER
                      AND c.INDEX_NAME = i.INDEX_NAME AND c.COLUMN_NAME = 'SYS_SESSION_ID'))
                ORDER BY i.INDEX_NAME
                """;
            List<String> indexNames = new ArrayList<>();
            try (var stmt = requireConnection().prepareStatement(indexSql)) {
                stmt.setString(1, owner);
                stmt.setString(2, tableName);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) indexNames.add(rs.getString(1));
                }
            }
            for (String index : indexNames) {
                String indexDdl = queryDbmsMetadataSource(owner, index, "INDEX");
                if (indexDdl == null || indexDdl.isBlank()) throw new SQLException("Empty index DDL: " + index);
                ddl = DdlBuilder.appendTrailingSql(ddl, indexDdl);
            }
            String tableRef = quoteIdentifier(owner) + "." + quoteIdentifier(tableName);
            String comment = getTableComment(owner, tableName);
            if (comment != null && !comment.isBlank()) {
                ddl = DdlBuilder.appendTrailingSql(ddl, "COMMENT ON TABLE " + tableRef + " IS '" + comment.replace("'", "''") + "';");
            }
            String commentSql = "SELECT COLUMN_NAME, COMMENTS FROM ALL_COL_COMMENTS WHERE OWNER = ? AND TABLE_NAME = ? AND COMMENTS IS NOT NULL ORDER BY COLUMN_NAME";
            try (var stmt = requireConnection().prepareStatement(commentSql)) {
                stmt.setString(1, owner);
                stmt.setString(2, tableName);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String text = rs.getString("COMMENTS");
                        if (text == null || text.isBlank()) continue;
                        ddl = DdlBuilder.appendTrailingSql(ddl, "COMMENT ON COLUMN " + tableRef + "." + quoteIdentifier(rs.getString("COLUMN_NAME")) + " IS '" + text.replace("'", "''") + "';");
                    }
                }
            }
            try {
                ddl = DdlBuilder.appendTrailingSql(ddl, queryObjectGrantSql(owner, tableName));
            } catch (RuntimeException | SQLException ignored) {
                // Privilege metadata remains optional for users without access to grant views.
            }
            return ddl;
        });
    }

    private static String quoteIdentifier(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }

    @Override
    public List<PartitionInfo> listPartitions(String schema, String table) {
        return queryPartitions(schema, table, false);
    }

    @Override
    public List<PartitionInfo> listSubpartitions(String schema, String table) {
        return queryPartitions(schema, table, true);
    }

    private List<PartitionInfo> queryPartitions(String schema, String table, boolean subpartition) {
        return unchecked(() -> {
            String owner = normalizeSchema(schema);
            String tableName = normalizeObjectName(table);
            String prefix = subpartition ? "SUBPARTITION" : "PARTITION";
            String keysView = subpartition ? "ALL_SUBPART_KEY_COLUMNS" : "ALL_PART_KEY_COLUMNS";
            List<String> keys = new ArrayList<>();
            try (var stmt = requireConnection().prepareStatement("SELECT COLUMN_NAME FROM " + keysView
                + " WHERE OWNER = ? AND NAME = ? AND OBJECT_TYPE = 'TABLE' ORDER BY COLUMN_POSITION")) {
                stmt.setString(1, owner);
                stmt.setString(2, tableName);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) keys.add(quoteIdentifier(rs.getString(1)));
                }
            }
            String sql = "SELECT p." + prefix + "_NAME AS NAME, p." + prefix + "_POSITION AS POSITION, p.HIGH_VALUE, t."
                + prefix + "ING_TYPE AS PARTITION_TYPE FROM " + (subpartition ? "ALL_TAB_SUBPARTITIONS" : "ALL_TAB_PARTITIONS")
                + " p JOIN ALL_PART_TABLES t ON t.OWNER = p.TABLE_OWNER AND t.TABLE_NAME = p.TABLE_NAME"
                + " WHERE p.TABLE_OWNER = ? AND p.TABLE_NAME = ? ORDER BY "
                + (subpartition ? "p.PARTITION_NAME, " : "") + "p." + prefix + "_POSITION";
            List<PartitionInfo> result = new ArrayList<>();
            try (var stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, owner);
                stmt.setString(2, tableName);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String value = rs.getString("HIGH_VALUE");
                        result.add(new PartitionInfo(rs.getString("NAME"), rs.getInt("POSITION"), value == null ? "" : value,
                            rs.getString("PARTITION_TYPE"), String.join(", ", keys)));
                    }
                }
            }
            return result;
        });
    }

    private String queryObjectGrantSql(String owner, String table) throws SQLException {
        List<OracleObjectPrivilege> privileges = new ArrayList<>();
        privileges.addAll(queryTablePrivileges(owner, table));
        try {
            privileges.addAll(queryColumnPrivileges(owner, table));
        } catch (SQLException ignored) {
            // Column privileges are optional when table-level grants are available.
        }
        return DdlBuilder.buildOracleObjectGrantSql(owner, table, privileges);
    }

    private List<OracleObjectPrivilege> queryTablePrivileges(String owner, String table) throws SQLException {
        // DBA_TAB_PRIVS shows every object grant (OWNER column). ALL_TAB_PRIVS is limited to
        // grants where the session user is owner/grantor/grantee (or PUBLIC), so admins
        // browsing another schema often see nothing unless we prefer the DBA view.
        return queryFirstAvailablePrivileges(tablePrivilegeQueries(), owner, table, null);
    }

    private List<OracleObjectPrivilege> queryColumnPrivileges(String owner, String table) throws SQLException {
        return queryFirstAvailablePrivileges(columnPrivilegeQueries(), owner, table, "COLUMN_NAME");
    }

    private List<OracleObjectPrivilege> queryFirstAvailablePrivileges(
        List<String> queries,
        String owner,
        String table,
        String columnNameField
    ) throws SQLException {
        SQLException firstError = null;
        for (String sql : queries) {
            try {
                return queryPrivileges(sql, owner, table, columnNameField);
            } catch (SQLException error) {
                if (firstError == null) {
                    firstError = error;
                } else {
                    firstError.addSuppressed(error);
                }
            }
        }
        throw firstError == null ? new SQLException("No privilege views available") : firstError;
    }

    private static List<String> tablePrivilegeQueries() {
        return List.of(
            """
                SELECT GRANTEE, PRIVILEGE, GRANTABLE
                FROM DBA_TAB_PRIVS
                WHERE OWNER = ? AND TABLE_NAME = ?
                ORDER BY GRANTEE, PRIVILEGE
                """.stripIndent().trim(),
            """
                SELECT GRANTEE, PRIVILEGE, GRANTABLE
                FROM SYS.DBA_TAB_PRIVS
                WHERE OWNER = ? AND TABLE_NAME = ?
                ORDER BY GRANTEE, PRIVILEGE
                """.stripIndent().trim(),
            """
                SELECT GRANTEE, PRIVILEGE, GRANTABLE
                FROM ALL_TAB_PRIVS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                ORDER BY GRANTEE, PRIVILEGE
                """.stripIndent().trim()
        );
    }

    private static List<String> columnPrivilegeQueries() {
        return List.of(
            """
                SELECT GRANTEE, PRIVILEGE, GRANTABLE, COLUMN_NAME
                FROM DBA_COL_PRIVS
                WHERE OWNER = ? AND TABLE_NAME = ?
                ORDER BY GRANTEE, COLUMN_NAME, PRIVILEGE
                """.stripIndent().trim(),
            """
                SELECT GRANTEE, PRIVILEGE, GRANTABLE, COLUMN_NAME
                FROM SYS.DBA_COL_PRIVS
                WHERE OWNER = ? AND TABLE_NAME = ?
                ORDER BY GRANTEE, COLUMN_NAME, PRIVILEGE
                """.stripIndent().trim(),
            """
                SELECT GRANTEE, PRIVILEGE, GRANTABLE, COLUMN_NAME
                FROM ALL_COL_PRIVS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                ORDER BY GRANTEE, COLUMN_NAME, PRIVILEGE
                """.stripIndent().trim()
        );
    }

    private List<OracleObjectPrivilege> queryPrivileges(
        String sql,
        String owner,
        String table,
        String columnNameField
    ) throws SQLException {
        List<OracleObjectPrivilege> result = new ArrayList<>();
        try (var stmt = requireConnection().prepareStatement(sql)) {
            stmt.setString(1, owner);
            stmt.setString(2, table);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    result.add(new OracleObjectPrivilege(
                        rs.getString("GRANTEE"),
                        rs.getString("PRIVILEGE"),
                        isYes(rs.getString("GRANTABLE")),
                        columnNameField == null ? null : rs.getString(columnNameField)
                    ));
                }
            }
        }
        return result;
    }

    private static boolean isYes(String value) {
        return value != null && "YES".equalsIgnoreCase(value.trim());
    }

    @Override
    public String getTableComment(String schema, String table) {
        return unchecked(() -> {
            String owner = normalizeSchema(schema);
            String tableName = normalizeObjectName(table);
            String sql = "SELECT COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'TABLE'";
            try (var stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, owner);
                stmt.setString(2, tableName);
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
            String tableName = normalizeObjectName(table);
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
                stmt.setString(2, tableName);
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
            String tableName = normalizeObjectName(table);
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
                stmt.setString(2, tableName);
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
            String tableName = normalizeObjectName(table);
            String sql = """
                SELECT TRIGGER_NAME, TRIGGERING_EVENT, TRIGGER_TYPE
                FROM ALL_TRIGGERS
                WHERE OWNER = ? AND TABLE_NAME = ?
                ORDER BY TRIGGER_NAME
                """.stripIndent().trim();

            List<TriggerInfo> result = new ArrayList<>();
            try (var stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, owner);
                stmt.setString(2, tableName);
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
        if (schema == null || schema.isBlank()) {
            return "";
        }
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
        String sql = """
            SELECT username
            FROM ALL_USERS
            WHERE username IS NOT NULL
            ORDER BY CASE
                WHEN username = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') THEN 0
                WHEN username = SYS_CONTEXT('USERENV', 'SESSION_USER') THEN 1
                ELSE 2
            END, username
            """.stripIndent().trim();

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

    private static String normalizeObjectName(String name) {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("Object name must not be blank");
        }
        return name;
    }

    private String normalizeSchema(String schema) throws SQLException {
        return schema == null || schema.isBlank() ? currentSchema() : schema;
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
