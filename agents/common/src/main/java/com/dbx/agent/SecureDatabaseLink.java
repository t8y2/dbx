package com.dbx.agent;

import com.google.gson.JsonObject;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Map;

/** Password-bearing SQL never enters JdbcExecutor or an exception response. */
public final class SecureDatabaseLink {
    private SecureDatabaseLink() {}

    public static Map<String, Object> executeOceanBase(Connection connection, JsonObject params) {
        try {
            String sql = oceanBaseSql(params);
            if (!connection.getAutoCommit()) {
                return Map.of("ok", false, "errorCode", "DBLINK_MANUAL_TRANSACTION_UNSUPPORTED");
            }
            try (Statement statement = connection.createStatement()) {
                statement.setQueryTimeout(30);
                statement.execute(sql);
            }
            return Map.of("ok", true);
        } catch (SQLException error) {
            String state = error.getSQLState();
            int code = error.getErrorCode();
            boolean unknown = state == null || state.startsWith("08") || code == 1013 || code == 3113 || code == 3114;
            return Map.of("ok", false, "errorCode", unknown ? "DBLINK_OUTCOME_UNKNOWN" : "DBLINK_CREATE_FAILED", "vendorCode", code);
        } catch (IllegalArgumentException ignored) {
            return Map.of("ok", false, "errorCode", "DBLINK_INVALID_CONFIGURATION");
        } catch (Throwable ignored) {
            return Map.of("ok", false, "errorCode", "DBLINK_OUTCOME_UNKNOWN");
        }
    }

    static String oceanBaseSql(JsonObject params) {
        String name = value(params, "name"), username = value(params, "username"), password = value(params, "password");
        String host = value(params, "host"), protocol = value(params, "protocol"), tenant = value(params, "tenant"), cluster = value(params, "cluster");
        if (!name.matches("[A-Za-z][A-Za-z0-9_$#]*(\\.[A-Za-z0-9_$#]+)*") || name.length() > 128
            || !value(params, "scope").equals("tenant") || !value(params, "authentication").equals("fixedUser")
            || username.isEmpty() || password.isEmpty() || host.isBlank() || password.contains("\"")
            || !(protocol.equals("OB") || protocol.equals("OCI")) || (protocol.equals("OB") && tenant.isEmpty())
            || (protocol.equals("OCI") && (!cluster.isEmpty() || !tenant.equals("oracle")))) {
            throw new IllegalArgumentException("DBLINK_INVALID_CONFIGURATION");
        }
        for (String part : new String[]{username, password, host, tenant, cluster}) {
            if (part.indexOf('\0') >= 0 || part.indexOf('\r') >= 0 || part.indexOf('\n') >= 0) {
                throw new IllegalArgumentException("DBLINK_INVALID_CONFIGURATION");
            }
        }
        return "CREATE DATABASE LINK " + name + " CONNECT TO " + identifier(username) + "@" + identifier(tenant)
            + " IDENTIFIED BY \"" + password + "\" " + protocol + " HOST '" + host.replace("'", "''") + "'"
            + (cluster.isEmpty() ? "" : " CLUSTER " + identifier(cluster));
    }

    private static String value(JsonObject params, String key) {
        return params.has(key) && !params.get(key).isJsonNull() ? params.get(key).getAsString() : "";
    }
    private static String identifier(String value) { return "\"" + value.replace("\"", "\"\"") + "\""; }
}
