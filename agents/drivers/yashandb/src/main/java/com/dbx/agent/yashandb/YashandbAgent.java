package com.dbx.agent.yashandb;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectSource;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Struct;
import java.sql.Types;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Locale;
import java.util.Set;

public final class YashandbAgent extends ConfiguredJdbcAgent {
    private static final int MAX_STRUCT_DEPTH = 8;
    static final String OBJECT_SOURCE_SQL = """
        SELECT TEXT
        FROM ALL_SOURCE
        WHERE OWNER = ?
          AND NAME = ?
          AND TYPE = ?
        ORDER BY LINE
        """.stripIndent().trim();

    public static final JdbcAgentProfile YASHANDB_PROFILE = new JdbcAgentProfile(
        "com.yashandb.jdbc.Driver",
        "jdbc:yasdb://{host}:{port}/{database}",
        1688,
        true
    );

    public YashandbAgent() {
        super(YASHANDB_PROFILE);
    }

    @Override
    protected JdbcExecutor.ResultValueReader resultValueReader() {
        return (JdbcExecutor.ColumnAwareResultValueReader) this::readYashandbValue;
    }

    private Object readYashandbValue(ResultSet resultSet, int index, int sqlType, String columnTypeName) throws SQLException {
        if (!isStructuredValue(sqlType, columnTypeName)) {
            return super.resultValue(resultSet, index, sqlType);
        }
        // YashanDB JDBC rejects getString for UDT accessors; materialize the structured object instead.
        Object value = resultSet.getObject(index);
        if (value == null || resultSet.wasNull()) {
            return null;
        }
        if (value instanceof Struct) {
            return normalizeStructuredValue((Struct) value);
        }
        return JdbcExecutor.normalizeResultValue(value);
    }

    private static String normalizeStructuredValue(Struct value) throws SQLException {
        Set<Struct> visited = Collections.newSetFromMap(new IdentityHashMap<>());
        return normalizeStructuredValue(value, visited, 0);
    }

    private static String normalizeStructuredValue(Struct value, Set<Struct> visited, int depth) throws SQLException {
        String typeName = value.getSQLTypeName();
        String displayType = typeName == null || typeName.isBlank() ? "STRUCT" : typeName;
        if (depth >= MAX_STRUCT_DEPTH) {
            return displayType + "(<max-depth>)";
        }
        if (!visited.add(value)) {
            return displayType + "(<cycle>)";
        }
        try {
            StringBuilder result = new StringBuilder(displayType).append('(');
            Object[] attributes = value.getAttributes();
            if (attributes != null) {
                for (int i = 0; i < attributes.length; i++) {
                    if (i > 0) {
                        result.append(", ");
                    }
                    Object attribute = attributes[i];
                    Object normalized = attribute instanceof Struct
                        ? normalizeStructuredValue((Struct) attribute, visited, depth + 1)
                        : JdbcExecutor.normalizeResultValue(attribute);
                    result.append(normalized);
                }
            }
            return result.append(')').toString();
        } finally {
            visited.remove(value);
        }
    }

    private static boolean isStructuredValue(int sqlType, String columnTypeName) {
        if (sqlType == Types.STRUCT) {
            return true;
        }
        if (columnTypeName == null) {
            return false;
        }
        String normalized = columnTypeName.trim().toUpperCase(Locale.ROOT);
        int qualifier = normalized.lastIndexOf('.');
        if (qualifier >= 0) {
            normalized = normalized.substring(qualifier + 1);
        }
        return "ST_GEOMETRY".equals(normalized);
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String normalizedObjectType = normalizeObjectSourceType(objectType);
        return unchecked(() -> {
            StringBuilder source = new StringBuilder();
            try (PreparedStatement statement = requireConnection().prepareStatement(OBJECT_SOURCE_SQL)) {
                statement.setString(1, schema);
                statement.setString(2, name);
                statement.setString(3, normalizedObjectType);
                try (ResultSet resultSet = statement.executeQuery()) {
                    while (resultSet.next()) {
                        String line = resultSet.getString(1);
                        if (line != null) {
                            source.append(line);
                        }
                    }
                }
            }
            return new ObjectSource(name, normalizedObjectType, schema, source.toString(), false);
        });
    }

    static String normalizeObjectSourceType(String objectType) {
        if (objectType == null) {
            throw new IllegalArgumentException("Unsupported object type: null");
        }
        String normalized = objectType.trim().toUpperCase(Locale.ROOT);
        if (!"FUNCTION".equals(normalized) && !"PROCEDURE".equals(normalized)) {
            throw new IllegalArgumentException("Unsupported object type: " + objectType);
        }
        return normalized;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(YashandbAgent::new).run();
    }
}
