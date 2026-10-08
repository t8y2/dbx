package com.dbx.agent.sqlserverlegacy;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.QueryResult;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DdlBuilder;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectSource;

import java.security.Security;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

public final class SqlServerLegacyAgent extends ConfiguredJdbcAgent {
    private static final String JTDS_DRIVER_CLASS = "net.sourceforge.jtds.jdbc.Driver";
    private static final String SQLSERVER_JDBC_PREFIX = "jdbc:sqlserver://";
    private static final String JTDS_JDBC_PREFIX = "jdbc:jtds:sqlserver://";
    private static final String TLS_DISABLED_ALGORITHMS_KEY = "jdk.tls.disabledAlgorithms";
    private static final Set<String> LEGACY_TLS_ALGORITHMS_TO_ALLOW = Set.of(
        "TLSV1",
        "TLSV1.1",
        "DTLSV1.0",
        "3DES_EDE_CBC",
        "RC4",
        "DES",
        "MD5WITHRSA",
        // Legacy SQL Server TLS 1.0 endpoints commonly rely on static RSA cipher
        // suites and RSA/SHA-1 handshake signatures disabled by newer JREs.
        "TLS_RSA_*",
        "RSA_PKCS1_SHA1 USAGE HANDSHAKESIGNATURE",
        "DH KEYSIZE < 1024",
        "RSA KEYSIZE < 1024"
    );
    private static final Set<String> INTERNAL_URL_PARAMS = Set.of(
        "SQLSERVERENCRYPTION",
        "ENCRYPT",
        "TRUSTSERVERCERTIFICATE",
        "SSLPROTOCOL"
    );
    private static final JdbcAgentProfile PROFILE = new JdbcAgentProfile(
        "com.microsoft.sqlserver.jdbc.SQLServerDriver",
        "jdbc:sqlserver://{host}:{port};databaseName={database};",
        1433,
        true,
        Set.of("INFORMATION_SCHEMA", "SYS"),
        Arrays.asList("TABLE", "VIEW", "SYSTEM TABLE")
    );
    private volatile boolean sqlServer2000Mode;
    private volatile boolean manualTransactionSession;
    private volatile boolean manualTransactionExecuted;

    public SqlServerLegacyAgent() {
        super(PROFILE);
        // AbstractJdbcAgent loads the JDBC driver before building the URL, so relax
        // the legacy TLS policy here before the driver can initialize JSSE.
        enableLegacyTlsAlgorithms();
    }

    @Override
    public Map<String, Object> beginManualTransaction(String schema) {
        Connection conn = getConnection();
        if (conn == null) throw new IllegalStateException("Not connected");
        // Metadata is advisory when an old JDBC driver cannot implement it.
        // A definitive false is different from an unavailable metadata method.
        return unchecked(() -> {
            java.sql.DatabaseMetaData metadata = null;
            boolean unsupported = false;
            try {
                metadata = conn.getMetaData();
                unsupported = !metadata.supportsTransactions();
            } catch (SQLException | AbstractMethodError unavailable) {
                // setAutoCommit is the authoritative operation in this case.
            }
            if (unsupported) throw new IllegalStateException("DBX_MANUAL_TRANSACTION_UNSUPPORTED: JDBC driver reports transactions are unsupported");
            if (!conn.getAutoCommit()) throw new IllegalStateException("Manual transaction already open");
            conn.setAutoCommit(false);
            manualTransactionSession = true;
            manualTransactionExecuted = false;
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("ok", true);
            result.put("manualTransactionBatch", true);
            if (metadata != null) {
                try {
                    result.put("productVersion", metadata.getDatabaseProductVersion());
                    result.put("productType", metadata.getDatabaseProductName());
                    result.put("driverName", metadata.getDriverName());
                    result.put("driverVersion", metadata.getDriverVersion());
                } catch (SQLException | AbstractMethodError unavailable) {
                    // Diagnostics must not turn a successful BEGIN into a failure.
                }
            }
            return result;
        });
    }

    @Override
    public Map<String, Object> commitManualTransaction() {
        Connection conn = getConnection();
        if (conn == null) throw new IllegalStateException("Not connected");
        return unchecked(() -> {
            if (conn.getAutoCommit()) throw new IllegalStateException("No manual transaction open");
            if (manualTransactionExecuted && transactionCount(conn, 30) != 1) throw new IllegalStateException("DBX_MANUAL_TRANSACTION_STATE_LOST: commit state cannot be confirmed");
            conn.commit();
            // This is a dedicated, terminal session. Do not setAutoCommit(true):
            // a failure in that cleanup must not obscure an acknowledged COMMIT.
            return Collections.singletonMap("ok", (Object) true);
        });
    }

    @Override
    public Map<String, Object> rollbackManualTransaction() {
        Connection conn = getConnection();
        if (conn == null) throw new IllegalStateException("Not connected");
        return unchecked(() -> {
            if (conn.getAutoCommit()) throw new IllegalStateException("No manual transaction open");
            if (manualTransactionExecuted && transactionCount(conn, 30) == 0) throw new IllegalStateException("DBX_MANUAL_TRANSACTION_STATE_LOST: transaction already ended; rollback cannot be confirmed");
            conn.rollback();
            return Collections.singletonMap("ok", (Object) true);
        });
    }

