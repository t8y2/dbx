package com.dbx.agent.saphana;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;
import java.util.Arrays;
import java.util.Collections;

public final class SapHanaAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile SAPHANA_PROFILE = new JdbcAgentProfile(
        "com.sap.db.jdbc.Driver",
        "jdbc:sap://{host}:{port}/?databaseName={database}",
        30015,
        false,
        Collections.emptySet(),
        Arrays.asList("COLUMN TABLE", "ROW TABLE", "TABLE", "VIEW")
    );

    public SapHanaAgent() {
        super(SAPHANA_PROFILE);
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(SapHanaAgent::new).run();
    }
}
