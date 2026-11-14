package com.dbx.agent.kafka;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.apache.kafka.common.message.DescribeClusterResponseData;
import org.apache.kafka.common.message.MetadataResponseData;
import org.apache.kafka.common.protocol.ApiKeys;
import org.apache.kafka.common.protocol.ByteBufferAccessor;
import org.apache.kafka.common.protocol.Message;
import org.apache.kafka.common.protocol.ObjectSerializationCache;
import org.junit.jupiter.api.Test;

class KafkaSocksBridgeTest {

    private static final short METADATA_VERSION = 3;
    private static final short METADATA_FLEXIBLE_VERSION = 12;

    // -----------------------------------------------------------------------
    // Config parsing
    // -----------------------------------------------------------------------

    @Test
    void connectionWithoutSocksProxyYieldsNoConfig() {
        assertNull(KafkaSocksBridge.ProxyConfig.fromConnection(connection("{\"bootstrap_servers\":\"broker:9092\"}")));
        assertNull(KafkaSocksBridge.ProxyConfig.fromConnection(connection("{\"socks_proxy\":null}")));
    }

    @Test
    void socksProxyConfigRequiresHostAndPort() {
        assertThrows(
            IllegalArgumentException.class,
            () -> KafkaSocksBridge.ProxyConfig.fromConnection(connection("{\"socks_proxy\":{\"host\":\"\"}}"))
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> KafkaSocksBridge.ProxyConfig.fromConnection(connection("{\"socks_proxy\":{\"host\":\"p\",\"port\":70000}}"))
        );
    }

    @Test
    void socksProxyConfigKeepsOptionalCredentials() {
        KafkaSocksBridge.ProxyConfig config = KafkaSocksBridge.ProxyConfig.fromConnection(
            connection("{\"socks_proxy\":{\"host\":\"proxy.internal\",\"port\":1080,\"username\":\"u\",\"password\":\"p\"}}")
        );
        assertNotNull(config);
        assertEquals("proxy.internal", config.host);
        assertEquals(1080, config.port);
        assertEquals("u", config.username);
        assertEquals("p", config.password);
        assertTrue(config.hasCredentials());
    }

    // -----------------------------------------------------------------------
    // Bootstrap rewriting
    // -----------------------------------------------------------------------

    @Test
    void bootstrapServersAreMappedToDistinctLoopbackListeners() {
        try (KafkaSocksBridge bridge = bridge()) {
            String rewritten = bridge.rewriteBootstrapServers("broker-1.internal:9092, broker-2.internal:9093");
            List<String> entries = KafkaSocksBridge.splitBootstrapServers(rewritten);

            assertEquals(2, entries.size());
            for (String entry : entries) {
                assertTrue(entry.startsWith(KafkaSocksBridge.LOOPBACK_HOST + ":"), entry);
            }
            assertNotEquals(entries.get(0), entries.get(1));

            // The same remote endpoint always maps to the same listener.
            assertEquals(rewritten, bridge.rewriteBootstrapServers("broker-1.internal:9092,broker-2.internal:9093"));
        }
    }

    @Test
    void bootstrapRewritingKeepsSchemesOutOfTheListenerList() {
        try (KafkaSocksBridge bridge = bridge()) {
            String rewritten = bridge.rewriteBootstrapServers("PLAINTEXT://broker.internal:19092");
            KafkaSocksBridge.HostPort endpoint = KafkaSocksBridge.parseHostPort(rewritten);
            assertNotNull(endpoint);
            assertEquals(KafkaSocksBridge.LOOPBACK_HOST, endpoint.host());
            assertTrue(endpoint.port() > 0);
        }
    }

    @Test
    void unparsableBootstrapEntriesPassThroughUnchanged() {
        try (KafkaSocksBridge bridge = bridge()) {
            assertEquals("not-an-endpoint", bridge.rewriteBootstrapServers("not-an-endpoint"));
        }
    }

    // -----------------------------------------------------------------------
    // Response rewriting
    // -----------------------------------------------------------------------

