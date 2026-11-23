package com.dbx.agent.kafka;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.apache.kafka.common.message.DescribeClusterResponseData;
import org.apache.kafka.common.message.FindCoordinatorResponseData;
import org.apache.kafka.common.message.MetadataResponseData;
import org.apache.kafka.common.protocol.ApiKeys;
import org.apache.kafka.common.protocol.ByteBufferAccessor;
import org.apache.kafka.common.protocol.Message;
import org.apache.kafka.common.protocol.ObjectSerializationCache;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Authenticator;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.PasswordAuthentication;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * Local TCP bridge that lets kafka-clients reach a Kafka cluster through a SOCKS5 proxy.
 *
 * <p>kafka-clients uses NIO {@code SocketChannel}s, which ignore the JVM's
 * {@code socksProxyHost}/{@code socksProxyPort} properties (KAFKA-10707), and even a
 * bootstrap tunnel is not enough because the client reconnects to every broker in the
 * cluster metadata ({@code advertised.listeners}). This bridge therefore:
 *
 * <ol>
 *   <li>starts a loopback listener per broker endpoint and dials that endpoint through
 *       the configured SOCKS5 proxy;</li>
 *   <li>rewrites {@code bootstrap_servers} to the loopback listeners;</li>
 *   <li>rewrites the broker/coordinator endpoints in {@code Metadata},
 *       {@code FindCoordinator} and {@code DescribeCluster} responses to the same
 *       loopback listeners, so every connection the client opens goes through SOCKS5.</li>
 * </ol>
 *
 * <p>The JVM-wide SOCKS properties are also set while the bridge is active so legacy
 * socket users in the same process (notably ZooKeeper bootstrap discovery) are routed
 * through the proxy. The bridge dialer itself bypasses those properties via
 * {@link Proxy#NO_PROXY} to avoid recursing into the proxy.
 *
 * <p>Only plaintext traffic survives address rewriting transparently. With TLS the
 * client verifies the certificate against the rewritten host ({@code 127.0.0.1}), so
 * endpoint identification must be disabled (DBX's "skip TLS verification") or the
 * broker certificate must contain a loopback SAN.
 */
final class KafkaSocksBridge implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(KafkaSocksBridge.class);

    static final int METADATA_API_KEY = 3;
    static final int FIND_COORDINATOR_API_KEY = 10;
    static final int DESCRIBE_CLUSTER_API_KEY = 60;
    static final String LOOPBACK_HOST = "127.0.0.1";

    private static final int MAX_FRAME_BYTES = 64 * 1024 * 1024;
    private static final Pattern IPV4 = Pattern.compile("\\d{1,3}(?:\\.\\d{1,3}){3}");

    /** Parsed {@code socks_proxy} block from the Rust connection payload. */
    static final class ProxyConfig {
        final String host;
        final int port;
        final String username;
        final String password;

        ProxyConfig(String host, int port, String username, String password) {
            this.host = host;
            this.port = port;
            this.username = username;
            this.password = password;
        }

        static ProxyConfig fromConnection(JsonObject conn) {
            if (conn == null || !conn.has("socks_proxy") || conn.get("socks_proxy").isJsonNull()) {
                return null;
            }
            JsonElement element = conn.get("socks_proxy");
            if (!element.isJsonObject()) {
                throw new IllegalArgumentException("socks_proxy must be an object");
            }
            JsonObject proxy = element.getAsJsonObject();
            String host = stringOrEmpty(proxy, "host").trim();
            Integer port = integerOrNull(proxy, "port");
            if (host.isEmpty() || port == null || port < 1 || port > 65535) {
                throw new IllegalArgumentException("socks_proxy host and port are required");
            }
            return new ProxyConfig(
                host,
                port,
                stringOrEmpty(proxy, "username"),
                stringOrEmpty(proxy, "password")
            );
        }

        boolean matches(ProxyConfig other) {
            return other != null
                && host.equals(other.host)
                && port == other.port
                && username.equals(other.username)
                && password.equals(other.password);
        }

        boolean hasCredentials() {
            return !username.isEmpty() || !password.isEmpty();
        }
    }

    private final ProxyConfig proxy;
    private final int connectTimeoutMs;
    private final Map<String, Endpoint> endpoints = new HashMap<>();
    private final List<ServerSocket> serverSockets = new ArrayList<>();
    private final Set<Socket> openSockets = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closed = new AtomicBoolean();

    private final String previousSocksHost;
    private final String previousSocksPort;
    private final String previousSocksVersion;
    private final Authenticator previousAuthenticator;

    private KafkaSocksBridge(ProxyConfig proxy, int connectTimeoutMs) {
        this.proxy = proxy;
        this.connectTimeoutMs = Math.max(1_000, connectTimeoutMs);
        this.previousSocksHost = System.getProperty("socksProxyHost");
        this.previousSocksPort = System.getProperty("socksProxyPort");
        this.previousSocksVersion = System.getProperty("socksProxyVersion");
        this.previousAuthenticator = proxy.hasCredentials() ? Authenticator.getDefault() : null;
        applyJvmProxyProperties();
    }

    /**
     * Reuses {@code current} when it already serves the same proxy, otherwise replaces it.
     * A {@code null} config tears the bridge down and returns {@code null}.
     */
    static KafkaSocksBridge ensure(KafkaSocksBridge current, ProxyConfig config, int connectTimeoutMs) {
        if (config == null) {
            if (current != null) {
                current.close();
            }
            return null;
        }
        if (current != null && current.proxy.matches(config) && current.connectTimeoutMs == Math.max(1_000, connectTimeoutMs)) {
            return current;
        }
        if (current != null) {
            current.close();
        }
        return new KafkaSocksBridge(config, connectTimeoutMs);
    }

    /**
     * Returns a copy of {@code conn} whose {@code bootstrap_servers} point at loopback
     * listeners that forward through the proxy.
     */
    JsonObject rewriteConnection(JsonObject conn) {
        String servers = stringOrEmpty(conn, "bootstrap_servers");
        if (servers.isBlank()) {
            servers = stringOrEmpty(conn, "bootstrapServers");
        }
        if (servers.isBlank()) {
            return conn;
        }
        JsonObject rewritten = conn.deepCopy();
        rewritten.addProperty("bootstrap_servers", rewriteBootstrapServers(servers));
        return rewritten;
    }

    String rewriteBootstrapServers(String servers) {
        List<String> rewritten = new ArrayList<>();
        for (String entry : splitBootstrapServers(servers)) {
            HostPort endpoint = parseHostPort(entry);
            if (endpoint == null) {
                rewritten.add(entry);
                continue;
            }
            Endpoint local = endpointFor(endpoint.host, endpoint.port);
            rewritten.add(LOOPBACK_HOST + ":" + local.localPort);
        }
        return String.join(",", rewritten);
    }

    /** Allocates (or reuses) a loopback listener for one remote broker endpoint. */
    Endpoint endpointFor(String host, int port) {
        if (closed.get()) {
            throw new IllegalStateException("SOCKS bridge is closed");
        }
        String key = host + "\u0000" + port;
        synchronized (endpoints) {
            Endpoint existing = endpoints.get(key);
            if (existing != null) {
                return existing;
            }
            Endpoint created = Endpoint.start(this, host, port);
            endpoints.put(key, created);
            return created;
        }
    }

    int localPortFor(String host, int port) {
        return endpointFor(host, port).localPort;
    }

    String proxyHost() {
        return proxy.host;
    }

    int proxyPort() {
        return proxy.port;
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        synchronized (endpoints) {
            for (Endpoint endpoint : endpoints.values()) {
                closeQuietly(endpoint.serverSocket);
            }
            endpoints.clear();
        }
        for (Socket socket : openSockets) {
            closeQuietly(socket);
        }
        openSockets.clear();
        restoreJvmProxyProperties();
    }

    // -----------------------------------------------------------------------
    // JVM-wide proxy properties (legacy java.net.Socket users, e.g. ZooKeeper)
    // -----------------------------------------------------------------------

    private void applyJvmProxyProperties() {
        System.setProperty("socksProxyHost", proxy.host);
        System.setProperty("socksProxyPort", String.valueOf(proxy.port));
        System.setProperty("socksProxyVersion", "5");
        if (proxy.hasCredentials()) {
            Authenticator.setDefault(new SocksAuthenticator(proxy.username, proxy.password));
        }
    }

    private void restoreJvmProxyProperties() {
        restoreProperty("socksProxyHost", previousSocksHost);
        restoreProperty("socksProxyPort", previousSocksPort);
        restoreProperty("socksProxyVersion", previousSocksVersion);
        if (proxy.hasCredentials()) {
            Authenticator.setDefault(previousAuthenticator);
        }
    }

    private static void restoreProperty(String key, String value) {
        if (value == null) {
            System.clearProperty(key);
        } else {
            System.setProperty(key, value);
        }
    }

    private static final class SocksAuthenticator extends Authenticator {
        private final String username;
        private final String password;

        SocksAuthenticator(String username, String password) {
            this.username = username;
            this.password = password;
        }

        @Override
        protected PasswordAuthentication getPasswordAuthentication() {
            if (getRequestorType() == RequestorType.PROXY) {
                return new PasswordAuthentication(username, password.toCharArray());
            }
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // Loopback listeners
    // -----------------------------------------------------------------------

    static final class Endpoint {
        final String remoteHost;
        final int remotePort;
        final ServerSocket serverSocket;
        final int localPort;

        private Endpoint(String remoteHost, int remotePort, ServerSocket serverSocket) {
            this.remoteHost = remoteHost;
            this.remotePort = remotePort;
            this.serverSocket = serverSocket;
            this.localPort = serverSocket.getLocalPort();
        }

        static Endpoint start(KafkaSocksBridge bridge, String remoteHost, int remotePort) {
            try {
                ServerSocket server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
                Endpoint endpoint = new Endpoint(remoteHost, remotePort, server);
                bridge.serverSockets.add(server);
                Thread acceptor = new Thread(
                    () -> bridge.acceptLoop(endpoint),
                    "dbx-kafka-socks-" + remotePort
                );
                acceptor.setDaemon(true);
                acceptor.start();
                return endpoint;
            } catch (IOException error) {
                throw new IllegalStateException(
                    "Failed to start SOCKS bridge listener for " + remoteHost + ":" + remotePort,
                    error
                );
            }
        }
    }

    private void acceptLoop(Endpoint endpoint) {
        while (!closed.get()) {
            Socket client;
            try {
                client = endpoint.serverSocket.accept();
            } catch (IOException error) {
                if (!closed.get()) {
                    LOG.warn("Kafka SOCKS bridge listener stopped: {}", error.getMessage());
                }
                return;
            }
            openSockets.add(client);
            Thread handler = new Thread(
                () -> handleConnection(client, endpoint),
                "dbx-kafka-socks-conn-" + endpoint.localPort
            );
            handler.setDaemon(true);
            handler.start();
        }
    }

    private void handleConnection(Socket client, Endpoint endpoint) {
        Socket upstream = null;
        try {
            upstream = connectThroughSocks(proxy, endpoint.remoteHost, endpoint.remotePort, connectTimeoutMs);
            openSockets.add(upstream);
            Socket broker = upstream;
            Map<Integer, RequestInfo> pending = new ConcurrentHashMap<>();
            Thread brokerToClient = new Thread(
                () -> {
                    try {
                        pumpBrokerToClient(broker.getInputStream(), client.getOutputStream(), pending, this);
                    } catch (IOException error) {
                        debugQuietly(error);
                    } finally {
                        closeQuietly(client);
                        closeQuietly(broker);
                    }
                },
                "dbx-kafka-socks-down-" + endpoint.localPort
            );
            brokerToClient.setDaemon(true);
            brokerToClient.start();
            try {
                pumpClientToBroker(client.getInputStream(), broker.getOutputStream(), pending);
            } finally {
                closeQuietly(client);
                closeQuietly(broker);
            }
        } catch (IOException error) {
            LOG.warn(
                "Kafka SOCKS bridge failed to reach {}:{} through {}:{}: {}",
                endpoint.remoteHost,
                endpoint.remotePort,
                proxy.host,
                proxy.port,
                error.getMessage()
            );
            closeQuietly(client);
            if (upstream != null) {
                closeQuietly(upstream);
            }
        } finally {
            openSockets.remove(client);
            if (upstream != null) {
                openSockets.remove(upstream);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Frame pumps and address rewriting
    // -----------------------------------------------------------------------

    record RequestInfo(int apiKey, short apiVersion) {}

    private static void pumpClientToBroker(
        InputStream clientIn,
        OutputStream brokerOut,
        Map<Integer, RequestInfo> pending
    ) throws IOException {
        byte[] lengthBytes = new byte[4];
        while (true) {
            readFully(clientIn, lengthBytes);
            int length = ByteBuffer.wrap(lengthBytes).getInt();
            if (length < 0 || length > MAX_FRAME_BYTES) {
                throw new IOException("Invalid Kafka request frame length: " + length);
            }
            byte[] payload = new byte[length];
            readFully(clientIn, payload);
            rememberRequest(payload, pending);
            brokerOut.write(lengthBytes);
            brokerOut.write(payload);
            brokerOut.flush();
        }
    }

    private static void pumpBrokerToClient(
        InputStream brokerIn,
        OutputStream clientOut,
        Map<Integer, RequestInfo> pending,
        KafkaSocksBridge bridge
    ) throws IOException {
        byte[] lengthBytes = new byte[4];
        while (true) {
            readFully(brokerIn, lengthBytes);
            int length = ByteBuffer.wrap(lengthBytes).getInt();
            if (length < 0 || length > MAX_FRAME_BYTES) {
                throw new IOException("Invalid Kafka response frame length: " + length);
            }
            byte[] payload = new byte[length];
            readFully(brokerIn, payload);
            byte[] rewritten = KafkaSocksBridge.rewriteResponse(payload, pending, bridge);
            clientOut.write(ByteBuffer.allocate(4).putInt(rewritten.length).array());
            clientOut.write(rewritten);
            clientOut.flush();
        }
    }

    private static void rememberRequest(byte[] payload, Map<Integer, RequestInfo> pending) {
        if (payload.length < 8) {
            return;
        }
        ByteBuffer buffer = ByteBuffer.wrap(payload);
        short apiKey = buffer.getShort(0);
        short apiVersion = buffer.getShort(2);
        if (apiKey == METADATA_API_KEY || apiKey == FIND_COORDINATOR_API_KEY || apiKey == DESCRIBE_CLUSTER_API_KEY) {
            pending.put(buffer.getInt(4), new RequestInfo(apiKey, apiVersion));
        }
    }

    /**
     * Rewrites broker/coordinator addresses in a response frame. Any parse or
     * serialization failure leaves the original bytes untouched so an unexpected
     * protocol version can never break a working connection.
     */
    static byte[] rewriteResponse(byte[] payload, Map<Integer, RequestInfo> pending, KafkaSocksBridge bridge) {
        if (payload.length < 4) {
            return payload;
        }
        RequestInfo request = pending.remove(ByteBuffer.wrap(payload).getInt(0));
        if (request == null) {
            return payload;
        }
        try {
            short headerVersion = ApiKeys.forId(request.apiKey()).responseHeaderVersion(request.apiVersion());
            int headerLength = responseHeaderLength(payload, headerVersion);
            if (headerLength < 4 || headerLength > payload.length) {
                return payload;
            }
            byte[] body = new byte[payload.length - headerLength];
            System.arraycopy(payload, headerLength, body, 0, body.length);
            byte[] rewrittenBody = rewriteResponseBody(request.apiKey(), request.apiVersion(), body, bridge);
            if (rewrittenBody == null) {
                return payload;
            }
            byte[] rewritten = new byte[headerLength + rewrittenBody.length];
            System.arraycopy(payload, 0, rewritten, 0, headerLength);
            System.arraycopy(rewrittenBody, 0, rewritten, headerLength, rewrittenBody.length);
            return rewritten;
        } catch (RuntimeException error) {
            LOG.debug("Leaving Kafka response untouched after rewrite failure: {}", error.getMessage());
            return payload;
        }
    }

    private static byte[] rewriteResponseBody(
        int apiKey,
        short apiVersion,
        byte[] body,
        KafkaSocksBridge bridge
    ) {
        ByteBufferAccessor accessor = new ByteBufferAccessor(ByteBuffer.wrap(body));
        switch (apiKey) {
            case METADATA_API_KEY: {
                MetadataResponseData data = new MetadataResponseData(accessor, apiVersion);
                boolean changed = false;
                for (MetadataResponseData.MetadataResponseBroker broker : data.brokers()) {
                    if (remap(broker.host(), broker.port(), bridge, broker::setHost, broker::setPort)) {
                        changed = true;
                    }
                }
                return changed ? serialize(data, apiVersion) : null;
            }
            case FIND_COORDINATOR_API_KEY: {
                FindCoordinatorResponseData data = new FindCoordinatorResponseData(accessor, apiVersion);
                boolean changed = false;
                if (apiVersion >= 4) {
                    for (FindCoordinatorResponseData.Coordinator coordinator : data.coordinators()) {
                        if (remap(coordinator.host(), coordinator.port(), bridge, coordinator::setHost, coordinator::setPort)) {
                            changed = true;
                        }
                    }
                } else if (remap(data.host(), data.port(), bridge, data::setHost, data::setPort)) {
                    changed = true;
                }
                return changed ? serialize(data, apiVersion) : null;
            }
            case DESCRIBE_CLUSTER_API_KEY: {
                DescribeClusterResponseData data = new DescribeClusterResponseData(accessor, apiVersion);
                boolean changed = false;
                for (DescribeClusterResponseData.DescribeClusterBroker broker : data.brokers()) {
                    if (remap(broker.host(), broker.port(), bridge, broker::setHost, broker::setPort)) {
                        changed = true;
                    }
                }
                return changed ? serialize(data, apiVersion) : null;
            }
            default:
                return null;
        }
    }

    private static boolean remap(
        String host,
        int port,
        KafkaSocksBridge bridge,
        java.util.function.Consumer<String> hostSetter,
        java.util.function.IntConsumer portSetter
    ) {
        if (bridge == null || host == null || host.isBlank() || port <= 0) {
            return false;
        }
        if (LOOPBACK_HOST.equals(host)) {
            // Already rewritten by an earlier response on this cluster.
            return false;
        }
        int localPort = bridge.localPortFor(host, port);
        hostSetter.accept(LOOPBACK_HOST);
        portSetter.accept(localPort);
        return true;
    }

    private static byte[] serialize(Message message, short apiVersion) {
        ObjectSerializationCache cache = new ObjectSerializationCache();
        int size = message.size(cache, apiVersion);
        ByteBuffer buffer = ByteBuffer.allocate(size);
        message.write(new ByteBufferAccessor(buffer), cache, apiVersion);
        return buffer.array();
    }

    /** Length of the response header (correlation id plus flexible tagged fields). */
    static int responseHeaderLength(byte[] payload, short headerVersion) {
        if (headerVersion <= 0) {
            return 4;
        }
        ByteBuffer buffer = ByteBuffer.wrap(payload);
        buffer.position(4);
        int tagCount = readUnsignedVarint(buffer);
        for (int index = 0; index < tagCount; index++) {
            readUnsignedVarint(buffer);
            int size = readUnsignedVarint(buffer);
            if (size < 0 || buffer.position() + size > buffer.limit()) {
                throw new IllegalArgumentException("Invalid response header tagged field");
            }
            buffer.position(buffer.position() + size);
        }
        return buffer.position();
    }

    static int readUnsignedVarint(ByteBuffer buffer) {
        int value = 0;
        for (int shift = 0; shift <= 28; shift += 7) {
            int current = buffer.get() & 0xff;
            value |= (current & 0x7f) << shift;
            if ((current & 0x80) == 0) {
                return value;
            }
        }
        throw new IllegalArgumentException("Invalid unsigned varint");
    }

    private static void readFully(InputStream input, byte[] target) throws IOException {
        int offset = 0;
        while (offset < target.length) {
            int read = input.read(target, offset, target.length - offset);
            if (read < 0) {
                throw new EOFException("Kafka connection closed");
            }
            offset += read;
        }
    }

    // -----------------------------------------------------------------------
    // SOCKS5 client (RFC 1928 + RFC 1929)
    // -----------------------------------------------------------------------

    static Socket connectThroughSocks(ProxyConfig proxy, String targetHost, int targetPort, int connectTimeoutMs)
        throws IOException {
        // Proxy.NO_PROXY keeps the bridge dialer from recursing through the JVM-wide
        // socksProxyHost property the bridge itself installs.
        Socket socket = new Socket(Proxy.NO_PROXY);
        try {
            socket.connect(new InetSocketAddress(proxy.host, proxy.port), connectTimeoutMs);
            socket.setSoTimeout(connectTimeoutMs);
            InputStream input = socket.getInputStream();
            OutputStream output = socket.getOutputStream();

            byte[] greeting = proxy.hasCredentials()
                ? new byte[] {5, 2, 0, 2}
                : new byte[] {5, 1, 0};
            output.write(greeting);
            output.flush();

            byte[] methodReply = new byte[2];
            readFully(input, methodReply);
            if (methodReply[0] != 5) {
                throw new IOException("SOCKS proxy replied with an unexpected version: " + methodReply[0]);
            }
            int method = methodReply[1] & 0xff;
            if (method == 0xff) {
                throw new IOException("SOCKS proxy rejected the offered authentication methods");
            }
            if (method == 0x02) {
                authenticate(input, output, proxy);
            } else if (method != 0x00) {
                throw new IOException("SOCKS proxy selected an unsupported auth method: " + method);
            }

            output.write(connectRequest(targetHost, targetPort));
            output.flush();

            byte[] reply = new byte[4];
            readFully(input, reply);
            if (reply[0] != 5) {
                throw new IOException("SOCKS proxy replied with an unexpected version: " + reply[0]);
            }
            if (reply[1] != 0) {
                throw new IOException("SOCKS proxy refused CONNECT to " + targetHost + ":" + targetPort
                    + " (code " + (reply[1] & 0xff) + ")");
            }
            consumeBoundAddress(input, reply[3] & 0xff);
            socket.setSoTimeout(0);
            return socket;
        } catch (IOException | RuntimeException error) {
            closeQuietly(socket);
            throw error;
        }
    }

    private static void authenticate(InputStream input, OutputStream output, ProxyConfig proxy) throws IOException {
        byte[] username = proxy.username.getBytes(StandardCharsets.UTF_8);
        byte[] password = proxy.password.getBytes(StandardCharsets.UTF_8);
        if (username.length > 255 || password.length > 255) {
            throw new IOException("SOCKS proxy username or password is too long");
        }
        ByteArrayOutputStream request = new ByteArrayOutputStream();
        request.write(1);
        request.write(username.length);
        request.write(username);
        request.write(password.length);
        request.write(password);
        output.write(request.toByteArray());
        output.flush();
        byte[] reply = new byte[2];
        readFully(input, reply);
        if (reply[0] != 1 || reply[1] != 0) {
            throw new IOException("SOCKS proxy authentication failed");
        }
    }

    private static byte[] connectRequest(String host, int port) throws IOException {
        ByteArrayOutputStream request = new ByteArrayOutputStream();
        request.write(5);
        request.write(1);
        request.write(0);
        writeAddress(request, host);
        request.write((port >> 8) & 0xff);
        request.write(port & 0xff);
        return request.toByteArray();
    }

    private static void writeAddress(ByteArrayOutputStream request, String host) throws IOException {
        String value = host;
        if (value.startsWith("[") && value.endsWith("]")) {
            value = value.substring(1, value.length() - 1);
        }
        if (IPV4.matcher(value).matches() || value.contains(":")) {
            InetAddress address = InetAddress.getByName(value);
            byte[] raw = address.getAddress();
            request.write(raw.length == 4 ? 0x01 : 0x04);
            request.write(raw);
            return;
        }
        byte[] name = value.getBytes(StandardCharsets.UTF_8);
        if (name.length == 0 || name.length > 255) {
            throw new IOException("Invalid SOCKS target host: " + host);
        }
        request.write(0x03);
        request.write(name.length);
        request.write(name);
    }

    private static void consumeBoundAddress(InputStream input, int addressType) throws IOException {
        int length;
        switch (addressType) {
            case 0x01:
                length = 4;
                break;
            case 0x04:
                length = 16;
                break;
            case 0x03:
                length = input.read();
                if (length < 0) {
                    throw new EOFException("SOCKS proxy closed the connection");
                }
                break;
            default:
                throw new IOException("SOCKS proxy returned an unknown address type: " + addressType);
        }
        byte[] address = new byte[length + 2];
        readFully(input, address);
    }

    // -----------------------------------------------------------------------
    // Bootstrap server parsing
    // -----------------------------------------------------------------------

    static List<String> splitBootstrapServers(String servers) {
        List<String> entries = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        for (int index = 0; index < servers.length(); index++) {
            char character = servers.charAt(index);
            if (Character.isWhitespace(character)
                || character == ','
                || character == ';'
                || character == '，'
                || character == '；') {
                if (current.length() > 0) {
                    entries.add(current.toString());
                    current.setLength(0);
                }
            } else {
                current.append(character);
            }
        }
        if (current.length() > 0) {
            entries.add(current.toString());
        }
        return entries;
    }

    static HostPort parseHostPort(String entry) {
        String value = entry;
        int scheme = value.lastIndexOf("://");
        if (scheme >= 0) {
            value = value.substring(scheme + 3);
        }
        if (value.startsWith("[")) {
            int close = value.indexOf(']');
            if (close <= 1) {
                return null;
            }
            String host = value.substring(0, close + 1);
            if (close + 1 >= value.length() || value.charAt(close + 1) != ':') {
                return null;
            }
            Integer port = parsePort(value.substring(close + 2));
            return port == null ? null : new HostPort(host, port);
        }
        int colon = value.lastIndexOf(':');
        if (colon <= 0) {
            return null;
        }
        Integer port = parsePort(value.substring(colon + 1));
        return port == null ? null : new HostPort(value.substring(0, colon), port);
    }

    private static Integer parsePort(String value) {
        try {
            int port = Integer.parseInt(value);
            return port >= 1 && port <= 65535 ? port : null;
        } catch (NumberFormatException error) {
            return null;
        }
    }

    record HostPort(String host, int port) {}

    // -----------------------------------------------------------------------
    // Small helpers
    // -----------------------------------------------------------------------

    private static String stringOrEmpty(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return "";
        }
        JsonElement value = object.get(key);
        return value.isJsonPrimitive() ? value.getAsString() : "";
    }

    private static Integer integerOrNull(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        JsonElement value = object.get(key);
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            return null;
        }
        return value.getAsInt();
    }

    private static void closeQuietly(AutoCloseable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (Exception ignored) {
            // Best effort cleanup.
        }
    }

    private static void debugQuietly(IOException error) {
        if (!(error instanceof EOFException) && !(error instanceof SocketException)) {
            LOG.debug("Kafka SOCKS bridge connection ended: {}", error.getMessage());
        }
    }
}
