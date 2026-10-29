package com.dbx.agent;

import org.junit.jupiter.api.Test;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverPropertyInfo;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.logging.Logger;
import static org.junit.jupiter.api.Assertions.*;

class JdbcConnectionParametersTest {
    private static Driver driver(DriverPropertyInfo[] information) {
        return new Driver() {
            public Connection connect(String url, Properties props) { throw new AssertionError("Metadata must not connect"); }
            public boolean acceptsURL(String url) { return true; }
            public DriverPropertyInfo[] getPropertyInfo(String url, Properties props) {
                assertEquals("jdbc:test://unreachable/db", url);
                assertEquals("context", props.getProperty("applicationName"));
                return information;
            }
            public int getMajorVersion() { return 1; }
            public int getMinorVersion() { return 0; }
            public boolean jdbcCompliant() { return true; }
            public Logger getParentLogger() { return Logger.getGlobal(); }
        };
    }
    private static Properties context() { Properties value = new Properties(); value.setProperty("applicationName", "context"); return value; }
    @Test void reportsChoicesRequiredAndDescriptionsWithoutConnecting() throws SQLException {
        DriverPropertyInfo mode = new DriverPropertyInfo("mode", "strict");
        mode.description = "Connection mode"; mode.choices = new String[] {"strict", "relaxed"}; mode.required = true;
        DriverPropertyInfo enabled = new DriverPropertyInfo("enabled", "true");
        enabled.choices = new String[] {"true", "false"};
        List<Map<String,Object>> result = JdbcConnectionParameters.describe(driver(new DriverPropertyInfo[] {mode, enabled}), "jdbc:test://unreachable/db", context());
        assertEquals("enum", result.get(0).get("type")); assertEquals("strict", result.get(0).get("defaultValue"));
        assertEquals("Connection mode", result.get(0).get("description")); assertEquals(true, result.get(0).get("required"));
        assertEquals(List.of("strict", "relaxed"), result.get(0).get("choices")); assertEquals("boolean", result.get(1).get("type"));
    }
    @Test void omitsAuthenticationAndNeverReturnsEchoedSecretDefaultsOrChoices() throws SQLException {
        DriverPropertyInfo secret = new DriverPropertyInfo("accessToken", "echoed-secret"); secret.choices = new String[] {"echoed-secret"};
        DriverPropertyInfo password = new DriverPropertyInfo("password", "login-secret");
        DriverPropertyInfo user = new DriverPropertyInfo("user", "login-user");
        List<Map<String,Object>> result = JdbcConnectionParameters.describe(driver(new DriverPropertyInfo[] {secret, password, user}), "jdbc:test://unreachable/db", context());
        assertEquals(1, result.size()); assertEquals(true, result.get(0).get("secret"));
        assertFalse(result.get(0).containsKey("defaultValue")); assertFalse(result.get(0).containsKey("choices"));
        assertFalse(result.toString().contains("echoed-secret"));
    }
    @Test void toleratesMissingOrIncompleteDriverMetadata() throws SQLException {
        assertTrue(JdbcConnectionParameters.describe(driver(null), "jdbc:test://unreachable/db", context()).isEmpty());
        DriverPropertyInfo empty = new DriverPropertyInfo("", null);
        List<Map<String,Object>> result = JdbcConnectionParameters.describe(driver(new DriverPropertyInfo[] {null, empty, new DriverPropertyInfo("custom", null)}), "jdbc:test://unreachable/db", context());
        assertEquals(1, result.size()); assertEquals("string", result.get(0).get("type"));
    }
}
