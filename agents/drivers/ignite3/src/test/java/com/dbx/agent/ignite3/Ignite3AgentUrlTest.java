package com.dbx.agent.ignite3;

import com.dbx.agent.ConnectParams;
import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;
import java.util.logging.Logger;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class Ignite3AgentUrlTest {

    @Test
    void buildUrlUsesExplicitConnectionString() {
        ConnectParams params = new ConnectParams(
            "127.0.0.1", 10800, "PUBLIC", "", "", "",
            "jdbc:ignite:thin://10.0.0.1:10800/PUBLIC?connectionTimeout=5000", false
        );

        Assertions.assertEquals(
            "jdbc:ignite:thin://10.0.0.1:10800/PUBLIC?connectionTimeout=5000",
            Ignite3Agent.buildUrl(params)
        );
    }

    @Test
    void buildUrlWithoutDatabaseOmitsSchemaSegment() {
        ConnectParams params = new ConnectParams("127.0.0.1", 10800, "", "", "", "", "", false);

        Assertions.assertEquals("jdbc:ignite:thin://127.0.0.1:10800", Ignite3Agent.buildUrl(params));
    }

    @Test
    void buildUrlWithoutUrlParamsStaysUnchanged() {
        ConnectParams params = new ConnectParams("127.0.0.1", 10800, "PUBLIC", "", "", null, "", false);

        Assertions.assertEquals("jdbc:ignite:thin://127.0.0.1:10800/PUBLIC", Ignite3Agent.buildUrl(params));
    }

    @Test
    void buildUrlAppendsAdvancedUrlParamsAfterSchema() {
        ConnectParams params = new ConnectParams(
            "127.0.0.1", 10800, "PUBLIC", "", "",
            "connectionTimeout=5000&queryTimeout=30", "", false
        );

        Assertions.assertEquals(
            "jdbc:ignite:thin://127.0.0.1:10800/PUBLIC?connectionTimeout=5000&queryTimeout=30",
            Ignite3Agent.buildUrl(params)
        );
    }

    @Test
    void buildUrlPassesThroughUserParamStringVerbatim() {
        ConnectParams params = new ConnectParams(
            "127.0.0.1", 10800, "PUBLIC", "", "",
            "sslEnabled=true;trustStorePath=/etc/ignite/trust.jks", "", false
        );

        Assertions.assertEquals(
            "jdbc:ignite:thin://127.0.0.1:10800/PUBLIC?sslEnabled=true;trustStorePath=/etc/ignite/trust.jks",
            Ignite3Agent.buildUrl(params)
        );
    }

    @Test
    void buildUrlStripsLeadingParamSeparators() {
        ConnectParams params = new ConnectParams("127.0.0.1", 10800, "", "", "", "?sslEnabled=true", "", false);

        Assertions.assertEquals("jdbc:ignite:thin://127.0.0.1:10800?sslEnabled=true", Ignite3Agent.buildUrl(params));
    }

    @Test
    void usesThePinnedIgniteJdbcDependency() throws Exception {
        Path driverJar = Path.of(
            org.apache.ignite.jdbc.IgniteJdbcDriver.class.getProtectionDomain().getCodeSource().getLocation().toURI()
        );

        Assertions.assertEquals("ignite-jdbc-3.1.0.jar", driverJar.getFileName().toString());
    }

    @Test
    void separateCredentialsRoundTripThroughJdbcPropertiesAndIgniteParser() throws Exception {
        String username = "dbx-user";
        String password = "dbx-secret";
        String urlParams = "sslEnabled=true&connectionTimeout=5000&queryTimeout=30&connectionTimeZone=UTC";
        CapturingDriver capturingDriver = new CapturingDriver();
        DriverManager.registerDriver(capturingDriver);

        try {
            ConnectParams captureParams = new ConnectParams(
                "127.0.0.1", 10800, "PUBLIC", username, password, urlParams,
                CapturingDriver.URL, false
            );
            Properties connectionProperties = new Ignite3Agent().buildConnectionProperties(captureParams);
            try (Connection ignored = DriverManager.getConnection(CapturingDriver.URL, connectionProperties)) {
                Assertions.assertEquals(CapturingDriver.URL, capturingDriver.url);
            }

            Assertions.assertEquals(username, capturingDriver.properties.getProperty("ignite.jdbc.username"));
            Assertions.assertEquals(password, capturingDriver.properties.getProperty("ignite.jdbc.password"));
            Assertions.assertNull(capturingDriver.properties.getProperty("user"));
            Assertions.assertNull(capturingDriver.properties.getProperty("password"));

            ConnectParams igniteParams = new ConnectParams(
                "127.0.0.1", 10800, "PUBLIC", username, password, urlParams, "", false
            );
            String igniteUrl = Ignite3Agent.buildUrl(igniteParams);
            Assertions.assertFalse(igniteUrl.contains(username));
            Assertions.assertFalse(igniteUrl.contains(password));

            Map<String, String> parsed = parsedProperties(
                new org.apache.ignite.jdbc.IgniteJdbcDriver(),
                igniteUrl,
                capturingDriver.properties
            );
            Assertions.assertEquals(username, parsed.get("ignite.jdbc.username"));
            Assertions.assertEquals(password, parsed.get("ignite.jdbc.password"));
            Assertions.assertEquals("true", parsed.get("ignite.jdbc.sslEnabled"));
            Assertions.assertEquals("5000", parsed.get("ignite.jdbc.connectionTimeout"));
            Assertions.assertEquals("30", parsed.get("ignite.jdbc.queryTimeout"));
            Assertions.assertEquals("UTC", parsed.get("ignite.jdbc.connectionTimeZone"));
        } finally {
            DriverManager.deregisterDriver(capturingDriver);
        }
    }

    @Test
    void blankCredentialsDoNotEnableIgniteAuthentication() throws Exception {
        CapturingDriver capturingDriver = new CapturingDriver();
        DriverManager.registerDriver(capturingDriver);

        try {
            ConnectParams params = new ConnectParams(
                "127.0.0.1", 10800, "PUBLIC", "", "", "", CapturingDriver.URL, false
            );
            Properties connectionProperties = new Ignite3Agent().buildConnectionProperties(params);
            try (Connection ignored = DriverManager.getConnection(CapturingDriver.URL, connectionProperties)) {
                Assertions.assertTrue(capturingDriver.properties.isEmpty());
            }
        } finally {
            DriverManager.deregisterDriver(capturingDriver);
        }
    }

    @Test
    void semicolonAdvancedParamsStayVerbatimAndAreNotSplitInQueryMode() throws Exception {
        String url = Ignite3Agent.buildUrl(new ConnectParams(
            "127.0.0.1", 10800, "PUBLIC", "", "",
            "sslEnabled=true;trustStorePath=/etc/ignite/trust.jks", "", false
        ));

        Assertions.assertEquals(
            "jdbc:ignite:thin://127.0.0.1:10800/PUBLIC?sslEnabled=true;trustStorePath=/etc/ignite/trust.jks",
            url
        );

        Map<String, String> parsed = parsedProperties(
            new org.apache.ignite.jdbc.IgniteJdbcDriver(),
            url,
            new Properties()
        );
        Assertions.assertEquals("false", parsed.get("ignite.jdbc.sslEnabled"));
        Assertions.assertNull(parsed.get("ignite.jdbc.trustStorePath"));
    }

    private static Map<String, String> parsedProperties(
        Driver driver,
        String url,
        Properties properties
    ) throws SQLException {
        Map<String, String> parsed = new LinkedHashMap<>();
        for (DriverPropertyInfo property : driver.getPropertyInfo(url, properties)) {
            parsed.put(property.name, property.value);
        }
        return parsed;
    }

    private static final class CapturingDriver implements Driver {
        private static final String URL = "jdbc:dbx-ignite3-test:";

        private String url;
        private Properties properties;

        @Override
        public Connection connect(String url, Properties info) {
            if (!acceptsURL(url)) {
                return null;
            }
            this.url = url;
            properties = new Properties();
            properties.putAll(info);
            return (Connection) Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[]{Connection.class},
                (proxy, method, args) -> {
                    if ("close".equals(method.getName())) {
                        return null;
                    }
                    if ("isClosed".equals(method.getName())) {
                        return false;
                    }
                    throw new UnsupportedOperationException(method.getName());
                }
            );
        }

        @Override
        public boolean acceptsURL(String url) {
            return URL.equals(url);
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) {
            return new DriverPropertyInfo[0];
        }

        @Override
        public int getMajorVersion() {
            return 1;
        }

        @Override
        public int getMinorVersion() {
            return 0;
        }

        @Override
        public boolean jdbcCompliant() {
            return false;
        }

        @Override
        public Logger getParentLogger() {
            return Logger.getGlobal();
        }
    }
}
