package com.dbx.agent.etcd;

import com.dbx.agent.AgentProtocol;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.SessionRpcHandler;
import com.google.protobuf.CodedInputStream;
import com.google.protobuf.WireFormat;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.grpc.MethodDescriptor;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.netty.GrpcSslContexts;
import io.grpc.stub.ClientCalls;
import io.etcd.jetcd.ByteSequence;
import io.etcd.jetcd.Auth;
import io.etcd.jetcd.Client;
import io.etcd.jetcd.ClientBuilder;
import io.etcd.jetcd.Cluster;
import io.etcd.jetcd.KV;
import io.etcd.jetcd.KeyValue;
import io.etcd.jetcd.Lease;
import io.etcd.jetcd.Maintenance;
import io.etcd.jetcd.Watch;
import io.etcd.jetcd.cluster.Member;
import io.etcd.jetcd.cluster.MemberListResponse;
import io.etcd.jetcd.kv.TxnResponse;
import io.etcd.jetcd.lease.LeaseGrantResponse;
import io.etcd.jetcd.lease.LeaseTimeToLiveResponse;
import io.etcd.jetcd.api.VertxLeaseGrpc;
import io.etcd.jetcd.maintenance.AlarmMember;
import io.etcd.jetcd.maintenance.AlarmResponse;
import io.etcd.jetcd.maintenance.StatusResponse;
import io.etcd.jetcd.op.Cmp;
import io.etcd.jetcd.op.CmpTarget;
import io.etcd.jetcd.op.Op;
import io.etcd.jetcd.kv.DeleteResponse;
import io.etcd.jetcd.kv.GetResponse;
import io.etcd.jetcd.kv.PutResponse;
import io.etcd.jetcd.options.DeleteOption;
import io.etcd.jetcd.options.GetOption;
import io.etcd.jetcd.options.LeaseOption;
import io.etcd.jetcd.options.PutOption;
import io.etcd.jetcd.options.WatchOption;
import io.etcd.jetcd.watch.WatchEvent;
import io.etcd.jetcd.watch.WatchResponse;
import io.etcd.jetcd.auth.Permission;
import io.netty.handler.ssl.SslContext;
import io.netty.handler.ssl.SslContextBuilder;
import java.io.ByteArrayInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.time.Duration;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Base64;
import java.util.Collections;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.ConcurrentHashMap;
import java.util.UUID;

public final class EtcdAgent {
    private static final Gson GSON = new Gson();
    private static final int DEFAULT_LIMIT = 100;
    private static final int RPC_TIMEOUT_SECONDS = 30;
    static final int DEFAULT_GRPC_MAX_INBOUND_MESSAGE_SIZE = 32 * 1024 * 1024;
    static final int MIN_GRPC_MAX_INBOUND_MESSAGE_SIZE = 1024 * 1024;
    static final int MAX_GRPC_MAX_INBOUND_MESSAGE_SIZE = 256 * 1024 * 1024;
    private static final String GRPC_MAX_INBOUND_MESSAGE_SIZE_KEY = "grpc_max_inbound_message_size";
    private static final int PRESERVE_LEASE_MAX_ATTEMPTS = 3;
    private static final long HISTORY_DEFAULT_REVISION_WINDOW = 10_000L;
    private static final List<String> CAPABILITIES = Collections.unmodifiableList(Arrays.asList(
        AgentProtocol.CAPABILITY_CONNECT,
        AgentProtocol.CAPABILITY_TEST_CONNECTION,
        AgentProtocol.CAPABILITY_KV,
        AgentProtocol.CAPABILITY_KV_TTL,
        AgentProtocol.CAPABILITY_KV_CAS,
        AgentProtocol.CAPABILITY_KV_LIST_VALUES,
        AgentProtocol.CAPABILITY_KV_STATUS,
        AgentProtocol.CAPABILITY_KV_HISTORY,
        AgentProtocol.CAPABILITY_ETCD_COMPACTION,
        AgentProtocol.CAPABILITY_ETCD_DEFRAG,
        AgentProtocol.CAPABILITY_ETCD_WATCH,
        AgentProtocol.CAPABILITY_ETCD_LEASE,
        AgentProtocol.CAPABILITY_ETCD_AUTH,
        AgentProtocol.CAPABILITY_MULTI_SESSION
    ));
    private static final int MAX_WATCHES = 4;
    private static final int MAX_WATCH_BATCHES = 256;
    private static final int MAX_WATCH_EVENTS = 10_000;
    static final long MAX_WATCH_BUFFER_BYTES = 8L * 1024 * 1024;
    static final long MAX_SESSION_WATCH_BUFFER_BYTES = 16L * 1024 * 1024;
    private static final int MAX_LEASE_ATTACHED_KEYS = 256;
    private static final int DEFAULT_LEASE_LIST_LIMIT = 100;
    private static final int MAX_LEASE_LIST_LIMIT = 200;
    private static final int LEASE_LIST_CONCURRENCY = 8;
    private static final int LEASE_LIST_DEADLINE_SECONDS = 5;
    private static final MethodDescriptor.Marshaller<byte[]> BYTE_ARRAY_MARSHALLER = new MethodDescriptor.Marshaller<>() {
        @Override
        public InputStream stream(byte[] value) {
            return new ByteArrayInputStream(value);
        }

        @Override
        public byte[] parse(InputStream stream) {
            try {
                return stream.readAllBytes();
            } catch (IOException error) {
                throw new IllegalStateException("Failed to read etcd gRPC response", error);
            }
        }
    };
    private static final MethodDescriptor<byte[], byte[]> LEASES_METHOD = MethodDescriptor.<byte[], byte[]>newBuilder()
        .setType(MethodDescriptor.MethodType.UNARY)
        .setFullMethodName(MethodDescriptor.generateFullMethodName("etcdserverpb.Lease", "LeaseLeases"))
        .setRequestMarshaller(BYTE_ARRAY_MARSHALLER)
        .setResponseMarshaller(BYTE_ARRAY_MARSHALLER)
        .build();
    private static final ThreadLocal<EtcdSessionState> CURRENT_SESSION = new ThreadLocal<>();
    private static final EtcdSessionState LEGACY_SESSION = new EtcdSessionState();

    private EtcdAgent() {
    }

    private static Object handshakeResult() {
        return new HandshakeResult(AgentProtocol.MULTI_SESSION_PROTOCOL_VERSION, AgentProtocol.MULTI_SESSION_PROTOCOL_VERSION, CAPABILITIES);
    }

    private static Object connect(JsonObject params) throws Exception {
        EtcdSessionState state = sessionState();
        JsonObject connection = connectionObject(params);
        Client nextClient = buildClient(connection);
        try {
            probeClient(nextClient, endpoints(connection));
        } catch (Exception error) {
            nextClient.close();
            throw error;
        }
        closeClient();
        state.client = nextClient;
        state.kv = nextClient.getKVClient();
        state.connectedEndpoints = endpoints(connection);
        return Collections.singletonMap("ok", true);
    }

    static Client buildClient(JsonObject connection) throws Exception {
        List<String> endpoints = endpoints(connection);
        ClientBuilder builder = Client.builder()
            .endpoints(endpoints.toArray(String[]::new))
            .connectTimeout(Duration.ofSeconds(connectTimeoutSeconds(connection)))
            .maxInboundMessageSize(grpcMaxInboundMessageSize(connection));
        String username = stringOrEmpty(connection, "username");
        String password = stringOrEmpty(connection, "password");
        if (!username.isBlank()) {
            builder.user(byteSequence(username));
            builder.password(byteSequence(password));
        }
        if (boolOrDefault(connection, "ssl", false)) {
            builder.sslContext(sslContext(connection));
        }
        return builder.build();
    }

    static int connectTimeoutSeconds(JsonObject connection) {
        return Math.min(300, Math.max(1, intOrDefault(connection, "connect_timeout_secs", RPC_TIMEOUT_SECONDS)));
    }

    static int grpcMaxInboundMessageSize(JsonObject connection) {
        int configured = intOrDefault(
            connection,
            GRPC_MAX_INBOUND_MESSAGE_SIZE_KEY,
            intUrlParamOrDefault(
                stringOrEmpty(connection, "url_params"),
                GRPC_MAX_INBOUND_MESSAGE_SIZE_KEY,
                DEFAULT_GRPC_MAX_INBOUND_MESSAGE_SIZE
            )
        );
        return Math.min(MAX_GRPC_MAX_INBOUND_MESSAGE_SIZE, Math.max(MIN_GRPC_MAX_INBOUND_MESSAGE_SIZE, configured));
    }

    private static Map<String, Object> validateConnectedClient() throws Exception {
        EtcdSessionState state = sessionState();
        Client active = requireClient();
        return probeClient(active, state.connectedEndpoints);
    }

