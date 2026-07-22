package com.dbx.agent.dameng;

import com.dbx.agent.BaseDatabaseAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.io.PrintStream;
import java.io.Reader;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLXML;
import java.sql.Statement;
import java.sql.Types;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public final class DamengAgent extends BaseDatabaseAgent {
    private static final String AGENT_VERSION = "9999.06.04.1-fix-default";
    private static final String DAMENG_CLASSIFIED_OBJECT_TYPE_SQL =
        "CASE WHEN o.OBJECT_TYPE = 'MATERIALIZED VIEW' OR (o.OBJECT_TYPE = 'VIEW' AND mv.MVIEW_NAME IS NOT NULL) "
            + "THEN 'MATERIALIZED_VIEW' ELSE o.OBJECT_TYPE END";
    // DM8 does not expose ALL_MVIEWS; SYSOBJECTS provides the owning schema through SCHID.
    private static final String DAMENG_SYSTEM_MATERIALIZED_VIEW_JOIN_SQL = """
        LEFT JOIN (
            SELECT schema_object.NAME AS OWNER, materialized_view.NAME AS MVIEW_NAME
            FROM SYS.SYSOBJECTS materialized_view
            JOIN SYS.SYSOBJECTS schema_object
              ON schema_object.ID = materialized_view.SCHID AND schema_object.TYPE$ = 'SCH'
            WHERE materialized_view.TYPE$ = 'SCHOBJ'
              AND materialized_view.SUBTYPE$ = 'VIEW'
              AND (materialized_view.INFO1 & 0x200) > 0
        ) mv ON mv.OWNER = o.OWNER AND mv.MVIEW_NAME = o.OBJECT_NAME
        """.stripIndent().trim();
    private static final String DAMENG_ACCESSIBLE_MATERIALIZED_VIEW_JOIN_SQL = """
        LEFT JOIN (
            SELECT DISTINCT OWNER, NAME AS MVIEW_NAME
            FROM ALL_DEPENDENCIES
            WHERE TYPE IN ('MATERIALIZED VIEW', 'MATERIALIZED_VIEW')
        ) mv ON mv.OWNER = o.OWNER AND mv.MVIEW_NAME = o.OBJECT_NAME
        """.stripIndent().trim();
    private static final String DAMENG_USER_MATERIALIZED_VIEW_JOIN_SQL = """
        LEFT JOIN (
            SELECT DISTINCT schema_object.OWNER, m.MVIEW_NAME
            FROM USER_MVIEWS m
            JOIN ALL_OBJECTS schema_object
              ON schema_object.OBJECT_ID = m.SCHID AND schema_object.OBJECT_TYPE = 'SCH'
        ) mv ON mv.OWNER = o.OWNER AND mv.MVIEW_NAME = o.OBJECT_NAME
        """.stripIndent().trim();
    private Connection connection;
    private String connectedUsername;

    @Override
    public Connection getConnection() {
        return connection;
    }

    @Override
    public void connect(ConnectParams params) {
        uncheckedVoid(() -> {
            withSuppressedStdout(() -> {
                Class.forName("dm.jdbc.driver.DmDriver");
                connection = DriverManager.getConnection(buildUrl(params), params.getUsername(), params.getPassword());
                connectedUsername = params.getUsername();
            });
        });
    }

    @Override
    public boolean testConnection(ConnectParams params) {
        return unchecked(() -> {
            return withSuppressedStdout(() -> {
                Class.forName("dm.jdbc.driver.DmDriver");
                try (Connection conn = DriverManager.getConnection(buildUrl(params), params.getUsername(), params.getPassword())) {
                    return conn.isValid(5);
                }
            });
        });
    }

    /**
     * The DM JDBC driver writes a banner to {@code System.out} during
     * {@code Class.forName} / driver initialization.  This corrupts the
     * JSON-RPC stdout protocol.  Temporarily redirect {@code System.out}
     * to {@code System.err} so driver output lands on stderr instead.
     */
    private static <T> T withSuppressedStdout(ThrowingSupplier<T> action) throws Exception {
        PrintStream originalOut = System.out;
        try {
            System.setOut(System.err);
            return action.get();
        } finally {
            System.setOut(originalOut);
        }
    }

    private static void withSuppressedStdout(ThrowingRunnable action) throws Exception {
        PrintStream originalOut = System.out;
        try {
            System.setOut(System.err);
            action.run();
        } finally {
            System.setOut(originalOut);
        }
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> listVisibleUsers().stream().map(DatabaseInfo::new).toList());
    }

    @Override
    public List<String> listSchemas() {
        return unchecked(() -> {
            try {
                return listVisibleSchemas();
            } catch (SQLException catalogError) {
                try {
                    return listVisibleUsers();
                } catch (Exception fallbackError) {
                    catalogError.addSuppressed(fallbackError);
                    throw catalogError;
                }
            }
        });
    }

    private List<String> listVisibleUsers() throws Exception {
        List<String> result = new ArrayList<>();
        String sql = "SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME";
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    result.add(rs.getString(1));
                }
            }
        }
        return result;
    }

    private List<String> listVisibleSchemas() throws Exception {
        List<String> result = new ArrayList<>();
        String sql = "SELECT NAME FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCH' ORDER BY NAME";
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    result.add(rs.getString(1));
                }
            }
        }
        return result;
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return queryConstrainedTables(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<TableInfo> listTables(String schema, List<String> objectTypes) {
        return queryConstrainedTables(schema, new MetadataListConstraints(null, null, null, objectTypes));
    }

    @Override
    public List<TableInfo> listTables(String schema, MetadataListConstraints constraints) {
        return queryConstrainedTables(schema, MetadataListConstraints.orNone(constraints));
    }

    private List<TableInfo> queryConstrainedTables(String schema, MetadataListConstraints constraints) {
        if (!constraints.includesTableLikeTypes()) {
            return List.of();
        }
        try {
            return executeConstrainedTables(buildConstrainedTablesQuery(schema, constraints), constraints);
        } catch (RuntimeException e) {
            if (needsMaterializedViewClassification(constraints)) {
                try {
                    return executeConstrainedTables(
                        buildAccessibleConstrainedTablesQuery(schema, constraints),
                        constraints
                    );
                } catch (RuntimeException ignored) {
                    // Fall through to owner-local and raw catalog fallbacks.
                }
            }
            if (needsMaterializedViewClassification(constraints) && schemaMatchesConnectedUser(schema)) {
                try {
                    return executeConstrainedTables(
                        buildConstrainedTablesQuery(schema, constraints, DAMENG_USER_MATERIALIZED_VIEW_JOIN_SQL),
                        constraints
                    );
                } catch (RuntimeException ignored) {
                    // Fall through to the raw catalog path below.
                }
            }
            return executeRawConstrainedTables(schema, constraints);
        }
    }

    private List<TableInfo> executeConstrainedTables(MetadataQuery query, MetadataListConstraints constraints) {
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            try (PreparedStatement stmt = requireConnected().prepareStatement(query.sql())) {
                bind(stmt, query.args());
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TableInfo(rs.getString("TABLE_NAME"), normalizeObjectType(rs.getString("TABLE_TYPE")), rs.getString("COMMENTS")));
                    }
                }
            }
            return constraints.withoutPaging().filterTables(result);
        });
    }

    private List<TableInfo> executeRawConstrainedTables(String schema, MetadataListConstraints constraints) {
        List<TableInfo> candidates = executeConstrainedTables(
            buildRawConstrainedTablesQuery(schema, constraints),
            MetadataListConstraints.NONE
        );
        return constraints.filterTables(candidates);
    }

    static MetadataQuery buildConstrainedTablesQuery(String schema, MetadataListConstraints constraints) {
        return buildConstrainedTablesQuery(schema, constraints, DAMENG_SYSTEM_MATERIALIZED_VIEW_JOIN_SQL);
    }

    static MetadataQuery buildAccessibleConstrainedTablesQuery(
        String schema,
        MetadataListConstraints constraints
    ) {
        return buildConstrainedTablesQuery(schema, constraints, DAMENG_ACCESSIBLE_MATERIALIZED_VIEW_JOIN_SQL);
    }

    static MetadataQuery buildRawConstrainedTablesQuery(
        String schema,
        MetadataListConstraints constraints
    ) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        List<String> objectTypes = rawDamengTableObjectTypes(normalized);
        List<Object> args = new ArrayList<>();
        StringBuilder sql = new StringBuilder("""
            SELECT o.OBJECT_NAME AS TABLE_NAME,
                   o.OBJECT_TYPE AS TABLE_TYPE,
                   c.COMMENTS
            FROM ALL_OBJECTS o
            LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME
            WHERE o.OWNER = ?
            """.stripIndent().trim());
        args.add(schema);
        appendRawObjectTypePredicate(sql, args, objectTypes);
        sql.append(" AND (o.OBJECT_TYPE <> 'TABLE' OR o.OBJECT_NAME NOT LIKE 'MTAB$_%')");
        appendNameFilter(sql, args, "o.OBJECT_NAME", normalized);
        sql.append(" ORDER BY o.OBJECT_NAME");
        return new MetadataQuery(sql.toString(), args);
    }

    private static MetadataQuery buildConstrainedTablesQuery(
        String schema,
        MetadataListConstraints constraints,
        String materializedViewJoinSql
    ) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        boolean classifyMaterializedViews = needsMaterializedViewClassification(normalized);
        String objectTypeSql = classifyMaterializedViews ? DAMENG_CLASSIFIED_OBJECT_TYPE_SQL : "o.OBJECT_TYPE";
        String classificationJoinSql = classifyMaterializedViews ? materializedViewJoinSql : "";
        List<Object> args = new ArrayList<>();
        StringBuilder sql = new StringBuilder(("""
            SELECT o.OBJECT_NAME AS TABLE_NAME,
                   %s AS TABLE_TYPE,
                   c.COMMENTS
            FROM ALL_OBJECTS o
            LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME
            %s
            WHERE o.OWNER = ?
            """).formatted(objectTypeSql, classificationJoinSql).stripIndent().trim());
        args.add(schema);
        appendDamengObjectTypePredicate(sql, args, normalized, true, objectTypeSql);
        sql.append(" AND (o.OBJECT_TYPE <> 'TABLE' OR o.OBJECT_NAME NOT LIKE 'MTAB$_%')");
        appendNameFilter(sql, args, "o.OBJECT_NAME", normalized);
        sql.append(" ORDER BY o.OBJECT_NAME");
        appendLimitOffset(sql, args, normalized);
        return new MetadataQuery(sql.toString(), args);
    }

    private boolean schemaMatchesConnectedUser(String schema) {
        return connectedUsername != null
            && schema != null
            && !connectedUsername.isBlank()
            && schema.equalsIgnoreCase(connectedUsername);
    }

    private static boolean includesSupportedObjectTypes(MetadataListConstraints constraints) {
        return constraints.includesTableLikeTypes()
            || constraints.objectTypeAllowed("PROCEDURE")
            || constraints.objectTypeAllowed("FUNCTION");
    }

    private static void appendDamengObjectTypePredicate(
        StringBuilder sql,
        List<Object> args,
        MetadataListConstraints constraints,
        boolean tableOnly,
        String objectTypeSql
    ) {
        List<String> objectTypes = tableOnly ? damengTableObjectTypes(constraints) : damengObjectTypes(constraints);
        if (objectTypes.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND ").append(objectTypeSql)
            .append(" IN (").append(placeholders(objectTypes.size())).append(")");
        args.addAll(objectTypes);
    }

    private static List<String> damengTableObjectTypes(MetadataListConstraints constraints) {
        List<String> result = new ArrayList<>();
        if (constraints.tableTypeAllowed("TABLE")) {
            result.add("TABLE");
        }
        if (constraints.tableTypeAllowed("VIEW")) {
            result.add("VIEW");
        }
        if (constraints.tableTypeAllowed("MATERIALIZED_VIEW")) {
            result.add("MATERIALIZED_VIEW");
        }
        return result;
    }

    private static List<String> damengObjectTypes(MetadataListConstraints constraints) {
        List<String> result = damengTableObjectTypes(constraints);
        if (constraints.objectTypeAllowed("PROCEDURE")) {
            result.add("PROCEDURE");
        }
        if (constraints.objectTypeAllowed("FUNCTION")) {
            result.add("FUNCTION");
        }
        return result;
    }

    private static List<String> rawDamengTableObjectTypes(MetadataListConstraints constraints) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        if (constraints.tableTypeAllowed("TABLE")) {
            result.add("TABLE");
        }
        if (constraints.tableTypeAllowed("VIEW") || constraints.tableTypeAllowed("MATERIALIZED_VIEW")) {
            // DM8 may expose a materialized view as VIEW in ALL_OBJECTS. Keep
            // the direct catalog type too for versions that report it accurately.
            result.add("VIEW");
            result.add("MATERIALIZED VIEW");
        }
        return new ArrayList<>(result);
    }

    private static List<String> rawDamengObjectTypes(MetadataListConstraints constraints) {
        List<String> result = rawDamengTableObjectTypes(constraints);
        if (constraints.objectTypeAllowed("PROCEDURE")) {
            result.add("PROCEDURE");
        }
        if (constraints.objectTypeAllowed("FUNCTION")) {
            result.add("FUNCTION");
        }
        return result;
    }

    private static void appendRawObjectTypePredicate(
        StringBuilder sql,
        List<Object> args,
        List<String> objectTypes
    ) {
        if (objectTypes.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND o.OBJECT_TYPE IN (").append(placeholders(objectTypes.size())).append(")");
        args.addAll(objectTypes);
    }

    private static boolean needsMaterializedViewClassification(MetadataListConstraints constraints) {
        return constraints.tableTypeAllowed("VIEW") || constraints.tableTypeAllowed("MATERIALIZED_VIEW");
    }

    private static void appendNameFilter(StringBuilder sql, List<Object> args, String column, MetadataListConstraints constraints) {
        if (!constraints.hasFilter()) {
            return;
        }
        sql.append(" AND UPPER(").append(column).append(") LIKE ? ESCAPE '\\\\'");
        args.add(constraints.fuzzyLikePattern().toUpperCase(Locale.ROOT));
    }

    private static void appendLimitOffset(StringBuilder sql, List<Object> args, MetadataListConstraints constraints) {
        if (!constraints.hasLimit()) {
            return;
        }
        sql.append(" LIMIT ?");
        args.add(constraints.getLimit());
        if (constraints.hasOffset()) {
            sql.append(" OFFSET ?");
            args.add(constraints.getOffset());
        }
    }

    private static String placeholders(int count) {
        return String.join(", ", java.util.Collections.nCopies(count, "?"));
    }

    private static void bind(PreparedStatement stmt, List<Object> args) throws Exception {
        for (int index = 0; index < args.size(); index += 1) {
            Object arg = args.get(index);
            if (arg instanceof Integer) {
                stmt.setInt(index + 1, (Integer) arg);
            } else if (arg == null) {
                stmt.setObject(index + 1, null);
            } else {
                stmt.setString(index + 1, String.valueOf(arg));
            }
        }
    }

    static final class MetadataQuery {
        private final String sql;
        private final List<Object> args;

        MetadataQuery(String sql, List<Object> args) {
            this.sql = sql;
            this.args = args;
        }

        String sql() {
            return sql;
        }

        List<Object> args() {
            return args;
        }
    }

    private static String normalizeObjectType(String value) {
        String upper = value == null ? "" : value.trim().toUpperCase(Locale.ROOT).replace(' ', '_').replace('-', '_');
        if (upper.contains("MATERIALIZED") && upper.contains("VIEW")) {
            return "MATERIALIZED_VIEW";
        }
        if (upper.contains("VIEW")) {
            return "VIEW";
        }
        if (upper.contains("TABLE")) {
            return "TABLE";
        }
        return upper;
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return queryConstrainedObjects(schema, MetadataListConstraints.NONE);
    }

    @Override
    public List<ObjectInfo> listObjects(String schema, MetadataListConstraints constraints) {
        return queryConstrainedObjects(schema, MetadataListConstraints.orNone(constraints));
    }

    private List<ObjectInfo> queryConstrainedObjects(String schema, MetadataListConstraints constraints) {
        if (!includesSupportedObjectTypes(constraints)) {
            return List.of();
        }
        try {
            return executeConstrainedObjects(schema, buildConstrainedObjectsQuery(schema, constraints), constraints);
        } catch (RuntimeException e) {
            if (needsMaterializedViewClassification(constraints)) {
                try {
                    return executeConstrainedObjects(
                        schema,
                        buildAccessibleConstrainedObjectsQuery(schema, constraints),
                        constraints
                    );
                } catch (RuntimeException ignored) {
                    // Fall through to owner-local and raw catalog fallbacks.
                }
            }
            if (needsMaterializedViewClassification(constraints) && schemaMatchesConnectedUser(schema)) {
                try {
                    return executeConstrainedObjects(
                        schema,
                        buildConstrainedObjectsQuery(schema, constraints, DAMENG_USER_MATERIALIZED_VIEW_JOIN_SQL),
                        constraints
                    );
                } catch (RuntimeException ignored) {
                    // Fall through to the raw catalog path below.
                }
            }
            return executeRawConstrainedObjects(schema, constraints);
        }
    }

    private List<ObjectInfo> executeConstrainedObjects(
        String schema,
        MetadataQuery query,
        MetadataListConstraints constraints
    ) {
        return unchecked(() -> {
            List<ObjectInfo> result = new ArrayList<>();
            try (PreparedStatement stmt = requireConnected().prepareStatement(query.sql())) {
                bind(stmt, query.args());
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(
                            rs.getString("OBJECT_NAME"),
                            normalizeObjectType(rs.getString("OBJECT_TYPE")),
                            schema,
                            rs.getString("COMMENTS")
                        ));
                    }
                }
            }
            return constraints.withoutPaging().filterObjects(result);
        });
    }

    private List<ObjectInfo> executeRawConstrainedObjects(String schema, MetadataListConstraints constraints) {
        List<ObjectInfo> candidates = executeConstrainedObjects(
            schema,
            buildRawConstrainedObjectsQuery(schema, constraints),
            MetadataListConstraints.NONE
        );
        return constraints.filterObjects(candidates);
    }

    static MetadataQuery buildConstrainedObjectsQuery(String schema, MetadataListConstraints constraints) {
        return buildConstrainedObjectsQuery(schema, constraints, DAMENG_SYSTEM_MATERIALIZED_VIEW_JOIN_SQL);
    }

    static MetadataQuery buildAccessibleConstrainedObjectsQuery(
        String schema,
        MetadataListConstraints constraints
    ) {
        return buildConstrainedObjectsQuery(schema, constraints, DAMENG_ACCESSIBLE_MATERIALIZED_VIEW_JOIN_SQL);
    }

    static MetadataQuery buildRawConstrainedObjectsQuery(
        String schema,
        MetadataListConstraints constraints
    ) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        List<String> objectTypes = rawDamengObjectTypes(normalized);
        List<Object> args = new ArrayList<>();
        StringBuilder sql = new StringBuilder("""
            SELECT o.OBJECT_NAME,
                   o.OBJECT_TYPE,
                   c.COMMENTS
            FROM ALL_OBJECTS o
            LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME
            WHERE o.OWNER = ?
            """.stripIndent().trim());
        args.add(schema);
        appendRawObjectTypePredicate(sql, args, objectTypes);
        sql.append(" AND (o.OBJECT_TYPE <> 'TABLE' OR o.OBJECT_NAME NOT LIKE 'MTAB$_%')");
        appendNameFilter(sql, args, "o.OBJECT_NAME", normalized);
        sql.append(" ORDER BY o.OBJECT_NAME");
        return new MetadataQuery(sql.toString(), args);
    }

    private static MetadataQuery buildConstrainedObjectsQuery(
        String schema,
        MetadataListConstraints constraints,
        String materializedViewJoinSql
    ) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        boolean classifyMaterializedViews = needsMaterializedViewClassification(normalized);
        String objectTypeSql = classifyMaterializedViews ? DAMENG_CLASSIFIED_OBJECT_TYPE_SQL : "o.OBJECT_TYPE";
        String classificationJoinSql = classifyMaterializedViews ? materializedViewJoinSql : "";
        List<Object> args = new ArrayList<>();
        StringBuilder sql = new StringBuilder(("""
            SELECT o.OBJECT_NAME,
                   %s AS OBJECT_TYPE,
                   c.COMMENTS
            FROM ALL_OBJECTS o
            LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME
            %s
            WHERE o.OWNER = ?
            """).formatted(objectTypeSql, classificationJoinSql).stripIndent().trim());
        args.add(schema);
        appendDamengObjectTypePredicate(sql, args, normalized, false, objectTypeSql);
        sql.append(" AND (o.OBJECT_TYPE <> 'TABLE' OR o.OBJECT_NAME NOT LIKE 'MTAB$_%')");
        appendNameFilter(sql, args, "o.OBJECT_NAME", normalized);
        sql.append(" ORDER BY CASE ").append(objectTypeSql)
            .append(" WHEN 'TABLE' THEN 0")
            .append(" WHEN 'VIEW' THEN 1")
            .append(" WHEN 'MATERIALIZED_VIEW' THEN 2")
            .append(" WHEN 'PROCEDURE' THEN 3")
            .append(" WHEN 'FUNCTION' THEN 4")
            .append(" ELSE 9 END, o.OBJECT_NAME");
        appendLimitOffset(sql, args, normalized);
        return new MetadataQuery(sql.toString(), args);
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        return unchecked(() -> {
            String dbmsType = damengDdlObjectType(objectType);
            String source;
            String sql = "SELECT /*+ PARALLEL(1) */ DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, dbmsType);
                stmt.setString(2, name);
                stmt.setString(3, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    source = rs.next() ? coalesce(readTextColumn(rs, 1)) : "";
                }
            }
            return new ObjectSource(name, objectType, schema, source);
        });
    }

    static String damengDdlObjectType(String objectType) {
        return switch (objectType.toUpperCase(Locale.ROOT)) {
            case "VIEW" -> "VIEW";
            case "MATERIALIZED_VIEW", "MATERIALIZED VIEW" -> "MATERIALIZED_VIEW";
            case "PROCEDURE" -> "PROCEDURE";
            case "FUNCTION" -> "FUNCTION";
            // DM DBMS_METADATA accepts TRIGGER directly and returns executable CREATE OR REPLACE DDL.
            case "TRIGGER" -> "TRIGGER";
            default -> throw new IllegalArgumentException("Unsupported object type: " + objectType);
        };
    }

    @Override
    public String getTableDdl(String schema, String table) {
        return unchecked(() -> {
            String sql = "SELECT /*+ PARALLEL(1) */ DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL";
            String ddl = null;
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, "TABLE");
                stmt.setString(2, table);
                stmt.setString(3, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    if (rs.next()) {
                        ddl = coalesce(readTextColumn(rs, 1));
                    }
                }
            }
            if (ddl != null) {
                ddl = appendTableAndColumnComments(ddl, schema, table);
                return appendIndependentIndexDdl(ddl, schema, table);
            }
            throw new IllegalArgumentException("Table not found: " + schema + "." + table);
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            Set<String> pkColumns = new java.util.HashSet<>();
            String pkSql = """
                SELECT /*+ PARALLEL(1) */ cols.COLUMN_NAME FROM ALL_CONS_COLUMNS cols
                JOIN ALL_CONSTRAINTS cons ON cols.CONSTRAINT_NAME = cons.CONSTRAINT_NAME AND cols.OWNER = cons.OWNER
                WHERE cons.CONSTRAINT_TYPE = 'P' AND cons.OWNER = ? AND cons.TABLE_NAME = ?
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(pkSql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        pkColumns.add(rs.getString(1));
                    }
                }
            }

            Set<String> identityColumns = identityColumns(schema, table);
            List<ColumnInfo> result = new ArrayList<>();
            // DATA_DEFAULT is a LONG column — it must be selected first and read first
            // in JDBC, otherwise the data is truncated.
            String colSql = """
                SELECT /*+ PARALLEL(1) */ c.DATA_DEFAULT,
                    c.COLUMN_NAME,
                    c.DATA_TYPE,
                    c.NULLABLE,
                    c.DATA_PRECISION,
                    c.DATA_SCALE,
                    c.DATA_LENGTH,
                    c.CHAR_LENGTH,
                    c.CHAR_USED,
                    cc.COMMENTS
                FROM ALL_TAB_COLUMNS c
                LEFT JOIN ALL_COL_COMMENTS cc
                    ON cc.OWNER = c.OWNER
                    AND cc.TABLE_NAME = c.TABLE_NAME
                    AND cc.COLUMN_NAME = c.COLUMN_NAME
                WHERE c.OWNER = ? AND c.TABLE_NAME = ?
                ORDER BY c.COLUMN_ID
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(colSql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        // DATA_DEFAULT is a LONG — must be read first, before all other columns.
                        String dataDefault = readLongColumn(rs, "DATA_DEFAULT");
                        String name = rs.getString("COLUMN_NAME");
                        String baseType = rs.getString("DATA_TYPE");
                        Integer numPrec = intObject(rs, "DATA_PRECISION");
                        Integer numScale = intObject(rs, "DATA_SCALE");
                        Integer dataLen = intObject(rs, "DATA_LENGTH");
                        Integer charLen = intObject(rs, "CHAR_LENGTH");
                        String charUsed = rs.getString("CHAR_USED");
                        String dataType = formatDataType(baseType, numPrec, numScale, dataLen, charLen, charUsed);

                        result.add(new ColumnInfo(
                            name,
                            dataType,
                            "Y".equals(rs.getString("NULLABLE")),
                            dataDefault,
                            pkColumns.contains(name),
                            identityColumns.contains(name) ? "identity" : null,
                            rs.getString("COMMENTS"),
                            numPrec,
                            numScale,
                            charLen
                        ));
                    }
                }
            }
            fillMissingColumnComments(schema, table, result);
            return result;
        });
    }

    private Set<String> identityColumns(String schema, String table) {
        Set<String> result = new java.util.HashSet<>();
        String sql = """
            SELECT /*+ PARALLEL(1) */ c.NAME
            FROM SYS.SYSCOLUMNS c
            JOIN SYS.SYSOBJECTS t ON c.ID = t.ID
            JOIN SYS.SYSOBJECTS s ON t.SCHID = s.ID
            WHERE s.NAME = ? AND t.NAME = ? AND (c.INFO2 & 0x01) = 0x01
            """.stripIndent().trim();
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setString(1, schema);
            stmt.setString(2, table);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    String column = rs.getString(1);
                    if (notBlank(column)) {
                        result.add(column);
                    }
                }
            }
        } catch (Exception ignored) {
            // Some Dameng versions or users do not expose SYS.SYSCOLUMNS.
        }
        return result;
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return unchecked(() -> {
            List<IndexInfo> result = new ArrayList<>();
            String sql = """
                SELECT /*+ PARALLEL(1) */ i.INDEX_NAME,
                    LISTAGG(ic.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION) AS COLUMNS,
                    i.UNIQUENESS,
                    CASE WHEN c.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END AS IS_PK,
                    i.INDEX_TYPE
                FROM ALL_INDEXES i
                JOIN ALL_IND_COLUMNS ic ON i.INDEX_NAME = ic.INDEX_NAME AND i.OWNER = ic.INDEX_OWNER AND i.TABLE_OWNER = ic.TABLE_OWNER
                LEFT JOIN ALL_CONSTRAINTS c ON i.INDEX_NAME = c.INDEX_NAME AND i.TABLE_OWNER = c.OWNER
                    AND c.CONSTRAINT_TYPE = 'P'
                WHERE i.TABLE_OWNER = ? AND i.TABLE_NAME = ?
                GROUP BY i.INDEX_NAME, i.UNIQUENESS, c.CONSTRAINT_TYPE, i.INDEX_TYPE
                ORDER BY i.INDEX_NAME
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new IndexInfo(
                            rs.getString(1),
                            splitNonEmpty(coalesce(rs.getString(2)), ","),
                            "UNIQUE".equals(rs.getString(3)),
                            "1".equals(rs.getString(4)),
                            null,
                            rs.getString(5),
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
            String sql = """
                SELECT c.CONSTRAINT_NAME, cc.COLUMN_NAME, rc.TABLE_NAME, rcc.COLUMN_NAME
                FROM ALL_CONSTRAINTS c
                JOIN ALL_CONS_COLUMNS cc ON c.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND c.OWNER = cc.OWNER
                JOIN ALL_CONSTRAINTS rc ON c.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND c.R_OWNER = rc.OWNER
                JOIN ALL_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME AND rc.OWNER = rcc.OWNER
                WHERE c.CONSTRAINT_TYPE = 'R' AND c.OWNER = ? AND c.TABLE_NAME = ?
                ORDER BY c.CONSTRAINT_NAME
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
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
            List<TriggerInfo> result = new ArrayList<>();
            String sql = """
                SELECT TRIGGER_NAME, TRIGGERING_EVENT, '' AS TRIGGER_TYPE
                FROM ALL_TRIGGERS
                WHERE OWNER = ? AND TABLE_NAME = ?
                ORDER BY TRIGGER_NAME
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
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
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        String explainSql = explainTargetSql(sql);
        if (explainSql != null) {
            // DM JDBC reports raw EXPLAIN as an update count; its driver API is the only source of plan rows.
            return executeExplainQuery(explainSql, schema, options);
        }
        return JdbcExecutor.current().execute(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            options.getMaxRows(),
            options.getFetchSize(),
            options.getTimeoutSecs(),
            this::stringResultValue
        );
    }

    private QueryResult executeExplainQuery(String sql, String schema, ExecuteQueryOptions options) {
        return explainQueryResult(sql, schema, options.getTimeoutSecs(), options.getMaxRows());
    }

    private QueryResult explainQueryResult(String sql, String schema, int timeoutSecs, int maxRows) {
        long start = System.currentTimeMillis();
        String planText = getExplainInfo(sql, null, schema, timeoutSecs, "explain");
        int effectiveMaxRows = Math.max(maxRows, 1);
        List<List<Object>> rows = new ArrayList<>();
        boolean truncated = false;
        for (String line : planText.split("\\R")) {
            if (line.trim().isEmpty()) {
                continue;
            }
            if (rows.size() >= effectiveMaxRows) {
                truncated = true;
                break;
            }
            rows.add(List.of(line));
        }
        return new QueryResult(
            List.of("PLAN"),
            List.of("VARCHAR"),
            rows,
            0,
            System.currentTimeMillis() - start,
            truncated
        );
    }

    static String explainTargetSql(String sql) {
        if (sql == null) {
            return null;
        }
        int index = skipSqlTrivia(sql, 0);
        int keywordEnd = index + "EXPLAIN".length();
        if (keywordEnd > sql.length()
            || !sql.regionMatches(true, index, "EXPLAIN", 0, "EXPLAIN".length())
            || (keywordEnd < sql.length() && isIdentifierPart(sql.charAt(keywordEnd)))) {
            return null;
        }
        String targetSql = sql.substring(keywordEnd).trim();
        while (targetSql.endsWith(";")) {
            targetSql = targetSql.substring(0, targetSql.length() - 1).trim();
        }
        return targetSql.isEmpty() ? null : targetSql;
    }

    private static int skipSqlTrivia(String sql, int start) {
        int index = start;
        while (index < sql.length()) {
            if (Character.isWhitespace(sql.charAt(index))) {
                index++;
            } else if (sql.startsWith("--", index)) {
                int lineEnd = sql.indexOf('\n', index + 2);
                index = lineEnd < 0 ? sql.length() : lineEnd + 1;
            } else if (sql.startsWith("/*", index)) {
                int commentEnd = sql.indexOf("*/", index + 2);
                index = commentEnd < 0 ? sql.length() : commentEnd + 2;
            } else {
                break;
            }
        }
        return index;
    }

    private static boolean isIdentifierPart(char value) {
        return Character.isLetterOrDigit(value) || value == '_' || value == '$';
    }

    @Override
    public QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        String explainSql = explainTargetSql(sql);
        if (explainSql != null) {
            QueryResult result = explainQueryResult(explainSql, schema, options.getTimeoutSecs(), options.getMaxRows());
            return new QueryPageResult(
                result.getColumns(),
                result.getColumn_types(),
                result.getRows(),
                result.getAffected_rows(),
                result.getExecution_time_ms(),
                result.getTruncated(),
                null,
                false
            );
        }
        return JdbcExecutor.current().executePage(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            options,
            this::stringResultValue
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
            this::stringResultValue
        );
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "SET SCHEMA " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    @Override
    public void disconnect() {
        uncheckedVoid(() -> {
            if (connection != null) {
                connection.close();
            }
            connection = null;
        });
    }

    private Object stringResultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
            Object value = switch (sqlType) {
                case Types.BIGINT -> rs.getLong(index);
                case Types.INTEGER, Types.SMALLINT, Types.TINYINT -> rs.getInt(index);
                case Types.FLOAT, Types.REAL -> rs.getFloat(index);
                case Types.DOUBLE -> rs.getDouble(index);
                case Types.DECIMAL, Types.NUMERIC -> rs.getBigDecimal(index);
                case Types.BOOLEAN, Types.BIT -> rs.getBoolean(index);
                case Types.CHAR, Types.VARCHAR, Types.LONGVARCHAR,
                    Types.NCHAR, Types.NVARCHAR, Types.LONGNVARCHAR,
                    Types.CLOB, Types.NCLOB -> rs.getString(index);
                case Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY,
                    Types.BLOB -> bytesToHex(rs.getBytes(index));
                case Types.SQLXML -> sqlXmlToString(rs.getSQLXML(index));
                default -> normalizeResultValue(rs.getObject(index));
            };
            return rs.wasNull() ? null : value;
        });
    }

    private static Object normalizeResultValue(Object value) {
        if (value == null) return null;
        if (value instanceof Clob) {
            Clob clob = (Clob) value;
            return unchecked(() -> clob.getSubString(1, Math.toIntExact(clob.length())));
        }
        if (value instanceof Blob) {
            Blob blob = (Blob) value;
            return unchecked(() -> bytesToHex(blob.getBytes(1, Math.toIntExact(blob.length()))));
        }
        if (value instanceof SQLXML) {
            SQLXML sqlxml = (SQLXML) value;
            return unchecked(sqlxml::getString);
        }
        if (value instanceof byte[]) {
            return bytesToHex((byte[]) value);
        }
        return value instanceof Number || value instanceof Boolean ? value : value.toString();
    }

    private static String sqlXmlToString(SQLXML value) {
        return value == null ? null : unchecked(value::getString);
    }

    private static String readTextColumn(ResultSet rs, int columnIndex) throws Exception {
        try (Reader reader = rs.getCharacterStream(columnIndex)) {
            String value = readAll(reader);
            if (value != null) {
                return value;
            }
        } catch (Exception ignored) {
        }
        try {
            Clob clob = rs.getClob(columnIndex);
            if (clob != null) {
                return clob.getSubString(1, Math.toIntExact(clob.length()));
            }
        } catch (Exception ignored) {
        }
        return rs.getString(columnIndex);
    }

    private static String bytesToHex(byte[] bytes) {
        if (bytes == null) {
            return null;
        }
        StringBuilder result = new StringBuilder(bytes.length * 2 + 2);
        result.append("0x");
        for (byte b : bytes) {
            result.append(Character.forDigit((b >> 4) & 0xF, 16));
            result.append(Character.forDigit(b & 0xF, 16));
        }
        return result.toString();
    }

    private static String buildUrl(ConnectParams params) {
        String database = params.getDatabase() == null ? "" : params.getDatabase().trim();
        String suffix = database.isEmpty() ? "" : "/" + database;
        return "jdbc:dm://" + params.getHost() + ":" + params.getPort() + suffix;
    }

    private static String formatDataType(
        String base,
        Integer numPrec,
        Integer numScale,
        Integer dataLen,
        Integer charLen,
        String charUsed
    ) {
        return switch (base.toUpperCase(Locale.ROOT)) {
            case "VARCHAR2", "VARCHAR", "CHAR" -> {
                Integer length = characterLength(dataLen, charLen, charUsed);
                yield length != null ? base + "(" + length + characterLengthUnit(charUsed) + ")" : base;
            }
            case "NVARCHAR2", "NCHAR" -> {
                Integer length = charLen != null ? charLen : dataLen;
                yield length != null ? base + "(" + length + ")" : base;
            }
            case "NUMBER", "NUMERIC", "DECIMAL" -> {
                if (numPrec != null && numScale != null && numScale > 0) {
                    yield base + "(" + numPrec + "," + numScale + ")";
                }
                yield numPrec != null && numPrec > 0 ? base + "(" + numPrec + ")" : base;
            }
            case "RAW" -> dataLen != null ? "RAW(" + dataLen + ")" : "RAW";
            default -> base;
        };
    }

    private static Integer characterLength(Integer dataLen, Integer charLen, String charUsed) {
        String normalized = charUsed == null ? "" : charUsed.trim().toUpperCase(Locale.ROOT);
        if ("B".equals(normalized) || "BYTE".equals(normalized)) {
            return dataLen != null ? dataLen : charLen;
        }
        return charLen != null ? charLen : dataLen;
    }

    private static String characterLengthUnit(String charUsed) {
        if (charUsed == null) {
            return "";
        }
        return switch (charUsed.trim().toUpperCase(Locale.ROOT)) {
            case "B", "BYTE" -> " BYTE";
            case "C", "CHAR" -> " CHAR";
            default -> "";
        };
    }

    private static Integer intObject(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value == null ? null : ((Number) value).intValue();
    }

    // DATA_DEFAULT is stored as a LONG column in Oracle/Dameng. JDBC requires LONG
    // columns to be read before other columns. We also try getCharacterStream as a
    // fallback because some drivers don't support getString on LONG columns.
    private static String readLongColumn(ResultSet rs, String column) throws Exception {
        try {
            String value = rs.getString(column);
            if (value != null) {
                return value;
            }
        } catch (Exception ignored) {
        }
        try (Reader reader = rs.getCharacterStream(column)) {
            return readAll(reader);
        }
    }

    private static String readAll(Reader reader) throws Exception {
        if (reader == null) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        char[] buf = new char[4096];
        int n;
        while ((n = reader.read(buf)) != -1) {
            sb.append(buf, 0, n);
        }
        return sb.toString();
    }

    private static List<String> splitNonEmpty(String value, String delimiter) {
        List<String> result = new ArrayList<>();
        Arrays.stream(value.split(delimiter))
            .filter(part -> !part.isEmpty())
            .forEach(result::add);
        return result;
    }

    private static String coalesce(String value) {
        return value == null ? "" : value;
    }

    private void fillMissingColumnComments(String schema, String table, List<ColumnInfo> columns) {
        if (columns.stream().noneMatch(column -> !notBlank(column.getComment()))) {
            return;
        }
        Map<String, String> comments = new HashMap<>();
        queryColumnComments(
            comments,
            "SELECT /*+ PARALLEL(1) */ COLUMN_NAME, COMMENTS FROM USER_COL_COMMENTS WHERE TABLE_NAME = ?",
            table
        );
        queryColumnComments(
            comments,
            "SELECT /*+ PARALLEL(1) */ COLNAME, COMMENT$ FROM SYS.SYSCOLUMNCOMMENTS WHERE SCHNAME = ? AND TVNAME = ?",
            schema,
            table
        );
        queryColumnComments(
            comments,
            "SELECT /*+ PARALLEL(1) */ COLUMN_NAME, COMMENTS FROM ALL_COL_COMMENTS WHERE UPPER(OWNER) = UPPER(?) AND UPPER(TABLE_NAME) = UPPER(?)",
            schema,
            table
        );
        for (ColumnInfo column : columns) {
            if (notBlank(column.getComment())) {
                continue;
            }
            String comment = comments.get(column.getName().toUpperCase(Locale.ROOT));
            if (notBlank(comment)) {
                column.setComment(comment);
            }
        }
    }

    private void queryColumnComments(Map<String, String> comments, String sql, String... params) {
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            for (int i = 0; i < params.length; i++) {
                stmt.setString(i + 1, params[i]);
            }
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    String column = rs.getString(1);
                    String comment = rs.getString(2);
                    if (notBlank(column) && notBlank(comment)) {
                        comments.putIfAbsent(column.toUpperCase(Locale.ROOT), comment);
                    }
                }
            }
        } catch (Exception ignored) {
            // Some Dameng versions or users do not expose every comment view.
        }
    }

    private String appendTableAndColumnComments(String ddl, String schema, String table) throws Exception {
        StringBuilder result = new StringBuilder(ddl == null ? "" : ddl.trim());
        String tableRef = qualifiedName(schema, table);
        String tableComment = tableComment(schema, table);
        if (notBlank(tableComment) && !containsCommentOnTable(result.toString(), schema, table)) {
            appendCommentStatement(result, "COMMENT ON TABLE " + tableRef + " IS '" + sqlStringBody(tableComment) + "';");
        }
        for (ColumnInfo column : getColumns(schema, table)) {
            if (!notBlank(column.getComment()) || containsCommentOnColumn(result.toString(), schema, table, column.getName())) {
                continue;
            }
            appendCommentStatement(result, "COMMENT ON COLUMN " + tableRef + "." + JdbcIdentifiers.INSTANCE.doubleQuote(column.getName()) + " IS '" + sqlStringBody(column.getComment()) + "';");
        }
        return result.toString();
    }

    private String appendIndependentIndexDdl(String ddl, String schema, String table) throws Exception {
        StringBuilder result = new StringBuilder(ddl == null ? "" : ddl.trim());
        for (IndexInfo index : independentIndexes(schema, table)) {
            String indexName = index.getName();
            if (isInternalIndexMetadata(index) || index.getColumns().isEmpty()) {
                continue;
            }
            if (containsCreateIndex(result.toString(), schema, indexName)) {
                continue;
            }
            appendDdlStatement(result, indexDdl(schema, table, index));
        }
        return result.toString();
    }

    private List<IndexInfo> independentIndexes(String schema, String table) throws Exception {
        List<IndexInfo> result = new ArrayList<>();
        // Primary-key and unique-constraint backing indexes are already represented in table DDL.
        String sql = """
            SELECT /*+ PARALLEL(1) */ i.INDEX_NAME,
                LISTAGG(ic.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION) AS COLUMNS,
                i.UNIQUENESS,
                i.INDEX_TYPE
            FROM ALL_INDEXES i
            JOIN ALL_IND_COLUMNS ic ON i.INDEX_NAME = ic.INDEX_NAME AND i.OWNER = ic.INDEX_OWNER AND i.TABLE_OWNER = ic.TABLE_OWNER
            WHERE i.TABLE_OWNER = ? AND i.TABLE_NAME = ?
                AND NOT EXISTS (
                    SELECT 1
                    FROM ALL_CONSTRAINTS c
                    WHERE c.OWNER = i.TABLE_OWNER
                        AND c.TABLE_NAME = i.TABLE_NAME
                        AND c.INDEX_NAME = i.INDEX_NAME
                        AND c.CONSTRAINT_TYPE IN ('P', 'U')
                )
            GROUP BY i.INDEX_NAME, i.UNIQUENESS, i.INDEX_TYPE
            ORDER BY i.INDEX_NAME
            """.stripIndent().trim();
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setString(1, schema);
            stmt.setString(2, table);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    String indexName = rs.getString(1);
                    if (notBlank(indexName)) {
                        result.add(new IndexInfo(
                            indexName,
                            splitNonEmpty(coalesce(rs.getString(2)), ","),
                            "UNIQUE".equals(rs.getString(3)),
                            false,
                            null,
                            rs.getString(4),
                            null,
                            null
                        ));
                    }
                }
            }
        }
        return result;
    }

    private static String indexDdl(String schema, String table, IndexInfo index) {
        StringBuilder ddl = new StringBuilder("CREATE ");
        if (index.getIs_unique()) {
            ddl.append("UNIQUE ");
        }
        ddl.append("INDEX ")
            .append(qualifiedName(schema, index.getName()))
            .append(" ON ")
            .append(qualifiedName(schema, table))
            .append(" (");
        for (int i = 0; i < index.getColumns().size(); i++) {
            if (i > 0) {
                ddl.append(", ");
            }
            ddl.append(JdbcIdentifiers.INSTANCE.doubleQuote(index.getColumns().get(i)));
        }
        ddl.append(");");
        return ddl.toString();
    }

    private static boolean isInternalIndexMetadata(IndexInfo index) {
        String indexType = coalesce(index.getIndex_type()).toUpperCase(Locale.ROOT);
        return indexType.contains("INNER") || indexType.contains("INTERNAL");
    }

    private String tableComment(String schema, String table) throws Exception {
        String sql = """
            SELECT /*+ PARALLEL(1) */ COMMENTS
            FROM ALL_TAB_COMMENTS
            WHERE OWNER = ? AND TABLE_NAME = ?
            """.stripIndent().trim();
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setString(1, schema);
            stmt.setString(2, table);
            try (ResultSet rs = stmt.executeQuery()) {
                return rs.next() ? rs.getString(1) : null;
            }
        }
    }

    private static void appendCommentStatement(StringBuilder ddl, String statement) {
        appendDdlStatement(ddl, statement);
    }

    private static void appendDdlStatement(StringBuilder ddl, String statement) {
        if (!ddl.isEmpty()) {
            if (ddl.charAt(ddl.length() - 1) != '\n') {
                ddl.append("\n");
            }
            ddl.append("\n");
        }
        ddl.append(statement);
    }

    private static String ensureStatementTerminator(String statement) {
        String trimmed = coalesce(statement).trim();
        if (trimmed.isEmpty() || trimmed.endsWith(";")) {
            return trimmed;
        }
        return trimmed + ";";
    }

    private static boolean containsCommentOnTable(String ddl, String schema, String table) {
        return normalizedDdl(ddl).contains("COMMENT ON TABLE " + normalizedQualifiedName(schema, table));
    }

    private static boolean containsCommentOnColumn(String ddl, String schema, String table, String column) {
        return normalizedDdl(ddl).contains("COMMENT ON COLUMN " + normalizedQualifiedName(schema, table) + "." + normalizedIdentifier(column));
    }

    private static boolean containsCreateIndex(String ddl, String schema, String indexName) {
        String normalized = normalizedDdl(ddl);
        return normalized.contains(" INDEX " + normalizedQualifiedName(schema, indexName) + " ")
            || normalized.contains(" INDEX " + normalizedIdentifier(indexName) + " ");
    }

    private static String qualifiedName(String schema, String name) {
        if (!notBlank(schema)) {
            return JdbcIdentifiers.INSTANCE.doubleQuote(name);
        }
        return JdbcIdentifiers.INSTANCE.doubleQuote(schema) + "." + JdbcIdentifiers.INSTANCE.doubleQuote(name);
    }

    private static String normalizedQualifiedName(String schema, String name) {
        if (!notBlank(schema)) {
            return normalizedIdentifier(name);
        }
        return normalizedIdentifier(schema) + "." + normalizedIdentifier(name);
    }

    private static String normalizedIdentifier(String value) {
        return JdbcIdentifiers.INSTANCE.doubleQuote(value).toUpperCase(Locale.ROOT);
    }

    private static String normalizedDdl(String ddl) {
        return coalesce(ddl).toUpperCase(Locale.ROOT).replaceAll("\\s+", " ");
    }

    private static boolean notBlank(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private static String sqlStringBody(String value) {
        return value.replace("'", "''");
    }

    @Override
    public String getExplainInfo(String sql, String database, String schema, int timeoutSecs, String mode) {
        return unchecked(() -> {
            Connection conn = requireConnected();
            if (schema != null && !schema.trim().isEmpty()) {
                try (Statement schemaStmt = conn.createStatement()) {
                    schemaStmt.execute(setSchemaSQL(schema));
                }
            }
            boolean autotrace = "autotrace".equalsIgnoreCase(mode);
            String planText = null;

            if (autotrace) {
                boolean monitorEnabled = false;
                try (Statement s = conn.createStatement()) {
                    s.execute("SF_SET_SESSION_PARA_VALUE('MONITOR_SQL_EXEC', 1)");
                    monitorEnabled = true;
                } catch (Exception ignored) {}

                try (Statement stmt = conn.createStatement()) {
                    if (timeoutSecs >= 0) {
                        try { stmt.setQueryTimeout(timeoutSecs); } catch (Exception ignored) {}
                    }
                    boolean hasResultSet = stmt.execute(sql);
                    if (hasResultSet) {
                        try (ResultSet rs = stmt.getResultSet()) {
                            while (rs.next()) { /* consume all rows */ }
                        }
                    }
                    try {
                        Class<?> dmConnClass = Class.forName("dm.jdbc.driver.DmdbConnection");
                        if (dmConnClass.isInstance(conn)) {
                            Method m = dmConnClass.getMethod("getExplainInfo", Statement.class);
                            planText = (String) m.invoke(dmConnClass.cast(conn), stmt);
                        }
                    } catch (Exception ignored) {}
                } finally {
                    if (monitorEnabled) {
                        try (Statement s = conn.createStatement()) {
                            s.execute("SF_SET_SESSION_PARA_VALUE('MONITOR_SQL_EXEC', 0)");
                        } catch (Exception ignored) {}
                    }
                }
            } else {
                try {
                    Class<?> dmConnClass = Class.forName("dm.jdbc.driver.DmdbConnection");
                    if (dmConnClass.isInstance(conn)) {
                        Method m = dmConnClass.getMethod("getExplainInfo", String.class);
                        planText = (String) m.invoke(dmConnClass.cast(conn), sql);
                    }
                } catch (Exception ignored) {}
            }

            if (planText == null || planText.trim().isEmpty()) {
                try (Statement explainStmt = conn.createStatement();
                     ResultSet rs = explainStmt.executeQuery("EXPLAIN " + sql)) {
                    StringBuilder sb = new StringBuilder();
                    while (rs.next()) {
                        sb.append(rs.getString(1)).append("\n");
                    }
                    planText = sb.toString().trim();
                } catch (Exception ignored) {}
            }
            return planText != null ? planText : "";
        });
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(DamengAgent::new).run();
    }
}