    @Override
    public boolean permitsAutomaticReconnect() {
        return !manualTransactionSession;
    }

    @Override
    public List<QueryResult> executeQueryResults(String sql, String schema, ExecuteQueryOptions options) {
        Connection conn = getConnection();
        if (!manualTransactionSession || conn == null) throw new IllegalStateException("No dedicated manual transaction connection");
        return unchecked(() -> {
            if (conn.getAutoCommit()) throw new IllegalStateException("DBX_MANUAL_TRANSACTION_STATE_LOST: autoCommit changed");
            beforeQueryExecution(conn, options.getTimeoutSecs());
            int before = transactionCount(conn, options.getTimeoutSecs());
            if (before == 0 && !manualTransactionExecuted) {
                // JDBC may defer its physical BEGIN. Open the DBX transaction before
                // the first user batch, including PRINT/read-only procedures. Explicit
                // BEGIN with IMPLICIT_TRANSACTIONS ON would open two transactions.
                JdbcExecutor.current().executeAll(conn, "SET IMPLICIT_TRANSACTIONS OFF; BEGIN TRANSACTION", 1, null,
                    options.getTimeoutSecs(), resultValueReader());
                before = transactionCount(conn, options.getTimeoutSecs());
            }
            if (before != 1) throw new IllegalStateException("DBX_MANUAL_TRANSACTION_STATE_LOST: transaction not active or nested");
            manualTransactionExecuted = true;
            List<QueryResult> results = JdbcExecutor.current().executeAll(conn, sql, options.getMaxRows(),
                options.getFetchSize(), options.getTimeoutSecs(), resultValueReader());
            int after = transactionCount(conn, options.getTimeoutSecs());
            if (after != 1) {
                throw new IllegalStateException("DBX_MANUAL_TRANSACTION_STATE_LOST: transaction ended or changed inside the batch");
            }
            return results;
        });
    }

    private static int transactionCount(Connection conn, int timeoutSecs) throws SQLException {
        try (java.sql.Statement stmt = conn.createStatement()) {
            stmt.setQueryTimeout(timeoutSecs > 0 ? timeoutSecs : 30);
            try (ResultSet rows = stmt.executeQuery("SELECT @@TRANCOUNT")) {
                if (!rows.next()) throw new SQLException("Missing SQL Server transaction status");
                int count = rows.getInt(1);
                while (rows.next()) { /* consume status response */ }
                return count;
            }
        }
    }

    @Override
    public boolean supportsConnectionPooling() {
        // The mssql-jdbc -> jTDS fallback is session state on this Agent
        // instance. A shared JDBC pool could hand a jTDS connection to another
        // session that still believes it is using mssql-jdbc, and SQL Server
        // 2000 is particularly prone to resetting those reused connections.
        return false;
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return sqlServer2000Mode ? jtdsUrl(params) : legacyTlsUrl(params);
    }

    @Override
    protected Connection openConnection(ConnectParams params) throws Exception {
        sqlServer2000Mode = false;
        logConnectionEvent("mssql-jdbc attempt", params, null);
        try {
            Connection connection = super.openConnection(params);
            sqlServer2000Mode = false;
            logConnectionEvent("mssql-jdbc connected", params, null);
            return connection;
        } catch (SQLException error) {
            logConnectionEvent("mssql-jdbc failed", params, error);
            if (shouldFallbackToJtds(error)) {
                logConnectionEvent("switching to jTDS 1.3.1 fallback", params, null);
                try {
                    super.loadDriver(jtdsDriverParams());
                    sqlServer2000Mode = true;
                    Connection connection = super.openConnection(params);
                    logConnectionEvent("jTDS 1.3.1 connected", params, null);
                    return connection;
                } catch (SQLException fallbackError) {
                    sqlServer2000Mode = false;
                    logConnectionEvent("jTDS 1.3.1 failed", params, fallbackError);
                    fallbackError.addSuppressed(error);
                    throw withLegacyTlsDiagnostics(fallbackError, "jTDS 1.3.1");
                } catch (Exception fallbackError) {
                    sqlServer2000Mode = false;
                    logConnectionEvent("jTDS 1.3.1 failed", params, fallbackError);
                    fallbackError.addSuppressed(error);
                    throw fallbackError;
                }
            }
            throw withLegacyTlsDiagnostics(error, jdbcDriverVersion(), requestedTlsProtocol(params));
        }
    }

    private static ConnectParams jtdsDriverParams() {
        ConnectParams params = new ConnectParams();
        params.setJdbc_driver_class(JTDS_DRIVER_CLASS);
        params.setJdbc_driver_paths(Collections.emptyList());
        return params;
    }

    @Override
    protected String connectionValidationQuery() {
        // jTDS can establish a SQL Server 2000 session but its JDBC 4
        // isValid() implementation is not reliable on this legacy endpoint.
        return "SELECT 1";
    }

