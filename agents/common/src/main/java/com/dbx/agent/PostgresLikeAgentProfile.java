package com.dbx.agent;

public final class PostgresLikeAgentProfile {
    private final String driverClass;
    private final String urlTemplate;

    public PostgresLikeAgentProfile(String driverClass, String urlTemplate) {
        this.driverClass = driverClass;
        this.urlTemplate = urlTemplate;
    }

    public String getDriverClass() {
        return driverClass;
    }

    public String getUrlTemplate() {
        return urlTemplate;
    }

    public String buildUrl(ConnectParams params) {
        return new JdbcAgentProfile(
            driverClass,
            urlTemplate,
            0,
            false,
            java.util.Collections.emptySet(),
            java.util.Arrays.asList("TABLE", "VIEW", "MATERIALIZED VIEW", "SYSTEM TABLE", "SYSTEM VIEW")
        ).buildUrl(params);
    }
}
