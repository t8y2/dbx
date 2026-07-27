package com.dbx.agent.etcd;

import com.google.protobuf.ByteString;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.etcd.jetcd.ByteSequence;
import io.etcd.jetcd.KV;
import io.etcd.jetcd.Lease;
import io.etcd.jetcd.Txn;
import io.etcd.jetcd.api.KeyValue;
import io.etcd.jetcd.api.RangeResponse;
import io.etcd.jetcd.api.ResponseHeader;
import io.etcd.jetcd.kv.GetResponse;
import io.etcd.jetcd.kv.TxnResponse;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

final class EtcdAgentTest {
    @Test
    void handshakeAdvertisesKvCapability() {
        String response = EtcdAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"handshake\",\"params\":{}}"
        );

        JsonObject result = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("result");

        Assertions.assertEquals(1, result.get("protocolVersion").getAsInt());
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"kv\"")));
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"kv_ttl\"")));
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"kv_cas\"")));
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"kv_list_values\"")));
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"kv_status\"")));
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"kv_history\"")));
        Assertions.assertTrue(result.getAsJsonArray("capabilities").contains(JsonParser.parseString("\"connect\"")));
    }

    @Test
    void endpointsUseConfiguredListAndScheme() {
        JsonObject connection = JsonParser.parseString(
            "{\"endpoints\":\"etcd-1:2379,https://etcd-2:2379\",\"ssl\":true}"
        ).getAsJsonObject();

        Assertions.assertEquals(
            List.of("https://etcd-1:2379", "https://etcd-2:2379"),
            EtcdAgent.endpoints(connection)
        );
    }

    @Test
    void endpointsFallbackToHostPort() {
        JsonObject connection = JsonParser.parseString(
            "{\"host\":\"127.0.0.1\",\"port\":2379}"
        ).getAsJsonObject();

        Assertions.assertEquals(List.of("http://127.0.0.1:2379"), EtcdAgent.endpoints(connection));
    }

    @Test
    void kvMethodDispatchReturnsJsonRpcErrorWhenDisconnected() {
        String response = EtcdAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"kv_get\",\"params\":{\"key\":\"/app/name\"}}"
        );

        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");

        Assertions.assertEquals(-1, error.get("code").getAsInt());
        Assertions.assertEquals("Not connected", error.get("message").getAsString());
    }

    @Test
    void historyMethodIsRegistered() {
        String response = EtcdAgent.handleRequest(
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"kv_history\",\"params\":{\"key\":\"/app/name\",\"limit\":100}}"
        );

        JsonObject error = JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error");

        Assertions.assertEquals(-1, error.get("code").getAsInt());
        Assertions.assertEquals("Not connected", error.get("message").getAsString());
    }

    @Test
    void historyDefaultsToABoundedRevisionWindow() {
        Assertions.assertEquals(1L, EtcdAgent.historyStartRevision(null, 100L));
        Assertions.assertEquals(10_001L, EtcdAgent.historyStartRevision(null, 20_000L));
        Assertions.assertEquals(42L, EtcdAgent.historyStartRevision(42L, 20_000L));
    }

    @Test
    void historyRetainsOnlyTheNewestRequestedEvents() {
        Deque<Integer> events = new ArrayDeque<>();
        AtomicBoolean truncated = new AtomicBoolean();

        for (int value = 1; value <= 5; value++) {
            EtcdAgent.appendBoundedHistory(events, value, 3, truncated);
        }

        Assertions.assertEquals(List.of(3, 4, 5), List.copyOf(events));
        Assertions.assertTrue(truncated.get());
    }

    @Test
    void preserveLeaseRetriesWithTheLatestLeaseAfterConcurrentChange() throws Exception {
        AtomicInteger getCalls = new AtomicInteger();
        AtomicInteger txnCalls = new AtomicInteger();
        KV active = scriptedKv(
            getCalls,
            txnCalls,
            List.of(getResponse("/app/name", 10, 101), getResponse("/app/name", 11, 202)),
            List.of(txnResponse(false, 10), txnResponse(true, 12))
        );

        long revision = EtcdAgent.putPreservingLease(active, bytes("/app/name"), bytes("updated"));

        Assertions.assertEquals(12, revision);
        Assertions.assertEquals(2, getCalls.get());
        Assertions.assertEquals(2, txnCalls.get());
    }

    @Test
    void preserveLeaseRejectsMissingOrUnleasedKeys() {
        KV missing = scriptedKv(
            new AtomicInteger(),
            new AtomicInteger(),
            List.of(emptyGetResponse()),
            List.of()
        );
        KV unleased = scriptedKv(
            new AtomicInteger(),
            new AtomicInteger(),
            List.of(getResponse("/app/name", 10, 0)),
            List.of()
        );

        IllegalStateException missingError = Assertions.assertThrows(
            IllegalStateException.class,
            () -> EtcdAgent.putPreservingLease(missing, bytes("/app/name"), bytes("updated"))
        );
        IllegalStateException unleasedError = Assertions.assertThrows(
            IllegalStateException.class,
            () -> EtcdAgent.putPreservingLease(unleased, bytes("/app/name"), bytes("updated"))
        );

        Assertions.assertEquals("Cannot preserve lease: key does not exist or has no lease", missingError.getMessage());
        Assertions.assertEquals("Cannot preserve lease: key does not exist or has no lease", unleasedError.getMessage());
    }

    @Test
    void preserveLeaseFailsClearlyAfterBoundedConcurrentChanges() {
        AtomicInteger getCalls = new AtomicInteger();
        AtomicInteger txnCalls = new AtomicInteger();
        KV active = scriptedKv(
            getCalls,
            txnCalls,
            List.of(
                getResponse("/app/name", 10, 101),
                getResponse("/app/name", 11, 202),
                getResponse("/app/name", 12, 303)
            ),
            List.of(txnResponse(false, 10), txnResponse(false, 11), txnResponse(false, 12))
        );

        IllegalStateException error = Assertions.assertThrows(
            IllegalStateException.class,
            () -> EtcdAgent.putPreservingLease(active, bytes("/app/name"), bytes("updated"))
        );

        Assertions.assertEquals("Cannot preserve lease: key changed concurrently; retry the save", error.getMessage());
        Assertions.assertEquals(3, getCalls.get());
        Assertions.assertEquals(3, txnCalls.get());
    }

    @Test
    void grantedLeaseIsRevokedWhenWriteFailsAfterCreation() {
        AtomicInteger revokeCalls = new AtomicInteger();
        AtomicInteger revokedLeaseId = new AtomicInteger();
        Lease lease = (Lease) Proxy.newProxyInstance(
            Lease.class.getClassLoader(),
            new Class<?>[] { Lease.class },
            (proxy, method, args) -> {
                if (method.getName().equals("revoke")) {
                    revokeCalls.incrementAndGet();
                    revokedLeaseId.set(Math.toIntExact((long) args[0]));
                    return CompletableFuture.completedFuture(null);
                }
                if (method.getName().equals("close")) return null;
                throw new UnsupportedOperationException(method.getName());
            }
        );

        TimeoutException error = Assertions.assertThrows(
            TimeoutException.class,
            () -> EtcdAgent.cleanUpGrantedLeaseOnFailure(123, lease, () -> {
                throw new TimeoutException("write timed out");
            })
        );

        Assertions.assertEquals("write timed out", error.getMessage());
        Assertions.assertEquals(1, revokeCalls.get());
        Assertions.assertEquals(123, revokedLeaseId.get());
    }

    private static KV scriptedKv(
        AtomicInteger getCalls,
        AtomicInteger txnCalls,
        List<GetResponse> getResponses,
        List<TxnResponse> txnResponses
    ) {
        Deque<GetResponse> gets = new ArrayDeque<>(getResponses);
        Deque<TxnResponse> txns = new ArrayDeque<>(txnResponses);
        return (KV) Proxy.newProxyInstance(
            KV.class.getClassLoader(),
            new Class<?>[] { KV.class },
            (proxy, method, args) -> {
                if (method.getName().equals("get")) {
                    getCalls.incrementAndGet();
                    return CompletableFuture.completedFuture(gets.removeFirst());
                }
                if (method.getName().equals("txn")) {
                    return scriptedTxn(txnCalls, txns);
                }
                if (method.getName().equals("close")) {
                    return null;
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
    }

    private static Txn scriptedTxn(AtomicInteger txnCalls, Deque<TxnResponse> responses) {
        return (Txn) Proxy.newProxyInstance(
            Txn.class.getClassLoader(),
            new Class<?>[] { Txn.class },
            (proxy, method, args) -> {
                if (Arrays.asList("If", "Then", "Else").contains(method.getName())) {
                    return proxy;
                }
                if (method.getName().equals("commit")) {
                    txnCalls.incrementAndGet();
                    return CompletableFuture.completedFuture(responses.removeFirst());
                }
                throw new UnsupportedOperationException(method.getName());
            }
        );
    }

    private static ByteSequence bytes(String value) {
        return ByteSequence.from(value, StandardCharsets.UTF_8);
    }

    private static GetResponse getResponse(String key, long modRevision, long lease) {
        KeyValue keyValue = KeyValue.newBuilder()
            .setKey(ByteString.copyFromUtf8(key))
            .setModRevision(modRevision)
            .setLease(lease)
            .build();
        RangeResponse response = RangeResponse.newBuilder()
            .setHeader(header(modRevision))
            .addKvs(keyValue)
            .build();
        return new GetResponse(response, ByteSequence.EMPTY);
    }

    private static GetResponse emptyGetResponse() {
        return new GetResponse(
            RangeResponse.newBuilder().setHeader(header(1)).build(),
            ByteSequence.EMPTY
        );
    }

    private static TxnResponse txnResponse(boolean succeeded, long revision) {
        io.etcd.jetcd.api.TxnResponse response = io.etcd.jetcd.api.TxnResponse.newBuilder()
            .setHeader(header(revision))
            .setSucceeded(succeeded)
            .build();
        return new TxnResponse(response, ByteSequence.EMPTY);
    }

    private static ResponseHeader header(long revision) {
        return ResponseHeader.newBuilder().setRevision(revision).build();
    }
}
