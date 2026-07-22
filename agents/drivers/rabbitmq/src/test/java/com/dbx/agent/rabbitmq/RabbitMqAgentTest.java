package com.dbx.agent.rabbitmq;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.rabbitmq.client.AMQP;
import com.rabbitmq.client.Address;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.ConnectionFactory;
import com.rabbitmq.client.ShutdownSignalException;
import com.rabbitmq.client.impl.AMQImpl;
import com.sun.net.httpserver.HttpServer;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class RabbitMqAgentTest {

    // -------------------------------------------------------------------
    // Address parsing
    // -------------------------------------------------------------------

    @Test
    void parsesCommaSeparatedHostPortPairs() {
        List<Address> addresses = RabbitMqAgent.parseAddresses("a:5672, b:5673", 5672);
        assertEquals(2, addresses.size());
        assertEquals("a", addresses.get(0).getHost());
        assertEquals(5672, addresses.get(0).getPort());
        assertEquals("b", addresses.get(1).getHost());
        assertEquals(5673, addresses.get(1).getPort());
    }

    @Test
    void bareHostFallsBackToDefaultPort() {
        List<Address> addresses = RabbitMqAgent.parseAddresses("rabbit.internal", 5672);
        assertEquals(1, addresses.size());
        assertEquals("rabbit.internal", addresses.get(0).getHost());
        assertEquals(5672, addresses.get(0).getPort());
    }

    @Test
    void skipsBlankAddressEntries() {
        List<Address> addresses = RabbitMqAgent.parseAddresses(" a:5672,, ", 5672);
        assertEquals(1, addresses.size());
        assertEquals("a", addresses.get(0).getHost());
    }

    @Test
    void rejectsBlankAddressList() {
        assertThrows(IllegalArgumentException.class, () -> RabbitMqAgent.parseAddresses(" , ", 5672));
    }

    @Test
    void resolveAddressesUsesPortParameterForBareHosts() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "host1,host2:5673", "port": 5670 }
            """).getAsJsonObject();
        List<Address> addresses = RabbitMqAgent.resolveAddresses(conn);
        assertEquals(2, addresses.size());
        assertEquals(5670, addresses.get(0).getPort());
        assertEquals(5673, addresses.get(1).getPort());
    }

    @Test
    void resolveAddressesDefaultsToAmqpPort() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "host1" }
            """).getAsJsonObject();
        List<Address> addresses = RabbitMqAgent.resolveAddresses(conn);
        assertEquals(5672, addresses.get(0).getPort());
    }

    @Test
    void resolveAddressesRequiresAddresses() {
        JsonObject conn = JsonParser.parseString("""
            { "username": "guest" }
            """).getAsJsonObject();
        assertThrows(IllegalArgumentException.class, () -> RabbitMqAgent.resolveAddresses(conn));
    }

    // -------------------------------------------------------------------
    // Peek normalization
    // -------------------------------------------------------------------

    @Test
    void normalizesNegativePeekOffsetToZero() {
        assertEquals(0L, RabbitMqAgent.normalizePeekOffset(-5));
    }

    @Test
    void keepsPositivePeekOffset() {
        assertEquals(7L, RabbitMqAgent.normalizePeekOffset(7));
    }

    @Test
    void normalizesPeekCountToAtLeastOne() {
        assertEquals(1, RabbitMqAgent.normalizePeekCount(0));
        assertEquals(1, RabbitMqAgent.normalizePeekCount(-3));
        assertEquals(10, RabbitMqAgent.normalizePeekCount(10));
    }

    // -------------------------------------------------------------------
    // Send routing key resolution
    // -------------------------------------------------------------------

    @Test
    void routingKeyFallsBackToMessageKeyThenQueue() {
        assertEquals("q1", RabbitMqAgent.resolveRoutingKey(JsonParser.parseString("""
            { "topic": "q1" }
            """).getAsJsonObject(), "q1"));
        assertEquals("orders.new", RabbitMqAgent.resolveRoutingKey(JsonParser.parseString("""
            { "topic": "q1", "key": "orders.new" }
            """).getAsJsonObject(), "q1"));
        assertEquals("rk", RabbitMqAgent.resolveRoutingKey(JsonParser.parseString("""
            { "topic": "q1", "key": "orders.new", "routing_key": "rk" }
            """).getAsJsonObject(), "q1"));
        assertEquals("rk2", RabbitMqAgent.resolveRoutingKey(JsonParser.parseString("""
            { "topic": "q1", "routingKey": "rk2" }
            """).getAsJsonObject(), "q1"));
    }

    @Test
    void blankRoutingKeyFallsBackToQueue() {
        assertEquals("q1", RabbitMqAgent.resolveRoutingKey(JsonParser.parseString("""
            { "topic": "q1", "key": "" }
            """).getAsJsonObject(), "q1"));
        assertEquals("q1", RabbitMqAgent.resolveRoutingKey(JsonParser.parseString("""
            { "topic": "q1", "key": "   " }
            """).getAsJsonObject(), "q1"));
        assertEquals("q1", RabbitMqAgent.resolveRoutingKey(JsonParser.parseString("""
            { "topic": "q1", "routing_key": "", "key": "" }
            """).getAsJsonObject(), "q1"));
    }

    // -------------------------------------------------------------------
    // Connection factory
    // -------------------------------------------------------------------

    @Test
    void buildsConnectionFactoryWithDefaults() throws Exception {
        ConnectionFactory factory = RabbitMqAgent.buildConnectionFactory(JsonParser.parseString("""
            { "addresses": "localhost" }
            """).getAsJsonObject());
        assertEquals("guest", factory.getUsername());
        assertEquals("/", factory.getVirtualHost());
    }

    @Test
    void buildsConnectionFactoryWithVirtualHostAndCredentials() throws Exception {
        ConnectionFactory factory = RabbitMqAgent.buildConnectionFactory(JsonParser.parseString("""
            { "addresses": "localhost", "username": "dbx", "password": "secret", "virtual_host": "/tenant" }
            """).getAsJsonObject());
        assertEquals("dbx", factory.getUsername());
        assertEquals("/tenant", factory.getVirtualHost());
    }

    @Test
    void appliesExtraPropertiesToConnectionFactory() throws Exception {
        ConnectionFactory factory = RabbitMqAgent.buildConnectionFactory(JsonParser.parseString("""
            {
              "addresses": "localhost",
              "properties": {
                "requested_heartbeat": 30,
                "connection_timeout_ms": 5000,
                "automatic_recovery": false
              }
            }
            """).getAsJsonObject());
        assertEquals(30, factory.getRequestedHeartbeat());
        assertEquals(5000, factory.getConnectionTimeout());
        assertFalse(factory.isAutomaticRecoveryEnabled());
    }

    @Test
    void enablesTlsWithoutVerificationWhenSkipVerifyRequested() throws Exception {
        ConnectionFactory factory = RabbitMqAgent.buildConnectionFactory(JsonParser.parseString("""
            { "addresses": "localhost", "tls_skip_verify": true }
            """).getAsJsonObject());
        assertTrue(factory.isSSL());
    }

    // -------------------------------------------------------------------
    // Management API helpers
    // -------------------------------------------------------------------

    @Test
    void buildsBasicAuthHeader() {
        assertEquals("Basic Z3Vlc3Q6Z3Vlc3Q=", RabbitMqAgent.basicAuthHeader("guest", "guest"));
    }

    @Test
    void buildsManagementBaseUrl() {
        assertEquals("http://localhost:15672", RabbitMqAgent.managementBaseUrl("localhost", 15672, false));
        assertEquals("https://mq:15671", RabbitMqAgent.managementBaseUrl("mq", 15671, true));
    }

    @Test
    void managementPortDefaultsTo15672Or15671ForTls() {
        JsonObject plain = JsonParser.parseString("""
            { "addresses": "localhost" }
            """).getAsJsonObject();
        assertEquals(15672, RabbitMqAgent.managementPort(plain, false));
        assertEquals(15671, RabbitMqAgent.managementPort(plain, true));
    }

    @Test
    void managementPortCanBeOverriddenViaProperties() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "localhost", "properties": { "management_port": 55672 } }
            """).getAsJsonObject();
        assertEquals(55672, RabbitMqAgent.managementPort(conn, false));
    }

    @Test
    void managementErrorMessageBlamesCredentialsOn401And403() {
        for (int status : new int[] {401, 403}) {
            String message = RabbitMqAgent.managementErrorMessage(status, "GET", "/api/queues");
            assertTrue(message.contains("HTTP " + status), message);
            assertTrue(message.contains("management permission tag"), message);
            assertFalse(message.contains("rabbitmq_management plugin must be enabled"), message);
        }
    }

    @Test
    void managementErrorMessageKeepsPluginHintForOtherStatuses() {
        String message = RabbitMqAgent.managementErrorMessage(404, "GET", "/api/queues/%2F/gone");
        assertTrue(message.contains("HTTP 404"));
        assertTrue(message.contains("rabbitmq_management plugin must be enabled"));
        assertFalse(message.contains("management permission tag"));
    }

    @Test
    void managementRequestSurfaces401AsCredentialError() throws Exception {
        // A local stub server standing in for the management API: the agent must
        // attribute a 401 to credentials/permissions, not to a missing plugin.
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api", exchange -> {
            exchange.sendResponseHeaders(401, -1);
            exchange.close();
        });
        server.start();
        try {
            JsonObject conn = JsonParser.parseString("""
                { "addresses": "127.0.0.1", "properties": { "management_port": %d } }
                """.formatted(server.getAddress().getPort())).getAsJsonObject();
            Exception error = assertThrows(IllegalStateException.class,
                () -> RabbitMqAgent.managementGet(conn, "/api/queues"));
            assertTrue(error.getMessage().contains("HTTP 401"), error.getMessage());
            assertTrue(error.getMessage().contains("management permission tag"), error.getMessage());
            assertFalse(error.getMessage().contains("plugin must be enabled"), error.getMessage());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void explicitManagementUrlIsUsedVerbatimWithTrailingSlashTrimmed() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "mq1:5672,mq2:5672", "management_url": "https://proxy:8443/rmq/" }
            """).getAsJsonObject();
        assertEquals(List.of("https://proxy:8443/rmq"), RabbitMqAgent.managementBaseUrls(conn));
    }

    @Test
    void explicitManagementUrlDoesNotRequireAddresses() {
        JsonObject conn = JsonParser.parseString("""
            { "management_url": "http://mgmt:15672" }
            """).getAsJsonObject();
        assertEquals(List.of("http://mgmt:15672"), RabbitMqAgent.managementBaseUrls(conn));
    }

    @Test
    void derivedManagementBaseUrlsCoverAllAddresses() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "mq1:5672,mq2:5673" }
            """).getAsJsonObject();
        assertEquals(List.of("http://mq1:15672", "http://mq2:15672"),
            RabbitMqAgent.managementBaseUrls(conn));
    }

    @Test
    void tlsSkipVerifyAloneDoesNotFlipDerivedSchemeToHttps() {
        // tls_skip_verify is a verification flag, not a scheme indicator.
        JsonObject skipVerifyOnly = JsonParser.parseString("""
            { "addresses": "mq1", "tls_skip_verify": true }
            """).getAsJsonObject();
        assertEquals(List.of("http://mq1:15672"), RabbitMqAgent.managementBaseUrls(skipVerifyOnly));

        JsonObject tlsObject = JsonParser.parseString("""
            { "addresses": "mq1", "tls": { "skip_verify": true } }
            """).getAsJsonObject();
        assertEquals(List.of("https://mq1:15671"), RabbitMqAgent.managementBaseUrls(tlsObject));

        JsonObject sslProperty = JsonParser.parseString("""
            { "addresses": "mq1", "properties": { "ssl": true } }
            """).getAsJsonObject();
        assertEquals(List.of("https://mq1:15671"), RabbitMqAgent.managementBaseUrls(sslProperty));
    }

    @Test
    void blankCredentialsFallBackToGuest() throws Exception {
        ConnectionFactory factory = RabbitMqAgent.buildConnectionFactory(JsonParser.parseString("""
            { "addresses": "localhost", "username": "", "password": "   " }
            """).getAsJsonObject());
        assertEquals("guest", factory.getUsername());
        assertEquals("guest", factory.getPassword());

        ConnectionFactory nullCredentials = RabbitMqAgent.buildConnectionFactory(JsonParser.parseString("""
            { "addresses": "localhost", "username": null }
            """).getAsJsonObject());
        assertEquals("guest", nullCredentials.getUsername());
    }

    @Test
    void managementGetAllPaginatesToLastPage() throws Exception {
        List<Integer> requestedPages = new ArrayList<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/queues", exchange -> {
            String query = exchange.getRequestURI().getQuery();
            int page = Integer.parseInt(query.replaceAll(".*page=(\\d+).*", "$1"));
            requestedPages.add(page);
            byte[] body = switch (page) {
                case 1 -> """
                    { "items": [ { "name": "q1" } ], "page": 1, "page_count": 3, "total_count": 3 }
                    """.getBytes(StandardCharsets.UTF_8);
                case 2 -> """
                    { "items": [ { "name": "q2" } ], "page": 2, "page_count": 3, "total_count": 3 }
                    """.getBytes(StandardCharsets.UTF_8);
                default -> """
                    { "items": [ { "name": "q3" } ], "page": 3, "page_count": 3, "total_count": 3 }
                    """.getBytes(StandardCharsets.UTF_8);
            };
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            JsonObject conn = JsonParser.parseString("""
                { "addresses": "127.0.0.1", "properties": { "management_port": %d } }
                """.formatted(server.getAddress().getPort())).getAsJsonObject();
            JsonArray all = RabbitMqAgent.managementGetAll(conn, "/api/queues");
            assertEquals(3, all.size());
            assertEquals("q1", all.get(0).getAsJsonObject().get("name").getAsString());
            assertEquals("q3", all.get(2).getAsJsonObject().get("name").getAsString());
            assertEquals(List.of(1, 2, 3), requestedPages);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void managementGetAllAcceptsPlainArrayResponse() throws Exception {
        List<String> requests = new ArrayList<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/users", exchange -> {
            requests.add(exchange.getRequestURI().toString());
            byte[] body = """
                [ { "name": "guest", "tags": "administrator" } ]
                """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            JsonObject conn = JsonParser.parseString("""
                { "addresses": "127.0.0.1", "properties": { "management_port": %d } }
                """.formatted(server.getAddress().getPort())).getAsJsonObject();
            JsonArray all = RabbitMqAgent.managementGetAll(conn, "/api/users");
            assertEquals(1, all.size());
            // A plain-array answer means the broker ignored pagination: stop there.
            assertEquals(1, requests.size());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void managementRequestFailsOverAcrossDerivedCandidates() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/queues", exchange -> {
            byte[] body = "[]".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            // 127.0.0.2 refuses the connection; the second candidate answers.
            JsonObject conn = JsonParser.parseString("""
                { "addresses": "127.0.0.2,127.0.0.1", "properties": { "management_port": %d } }
                """.formatted(server.getAddress().getPort())).getAsJsonObject();
            assertTrue(RabbitMqAgent.managementGet(conn, "/api/queues").isJsonArray());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void httpErrorStatusDoesNotTriggerFailover() throws Exception {
        HttpServer rejecting = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        rejecting.createContext("/api", exchange -> {
            exchange.sendResponseHeaders(401, -1);
            exchange.close();
        });
        rejecting.start();
        int port = rejecting.getAddress().getPort();
        try {
            JsonObject conn = JsonParser.parseString("""
                { "addresses": "127.0.0.1,127.0.0.2", "properties": { "management_port": %d } }
                """.formatted(port)).getAsJsonObject();
            Exception error = assertThrows(IllegalStateException.class,
                () -> RabbitMqAgent.managementGet(conn, "/api/queues"));
            // If the second candidate were attempted, its connection failure
            // would replace this terminal HTTP status with an I/O error.
            assertTrue(error.getMessage().contains("HTTP 401"), error.getMessage());
        } finally {
            rejecting.stop(0);
        }
    }

    @Test
    void managementUrlWithPathPrefixReachesStub() throws Exception {
        List<String> requests = new ArrayList<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/rmq/api/queues", exchange -> {
            requests.add(exchange.getRequestURI().getRawPath());
            byte[] body = """
                [ { "name": "dbx-q1", "durable": true, "state": "running" } ]
                """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            JsonObject response = JsonParser.parseString(RabbitMqAgent.handleRequest("""
                { "jsonrpc": "2.0", "id": 70, "method": "mq_list_topics",
                  "params": { "connection": { "addresses": "192.0.2.1:5672",
                                              "management_url": "http://127.0.0.1:%d/rmq/" } } }
                """.formatted(server.getAddress().getPort()))).getAsJsonObject();
            JsonArray topics = response.getAsJsonObject("result").getAsJsonArray("topics");
            assertEquals("dbx-q1", topics.get(0).getAsJsonObject().get("name").getAsString());
            // The reverse-proxy path prefix is preserved verbatim.
            assertEquals("/rmq/api/queues/%2F", requests.get(0));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void encodesDefaultVhostForManagementApi() {
        assertEquals("%2F", RabbitMqAgent.urlEncodeVhost("/"));
        assertEquals("tenant-a", RabbitMqAgent.urlEncodeVhost("tenant-a"));
    }

    @Test
    void urlEncodePathSegmentEncodesSpacesAsPercent20() {
        // URLEncoder's form-style '+' for spaces 404s on the management API.
        assertEquals("dbx-space%20test", RabbitMqAgent.urlEncodePathSegment("dbx-space test"));
        assertEquals("plain-name", RabbitMqAgent.urlEncodePathSegment("plain-name"));
        assertEquals("a%2Fb%3Ac", RabbitMqAgent.urlEncodePathSegment("a/b:c"));
        assertEquals("%E4%B8%AD%E6%96%87%20queue", RabbitMqAgent.urlEncodePathSegment("中文 queue"));
    }

    @Test
    void tlsSkipVerifyReadsTopLevelAndNestedFlags() {
        assertFalse(RabbitMqAgent.tlsSkipVerify(JsonParser.parseString("""
            { "addresses": "localhost" }
            """).getAsJsonObject()));
        assertTrue(RabbitMqAgent.tlsSkipVerify(JsonParser.parseString("""
            { "addresses": "localhost", "tls_skip_verify": true }
            """).getAsJsonObject()));
        assertTrue(RabbitMqAgent.tlsSkipVerify(JsonParser.parseString("""
            { "addresses": "localhost", "tls": { "skip_verify": true } }
            """).getAsJsonObject()));
        assertFalse(RabbitMqAgent.tlsSkipVerify(JsonParser.parseString("""
            { "addresses": "localhost", "tls": { "skip_verify": false } }
            """).getAsJsonObject()));
    }

    // -------------------------------------------------------------------
    // JSON-RPC envelope (no broker required)
    // -------------------------------------------------------------------

    @Test
    void handshakeReportsCapabilities() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 1, "method": "handshake", "params": {} }
            """);
        JsonObject result = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("result");
        assertEquals(1, result.get("protocolVersion").getAsInt());
        assertTrue(result.getAsJsonArray("capabilities").toString().contains("mq_topics"));
        assertTrue(result.getAsJsonArray("capabilities").toString().contains("mq_messages"));
    }

    @Test
    void unknownMethodReturnsError() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 2, "method": "mq_bogus", "params": {} }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("Unknown method"));
    }

    @Test
    void topicOperationsRequireConnection() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 3, "method": "mq_create_topic", "params": { "name": "q1" } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("Not connected"));
    }

    @Test
    void alterTopicConfigIsRejectedAsUnsupported() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 4, "method": "mq_alter_topic_config", "params": { "name": "q1", "configs": [] } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("immutable"));
    }

    @Test
    void testConnectionFailsFastWithoutAddresses() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 5, "method": "test_connection", "params": { "connection": { "addresses": "" } } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("addresses is required"));
    }

    @Test
    void malformedRequestReturnsErrorWithNullId() {
        // A request that is not valid JSON must not kill the agent process.
        JsonObject response = JsonParser.parseString(
            RabbitMqAgent.handleRequest("this is not json")).getAsJsonObject();
        assertTrue(response.get("id").isJsonNull());
        assertEquals(-1, response.getAsJsonObject("error").get("code").getAsInt());

        JsonObject notAnObject = JsonParser.parseString(
            RabbitMqAgent.handleRequest("[1, 2, 3]")).getAsJsonObject();
        assertTrue(notAnObject.get("id").isJsonNull());
        assertTrue(notAnObject.has("error"));
    }

    @Test
    void missingMethodReturnsErrorButKeepsRequestId() {
        JsonObject response = JsonParser.parseString(RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 6, "params": {} }
            """)).getAsJsonObject();
        assertEquals(6, response.get("id").getAsInt());
        assertEquals(-1, response.getAsJsonObject("error").get("code").getAsInt());
    }

    // -------------------------------------------------------------------
    // all_vhosts fail-fast on non-list operations
    // -------------------------------------------------------------------

    @Test
    void allVhostsIsRejectedForNonListOperations() {
        List<String> methods = List.of(
            "mq_create_topic", "mq_delete_topic", "mq_purge_queue", "mq_send_message",
            "mq_bind", "mq_unbind", "mq_create_exchange", "mq_delete_exchange",
            "mq_peek_messages", "mq_get_topic_stats", "mq_list_consumers", "mq_close_connection");
        for (String method : methods) {
            JsonObject response = JsonParser.parseString(RabbitMqAgent.handleRequest("""
                { "jsonrpc": "2.0", "id": 40, "method": "%s",
                  "params": { "all_vhosts": true, "topic": "q1", "name": "q1",
                              "source": "ex1", "destination": "q1", "destinationType": "queue",
                              "type": "direct" } }
                """.formatted(method))).getAsJsonObject();
            JsonObject error = response.getAsJsonObject("error");
            assertEquals(-1, error.get("code").getAsInt(), method);
            assertEquals("all_vhosts is only supported for list operations",
                error.get("message").getAsString(), method);
        }
    }

    @Test
    void allVhostsRejectionPrecedesConnectionCheck() {
        // The semantic error must win over "Not connected": no broker is needed.
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 41, "method": "mq_purge_queue",
              "params": { "all_vhosts": true, "topic": "q1" } }
            """);
        String message = JsonParser.parseString(response).getAsJsonObject()
            .getAsJsonObject("error").get("message").getAsString();
        assertTrue(message.contains("all_vhosts is only supported for list operations"));
        assertFalse(message.contains("Not connected"));
    }

    @Test
    void listOperationsStillAcceptAllVhosts() {
        // Without a connection these fail with "Not connected", proving the
        // all_vhosts guard did not reject them first.
        for (String method : List.of("mq_list_topics", "mq_list_exchanges", "mq_list_bindings",
                "mq_list_connections", "mq_list_channels")) {
            JsonObject response = JsonParser.parseString(RabbitMqAgent.handleRequest("""
                { "jsonrpc": "2.0", "id": 42, "method": "%s", "params": { "all_vhosts": true } }
                """.formatted(method))).getAsJsonObject();
            String message = response.getAsJsonObject("error").get("message").getAsString();
            assertTrue(message.contains("Not connected"), method + ": " + message);
        }
    }

    // -------------------------------------------------------------------
    // Effective virtual host resolution
    // -------------------------------------------------------------------

    @Test
    void explicitVirtualHostParameterWins() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "localhost", "virtual_host": "/default" }
            """).getAsJsonObject();
        JsonObject params = JsonParser.parseString("""
            { "topic": "q1", "virtual_host": "/tenant" }
            """).getAsJsonObject();
        assertEquals("/tenant", RabbitMqAgent.effectiveVhost(params, conn));
    }

    @Test
    void blankVirtualHostFallsBackToConnectionVhost() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "localhost", "virtual_host": "/default" }
            """).getAsJsonObject();
        assertEquals("/default", RabbitMqAgent.effectiveVhost(JsonParser.parseString("""
            { "topic": "q1", "virtual_host": "" }
            """).getAsJsonObject(), conn));
        assertEquals("/default", RabbitMqAgent.effectiveVhost(JsonParser.parseString("""
            { "topic": "q1", "virtual_host": "   " }
            """).getAsJsonObject(), conn));
        assertEquals("/default", RabbitMqAgent.effectiveVhost(JsonParser.parseString("""
            { "topic": "q1", "virtual_host": null }
            """).getAsJsonObject(), conn));
    }

    @Test
    void missingVirtualHostFallsBackToConnectionThenSlash() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "localhost", "virtual_host": "/default" }
            """).getAsJsonObject();
        JsonObject params = JsonParser.parseString("""
            { "topic": "q1" }
            """).getAsJsonObject();
        assertEquals("/default", RabbitMqAgent.effectiveVhost(params, conn));
        assertEquals("/", RabbitMqAgent.effectiveVhost(params, null));
        JsonObject noVhostConn = JsonParser.parseString("""
            { "addresses": "localhost" }
            """).getAsJsonObject();
        assertEquals("/", RabbitMqAgent.effectiveVhost(params, noVhostConn));
    }

    // -------------------------------------------------------------------
    // All-vhosts listing
    // -------------------------------------------------------------------

    @Test
    void allVhostsRequestedDefaultsToFalse() {
        assertFalse(RabbitMqAgent.allVhostsRequested(JsonParser.parseString("""
            { "virtual_host": "/tenant" }
            """).getAsJsonObject()));
        assertFalse(RabbitMqAgent.allVhostsRequested(JsonParser.parseString("""
            { "all_vhosts": false }
            """).getAsJsonObject()));
        assertTrue(RabbitMqAgent.allVhostsRequested(JsonParser.parseString("""
            { "all_vhosts": true }
            """).getAsJsonObject()));
    }

    @Test
    void managementListPathScopesToEffectiveVhostByDefault() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "localhost", "virtual_host": "/default" }
            """).getAsJsonObject();
        assertEquals("/api/queues/%2Fdefault", RabbitMqAgent.managementListPath(
            JsonParser.parseString("{}").getAsJsonObject(), conn, "queues"));
        assertEquals("/api/exchanges/%2Ftenant", RabbitMqAgent.managementListPath(
            JsonParser.parseString("""
                { "virtual_host": "/tenant" }
                """).getAsJsonObject(), conn, "exchanges"));
        JsonObject noVhostConn = JsonParser.parseString("""
            { "addresses": "localhost" }
            """).getAsJsonObject();
        assertEquals("/api/bindings/%2F", RabbitMqAgent.managementListPath(
            JsonParser.parseString("{}").getAsJsonObject(), noVhostConn, "bindings"));
    }

    @Test
    void managementListPathUsesVhostlessVariantWhenAllVhosts() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "localhost", "virtual_host": "/default" }
            """).getAsJsonObject();
        JsonObject params = JsonParser.parseString("""
            { "all_vhosts": true }
            """).getAsJsonObject();
        assertEquals("/api/queues", RabbitMqAgent.managementListPath(params, conn, "queues"));
        assertEquals("/api/exchanges", RabbitMqAgent.managementListPath(params, conn, "exchanges"));
        assertEquals("/api/bindings", RabbitMqAgent.managementListPath(params, conn, "bindings"));
    }

    @Test
    void allVhostsWinsOverExplicitVirtualHost() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "localhost" }
            """).getAsJsonObject();
        JsonObject params = JsonParser.parseString("""
            { "all_vhosts": true, "virtual_host": "/tenant" }
            """).getAsJsonObject();
        assertEquals("/api/queues", RabbitMqAgent.managementListPath(params, conn, "queues"));
        assertEquals("", RabbitMqAgent.vhostFilter(params, conn));
    }

    @Test
    void vhostFilterPassesThroughExplicitVirtualHost() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "localhost", "virtual_host": "/default" }
            """).getAsJsonObject();
        assertEquals("/tenant", RabbitMqAgent.vhostFilter(JsonParser.parseString("""
            { "virtual_host": "/tenant" }
            """).getAsJsonObject(), conn));
    }

    @Test
    void vhostFilterFallsBackToConnectionVhost() {
        JsonObject conn = JsonParser.parseString("""
            { "addresses": "localhost", "virtual_host": "/default" }
            """).getAsJsonObject();
        JsonObject params = JsonParser.parseString("{}").getAsJsonObject();
        assertEquals("/default", RabbitMqAgent.vhostFilter(params, conn));
        assertEquals("/", RabbitMqAgent.vhostFilter(params, null));
        JsonObject noVhostConn = JsonParser.parseString("""
            { "addresses": "localhost" }
            """).getAsJsonObject();
        assertEquals("/", RabbitMqAgent.vhostFilter(params, noVhostConn));
    }

    @Test
    void attachVhostCopiesSourceVhost() {
        java.util.Map<String, Object> info = new java.util.LinkedHashMap<>();
        RabbitMqAgent.attachVhost(info, JsonParser.parseString("""
            { "name": "q1", "vhost": "/tenant-a" }
            """).getAsJsonObject());
        assertEquals("/tenant-a", info.get("vhost"));

        java.util.Map<String, Object> missing = new java.util.LinkedHashMap<>();
        RabbitMqAgent.attachVhost(missing, JsonParser.parseString("""
            { "name": "q1" }
            """).getAsJsonObject());
        assertEquals("", missing.get("vhost"));
    }

    // -------------------------------------------------------------------
    // consumer_details mapping
    // -------------------------------------------------------------------

    @Test
    void mapsConsumerDetailsFromQueueInfo() {
        JsonObject info = JsonParser.parseString("""
            {
              "name": "q1",
              "consumer_details": [
                {
                  "consumer_tag": "amq.ctag-abc",
                  "ack_required": true,
                  "prefetch_count": 20,
                  "active": true,
                  "channel_details": { "name": "10.0.0.1:5672 -> 10.0.0.2:41234 (1)", "number": 1 }
                },
                {
                  "consumer_tag": "amq.ctag-def",
                  "ack_required": false,
                  "active": false
                }
              ]
            }
            """).getAsJsonObject();
        var consumers = RabbitMqAgent.consumersFromQueueInfo(info);
        assertEquals(2, consumers.size());

        var first = consumers.get(0);
        assertEquals("10.0.0.1:5672 -> 10.0.0.2:41234 (1)", first.get("name"));
        assertEquals("amq.ctag-abc", first.get("tag"));
        assertEquals(true, first.get("active"));
        assertEquals(true, first.get("ackRequired"));
        assertEquals(20, first.get("prefetch"));

        var second = consumers.get(1);
        assertEquals("", second.get("name"));
        assertEquals("amq.ctag-def", second.get("tag"));
        assertEquals(false, second.get("active"));
        assertEquals(false, second.get("ackRequired"));
        assertFalse(second.containsKey("prefetch"));
    }

    @Test
    void missingConsumerDetailsMapsToEmptyList() {
        assertTrue(RabbitMqAgent.consumersFromQueueInfo(JsonParser.parseString("""
            { "name": "q1" }
            """).getAsJsonObject()).isEmpty());
        assertTrue(RabbitMqAgent.consumersFromQueueInfo(JsonParser.parseString("""
            { "name": "q1", "consumer_details": [] }
            """).getAsJsonObject()).isEmpty());
    }

    // -------------------------------------------------------------------
    // Purge queue
    // -------------------------------------------------------------------

    @Test
    void purgeQueueRequiresTopic() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 10, "method": "mq_purge_queue", "params": {} }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("topic (queue name) is required"));
    }

    @Test
    void purgeQueueRequiresConnection() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 11, "method": "mq_purge_queue", "params": { "topic": "q1" } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("Not connected"));
    }

    // -------------------------------------------------------------------
    // Consumers / namespaces (no broker required)
    // -------------------------------------------------------------------

    @Test
    void listConsumersRequiresConnection() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 12, "method": "mq_list_consumers", "params": { "topic": "q1" } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("Not connected"));
    }

    @Test
    void listNamespacesRequiresConnection() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 13, "method": "mq_list_namespaces", "params": {} }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("Not connected"));
    }

    @Test
    void createNamespaceRequiresName() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 14, "method": "mq_create_namespace", "params": { "namespace": "  " } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("namespace is required"));
    }

    @Test
    void createNamespaceRejectsAllVhostsMarker() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 14, "method": "mq_create_namespace", "params": { "namespace": "*" } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("all-vhosts"));
    }

    @Test
    void deleteNamespaceRejectsAllVhostsMarker() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 15, "method": "mq_delete_namespace", "params": { "namespace": "*" } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("all-vhosts"));
    }

    @Test
    void deleteNamespaceRejectsDefaultVhost() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 15, "method": "mq_delete_namespace", "params": { "namespace": "/" } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("cannot be deleted"));
    }

    @Test
    void deleteNamespaceGuardRejectsConnectedVhost() {
        assertThrows(IllegalArgumentException.class,
            () -> RabbitMqAgent.assertNamespaceDeletable("/", null));
        assertThrows(IllegalArgumentException.class,
            () -> RabbitMqAgent.assertNamespaceDeletable("/tenant", "/tenant"));
        RabbitMqAgent.assertNamespaceDeletable("/tenant", "/");
        RabbitMqAgent.assertNamespaceDeletable("dbx-tier1-vhost", null);
    }

    // -------------------------------------------------------------------
    // Exchanges & bindings
    // -------------------------------------------------------------------

    @Test
    void validatesExchangeTypeWhitelist() {
        assertEquals("direct", RabbitMqAgent.validateExchangeType("direct"));
        assertEquals("fanout", RabbitMqAgent.validateExchangeType("fanout"));
        assertEquals("topic", RabbitMqAgent.validateExchangeType("topic"));
        assertEquals("headers", RabbitMqAgent.validateExchangeType("headers"));
        assertThrows(IllegalArgumentException.class, () -> RabbitMqAgent.validateExchangeType(""));
        assertThrows(IllegalArgumentException.class, () -> RabbitMqAgent.validateExchangeType("x-delayed-message"));
        assertThrows(IllegalArgumentException.class, () -> RabbitMqAgent.validateExchangeType("Direct"));
    }

    @Test
    void exchangeDeletionGuardRejectsDefaultAndBuiltIns() {
        assertThrows(IllegalArgumentException.class, () -> RabbitMqAgent.assertExchangeDeletable(""));
        assertThrows(IllegalArgumentException.class, () -> RabbitMqAgent.assertExchangeDeletable("amq.direct"));
        assertThrows(IllegalArgumentException.class, () -> RabbitMqAgent.assertExchangeDeletable("amq.topic"));
        RabbitMqAgent.assertExchangeDeletable("dbx-ex-change");
        RabbitMqAgent.assertExchangeDeletable("amqp.custom");
    }

    @Test
    void mapsExchangeInfoWithDefaultExchangeType() {
        var defaultExchange = RabbitMqAgent.exchangeInfoFromJson(JsonParser.parseString("""
            { "name": "", "type": "", "durable": true, "auto_delete": false, "internal": false }
            """).getAsJsonObject());
        assertEquals("", defaultExchange.get("name"));
        assertEquals("default", defaultExchange.get("type"));
        assertEquals(true, defaultExchange.get("durable"));
        assertEquals(false, defaultExchange.get("autoDelete"));
        assertEquals(false, defaultExchange.get("internal"));
    }

    @Test
    void mapsExchangeInfoKeepsDeclaredType() {
        var exchange = RabbitMqAgent.exchangeInfoFromJson(JsonParser.parseString("""
            { "name": "amq.topic", "type": "topic", "durable": true, "auto_delete": false, "internal": false }
            """).getAsJsonObject());
        assertEquals("amq.topic", exchange.get("name"));
        assertEquals("topic", exchange.get("type"));
    }

    @Test
    void mapsBindingInfoToCamelCase() {
        var binding = RabbitMqAgent.bindingInfoFromJson(JsonParser.parseString("""
            {
              "source": "dbx-ex-change",
              "destination": "dbx-ex-test",
              "destination_type": "queue",
              "routing_key": "dbx.key",
              "arguments": { "x-match": "all", "retries": 3, "drop": null }
            }
            """).getAsJsonObject());
        assertEquals("dbx-ex-change", binding.get("source"));
        assertEquals("dbx-ex-test", binding.get("destination"));
        assertEquals("queue", binding.get("destinationType"));
        assertEquals("dbx.key", binding.get("routingKey"));
        var arguments = (java.util.Map<?, ?>) binding.get("arguments");
        assertEquals("all", arguments.get("x-match"));
        assertEquals(3L, arguments.get("retries"));
        assertFalse(arguments.containsKey("drop"));
    }

    @Test
    void bindingInfoOmitsEmptyArguments() {
        var binding = RabbitMqAgent.bindingInfoFromJson(JsonParser.parseString("""
            {
              "source": "ex1",
              "destination": "ex2",
              "destination_type": "exchange",
              "routing_key": "",
              "arguments": {}
            }
            """).getAsJsonObject());
        assertEquals("exchange", binding.get("destinationType"));
        assertFalse(binding.containsKey("arguments"));
    }

    @Test
    void createExchangeRejectsInvalidTypeBeforeConnecting() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 20, "method": "mq_create_exchange",
              "params": { "name": "ex1", "type": "bogus" } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("Invalid exchange type"));
    }

    @Test
    void createExchangeRequiresName() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 21, "method": "mq_create_exchange",
              "params": { "name": " ", "type": "direct" } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("name is required"));
    }

    @Test
    void deleteExchangeRejectsDefaultAndBuiltInsBeforeConnecting() {
        String defaultResponse = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 22, "method": "mq_delete_exchange", "params": { "name": "" } }
            """);
        assertTrue(JsonParser.parseString(defaultResponse).getAsJsonObject().getAsJsonObject("error")
            .get("message").getAsString().contains("default exchange cannot be deleted"));

        String builtInResponse = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 23, "method": "mq_delete_exchange", "params": { "name": "amq.direct" } }
            """);
        assertTrue(JsonParser.parseString(builtInResponse).getAsJsonObject().getAsJsonObject("error")
            .get("message").getAsString().contains("built-in exchange 'amq.direct' cannot be deleted"));
    }

    @Test
    void listExchangesRequiresConnection() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 24, "method": "mq_list_exchanges", "params": {} }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("Not connected"));
    }

    @Test
    void listBindingsRequiresConnection() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 25, "method": "mq_list_bindings", "params": { "queue": "q1" } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("Not connected"));
    }

    @Test
    void bindRequiresSourceAndDestination() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 26, "method": "mq_bind",
              "params": { "source": "", "destination": "q1", "destinationType": "queue" } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("source is required"));
    }

    @Test
    void bindRejectsUnknownDestinationType() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 27, "method": "mq_bind",
              "params": { "source": "ex1", "destination": "q1", "destinationType": "stream" } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("destinationType must be 'queue' or 'exchange'"));
    }

    // -------------------------------------------------------------------
    // Client connections & channels
    // -------------------------------------------------------------------

    @Test
    void mapsClientConnectionInfoWithRatesAndConnectedAt() {
        var connection = RabbitMqAgent.clientConnectionInfoFromJson(JsonParser.parseString("""
            {
              "name": "10.0.0.1:52364 -> 10.0.0.2:5672",
              "user": "spring",
              "peer_host": "10.0.0.1",
              "peer_port": 52364,
              "state": "running",
              "channels": 3,
              "vhost": "/",
              "recv_oct_details": { "rate": 12.5 },
              "send_oct_details": { "rate": 0.0 },
              "connected_at": 1751900000000
            }
            """).getAsJsonObject());
        assertEquals("10.0.0.1:52364 -> 10.0.0.2:5672", connection.get("name"));
        assertEquals("spring", connection.get("user"));
        assertEquals("10.0.0.1", connection.get("peerHost"));
        assertEquals(52364L, connection.get("peerPort"));
        assertEquals("running", connection.get("state"));
        assertEquals(3L, connection.get("channels"));
        assertEquals(12.5, (Double) connection.get("recvRate"), 0.0001);
        assertEquals(0.0, (Double) connection.get("sendRate"), 0.0001);
        assertEquals(1751900000000L, connection.get("connectedAt"));
    }

    @Test
    void clientConnectionInfoOmitsMissingRatesAndConnectedAt() {
        var connection = RabbitMqAgent.clientConnectionInfoFromJson(JsonParser.parseString("""
            {
              "name": "c1",
              "user": "guest",
              "peer_host": "10.0.0.1",
              "peer_port": 1,
              "state": "blocked",
              "channels": 0
            }
            """).getAsJsonObject());
        assertEquals("c1", connection.get("name"));
        assertFalse(connection.containsKey("recvRate"));
        assertFalse(connection.containsKey("sendRate"));
        assertFalse(connection.containsKey("connectedAt"));
    }

    @Test
    void mapsChannelInfoToCamelCase() {
        var channel = RabbitMqAgent.channelInfoFromJson(JsonParser.parseString("""
            {
              "name": "10.0.0.1:52364 -> 10.0.0.2:5672 (1)",
              "connection_details": { "name": "10.0.0.1:52364 -> 10.0.0.2:5672" },
              "state": "running",
              "prefetch_count": 20,
              "messages_unacknowledged": 4,
              "consumer_count": 2
            }
            """).getAsJsonObject());
        assertEquals("10.0.0.1:52364 -> 10.0.0.2:5672 (1)", channel.get("name"));
        assertEquals("10.0.0.1:52364 -> 10.0.0.2:5672", channel.get("connectionName"));
        assertEquals("running", channel.get("state"));
        assertEquals(20, channel.get("prefetch"));
        assertEquals(4L, channel.get("messagesUnacked"));
        assertEquals(2L, channel.get("consumerCount"));
    }

    @Test
    void channelInfoOmitsMissingOptionalFields() {
        var channel = RabbitMqAgent.channelInfoFromJson(JsonParser.parseString("""
            { "name": "c (1)", "state": "running" }
            """).getAsJsonObject());
        assertFalse(channel.containsKey("connectionName"));
        assertFalse(channel.containsKey("prefetch"));
        assertFalse(channel.containsKey("messagesUnacked"));
        assertFalse(channel.containsKey("consumerCount"));
    }

    @Test
    void channelMatchesConnectionByDetailsNameOrNamePrefix() {
        var channel = RabbitMqAgent.channelInfoFromJson(JsonParser.parseString("""
            {
              "name": "10.0.0.1:52364 -> 10.0.0.2:5672 (1)",
              "connection_details": { "name": "10.0.0.1:52364 -> 10.0.0.2:5672" }
            }
            """).getAsJsonObject());
        assertTrue(RabbitMqAgent.channelMatchesConnection(channel, "10.0.0.1:52364 -> 10.0.0.2:5672"));
        // Prefix match works even without connection_details.
        var noDetails = RabbitMqAgent.channelInfoFromJson(JsonParser.parseString("""
            { "name": "10.0.0.1:52364 -> 10.0.0.2:5672 (1)" }
            """).getAsJsonObject());
        assertTrue(RabbitMqAgent.channelMatchesConnection(noDetails, "10.0.0.1:52364 -> 10.0.0.2:5672"));
        assertFalse(RabbitMqAgent.channelMatchesConnection(channel, "10.0.0.9:11111 -> 10.0.0.2:5672"));
        assertFalse(RabbitMqAgent.channelMatchesConnection(noDetails, "10.0.0.9:11111 -> 10.0.0.2:5672"));
    }

    @Test
    void urlEncodeNameEncodesSpacesAndArrows() {
        assertEquals("10.0.0.1%3A52364%20-%3E%2010.0.0.2%3A5672",
            RabbitMqAgent.urlEncodeName("10.0.0.1:52364 -> 10.0.0.2:5672"));
        assertEquals("plain-name", RabbitMqAgent.urlEncodeName("plain-name"));
    }

    @Test
    void listConnectionsRequiresConnection() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 30, "method": "mq_list_connections", "params": {} }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("Not connected"));
    }

    @Test
    void listChannelsRequiresConnection() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 31, "method": "mq_list_channels", "params": {} }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("Not connected"));
    }

    @Test
    void closeConnectionRequiresName() {
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 32, "method": "mq_close_connection", "params": { "name": "  " } }
            """);
        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");
        assertEquals(-1, error.get("code").getAsInt());
        assertTrue(error.get("message").getAsString().contains("name is required"));
    }

    // -------------------------------------------------------------------
    // AMQP error mapping
    // -------------------------------------------------------------------

    @Test
    void mapsResourceLockedToExclusiveQueueHint() {
        String message = RabbitMqAgent.mapAmqpError(405,
            "RESOURCE_LOCKED - cannot obtain exclusive access to locked queue "
                + "'springCloudBus.anonymous.abc' in vhost '/'");
        assertTrue(message.contains("Queue 'springCloudBus.anonymous.abc' is exclusive"));
        assertTrue(message.contains("owned by another connection"));
        assertTrue(message.contains("Hint:"));
        assertTrue(message.contains("management API"));
    }

    @Test
    void mapsResourceLockedWithoutQueueName() {
        String message = RabbitMqAgent.mapAmqpError(405, "RESOURCE_LOCKED");
        assertTrue(message.startsWith("The queue is exclusive"));
        assertTrue(message.contains("Hint:"));
    }

    @Test
    void mapsNotFoundToFriendlyQueueMessage() {
        String message = RabbitMqAgent.mapAmqpError(404, "NOT_FOUND - no queue 'gone' in vhost '/'");
        assertEquals("Queue 'gone' was not found."
            + " Hint: it may have been deleted, or it never existed on this virtual host.", message);
    }

    @Test
    void mapsNotFoundForExchange() {
        String message = RabbitMqAgent.mapAmqpError(404, "NOT_FOUND - no exchange 'ex1' in vhost '/'");
        assertTrue(message.startsWith("Exchange 'ex1' was not found."));
    }

    @Test
    void mapsPreconditionFailedToImmutableParametersHint() {
        String message = RabbitMqAgent.mapAmqpError(406,
            "PRECONDITION_FAILED - inequivalent arg 'durable' for queue 'q1' in vhost '/':"
                + " received 'false' but current is 'true'");
        // The resource name is the queue, not the mismatched argument.
        assertTrue(message.contains("Queue 'q1' already exists with different parameters."));
        assertFalse(message.contains("'durable' already exists"));
        assertTrue(message.contains("Hint:"));
        assertTrue(message.contains("immutable"));
        assertTrue(message.contains("delete and re-declare"));
    }

    @Test
    void mapsPreconditionFailedForExchange() {
        String message = RabbitMqAgent.mapAmqpError(406,
            "PRECONDITION_FAILED - inequivalent arg 'type' for exchange 'ex1' in vhost '/':"
                + " received 'fanout' but current is 'direct'");
        assertTrue(message.startsWith("Exchange 'ex1' already exists with different parameters."));
        assertTrue(message.contains("delete and re-declare the exchange"));
    }

    @Test
    void mapsPreconditionFailedWithoutResourceName() {
        String message = RabbitMqAgent.mapAmqpError(406, "PRECONDITION_FAILED");
        assertTrue(message.startsWith("The queue already exists with different parameters."));
        assertTrue(message.contains("Hint:"));
    }

    @Test
    void mapsAccessRefusedToPermissionHint() {
        String message = RabbitMqAgent.mapAmqpError(403,
            "ACCESS_REFUSED - access to queue 'q1' in vhost '/' refused for user 'dbx'");
        assertTrue(message.contains("Access to 'q1' was refused."));
        assertTrue(message.contains("Hint:"));
        assertTrue(message.contains("configure/write/read permissions"));
    }

    @Test
    void mapsAccessRefusedWithoutResourceName() {
        String message = RabbitMqAgent.mapAmqpError(403, "ACCESS_REFUSED");
        assertTrue(message.startsWith("Access to the requested resource was refused."));
        assertTrue(message.contains("Hint:"));
    }

    @Test
    void leavesOtherReplyCodesUnmapped() {
        assertNull(RabbitMqAgent.mapAmqpError(503, "COMMAND_INVALID"));
        assertNull(RabbitMqAgent.mapAmqpError(501, "FRAME_ERROR"));
    }

    @Test
    void extractsDeclaredResourceNameFromPreconditionFailedText() {
        assertEquals("q1", RabbitMqAgent.extractDeclaredResourceName(
            "PRECONDITION_FAILED - inequivalent arg 'durable' for queue 'q1' in vhost '/'"));
        assertEquals("ex1", RabbitMqAgent.extractDeclaredResourceName(
            "PRECONDITION_FAILED - inequivalent arg 'type' for exchange 'ex1' in vhost '/'"));
        assertNull(RabbitMqAgent.extractDeclaredResourceName("no resource here"));
        assertNull(RabbitMqAgent.extractDeclaredResourceName(null));
    }

    @Test
    void extractsFirstQuotedNameFromReplyText() {
        assertEquals("q1", RabbitMqAgent.extractQuotedName("NOT_FOUND - no queue 'q1' in vhost '/'"));
        assertNull(RabbitMqAgent.extractQuotedName("no quoted name here"));
        assertNull(RabbitMqAgent.extractQuotedName(null));
    }

    @Test
    void normalizeErrorMessageUsesAmqpFriendlyMapping() {
        ShutdownSignalException shutdown = new ShutdownSignalException(true, false,
            new AMQImpl.Channel.Close(405,
                "RESOURCE_LOCKED - cannot obtain exclusive access to locked queue 'q1' in vhost '/'",
                0, 0), null);
        String message = RabbitMqAgent.normalizeErrorMessage(
            new java.io.IOException("channel is already closed", shutdown));
        assertTrue(message.contains("Queue 'q1' is exclusive"));
        assertFalse(message.contains("RESOURCE_LOCKED"));
    }

    @Test
    void normalizeErrorMessageKeepsRawMessageForUnmappedCodes() {
        ShutdownSignalException shutdown = new ShutdownSignalException(true, false,
            new AMQImpl.Channel.Close(503, "COMMAND_INVALID - unknown method", 0, 0), null);
        String message = RabbitMqAgent.normalizeErrorMessage(new java.io.IOException("boom", shutdown));
        assertTrue(message.contains("COMMAND_INVALID"));
    }

    @Test
    void normalizeErrorMessagePassesThroughPlainExceptions() {
        String message = RabbitMqAgent.normalizeErrorMessage(new IllegalStateException("Not connected"));
        assertEquals("Not connected", message);
    }

    // -------------------------------------------------------------------
    // Users & permissions
    // -------------------------------------------------------------------

    @Test
    void mapsUserInfoWithTagsArray() {
        var user = RabbitMqAgent.userInfoFromJson(JsonParser.parseString("""
            { "name": "jjsd", "tags": "administrator,management" }
            """).getAsJsonObject());
        assertEquals("jjsd", user.get("name"));
        assertEquals(List.of("administrator", "management"), user.get("tags"));
    }

    @Test
    void parseUserTagsTrimsAndDropsBlanks() {
        assertEquals(List.of("administrator", "monitoring"),
            RabbitMqAgent.parseUserTags("administrator, monitoring,,"));
        assertTrue(RabbitMqAgent.parseUserTags("").isEmpty());
        assertTrue(RabbitMqAgent.parseUserTags(" , ").isEmpty());
    }

    @Test
    void userTagsParamAcceptsArrayOrString() {
        assertEquals("management,policymaker", RabbitMqAgent.userTagsParam(JsonParser.parseString("""
            { "tags": ["management", " policymaker "] }
            """).getAsJsonObject()));
        assertEquals("administrator", RabbitMqAgent.userTagsParam(JsonParser.parseString("""
            { "tags": "administrator" }
            """).getAsJsonObject()));
        assertEquals("", RabbitMqAgent.userTagsParam(JsonParser.parseString("""
            { "name": "dbx-test-user" }
            """).getAsJsonObject()));
    }

    @Test
    void mapsPermissionInfo() {
        var permission = RabbitMqAgent.permissionInfoFromJson(JsonParser.parseString("""
            { "user": "jjsd", "vhost": "/", "configure": ".*", "write": ".*", "read": ".*" }
            """).getAsJsonObject());
        assertEquals("jjsd", permission.get("user"));
        assertEquals("/", permission.get("vhost"));
        assertEquals(".*", permission.get("configure"));
        assertEquals(".*", permission.get("write"));
        assertEquals(".*", permission.get("read"));
    }

    @Test
    void permissionPatternDefaultsToMatchAll() {
        JsonObject params = JsonParser.parseString("""
            { "write": "^dbx-", "read": "" }
            """).getAsJsonObject();
        assertEquals(".*", RabbitMqAgent.permissionPattern(params, "configure"));
        assertEquals("^dbx-", RabbitMqAgent.permissionPattern(params, "write"));
        assertEquals(".*", RabbitMqAgent.permissionPattern(params, "read"));
    }

    @Test
    void permissionVhostRejectsBlankAndAllVhostsSentinel() {
        assertThrows(IllegalArgumentException.class, () -> RabbitMqAgent.permissionVhost(
            JsonParser.parseString("{}").getAsJsonObject()));
        assertThrows(IllegalArgumentException.class, () -> RabbitMqAgent.permissionVhost(
            JsonParser.parseString("""
                { "virtual_host": "*" }
                """).getAsJsonObject()));
        assertEquals("/", RabbitMqAgent.permissionVhost(JsonParser.parseString("""
            { "virtual_host": "/" }
            """).getAsJsonObject()));
    }

    @Test
    void userGuardRejectsConnectedUser() {
        assertThrows(IllegalArgumentException.class,
            () -> RabbitMqAgent.assertNotConnectedUser("delete", "jjsd", "jjsd"));
        assertThrows(IllegalArgumentException.class,
            () -> RabbitMqAgent.assertNotConnectedUser("create or modify", "jjsd", "jjsd"));
        RabbitMqAgent.assertNotConnectedUser("delete", "dbx-test-user", "jjsd");
    }

    @Test
    void createUserRequiresNameAndPassword() {
        String noName = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 50, "method": "mq_create_user", "params": { "password": "x" } }
            """);
        assertTrue(JsonParser.parseString(noName).getAsJsonObject().getAsJsonObject("error")
            .get("message").getAsString().contains("user name is required"));

        String noPassword = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 51, "method": "mq_create_user", "params": { "name": "dbx-test-user" } }
            """);
        assertTrue(JsonParser.parseString(noPassword).getAsJsonObject().getAsJsonObject("error")
            .get("message").getAsString().contains("password is required"));
    }

    @Test
    void grantAndRevokeRequireVhostBeforeConnecting() {
        String grant = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 52, "method": "mq_grant_permission", "params": { "user": "dbx-test-user" } }
            """);
        String grantMessage = JsonParser.parseString(grant).getAsJsonObject().getAsJsonObject("error")
            .get("message").getAsString();
        assertTrue(grantMessage.contains("virtual_host is required"), grantMessage);

        String revoke = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 53, "method": "mq_revoke_permission",
              "params": { "user": "dbx-test-user", "virtual_host": "*" } }
            """);
        String revokeMessage = JsonParser.parseString(revoke).getAsJsonObject().getAsJsonObject("error")
            .get("message").getAsString();
        assertTrue(revokeMessage.contains("all_vhosts is only supported for list operations"), revokeMessage);
    }

    @Test
    void grantAndRevokeRejectAllVhostsFlag() {
        for (String method : List.of("mq_grant_permission", "mq_revoke_permission")) {
            JsonObject response = JsonParser.parseString(RabbitMqAgent.handleRequest("""
                { "jsonrpc": "2.0", "id": 54, "method": "%s",
                  "params": { "all_vhosts": true, "user": "dbx-test-user", "virtual_host": "/" } }
                """.formatted(method))).getAsJsonObject();
            assertEquals("all_vhosts is only supported for list operations",
                response.getAsJsonObject("error").get("message").getAsString(), method);
        }
    }

    @Test
    void userAndPermissionOperationsRequireConnection() {
        List<String> requests = List.of("""
            { "jsonrpc": "2.0", "id": 55, "method": "mq_list_users", "params": {} }
            """, """
            { "jsonrpc": "2.0", "id": 56, "method": "mq_list_permissions", "params": {} }
            """, """
            { "jsonrpc": "2.0", "id": 57, "method": "mq_delete_user", "params": { "name": "dbx-test-user" } }
            """);
        for (String request : requests) {
            String message = JsonParser.parseString(RabbitMqAgent.handleRequest(request))
                .getAsJsonObject().getAsJsonObject("error").get("message").getAsString();
            assertTrue(message.contains("Not connected"), message);
        }
    }

    @Test
    void deleteUserRejectsConnectedUserBeforeHttpCall() {
        // The guard must win over the management API call: no broker is needed.
        String response = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 58, "method": "mq_delete_user",
              "params": { "name": "jjsd",
                          "connection": { "addresses": "127.0.0.1:1", "username": "jjsd" } } }
            """);
        String message = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error")
            .get("message").getAsString();
        assertTrue(message.contains("Cannot delete user 'jjsd' while connected as that user"), message);
    }

    // -------------------------------------------------------------------
    // Policies
    // -------------------------------------------------------------------

    @Test
    void policyInfoMapsApplyToAndDefinition() {
        Map<String, Object> policy = RabbitMqAgent.policyInfoFromJson(JsonParser.parseString("""
            { "name": "dbx-pol", "vhost": "/", "pattern": "^dbx-",
              "apply-to": "exchanges", "priority": 5,
              "definition": { "max-length": 100, "alternate-exchange": "dbx-ae", "skip": null } }
            """).getAsJsonObject());
        assertEquals("dbx-pol", policy.get("name"));
        assertEquals("/", policy.get("vhost"));
        assertEquals("^dbx-", policy.get("pattern"));
        assertEquals("exchanges", policy.get("applyTo"));
        assertEquals(5L, policy.get("priority"));
        @SuppressWarnings("unchecked")
        Map<String, Object> definition = (Map<String, Object>) policy.get("definition");
        assertEquals(100L, definition.get("max-length"));
        assertEquals("dbx-ae", definition.get("alternate-exchange"));
        assertFalse(definition.containsKey("skip"));
    }

    @Test
    void listPoliciesMapsEntriesViaManagementApi() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/policies", exchange -> {
            byte[] body = """
                [ { "name": "dbx-pol", "vhost": "/", "pattern": "^dbx-",
                    "apply-to": "queues", "priority": 0,
                    "definition": { "max-length": 100 } } ]
                """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            JsonObject response = JsonParser.parseString(RabbitMqAgent.handleRequest("""
                { "jsonrpc": "2.0", "id": 60, "method": "mq_list_policies",
                  "params": { "all_vhosts": true,
                              "connection": { "addresses": "127.0.0.1",
                                              "properties": { "management_port": %d } } } }
                """.formatted(server.getAddress().getPort()))).getAsJsonObject();
            JsonObject policy = response.getAsJsonObject("result").getAsJsonArray("policies")
                .get(0).getAsJsonObject();
            assertEquals("dbx-pol", policy.get("name").getAsString());
            assertEquals("/", policy.get("vhost").getAsString());
            assertEquals("queues", policy.get("applyTo").getAsString());
            assertEquals(100, policy.getAsJsonObject("definition").get("max-length").getAsInt());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void setPolicyAppliesDefaultsAndMapsApplyTo() throws Exception {
        String[] capturedRequest = new String[2]; // [0] "METHOD path", [1] request body
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            capturedRequest[0] = exchange.getRequestMethod() + " " + exchange.getRequestURI().getRawPath();
            capturedRequest[1] = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.start();
        try {
            String response = RabbitMqAgent.handleRequest("""
                { "jsonrpc": "2.0", "id": 61, "method": "mq_set_policy",
                  "params": { "virtual_host": "/", "name": "dbx-pol", "pattern": "^dbx-",
                              "definition": { "max-length": 100 },
                              "connection": { "addresses": "127.0.0.1",
                                              "properties": { "management_port": %d } } } }
                """.formatted(server.getAddress().getPort()));
            assertTrue(JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("result")
                .get("ok").getAsBoolean());
            assertEquals("PUT /api/policies/%2F/dbx-pol", capturedRequest[0]);
            JsonObject body = JsonParser.parseString(capturedRequest[1]).getAsJsonObject();
            // applyTo defaults to queues and priority to 0.
            assertEquals("queues", body.get("apply-to").getAsString());
            assertEquals(0, body.get("priority").getAsInt());
            assertEquals("^dbx-", body.get("pattern").getAsString());
            assertEquals(100, body.getAsJsonObject("definition").get("max-length").getAsInt());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void deletePolicyCallsManagementApiDelete() throws Exception {
        String[] capturedRequest = new String[1];
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            capturedRequest[0] = exchange.getRequestMethod() + " " + exchange.getRequestURI().getRawPath();
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        server.start();
        try {
            String response = RabbitMqAgent.handleRequest("""
                { "jsonrpc": "2.0", "id": 62, "method": "mq_delete_policy",
                  "params": { "virtual_host": "/", "name": "dbx-pol",
                              "connection": { "addresses": "127.0.0.1",
                                              "properties": { "management_port": %d } } } }
                """.formatted(server.getAddress().getPort()));
            assertTrue(JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("result")
                .get("ok").getAsBoolean());
            assertEquals("DELETE /api/policies/%2F/dbx-pol", capturedRequest[0]);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void setAndDeletePolicyRejectAllVhostsSentinel() {
        for (String method : List.of("mq_set_policy", "mq_delete_policy")) {
            JsonObject response = JsonParser.parseString(RabbitMqAgent.handleRequest("""
                { "jsonrpc": "2.0", "id": 63, "method": "%s",
                  "params": { "virtual_host": "*", "name": "dbx-pol", "pattern": "^dbx-",
                              "definition": {} } }
                """.formatted(method))).getAsJsonObject();
            assertEquals("all_vhosts is only supported for list operations",
                response.getAsJsonObject("error").get("message").getAsString(), method);
        }
    }

    @Test
    void setAndDeletePolicyRejectAllVhostsFlag() {
        for (String method : List.of("mq_set_policy", "mq_delete_policy")) {
            JsonObject response = JsonParser.parseString(RabbitMqAgent.handleRequest("""
                { "jsonrpc": "2.0", "id": 64, "method": "%s",
                  "params": { "all_vhosts": true, "virtual_host": "/", "name": "dbx-pol" } }
                """.formatted(method))).getAsJsonObject();
            assertEquals("all_vhosts is only supported for list operations",
                response.getAsJsonObject("error").get("message").getAsString(), method);
        }
    }

    @Test
    void setPolicyRequiresNamePatternAndDefinition() {
        String noName = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 65, "method": "mq_set_policy",
              "params": { "virtual_host": "/" } }
            """);
        assertTrue(JsonParser.parseString(noName).getAsJsonObject().getAsJsonObject("error")
            .get("message").getAsString().contains("name is required"));

        String noPattern = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 66, "method": "mq_set_policy",
              "params": { "virtual_host": "/", "name": "dbx-pol", "definition": {} } }
            """);
        assertTrue(JsonParser.parseString(noPattern).getAsJsonObject().getAsJsonObject("error")
            .get("message").getAsString().contains("pattern is required"));

        String noDefinition = RabbitMqAgent.handleRequest("""
            { "jsonrpc": "2.0", "id": 67, "method": "mq_set_policy",
              "params": { "virtual_host": "/", "name": "dbx-pol", "pattern": "^dbx-" } }
            """);
        assertTrue(JsonParser.parseString(noDefinition).getAsJsonObject().getAsJsonObject("error")
            .get("message").getAsString().contains("definition is required"));
    }

    // -------------------------------------------------------------------
    // Overview & nodes
    // -------------------------------------------------------------------

    @Test
    void overviewInfoMapsTotalsAndRates() {
        Map<String, Object> overview = RabbitMqAgent.overviewInfoFromJson(JsonParser.parseString("""
            { "queue_totals": { "messages_ready": 12, "messages_unacknowledged": 3 },
              "message_stats": { "publish": 100, "publish_details": { "rate": 1.5 },
                                 "deliver_get": 90, "deliver_get_details": { "rate": 2.5 },
                                 "ack": 80, "ack_details": { "rate": 0.5 } },
              "object_totals": { "connections": 4, "channels": 6, "exchanges": 8,
                                 "queues": 10, "consumers": 2 } }
            """).getAsJsonObject());
        assertEquals(12L, overview.get("messagesReady"));
        assertEquals(3L, overview.get("messagesUnacked"));
        assertEquals(1.5, (Double) overview.get("publishRate"), 0.0001);
        assertEquals(2.5, (Double) overview.get("deliverRate"), 0.0001);
        assertEquals(0.5, (Double) overview.get("ackRate"), 0.0001);
        assertEquals(10L, overview.get("totalQueues"));
        assertEquals(8L, overview.get("totalExchanges"));
        assertEquals(4L, overview.get("totalConnections"));
        assertEquals(6L, overview.get("totalChannels"));
        assertEquals(2L, overview.get("totalConsumers"));
    }

    @Test
    void overviewInfoOmitsMissingStats() {
        Map<String, Object> overview = RabbitMqAgent.overviewInfoFromJson(JsonParser.parseString("""
            { "queue_totals": { "messages_ready": 1 } }
            """).getAsJsonObject());
        assertEquals(1L, overview.get("messagesReady"));
        assertFalse(overview.containsKey("messagesUnacked"));
        assertFalse(overview.containsKey("publishRate"));
        assertFalse(overview.containsKey("totalQueues"));
    }

    @Test
    void nodeInfoMapsSnakeCaseToCamelCase() {
        Map<String, Object> node = RabbitMqAgent.nodeInfoFromJson(JsonParser.parseString("""
            { "name": "rabbit@node1", "running": true, "mem_used": 1000, "mem_limit": 2000,
              "disk_free": 3000, "fd_used": 10, "fd_total": 100, "sockets_used": 5,
              "sockets_total": 50, "uptime": 123456 }
            """).getAsJsonObject());
        assertEquals("rabbit@node1", node.get("name"));
        assertEquals(true, node.get("running"));
        assertEquals(1000L, node.get("memUsed"));
        assertEquals(2000L, node.get("memLimit"));
        assertEquals(3000L, node.get("diskFree"));
        assertEquals(10L, node.get("fdUsed"));
        assertEquals(100L, node.get("fdTotal"));
        assertEquals(5L, node.get("socketsUsed"));
        assertEquals(50L, node.get("socketsTotal"));
        assertEquals(123456L, node.get("uptimeMs"));
    }

    @Test
    void listNodesMapsEntriesViaManagementApi() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/nodes", exchange -> {
            byte[] body = """
                [ { "name": "rabbit@node1", "running": true, "mem_used": 1000,
                    "uptime": 123456 } ]
                """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            JsonObject response = JsonParser.parseString(RabbitMqAgent.handleRequest("""
                { "jsonrpc": "2.0", "id": 68, "method": "mq_list_nodes",
                  "params": { "connection": { "addresses": "127.0.0.1",
                                              "properties": { "management_port": %d } } } }
                """.formatted(server.getAddress().getPort()))).getAsJsonObject();
            JsonObject node = response.getAsJsonObject("result").getAsJsonArray("nodes")
                .get(0).getAsJsonObject();
            assertEquals("rabbit@node1", node.get("name").getAsString());
            assertTrue(node.get("running").getAsBoolean());
            assertEquals(1000, node.get("memUsed").getAsLong());
            assertEquals(123456, node.get("uptimeMs").getAsLong());
        } finally {
            server.stop(0);
        }
    }

    // -------------------------------------------------------------------
    // Channel self-healing decision
    // -------------------------------------------------------------------

    @Test
    void nullChannelNeedsRecreation() {
        assertTrue(RabbitMqAgent.needsNewChannel(null));
    }

    @Test
    void closedChannelNeedsRecreation() {
        assertTrue(RabbitMqAgent.needsNewChannel(stubChannel(false)));
    }

    @Test
    void openChannelIsReused() {
        assertFalse(RabbitMqAgent.needsNewChannel(stubChannel(true)));
    }

    private static Channel stubChannel(boolean open) {
        return (Channel) Proxy.newProxyInstance(
            RabbitMqAgentTest.class.getClassLoader(),
            new Class<?>[] { Channel.class },
            (proxy, method, args) -> {
                if ("isOpen".equals(method.getName())) {
                    return open;
                }
                throw new UnsupportedOperationException(method.getName());
            });
    }
}