    @Override
    protected boolean advancePastUpdateCounts() {
        return true;
    }

    @Override
    protected void afterDisconnect() {
        manualTransactionSession = false;
        manualTransactionExecuted = false;
        sqlServer2000Mode = false;
    }

    @Override
    protected Object resultValue(ResultSet resultSet, int index, int sqlType) {
        Object value = super.resultValue(resultSet, index, sqlType);
        return normalizeSqlServer2000ResultValue(value, sqlType, sqlServer2000Mode);
    }

    static Object normalizeSqlServer2000ResultValue(Object value, int sqlType, boolean sqlServer2000Mode) {
        if (!sqlServer2000Mode || !(value instanceof String) || !isCharacterType(sqlType)) {
            return value;
        }
        String text = (String) value;
        if (text.isEmpty()) {
            return text;
        }
        for (int index = 0; index < text.length(); index++) {
            if (text.charAt(index) != '\0') {
                return text;
            }
        }
        // jTDS can expose an empty SQL Server 2000 varchar as NUL padding up to
        // the declared column length. Keep SQL NULL and mixed binary-like text
        // distinct, but restore an all-NUL character value to the empty string.
        return "";
    }

    private static boolean isCharacterType(int sqlType) {
        return sqlType == Types.CHAR
            || sqlType == Types.VARCHAR
            || sqlType == Types.LONGVARCHAR
            || sqlType == Types.NCHAR
            || sqlType == Types.NVARCHAR
            || sqlType == Types.LONGNVARCHAR
            || sqlType == Types.CLOB
            || sqlType == Types.NCLOB;
    }

    private static void logConnectionEvent(String stage, ConnectParams params, Throwable error) {
        String detail = error == null ? "" : ", error=" + sanitizeDiagnostic(error.getClass().getSimpleName() + ": " + error.getMessage());
        System.err.println(
            "[sqlserver-legacy] " + stage
                + ", host=" + sanitizeDiagnostic(params.getHost())
                + ", port=" + params.getPort()
                + ", portExplicit=" + params.isPort_explicit()
                + ", database=" + sanitizeDiagnostic(params.getDatabase())
                + ", usernamePresent=" + (params.getUsername() != null && !params.getUsername().isBlank())
                + detail
        );
    }

    private static String sanitizeDiagnostic(String value) {
        if (value == null || value.isBlank()) {
            return "<empty>";
        }
        return value
            .replaceAll("(?i)(password|passwd|pwd)\\s*[=:]\\s*[^;,&\\s]+", "$1=<redacted>")
            .replace('\r', ' ')
            .replace('\n', ' ');
    }

    static boolean shouldFallbackToJtds(Throwable error) {
        Throwable current = error;
        while (current != null) {
            String message = current.getMessage();
            if (message != null) {
                String normalized = message.toLowerCase(Locale.ROOT);
                // mssql-jdbc rejects SQL Server 2000 (major version 8) during
                // prelogin with "SQL Server version 8 is not supported by
                // this driver." Localized messages can translate the version
                // and unsupported phrases, so accept those equivalent shapes.
                boolean version8Rejection = (normalized.contains("sql server 8")
                    || normalized.contains("sql server version 8")
                    || normalized.contains("sql server 版本 8"))
                    && (normalized.contains("not support")
                        || normalized.contains("不支持")
                        || normalized.contains("不支援"));
                // Other driver wordings name the supported floor instead. The
                // localized mssql-jdbc resource keeps "SQL Server 2005" in
                // English while translating the "or later" suffix.
                boolean floor2005Rejection = normalized.contains("sql server 2005 or later")
                    || (normalized.contains("sql server 2005") && normalized.contains("更高版本"));
                // Some SQL Server 2000 installations close the TDS 7.4
                // prelogin socket before mssql-jdbc can report the server
                // version. In legacy mode, retry that handshake once with
                // jTDS, which speaks the older protocol.
                boolean preloginRejection = normalized.contains("connection reset")
                    || normalized.contains("connection was reset")
                    || normalized.contains("forcibly closed")
                    || normalized.contains("意外的登录前响应")
                    || (normalized.contains("unexpected")
                        && (normalized.contains("prelogin") || normalized.contains("pre-login")));
                if (version8Rejection || floor2005Rejection || preloginRejection) {
                    return true;
                }
            }
            if (current instanceof SQLException) {
                SQLException next = ((SQLException) current).getNextException();
                if (next != null && next != current.getCause()) {
                    if (shouldFallbackToJtds(next)) {
                        return true;
                    }
                }
            }
            current = current.getCause();
        }
        return false;
    }

