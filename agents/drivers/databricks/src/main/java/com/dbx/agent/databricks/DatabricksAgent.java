package com.dbx.agent.databricks;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;

public final class DatabricksAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile DATABRICKS_PROFILE = new DatabricksProfile();

    public DatabricksAgent() {
        super(DATABRICKS_PROFILE);
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(DatabricksAgent::new).run();
    }

    private static final class DatabricksProfile extends JdbcAgentProfile {
        private DatabricksProfile() {
            super("com.databricks.client.jdbc.Driver", "jdbc:databricks://{host}:{port}/{database}", 443, true);
        }

        @Override
        public String buildUrl(ConnectParams params) {
            if (!params.getConnection_string().trim().isEmpty()) {
                return params.getConnection_string();
            }
            int port = params.getPort() > 0 ? params.getPort() : getDefaultPort();
            String base = getUrlTemplate()
                .replace("{host}", params.getHost())
                .replace("{port}", Integer.toString(port))
                .replace("{database}", params.getDatabase());
            String urlParams = params.getUrl_params() == null ? "" : params.getUrl_params().trim();
            while (urlParams.startsWith(";") || urlParams.startsWith("?") || urlParams.startsWith("&")) {
                urlParams = urlParams.substring(1);
            }
            return urlParams.isEmpty() ? base : base + ";" + urlParams;
        }
    }
}
