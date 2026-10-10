package com.dbx.agent;

import com.google.gson.JsonObject;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class SecureDatabaseLinkTest {
    private JsonObject params() {
        JsonObject value = new JsonObject();
        for (Map.Entry<String, String> field : Map.of("name", "REMOTE.EXAMPLE", "scope", "tenant", "authentication", "fixedUser", "username", "REMOTEUSER", "password", "marker-secret", "host", "remote:2881", "protocol", "OB", "tenant", "remoteTenant").entrySet()) {
            value.addProperty(field.getKey(), field.getValue());
        }
        return value;
    }
    @Test void tenantScopeNeverProducesPublicSql() {
        String sql = SecureDatabaseLink.oceanBaseSql(params());
        assertTrue(sql.startsWith("CREATE DATABASE LINK REMOTE.EXAMPLE "));
        JsonObject invalid = params(); invalid.addProperty("scope", "public");
        assertThrows(IllegalArgumentException.class, () -> SecureDatabaseLink.oceanBaseSql(invalid));
        invalid.addProperty("scope", "tenant"); invalid.addProperty("password", "unsafe\"password");
        assertThrows(IllegalArgumentException.class, () -> SecureDatabaseLink.oceanBaseSql(invalid));
    }
    @Test void truncatedDriverSqlNeverEscapesSecureBoundary() {
        Statement statement = (Statement) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Statement.class}, (proxy, method, args) -> {
            if (method.getName().equals("execute")) { throw new SQLException("CREATE DATABASE LINK IDENTIFIED BY marker-secr", "42000", 955); }
            return null;
        });
        Connection connection = (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
            if (method.getName().equals("getAutoCommit")) { return true; }
            if (method.getName().equals("createStatement")) { return statement; }
            return null;
        });
        Map<String, Object> response = SecureDatabaseLink.executeOceanBase(connection, params());
        assertEquals(false, response.get("ok"));
        assertEquals(955, response.get("vendorCode"));
        assertEquals("DBLINK_CREATE_FAILED", response.get("errorCode"));
        assertFalse(response.toString().contains("marker"));
        assertFalse(response.toString().contains("CREATE DATABASE LINK"));
    }
}