    static String jtdsUrl(ConnectParams params) {
        String explicit = params.getConnection_string() == null ? "" : params.getConnection_string().trim();
        if (explicit.toLowerCase(Locale.ROOT).startsWith(JTDS_JDBC_PREFIX)) {
            return appendProperties(trimSqlServerUrl(explicit), jtdsConnectionProperties(params));
        }

        String sqlServerUrl = baseJdbcUrl(params);
        String body = sqlServerUrl.substring(SQLSERVER_JDBC_PREFIX.length());
        String[] parts = body.split(";", -1);
        String authority = parts[0].trim();
        String database = "";
        for (int i = 1; i < parts.length; i++) {
            int separator = parts[i].indexOf('=');
            if (separator <= 0) {
                continue;
            }
            String key = parts[i].substring(0, separator).trim();
            if ("databaseName".equalsIgnoreCase(key)) {
                database = parts[i].substring(separator + 1).trim();
                break;
            }
        }

        StringBuilder url = new StringBuilder(JTDS_JDBC_PREFIX);
        String namedInstance = namedInstance(authority);
        if (namedInstance != null && !params.isPort_explicit()) {
            url.append(namedInstance.substring(0, namedInstance.indexOf('\\')));
        } else {
            url.append(authority);
        }
        if (database.length() > 0) {
            url.append('/').append(database);
        }
        if (namedInstance != null && !params.isPort_explicit()) {
            url.append(";instance=")
                .append(namedInstance.substring(namedInstance.indexOf('\\') + 1));
        }
        return appendProperties(url.toString(), jtdsConnectionProperties(params));
    }

    private static String namedInstance(String authority) {
        int separator = authority.indexOf('\\');
        if (separator <= 0 || separator >= authority.length() - 1) {
            return null;
        }
        return authority;
    }

    private static Map<String, String> jtdsConnectionProperties(ConnectParams params) {
        Map<String, String> properties = new LinkedHashMap<>();
        String urlParams = params.getUrl_params();
        if (urlParams == null || urlParams.trim().isEmpty()) {
            return properties;
        }
        for (String pair : connectionPropertyParts(urlParams.trim(), true)) {
            String value = pair.trim();
            int separator = value.indexOf('=');
            if (separator <= 0) {
                continue;
            }
            String key = value.substring(0, separator).trim();
            String property = value.substring(separator + 1).trim();
            if ("applicationName".equalsIgnoreCase(key)) {
                properties.put("appName", property);
            } else if ("ssl".equalsIgnoreCase(key)
                || "socketTimeout".equalsIgnoreCase(key)
                || "loginTimeout".equalsIgnoreCase(key)) {
                properties.put(key, property);
            }
        }
        return properties;
    }

