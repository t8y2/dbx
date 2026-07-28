package com.dbx.agent.gbase8a;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import com.dbx.agent.StandardJdbcMetadata;
import com.dbx.agent.TableInfo;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

public final class Gbase8aAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile GBASE8A_PROFILE = new JdbcAgentProfile(
        "com.gbase.jdbc.Driver",
        "jdbc:gbase://{host}:{port}/{database}?useSSL=false",
        5258,
        false,
        java.util.Collections.emptySet(),
        java.util.Arrays.asList("TABLE", "VIEW", "BASE TABLE"),
        "`",
        "USE",
        true,
        false,
        true,
        false
    );

    public Gbase8aAgent() {
        super(GBASE8A_PROFILE);
    }

    @Override
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        return super.executeQuery(sql, schema, withoutFetchSize(options));
    }

    @Override
    public QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        return super.executeQueryPage(sql, schema, withoutFetchSize(options));
    }

    @Override
    public QueryPageResult startTableRead(String sql, String schema, QueryPageOptions options) {
        return super.startTableRead(sql, schema, withoutFetchSize(options));
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
            if (!constraints.includesTableLikeTypes()) {
                return List.of();
            }
            List<TableInfo> result = new ArrayList<>();
            List<Object> args = new ArrayList<>();
            StringBuilder sql = new StringBuilder("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE ");
            if (hasSchema(schema)) {
                sql.append("TABLE_SCHEMA = ?");
                args.add(schema);
            } else {
                sql.append("TABLE_SCHEMA NOT IN ('information_schema', 'performance_schema', 'gclusterdb', 'gctmpdb')");
            }
            appendGbase8aTableTypePredicate(sql, args, constraints);
            appendNameFilter(sql, args, "TABLE_NAME", constraints);
            sql.append(hasSchema(schema) ? " ORDER BY TABLE_NAME" : " ORDER BY TABLE_SCHEMA, TABLE_NAME");
            appendLimitOffset(sql, args, constraints);
            try (PreparedStatement stmt = requireConnection().prepareStatement(sql.toString())) {
                bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        String tableType = rs.getString("TABLE_TYPE");
                        if ("BASE TABLE".equals(tableType)) {
                            tableType = "TABLE";
                        }
                        result.add(new TableInfo(rs.getString("TABLE_NAME"), tableType, null));
                    }
                }
            }
            result.sort(Comparator.comparing(TableInfo::getName));
            MetadataListConstraints guard = constraints.hasLimit() ? constraints.withoutPaging() : constraints;
            return guard.filterTables(result);
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
            boolean includeTables = constraints.includesTableLikeTypes();
            boolean includeRoutines = includesRoutineTypes(constraints);
            if (!includeTables && !includeRoutines) {
                return List.of();
            }
            List<ObjectInfo> result = new ArrayList<>();
            if (includeTables) {
                MetadataListConstraints tableConstraints = includeRoutines
                    ? new MetadataListConstraints(constraints.getFilter(), null, null, tableLikeObjectTypes(constraints))
                    : constraints;
                result.addAll(StandardJdbcMetadata.INSTANCE.listObjects(queryTables(schema, tableConstraints), schema));
            }
            if (includeRoutines) {
                MetadataListConstraints routineConstraints = includeTables
                    ? new MetadataListConstraints(constraints.getFilter(), null, null, routineObjectTypes(constraints))
                    : constraints;
                appendRoutines(result, schema, routineConstraints);
            }
            boolean singlePagedSource = includeTables != includeRoutines && constraints.hasLimit();
            MetadataListConstraints guard = singlePagedSource ? constraints.withoutPaging() : constraints;
            return guard.filterObjects(result);
        });
    }

    private void appendRoutines(List<ObjectInfo> result, String schema, MetadataListConstraints constraints) throws Exception {
        StringBuilder sql = new StringBuilder();
        List<Object> args = new ArrayList<>();
        boolean hasSchema = hasSchema(schema);
        if (hasSchema) {
            sql.append("SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?");
            args.add(schema);
        } else {
            sql.append("SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA NOT IN ('information_schema', 'performance_schema', 'gclusterdb', 'gctmpdb')");
        }
        appendGbase8aRoutineTypePredicate(sql, args, constraints);
        appendNameFilter(sql, args, "ROUTINE_NAME", constraints);
        sql.append(hasSchema ? " ORDER BY ROUTINE_NAME" : " ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME");
        appendLimitOffset(sql, args, constraints);
        try (PreparedStatement stmt = requireConnection().prepareStatement(sql.toString())) {
            bind(stmt, args);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    String routineSchema = hasSchema ? schema : rs.getString("ROUTINE_SCHEMA");
                    result.add(new ObjectInfo(
                        rs.getString("ROUTINE_NAME"),
                        normalizeRoutineType(rs.getString("ROUTINE_TYPE")),
                        routineSchema,
                        rs.getString("ROUTINE_COMMENT")
                    ));
                }
            }
        }
    }

    @Override
    public String getTableDdl(String schema, String table) {
        try {
            String ddl = showCreateDefinition("TABLE", schema, table);
            if (!ddl.isEmpty()) {
                return ddl;
            }
        } catch (RuntimeException ignored) {
            // Keep metadata-based DDL available for servers that restrict SHOW CREATE TABLE.
        }
        return super.getTableDdl(schema, table);
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String normalizedType = objectType.toUpperCase(Locale.ROOT);
        if (!List.of("VIEW", "PROCEDURE", "FUNCTION").contains(normalizedType)) {
            throw new IllegalArgumentException("Unsupported object type: " + objectType);
        }
        return new ObjectSource(name, normalizedType, schema, showCreateDefinition(normalizedType, schema, name));
    }

    private String showCreateDefinition(String objectType, String schema, String name) {
        return unchecked(() -> {
            String qualifiedName = hasSchema(schema)
                ? JdbcIdentifiers.INSTANCE.backtick(schema) + "." + JdbcIdentifiers.INSTANCE.backtick(name)
                : JdbcIdentifiers.INSTANCE.backtick(name);
            try (Statement stmt = requireConnection().createStatement();
                 ResultSet rs = stmt.executeQuery("SHOW CREATE " + objectType + " " + qualifiedName)) {
                if (!rs.next()) {
                    return "";
                }
                // SHOW CREATE result layouts vary by GBase driver version, so locate the definition column by label.
                ResultSetMetaData metadata = rs.getMetaData();
                for (int index = 1; index <= metadata.getColumnCount(); index++) {
                    String label = metadata.getColumnLabel(index);
                    if (label != null && label.toUpperCase(Locale.ROOT).startsWith("CREATE ")) {
                        String value = rs.getString(index);
                        return value == null ? "" : value;
                    }
                }
                return "";
            }
        });
    }

    private static void appendGbase8aTableTypePredicate(
        StringBuilder sql,
        List<Object> args,
        MetadataListConstraints constraints
    ) {
        if (!constraints.hasObjectTypes()) {
            return;
        }
        List<String> tableTypes = new ArrayList<>();
        if (constraints.tableTypeAllowed("TABLE")) {
            tableTypes.add("BASE TABLE");
        }
        if (constraints.tableTypeAllowed("VIEW")) {
            tableTypes.add("VIEW");
        }
        if (tableTypes.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND TABLE_TYPE IN (").append(placeholders(tableTypes.size())).append(")");
        args.addAll(tableTypes);
    }

    private static void appendGbase8aRoutineTypePredicate(
        StringBuilder sql,
        List<Object> args,
        MetadataListConstraints constraints
    ) {
        if (!constraints.hasObjectTypes()) {
            return;
        }
        List<String> routineTypes = new ArrayList<>();
        if (constraints.objectTypeAllowed("PROCEDURE")) {
            routineTypes.add("PROCEDURE");
        }
        if (constraints.objectTypeAllowed("FUNCTION")) {
            routineTypes.add("FUNCTION");
        }
        if (routineTypes.isEmpty()) {
            sql.append(" AND 1 = 0");
            return;
        }
        sql.append(" AND ROUTINE_TYPE IN (").append(placeholders(routineTypes.size())).append(")");
        args.addAll(routineTypes);
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

    private static boolean hasSchema(String schema) {
        return schema != null && !schema.trim().isEmpty();
    }

    private static boolean includesRoutineTypes(MetadataListConstraints constraints) {
        if (!constraints.hasObjectTypes()) {
            return true;
        }
        return constraints.objectTypeAllowed("PROCEDURE") || constraints.objectTypeAllowed("FUNCTION");
    }

    private static List<String> tableLikeObjectTypes(MetadataListConstraints constraints) {
        if (!constraints.hasObjectTypes()) {
            return null;
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

    private static List<String> routineObjectTypes(MetadataListConstraints constraints) {
        if (!constraints.hasObjectTypes()) {
            return null;
        }
        List<String> result = new ArrayList<>();
        if (constraints.objectTypeAllowed("PROCEDURE")) {
            result.add("PROCEDURE");
        }
        if (constraints.objectTypeAllowed("FUNCTION")) {
            result.add("FUNCTION");
        }
        return result;
    }

    private static String placeholders(int count) {
        return String.join(", ", java.util.Collections.nCopies(count, "?"));
    }

    private static void bind(PreparedStatement stmt, List<Object> args) throws Exception {
        for (int index = 0; index < args.size(); index += 1) {
            Object arg = args.get(index);
            if (arg instanceof Integer) {
                stmt.setInt(index + 1, (Integer) arg);
            } else {
                stmt.setString(index + 1, String.valueOf(arg));
            }
        }
    }

    private static String normalizeRoutineType(String routineType) {
        if (routineType == null || routineType.trim().isEmpty()) {
            return "PROCEDURE";
        }
        return routineType.trim().toUpperCase(Locale.ROOT);
    }

    private static ExecuteQueryOptions withoutFetchSize(ExecuteQueryOptions options) {
        return new ExecuteQueryOptions(options.getMaxRows(), null, options.getTimeoutSecs());
    }

    private static QueryPageOptions withoutFetchSize(QueryPageOptions options) {
        return new QueryPageOptions(options.getPageSize(), null, options.getMaxRows(), options.getTimeoutSecs());
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(Gbase8aAgent::new).run();
    }
}
