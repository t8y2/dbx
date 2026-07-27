package com.dbx.agent;

public final class PostgresLikeAgentProfile {
    private final String driverClass;
    private final String urlTemplate;
    private final int defaultPort;
    private final String catalogSchema;
    private final String catalogPrefix;

    public PostgresLikeAgentProfile(String driverClass, String urlTemplate) {
        this(driverClass, urlTemplate, 0, "pg_catalog", "pg_");
    }

    public PostgresLikeAgentProfile(
        String driverClass,
        String urlTemplate,
        String catalogSchema,
        String catalogPrefix
    ) {
        this(driverClass, urlTemplate, 0, catalogSchema, catalogPrefix);
    }

    public PostgresLikeAgentProfile(
        String driverClass,
        String urlTemplate,
        int defaultPort,
        String catalogSchema,
        String catalogPrefix
    ) {
        this.driverClass = driverClass;
        this.urlTemplate = urlTemplate;
        this.defaultPort = defaultPort;
        // PostgreSQL derivatives may preserve catalog semantics while renaming every
        // relation and helper function. Centralize that mapping instead of copying
        // the full metadata implementation for each compatible database.
        this.catalogSchema = catalogSchema;
        this.catalogPrefix = catalogPrefix;
    }

    public String getDriverClass() {
        return driverClass;
    }

    public String getUrlTemplate() {
        return urlTemplate;
    }

    public String getCatalogSchema() {
        return catalogSchema;
    }

    public String getToastSchema() {
        return catalogPrefix + "toast";
    }

    public String getTemporarySchemaPrefix() {
        return catalogPrefix + "temp_";
    }

    public String getToastTemporarySchemaPrefix() {
        return catalogPrefix + "toast_temp_";
    }

    public String catalogRelation(String name) {
        return catalogSchema + "." + catalogPrefix + name;
    }

    public String catalogPrefixedFunction(String name) {
        return catalogSchema + "." + catalogPrefix + name;
    }

    public String catalogBuiltinFunction(String name) {
        return catalogSchema + "." + name;
    }

    public String buildUrl(ConnectParams params) {
        return new JdbcAgentProfile(
            driverClass,
            urlTemplate,
            defaultPort,
            false,
            java.util.Collections.emptySet(),
            java.util.Arrays.asList("TABLE", "VIEW", "MATERIALIZED VIEW", "SYSTEM TABLE", "SYSTEM VIEW")
        ).buildUrl(params);
    }
}