    @Override
    public String getTableComment(String schema, String table) {
        if (sqlServer2000Mode) {
            return null;
        }
        return unchecked(() -> {
            try (PreparedStatement statement = requireConnection().prepareStatement(tableCommentSql())) {
                statement.setString(1, schema);
                statement.setString(2, table);
                try (ResultSet resultSet = statement.executeQuery()) {
                    if (resultSet.next()) {
                        String comment = resultSet.getString("table_comment");
                        return comment != null && !comment.trim().isEmpty() ? comment : null;
                    }
                }
            }
            return null;
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        String resolvedSchema = metadataSchema(schema, table);
        List<ColumnInfo> columns = super.getColumns(resolvedSchema, table);
        if (!sqlServer2000Mode || columns.isEmpty()) {
            return columns;
        }
        try {
            return mergeSqlServer2000ColumnComments(
                columns,
                readSqlServer2000ColumnComments(resolvedSchema, table)
            );
        } catch (SQLException | RuntimeException error) {
            // Comments are optional metadata. Keep the table usable when the
            // legacy catalog is unavailable or the account cannot read it.
            // Legacy drivers can also throw runtime errors from their catalog
            // code, mirroring the RuntimeException guards in getTableDdl.
            System.err.println(
                "[sqlserver-legacy] SQL Server 2000 column comments unavailable: "
                    + error.getClass().getName()
                    + ": "
                    + error.getMessage()
            );
            return columns;
        }
    }

    private Map<String, String> readSqlServer2000ColumnComments(String schema, String table) throws SQLException {
        try {
            return readColumnCommentsFromQuery(sqlServer2000ColumnCommentsSql(), schema, table);
        } catch (SQLException error) {
            System.err.println(
                "[sqlserver-legacy] SQL Server 2000 direct column comments query failed; trying compatibility function: "
                    + error.getMessage()
            );
            return readColumnCommentsFromQuery(sqlServer2000ColumnCommentsFunctionSql(), schema, table);
        }
    }

    private Map<String, String> readColumnCommentsFromQuery(String sql, String schema, String table) throws SQLException {
        Map<String, String> comments = new LinkedHashMap<>();
        try (PreparedStatement statement = requireConnection().prepareStatement(sql)) {
            statement.setString(1, schema);
            statement.setString(2, table);
            try (ResultSet resultSet = statement.executeQuery()) {
                while (resultSet.next()) {
                    String column = resultSet.getString("column_name");
                    String comment = resultSet.getString("column_comment");
                    if (column != null && comment != null && !comment.trim().isEmpty()) {
                        String key = column.trim().toLowerCase(Locale.ROOT);
                        String property = resultSet.getString("property_name");
                        if (!comments.containsKey(key) || "MS_Description".equalsIgnoreCase(property)) {
                            comments.put(key, comment);
                        }
                    }
                }
            }
        }
        return comments;
    }

    static List<ColumnInfo> mergeSqlServer2000ColumnComments(
        List<ColumnInfo> columns,
        Map<String, String> comments
    ) {
        if (comments.isEmpty()) {
            return columns;
        }
        Map<String, String> normalizedComments = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : comments.entrySet()) {
            if (entry.getKey() != null) {
                normalizedComments.put(entry.getKey().trim().toLowerCase(Locale.ROOT), entry.getValue());
            }
        }
        for (ColumnInfo column : columns) {
            String comment = normalizedComments.get(column.getName().trim().toLowerCase(Locale.ROOT));
            if (comment != null) {
                column.setComment(comment);
            }
        }
        return columns;
    }

    static String sqlServer2000ColumnCommentsSql() {
        return "SELECT c.name AS column_name, p.value AS column_comment, p.name AS property_name "
            + "FROM sysobjects o JOIN sysusers u ON o.uid = u.uid "
            + "JOIN syscolumns c ON c.id = o.id "
            + "LEFT OUTER JOIN sysproperties p ON p.id = o.id AND p.smallid = c.colid "
            + "WHERE u.name = ? AND o.name = ? AND o.xtype IN ('U', 'V') "
            + "AND p.value IS NOT NULL "
            + "ORDER BY c.colid, CASE WHEN p.name = 'MS_Description' THEN 0 ELSE 1 END";
    }

    static String sqlServer2000ColumnCommentsFunctionSql() {
        return "SELECT objname AS column_name, CONVERT(nvarchar(4000), value) AS column_comment, "
            + "'MS_Description' AS property_name "
            + "FROM ::fn_listextendedproperty('MS_Description', 'user', ?, 'table', ?, 'column', default)";
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        String resolvedSchema = metadataSchema(schema, table);
        List<IndexInfo> indexes = super.listIndexes(resolvedSchema, table);
        return markPrimaryKeyIndex(indexes, resolvedSchema, table);
    }

    // SQL Server names a primary-key index after its constraint (PK__<table>__<hex>
    // or a user-chosen name), so the shared JDBC metadata layer's "PRIMARY"
    // index-name convention never matches and is_primary stayed false. Resolve
    // the flag from DatabaseMetaData.getPrimaryKeys() PK_NAME instead, so table
    // cloning, the index tree badge, and DDL output see the real primary key.
    private List<IndexInfo> markPrimaryKeyIndex(List<IndexInfo> indexes, String schema, String table) {
        if (indexes.isEmpty()) {
            return indexes;
        }
        try {
            String primaryKeyName = null;
            try (java.sql.ResultSet rs = requireConnection().getMetaData().getPrimaryKeys(null, schema, table)) {
                if (rs.next()) {
                    primaryKeyName = rs.getString("PK_NAME");
                }
            }
            if (primaryKeyName == null || primaryKeyName.trim().isEmpty()) {
                return indexes;
            }
            for (IndexInfo index : indexes) {
                if (primaryKeyName.equals(index.getName())) {
                    index.setIs_primary(true);
                }
            }
        } catch (Exception ignored) {
            // Fail soft: keep the metadata-layer flags when primary-key lookup is unavailable.
        }
        return indexes;
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return super.listForeignKeys(metadataSchema(schema, table), table);
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String normalizedType = objectType == null ? "" : objectType.trim().toUpperCase(Locale.ROOT);
        String objectXtype = sqlServer2000ObjectXtype(normalizedType);
        if (objectXtype == null) {
            throw new IllegalArgumentException("Unsupported object type: " + objectType);
        }
        return unchecked(() -> {
            String resolvedSchema = metadataSchema(schema, name);
            StringBuilder source = new StringBuilder();
            try (PreparedStatement statement = requireConnection().prepareStatement(sqlServer2000ObjectSourceSql())) {
                statement.setString(1, resolvedSchema);
                statement.setString(2, name);
                statement.setString(3, objectXtype);
                try (ResultSet resultSet = statement.executeQuery()) {
                    while (resultSet.next()) {
                        String chunk = resultSet.getString("source_text");
                        if (chunk != null) {
                            source.append(chunk);
                        }
                    }
                }
            }
            // SQL Server 2000 exposes syscomments as source chunks. The legacy
            // editor is read-only because rewriting old procedure syntax safely
            // needs a separate DDL compatibility path.
            return new ObjectSource(name, objectType, resolvedSchema, source.toString(), false);
        });
    }

    static String sqlServer2000ObjectSourceSql() {
        return "SELECT c.text AS source_text FROM syscomments c "
            + "JOIN sysobjects o ON c.id = o.id "
            + "JOIN sysusers u ON o.uid = u.uid "
            + "WHERE u.name = ? AND o.name = ? AND o.xtype = ? "
            + "ORDER BY c.colid";
    }

    // sysobjects.xtype codes for the object kinds the object browser and the
    // tree both ask object source for: P = stored procedure, FN = scalar
    // function, V = view, TR = trigger. Views were missing, so "view DDL" on a
    // SQL Server legacy connection failed with "Unsupported object type: VIEW"
    // instead of returning the definition stored in syscomments (#10162).
    private static String sqlServer2000ObjectXtype(String objectType) {
        return switch (objectType) {
            case "PROCEDURE" -> "P";
            case "FUNCTION" -> "FN";
            case "VIEW" -> "V";
            case "TRIGGER" -> "TR";
            default -> null;
        };
    }

    private String metadataSchema(String schema, String table) {
        if (schema != null && !schema.trim().isEmpty()) {
            return schema;
        }
        return unchecked(() -> {
            String schemaSql = sqlServer2000Mode ? sqlServer2000ObjectSchemaSql() : unqualifiedObjectSchemaSql();
            try (PreparedStatement statement = requireConnection().prepareStatement(schemaSql)) {
                statement.setString(1, table);
                try (ResultSet resultSet = statement.executeQuery()) {
                    return normalizeMetadataSchema(schema, resultSet.next() ? resultSet.getString("schema_name") : null);
                }
            }
        });
    }

    static String unqualifiedObjectSchemaSql() {
        return "SELECT COALESCE(OBJECT_SCHEMA_NAME(OBJECT_ID(QUOTENAME(?))), "
            + "NULLIF(SCHEMA_NAME(), N''), N'dbo') AS schema_name";
    }

    static String sqlServer2000ObjectSchemaSql() {
        return "SELECT TOP 1 u.name AS schema_name FROM sysobjects o "
            + "JOIN sysusers u ON o.uid = u.uid "
            + "WHERE o.name = ? AND o.xtype IN ('U', 'V', 'P', 'FN', 'IF', 'TF') "
            + "ORDER BY CASE WHEN u.name = 'dbo' THEN 0 ELSE 1 END, u.name";
    }

    static String normalizeMetadataSchema(String schema, String defaultSchema) {
        if (schema != null && !schema.trim().isEmpty()) {
            return schema;
        }
        return defaultSchema == null || defaultSchema.trim().isEmpty() ? "dbo" : defaultSchema;
    }

    @Override
    public String getTableDdl(String schema, String table) {
        List<IndexInfo> indexes;
        try {
            indexes = listIndexes(schema, table);
        } catch (RuntimeException error) {
            indexes = Collections.emptyList();
        }

        List<ForeignKeyInfo> foreignKeys;
        try {
            foreignKeys = listForeignKeys(schema, table);
        } catch (RuntimeException error) {
            foreignKeys = Collections.emptyList();
        }

        String tableComment = null;
        try {
            tableComment = getTableComment(schema, table);
        } catch (RuntimeException error) {
            // Extended properties are optional; base DDL must remain available.
        }

        String ddl = DdlBuilder.buildTableDdl(
            schema,
            table,
            getColumns(schema, table),
            indexes,
            foreignKeys,
            Collections.emptyList(),
            false,
            false,
            null
        );
        return appendTableCommentDdl(ddl, schema, table, tableComment);
    }

    static String tableCommentSql() {
        return "SELECT CAST(ep.value AS nvarchar(max)) AS table_comment "
            + "FROM sys.extended_properties ep "
            + "JOIN sys.tables t ON t.object_id = ep.major_id "
            + "JOIN sys.schemas s ON s.schema_id = t.schema_id "
            + "WHERE ep.class = 1 AND ep.minor_id = 0 AND ep.name = N'MS_Description' "
            + "AND s.name = ? AND t.name = ?";
    }

    static String appendTableCommentDdl(String ddl, String schema, String table, String comment) {
        if (comment == null || comment.trim().isEmpty()) {
            return ddl;
        }
        return ddl
            + "\nEXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=" + sqlServerString(comment)
            + ", @level0type=N'SCHEMA', @level0name=" + sqlServerString(schema)
            + ", @level1type=N'TABLE', @level1name=" + sqlServerString(table) + ";";
    }

    private static String sqlServerString(String value) {
        return "N'" + value.replace("'", "''") + "'";
    }

    static String legacyTlsUrl(ConnectParams params) {
        Map<String, String> properties = baseConnectionProperties(params);
        properties.put("encrypt", "true");
        properties.put("trustServerCertificate", "true");
        properties.put("sslProtocol", requestedTlsProtocol(params));
        return appendProperties(baseJdbcUrl(params), properties);
    }

    private static String requestedTlsProtocol(ConnectParams params) {
        // Keep the legacy default for existing SQL Server 2000 connections, but
        // allow an explicit modern protocol when this driver is used on 2019/2022.
        String protocol = tlsProtocolProperty(params.getConnection_string(), "TLSv1", false);
        protocol = tlsProtocolProperty(params.getUrl_params(), protocol, true);
        switch (protocol.toUpperCase(Locale.ROOT)) {
            case "TLS": return "TLS";
            case "TLSV1": return "TLSv1";
            case "TLSV1.1": return "TLSv1.1";
            case "TLSV1.2": return "TLSv1.2";
            case "TLSV1.3": return "TLSv1.3";
            default: throw new IllegalArgumentException("Unsupported SQL Server sslProtocol; use TLS, TLSv1, TLSv1.1, TLSv1.2 or TLSv1.3");
        }
    }

    private static String tlsProtocolProperty(String properties, String fallback, boolean urlParams) {
        if (properties == null) return fallback;
        String protocol = fallback;
        for (String property : connectionPropertyParts(properties, urlParams)) {
            String part = property.trim();
            while (part.startsWith("?")) part = part.substring(1).trim();
            int separator = part.indexOf('=');
            if (separator > 0 && "sslProtocol".equalsIgnoreCase(part.substring(0, separator).trim())) {
                String value = part.substring(separator + 1).trim();
                protocol = value.startsWith("{") && value.endsWith("}")
                    ? value.substring(1, value.length() - 1).replace("}}", "}") : value;
            }
        }
        return protocol;
    }
    private static List<String> connectionPropertyParts(String value, boolean ampersandDelimiter) {
        List<String> parts = new ArrayList<>();
        int start = 0;
        boolean propertyValue = false;
        boolean valueStarted = false;
        boolean escaped = false;
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (escaped) {
                if (ch == '}') {
                    if (i + 1 < value.length() && value.charAt(i + 1) == '}') i++;
                    else escaped = false;
                }
                continue;
            }
            if (ch == ';' || (ampersandDelimiter && ch == '&')) {
                parts.add(value.substring(start, i));
                start = i + 1;
                propertyValue = false;
                valueStarted = false;
            } else if (!propertyValue && ch == '=') {
                propertyValue = true;
            } else if (propertyValue && !valueStarted && !Character.isWhitespace(ch)) {
                valueStarted = true;
                escaped = ch == '{';
            }
        }
        parts.add(value.substring(start));
        return parts;
    }
    static String relaxedDisabledAlgorithms(String current) {
        if (current == null || current.trim().isEmpty()) {
            return "";
        }

        List<String> kept = new ArrayList<>();
        for (String rawPart : current.split(",")) {
            String part = rawPart.trim();
            if (part.isEmpty()) {
                continue;
            }
            if (!LEGACY_TLS_ALGORITHMS_TO_ALLOW.contains(part.toUpperCase(Locale.ROOT))) {
                kept.add(part);
            }
        }
        return String.join(", ", kept);
    }

