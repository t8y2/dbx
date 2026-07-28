package com.dbx.agent.databend;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.PreparedStatement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public final class DatabendAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile DATABEND_PROFILE = new JdbcAgentProfile(
        "com.databend.jdbc.DatabendDriver",
        "jdbc:databend://{host}:{port}/{database}",
        8000,
        false,
        Collections.singleton("INFORMATION_SCHEMA"),
        Arrays.asList("TABLE", "VIEW", "BASE TABLE", "MATERIALIZED VIEW", "SYSTEM TABLE", "SYSTEM VIEW"),
        "\"",
        "USE",
        true,
        false,
        false,
        false
    );

    public DatabendAgent() {
        super(DATABEND_PROFILE);
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return unchecked(() -> {
            List<ObjectInfo> result = new ArrayList<>(super.listObjects(schema));
            try {
                useSchema(schema);
                try (java.sql.Statement stmt = requireConnected().createStatement();
                     ResultSet rs = stmt.executeQuery("SHOW PROCEDURES")) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString("name"), "PROCEDURE", schema, rs.getString("comment")));
                    }
                }
            } catch (Exception ignored) {
            }
            return result;
        });
    }

    @Override
    public List<ObjectInfo> listObjects(String schema, MetadataListConstraints constraints) {
        MetadataListConstraints normalized = MetadataListConstraints.orNone(constraints);
        boolean includeTables = normalized.includesTableLikeTypes();
        boolean includeProcedures = includesProcedures(normalized);
        if (includeProcedures && !includeTables) {
            return listProcedures(schema, normalized);
        }
        if (includeTables && !includeProcedures) {
            return super.listObjects(schema, normalized);
        }
        if (!includeTables && !includeProcedures) {
            return List.of();
        }
        return normalized.filterObjects(listObjects(schema));
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        if (!"PROCEDURE".equalsIgnoreCase(objectType)) {
            return super.getObjectSource(schema, name, objectType);
        }
        return unchecked(() -> {
            useSchema(schema);
            ProcedureMetadata procedure = findProcedure(name);
            if (procedure == null) {
                throw new IllegalArgumentException("Procedure not found: " + name);
            }
            Map<String, String> properties = describeProcedure(name, procedure.inputTypes);
            String source = buildProcedureSource(name, procedure, properties);
            return new ObjectSource(name, objectType, schema, source);
        });
    }

    private void useSchema(String schema) throws SQLException {
        if (schema == null || schema.trim().isEmpty()) {
            return;
        }
        try (java.sql.Statement stmt = requireConnected().createStatement()) {
            stmt.execute(DATABEND_PROFILE.schemaSwitchSql(schema.trim()));
        }
    }

    private List<ObjectInfo> listProcedures(String schema, MetadataListConstraints constraints) {
        return unchecked(() -> {
            useSchema(schema);
            List<ObjectInfo> result = new ArrayList<>();
            StringBuilder sql = new StringBuilder("SELECT name, comment FROM system.procedures");
            List<Object> args = new ArrayList<>();
            if (constraints.hasFilter()) {
                sql.append(" WHERE UPPER(name) LIKE ? ESCAPE '\\\\'");
                args.add(constraints.fuzzyLikePattern().toUpperCase(Locale.ROOT));
            }
            sql.append(" ORDER BY name");
            if (constraints.hasLimit()) {
                sql.append(" LIMIT ?");
                args.add(constraints.getLimit());
                if (constraints.hasOffset()) {
                    sql.append(" OFFSET ?");
                    args.add(constraints.getOffset());
                }
            }
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql.toString())) {
                bind(stmt, args);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString("name"), "PROCEDURE", schema, rs.getString("comment")));
                    }
                }
            }
            MetadataListConstraints guard = constraints.hasLimit() ? constraints.withoutPaging() : constraints;
            return guard.filterObjects(result);
        });
    }

    private static boolean includesProcedures(MetadataListConstraints constraints) {
        return !constraints.hasObjectTypes() || constraints.objectTypeAllowed("PROCEDURE");
    }

    private static void bind(PreparedStatement stmt, List<Object> args) throws SQLException {
        for (int index = 0; index < args.size(); index += 1) {
            Object arg = args.get(index);
            if (arg instanceof Integer) {
                stmt.setInt(index + 1, (Integer) arg);
            } else {
                stmt.setString(index + 1, String.valueOf(arg));
            }
        }
    }

    private ProcedureMetadata findProcedure(String name) throws SQLException {
        try (java.sql.PreparedStatement stmt = requireConnected().prepareStatement(
            "SELECT arguments, comment FROM system.procedures WHERE name = ? ORDER BY procedure_id LIMIT 1"
        )) {
            stmt.setString(1, name);
            try (ResultSet rs = stmt.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                return new ProcedureMetadata(
                    rs.getString("comment"),
                    inputTypesFromArguments(rs.getString("arguments"))
                );
            }
        }
    }

    private Map<String, String> describeProcedure(String name, List<String> inputTypes) throws SQLException {
        Map<String, String> result = new LinkedHashMap<>();
        try (java.sql.Statement stmt = requireConnected().createStatement();
             ResultSet rs = stmt.executeQuery("DESC PROCEDURE " + simpleProcedureName(name) + "(" + String.join(", ", inputTypes) + ")")) {
            while (rs.next()) {
                result.put(rs.getString("Property").toLowerCase(Locale.ROOT), rs.getString("Value"));
            }
        }
        return result;
    }

    private static String buildProcedureSource(String name, ProcedureMetadata procedure, Map<String, String> properties) {
        List<String> names = signatureNames(properties.get("signature"));
        List<String> arguments = new ArrayList<>();
        for (int index = 0; index < procedure.inputTypes.size(); index += 1) {
            String argumentName = index < names.size() && !names.get(index).isEmpty() ? names.get(index) : "arg" + (index + 1);
            arguments.add(argumentName + " " + procedure.inputTypes.get(index));
        }

        String returns = trimOuterParens(properties.getOrDefault("returns", ""));
        String language = properties.getOrDefault("language", "SQL");
        String body = properties.getOrDefault("body", "").trim();
        StringBuilder source = new StringBuilder();
        source.append("CREATE PROCEDURE ").append(simpleProcedureName(name)).append("(").append(String.join(", ", arguments)).append(")");
        if (!returns.isEmpty()) {
            source.append("\nRETURNS ").append(returns);
        }
        source.append("\nLANGUAGE ").append(language);
        if (procedure.comment != null && !procedure.comment.isEmpty()) {
            source.append("\nCOMMENT = '").append(procedure.comment.replace("'", "''")).append("'");
        }
        source.append("\nAS $$\n").append(body).append("\n$$;");
        return source.toString();
    }

    private static String simpleProcedureName(String name) {
        if (name != null && name.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            return name;
        }
        throw new IllegalArgumentException("Databend procedure names with special characters are not supported: " + name);
    }

    private static List<String> inputTypesFromArguments(String arguments) {
        if (arguments == null) {
            return Collections.emptyList();
        }
        int open = arguments.indexOf('(');
        if (open < 0) {
            return Collections.emptyList();
        }
        int close = matchingParen(arguments, open);
        if (close < 0) {
            return Collections.emptyList();
        }
        return splitTopLevel(arguments.substring(open + 1, close));
    }

    private static List<String> signatureNames(String signature) {
        if (signature == null) {
            return Collections.emptyList();
        }
        String trimmed = trimOuterParens(signature);
        return splitTopLevel(trimmed);
    }

    private static List<String> splitTopLevel(String value) {
        if (value == null || value.trim().isEmpty()) {
            return Collections.emptyList();
        }
        List<String> result = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        int depth = 0;
        for (int index = 0; index < value.length(); index += 1) {
            char ch = value.charAt(index);
            if (ch == '(') {
                depth += 1;
            } else if (ch == ')') {
                depth = Math.max(0, depth - 1);
            } else if (ch == ',' && depth == 0) {
                addTrimmed(result, current.toString());
                current.setLength(0);
                continue;
            }
            current.append(ch);
        }
        addTrimmed(result, current.toString());
        return result;
    }

    private static void addTrimmed(List<String> result, String value) {
        String trimmed = value.trim();
        if (!trimmed.isEmpty()) {
            result.add(trimmed);
        }
    }

    private static int matchingParen(String value, int open) {
        int depth = 0;
        for (int index = open; index < value.length(); index += 1) {
            char ch = value.charAt(index);
            if (ch == '(') {
                depth += 1;
            } else if (ch == ')') {
                depth -= 1;
                if (depth == 0) {
                    return index;
                }
            }
        }
        return -1;
    }

    private static String trimOuterParens(String value) {
        String trimmed = value == null ? "" : value.trim();
        if (trimmed.startsWith("(") && trimmed.endsWith(")") && matchingParen(trimmed, 0) == trimmed.length() - 1) {
            return trimmed.substring(1, trimmed.length() - 1).trim();
        }
        return trimmed;
    }

    private static final class ProcedureMetadata {
        private final String comment;
        private final List<String> inputTypes;

        ProcedureMetadata(String comment, List<String> inputTypes) {
            this.comment = comment;
            this.inputTypes = inputTypes;
        }
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(DatabendAgent::new).run();
    }
}