    @Test
    void metadataResponseBrokersAreRewrittenToLoopbackListeners() {
        short version = METADATA_VERSION;
        MetadataResponseData data = new MetadataResponseData();
        MetadataResponseData.MetadataResponseBroker first = new MetadataResponseData.MetadataResponseBroker();
        first.setNodeId(1);
        first.setHost("broker-1.internal");
        first.setPort(9092);
        data.brokers().add(first);
        MetadataResponseData.MetadataResponseBroker second = new MetadataResponseData.MetadataResponseBroker();
        second.setNodeId(2);
        second.setHost("broker-2.internal");
        second.setPort(9093);
        data.brokers().add(second);

        byte[] frame = responseFrame(7, version, data);
        Map<Integer, KafkaSocksBridge.RequestInfo> pending = new HashMap<>();
        pending.put(7, new KafkaSocksBridge.RequestInfo(KafkaSocksBridge.METADATA_API_KEY, version));

        try (KafkaSocksBridge bridge = bridge()) {
            byte[] rewritten = KafkaSocksBridge.rewriteResponse(frame, pending, bridge);
            assertTrue(pending.isEmpty());

            MetadataResponseData parsed = parseMetadata(rewritten, version);
            assertEquals(2, parsed.brokers().size());
            for (MetadataResponseData.MetadataResponseBroker broker : parsed.brokers()) {
                assertEquals(KafkaSocksBridge.LOOPBACK_HOST, broker.host());
                assertTrue(broker.port() > 0);
            }
            assertNotEquals(parsed.brokers().find(1).port(), parsed.brokers().find(2).port());
        }
    }

    @Test
    void flexibleMetadataResponseKeepsItsTaggedHeader() {
        short version = METADATA_FLEXIBLE_VERSION;
        MetadataResponseData data = new MetadataResponseData();
        data.setClusterId("cluster");
        MetadataResponseData.MetadataResponseBroker broker = new MetadataResponseData.MetadataResponseBroker();
        broker.setNodeId(3);
        broker.setHost("broker.internal");
        broker.setPort(9092);
        data.brokers().add(broker);

        byte[] frame = responseFrame(11, version, data);
        assertEquals(5, KafkaSocksBridge.responseHeaderLength(frame, (short) 1));
        Map<Integer, KafkaSocksBridge.RequestInfo> pending = new HashMap<>();
        pending.put(11, new KafkaSocksBridge.RequestInfo(KafkaSocksBridge.METADATA_API_KEY, version));

        try (KafkaSocksBridge bridge = bridge()) {
            byte[] rewritten = KafkaSocksBridge.rewriteResponse(frame, pending, bridge);

            MetadataResponseData parsed = parseMetadata(rewritten, version);
            assertEquals("cluster", parsed.clusterId());
            assertEquals(KafkaSocksBridge.LOOPBACK_HOST, parsed.brokers().find(3).host());
        }
    }

    @Test
    void describeClusterResponseBrokersAreRewritten() {
        short version = 1;
        DescribeClusterResponseData data = new DescribeClusterResponseData();
        data.setClusterId("cluster");
        DescribeClusterResponseData.DescribeClusterBroker broker =
            new DescribeClusterResponseData.DescribeClusterBroker();
        broker.setBrokerId(5);
        broker.setHost("broker.internal");
        broker.setPort(9092);
        data.brokers().add(broker);

        byte[] frame = responseFrame(13, version, data);
        Map<Integer, KafkaSocksBridge.RequestInfo> pending = new HashMap<>();
        pending.put(13, new KafkaSocksBridge.RequestInfo(KafkaSocksBridge.DESCRIBE_CLUSTER_API_KEY, version));

        try (KafkaSocksBridge bridge = bridge()) {
            byte[] rewritten = KafkaSocksBridge.rewriteResponse(frame, pending, bridge);

            ByteBufferAccessor accessor = new ByteBufferAccessor(bodyOf(rewritten, (short) 1));
            DescribeClusterResponseData parsed = new DescribeClusterResponseData(accessor, version);
            assertEquals(KafkaSocksBridge.LOOPBACK_HOST, parsed.brokers().find(5).host());
            assertTrue(parsed.brokers().find(5).port() > 0);
        }
    }