    static String legacyTlsDiagnostics() {
        return legacyTlsDiagnostics(jdbcDriverVersion(), "TLSv1");
    }

    private static String legacyTlsDiagnostics(String jdbcVersion, String protocol) {
        String disabledAlgorithms = Security.getProperty(TLS_DISABLED_ALGORITHMS_KEY);
        return "DBX SQL Server legacy TLS diagnostics: java=" + System.getProperty("java.version", "unknown")
            + ", javaVendor=" + System.getProperty("java.vendor", "unknown")
            + ", jdbc=" + jdbcVersion
            + ", sslProtocol=" + protocol
            + ", tlsV1Disabled=" + isDisabled(disabledAlgorithms, "TLSV1")
            + ", tlsRsaDisabled=" + isDisabled(disabledAlgorithms, "TLS_RSA_*")
            + ", rsaPkcs1Sha1HandshakeDisabled="
            + isDisabled(disabledAlgorithms, "RSA_PKCS1_SHA1 USAGE HANDSHAKESIGNATURE")
            + ", 3desDisabled=" + isDisabled(disabledAlgorithms, "3DES_EDE_CBC")
            + ", rc4Disabled=" + isDisabled(disabledAlgorithms, "RC4");
    }

    static SQLException withLegacyTlsDiagnostics(SQLException error) {
        return withLegacyTlsDiagnostics(error, jdbcDriverVersion());
    }

