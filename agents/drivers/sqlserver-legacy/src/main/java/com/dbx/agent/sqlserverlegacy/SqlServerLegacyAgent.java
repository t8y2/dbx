package com.dbx.agent.sqlserverlegacy;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DdlBuilder;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;

import java.security.Security;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
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

    public SqlServerLegacyAgent() {
        super(PROFILE);
        // AbstractJdbcAgent loads the JDBC driver before building the URL, so relax
        // the legacy TLS policy here before the driver can initialize JSSE.
        enableLegacyTlsAlgorithms();
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        return legacyTlsUrl(params);
    }

    @Override
    protected Connection openConnection(ConnectParams params) throws Exception {
        try {
            return super.openConnection(params);
        } catch (SQLException error) {
            throw withLegacyTlsDiagnostics(error);
        }
    }

    @Override
    public String getTableComment(String schema, String table) {
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
        properties.put("sslProtocol", "TLSv1");
        return appendProperties(baseJdbcUrl(params), properties);
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
        String disabledAlgorithms = Security.getProperty(TLS_DISABLED_ALGORITHMS_KEY);
        return "DBX SQL Server legacy TLS diagnostics: java=" + System.getProperty("java.version", "unknown")
            + ", javaVendor=" + System.getProperty("java.vendor", "unknown")
            + ", jdbc=" + jdbcDriverVersion()
            + ", sslProtocol=TLSv1"
            + ", tlsV1Disabled=" + isDisabled(disabledAlgorithms, "TLSV1")
            + ", tlsRsaDisabled=" + isDisabled(disabledAlgorithms, "TLS_RSA_*")
            + ", rsaPkcs1Sha1HandshakeDisabled="
            + isDisabled(disabledAlgorithms, "RSA_PKCS1_SHA1 USAGE HANDSHAKESIGNATURE")
            + ", 3desDisabled=" + isDisabled(disabledAlgorithms, "3DES_EDE_CBC")
            + ", rc4Disabled=" + isDisabled(disabledAlgorithms, "RC4");
    }

    static SQLException withLegacyTlsDiagnostics(SQLException error) {
        String message = error.getMessage() == null ? error.toString() : error.getMessage();
        return new SQLException(
            message + "\n\n" + legacyTlsDiagnostics(),
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
        String[] parts = trimmed.split(";");
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

        for (String pair : urlParams.trim().split("[&;]")) {
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
