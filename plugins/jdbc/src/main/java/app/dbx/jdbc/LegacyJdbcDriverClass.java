package app.dbx.jdbc;

final class LegacyJdbcDriverClass {
    private LegacyJdbcDriverClass() {}

    static Class<?> load(String driverClass, String jdbcUrl, ClassLoader loader) throws ClassNotFoundException {
        try {
            return Class.forName(driverClass, true, loader);
        } catch (ClassNotFoundException error) {
            if (!driverClass.equals(error.getMessage()) || error.getCause() != null || jdbcUrl == null) {
                throw error;
            }
            String resolved = switch (driverClass) {
                case "teradata" -> hasUrlPrefix(jdbcUrl, "jdbc:teradata://") ? "com.teradata.jdbc.TeraDriver" : null;
                case "db2" -> hasUrlPrefix(jdbcUrl, "jdbc:db2:") ? "com.ibm.db2.jcc.DB2Driver" : null;
                case "h2_embedded", "h2_embedded_v2" -> hasUrlPrefix(jdbcUrl, "jdbc:h2:") ? "org.h2.Driver" : null;
                default -> null;
            };
            if (resolved == null) {
                throw error;
            }
            return Class.forName(resolved, true, loader);
        }
    }

    private static boolean hasUrlPrefix(String url, String prefix) {
        return url.startsWith(prefix) && url.length() > prefix.length();
    }
}