    @Test
    void framesWithoutAPendingRequestPassThroughUnchanged() {
        byte[] frame = responseFrame(17, METADATA_VERSION, new MetadataResponseData());
        try (KafkaSocksBridge bridge = bridge()) {
            assertArrayEquals(frame, KafkaSocksBridge.rewriteResponse(frame, new HashMap<>(), bridge));
        }
    }

    @Test
    void unparsableResponseBodiesFailOpen() {
        // Correlation id followed by a throttle time and a negative broker
        // array length, which the generated parser rejects.
        byte[] frame = ByteBuffer.allocate(12).putInt(21).putInt(0).putInt(-5).array();
        Map<Integer, KafkaSocksBridge.RequestInfo> pending = new HashMap<>();
        pending.put(21, new KafkaSocksBridge.RequestInfo(KafkaSocksBridge.METADATA_API_KEY, METADATA_VERSION));

        try (KafkaSocksBridge bridge = bridge()) {
            assertArrayEquals(frame, KafkaSocksBridge.rewriteResponse(frame, pending, bridge));
        }
    }

    // -----------------------------------------------------------------------
    // SOCKS5 dialing
    // -----------------------------------------------------------------------

    @Test
    void bridgeDialerSpeaksSocks5AndRewritesTheBrokerResponse() throws Exception {
        MetadataResponseData metadata = new MetadataResponseData();
        MetadataResponseData.MetadataResponseBroker broker = new MetadataResponseData.MetadataResponseBroker();
        broker.setNodeId(1);
        broker.setHost("broker.internal");
        broker.setPort(9092);
        metadata.brokers().add(broker);

        try (EchoServer target = new EchoServer();
             FakeSocksProxy proxy = new FakeSocksProxy(target.port(), true, responseFrame(1, METADATA_VERSION, metadata));
             KafkaSocksBridge bridge = bridge(proxy.port(), "proxy-user", "proxy-secret")) {
            KafkaSocksBridge.Endpoint endpoint = bridge.endpointFor("broker.internal", 9092);

            try (Socket client = new Socket(KafkaSocksBridge.LOOPBACK_HOST, endpoint.localPort)) {
                client.setSoTimeout(5_000);
                DataInputStream input = new DataInputStream(client.getInputStream());
                DataOutputStream output = new DataOutputStream(client.getOutputStream());
                output.write(requestFrame(1, KafkaSocksBridge.METADATA_API_KEY, METADATA_VERSION));
                output.flush();

                int length = input.readInt();
                byte[] payload = new byte[length];
                input.readFully(payload);
                MetadataResponseData parsed = new MetadataResponseData(
                    new ByteBufferAccessor(ByteBuffer.wrap(payload, 4, payload.length - 4)),
                    METADATA_VERSION
                );
                assertEquals(KafkaSocksBridge.LOOPBACK_HOST, parsed.brokers().find(1).host());
                assertTrue(parsed.brokers().find(1).port() > 0);
            }

            assertEquals("broker.internal", proxy.requestedTarget.get().host());
            assertEquals(9092, proxy.requestedTarget.get().port());
            assertEquals("proxy-user", proxy.username.get());
            assertEquals("proxy-secret", proxy.password.get());
        }
    }

    @Test
    void dialerUsesNoAuthenticationWhenNoCredentialsAreConfigured() throws Exception {
        try (EchoServer target = new EchoServer();
             FakeSocksProxy proxy = new FakeSocksProxy(target.port(), false)) {
            Socket connection = KafkaSocksBridge.connectThroughSocks(
                new KafkaSocksBridge.ProxyConfig("127.0.0.1", proxy.port(), "", ""),
                "broker.internal",
                9092,
                2_000
            );
            try (connection) {
                connection.getOutputStream().write("ok".getBytes(StandardCharsets.UTF_8));
                connection.getOutputStream().flush();
                assertEquals("ok", new String(connection.getInputStream().readNBytes(2), StandardCharsets.UTF_8));
            }
            assertFalse(proxy.authRequested.get());
        }
    }