    private static Map<String, Object> probeClient(Client candidate, List<String> endpoints) throws Exception {
        Maintenance maintenance = candidate.getMaintenanceClient();
        Exception lastFailure = null;
        for (String endpoint : endpoints) {
            try {
                maintenance.statusMember(endpoint).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("ok", true);
                result.put("endpoint", endpoint);
                return result;
            } catch (Exception error) {
                Throwable cause = rootCause(error);
                // A restricted etcd user may not be allowed to call Maintenance.Status.
                // PERMISSION_DENIED still proves that the channel reached an etcd server.
                if (Status.fromThrowable(cause).getCode() == Status.Code.PERMISSION_DENIED) {
                    Map<String, Object> result = new LinkedHashMap<>();
                    result.put("ok", true);
                    result.put("endpoint", endpoint);
                    result.put("limited", true);
                    return result;
                }
                lastFailure = error;
            }
        }
        if (lastFailure != null) {
            throw lastFailure;
        }
        throw new IllegalStateException("No etcd endpoint configured");
    }

    static List<String> endpoints(JsonObject connection) {
        String configured = firstNonBlank(
            stringOrNull(connection, "etcd_endpoints"),
            stringOrNull(connection, "endpoints"),
            stringOrNull(connection, "connection_string")
        );
        List<String> result = new ArrayList<>();
        if (configured != null) {
            for (String endpoint : configured.split("[,\\n]")) {
                String normalized = normalizeEndpoint(endpoint.trim(), boolOrDefault(connection, "ssl", false));
                if (!normalized.isBlank()) {
                    result.add(normalized);
                }
            }
        }
        if (result.isEmpty()) {
            String host = stringOrDefault(connection, "host", "127.0.0.1");
            int port = intOrDefault(connection, "port", 2379);
            result.add(normalizeEndpoint(host + ":" + port, boolOrDefault(connection, "ssl", false)));
        }
        return result;
    }

