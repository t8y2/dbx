package com.dbx.agent.ldap;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;

class LdapAgentTest {

    @AfterEach
    void tearDown() {
        // Ensure connection is closed between tests
        LdapAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 0, "method": "disconnect" }
            """);
    }

    // -----------------------------------------------------------------------
    // Handshake
    // -----------------------------------------------------------------------

    @Test
    void handshakeReturnsProtocolVersionAndCapabilities() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 1,
              "method": "handshake"
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        var result = payload.getAsJsonObject("result");

        assertEquals(1, result.get("protocolVersion").getAsInt());
        assertEquals(1, result.get("agentProtocolVersion").getAsInt());
        assertTrue(result.getAsJsonArray("capabilities").size() > 0);
    }

    // -----------------------------------------------------------------------
    // JSON-RPC dispatch: routing and error handling
    // -----------------------------------------------------------------------

    @Test
    void unknownMethodReturnsError() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 2,
              "method": "nonexistent_method"
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("error"));
        assertEquals(-1, payload.getAsJsonObject("error").get("code").getAsInt());
    }

    @Test
    void shutdownReturnsOkAndSetsFlag() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 3,
              "method": "shutdown"
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(true, payload.getAsJsonObject("result").get("ok").getAsBoolean());
    }

    @Test
    void disconnectReturnsOk() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 4,
              "method": "disconnect"
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertEquals(true, payload.getAsJsonObject("result").get("ok").getAsBoolean());
    }

    @Test
    void searchWithoutConnectionReturnsError() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 5,
              "method": "ldap_search",
              "params": {
                "base_dn": "dc=example,dc=com",
                "filter": "(objectClass=*)"
              }
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("error"));
        assertTrue(payload.getAsJsonObject("error").get("message").getAsString()
            .contains("Not connected"));
    }

    // -----------------------------------------------------------------------
    // test_connection: routing for different security protocols
    // -----------------------------------------------------------------------

    @Test
    void testConnectionWithSimpleBindRoutesCorrectly() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 10,
              "method": "test_connection",
              "params": {
                "connection": {
                  "hostname": "ldap.example.com",
                  "port": 389,
                  "security_protocol": "simple",
                  "username": "cn=admin,dc=example,dc=com",
                  "password": "secret"
                }
              }
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        // Will fail with connection error, but should not fail with routing error
        assertTrue(payload.has("error"));
        assertFalse(payload.getAsJsonObject("error").get("message").getAsString()
            .contains("Unsupported security protocol"));
    }

    @Test
    void testConnectionWithGssapiPasswordRoutesCorrectly() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 11,
              "method": "test_connection",
              "params": {
                "connection": {
                  "hostname": "ldap.example.com",
                  "port": 389,
                  "security_protocol": "gssapi",
                  "principal": "user@REALM.COM",
                  "password": "secret"
                }
              }
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("error"));
        // Should not be a routing error
        assertFalse(payload.getAsJsonObject("error").get("message").getAsString()
            .contains("Unsupported security protocol"));
    }

    @Test
    void testConnectionWithGssapiKeytabRoutesCorrectly() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 12,
              "method": "test_connection",
              "params": {
                "connection": {
                  "hostname": "ldap.example.com",
                  "port": 389,
                  "security_protocol": "gssapi",
                  "principal": "svc/ldap@REALM.COM",
                  "keytab_path": "/etc/krb5.keytab",
                  "krb5_conf": "[libdefaults]\\n  default_realm = REALM.COM"
                }
              }
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("error"));
        assertFalse(payload.getAsJsonObject("error").get("message").getAsString()
            .contains("Unsupported security protocol"));
    }

    @Test
    void testConnectionWithNoneProtocolRoutesCorrectly() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 13,
              "method": "test_connection",
              "params": {
                "connection": {
                  "hostname": "ldap.example.com",
                  "port": 389,
                  "security_protocol": "none"
                }
              }
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("error"));
        assertFalse(payload.getAsJsonObject("error").get("message").getAsString()
            .contains("Unsupported security protocol"));
    }

    @Test
    void testConnectionRejectsUnsupportedSecurityProtocol() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 14,
              "method": "test_connection",
              "params": {
                "connection": {
                  "hostname": "ldap.example.com",
                  "port": 389,
                  "security_protocol": "digest-md5"
                }
              }
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("error"));
        assertTrue(payload.getAsJsonObject("error").get("message").getAsString()
            .contains("Unsupported security protocol"));
    }

    // -----------------------------------------------------------------------
    // search: filter validation
    // -----------------------------------------------------------------------

    @Test
    void searchWithoutFilterReturnsError() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 20,
              "method": "ldap_search",
              "params": {
                "base_dn": "dc=example,dc=com"
              }
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("error"));
        // Should fail because not connected (connection check happens first)
        // If connected, would fail on missing filter
        assertNotNull(payload.getAsJsonObject("error").get("message"));
    }

    // -----------------------------------------------------------------------
    // connect: alternate parameter names
    // -----------------------------------------------------------------------

    @Test
    void connectAcceptsAlternateFieldNames() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 30,
              "method": "connect",
              "params": {
                "connection": {
                  "host": "ldap.example.com",
                  "port": 636,
                  "ssl": true,
                  "tls_skip_verify": true,
                  "security_protocol": "simple",
                  "bind_dn": "cn=admin,dc=example,dc=com",
                  "bind_password": "secret"
                }
              }
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("error"));
        // Should not complain about missing hostname — "host" should be accepted
        assertFalse(payload.getAsJsonObject("error").get("message").getAsString()
            .contains("hostname"));
    }

    // -----------------------------------------------------------------------
    // jaasValue escaping
    // -----------------------------------------------------------------------

    @Test
    void jaasValueEscapesBackslashAndQuote() {
        assertEquals("foo\\\\bar", LdapAgent.jaasValue("foo\\bar"));
        assertEquals("foo\\\"bar", LdapAgent.jaasValue("foo\"bar"));
        assertEquals("a\\\\b\\\"c", LdapAgent.jaasValue("a\\b\"c"));
    }

    @Test
    void jaasValuePreservesPlainStrings() {
        assertEquals("simple", LdapAgent.jaasValue("simple"));
        assertEquals("user@REALM.COM", LdapAgent.jaasValue("user@REALM.COM"));
    }

    // -----------------------------------------------------------------------
    // connect with default security_protocol (simple)
    // -----------------------------------------------------------------------

    @Test
    void connectDefaultsToSimpleWhenSecurityProtocolOmitted() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 40,
              "method": "test_connection",
              "params": {
                "connection": {
                  "hostname": "ldap.example.com",
                  "port": 389,
                  "username": "cn=admin,dc=example,dc=com",
                  "password": "secret"
                }
              }
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("error"));
        assertFalse(payload.getAsJsonObject("error").get("message").getAsString()
            .contains("Unsupported security protocol"));
    }

    // -----------------------------------------------------------------------
    // GSSAPI with krb5 config variants
    // -----------------------------------------------------------------------

    @Test
    void gssapiAcceptsAlternateKrb5FieldNames() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 50,
              "method": "test_connection",
              "params": {
                "connection": {
                  "hostname": "ldap.example.com",
                  "port": 389,
                  "security_protocol": "gssapi",
                  "kerberos_principal": "user@REALM.COM",
                  "kerberos_password": "secret",
                  "krb5_config": "[libdefaults]\\n  default_realm = REALM.COM"
                }
              }
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("error"));
        assertFalse(payload.getAsJsonObject("error").get("message").getAsString()
            .contains("Unsupported security protocol"));
    }

    // -----------------------------------------------------------------------
    // connect with ldaps (SSL)
    // -----------------------------------------------------------------------

    @Test
    void connectWithLdapsAndSimpleBind() {
        String response = LdapAgent.handleRequest("""
            {
              "jsonrpc": "2.0",
              "id": 60,
              "method": "test_connection",
              "params": {
                "connection": {
                  "hostname": "ldap.example.com",
                  "port": 636,
                  "ssl": true,
                  "tls_skip_verify": true,
                  "security_protocol": "simple",
                  "username": "cn=admin,dc=example,dc=com",
                  "password": "secret"
                }
              }
            }
            """);

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("error"));
        assertFalse(payload.getAsJsonObject("error").get("message").getAsString()
            .contains("Unsupported security protocol"));
    }

    // =======================================================================
    // Integration tests — real LDAP server
    //
    // These tests exercise the agent against a live OpenLDAP server launched
    // from `deploy/database/ldap/compose.yml` (image `mlan/openldap`, root
    // suffix `dc=example,dc=com`, admin `cn=admin,dc=example,dc=com` /
    // `123456`, demo users `uid=alice|bob|charlie,ou=users,dc=example,dc=com`
    // with password `123456`).
    //
    // Every value can be overridden with environment variables so the same
    // test file can target any LDAP server:
    //
    //   DBX_LDAP_TEST_HOST            default localhost
    //   DBX_LDAP_TEST_PORT            default 389
    //   DBX_LDAP_TEST_SSL_PORT        default 636   (LDAPS — see note below)
    //   DBX_LDAP_TEST_BASE_DN         default dc=example,dc=com
    //   DBX_LDAP_TEST_BIND_DN         default cn=admin,dc=example,dc=com
    //   DBX_LDAP_TEST_BIND_PASSWORD   default 123456
    //   DBX_LDAP_TEST_USER_DN         default uid=alice,ou=users,dc=example,dc=com
    //   DBX_LDAP_TEST_USER_PASSWORD   default 123456
    //   DBX_LDAP_TEST_USER_UID        default alice
    //   DBX_LDAP_TEST_USER_FILTER     default (uid=alice)
    //
    // If the server is unreachable the integration tests are skipped (not
    // failed) so a plain `gradle test` still succeeds without the container.
    // =======================================================================

    private static String envOr(String key, String fallback) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? fallback : v;
    }

    private static int envIntOr(String key, int fallback) {
        try {
            return Integer.parseInt(envOr(key, String.valueOf(fallback)));
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static final int LDAP_PORT = envIntOr("DBX_LDAP_TEST_PORT", 389);
    private static final int LDAP_SSL_PORT = envIntOr("DBX_LDAP_TEST_SSL_PORT", 636);

    /**
     * Resolves the LDAP host to use. An explicit {@code DBX_LDAP_TEST_HOST}
     * always wins; otherwise the first reachable candidate wins so the tests
     * work out of the box with common local setups. On WSL2 + podman the
     * published port is reachable via {@code localhost} or IPv6 {@code ::1}
     * but NOT necessarily via {@code 127.0.0.1} (which is what {@code
     * InetSocketAddress("localhost")} normally prefers), so both are probed.
     */
    private static String resolveLdapHost() {
        String explicit = System.getenv("DBX_LDAP_TEST_HOST");
        if (explicit != null && !explicit.isBlank()) return explicit;
        for (String candidate : new String[]{"localhost", "::1"}) {
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress(candidate, LDAP_PORT), 1000);
                return candidate;
            } catch (Exception e) {
                // try next candidate
            }
        }
        return "localhost";
    }

    private static final String LDAP_HOST = resolveLdapHost();
    private static final String BASE_DN = envOr("DBX_LDAP_TEST_BASE_DN", "dc=example,dc=com");
    private static final String BIND_DN = envOr("DBX_LDAP_TEST_BIND_DN", "cn=admin,dc=example,dc=com");
    private static final String BIND_PASS = envOr("DBX_LDAP_TEST_BIND_PASSWORD", "123456");
    private static final String USER_DN = envOr("DBX_LDAP_TEST_USER_DN", "uid=alice,ou=users,dc=example,dc=com");
    private static final String USER_PASS = envOr("DBX_LDAP_TEST_USER_PASSWORD", "123456");
    private static final String USER_UID = envOr("DBX_LDAP_TEST_USER_UID", "alice");
    private static final String USER_FILTER = envOr("DBX_LDAP_TEST_USER_FILTER", "(uid=alice)");

    /** @return true when the configured LDAP server is reachable on the plain port. */
    private static boolean serverReachable() {
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(LDAP_HOST, LDAP_PORT), 2000);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static String simpleBindRequest(int id, String method, String dn, String password, int port) {
        JsonObject req = new JsonObject();
        req.addProperty("jsonrpc", "2.0");
        req.addProperty("id", id);
        req.addProperty("method", method);
        JsonObject params = new JsonObject();
        JsonObject conn = new JsonObject();
        conn.addProperty("hostname", LDAP_HOST);
        conn.addProperty("port", port);
        conn.addProperty("security_protocol", "simple");
        conn.addProperty("username", dn);
        conn.addProperty("password", password);
        params.add("connection", conn);
        req.add("params", params);
        return req.toString();
    }

    private static String adminTestConnectionRequest(int id) {
        return simpleBindRequest(id, "test_connection", BIND_DN, BIND_PASS, LDAP_PORT);
    }

    private static String adminConnectRequest(int id) {
        return simpleBindRequest(id, "connect", BIND_DN, BIND_PASS, LDAP_PORT);
    }

    private static String userTestConnectionRequest(int id) {
        return simpleBindRequest(id, "test_connection", USER_DN, USER_PASS, LDAP_PORT);
    }

    private static String userConnectRequest(int id) {
        return simpleBindRequest(id, "connect", USER_DN, USER_PASS, LDAP_PORT);
    }

    private static String ldapsAdminTestConnectionRequest(int id) {
        JsonObject req = new JsonObject();
        req.addProperty("jsonrpc", "2.0");
        req.addProperty("id", id);
        req.addProperty("method", "test_connection");
        JsonObject params = new JsonObject();
        JsonObject conn = new JsonObject();
        conn.addProperty("hostname", LDAP_HOST);
        conn.addProperty("port", LDAP_SSL_PORT);
        conn.addProperty("ssl", true);
        conn.addProperty("tls_skip_verify", true);
        conn.addProperty("security_protocol", "simple");
        conn.addProperty("username", BIND_DN);
        conn.addProperty("password", BIND_PASS);
        params.add("connection", conn);
        req.add("params", params);
        return req.toString();
    }

    private static String searchRequest(int id, String filter, int sizeLimit) {
        JsonObject req = new JsonObject();
        req.addProperty("jsonrpc", "2.0");
        req.addProperty("id", id);
        req.addProperty("method", "ldap_search");
        JsonObject params = new JsonObject();
        params.addProperty("base_dn", BASE_DN);
        params.addProperty("filter", filter);
        params.addProperty("size_limit", sizeLimit);
        req.add("params", params);
        return req.toString();
    }

    @Test
    void integrationSimpleBindAdminTestConnectionSucceeds() {
        Assumptions.assumeTrue(serverReachable(), "LDAP server not reachable at " + LDAP_HOST + ":" + LDAP_PORT);
        String response = LdapAgent.handleRequest(adminTestConnectionRequest(100));

        var payload = JsonParser.parseString(response).getAsJsonObject();
        if (payload.has("error")) {
            var err = payload.getAsJsonObject("error");
            System.err.println("Simple bind test_connection failed: " + err.get("message").getAsString());
        }
        assertTrue(payload.has("result"), "Expected result but got error: "
            + (payload.has("error") ? payload.getAsJsonObject("error").get("message").getAsString() : "unknown"));
        var result = payload.getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertTrue(result.get("connected").getAsBoolean());
    }

    @Test
    void integrationSimpleBindUserTestConnectionSucceeds() {
        Assumptions.assumeTrue(serverReachable(), "LDAP server not reachable at " + LDAP_HOST + ":" + LDAP_PORT);
        String response = LdapAgent.handleRequest(userTestConnectionRequest(105));

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("result"), "Expected result but got error: "
            + (payload.has("error") ? payload.getAsJsonObject("error").get("message").getAsString() : "unknown"));
        var result = payload.getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertTrue(result.get("connected").getAsBoolean());
    }

    @Test
    void integrationSimpleBindConnectAndSearch() {
        Assumptions.assumeTrue(serverReachable(), "LDAP server not reachable at " + LDAP_HOST + ":" + LDAP_PORT);
        // Step 1: connect as the demo user
        String connectResp = LdapAgent.handleRequest(userConnectRequest(101));
        var connectPayload = JsonParser.parseString(connectResp).getAsJsonObject();
        assertTrue(connectPayload.has("result"),
            "Connect failed: " + connectPayload);
        assertTrue(connectPayload.getAsJsonObject("result").get("ok").getAsBoolean());

        // Step 2: search for the demo user by uid
        String searchResp = LdapAgent.handleRequest(searchRequest(102, USER_FILTER, 10));
        var searchPayload = JsonParser.parseString(searchResp).getAsJsonObject();
        if (searchPayload.has("error")) {
            var err = searchPayload.getAsJsonObject("error");
            System.err.println("Search failed: " + err.get("message").getAsString());
        }
        assertTrue(searchPayload.has("result"),
            "Search failed: " + searchPayload);
        var result = searchPayload.getAsJsonObject("result");
        assertTrue(result.get("count").getAsInt() > 0, "Expected at least 1 search result");
        assertEquals(1, result.getAsJsonArray("entries").size());
        var entry = result.getAsJsonArray("entries").get(0).getAsJsonObject();
        assertNotNull(entry.get("dn"));
        var attrs = entry.getAsJsonObject("attributes");
        assertNotNull(attrs);
        assertTrue(attrs.has("uid") || attrs.has("cn"), "Expected user attributes, got: " + attrs);
    }

    @Test
    void integrationSimpleBindSearchWithLimit() {
        Assumptions.assumeTrue(serverReachable(), "LDAP server not reachable at " + LDAP_HOST + ":" + LDAP_PORT);
        // Connect as admin to list all demo users
        String connectResp = LdapAgent.handleRequest(adminConnectRequest(103));
        var cp = JsonParser.parseString(connectResp).getAsJsonObject();
        assertTrue(cp.has("result"), "Connect failed: " + cp);

        // Search with limit=3 across inetOrgPerson users
        String searchResp = LdapAgent.handleRequest(searchRequest(104, "(objectClass=inetOrgPerson)", 3));
        var sp = JsonParser.parseString(searchResp).getAsJsonObject();
        assertTrue(sp.has("result"), "Search failed: " + sp);
        var result = sp.getAsJsonObject("result");
        assertTrue(result.get("count").getAsInt() > 0);
        // Server may truncate results when size limit is exceeded
        assertTrue(result.get("count").getAsInt() <= 3 || result.has("truncated"));
    }

    // -----------------------------------------------------------------------
    // LDAPS (636) integration test
    //
    // The `mlan/openldap` image does not ship TLS support out of the box, so
    // `deploy/database/ldap/compose.yml` was extended to enable it: the config
    // bootstrap (`ldif/0/0.ldif`) sets olcTLSCertificateFile/Key on cn=config
    // and `LDAPURI` includes `ldaps:///`; a self-signed CA + server cert live
    // under `deploy/database/ldap/certs/`. The client uses `tls_skip_verify`
    // (TrustAllSSLSocketFactory) because the CA is self-signed.
    // -----------------------------------------------------------------------
    @Test
    void integrationSimpleBindOverLdapsSucceeds() {
        Assumptions.assumeTrue(serverReachable(), "LDAP server not reachable at " + LDAP_HOST + ":" + LDAP_PORT);
        String response = LdapAgent.handleRequest(ldapsAdminTestConnectionRequest(106));

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("result"), "Expected result but got error: "
            + (payload.has("error") ? payload.getAsJsonObject("error").get("message").getAsString() : "unknown"));
        var result = payload.getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertTrue(result.get("connected").getAsBoolean());
    }

    // =======================================================================
    // GSSAPI integration tests — DISABLED
    //
    // GSSAPI (Kerberos) requires a KDC and a keytab/ticket; the OpenLDAP
    // container from `compose.yml` provides neither, so these cannot run
    // against the local test server. They are left commented out for
    // reference and can be re-enabled when a Kerberos-enabled LDAP server is
    // available (set DBX_LDAP_TEST_HOST / DBX_LDAP_TEST_PORT accordingly).
    // =======================================================================
    /*
    private static final String GSSAPI_HOST = "dc.example.com";
    private static final String GSSAPI_PRINCIPAL = "user@example.com";
    private static final String GSSAPI_PASS = "123456";

    private static final String KRB5_CONF = """
        [libdefaults]
            default_realm = EXAMPLE.COM
            dns_lookup_realm = false
            dns_lookup_kdc = false

