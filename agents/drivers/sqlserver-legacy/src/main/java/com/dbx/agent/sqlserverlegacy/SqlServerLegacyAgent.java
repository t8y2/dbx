package com.dbx.agent.sqlserverlegacy;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.JsonRpcServer;

import java.security.Security;
import java.util.ArrayList;
import java.util.Arrays;
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
    }

    @Override
    protected String buildJdbcUrl(ConnectParams params) {
        enableLegacyTlsAlgorithms();
        return legacyTlsUrl(params);
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
        StringBuilder url = new StringBuilder("jdbc:sqlserver://")
            .append(host);
        if (!usesNamedInstance(host)) {
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

    private static boolean usesNamedInstance(String host) {
        int separator = host.indexOf('\\');
        return separator > 0 && separator < host.length() - 1;
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
        new JsonRpcServer(new SqlServerLegacyAgent()).run();
    }
}
