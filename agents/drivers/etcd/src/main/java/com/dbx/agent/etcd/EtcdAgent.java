package com.dbx.agent.etcd;

import com.dbx.agent.AgentProtocol;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.grpc.netty.GrpcSslContexts;
import io.etcd.jetcd.ByteSequence;
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
import io.netty.handler.ssl.SslContext;
import io.netty.handler.ssl.SslContextBuilder;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
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

public final class EtcdAgent {
    private static final Gson GSON = new Gson();
    private static final int DEFAULT_LIMIT = 100;
    private static final int RPC_TIMEOUT_SECONDS = 30;
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
        AgentProtocol.CAPABILITY_KV_HISTORY
    ));
    private static Client client;
    private static KV kv;
    private static List<String> connectedEndpoints = Collections.emptyList();

    private EtcdAgent() {
    }

    private static Object handshakeResult() {
        return new HandshakeResult(AgentProtocol.PROTOCOL_VERSION, AgentProtocol.PROTOCOL_VERSION, CAPABILITIES);
    }

    private static Object connect(JsonObject params) throws Exception {
        JsonObject connection = connectionObject(params);
        Client nextClient = buildClient(connection);
        nextClient.getKVClient().get(byteSequence("\0")).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        closeClient();
        client = nextClient;
        kv = client.getKVClient();
        connectedEndpoints = endpoints(connection);
        return Collections.singletonMap("ok", true);
    }

    static Client buildClient(JsonObject connection) throws Exception {
        List<String> endpoints = endpoints(connection);
        ClientBuilder builder = Client.builder().endpoints(endpoints.toArray(String[]::new));
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
        GetResponse latest = kv.get(key, latestOption.build()).get(RPC_TIMEOUT_SECONDS, TimeUnit.SECONDS);
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
        Watch watch = client.getWatchClient();
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
        Maintenance maintenance = client.getMaintenanceClient();
        Cluster cluster = client.getClusterClient();
        Map<Long, Member> membersById = new HashMap<>();
        List<String> endpoints = new ArrayList<>(connectedEndpoints);
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
        GetResponse countResponse = kv.get(ByteSequence.from(new byte[] {0}), countOption)
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

    private static Object dispatch(String method, JsonObject params) throws Exception {
        return switch (method) {
            case AgentProtocol.METHOD_HANDSHAKE -> handshakeResult();
            case AgentProtocol.METHOD_CONNECT, AgentProtocol.METHOD_TEST_CONNECTION -> connect(params);
            case AgentProtocol.KV_METHOD_LIST_PREFIX -> listPrefix(params);
            case AgentProtocol.KV_METHOD_GET -> get(params);
            case AgentProtocol.KV_METHOD_PUT -> put(params);
            case AgentProtocol.KV_METHOD_DELETE -> delete(params);
            case AgentProtocol.KV_METHOD_RENAME -> rename(params);
            case AgentProtocol.KV_METHOD_HISTORY -> history(params);
            case AgentProtocol.KV_METHOD_STATUS -> status();
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

        try {
            Object result = dispatch(method, params);
            response.add("result", GSON.toJsonTree(result));
        } catch (Exception e) {
            JsonObject error = new JsonObject();
            error.addProperty("code", -1);
            error.addProperty("message", e.getMessage() == null ? "Unknown error" : e.getMessage());
            response.add("error", error);
        }

        return GSON.toJson(response);
    }

    private static JsonObject connectionObject(JsonObject params) {
        JsonElement connection = params.get("connection");
        return connection != null && connection.isJsonObject() ? connection.getAsJsonObject() : params;
    }

    private static KV requireKv() {
        if (kv == null) {
            throw new IllegalStateException("Not connected");
        }
        return kv;
    }

    private static Client requireClient() {
        if (client == null) throw new IllegalStateException("Not connected");
        return client;
    }

    private static void closeClient() {
        if (kv != null) {
            kv.close();
            kv = null;
        }
        if (client != null) {
            client.close();
            client = null;
        }
        connectedEndpoints = Collections.emptyList();
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
        System.out.println("{\"ready\":true}");
        System.out.flush();

        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        while (true) {
            String line = reader.readLine();
            if (line == null) {
                break;
            }

            System.out.println(handleRequest(line));
            System.out.flush();
        }
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
}