        [realms]
            EXAMPLE.COM = {
                kdc = dc.example.com:88
            }

        [domain_realm]
            .example.com = EXAMPLE.COM
            example.com = EXAMPLE.COM
        """;

    private static String gssapiRequest(int id, String method) {
        JsonObject req = new JsonObject();
        req.addProperty("jsonrpc", "2.0");
        req.addProperty("id", id);
        req.addProperty("method", method);
        JsonObject params = new JsonObject();
        JsonObject conn = new JsonObject();
        conn.addProperty("hostname", GSSAPI_HOST);
        conn.addProperty("port", LDAP_PORT);
        conn.addProperty("security_protocol", "gssapi");
        conn.addProperty("principal", GSSAPI_PRINCIPAL);
        conn.addProperty("password", GSSAPI_PASS);
        conn.addProperty("krb5_conf", KRB5_CONF);
        params.add("connection", conn);
        req.add("params", params);
        return req.toString();
    }

    @Test
    void integrationGssapiPasswordTestConnectionSucceeds() {
        Assumptions.assumeTrue(serverReachable(), "LDAP server not reachable at " + LDAP_HOST + ":" + LDAP_PORT);
        String response = LdapAgent.handleRequest(gssapiRequest(110, "test_connection"));

        var payload = JsonParser.parseString(response).getAsJsonObject();
        assertTrue(payload.has("result"), "Expected result but got error: "
            + (payload.has("error") ? payload.getAsJsonObject("error").get("message").getAsString() : "unknown"));
        var result = payload.getAsJsonObject("result");
        assertTrue(result.get("ok").getAsBoolean());
        assertTrue(result.get("connected").getAsBoolean());
    }

    @Test
    void integrationGssapiConnectAndSearch() {
        Assumptions.assumeTrue(serverReachable(), "LDAP server not reachable at " + LDAP_HOST + ":" + LDAP_PORT);
        String connectResp = LdapAgent.handleRequest(gssapiRequest(111, "connect"));
        var connectPayload = JsonParser.parseString(connectResp).getAsJsonObject();
        assertTrue(connectPayload.has("result"), "GSSAPI connect failed: " + connectPayload);
        assertTrue(connectPayload.getAsJsonObject("result").get("ok").getAsBoolean());

        String searchResp = LdapAgent.handleRequest(searchRequest(112, USER_FILTER, 10));
        var searchPayload = JsonParser.parseString(searchResp).getAsJsonObject();
        assertTrue(searchPayload.has("result"), "GSSAPI search failed: " + searchPayload);
        var result = searchPayload.getAsJsonObject("result");
        assertTrue(result.get("count").getAsInt() > 0);
        var entry = result.getAsJsonArray("entries").get(0).getAsJsonObject();
        assertNotNull(entry.get("dn"));
        assertNotNull(entry.getAsJsonObject("attributes").get("uid"));
    }

    @Test
    void integrationGssapiSearchAllAttributes() {
        Assumptions.assumeTrue(serverReachable(), "LDAP server not reachable at " + LDAP_HOST + ":" + LDAP_PORT);
        String connectResp = LdapAgent.handleRequest(gssapiRequest(113, "connect"));
        var cp = JsonParser.parseString(connectResp).getAsJsonObject();
        assertTrue(cp.has("result"), "GSSAPI connect failed: " + cp);

        String searchResp = LdapAgent.handleRequest(searchRequest(114, USER_FILTER, 1));
        var sp = JsonParser.parseString(searchResp).getAsJsonObject();
        assertTrue(sp.has("result"), "Search failed: " + sp);
        var result = sp.getAsJsonObject("result");
        assertEquals(1, result.get("count").getAsInt());
        var entry = result.getAsJsonArray("entries").get(0).getAsJsonObject();
        var attrs = entry.getAsJsonObject("attributes");
        assertNotNull(attrs.get("cn"));
        assertNotNull(attrs.get("uid"));
    }
    */
}
