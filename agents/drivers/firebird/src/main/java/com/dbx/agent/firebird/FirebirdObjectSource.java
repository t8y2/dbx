package com.dbx.agent.firebird;

import com.dbx.agent.ObjectSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.function.UnaryOperator;

/** Read-only catalog source: stored routine bodies are never advertised as executable DDL. */
final class FirebirdObjectSource {
    static ObjectSource read(Connection connection, String schema, String name, String type,
                             UnaryOperator<String> decode) throws SQLException {
        String sql = switch (type) {
            case "FUNCTION" -> "SELECT RDB$FUNCTION_SOURCE, RDB$MODULE_NAME, RDB$ENTRYPOINT, RDB$ENGINE_NAME FROM RDB$FUNCTIONS WHERE CASE WHEN RDB$PACKAGE_NAME IS NULL THEN TRIM(RDB$FUNCTION_NAME) ELSE TRIM(RDB$PACKAGE_NAME) || '.' || TRIM(RDB$FUNCTION_NAME) END = ?";
            case "TRIGGER" -> "SELECT RDB$TRIGGER_SOURCE, RDB$RELATION_NAME, RDB$TRIGGER_TYPE, RDB$TRIGGER_SEQUENCE, RDB$TRIGGER_INACTIVE FROM RDB$TRIGGERS WHERE RDB$TRIGGER_NAME = ?";
            case "PACKAGE", "PACKAGE_BODY" -> "SELECT RDB$PACKAGE_HEADER_SOURCE, RDB$PACKAGE_BODY_SOURCE FROM RDB$PACKAGES WHERE RDB$PACKAGE_NAME = ?";
            case "SEQUENCE" -> "SELECT RDB$GENERATOR_NAME, RDB$INITIAL_VALUE, RDB$GENERATOR_INCREMENT FROM RDB$GENERATORS WHERE RDB$GENERATOR_NAME = ?";
            case "VIEW" -> "SELECT RDB$VIEW_SOURCE FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = ? AND RDB$VIEW_BLR IS NOT NULL";
            default -> throw new IllegalArgumentException("Unsupported Firebird object type: " + type);
        };
        boolean legacy = connection.getMetaData().getDatabaseMajorVersion() < 3;
        if (legacy && "FUNCTION".equals(type)) {
            sql = "SELECT CAST(NULL AS VARCHAR(1)), RDB$MODULE_NAME, RDB$ENTRYPOINT, CAST(NULL AS VARCHAR(1)) FROM RDB$FUNCTIONS WHERE RDB$FUNCTION_NAME = ?";
        } else if (legacy && "SEQUENCE".equals(type)) {
            sql = "SELECT RDB$GENERATOR_NAME, 0, 1 FROM RDB$GENERATORS WHERE RDB$GENERATOR_NAME = ?";
        }
        String source = "";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, name);
            try (ResultSet result = statement.executeQuery()) {
                if (result.next()) {
                    String quoted = "\"" + name.replace("\"", "\"\"") + "\"";
                    source = switch (type) {
                        case "FUNCTION" -> functionSource(result, decode);
                        case "TRIGGER" -> "-- Trigger: " + name + "\n-- Relation: " + result.getString(2)
                            + "\n-- Type: " + result.getInt(3) + ", position: " + result.getInt(4)
                            + ", inactive: " + result.getInt(5) + "\n" + text(decode.apply(result.getString(1)));
                        case "PACKAGE", "PACKAGE_BODY" -> packageSource(result, quoted, decode);
                        case "SEQUENCE" -> legacy ? "-- Generator: " + quoted
                            : "CREATE SEQUENCE " + quoted + " START WITH " + result.getLong(2)
                                + " INCREMENT BY " + result.getLong(3) + ";";
                        case "VIEW" -> "-- Stored view query\n" + text(decode.apply(result.getString(1)));
                        default -> "";
                    };
                }
            }
        }
        return new ObjectSource(name, type, schema, source, false);
    }

    private static String functionSource(ResultSet result, UnaryOperator<String> decode) throws SQLException {
        String body = decode.apply(result.getString(1));
        if (body != null && !body.isBlank()) return "-- Stored function body\n" + body;
        if (text(result.getString(2)).isBlank() && text(result.getString(4)).isBlank()) {
            return "-- No stored function body is available.";
        }
        return "-- External function\n-- Module: " + text(result.getString(2))
            + "\n-- Entry point: " + text(result.getString(3))
            + "\n-- Engine: " + text(result.getString(4));
    }

    private static String packageSource(ResultSet result, String name, UnaryOperator<String> decode) throws SQLException {
        String header = decode.apply(result.getString(1));
        String body = decode.apply(result.getString(2));
        return "CREATE OR ALTER PACKAGE " + name + " AS\n" + text(header)
            + (body == null ? "" : "\n\nCREATE OR ALTER PACKAGE BODY " + name + " AS\n" + body);
    }

    private static String text(String value) {
        return value == null ? "" : value.stripTrailing();
    }
}