    static SQLException withLegacyTlsDiagnostics(SQLException error, String jdbcVersion) {
        return withLegacyTlsDiagnostics(error, jdbcVersion, "TLSv1");
    }

    static SQLException withLegacyTlsDiagnostics(SQLException error, String jdbcVersion, String protocol) {
        String message = error.getMessage() == null ? error.toString() : error.getMessage();
        return new SQLException(
            message + "\n\n" + legacyTlsDiagnostics(jdbcVersion, protocol),
            error.getSQLState(),
            error.getErrorCode(),
            error
        );
    }

    private static boolean isDisabled(String disabledAlgorithms, String algorithm) {
        if (disabledAlgorithms == null || disabledAlgorithms.trim().isEmpty()) {
            return false;
        }
        for (String rawPart : disabledAlgorithms.split(",")) {
            if (algorithm.equals(rawPart.trim().toUpperCase(Locale.ROOT))) {
                return true;
            }
        }
        return false;
    }

    private static String jdbcDriverVersion() {
        try {
            Driver driver = DriverManager.getDriver("jdbc:sqlserver://localhost");
            Package driverPackage = driver.getClass().getPackage();
            String implementationVersion = driverPackage == null ? null : driverPackage.getImplementationVersion();
            if (implementationVersion != null && !implementationVersion.trim().isEmpty()) {
                return implementationVersion;
            }
            return driver.getMajorVersion() + "." + driver.getMinorVersion();
        } catch (SQLException ignored) {
            return "unknown";
        }
    }

