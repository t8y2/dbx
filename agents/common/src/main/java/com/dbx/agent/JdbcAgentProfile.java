package com.dbx.agent;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Set;

public class JdbcAgentProfile {
    private final String driverClass;
    private final String urlTemplate;
    private final int defaultPort;
    private final boolean skipExecutionContext;
    private final Set<String> excludedSchemas;
    private final List<String> tableTypes;
    private final String identifierQuote;
    private final String schemaSwitchPrefix;
    private final boolean catalogFallbackEnabled;
    private final boolean nativeTableDdlSupported;
    private final boolean objectSourceSupported;
    private final boolean triggersSupported;

    public JdbcAgentProfile(String driverClass, String urlTemplate) {
        this(driverClass, urlTemplate, 0);
    }

    public JdbcAgentProfile(String driverClass, String urlTemplate, int defaultPort) {
        this(driverClass, urlTemplate, defaultPort, false);
    }

    public JdbcAgentProfile(String driverClass, String urlTemplate, int defaultPort, boolean skipExecutionContext) {
        this(
            driverClass,
            urlTemplate,
            defaultPort,
            skipExecutionContext,
            Collections.emptySet(),
            Arrays.asList("TABLE", "VIEW", "BASE TABLE", "MATERIALIZED VIEW", "SYSTEM TABLE", "SYSTEM VIEW")
        );
    }

    public JdbcAgentProfile(
        String driverClass,
        String urlTemplate,
        int defaultPort,
        boolean skipExecutionContext,
        Set<String> excludedSchemas,
        List<String> tableTypes
    ) {
        this(
            driverClass,
            urlTemplate,
            defaultPort,
            skipExecutionContext,
            excludedSchemas,
            tableTypes,
            "\"",
            "SET SCHEMA",
            true,
            false,
            false,
            false
        );
    }

    public JdbcAgentProfile(
        String driverClass,
        String urlTemplate,
        int defaultPort,
        boolean skipExecutionContext,
        Set<String> excludedSchemas,
        List<String> tableTypes,
        String identifierQuote,
        String schemaSwitchPrefix,
        boolean catalogFallbackEnabled,
        boolean nativeTableDdlSupported,
        boolean objectSourceSupported,
        boolean triggersSupported
    ) {
        this.driverClass = driverClass;
        this.urlTemplate = urlTemplate;
        this.defaultPort = defaultPort;
        this.skipExecutionContext = skipExecutionContext;
        this.excludedSchemas = excludedSchemas;
        this.tableTypes = tableTypes;
        this.identifierQuote = identifierQuote;
        this.schemaSwitchPrefix = schemaSwitchPrefix;
        this.catalogFallbackEnabled = catalogFallbackEnabled;
        this.nativeTableDdlSupported = nativeTableDdlSupported;
        this.objectSourceSupported = objectSourceSupported;
        this.triggersSupported = triggersSupported;
    }

    public String getDriverClass() {
        return driverClass;
    }

    public String getUrlTemplate() {
        return urlTemplate;
    }

    public int getDefaultPort() {
        return defaultPort;
    }

    public boolean getSkipExecutionContext() {
        return skipExecutionContext;
    }

    public Set<String> getExcludedSchemas() {
        return excludedSchemas;
    }

    public List<String> getTableTypes() {
        return tableTypes;
    }

    public String getIdentifierQuote() {
        return identifierQuote;
    }

    public String getSchemaSwitchPrefix() {
        return schemaSwitchPrefix;
    }

    public boolean getCatalogFallbackEnabled() {
        return catalogFallbackEnabled;
    }

    public boolean getNativeTableDdlSupported() {
        return nativeTableDdlSupported;
    }

    public boolean getObjectSourceSupported() {
        return objectSourceSupported;
    }

    public boolean getTriggersSupported() {
        return triggersSupported;
    }

    public String buildUrl(ConnectParams params) {
        if (!params.getConnection_string().trim().isEmpty()) {
            return params.getConnection_string();
        }
        int port = params.getPort() > 0 ? params.getPort() : defaultPort;
        String base = urlTemplate
            .replace("{host}", params.getHost())
            .replace("{port}", Integer.toString(port))
            .replace("{database}", params.getDatabase());
        return appendUrlParams(base, params.getUrl_params());
    }

    public String quoteIdentifier(String identifier) {
        return identifierQuote + identifier.replace(identifierQuote, identifierQuote + identifierQuote) + identifierQuote;
    }

    public String schemaSwitchSql(String schema) {
        return schemaSwitchSql(schema, identifierQuote);
    }

    public String schemaSwitchSql(String schema, String quote) {
        if (skipExecutionContext) {
            return "";
        }
        return schemaSwitchPrefix + " " + quote + schema.replace(quote, quote + quote) + quote;
    }

    private static String appendUrlParams(String url, String urlParams) {
        String params = trimUrlParams(urlParams);
        if (params.isEmpty()) {
            return url;
        }
        if (usesColonProperties(url) && !params.endsWith(";")) {
            params = params + ";";
        }
        String separator = urlParamSeparator(url);
        return url + separator + params;
    }

    private static String trimUrlParams(String urlParams) {
        String value = urlParams == null ? "" : urlParams.trim();
        while (value.startsWith("?") || value.startsWith("&") || value.startsWith(";") || value.startsWith(":") || value.startsWith(",")) {
            value = value.substring(1);
        }
        return value;
    }

    private static String urlParamSeparator(String url) {
        if (startsWithIgnoreCase(url, "jdbc:sqlserver:") || startsWithIgnoreCase(url, "jdbc:exa:")) {
            return url.endsWith(";") ? "" : ";";
        }
        if (startsWithIgnoreCase(url, "jdbc:teradata:")) {
            return url.endsWith(",") ? "" : ",";
        }
        if (usesColonProperties(url)) {
            if (url.endsWith(":") || url.endsWith(";")) {
                return "";
            }
            return hasColonProperties(url) ? ";" : ":";
        }
        return url.contains("?") ? "&" : "?";
    }

    private static boolean usesColonProperties(String url) {
        return startsWithIgnoreCase(url, "jdbc:db2:") || startsWithIgnoreCase(url, "jdbc:informix-sqli:");
    }

    private static boolean hasColonProperties(String url) {
        int schemeEnd = url.indexOf("://");
        if (schemeEnd < 0) {
            return false;
        }
        int pathStart = url.indexOf('/', schemeEnd + 3);
        if (pathStart < 0) {
            return false;
        }
        return url.indexOf(':', pathStart + 1) >= 0;
    }

    private static boolean startsWithIgnoreCase(String value, String prefix) {
        return value.regionMatches(true, 0, prefix, 0, prefix.length());
    }
}
