package com.dbx.agent;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.SQLException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

final class JdbcDatabaseInfo {
    private JdbcDatabaseInfo() {
    }

    static Map<String, String> from(Connection connection) {
        if (connection == null) {
            return Collections.emptyMap();
        }

        final DatabaseMetaData metadata;
        try {
            metadata = connection.getMetaData();
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            return Collections.emptyMap();
        }
        if (metadata == null) {
            return Collections.emptyMap();
        }

        Map<String, String> info = new LinkedHashMap<>();
        putText(info, "productName", () -> metadata.getDatabaseProductName());
        putText(info, "productVersion", () -> metadata.getDatabaseProductVersion());
        putIdentifierCase(
            info,
            "unquotedIdentifierCase",
            () -> metadata.storesLowerCaseIdentifiers(),
            () -> metadata.storesUpperCaseIdentifiers(),
            () -> metadata.storesMixedCaseIdentifiers()
        );
        putIdentifierCase(
            info,
            "quotedIdentifierCase",
            () -> metadata.storesLowerCaseQuotedIdentifiers(),
            () -> metadata.storesUpperCaseQuotedIdentifiers(),
            () -> metadata.storesMixedCaseQuotedIdentifiers()
        );
        putText(info, "driverName", () -> metadata.getDriverName());
        putText(info, "driverVersion", () -> metadata.getDriverVersion());

        Integer jdbcMajor = readInteger(() -> metadata.getJDBCMajorVersion());
        Integer jdbcMinor = readInteger(() -> metadata.getJDBCMinorVersion());
        if (jdbcMajor != null && jdbcMinor != null && jdbcMajor >= 0 && jdbcMinor >= 0) {
            info.put("jdbcVersion", jdbcMajor + "." + jdbcMinor);
        }
        return info;
    }

    private static void putText(Map<String, String> target, String key, SqlSupplier<String> supplier) {
        String value = read(supplier);
        if (value != null && !value.trim().isEmpty()) {
            target.put(key, value.trim());
        }
    }

    private static void putIdentifierCase(
        Map<String, String> target,
        String key,
        SqlSupplier<Boolean> lower,
        SqlSupplier<Boolean> upper,
        SqlSupplier<Boolean> mixed
    ) {
        if (Boolean.TRUE.equals(read(lower))) {
            target.put(key, "lower");
        } else if (Boolean.TRUE.equals(read(upper))) {
            target.put(key, "upper");
        } else if (Boolean.TRUE.equals(read(mixed))) {
            target.put(key, "mixed");
        }
    }

    private static Integer readInteger(SqlSupplier<Integer> supplier) {
        return read(supplier);
    }

    private static <T> T read(SqlSupplier<T> supplier) {
        try {
            return supplier.get();
        } catch (SQLException | AbstractMethodError | UnsupportedOperationException ignored) {
            return null;
        }
    }

    private interface SqlSupplier<T> {
        T get() throws SQLException;
    }
}
