package com.dbx.agent.gbase8a;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.JsonRpcServer;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import com.dbx.agent.StandardJdbcMetadata;
import com.dbx.agent.TableInfo;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
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
        false,
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
        return unchecked(() -> {
            List<TableInfo> result = new ArrayList<>();
            String sql;
            if (schema != null && !schema.trim().isEmpty()) {
                sql = "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME";
            } else {
                sql = "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('information_schema', 'performance_schema', 'gclusterdb', 'gctmpdb') ORDER BY TABLE_SCHEMA, TABLE_NAME";
            }
            try (PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                if (schema != null && !schema.trim().isEmpty()) {
                    stmt.setString(1, schema);
                }
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
            return result;
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return unchecked(() -> {
            List<ObjectInfo> result = StandardJdbcMetadata.INSTANCE.listObjects(listTables(schema), schema);
            // GBase 8a's table metadata does not surface routines, so sidebar objects must load them explicitly.
            appendRoutines(result, schema);
            return result;
        });
    }

    private void appendRoutines(List<ObjectInfo> result, String schema) throws Exception {
        String sql;
        boolean hasSchema = schema != null && !schema.trim().isEmpty();
        if (hasSchema) {
            sql = "SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME";
        } else {
            sql = "SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA NOT IN ('information_schema', 'performance_schema', 'gclusterdb', 'gctmpdb') ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME";
        }
        try (PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
            if (hasSchema) {
                stmt.setString(1, schema);
            }
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
        new JsonRpcServer(new Gbase8aAgent()).run();
    }
}