    private static String normalizeEndpoint(String endpoint, boolean tls) {
        if (endpoint.isBlank()) {
            return "";
        }
        if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
            return endpoint;
        }
        return (tls ? "https://" : "http://") + endpoint;
    }

    private static SslContext sslContext(JsonObject connection) throws Exception {
        SslContextBuilder builder = GrpcSslContexts.forClient();
        String ca = stringOrEmpty(connection, "ca_cert_path");
        if (!ca.isBlank()) {
            builder.trustManager(new File(ca));
        }
        String cert = firstNonBlank(stringOrNull(connection, "client_cert_path"), stringOrNull(connection, "cert_path"));
        String key = firstNonBlank(stringOrNull(connection, "client_key_path"), stringOrNull(connection, "key_path"));
        if ((cert == null) != (key == null)) {
            throw new IllegalArgumentException("Client certificate and key must be provided together");
        }
        if (cert != null) {
            builder.keyManager(new File(cert), new File(key));
        }
        return builder.build();
    }

    private static Object listPrefix(JsonObject params) throws Exception {
        KV active = requireKv();
        String prefix = stringOrDefault(params, "prefix", "");
        int limit = intOrDefault(params, "limit", DEFAULT_LIMIT);
        Long revision = longOrNull(params, "revision");
        boolean includeValues = boolOrDefault(params, "includeValues", false);
        String continuation = stringOrNull(params, "continuation");
        ByteSequence start = continuation == null || continuation.isBlank()
            ? prefixStart(prefix)
            : ByteSequence.from(Base64.getDecoder().decode(continuation));
        GetOption.Builder optionBuilder = GetOption.newBuilder()
            .withRange(prefixEnd(byteSequence(prefix)))
            .withLimit(Math.max(1, limit))
            .withSortField(GetOption.SortTarget.KEY)
            .withSortOrder(GetOption.SortOrder.ASCEND);
        if (revision != null && revision > 0) {
            optionBuilder.withRevision(revision);
        }
        GetOption option = optionBuilder.build();
        GetResponse response = active.get(start, option).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);

        List<Map<String, Object>> keys = new ArrayList<>();
        List<KeyValue> kvs = response.getKvs();
        for (KeyValue item : kvs) {
            Map<String, Object> row = metadata(item);
            row.put("key", displayBytes(item.getKey().getBytes()));
            row.put("keyBytes", bytesObject(item.getKey().getBytes()));
            if (includeValues) {
                row.put("value", valueObject(item.getValue().getBytes()));
            }
            keys.add(row);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("keys", keys);
        result.put("continuation", response.isMore() && !kvs.isEmpty() ? nextContinuation(kvs.get(kvs.size() - 1)) : null);
        result.put("revision", longString(response.getHeader().getRevision()));
        return result;
    }

    private static Object get(JsonObject params) throws Exception {
        KV active = requireKv();
        ByteSequence key = keyBytes(params);
        Long revision = longOrNull(params, "revision");
        GetOption.Builder optionBuilder = GetOption.newBuilder();
        if (revision != null && revision > 0) {
            optionBuilder.withRevision(revision);
        }
        GetResponse response = active.get(key, optionBuilder.build()).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        Map<String, Object> result = new LinkedHashMap<>();
        if (response.getKvs().isEmpty()) {
            result.put("found", false);
            result.put("key", null);
            result.put("value", null);
            result.put("metadata", null);
            return result;
        }
        KeyValue item = response.getKvs().get(0);
        result.put("found", true);
        result.put("key", displayBytes(item.getKey().getBytes()));
        result.put("keyBytes", bytesObject(item.getKey().getBytes()));
        if (!boolOrDefault(params, "metadataOnly", false)) {
            result.put("value", valueObject(item.getValue().getBytes()));
        } else {
            result.put("value", null);
        }
        result.put("metadata", metadataWithTtl(item));
        return result;
    }

    private static Object put(JsonObject params) throws Exception {
        KV active = requireKv();
        ByteSequence key = keyBytes(params);
        byte[] value = parseValue(params.getAsJsonObject("value"));
        Long expectedModRevision = longOrNull(params, "expectedModRevision");
        Long expectedCreateRevision = longOrNull(params, "expectedCreateRevision");
        JsonElement leaseElement = params.get("lease");
        JsonElement ttlElement = params.get("ttl");
        boolean hasLease = leaseElement != null && !leaseElement.isJsonNull();
        boolean hasTtl = ttlElement != null && !ttlElement.isJsonNull();
        boolean preserveLease = boolOrDefault(params, "preserveLease", false);
        if ((hasLease && hasTtl) || (preserveLease && (hasLease || hasTtl))) {
            throw new IllegalArgumentException("lease, ttl, and preserveLease cannot be specified together");
        }
        if (preserveLease) {
            long revision = putPreservingLease(active, key, ByteSequence.from(value));
            return Collections.singletonMap("revision", longString(revision));
        }
        PutOption option = PutOption.DEFAULT;
        long grantedLeaseId = 0;
        if (hasTtl) {
            long ttl = ttlElement.getAsLong();
            if (ttl <= 0) throw new IllegalArgumentException("ttl must be a positive integer");
            LeaseGrantResponse grant = requireClient().getLeaseClient().grant(ttl).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            grantedLeaseId = grant.getID();
            option = PutOption.newBuilder().withLeaseId(grantedLeaseId).build();
        } else if (hasLease) {
            option = PutOption.newBuilder().withLeaseId(leaseElement.getAsLong()).build();
        }
        final long leaseToCleanUp = grantedLeaseId;
        final Lease leaseClient = leaseToCleanUp == 0 ? null : requireClient().getLeaseClient();
        final PutOption writeOption = option;
        return cleanUpGrantedLeaseOnFailure(leaseToCleanUp, leaseClient, () -> {
            if (expectedModRevision != null || expectedCreateRevision != null) {
                List<Cmp> comparisons = new ArrayList<>();
                if (expectedModRevision != null) {
                    comparisons.add(new Cmp(key, Cmp.Op.EQUAL, CmpTarget.modRevision(expectedModRevision)));
                }
                if (expectedCreateRevision != null) {
                    comparisons.add(new Cmp(key, Cmp.Op.EQUAL, CmpTarget.createRevision(expectedCreateRevision)));
                }
                TxnResponse response = active.txn()
                    .If(comparisons.toArray(Cmp[]::new))
                    .Then(Op.put(key, ByteSequence.from(value), writeOption))
                    .commit()
                    .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                if (!response.isSucceeded()) {
                    throw new IllegalStateException("ETCD_CAS_CONFLICT: key changed after it was loaded");
                }
                return Collections.singletonMap("revision", longString(response.getHeader().getRevision()));
            }
            PutResponse response = active.put(key, ByteSequence.from(value), writeOption)
                .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            return Collections.singletonMap("revision", longString(response.getHeader().getRevision()));
        });
    }

    static <T> T cleanUpGrantedLeaseOnFailure(long grantedLeaseId, Lease leaseClient, Callable<T> write) throws Exception {
        try {
            return write.call();
        } catch (Exception error) {
            if (grantedLeaseId != 0) {
                try {
                    leaseClient.revoke(grantedLeaseId).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                } catch (Exception revokeError) {
                    error.addSuppressed(revokeError);
                }
            }
            throw error;
        }
    }

    static long putPreservingLease(KV active, ByteSequence key, ByteSequence value) throws Exception {
        for (int attempt = 0; attempt < PRESERVE_LEASE_MAX_ATTEMPTS; attempt++) {
            GetResponse existing = active.get(key, GetOption.DEFAULT).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (existing.getKvs().isEmpty() || existing.getKvs().get(0).getLease() <= 0) {
                throw new IllegalStateException("Cannot preserve lease: key does not exist or has no lease");
            }

            KeyValue current = existing.getKvs().get(0);
            PutOption option = PutOption.builder().withLeaseId(current.getLease()).build();
            TxnResponse response = active.txn()
                .If(new Cmp(key, Cmp.Op.EQUAL, CmpTarget.modRevision(current.getModRevision())))
                .Then(Op.put(key, value, option))
                .commit()
                .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (response.isSucceeded()) {
                return response.getHeader().getRevision();
            }
        }

        throw new IllegalStateException("Cannot preserve lease: key changed concurrently; retry the save");
    }

    private static Object delete(JsonObject params) throws Exception {
        KV active = requireKv();
        ByteSequence key = keyBytes(params);
        Long expectedModRevision = longOrNull(params, "expectedModRevision");
        if (expectedModRevision != null) {
            TxnResponse txnResponse = active.txn()
                .If(new Cmp(key, Cmp.Op.EQUAL, CmpTarget.modRevision(expectedModRevision)))
                .Then(Op.delete(key, DeleteOption.DEFAULT))
                .commit()
                .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!txnResponse.isSucceeded()) {
                throw new IllegalStateException("ETCD_CAS_CONFLICT: key changed after it was loaded");
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("deleted", 1);
            result.put("revision", longString(txnResponse.getHeader().getRevision()));
            return result;
        }
        DeleteResponse response = active.delete(key).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("deleted", response.getDeleted());
        result.put("revision", longString(response.getHeader().getRevision()));
        return result;
    }

    private static Object rename(JsonObject params) throws Exception {
        KV active = requireKv();
        ByteSequence sourceKey = keyBytes(params);
        ByteSequence targetKey = byteSequence(params.get("newKey").getAsString());
        if (Arrays.equals(sourceKey.getBytes(), targetKey.getBytes())) {
            Map<String, Object> unchanged = new LinkedHashMap<>();
            unchanged.put("renamed", true);
            unchanged.put("revision", null);
            return unchanged;
        }

        GetResponse sourceResponse = active.get(sourceKey).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (sourceResponse.getKvs().isEmpty()) {
            throw new IllegalStateException("ETCD_NOT_FOUND: source key does not exist");
        }
        KeyValue source = sourceResponse.getKvs().get(0);
        Long expected = longOrNull(params, "expectedModRevision");
        long expectedRevision = expected == null ? source.getModRevision() : expected;
        PutOption putOption = source.getLease() == 0
            ? PutOption.DEFAULT
            : PutOption.newBuilder().withLeaseId(source.getLease()).build();

        TxnResponse response = active.txn()
            .If(
                new Cmp(sourceKey, Cmp.Op.EQUAL, CmpTarget.modRevision(expectedRevision)),
                new Cmp(targetKey, Cmp.Op.EQUAL, CmpTarget.createRevision(0))
            )
            .Then(
                Op.put(targetKey, source.getValue(), putOption),
                Op.delete(sourceKey, DeleteOption.DEFAULT)
            )
            .commit()
            .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (!response.isSucceeded()) {
            throw new IllegalStateException("ETCD_CAS_CONFLICT: source changed or target already exists");
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("renamed", true);
        result.put("revision", longString(response.getHeader().getRevision()));
        return result;
    }

    private static Object history(JsonObject params) throws Exception {
        requireKv();
        ByteSequence key = keyBytes(params);
        int limit = Math.min(Math.max(1, intOrDefault(params, "limit", 100)), 500);
        Long requestedEnd = longOrNull(params, "endRevision");
        GetOption.Builder latestOption = GetOption.newBuilder();
        if (requestedEnd != null && requestedEnd > 0) {
            latestOption.withRevision(requestedEnd);
        }
        GetResponse latest = sessionState().kv.get(key, latestOption.build()).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        long endRevision = requestedEnd == null ? latest.getHeader().getRevision() : requestedEnd;
        long targetKeyRevision = latest.getKvs().isEmpty()
            ? endRevision
            : latest.getKvs().get(0).getModRevision();
        Long requestedStart = longOrNull(params, "startRevision");
        long startRevision = historyStartRevision(requestedStart, targetKeyRevision);
        if (startRevision > targetKeyRevision) {
            return Map.of(
                "events", Collections.emptyList(),
                "observedRevision", longString(endRevision),
                "truncated", false
            );
        }

        Deque<Map<String, Object>> events = new ArrayDeque<>(limit);
        AtomicBoolean truncated = new AtomicBoolean(requestedStart == null && startRevision > 1L);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        CountDownLatch created = new CountDownLatch(1);
        CountDownLatch completed = new CountDownLatch(1);
        Watch watch = sessionState().client.getWatchClient();
        WatchOption option = WatchOption.newBuilder()
            .withRevision(startRevision)
            .withPrevKV(true)
            .withProgressNotify(true)
            .withCreateNotify(true)
            .build();

        Watch.Watcher watcher = watch.watch(key, option, new Watch.Listener() {
            @Override
            public void onNext(WatchResponse response) {
                if (response.isCreatedNotify()) {
                    created.countDown();
                }
                for (WatchEvent event : response.getEvents()) {
                    KeyValue item = event.getKeyValue();
                    long revision = item.getModRevision();
                    if (revision > endRevision) {
                        continue;
                    }
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("eventType", event.getEventType() == WatchEvent.EventType.DELETE ? "delete" : "put");
                    row.put("revision", longString(revision));
                    row.put(
                        "value",
                        event.getEventType() == WatchEvent.EventType.DELETE
                            ? null
                            : valueObject(item.getValue().getBytes())
                    );
                    KeyValue previous = event.getPrevKV();
                    row.put(
                        "previousValue",
                        previous != null && previous.getVersion() > 0
                            ? valueObject(previous.getValue().getBytes())
                            : null
                    );
                    row.put(
                        "metadata",
                        event.getEventType() == WatchEvent.EventType.DELETE && previous != null
                            ? metadata(previous)
                            : metadata(item)
                    );
                    appendBoundedHistory(events, row, limit, truncated);
                    if (revision >= targetKeyRevision) {
                        completed.countDown();
                    }
                }
                if (response.isProgressNotify() && response.getHeader().getRevision() >= endRevision) {
                    completed.countDown();
                }
            }

            @Override
            public void onError(Throwable throwable) {
                failure.set(throwable);
                completed.countDown();
            }

            @Override
            public void onCompleted() {
                completed.countDown();
            }
        });

        try {
            if (!created.await(5, TimeUnit.SECONDS)) {
                throw new IllegalStateException("ETCD_HISTORY_TIMEOUT: watcher was not created");
            }
            // For an existing exact key, its latest mod revision is an explicit
            // replay boundary. This avoids relying on progress notifications,
            // which older etcd/jetcd combinations do not consistently emit.
            watcher.requestProgress();
            if (!completed.await(15, TimeUnit.SECONDS)) {
                throw new IllegalStateException("ETCD_HISTORY_TIMEOUT: history replay did not reach the requested revision");
            }
        } finally {
            watcher.close();
        }
        if (failure.get() != null) {
            Throwable cause = rootCause(failure.get());
            if (cause instanceof io.etcd.jetcd.common.exception.CompactedException compacted) {
                throw new IllegalStateException(
                    "ETCD_COMPACTED: requested history was compacted at revision " + compacted.getCompactedRevision()
                );
            }
            throw new IllegalStateException("ETCD_HISTORY_FAILED: " + safeMessage(cause));
        }

        List<Map<String, Object>> page;
        synchronized (events) {
            page = new ArrayList<>(events);
        }
        page.sort(Comparator.comparingLong(row -> -Long.parseLong((String) row.get("revision"))));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("events", page);
        result.put("observedRevision", longString(endRevision));
        result.put("truncated", truncated.get());
        return result;
    }

    static long historyStartRevision(Long requestedStart, long targetRevision) {
        if (requestedStart != null) {
            return Math.max(1L, requestedStart);
        }
        return Math.max(1L, targetRevision - HISTORY_DEFAULT_REVISION_WINDOW + 1L);
    }

    static <T> void appendBoundedHistory(
        Deque<T> events,
        T event,
        int limit,
        AtomicBoolean truncated
    ) {
        synchronized (events) {
            if (events.size() == limit) {
                events.removeFirst();
                truncated.set(true);
            }
            events.addLast(event);
        }
    }

    private static Object status() throws Exception {
        requireKv();
        Maintenance maintenance = sessionState().client.getMaintenanceClient();
        Cluster cluster = sessionState().client.getClusterClient();
        Map<Long, Member> membersById = new HashMap<>();
        List<String> endpoints = new ArrayList<>(sessionState().connectedEndpoints);
        try {
            MemberListResponse memberList = cluster.listMember().get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            for (Member member : memberList.getMembers()) {
                membersById.put(member.getId(), member);
                for (java.net.URI uri : member.getClientURIs()) {
                    if (uri.getHost() == null || "0.0.0.0".equals(uri.getHost()) || "::".equals(uri.getHost())) {
                        continue;
                    }
                    String endpoint = uri.toString();
                    if (!endpoints.contains(endpoint)) {
                        endpoints.add(endpoint);
                    }
                }
            }
        } catch (Exception ignored) {
            // Status still provides useful information for configured endpoints.
        }

        List<String> alarms = new ArrayList<>();
        try {
            AlarmResponse alarmResponse = maintenance.listAlarms().get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            for (AlarmMember alarm : alarmResponse.getAlarms()) {
                alarms.add(alarm.getAlarmType().name() + "@" + Long.toUnsignedString(alarm.getMemberId()));
            }
        } catch (Exception error) {
            alarms.add("UNAVAILABLE: " + safeMessage(rootCause(error)));
        }

        GetOption countOption = GetOption.newBuilder()
            .withRange(ByteSequence.from(new byte[] {0}))
            .withCountOnly(true)
            .build();
        GetResponse countResponse = sessionState().kv.get(ByteSequence.from(new byte[] {0}), countOption)
            .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);

        List<Map<String, Object>> statusMembers = new ArrayList<>();
        Set<String> observedMemberIds = new HashSet<>();
        String clusterId = null;
        String revision = longString(countResponse.getHeader().getRevision());
        String leaderId = null;
        Map<String, CompletableFuture<StatusResponse>> statusRequests = new LinkedHashMap<>();
        Map<String, Long> statusStartedNanos = new LinkedHashMap<>();
        for (String endpoint : endpoints) {
            statusStartedNanos.put(endpoint, System.nanoTime());
            statusRequests.put(endpoint, maintenance.statusMember(endpoint));
        }
        for (String endpoint : endpoints) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("endpoint", endpoint);
            long started = statusStartedNanos.get(endpoint);
            try {
                StatusResponse memberStatus = statusRequests.get(endpoint)
                    .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                long latencyMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
                long memberId = memberStatus.getHeader().getMemberId();
                Member member = membersById.get(memberId);
                clusterId = unsignedLongString(memberStatus.getHeader().getClusterId());
                leaderId = unsignedLongString(memberStatus.getLeader());
                row.put("memberId", unsignedLongString(memberId));
                row.put("name", member == null ? null : member.getName());
                row.put("version", memberStatus.getVersion());
                row.put("leaderId", unsignedLongString(memberStatus.getLeader()));
                row.put("revision", longString(memberStatus.getHeader().getRevision()));
                row.put("raftTerm", longString(memberStatus.getRaftTerm()));
                row.put("raftIndex", longString(memberStatus.getRaftIndex()));
                row.put("raftAppliedIndex", longString(memberStatus.getRaftAppliedIndex()));
                row.put("dbSize", longString(memberStatus.getDbSize()));
                row.put("dbSizeInUse", longString(memberStatus.getDbSizeInUse()));
                row.put("learner", memberStatus.isLearner());
                row.put("reachable", true);
                row.put("latencyMs", latencyMs);
                row.put("errors", memberStatus.getErrorList());
                if (!observedMemberIds.add(unsignedLongString(memberId))) {
                    continue;
                }
            } catch (Exception error) {
                statusRequests.get(endpoint).cancel(true);
                row.put("memberId", null);
                row.put("name", null);
                row.put("version", null);
                row.put("leaderId", null);
                row.put("revision", null);
                row.put("raftTerm", null);
                row.put("raftIndex", null);
                row.put("raftAppliedIndex", null);
                row.put("dbSize", null);
                row.put("dbSizeInUse", null);
                row.put("learner", false);
                row.put("reachable", false);
                row.put("latencyMs", null);
                row.put("errors", List.of(safeMessage(rootCause(error))));
            }
            statusMembers.add(row);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("clusterId", clusterId);
        result.put("revision", revision);
        result.put("leaderId", leaderId);
        result.put("keyCount", longString(countResponse.getCount()));
        result.put("alarms", alarms);
        result.put("members", statusMembers);
        return result;
    }

    private static Object compact(JsonObject params) throws Exception {
        long revision = requiredPositiveLong(params, "revision");
        try {
            requireKv().get(ByteSequence.from(new byte[] {0}), GetOption.newBuilder()
                .withRange(ByteSequence.from(new byte[] {0}))
                .withCountOnly(true)
                .withRevision(revision)
                .build())
                .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (Exception error) {
            Throwable cause = rootCause(error);
            if (cause instanceof io.etcd.jetcd.common.exception.CompactedException compacted) {
                throw new IllegalArgumentException(
                    "ETCD_INVALID_REVISION: revision was already compacted at " + compacted.getCompactedRevision()
                );
            }
            throw error;
        }
        GetResponse current = requireKv().get(ByteSequence.from(new byte[] {0}), GetOption.newBuilder()
            .withRange(ByteSequence.from(new byte[] {0})).withCountOnly(true).build())
            .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        if (revision > current.getHeader().getRevision()) {
            throw new IllegalArgumentException("ETCD_INVALID_REVISION: revision is newer than the current revision");
        }
        requireKv().compact(revision).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        return Map.of("revision", longString(revision));
    }

    private static Object defrag(JsonObject params) throws Exception {
        JsonElement endpointsValue = params.get("endpoints");
        if (endpointsValue == null || !endpointsValue.isJsonArray() || endpointsValue.getAsJsonArray().isEmpty()) {
            throw new IllegalArgumentException("ETCD_DEFRAG_TARGET_REQUIRED: at least one endpoint is required");
        }
        Maintenance maintenance = requireClient().getMaintenanceClient();
        List<Map<String, Object>> members = new ArrayList<>();
        List<String> remaining = new ArrayList<>();
        for (JsonElement value : endpointsValue.getAsJsonArray()) {
            String endpoint = value.getAsString();
            if (!endpoint.isBlank() && !remaining.contains(endpoint)) remaining.add(endpoint);
        }
        while (!remaining.isEmpty()) {
            String endpoint = nextDefragEndpoint(maintenance, remaining);
            long started = System.nanoTime();
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("endpoint", endpoint);
            try {
                maintenance.defragmentMember(endpoint).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                row.put("status", "succeeded");
                row.put("durationMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
            } catch (Exception error) {
                row.put("status", "failed");
                row.put("durationMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
                row.put("error", safeMessage(rootCause(error)));
                members.add(row);
                appendUnexecutedDefragMembers(members, remaining, endpoint);
                break;
            }
            members.add(row);
            remaining.remove(endpoint);
        }
        return Map.of("members", members);
    }

    static void appendUnexecutedDefragMembers(
        List<Map<String, Object>> members,
        List<String> remaining,
        String failedEndpoint
    ) {
        for (String endpoint : remaining) {
            if (endpoint.equals(failedEndpoint)) continue;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("endpoint", endpoint);
            row.put("status", "not_executed");
            row.put("durationMs", null);
            row.put("error", null);
            members.add(row);
        }
    }

    /** Re-evaluate leadership before each member so a leader change is not defragmented early. */
    private static String nextDefragEndpoint(Maintenance maintenance, List<String> remaining) throws Exception {
        String leaderEndpoint = null;
        for (String endpoint : remaining) {
            try {
                StatusResponse status = maintenance.statusMember(endpoint).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                if (status.getHeader().getMemberId() == status.getLeader()) {
                    leaderEndpoint = endpoint;
                    break;
                }
            } catch (Exception ignored) {
                // The following defragment call reports this member as the failed step.
            }
        }
        for (String endpoint : remaining) {
            if (!endpoint.equals(leaderEndpoint)) return endpoint;
        }
        return leaderEndpoint == null ? remaining.get(0) : leaderEndpoint;
    }

    private static Object watchStart(JsonObject params) throws Exception {
        EtcdSessionState session = sessionState();
        if (session.watches.size() >= MAX_WATCHES) {
            throw new IllegalStateException("ETCD_WATCH_LIMIT: at most " + MAX_WATCHES + " watches are allowed per connection");
        }
        ByteSequence key = keyBytes(params);
        String scope = stringOrDefault(params, "scope", "key");
        if (!"key".equals(scope) && !"prefix".equals(scope)) {
            throw new IllegalArgumentException("ETCD_WATCH_SCOPE_INVALID: scope must be key or prefix");
        }
        Long requestedRevision = longOrNull(params, "startRevision");
        long startedRevision;
        if (requestedRevision != null && requestedRevision > 0) {
            startedRevision = requestedRevision;
        } else {
            GetResponse response = requireKv().get(ByteSequence.from(new byte[] {0}), GetOption.newBuilder()
                .withRange(ByteSequence.from(new byte[] {0})).withCountOnly(true).build())
                .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            startedRevision = response.getHeader().getRevision() + 1;
        }
        String watchId = UUID.randomUUID().toString();
        EtcdWatchState state = new EtcdWatchState(watchId, session);
        WatchOption.Builder option = WatchOption.newBuilder().withRevision(startedRevision)
            .withPrevKV(boolOrDefault(params, "includePrevKv", false));
        if ("prefix".equals(scope)) option.withRange(prefixEnd(key));
        try {
            Watch.Watcher watcher = requireClient().getWatchClient().watch(key, option.build(), new Watch.Listener() {
                @Override
                public void onNext(WatchResponse response) {
                    if (response.getEvents().isEmpty()) return;
                    List<Map<String, Object>> events = new ArrayList<>();
                    long bufferedBytes = 128;
                    for (WatchEvent event : response.getEvents()) {
                        KeyValue item = event.getKeyValue();
                        KeyValue previous = event.getPrevKV();
                        bufferedBytes += watchEventBufferBytes(item, previous);
                        if (bufferedBytes > MAX_WATCH_BUFFER_BYTES) {
                            state.overflow();
                            return;
                        }
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("eventType", event.getEventType() == WatchEvent.EventType.DELETE ? "delete" : "put");
                        row.put("revision", longString(item.getModRevision()));
                        row.put("key", displayBytes(item.getKey().getBytes()));
                        row.put("keyBytes", bytesObject(item.getKey().getBytes()));
                        row.put("value", event.getEventType() == WatchEvent.EventType.DELETE ? null : valueObject(item.getValue().getBytes()));
                        row.put("previousValue", previous != null && previous.getVersion() > 0 ? valueObject(previous.getValue().getBytes()) : null);
                        row.put("metadata", event.getEventType() == WatchEvent.EventType.DELETE && previous != null ? metadata(previous) : metadata(item));
                        events.add(row);
                    }
                    state.append(response.getHeader().getRevision(), events, bufferedBytes);
                }

                @Override
                public void onError(Throwable error) {
                    Throwable cause = rootCause(error);
                    if (cause instanceof io.etcd.jetcd.common.exception.CompactedException compacted) {
                        state.fail("compacted", "ETCD_COMPACTED", compacted.getCompactedRevision());
                    } else {
                        state.fail("error", safeMessage(cause), null);
                    }
                }

                @Override
                public void onCompleted() {
                    state.fail("closed", "watch closed", null);
                }
            });
            state.setWatcher(watcher);
            session.watches.put(watchId, state);
        } catch (Exception error) {
            state.close();
            throw error;
        }
        return Map.of("watchId", watchId, "startedRevision", longString(startedRevision));
    }

    private static Object watchPoll(JsonObject params) throws Exception {
        return pollWatchState(sessionState(), stringOrEmpty(params, "watchId"));
    }

    static Map<String, Object> pollWatchState(EtcdSessionState session, String watchId) {
        EtcdWatchState state = session.watches.get(watchId);
        if (state == null) throw new IllegalStateException("ETCD_WATCH_NOT_FOUND: watch does not exist");
        Map<String, Object> result = state.poll();
        if (result.containsKey("terminal") && session.watches.remove(watchId, state)) {
            state.close();
        }
        return result;
    }

    private static Object watchStop(JsonObject params) {
        EtcdWatchState state = sessionState().watches.remove(stringOrEmpty(params, "watchId"));
        if (state != null) state.close();
        return Map.of("stopped", true);
    }

    private static Object leaseList(JsonObject params) throws Exception {
        long deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(LEASE_LIST_DEADLINE_SECONDS);
        int limit = Math.min(Math.max(1, intOrDefault(params, "limit", DEFAULT_LEASE_LIST_LIMIT)), MAX_LEASE_LIST_LIMIT);
        String continuation = stringOrNull(params, "continuation");
        Long afterLeaseId = continuation == null || continuation.isBlank()
            ? null
            : Long.parseUnsignedLong(continuation);
        boolean partial = false;
        List<Long> leaseIds;
        try {
            leaseIds = clusterLeaseIds(remainingMillis(deadlineNanos));
            sessionState().knownLeases.addAll(leaseIds);
        } catch (ReflectiveOperationException error) {
            leaseIds = new ArrayList<>(sessionState().knownLeases);
            partial = true;
        } catch (java.util.concurrent.TimeoutException error) {
            leaseIds = new ArrayList<>(sessionState().knownLeases);
            partial = true;
        } catch (StatusRuntimeException error) {
            if (error.getStatus().getCode() != Status.Code.UNIMPLEMENTED
                && error.getStatus().getCode() != Status.Code.DEADLINE_EXCEEDED) {
                throw error;
            }
            leaseIds = new ArrayList<>(sessionState().knownLeases);
            partial = true;
        }
        leaseIds = leasePageIds(leaseIds, afterLeaseId, limit + 1);
        boolean hasMore = leaseIds.size() > limit;
        List<Long> pageIds = new ArrayList<>(leaseIds.subList(0, Math.min(limit, leaseIds.size())));

        List<Map<String, Object>> leases = new ArrayList<>();
        Long lastProcessedId = null;
        boolean deadlineReached = false;
        outer:
        for (int offset = 0; offset < pageIds.size(); offset += LEASE_LIST_CONCURRENCY) {
            List<Long> chunkIds = pageIds.subList(offset, Math.min(offset + LEASE_LIST_CONCURRENCY, pageIds.size()));
            Map<Long, CompletableFuture<LeaseTimeToLiveResponse>> requests = new LinkedHashMap<>();
            for (Long id : chunkIds) {
                requests.put(id, requireClient().getLeaseClient().timeToLive(id, LeaseOption.DEFAULT));
            }
            for (Map.Entry<Long, CompletableFuture<LeaseTimeToLiveResponse>> request : requests.entrySet()) {
                try {
                    LeaseTimeToLiveResponse response = request.getValue().get(
                        remainingMillis(deadlineNanos),
                        TimeUnit.MILLISECONDS
                    );
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("id", longString(response.getID()));
                    row.put("ttl", response.getTTL());
                    row.put("grantedTtl", response.getGrantedTTL());
                    leases.add(row);
                    lastProcessedId = request.getKey();
                } catch (java.util.concurrent.TimeoutException error) {
                    requests.values().forEach(future -> future.cancel(true));
                    partial = true;
                    deadlineReached = true;
                    break outer;
                } catch (Exception error) {
                    Throwable cause = rootCause(error);
                    if (Status.fromThrowable(cause).getCode() == Status.Code.NOT_FOUND) {
                        sessionState().knownLeases.remove(request.getKey());
                    } else {
                        partial = true;
                    }
                    lastProcessedId = request.getKey();
                }
            }
        }
        String nextContinuation = null;
        if (deadlineReached && !pageIds.isEmpty()) {
            nextContinuation = unsignedLongString(lastProcessedId != null ? lastProcessedId : afterLeaseId != null ? afterLeaseId : 0L);
        } else if (hasMore && !pageIds.isEmpty()) {
            nextContinuation = unsignedLongString(pageIds.get(pageIds.size() - 1));
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("leases", leases);
        result.put("partial", partial);
        result.put("nextContinuation", nextContinuation);
        return result;
    }

    static List<Long> leasePageIds(List<Long> leaseIds, Long afterLeaseId, int fetchLimit) {
        return leaseIds.stream()
            .sorted(Long::compareUnsigned)
            .filter(id -> afterLeaseId == null || Long.compareUnsigned(id, afterLeaseId) > 0)
            .limit(Math.max(0, fetchLimit))
            .toList();
    }

    private static long remainingMillis(long deadlineNanos) throws java.util.concurrent.TimeoutException {
        long remaining = TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime());
        if (remaining <= 0) throw new java.util.concurrent.TimeoutException("ETCD_LEASE_LIST_TIMEOUT");
        return remaining;
    }

    private static List<Long> clusterLeaseIds(long timeoutMillis) throws Exception {
        VertxLeaseGrpc.LeaseVertxStub stub = leaseStub(requireClient().getLeaseClient());
        byte[] response = ClientCalls.blockingUnaryCall(
            stub.getChannel(),
            LEASES_METHOD,
            stub.getCallOptions().withDeadlineAfter(timeoutMillis, TimeUnit.MILLISECONDS),
            new byte[0]
        );
        return leaseIdsFromResponse(response);
    }

    static List<Long> leaseIdsFromResponse(byte[] response) throws IOException {
        List<Long> ids = new ArrayList<>();
        CodedInputStream input = CodedInputStream.newInstance(response);
        while (!input.isAtEnd()) {
            int tag = input.readTag();
            if (tag == 0) break;
            if (WireFormat.getTagFieldNumber(tag) != 2 || WireFormat.getTagWireType(tag) != WireFormat.WIRETYPE_LENGTH_DELIMITED) {
                input.skipField(tag);
                continue;
            }
            CodedInputStream lease = CodedInputStream.newInstance(input.readByteArray());
            while (!lease.isAtEnd()) {
                int leaseTag = lease.readTag();
                if (leaseTag == 0) break;
                if (WireFormat.getTagFieldNumber(leaseTag) == 1 && WireFormat.getTagWireType(leaseTag) == WireFormat.WIRETYPE_VARINT) {
                    ids.add(lease.readInt64());
                } else {
                    lease.skipField(leaseTag);
                }
            }
        }
        return ids;
    }

    private static Object leaseGet(JsonObject params) throws Exception {
        long id = requiredPositiveLong(params, "id");
        LeaseOption option = boolOrDefault(params, "includeKeys", false) ? LeaseOption.newBuilder().withAttachedKeys().build() : LeaseOption.DEFAULT;
        LeaseTimeToLiveResponse response = requireClient().getLeaseClient().timeToLive(id, option)
            .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        sessionState().knownLeases.add(id);
        List<Map<String, Object>> keys = new ArrayList<>();
        List<ByteSequence> attachedKeys = response.getKeys();
        for (int index = 0; index < attachedKeys.size() && index < MAX_LEASE_ATTACHED_KEYS; index++) {
            keys.add(bytesObject(attachedKeys.get(index).getBytes()));
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", longString(response.getID()));
        result.put("ttl", response.getTTL());
        result.put("grantedTtl", response.getGrantedTTL());
        result.put("keys", keys);
        result.put("truncated", attachedKeys.size() > MAX_LEASE_ATTACHED_KEYS);
        return result;
    }

    private static Object leaseGrant(JsonObject params) throws Exception {
        long ttl = requiredPositiveLong(params, "ttl");
        Long requestedId = longOrNull(params, "id");
        if (requestedId != null && requestedId < 0) throw new IllegalArgumentException("id must be a positive integer or 0");
        LeaseGrantResponse response = requestedId == null || requestedId == 0
            ? requireClient().getLeaseClient().grant(ttl).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            : grantLeaseWithRequestedId(ttl, requestedId);
        sessionState().knownLeases.add(response.getID());
        return Map.of("id", longString(response.getID()), "ttl", response.getTTL());
    }

    private static LeaseGrantResponse grantLeaseWithRequestedId(long ttl, long requestedId) throws Exception {
        Lease lease = requireClient().getLeaseClient();
        try {
            VertxLeaseGrpc.LeaseVertxStub stub = leaseStub(lease);
            io.etcd.jetcd.api.LeaseGrantResponse response = stub
                .withDeadlineAfter(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .leaseGrant(io.etcd.jetcd.api.LeaseGrantRequest.newBuilder().setTTL(ttl).setID(requestedId).build())
                .toCompletionStage()
                .toCompletableFuture()
                .get(RPC_TIMEOUT_SECONDS + 1L, TimeUnit.SECONDS);
            return new LeaseGrantResponse(response);
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("Custom Lease ID is unavailable in the installed Jetcd version", error);
        }
    }

    private static VertxLeaseGrpc.LeaseVertxStub leaseStub(Lease lease) throws ReflectiveOperationException {
        Field stubField = lease.getClass().getDeclaredField("stub");
        stubField.setAccessible(true);
        return (VertxLeaseGrpc.LeaseVertxStub) stubField.get(lease);
    }

    private static Object leaseKeepAlive(JsonObject params) throws Exception {
        long id = requiredPositiveLong(params, "id");
        long ttl = requireClient().getLeaseClient().keepAliveOnce(id).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS).getTTL();
        sessionState().knownLeases.add(id);
        return Map.of("id", longString(id), "ttl", ttl);
    }

    private static Object leaseRevoke(JsonObject params) throws Exception {
        long id = requiredPositiveLong(params, "id");
        requireClient().getLeaseClient().revoke(id).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        sessionState().knownLeases.remove(id);
        return Map.of("id", longString(id), "revoked", true);
    }

    private static Object authUserList() throws Exception {
        return Map.of("users", requireClient().getAuthClient().userList().get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS).getUsers());
    }

    private static Object authUserGet(JsonObject params) throws Exception {
        String user = requiredString(params, "user");
        return Map.of("user", user, "roles", requireClient().getAuthClient().userGet(byteSequence(user))
            .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS).getRoles());
    }

    private static Object authUserAdd(JsonObject params) throws Exception {
        requireClient().getAuthClient().userAdd(byteSequence(requiredString(params, "user")), byteSequence(requiredString(params, "password")))
            .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        return Map.of("created", true);
    }

    private static Object authUserDelete(JsonObject params) throws Exception {
        requireClient().getAuthClient().userDelete(byteSequence(requiredString(params, "user"))).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        return Map.of("deleted", true);
    }

    private static Object authUserChangePassword(JsonObject params) throws Exception {
        requireClient().getAuthClient().userChangePassword(byteSequence(requiredString(params, "user")), byteSequence(requiredString(params, "password")))
            .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        return Map.of("changed", true);
    }

    private static Object authUserRole(JsonObject params, boolean grant) throws Exception {
        Auth auth = requireClient().getAuthClient();
        ByteSequence user = byteSequence(requiredString(params, "user"));
        ByteSequence role = byteSequence(requiredString(params, "role"));
        if (grant) auth.userGrantRole(user, role).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        else auth.userRevokeRole(user, role).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        return Map.of("updated", true);
    }

    private static Object authRoleList() throws Exception {
        return Map.of("roles", requireClient().getAuthClient().roleList().get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS).getRoles());
    }

    private static Object authRoleGet(JsonObject params) throws Exception {
        String role = requiredString(params, "role");
        List<Map<String, Object>> permissions = new ArrayList<>();
        for (Permission permission : requireClient().getAuthClient().roleGet(byteSequence(role)).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS).getPermissions()) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("access", permission.getPermType().name().toLowerCase());
            item.put("key", bytesObject(permission.getKey().getBytes()));
            item.put("rangeEnd", bytesObject(permission.getRangeEnd().getBytes()));
            byte[] keyBytes = permission.getKey().getBytes();
            byte[] rangeEndBytes = permission.getRangeEnd().getBytes();
            String resource = keyBytes.length == 1 && keyBytes[0] == 0
                && rangeEndBytes.length == 1 && rangeEndBytes[0] == 0
                ? "all"
                : rangeEndBytes.length == 0 ? "key" : "prefix";
            item.put("resource", resource);
            permissions.add(item);
        }
        return Map.of("role", role, "permissions", permissions);
    }

    private static Object authRoleAdd(JsonObject params) throws Exception {
        requireClient().getAuthClient().roleAdd(byteSequence(requiredString(params, "role"))).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        return Map.of("created", true);
    }

    private static Object authRoleDelete(JsonObject params) throws Exception {
        requireClient().getAuthClient().roleDelete(byteSequence(requiredString(params, "role"))).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        return Map.of("deleted", true);
    }

    private static Object authRolePermission(JsonObject params, boolean grant) throws Exception {
        Auth auth = requireClient().getAuthClient();
        ByteSequence role = byteSequence(requiredString(params, "role"));
        String resource = stringOrDefault(params, "resource", "key");
        boolean all = "all".equals(resource);
        boolean prefix = "prefix".equals(resource);
        ByteSequence key = all ? ByteSequence.from(new byte[] {0}) : keyBytes(params);
        ByteSequence rangeEnd = all
            ? ByteSequence.from(new byte[] {0})
            : prefix ? prefixEnd(key) : ByteSequence.from(new byte[0]);
        if (grant) {
            Permission.Type access = Permission.Type.valueOf(requiredString(params, "access").toUpperCase());
            auth.roleGrantPermission(role, key, rangeEnd, access).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } else {
            auth.roleRevokePermission(role, key, rangeEnd).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        }
        return Map.of("updated", true);
    }

    private static long requiredPositiveLong(JsonObject params, String field) {
        Long value = longOrNull(params, field);
        if (value == null || value <= 0) throw new IllegalArgumentException("ETCD_INVALID_" + field.toUpperCase() + ": a positive integer is required");
        return value;
    }

    private static String requiredString(JsonObject params, String field) {
        String value = stringOrNull(params, field);
        if (value == null || value.isBlank()) throw new IllegalArgumentException("ETCD_" + field.toUpperCase() + "_REQUIRED");
        return value;
    }

    static long watchEventBufferBytes(KeyValue item, KeyValue previous) {
        long bytes = 512L + estimatedBufferedBytes(item.getKey().size());
        bytes += estimatedBufferedBytes(item.getValue().size());
        if (previous != null && previous.getVersion() > 0) {
            bytes += estimatedBufferedBytes(previous.getValue().size());
        }
        return bytes;
    }

    static long estimatedBufferedBytes(int sourceBytes) {
        return Math.max(0L, sourceBytes) * 4L;
    }

    static final class BufferedWatchBatch {
        private final Map<String, Object> payload;
        private final long bufferedBytes;

        private BufferedWatchBatch(Map<String, Object> payload, long bufferedBytes) {
            this.payload = payload;
            this.bufferedBytes = bufferedBytes;
        }
    }

    static final class EtcdWatchState {
        private final String watchId;
        private final EtcdSessionState session;
        private final Deque<BufferedWatchBatch> batches = new ArrayDeque<>();
        private int eventCount;
        private long bufferedBytes;
        private String terminalReason;
        private String terminalMessage;
        private Long compactedRevision;
        private Watch.Watcher watcher;

        EtcdWatchState(String watchId, EtcdSessionState session) {
            this.watchId = watchId;
            this.session = session;
        }

        synchronized void append(long revision, List<Map<String, Object>> events, long batchBytes) {
            if (terminalReason != null) return;
            if (batches.size() >= MAX_WATCH_BATCHES
                || eventCount + events.size() > MAX_WATCH_EVENTS
                || batchBytes > MAX_WATCH_BUFFER_BYTES
                || bufferedBytes + batchBytes > MAX_WATCH_BUFFER_BYTES
                || !session.reserveWatchBuffer(batchBytes)) {
                overflow();
                return;
            }
            Map<String, Object> batch = new LinkedHashMap<>();
            batch.put("revision", longString(revision));
            batch.put("events", events);
            batches.addLast(new BufferedWatchBatch(batch, batchBytes));
            eventCount += events.size();
            bufferedBytes += batchBytes;
        }

        synchronized void overflow() {
            if (terminalReason != null) return;
            terminalReason = "overflow";
            terminalMessage = "ETCD_WATCH_OVERFLOW: the event buffer reached its byte or event limit";
            closeWatcher();
        }

        private synchronized void fail(String reason, String message, Long compacted) {
            if (terminalReason == null) {
                terminalReason = reason;
                terminalMessage = message;
                compactedRevision = compacted;
            }
        }

        synchronized Map<String, Object> poll() {
            List<Map<String, Object>> page = new ArrayList<>();
            while (!batches.isEmpty() && page.size() < 64) {
                BufferedWatchBatch batch = batches.removeFirst();
                eventCount -= ((List<?>) batch.payload.get("events")).size();
                bufferedBytes -= batch.bufferedBytes;
                session.releaseWatchBuffer(batch.bufferedBytes);
                page.add(batch.payload);
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("watchId", watchId);
            result.put("batches", page);
            if (terminalReason != null && batches.isEmpty()) {
                Map<String, Object> terminal = new LinkedHashMap<>();
                terminal.put("reason", terminalReason);
                terminal.put("message", terminalMessage);
                terminal.put("compactedRevision", compactedRevision == null ? null : longString(compactedRevision));
                result.put("terminal", terminal);
            }
            return result;
        }

        private synchronized void close() {
            fail("stopped", "watch stopped", null);
            clearBuffered();
            closeWatcher();
        }

        private void clearBuffered() {
            if (bufferedBytes > 0) session.releaseWatchBuffer(bufferedBytes);
            batches.clear();
            eventCount = 0;
            bufferedBytes = 0;
        }

        private synchronized void setWatcher(Watch.Watcher createdWatcher) {
            if (terminalReason != null) {
                createdWatcher.close();
            } else {
                watcher = createdWatcher;
            }
        }

        private void closeWatcher() {
            if (watcher != null) {
                watcher.close();
                watcher = null;
            }
        }
    }

    private static Object dispatch(String method, JsonObject params) throws Exception {
        return switch (method) {
            case AgentProtocol.METHOD_HANDSHAKE -> handshakeResult();
            case AgentProtocol.METHOD_CONNECT, AgentProtocol.METHOD_TEST_CONNECTION -> connect(params);
            case AgentProtocol.METHOD_VALIDATE_CONNECTION -> validateConnectedClient();
            case AgentProtocol.KV_METHOD_LIST_PREFIX -> listPrefix(params);
            case AgentProtocol.KV_METHOD_GET -> get(params);
            case AgentProtocol.KV_METHOD_PUT -> put(params);
            case AgentProtocol.KV_METHOD_DELETE -> delete(params);
            case AgentProtocol.KV_METHOD_RENAME -> rename(params);
            case AgentProtocol.KV_METHOD_HISTORY -> history(params);
            case AgentProtocol.KV_METHOD_STATUS -> status();
            case AgentProtocol.ETCD_METHOD_COMPACT -> compact(params);
            case AgentProtocol.ETCD_METHOD_DEFRAG -> defrag(params);
            case AgentProtocol.ETCD_METHOD_WATCH_START -> watchStart(params);
            case AgentProtocol.ETCD_METHOD_WATCH_POLL -> watchPoll(params);
            case AgentProtocol.ETCD_METHOD_WATCH_STOP -> watchStop(params);
            case AgentProtocol.ETCD_METHOD_LEASE_LIST -> leaseList(params);
            case AgentProtocol.ETCD_METHOD_LEASE_GET -> leaseGet(params);
            case AgentProtocol.ETCD_METHOD_LEASE_GRANT -> leaseGrant(params);
            case AgentProtocol.ETCD_METHOD_LEASE_KEEPALIVE -> leaseKeepAlive(params);
            case AgentProtocol.ETCD_METHOD_LEASE_REVOKE -> leaseRevoke(params);
            case AgentProtocol.ETCD_METHOD_AUTH_USER_LIST -> authUserList();
            case AgentProtocol.ETCD_METHOD_AUTH_USER_GET -> authUserGet(params);
            case AgentProtocol.ETCD_METHOD_AUTH_USER_ADD -> authUserAdd(params);
            case AgentProtocol.ETCD_METHOD_AUTH_USER_DELETE -> authUserDelete(params);
            case AgentProtocol.ETCD_METHOD_AUTH_USER_CHANGE_PASSWORD -> authUserChangePassword(params);
            case AgentProtocol.ETCD_METHOD_AUTH_USER_GRANT_ROLE -> authUserRole(params, true);
            case AgentProtocol.ETCD_METHOD_AUTH_USER_REVOKE_ROLE -> authUserRole(params, false);
            case AgentProtocol.ETCD_METHOD_AUTH_ROLE_LIST -> authRoleList();
            case AgentProtocol.ETCD_METHOD_AUTH_ROLE_GET -> authRoleGet(params);
            case AgentProtocol.ETCD_METHOD_AUTH_ROLE_ADD -> authRoleAdd(params);
            case AgentProtocol.ETCD_METHOD_AUTH_ROLE_DELETE -> authRoleDelete(params);
            case AgentProtocol.ETCD_METHOD_AUTH_ROLE_GRANT_PERMISSION -> authRolePermission(params, true);
            case AgentProtocol.ETCD_METHOD_AUTH_ROLE_REVOKE_PERMISSION -> authRolePermission(params, false);
            case AgentProtocol.METHOD_DISCONNECT -> {
                closeClient();
                yield Collections.singletonMap("ok", true);
            }
            case AgentProtocol.METHOD_SHUTDOWN -> {
                closeClient();
                System.exit(0);
                yield Collections.singletonMap("ok", true);
            }
            default -> throw new IllegalArgumentException("Unknown method: " + method);
        };
    }

    static String handleRequest(String line) {
        JsonObject req = JsonParser.parseString(line).getAsJsonObject();
        JsonElement id = req.get("id");
        String method = req.get("method").getAsString();
        JsonObject params = req.has("params") && req.get("params").isJsonObject()
            ? req.getAsJsonObject("params")
            : new JsonObject();

        JsonObject response = new JsonObject();
        response.addProperty("jsonrpc", "2.0");
        response.add("id", id);

        CURRENT_SESSION.set(LEGACY_SESSION);
        try {
            Object result = dispatch(method, params);
            response.add("result", GSON.toJsonTree(result));
        } catch (Exception e) {
            JsonObject error = new JsonObject();
            error.addProperty("code", -1);
            error.addProperty("message", e.getMessage() == null ? "Unknown error" : e.getMessage());
            response.add("error", error);
        } finally {
            CURRENT_SESSION.remove();
        }

        return GSON.toJson(response);
    }

    private static JsonObject connectionObject(JsonObject params) {
        JsonElement connection = params.get("connection");
        return connection != null && connection.isJsonObject() ? connection.getAsJsonObject() : params;
    }

    private static KV requireKv() {
        KV kv = sessionState().kv;
        if (kv == null) {
            throw new IllegalStateException("Not connected");
        }
        return kv;
    }

    private static EtcdSessionState sessionState() {
        EtcdSessionState state = CURRENT_SESSION.get();
        if (state == null) throw new IllegalStateException("No active etcd Agent session");
        return state;
    }

    private static Client requireClient() {
        Client client = sessionState().client;
        if (client == null) throw new IllegalStateException("Not connected");
        return client;
    }

    private static void closeClient() {
        EtcdSessionState state = sessionState();
        for (EtcdWatchState watch : state.watches.values()) watch.close();
        state.watches.clear();
        state.knownLeases.clear();
        if (state.kv != null) {
            state.kv.close();
            state.kv = null;
        }
        if (state.client != null) {
            state.client.close();
            state.client = null;
        }
        state.connectedEndpoints = Collections.emptyList();
    }

    private static ByteSequence byteSequence(String value) {
        return ByteSequence.from(value, java.nio.charset.StandardCharsets.UTF_8);
    }

    private static ByteSequence prefixEnd(ByteSequence prefix) {
        byte[] bytes = prefix.getBytes();
        if (bytes.length == 0) {
            return ByteSequence.from(new byte[] {0});
        }
        byte[] end = Arrays.copyOf(bytes, bytes.length);
        for (int i = end.length - 1; i >= 0; i--) {
            if ((end[i] & 0xff) < 0xff) {
                end[i]++;
                return ByteSequence.from(Arrays.copyOf(end, i + 1));
            }
        }
        return ByteSequence.from(new byte[] {0});
    }

    private static ByteSequence prefixStart(String prefix) {
        if (prefix.isEmpty()) {
            return ByteSequence.from(new byte[] {0});
        }
        return byteSequence(prefix);
    }

    private static String nextContinuation(KeyValue item) {
        byte[] key = item.getKey().getBytes();
        byte[] next = Arrays.copyOf(key, key.length + 1);
        next[next.length - 1] = 0;
        return Base64.getEncoder().encodeToString(next);
    }

    private static Map<String, Object> metadata(KeyValue item) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("createRevision", longString(item.getCreateRevision()));
        metadata.put("modRevision", longString(item.getModRevision()));
        metadata.put("version", longString(item.getVersion()));
        metadata.put("lease", longString(item.getLease()));
        metadata.put("valueSize", item.getValue().size());
        return metadata;
    }

    private static Map<String, Object> metadataWithTtl(KeyValue item) throws Exception {
        Map<String, Object> metadata = metadata(item);
        if (item.getLease() > 0) {
            LeaseTimeToLiveResponse lease = requireClient().getLeaseClient()
                .timeToLive(item.getLease(), LeaseOption.DEFAULT)
                .get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            metadata.put("ttl", lease.getTTL());
        }
        return metadata;
    }

    private static ByteSequence keyBytes(JsonObject params) {
        JsonElement encoded = params.get("keyBytes");
        if (encoded != null && encoded.isJsonObject()) {
            return ByteSequence.from(parseValue(encoded.getAsJsonObject()));
        }
        JsonElement key = params.get("key");
        if (key == null || key.isJsonNull()) {
            throw new IllegalArgumentException("Key is required");
        }
        return byteSequence(key.getAsString());
    }

    private static Map<String, Object> bytesObject(byte[] bytes) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("encoding", "base64");
        result.put("data", Base64.getEncoder().encodeToString(bytes));
        return result;
    }

    private static Map<String, Object> valueObject(byte[] bytes) {
        Map<String, Object> value = new LinkedHashMap<>();
        String utf8 = strictUtf8(bytes);
        if (utf8 != null) {
            value.put("encoding", "utf8");
            value.put("data", utf8);
        } else {
            value.put("encoding", "base64");
            value.put("data", Base64.getEncoder().encodeToString(bytes));
        }
        return value;
    }

    private static byte[] parseValue(JsonObject value) {
        String encoding = stringOrDefault(value, "encoding", "utf8");
        String data = stringOrDefault(value, "data", "");
        if ("base64".equals(encoding)) {
            return Base64.getDecoder().decode(data);
        }
        if (!"utf8".equals(encoding)) {
            throw new IllegalArgumentException("Unsupported value encoding: " + encoding);
        }
        return data.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    private static String displayBytes(byte[] bytes) {
        String utf8 = strictUtf8(bytes);
        return utf8 == null ? Base64.getEncoder().encodeToString(bytes) : utf8;
    }

    private static String strictUtf8(byte[] bytes) {
        CharsetDecoder decoder = java.nio.charset.StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            return decoder.decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    private static String stringOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? null : element.getAsString();
    }

    private static String stringOrEmpty(JsonObject object, String key) {
        return stringOrDefault(object, key, "");
    }

    private static String stringOrDefault(JsonObject object, String key, String fallback) {
        String value = stringOrNull(object, key);
        return value == null ? fallback : value;
    }

    private static int intOrDefault(JsonObject object, String key, int fallback) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? fallback : element.getAsInt();
    }

    private static int intUrlParamOrDefault(String params, String key, int fallback) {
        if (params == null || params.isBlank()) {
            return fallback;
        }
        for (String entry : params.replaceFirst("^\\?", "").split("&")) {
            int separator = entry.indexOf('=');
            String entryKey = separator < 0 ? entry : entry.substring(0, separator);
            if (!key.equals(entryKey)) {
                continue;
            }
            String value = separator < 0 ? "" : entry.substring(separator + 1);
            try {
                return Integer.parseInt(value);
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    private static boolean boolOrDefault(JsonObject object, String key, boolean fallback) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? fallback : element.getAsBoolean();
    }

    private static Long longOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? null : element.getAsLong();
    }

    private static String longString(long value) {
        return Long.toString(value);
    }

    private static String unsignedLongString(long value) {
        return Long.toUnsignedString(value);
    }

    private static Throwable rootCause(Throwable throwable) {
        Throwable current = throwable;
        while (current.getCause() != null && current.getCause() != current) {
            current = current.getCause();
        }
        return current;
    }

    private static String safeMessage(Throwable throwable) {
        String message = throwable == null ? null : throwable.getMessage();
        return message == null || message.isBlank() ? String.valueOf(throwable) : message;
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    public static void main(String[] args) throws Exception {
        MultiSessionJsonRpcServer.forSessionHandlers(EtcdSessionHandler::new).run();
    }

    private static final class HandshakeResult {
        private final int protocolVersion;
        private final int agentProtocolVersion;
        private final List<String> capabilities;

        private HandshakeResult(int protocolVersion, int agentProtocolVersion, List<String> capabilities) {
            this.protocolVersion = protocolVersion;
            this.agentProtocolVersion = agentProtocolVersion;
            this.capabilities = capabilities;
        }
    }

    static final class EtcdSessionState {
        private Client client;
        private KV kv;
        private List<String> connectedEndpoints = Collections.emptyList();
        private final Map<String, EtcdWatchState> watches = new ConcurrentHashMap<>();
        private final Set<Long> knownLeases = ConcurrentHashMap.newKeySet();
        private long watchBufferedBytes;

        private synchronized boolean reserveWatchBuffer(long bytes) {
            if (bytes < 0 || watchBufferedBytes + bytes > MAX_SESSION_WATCH_BUFFER_BYTES) return false;
            watchBufferedBytes += bytes;
            return true;
        }

        private synchronized void releaseWatchBuffer(long bytes) {
            watchBufferedBytes = Math.max(0, watchBufferedBytes - Math.max(0, bytes));
        }

        synchronized long watchBufferedBytes() {
            return watchBufferedBytes;
        }

        void addWatch(String watchId, EtcdWatchState watch) {
            watches.put(watchId, watch);
        }

        int watchCount() {
            return watches.size();
        }
    }

    private static final class EtcdSessionHandler implements SessionRpcHandler {
        private final EtcdSessionState state = new EtcdSessionState();

        @Override
        public Object handshake() {
            return handshakeResult();
        }

        @Override
        public Object connect(JsonObject params) throws Exception {
            return withSession(() -> EtcdAgent.connect(params));
        }

        @Override
        public Object handle(String method, JsonObject params) throws Exception {
            return withSession(() -> dispatch(method, params));
        }

        @Override
        public void close() {
            try {
                withSession(() -> {
                    closeClient();
                    return null;
                });
            } catch (Exception ignored) {
            }
        }

        private <T> T withSession(Callable<T> task) throws Exception {
            CURRENT_SESSION.set(state);
            try {
                return task.call();
            } finally {
                CURRENT_SESSION.remove();
            }
        }
    }
}