    // -----------------------------------------------------------------------
    // Fixtures
    // -----------------------------------------------------------------------

    private static JsonObject connection(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    private static KafkaSocksBridge bridge() {
        return KafkaSocksBridge.ensure(null, new KafkaSocksBridge.ProxyConfig("127.0.0.1", 1, "", ""), 1_000);
    }

    private static KafkaSocksBridge bridge(int proxyPort, String username, String password) {
        return KafkaSocksBridge.ensure(
            null,
            new KafkaSocksBridge.ProxyConfig("127.0.0.1", proxyPort, username, password),
            2_000
        );
    }

    private static byte[] requestFrame(int correlationId, int apiKey, short apiVersion) {
        return ByteBuffer.allocate(12).putInt(8).putShort((short) apiKey).putShort(apiVersion).putInt(correlationId).array();
    }

    private static byte[] responseFrame(int correlationId, short version, Message body) {
        short headerVersion = ApiKeys.forId(apiKeyFor(body)).responseHeaderVersion(version);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        output.writeBytes(ByteBuffer.allocate(4).putInt(correlationId).array());
        if (headerVersion > 0) {
            output.write(0);
        }
        ObjectSerializationCache cache = new ObjectSerializationCache();
        int size = body.size(cache, version);
        ByteBuffer buffer = ByteBuffer.allocate(size);
        body.write(new ByteBufferAccessor(buffer), cache, version);
        output.writeBytes(buffer.array());
        return output.toByteArray();
    }

    private static int apiKeyFor(Message body) {
        if (body instanceof MetadataResponseData) {
            return KafkaSocksBridge.METADATA_API_KEY;
        }
        if (body instanceof DescribeClusterResponseData) {
            return KafkaSocksBridge.DESCRIBE_CLUSTER_API_KEY;
        }
        throw new IllegalArgumentException("Unsupported test message: " + body.getClass());
    }

    private static ByteBuffer bodyOf(byte[] frame, short headerVersion) {
        int headerLength = KafkaSocksBridge.responseHeaderLength(frame, headerVersion);
        return ByteBuffer.wrap(frame, headerLength, frame.length - headerLength);
    }

    private static MetadataResponseData parseMetadata(byte[] frame, short version) {
        short headerVersion = ApiKeys.forId(KafkaSocksBridge.METADATA_API_KEY).responseHeaderVersion(version);
        return new MetadataResponseData(new ByteBufferAccessor(bodyOf(frame, headerVersion)), version);
    }

    private static final class EchoServer implements AutoCloseable {
        private final ServerSocket server;
        private final Thread thread;

        EchoServer() throws IOException {
            server = new ServerSocket(0, 10, InetAddress.getLoopbackAddress());
            thread = new Thread(() -> {
                while (!server.isClosed()) {
                    try (Socket client = server.accept()) {
                        byte[] buffer = new byte[1024];
                        int read;
                        while ((read = client.getInputStream().read(buffer)) >= 0) {
                            client.getOutputStream().write(buffer, 0, read);
                            client.getOutputStream().flush();
                        }
                    } catch (IOException ignored) {
                        return;
                    }
                }
            }, "kafka-socks-test-echo");
            thread.setDaemon(true);
            thread.start();
        }

        int port() {
            return server.getLocalPort();
        }

        @Override
        public void close() throws IOException {
            server.close();
        }
    }

    /**
     * Minimal SOCKS5 server: validates the greeting (and RFC 1929 auth when
     * required), records the CONNECT target, then pipes the connection to a
     * local echo server.
     */
    private static final class FakeSocksProxy implements AutoCloseable {
        private final ServerSocket server;
        private final int echoPort;
        private final boolean requiresAuth;
        private final byte[] cannedResponsePayload;
        private final Thread thread;
        final AtomicReference<KafkaSocksBridge.HostPort> requestedTarget = new AtomicReference<>();
        final AtomicReference<String> username = new AtomicReference<>();
        final AtomicReference<String> password = new AtomicReference<>();
        final AtomicReference<Boolean> authRequested = new AtomicReference<>(false);

        FakeSocksProxy(int echoPort, boolean requiresAuth) throws IOException {
            this(echoPort, requiresAuth, null);
        }

        FakeSocksProxy(int echoPort, boolean requiresAuth, byte[] cannedResponsePayload) throws IOException {
            this.echoPort = echoPort;
            this.requiresAuth = requiresAuth;
            this.cannedResponsePayload = cannedResponsePayload;
            server = new ServerSocket(0, 10, InetAddress.getLoopbackAddress());
            thread = new Thread(this::acceptLoop, "kafka-socks-test-proxy");
            thread.setDaemon(true);
            thread.start();
        }

        int port() {
            return server.getLocalPort();
        }

        private void acceptLoop() {
            try {
                Socket client = server.accept();
                handle(client);
            } catch (IOException ignored) {
                // Test teardown closes the server socket.
            }
        }

        private void handle(Socket client) throws IOException {
            try (client) {
                DataInputStream input = new DataInputStream(client.getInputStream());
                DataOutputStream output = new DataOutputStream(client.getOutputStream());

                assertEquals(5, input.readUnsignedByte());
                int methodCount = input.readUnsignedByte();
                boolean offersUserPassword = false;
                for (int index = 0; index < methodCount; index++) {
                    offersUserPassword |= input.readUnsignedByte() == 2;
                }
                output.writeByte(5);
                output.writeByte(requiresAuth ? 2 : 0);
                output.flush();

                if (requiresAuth) {
                    assertTrue(offersUserPassword);
                    authRequested.set(true);
                    assertEquals(1, input.readUnsignedByte());
                    byte[] user = new byte[input.readUnsignedByte()];
                    input.readFully(user);
                    byte[] pass = new byte[input.readUnsignedByte()];
                    input.readFully(pass);
                    username.set(new String(user, StandardCharsets.UTF_8));
                    password.set(new String(pass, StandardCharsets.UTF_8));
                    output.write(new byte[] {1, 0});
                    output.flush();
                }

                assertEquals(5, input.readUnsignedByte());
                assertEquals(1, input.readUnsignedByte());
                assertEquals(0, input.readUnsignedByte());
                int addressType = input.readUnsignedByte();
                String host;
                if (addressType == 1) {
                    byte[] raw = new byte[4];
                    input.readFully(raw);
                    host = InetAddress.getByAddress(raw).getHostAddress();
                } else if (addressType == 3) {
                    byte[] raw = new byte[input.readUnsignedByte()];
                    input.readFully(raw);
                    host = new String(raw, StandardCharsets.UTF_8);
                } else {
                    byte[] raw = new byte[16];
                    input.readFully(raw);
                    host = InetAddress.getByAddress(raw).getHostAddress();
                }
                int port = input.readUnsignedShort();
                requestedTarget.set(new KafkaSocksBridge.HostPort(host, port));
                output.write(new byte[] {5, 0, 0, 1, 127, 0, 0, 1, 0, 0});
                output.flush();

                if (cannedResponsePayload != null) {
                    int requestLength = input.readInt();
                    input.readNBytes(requestLength);
                    output.writeInt(cannedResponsePayload.length);
                    output.write(cannedResponsePayload);
                    output.flush();
                    return;
                }

                try (Socket upstream = new Socket(InetAddress.getLoopbackAddress(), echoPort)) {
                    Thread downstream = new Thread(() -> pump(upstream, client));
                    downstream.setDaemon(true);
                    downstream.start();
                    pump(client, upstream);
                    downstream.join(5_000);
                }
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        }

        private static void pump(Socket from, Socket to) {
            byte[] buffer = new byte[1024];
            try {
                InputStream input = from.getInputStream();
                OutputStream output = to.getOutputStream();
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    output.write(buffer, 0, read);
                    output.flush();
                }
            } catch (IOException ignored) {
                // Connection closed.
            }
        }

        @Override
        public void close() throws IOException {
            server.close();
        }
    }
}
