package com.dbx.agent.iotdb;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.JsonRpcServer;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

public final class IoTDBAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile IOTDB_PROFILE = new JdbcAgentProfile(
        "org.apache.iotdb.jdbc.IoTDBDriver",
        "jdbc:iotdb://{host}:{port}/",
        6667,
        true
    );

    public IoTDBAgent() {
        super(IOTDB_PROFILE);
    }

    // IoTDB 的 database 是 `root.xxx` 路径前缀；JDBC metadata 会把同一路径同时投影成 catalog/schema。
    // 这里使用 IoTDB 原生语句作为 database 列表来源，避免依赖驱动的关系型兼容层。
    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            List<DatabaseInfo> result = new ArrayList<>();
            try (Statement stmt = requireConnection().createStatement();
                 ResultSet rs = stmt.executeQuery("SHOW DATABASES")) {
                while (rs.next()) {
                    String name = rs.getString(1);
                    if (name != null && !name.trim().isEmpty()) {
                        result.add(new DatabaseInfo(name.trim()));
                    }
                }
            }
            return result;
        });
    }

    public static void main(String[] args) {
        new JsonRpcServer(new IoTDBAgent()).run();
    }
}