    private static void enableLegacyTlsAlgorithms() {
        String current = Security.getProperty(TLS_DISABLED_ALGORITHMS_KEY);
        String relaxed = relaxedDisabledAlgorithms(current);
        if (!Objects.equals(current, relaxed)) {
            Security.setProperty(TLS_DISABLED_ALGORITHMS_KEY, relaxed);
        }
    }

    private static String baseJdbcUrl(ConnectParams params) {
        String connectionString = params.getConnection_string();
        if (connectionString != null && !connectionString.trim().isEmpty()) {
            return sanitizeSqlServerUrl(connectionString.trim());
        }

        String host = normalizedSqlServerHost(params.getHost());
        boolean usesNamedInstance = usesNamedInstance(host, params.getPort(), params.isPort_explicit());
        StringBuilder url = new StringBuilder("jdbc:sqlserver://")
            .append(usesNamedInstance ? host : serverHost(host));
        if (!usesNamedInstance) {
            int port = params.getPort() > 0 ? params.getPort() : PROFILE.getDefaultPort();
            url.append(":").append(port);
        }
        if (params.getDatabase() != null && !params.getDatabase().trim().isEmpty()) {
            url.append(";databaseName=").append(params.getDatabase().trim());
        }
        return trimSqlServerUrl(url.toString());
    }

    private static String normalizedSqlServerHost(String value) {
        String host = value == null ? "" : value.trim();
        int separator = host.indexOf('\\');
        if (separator <= 0 || separator >= host.length() - 1) {
            return host;
        }

        String server = host.substring(0, separator).trim();
        String instance = host.substring(separator + 1).trim();
        if (server.isEmpty() || instance.isEmpty()) {
            return host;
        }
        return server + "\\" + instance;
    }

    private static boolean usesNamedInstance(String host, int port, boolean portExplicit) {
        int separator = host.indexOf('\\');
        return separator > 0 && separator < host.length() - 1 && (port <= 0 || (port == PROFILE.getDefaultPort() && !portExplicit));
    }

    private static String serverHost(String host) {
        int separator = host.indexOf('\\');
        if (separator > 0 && separator < host.length() - 1) {
            return host.substring(0, separator).trim();
        }
        return host;
    }

    private static String sanitizeSqlServerUrl(String value) {
        String trimmed = trimSqlServerUrl(value);
        String[] parts = connectionPropertyParts(trimmed, false).toArray(new String[0]);
        if (parts.length <= 1) {
            return trimmed;
        }
        StringBuilder result = new StringBuilder(parts[0].trim());
        for (int i = 1; i < parts.length; i++) {
            String part = parts[i].trim();
            if (part.isEmpty()) {
                continue;
            }
            int separator = part.indexOf('=');
            if (separator <= 0) {
                result.append(";").append(part);
                continue;
            }
            String key = part.substring(0, separator).trim();
            if (!INTERNAL_URL_PARAMS.contains(key.toUpperCase(Locale.ROOT))) {
                result.append(";").append(part);
            }
        }
        return result.toString();
    }

    private static Map<String, String> baseConnectionProperties(ConnectParams params) {
        Map<String, String> properties = new LinkedHashMap<>();
        String urlParams = params.getUrl_params();
        if (urlParams == null || urlParams.trim().isEmpty()) {
            return properties;
        }

        for (String pair : connectionPropertyParts(urlParams.trim(), true)) {
            String value = pair.trim();
            while (value.startsWith("?") || value.startsWith("&") || value.startsWith(";")) {
                value = value.substring(1).trim();
            }
            if (value.isEmpty()) {
                continue;
            }
            int separator = value.indexOf('=');
            if (separator <= 0) {
                continue;
            }
            String key = value.substring(0, separator).trim();
            String normalizedKey = key.toUpperCase(Locale.ROOT);
            if (key.isEmpty() || INTERNAL_URL_PARAMS.contains(normalizedKey)) {
                continue;
            }
            properties.put(key, value.substring(separator + 1).trim());
        }
        return properties;
    }

    private static String appendProperties(String base, Map<String, String> properties) {
        StringBuilder url = new StringBuilder(trimSqlServerUrl(base));
        for (Map.Entry<String, String> entry : properties.entrySet()) {
            url.append(";").append(entry.getKey()).append("=").append(entry.getValue());
        }
        return url.toString();
    }

    private static String trimSqlServerUrl(String value) {
        String trimmed = value.trim();
        while (trimmed.endsWith(";") || trimmed.endsWith("&") || trimmed.endsWith("?")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1).trim();
        }
        return trimmed;
    }

    public static void main(String[] args) throws Exception {
        new MultiSessionJsonRpcServer(SqlServerLegacyAgent::new).run();
    }
}
