package com.dbx.agent.saphana;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectSource;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Arrays;
import java.util.Collections;
import java.util.Locale;

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

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String normalizedType = objectType == null ? "" : objectType.trim().toUpperCase(Locale.ROOT);
        if (!"PROCEDURE".equals(normalizedType)) {
            return super.getObjectSource(schema, name, objectType);
        }

        return unchecked(() -> {
            String sql = "SELECT DEFINITION FROM SYS.PROCEDURES WHERE SCHEMA_NAME = ? AND PROCEDURE_NAME = ?";
            String source = "";
            try (PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, name);
                try (ResultSet rs = stmt.executeQuery()) {
                    if (rs.next()) {
                        String definition = rs.getString(1);
                        source = definition == null ? "" : definition;
                    }
                }
            }
            return new ObjectSource(name, normalizedType, schema, source);
        });
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(SapHanaAgent::new).run();
    }
}
