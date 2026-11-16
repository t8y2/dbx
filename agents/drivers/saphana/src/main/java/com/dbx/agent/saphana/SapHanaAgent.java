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
        Arrays.asList("COLUMN TABLE", "ROW TABLE", "TABLE", "VIEW", "CALC VIEW", "JOIN VIEW", "OLAP VIEW", "HIERARCHY VIEW")
    );

    public SapHanaAgent() {
        super(SAPHANA_PROFILE);
    }

    @Override
    protected boolean includeColumnCommentsInTableDdl() {
        return true;
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String normalizedType = objectType == null ? "" : objectType.trim().toUpperCase(Locale.ROOT);
        String catalogRelation;
        String nameColumn;
        switch (normalizedType) {
            case "PROCEDURE":
                catalogRelation = "SYS.PROCEDURES";
                nameColumn = "PROCEDURE_NAME";
                break;
            case "VIEW":
                catalogRelation = "SYS.VIEWS";
                nameColumn = "VIEW_NAME";
                break;
            default:
                return super.getObjectSource(schema, name, objectType);
        }

        return unchecked(() -> {
            boolean hasSchema = schema != null && !schema.trim().isEmpty();
            String resolvedSchema = schema;
            String source = "";
            if (hasSchema) {
                String sql = "SELECT DEFINITION FROM " + catalogRelation + " WHERE SCHEMA_NAME = ? AND " + nameColumn + " = ?";
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
            } else {
                String sql = "SELECT SCHEMA_NAME, DEFINITION FROM " + catalogRelation
                    + " WHERE SCHEMA_NAME = CURRENT_SCHEMA AND " + nameColumn + " = ?";
                try (PreparedStatement stmt = requireConnection().prepareStatement(sql)) {
                    stmt.setString(1, name);
                    try (ResultSet rs = stmt.executeQuery()) {
                        if (rs.next()) {
                            String currentSchema = rs.getString(1);
                            if (currentSchema != null && !currentSchema.trim().isEmpty()) {
                                resolvedSchema = currentSchema;
                            }
                            String definition = rs.getString(2);
                            source = definition == null ? "" : definition;
                        }
                    }
                }
            }
            boolean editable = !"VIEW".equals(normalizedType) || !source.trim().isEmpty();
            return new ObjectSource(name, normalizedType, resolvedSchema, source, editable);
        });
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(SapHanaAgent::new).run();
    }
}
