package com.dbx.agent.oceanbaseoracle;

import java.math.BigInteger;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;

/** Dictionary-backed DDL for objects not consistently covered by OB GET_DDL. */
final class OceanBaseSchemaObjects {
    private OceanBaseSchemaObjects() {}

    static String synonymSource(Connection connection, String owner, String name) throws SQLException {
        String sql = "SELECT TABLE_OWNER, TABLE_NAME, DB_LINK FROM ALL_SYNONYMS WHERE OWNER = ? AND SYNONYM_NAME = ?";
        try (var statement = connection.prepareStatement(sql)) {
            statement.setString(1, owner);
            statement.setString(2, name);
            try (var rs = statement.executeQuery()) {
                if (!rs.next()) return null;
                String targetOwner = rs.getString("TABLE_OWNER");
                String target = quote(rs.getString("TABLE_NAME"));
                if (targetOwner != null && !targetOwner.isEmpty()) target = quote(targetOwner) + "." + target;
                String link = rs.getString("DB_LINK");
                if (link != null && !link.isEmpty()) {
                    // A link's domain is part of its name, not a schema qualifier.
                    if (!link.matches("[A-Za-z][A-Za-z0-9_$#]*(?:\\.[A-Za-z0-9_$#]+)*") || link.length() > 128) {
                        throw new SQLException("Unsupported database link identifier in synonym metadata");
                    }
                    target += "@" + link;
                }
                String declaration = "PUBLIC".equals(owner) ? "PUBLIC SYNONYM " + quote(name)
                    : "SYNONYM " + quote(owner) + "." + quote(name);
                return "CREATE OR REPLACE " + declaration + " FOR " + target + ";";
            }
        }
    }

    static String sequenceSource(Connection connection, String owner, String name) throws SQLException {
        String sql = "SELECT MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, ORDER_FLAG, CACHE_SIZE, LAST_NUMBER "
            + "FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = ? AND SEQUENCE_NAME = ?";
        try (var statement = connection.prepareStatement(sql)) {
            statement.setString(1, owner);
            statement.setString(2, name);
            try (var rs = statement.executeQuery()) {
                if (!rs.next()) return null;
                // LAST_NUMBER is the dictionary/cache boundary, not session CURRVAL.
                // Never consume NEXTVAL while displaying or editing a sequence.
                String cache = integer(rs, "CACHE_SIZE");
                return "CREATE SEQUENCE " + quote(owner) + "." + quote(name)
                    + "\n  MINVALUE " + integer(rs, "MIN_VALUE")
                    + "\n  MAXVALUE " + integer(rs, "MAX_VALUE")
                    + "\n  INCREMENT BY " + integer(rs, "INCREMENT_BY")
                    + "\n  START WITH " + integer(rs, "LAST_NUMBER")
                    + "\n  " + ("0".equals(cache) ? "NOCACHE" : "CACHE " + cache)
                    + "\n  " + flag(rs, "CYCLE_FLAG", "CYCLE", "NOCYCLE")
                    + "\n  " + flag(rs, "ORDER_FLAG", "ORDER", "NOORDER") + ";";
            }
        }
    }

    private static String integer(ResultSet rs, String column) throws SQLException {
        String value = rs.getString(column);
        if (value == null || !value.matches("[+-]?[0-9]+")) throw new SQLException("Invalid sequence metadata: " + column);
        return new BigInteger(value).toString();
    }

    private static String flag(ResultSet rs, String column, String yes, String no) throws SQLException {
        String value = rs.getString(column);
        if ("Y".equals(value)) return yes;
        if ("N".equals(value)) return no;
        throw new SQLException("Invalid sequence metadata: " + column);
    }

    private static String quote(String name) throws SQLException {
        if (name == null || name.isEmpty() || name.indexOf('\0') >= 0) throw new SQLException("Missing object identifier");
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }
}
