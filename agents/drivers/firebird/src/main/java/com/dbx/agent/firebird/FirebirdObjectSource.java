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
        String targetName = name != null ? name.trim() : "";
        if (targetName.startsWith("\"") && targetName.endsWith("\"") && targetName.length() > 1) {
            targetName = targetName.substring(1, targetName.length() - 1);
        }
        String sql = switch (type) {
            case "FUNCTION" -> "SELECT RDB$FUNCTION_SOURCE, RDB$MODULE_NAME, RDB$ENTRYPOINT, RDB$ENGINE_NAME FROM RDB$FUNCTIONS WHERE CASE WHEN RDB$PACKAGE_NAME IS NULL THEN TRIM(RDB$FUNCTION_NAME) ELSE TRIM(RDB$PACKAGE_NAME) || '.' || TRIM(RDB$FUNCTION_NAME) END = ?";
            case "TRIGGER" -> "SELECT RDB$TRIGGER_SOURCE, TRIM(RDB$RELATION_NAME), RDB$TRIGGER_TYPE, RDB$TRIGGER_SEQUENCE, RDB$TRIGGER_INACTIVE FROM RDB$TRIGGERS WHERE (TRIM(RDB$TRIGGER_NAME) = ? OR TRIM(RDB$TRIGGER_NAME) = UPPER(?))";
            case "PACKAGE", "PACKAGE_BODY" -> "SELECT RDB$PACKAGE_HEADER_SOURCE, RDB$PACKAGE_BODY_SOURCE FROM RDB$PACKAGES WHERE (TRIM(RDB$PACKAGE_NAME) = ? OR TRIM(RDB$PACKAGE_NAME) = UPPER(?))";
            case "SEQUENCE" -> "SELECT RDB$GENERATOR_NAME, RDB$INITIAL_VALUE, RDB$GENERATOR_INCREMENT FROM RDB$GENERATORS WHERE RDB$GENERATOR_NAME = ?";
            case "VIEW" -> "SELECT RDB$VIEW_SOURCE FROM RDB$RELATIONS WHERE (TRIM(RDB$RELATION_NAME) = ? OR TRIM(RDB$RELATION_NAME) = UPPER(?)) AND RDB$VIEW_BLR IS NOT NULL";
            default -> throw new IllegalArgumentException("Unsupported Firebird object type: " + type);
        };
        boolean legacy = connection.getMetaData().getDatabaseMajorVersion() < 3;
        if (legacy && "FUNCTION".equals(type)) {
            sql = "SELECT CAST(NULL AS VARCHAR(1)), RDB$MODULE_NAME, RDB$ENTRYPOINT, CAST(NULL AS VARCHAR(1)) FROM RDB$FUNCTIONS WHERE (TRIM(RDB$FUNCTION_NAME) = ? OR TRIM(RDB$FUNCTION_NAME) = UPPER(?))";
        } else if (legacy && "SEQUENCE".equals(type)) {
            sql = "SELECT RDB$GENERATOR_NAME, 0, 1 FROM RDB$GENERATORS WHERE RDB$GENERATOR_NAME = ?";
        }
        String source = "";
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setString(1, targetName);
            if (sql.contains("UPPER(?)")) {
                statement.setString(2, targetName);
            }
            try (ResultSet result = statement.executeQuery()) {
                if (result.next()) {
                    String quoted = "\"" + targetName.replace("\"", "\"\"") + "\"";
                    source = switch (type) {
                        case "FUNCTION" -> functionSource(result, decode);
                        case "TRIGGER" -> triggerSource(result, targetName, decode);
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
        return new ObjectSource(targetName, type, schema, source, false);
    }

    private static String triggerSource(ResultSet result, String name, UnaryOperator<String> decode) throws SQLException {
        String relation = result.getString(2);
        int type = result.getInt(3);
        int position = result.getInt(4);
        int inactive = result.getInt(5);
        String body = text(decode.apply(result.getString(1)));
        String rel = relation != null ? relation.trim() : "";
        String trimmedBody = body.stripLeading();
        if ((trimmedBody.regionMatches(true, 0, "CREATE", 0, 6) && (trimmedBody.length() == 6 || Character.isWhitespace(trimmedBody.charAt(6))))
            || (trimmedBody.regionMatches(true, 0, "ALTER", 0, 5) && (trimmedBody.length() == 5 || Character.isWhitespace(trimmedBody.charAt(5))))) {
            return body;
        }
        String quoted = "\"" + name.replace("\"", "\"\"") + "\"";
        StringBuilder ddl = new StringBuilder("CREATE OR ALTER TRIGGER ").append(quoted);
        if (!rel.isEmpty()) {
            ddl.append(" FOR \"").append(rel.replace("\"", "\"\"")).append("\"");
        }
        ddl.append(inactive == 1 ? " INACTIVE\n" : " ACTIVE\n");
        if (type >= 8192) {
            ddl.append("ON ").append(FirebirdAgent.triggerEvent(type));
        } else {
            String timing = (type % 2 == 1) ? "BEFORE" : "AFTER";
            String event = FirebirdAgent.triggerEvent(type);
            ddl.append(timing).append(" ").append(event);
        }
        if (position > 0) {
            ddl.append(" POSITION ").append(position);
        }
        ddl.append("\n");
        if (trimmedBody.regionMatches(true, 0, "AS", 0, 2) && (trimmedBody.length() == 2 || Character.isWhitespace(trimmedBody.charAt(2)))) {
            ddl.append(trimmedBody);
        } else if (!trimmedBody.isEmpty()) {
            ddl.append("AS\n").append(trimmedBody);
        } else {
            ddl.append("AS\nBEGIN\nEND");
        }
        return ddl.toString().stripTrailing();
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
