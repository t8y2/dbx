package com.dbx.agent.yashandb;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectSource;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Locale;

public final class YashandbAgent extends ConfiguredJdbcAgent {
    static final String OBJECT_SOURCE_SQL = """
        SELECT TEXT
        FROM ALL_SOURCE
        WHERE OWNER = ?
          AND NAME = ?
          AND TYPE = ?
        ORDER BY LINE
        """.stripIndent().trim();

    public static final JdbcAgentProfile YASHANDB_PROFILE = new JdbcAgentProfile(
        "com.yashandb.jdbc.Driver",
        "jdbc:yasdb://{host}:{port}/{database}",
        1688,
        true
    );

    public YashandbAgent() {
        super(YASHANDB_PROFILE);
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String normalizedObjectType = normalizeObjectSourceType(objectType);
        return unchecked(() -> {
            StringBuilder source = new StringBuilder();
            try (PreparedStatement statement = requireConnection().prepareStatement(OBJECT_SOURCE_SQL)) {
                statement.setString(1, schema);
                statement.setString(2, name);
                statement.setString(3, normalizedObjectType);
                try (ResultSet resultSet = statement.executeQuery()) {
                    while (resultSet.next()) {
                        String line = resultSet.getString(1);
                        if (line != null) {
                            source.append(line);
                        }
                    }
                }
            }
            return new ObjectSource(name, normalizedObjectType, schema, source.toString(), false);
        });
    }

    static String normalizeObjectSourceType(String objectType) {
        if (objectType == null) {
            throw new IllegalArgumentException("Unsupported object type: null");
        }
        String normalized = objectType.trim().toUpperCase(Locale.ROOT);
        if (!"FUNCTION".equals(normalized) && !"PROCEDURE".equals(normalized)) {
            throw new IllegalArgumentException("Unsupported object type: " + objectType);
        }
        return normalized;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(YashandbAgent::new).run();
    }
}
