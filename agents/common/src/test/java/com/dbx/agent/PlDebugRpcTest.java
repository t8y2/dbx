package com.dbx.agent;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class PlDebugRpcTest {
    @Test void compilationReceiptsUseOriginalAgentSessionAndRemainQueryableDuringExecution() throws Exception {
        var entered = new CountDownLatch(1);
        var stopped = new CountDownLatch(1);
        var compilations = new AtomicInteger();
        var statuses = new AtomicInteger();
        var worker = Executors.newSingleThreadExecutor();
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(() -> new DebugAgent(
            "jdbc:h2:mem:pl_debug_compile_rpc", new CountDownLatch(0), new CountDownLatch(0), new AtomicInteger()) {
            @Override public Map<String, Object> plDebugCompile(String id, PlDebugStartRequest target, Map<String, Object> preview) {
                assertEquals("compile-original", id);
                assertEquals(" Owner. ", target.getSchema());
                assertEquals(" P.kg ", target.getPackageName());
                assertEquals("f.x", target.getObjectName());
                assertEquals("server preview SQL", preview.get("sql"));
                compilations.incrementAndGet(); entered.countDown();
                try { if (!stopped.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("fixture compile deadline"); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException(error); }
                return Map.of("operationId", id, "ddlState", "executed");
            }
            @Override public Map<String, Object> plDebugCompileStatus(String id) {
                assertEquals("compile-original", id); statuses.incrementAndGet();
                return Map.of("operationId", id, "ddlState", "unknown");
            }
        }).withNativePlDebug(true)) {
            assertTrue(request(server, "open_session", "{\"agentSessionId\":\"metadata\",\"username\":\"sa\",\"password\":\"\"}").has("result"));
            String params = "{\"agentSessionId\":\"metadata\",\"operationId\":\"compile-original\",\"target\":{\"schema\":\" Owner. \",\"packageName\":\" P.kg \",\"objectName\":\"f.x\",\"objectType\":\"FUNCTION\"},\"preview\":{\"sql\":\"server preview SQL\"}}";
            for (String invalid : List.of(params.replace("\"compile-original\"", "3"), params.replace("\"f.x\"", "false"), params.replace("{\"sql\":\"server preview SQL\"}", "null"))) {
                assertTrue(request(server, "pl_debug_compile", invalid).has("error"));
            }
            assertEquals(0, compilations.get());
            Future<JsonObject> pending = worker.submit(() -> request(server, "pl_debug_compile", params));
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            assertTrue(clientSafeRequest(server, "pl_debug_compile_status", params).has("result"));
            assertFalse(pending.isDone());
            assertTrue(request(server, "pl_debug_compile_status", params.replace("\"metadata\"", "\"foreign\"")).has("error"));
            assertEquals(1, statuses.get());
            stopped.countDown();
            assertEquals("executed", pending.get(2, TimeUnit.SECONDS).getAsJsonObject("result").get("ddlState").getAsString());
            assertEquals(1, compilations.get());
            assertFalse(AgentProtocol.COMMON_METHODS.contains("pl_debug_compile"));
        } finally { stopped.countDown(); worker.shutdownNow(); }
    }

    @Test
    void typedWireBudgetCountsOriginalEscapesAndKeepsLegacyStartUsable() {
        var starts = new AtomicInteger();
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(() -> new DebugAgent(
            "jdbc:h2:mem:pl_debug_wire", new CountDownLatch(0), new CountDownLatch(0), new AtomicInteger()) {
            @Override public Map<String,Object> plDebugStart(PlDebugStartRequest target) {
                starts.incrementAndGet(); return Map.of("ok",true);
            }
        }).withNativePlDebug(true)) {
            assertTrue(request(server,"open_session","{\"agentSessionId\":\"debug\",\"username\":\"sa\",\"password\":\"\"}").has("result"));
            String values = "\\u0000".repeat(JsonRpcServer.MAX_TYPED_DEBUG_WIRE_BYTES / 6);
            String params = "{\"agentSessionId\":\"debug\",\"targetSignature\":{\"signatureVersion\":2},\"params\":[{\"name\":\"X\",\"value\":\""+values+"\"}]}";
            var rejected = request(server,"pl_debug_start",params);
            assertEquals("not_started",rejected.getAsJsonObject("error").getAsJsonObject("data").get("operationOutcome").getAsString());
            assertEquals(0,starts.get());
            assertTrue(request(server,"pl_debug_start",params.replace("\"targetSignature\":{\"signatureVersion\":2},","")).has("result"));
            assertEquals(1,starts.get());
            assertTrue(request(server,"pl_debug_start","{\"agentSessionId\":\"debug\",\"targetSignature\":{\"signatureVersion\":2}}").has("result"));
            assertEquals(2,starts.get());
        }
    }

    @Test
    void typedWireBudgetUsesUtf8BytesAndAllowsItsExactBoundary() {
        var request = JsonParser.parseString("{\"method\":\"pl_debug_start\",\"params\":{\"targetSignature\":{\"signatureVersion\":2}}}").getAsJsonObject();
        int limit = JsonRpcServer.MAX_TYPED_DEBUG_WIRE_BYTES;
        assertDoesNotThrow(()->JsonRpcServer.validateTypedDebugWire("a".repeat(limit),request));
        assertThrows(AgentRpcError.class,()->JsonRpcServer.validateTypedDebugWire("中".repeat(limit / 3 + 1),request));
        assertDoesNotThrow(()->JsonRpcServer.validateTypedDebugWire("😀".repeat(limit / 4),request));
    }

    @Test
    void resultPagesUseTheOriginalSessionAndRejectCoercedBoundsBeforeDispatch() {
        var reads = new AtomicInteger();
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(() -> new DebugAgent(
            "jdbc:h2:mem:pl_debug_result_rpc", new CountDownLatch(0), new CountDownLatch(0), new AtomicInteger()) {
            @Override public Map<String,Object> plDebugGetResults(String id) {
                assertEquals("native-id",id); return Map.of("results",List.of());
            }
            @Override public Map<String,Object> plDebugGetResultPage(String id,String generation,String resultId,int offset,int limit) {
                assertEquals("native-id",id); assertEquals("g",generation); assertEquals("r",resultId);
                assertEquals(0,offset); assertEquals(32000,limit); reads.incrementAndGet(); return Map.of("data","cached");
            }
        }).withNativePlDebug(true)) {
            assertTrue(request(server,"open_session","{\"agentSessionId\":\"debug\",\"username\":\"sa\",\"password\":\"\"}").has("result"));
            String params="{\"agentSessionId\":\"debug\",\"debugId\":\"native-id\",\"generation\":\"g\",\"resultId\":\"r\",\"offset\":0,\"limit\":32000}";
            for(String invalid:List.of(params.replace("\"offset\":0","\"offset\":0.5"),params.replace("\"limit\":32000","\"limit\":\"3\""),params.replace("\"limit\":32000","\"limit\":65537"),params.replace("\"generation\":\"g\"","\"generation\":3"),params.replace("\"offset\":0","\"offset\":2147483648"))) {
                var response=request(server,"pl_debug_get_result_page",invalid);
                assertEquals("not_started",response.getAsJsonObject("error").getAsJsonObject("data").get("operationOutcome").getAsString());
            }
            assertEquals(0,reads.get());
            assertTrue(request(server,"pl_debug_get_results",params).has("result"));
            assertTrue(request(server,"pl_debug_get_result_page",params).has("result"));
            assertTrue(request(server,"pl_debug_get_result_page",params.replace("\"agentSessionId\":\"debug\"","\"agentSessionId\":\"foreign\"")).has("error"));
            assertEquals(1,reads.get());
        }
    }

    @Test
    void breakpointRuntimeRejectsCoercedNumbersBeforeDispatchAndPreservesExactRules() {
        AtomicInteger mutations = new AtomicInteger();
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(() -> new DebugAgent(
            "jdbc:h2:mem:pl_debug_breakpoint_rpc", new CountDownLatch(0), new CountDownLatch(0), new AtomicInteger()) {
            @Override public Map<String, Object> plDebugMutateBreakpoint(String id, String action, PlDebugBreakpointMutation input) {
                assertEquals("native-id", id);
                assertEquals("set_breakpoints", action);
                assertEquals(7L, input.stopRevision());
                assertEquals(2, input.line());
                assertEquals(9007199254740993L, input.rules().get("ignoreCount"));
                assertNull(input.enabled());
                mutations.incrementAndGet();
                return Map.of("ok", true, "result", 0);
            }
        }).withNativePlDebug(true)) {
            assertTrue(request(server, "open_session", "{\"agentSessionId\":\"debug\",\"username\":\"sa\",\"password\":\"\"}").has("result"));
            String params = "{\"agentSessionId\":\"debug\",\"debugId\":\"native-id\",\"operationId\":\"breakpoint\",\"stopRevision\":7,\"line\":2,\"rules\":{\"ignoreCount\":9007199254740993}}";
            for (String invalid : List.of(
                params.replace("\"line\":2", "\"line\":2.5"),
                params.replace("\"line\":2", "\"line\":2147483648"),
                params.replace("\"line\":2", "\"line\":\"2\""),
                params.replace("\"stopRevision\":7", "\"stopRevision\":9223372036854775808"),
                params.replace("9007199254740993", "1.5"),
                params.replace("9007199254740993", "null"),
                params.replace("9007199254740993", "\"3\""),
                params.replace("\"line\":2", "\"enabled\":\"true\",\"line\":2"))) {
                JsonObject response = request(server, "pl_debug_set_breakpoints", invalid);
                JsonObject error = response.getAsJsonObject("error").getAsJsonObject("data");
                assertEquals("request", error.get("stage").getAsString(), response.toString());
                assertEquals("not_started", error.get("operationOutcome").getAsString(), response.toString());
            }
            assertEquals(0, mutations.get());
            assertTrue(request(server, "pl_debug_set_breakpoints", params).has("result"));
            assertTrue(request(server, "pl_debug_set_breakpoints", params.replace("\"line\":2", "\"enabled\":null,\"sourceRevision\":null,\"line\":2")).has("result"));
            assertEquals(2, mutations.get());
        }
    }

    @Test
    void inspectionUsesOrdinaryMetadataSessionAndPreservesExactTarget() {
        AtomicInteger inspections = new AtomicInteger();
        AtomicInteger starts = new AtomicInteger();
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(() -> new DebugAgent(
            "jdbc:h2:mem:pl_debug_inspect", new CountDownLatch(0), new CountDownLatch(0), new AtomicInteger()) {
            @Override public Map<String, Object> plDebugInspect(PlDebugStartRequest target) {
                assertNotNull(requireConnected());
                inspections.incrementAndGet();
                if (target != null) {
                    assertEquals(" Mixed Owner ", target.getSchema());
                    assertEquals(" P.kg ", target.getPackageName());
                    assertEquals("f.x", target.getObjectName());
                }
                return Map.of("capabilities", Map.of("startVerified", false));
            }
            @Override public Map<String, Object> plDebugStart(PlDebugStartRequest target) {
                starts.incrementAndGet();
                return Map.of();
            }
        })) {
            assertTrue(request(server, "open_session", "{\"agentSessionId\":\"metadata\",\"username\":\"sa\",\"password\":\"\"}").has("result"));
            for (String target : List.of("null", "{\"schema\":\" Mixed Owner \",\"packageName\":\" P.kg \",\"objectName\":\"f.x\",\"objectType\":\"FUNCTION\"}")) {
                JsonObject result = request(server, "pl_debug_inspect", "{\"agentSessionId\":\"metadata\",\"target\":" + target + "}");
                assertTrue(result.has("result"), result.toString());
                assertFalse(result.getAsJsonObject("result").getAsJsonObject("capabilities").get("startVerified").getAsBoolean());
            }
            assertEquals(2, inspections.get());
            assertEquals(0, starts.get());
            assertFalse(AgentProtocol.PL_DEBUG_SESSION_METHODS.contains("pl_debug_inspect"));
            assertFalse(AgentProtocol.COMMON_METHODS.contains("pl_debug_inspect"));
        }
    }

    @Test
    void assignmentRuntimeForwardsFrozenIdentityAndReportsPreDispatchRejection() {
        AtomicInteger assignments = new AtomicInteger();
        java.util.function.Supplier<DebugAgent> factory = () -> new DebugAgent(
            "jdbc:h2:mem:pl_debug_assignment_rpc", new CountDownLatch(0), new CountDownLatch(0), new AtomicInteger()) {
            @Override public Map<String, Object> plDebugSetValue(String id, String operationId, Long revision,
                                                                String name, int frame, int index, String value) {
                assertNull(getConnection());
                assertEquals("native-id", id);
                assertEquals("assignment", operationId);
                assertEquals(7L, revision);
                assertEquals("N", name);
                assertEquals(1, frame);
                assertEquals(0, index);
                if ("unsupported".equals(value)) throw AgentRpcError.requestRejected("SET_VALUE is not declared");
                assignments.incrementAndGet();
                return Map.of("ok", false, "result", 77);
            }
            @Override public Map<String, Object> plDebugOperationStatus(String id, String operationId) {
                assertEquals("native-id", id);
                assertEquals("assignment", operationId);
                return Map.of("state", "failed");
            }
        };
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(factory).withNativePlDebug(true)) {
            assertTrue(request(server, "open_session", "{\"agentSessionId\":\"debug\",\"username\":\"sa\",\"password\":\"\"}").has("result"));
            assertTrue(request(server, "handshake", "{}").getAsJsonObject("result").getAsJsonObject("plDebug").get("setValueOperationStatus").getAsBoolean());
            assertFalse(request(server, "handshake", "{}").getAsJsonObject("result").getAsJsonObject("plDebug").get("breakpointOperationStatus").getAsBoolean());
            server.withBreakpointOperationStatus();
            assertTrue(request(server, "handshake", "{}").getAsJsonObject("result").getAsJsonObject("plDebug").get("breakpointOperationStatus").getAsBoolean());
            assertFalse(request(server, "handshake", "{}").getAsJsonObject("result").getAsJsonArray("capabilities").contains(new com.google.gson.JsonPrimitive("pl_debug_retained_results_v1")));
            server.withRetainedPlDebugResults();
            assertTrue(request(server, "handshake", "{}").getAsJsonObject("result").getAsJsonArray("capabilities").contains(new com.google.gson.JsonPrimitive("pl_debug_retained_results_v1")));
            JsonObject nativeHandshake = request(server, "handshake", "{}").getAsJsonObject("result");
            server.withExactMetadataIdentity();
            JsonObject combinedHandshake = request(server, "handshake", "{}").getAsJsonObject("result");
            assertEquals(nativeHandshake.getAsJsonObject("plDebug"), combinedHandshake.getAsJsonObject("plDebug"));
            assertTrue(combinedHandshake.getAsJsonArray("capabilities").contains(new com.google.gson.JsonPrimitive(AgentProtocol.CAPABILITY_EXACT_METADATA_IDENTITY_V1)));
            for (com.google.gson.JsonElement capability : nativeHandshake.getAsJsonArray("capabilities")) {
                assertTrue(combinedHandshake.getAsJsonArray("capabilities").contains(capability));
            }
            String params = "{\"agentSessionId\":\"debug\",\"debugId\":\"native-id\",\"operationId\":\"assignment\",\"stopRevision\":7,\"name\":\"N\",\"frame\":1,\"value\":\"9\"}";
            assertFalse(request(server, "pl_debug_set_value", params).getAsJsonObject("result").get("ok").getAsBoolean());
            for (String invalid : List.of(params.replace("\"frame\":1", "\"frame\":1.5"), params.replace("\"9\"", "\"unsupported\""))) {
                JsonObject error = request(server, "pl_debug_set_value", invalid).getAsJsonObject("error").getAsJsonObject("data");
                assertEquals("request", error.get("stage").getAsString());
                assertEquals("not_started", error.get("operationOutcome").getAsString());
            }
            assertEquals(1, assignments.get());
            assertEquals("failed", request(server, "pl_debug_operation_status", params).getAsJsonObject("result").get("state").getAsString());
        }
    }

    @Test
    void statusAndAbortBypassTheBusyDispatcherWithoutBorrowingAQueryConnection() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch stopped = new CountDownLatch(1);
        AtomicInteger opens = new AtomicInteger();
        String url = "jdbc:h2:mem:pl_debug_rpc_" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1";
        try (MultiSessionJsonRpcServer server = new MultiSessionJsonRpcServer(() ->
                 new DebugAgent(url, entered, stopped, opens));
             ExecutorService client = Executors.newSingleThreadExecutor()) {
            try {
                assertTrue(request(server, "open_session", "{\"agentSessionId\":\"debug\",\"username\":\"sa\",\"password\":\"\"}").has("result"));
                assertTrue(request(server, "open_session", "{\"agentSessionId\":\"query\",\"username\":\"sa\",\"password\":\"\"}").has("result"));
                int opened = opens.get();
                Future<JsonObject> pending = client.submit(() -> request(server, "pl_debug_resume", context("debug")));
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                JsonObject status = clientSafeRequest(server, "pl_debug_status", context("debug"));
                assertEquals("running", status.getAsJsonObject("result").get("state").getAsString());
                assertEquals(opened, opens.get(), "cached status must not acquire another physical query connection");
                JsonObject busy = clientSafeRequest(server, "pl_debug_step_over", context("debug"));
                assertTrue(busy.has("error"));
                assertTrue(busy.getAsJsonObject("error").get("message").getAsString().contains("already running"),
                    "the debugger must reject concurrent controls, not queue them behind CONTINUE");
                JsonObject query = request(server, "execute_query", "{\"agentSessionId\":\"query\",\"sql\":\"SELECT 1\"}");
                assertTrue(query.has("result"), query.toString());
                JsonObject abort = clientSafeRequest(server, "pl_debug_abort", context("debug"));
                assertTrue(abort.getAsJsonObject("result").get("ok").getAsBoolean());
                assertTrue(pending.get(2, TimeUnit.SECONDS).has("result"));
            } finally {
                stopped.countDown();
            }
        }
    }

    @Test
    void validatesNativeSessionIdentityBeforeDispatchingAndKeepsOrdinaryHandshakeUnchanged() throws Exception {
        AtomicInteger reads = new AtomicInteger();
        DebugAgent agent = new DebugAgent("jdbc:h2:mem:pl_debug_identity", new CountDownLatch(0), new CountDownLatch(0), new AtomicInteger()) {
            @Override public Map<String, Object> plDebugStatus(String id) { reads.incrementAndGet(); return Map.of("state", "paused"); }
        };
        JsonRpcServer server = new JsonRpcServer(agent);
        JsonObject invalid = JsonParser.parseString(server.handleRequest("{\"id\":1,\"method\":\"pl_debug_status\",\"params\":{}}" )).getAsJsonObject();
        assertTrue(invalid.has("error"));
        assertEquals(0, reads.get());
        assertFalse(AgentProtocol.COMMON_METHODS.contains("pl_debug_status"));
        assertFalse(AgentProtocol.COMMON_METHODS.contains("pl_debug_start"));
    }

    @Test
    void namedTargetPreviewAndStartRetainSignatureAndExplicitInputState() {
        AtomicInteger previews = new AtomicInteger();
        AtomicInteger starts = new AtomicInteger();
        DebugAgent agent = new DebugAgent("jdbc:h2:mem:pl_debug_target_preview", new CountDownLatch(0), new CountDownLatch(0), new AtomicInteger()) {
            @Override public Map<String, Object> plDebugResolveTarget(PlDebugStartRequest request) {
                previews.incrementAndGet();
                assertEquals(" P.kg ", request.getPackageName());
                return Map.of("candidates", List.of(Map.of("signature", Map.of("objectId", "123", "subprogramId", 2))));
            }
            @Override public Map<String, Object> plDebugStart(PlDebugStartRequest request) {
                starts.incrementAndGet();
                assertEquals("123", request.getTargetSignature().get("objectId"));
                assertEquals("default", request.getParams().getFirst().getInputState());
                assertNull(request.getParams().getFirst().getValue());
                return Map.of("state", "paused");
            }
        };
        JsonRpcServer server = new JsonRpcServer(agent);
        JsonObject preview = JsonParser.parseString(server.handleRequest("{\"id\":1,\"method\":\"pl_debug_resolve_target\",\"params\":{\"packageName\":\" P.kg \"}}")).getAsJsonObject();
        assertTrue(preview.has("result"), preview.toString());
        assertEquals(1, previews.get());
        JsonObject start = JsonParser.parseString(server.handleRequest("{\"id\":2,\"method\":\"pl_debug_start\",\"params\":{\"operationId\":\"start-with-signature\",\"targetSignature\":{\"objectId\":\"123\",\"subprogramId\":2},\"params\":[{\"name\":\"A\",\"mode\":\"IN\",\"type\":\"NUMBER\",\"inputState\":\"default\"}]}}")).getAsJsonObject();
        assertTrue(start.has("result"), start.toString());
        assertEquals(1, starts.get());
        assertFalse(AgentProtocol.PL_DEBUG_SESSION_METHODS.contains("pl_debug_resolve_target"), "read-only preview uses the ordinary metadata boundary");
    }

    @Test
    void nativeDebugContractRequiresExplicitServerOptInAndRetainsExistingCapabilities() {
        for (boolean blobBindings : List.of(false, true)) {
            java.util.function.Supplier<DebugAgent> factory = () -> new DebugAgent(
                "jdbc:h2:mem:pl_debug_handshake", new CountDownLatch(0), new CountDownLatch(0), new AtomicInteger());
            try (MultiSessionJsonRpcServer ordinary = blobBindings
                     ? MultiSessionJsonRpcServer.withBlobBindings(factory) : new MultiSessionJsonRpcServer(factory);
                 MultiSessionJsonRpcServer nativeServer = (blobBindings
                     ? MultiSessionJsonRpcServer.withBlobBindings(factory) : new MultiSessionJsonRpcServer(factory))
                     .withNativePlDebug()) {
                JsonObject before = request(ordinary, "handshake", "{}").getAsJsonObject("result");
                JsonObject after = request(nativeServer, "handshake", "{}").getAsJsonObject("result");
                assertFalse(before.has("plDebug"), "ordinary and legacy drivers must not advertise the native contract");
                assertEquals(before.get("capabilities"), after.get("capabilities"));
                assertEquals(before.get("protocolVersion"), after.get("protocolVersion"));
                assertEquals(1, after.getAsJsonObject("plDebug").get("contractVersion").getAsInt());
                assertFalse(after.getAsJsonObject("plDebug").get("helperObjects").getAsBoolean());
                assertFalse(after.getAsJsonObject("plDebug").get("setValueOperationStatus").getAsBoolean());
                assertFalse(after.getAsJsonObject("plDebug").get("breakpointOperationStatus").getAsBoolean());
            }
        }
    }

    private static String context(String session) {
        return "{\"agentSessionId\":\"" + session + "\",\"debugId\":\"native-id\"}";
    }

    private static JsonObject clientSafeRequest(MultiSessionJsonRpcServer server, String method, String params) {
        return assertTimeoutPreemptively(java.time.Duration.ofSeconds(2), () -> request(server, method, params));
    }

    private static JsonObject request(MultiSessionJsonRpcServer server, String method, String params) {
        return JsonParser.parseString(server.handleRequest("{\"id\":1,\"method\":\"" + method + "\",\"params\":" + params + "}")).getAsJsonObject();
    }

    private static class DebugAgent extends ConfiguredJdbcAgent {
        private final CountDownLatch entered;
        private final CountDownLatch stopped;
        private final AtomicInteger opens;

        DebugAgent(String url, CountDownLatch entered, CountDownLatch stopped, AtomicInteger opens) {
            super(new JdbcAgentProfile("org.h2.Driver", url, 0, false, Set.of(), List.of("TABLE")));
            this.entered = entered;
            this.stopped = stopped;
            this.opens = opens;
        }

        @Override protected Connection openConnection(ConnectParams params) throws Exception {
            opens.incrementAndGet();
            return super.openConnection(params);
        }

        @Override public Map<String, Object> plDebugResume(String id) {
            assertNull(getConnection(), "the dedicated debug session must not borrow the ordinary pool");
            entered.countDown();
            try {
                if (!stopped.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("test continuation deadline");
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt(); throw new IllegalStateException(error);
            }
            return Map.of("state", "ended");
        }

        @Override public Map<String, Object> plDebugStatus(String id) {
            assertNull(getConnection());
            return Map.of("state", "running");
        }

        @Override public Map<String, Object> plDebugStepOver(String id) {
            if (entered.getCount() == 0 && stopped.getCount() != 0) {
                throw new IllegalStateException("A debug operation is already running");
            }
            throw new IllegalStateException("The step was incorrectly queued until after the target stopped");
        }

        @Override public Map<String, Object> plDebugAbort(String id) {
            assertNull(getConnection());
            stopped.countDown();
            return Map.of("ok", true);
        }
    }
}
