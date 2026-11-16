package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.PlDebugStartRequest;
import com.dbx.agent.JsonRpcServer;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.sql.SQLException;
import java.time.Duration;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class PlDebugManagerTest {
    @Test
    void freezesExplicitTypedNullsWithoutCollapsingThemIntoMissingFields() throws Exception {
        var frozen = new AtomicReference<PlDebugStartRequest>();
        var registrations = new AtomicInteger();
        var manager = new PlDebugManager((value,onRetire,onCompletion)->{
            registrations.incrementAndGet();frozen.set(value);throw new IllegalStateException("injected before connection");
        });
        var request = request("typed-null-freeze");
        var parameter = new com.dbx.agent.PlDebugParam("X","IN OUT","EXT",null);
        var payload = JsonParser.parseString("{\"kind\":\"collection\",\"value\":null}");
        parameter.setTypedValue(payload);request.setParams(java.util.List.of(parameter));
        assertThrows(IllegalStateException.class,()->manager.start(request));
        assertEquals(payload,frozen.get().getParams().getFirst().getTypedValue());
        payload.getAsJsonObject().remove("value");
        assertTrue(frozen.get().getParams().getFirst().getTypedValue().getAsJsonObject().get("value").isJsonNull());
        assertThrows(IllegalArgumentException.class,()->manager.start(request));
        assertEquals(1,registrations.get());
        manager.closeAll();
    }

    @Test
    void retainedResultReadsRemainAvailableAfterReleaseWithoutDatabaseWork() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            var agent=agent(jdbc,new AtomicInteger());
            agent.plDebugStart(request("retained-results"));
            assertEquals("pending",agent.plDebugGetResults("retained-results").get("collectionState"));
            agent.plDebugResume("retained-results");
            agent.plDebugClose("retained-results");
            int events=jdbc.events.size();
            assertEquals(java.util.List.of(),agent.plDebugGetResults("retained-results").get("results"));
            assertEquals("retained-results",agent.plDebugGetResults("retained-results").get("debugId"));
            assertThrows(IllegalArgumentException.class,()->agent.plDebugGetResultPage("retained-results","wrong","unknown",0,64));
            assertThrows(IllegalArgumentException.class,()->agent.plDebugGetResults("foreign"));
            assertEquals(events,jdbc.events.size());
        }
    }

    @Test
    void profiledOwnerIsSelectedOnceBeforeBothOpensAndSecondOpenFailureIsNotReplayed() throws Exception {
        var registrations = new AtomicInteger();
        var opens = new AtomicInteger();
        var closes = new AtomicInteger();
        var manager = new PlDebugManager((request, onRetire, onCompletion) -> {
            registrations.incrementAndGet();
            assertTrue(PlDebugTarget.requiresTypedLobConnection(request));
            return new com.dbx.agent.AbstractJdbcAgent.DedicatedConnectionOwner() {
                @Override public java.sql.Connection open() throws Exception {
                    if (opens.incrementAndGet() == 2) throw new SQLException("injected second open failure");
                    return PlDebugTestJdbc.proxy(java.sql.Connection.class, (method,args) -> {
                        if (method.getName().equals("close")) closes.incrementAndGet();
                        return PlDebugTestJdbc.empty(method.getReturnType());
                    });
                }
                @Override public boolean resourcesReleased() { return closes.get() == 1; }
                @Override public void close() { }
            };
        });
        var request = request("lob-second-open");
        request.setTargetSignature(Map.of("signatureVersion",2,"arguments",java.util.List.of(Map.of("type","CLOB","mode","OUT"))));
        assertThrows(SQLException.class, () -> manager.start(request));
        assertEquals("released",manager.status("lob-second-open").get("releaseState"));
        manager.start(request);
        assertEquals(1,registrations.get());
        assertEquals(2,opens.get());
        assertEquals(1,closes.get());
        manager.closeAll();
    }

    @Test
    void predispatchInventoryTimeoutHasAFailedReceiptButNeverRestoresSessionUsability() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            OceanBaseOracleAgent agent = agent(jdbc, new AtomicInteger());
            agent.plDebugStart(request("inventory-timeout"));
            assertEquals("agent", agent.plDebugStatus("inventory-timeout").get("breakpointRulesOwner"));
            jdbc.nativeBreakpoints.failReadAt = jdbc.nativeBreakpoints.reads + 1;
            jdbc.nativeBreakpoints.readFailure = new java.sql.SQLTimeoutException("injected inventory timeout");
            com.dbx.agent.PlDebugBreakpoint point = new com.dbx.agent.PlDebugBreakpoint();
            point.setKind("ANONYMOUS"); point.setLine(2);
            assertThrows(com.dbx.agent.AgentRpcError.class,
                () -> agent.plDebugSetBreakpoints("inventory-timeout", "no-dispatch", null, java.util.List.of(point)));
            var receipt = agent.plDebugOperationStatus("inventory-timeout", "no-dispatch");
            assertEquals("failed", receipt.get("state"));
            assertEquals("not_started", ((Map<?, ?>) receipt.get("error")).get("operationOutcome"));
            assertEquals("unknown", agent.plDebugStatus("inventory-timeout").get("state"));
            assertEquals("agent", agent.plDebugStatus("inventory-timeout").get("breakpointRulesOwner"));
            int controls = jdbc.flags.size();
            assertThrows(Exception.class, () -> agent.plDebugResume("inventory-timeout"));
            assertEquals(controls, jdbc.flags.size());
            assertEquals(0, jdbc.nativeBreakpoints.sets);
            agent.plDebugClose("inventory-timeout");
        }
    }

    @Test
    void versionConnectionLossDoesNotStartAProgramAndReleasesBothAllocatedConnections() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            jdbc.versionFailure = new SQLException("injected version connection loss", "08006");
            OceanBaseOracleAgent agent = agent(jdbc, new AtomicInteger());
            assertThrows(RuntimeException.class, () -> agent.plDebugStart(request("version-loss")));
            assertEquals(0, jdbc.targetExecutions.get());
            assertTrue(jdbc.events.contains("debuggee.close"));
            assertTrue(jdbc.events.contains("debugger.close"));
        }
    }

    @Test
    void exceptionFlagRpcRejectsBeforeControlAndKeepsTheOriginalSessionUsable() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            OceanBaseOracleAgent agent = agent(jdbc, new AtomicInteger());
            agent.plDebugStart(request("exception-capability"));
            JsonRpcServer rpc = new JsonRpcServer(agent);
            var dispatch = JsonRpcServer.class.getDeclaredMethod("handleRequest", String.class);
            dispatch.setAccessible(true);
            int before = jdbc.flags.size();
            assertThrows(com.dbx.agent.AgentRpcError.class, () -> agent.plDebugSetExceptionBreakpoint("exception-capability", true));
            String enable = new Gson().toJson(Map.of("id", 1, "method", "pl_debug_set_exception_breakpoint", "params",
                Map.of("debugId", "exception-capability", "enabled", true)));
            JsonObject rejected = JsonParser.parseString((String) dispatch.invoke(rpc, enable)).getAsJsonObject();
            assertTrue(rejected.getAsJsonObject("error").get("message").getAsString().contains("4.2.5.7"));
            assertEquals(before, jdbc.flags.size());
            assertEquals(false, agent.plDebugStatus("exception-capability").get("exceptionBreakpoint"));
            agent.plDebugSetExceptionBreakpoint("exception-capability", false);
            assertEquals(before, jdbc.flags.size());
            agent.plDebugResume("exception-capability");
            agent.plDebugClose("exception-capability");
            assertEquals("released", agent.plDebugStatus("exception-capability").get("releaseState"));
        }
    }

    @Test
    void packageSourceRpcSeparatesContainerIdentityAndRecoversOriginalReceipts() throws Exception {
        for (String program : java.util.List.of("P_TEST.RUN", "P_TEST.__init__")) {
            try (PlDebugNamedLifecycleTest.Fixture jdbc = new PlDebugNamedLifecycleTest.Fixture()) {
                jdbc.enteredProgram = program;
                jdbc.metadata.bodyText = "PACKAGE BODY P_TEST IS\nBEGIN\n NULL;\nEND;\n";
                AtomicInteger opens = new AtomicInteger();
                OceanBaseOracleAgent agent = new OceanBaseOracleAgent(() -> jdbc.connection(opens.getAndIncrement() % 2 == 0));
                var request = jdbc.request();
                request.setOperationId("package-source");
                var started = agent.plDebugStart(request);
                var frame = (Map<?, ?>) ((java.util.List<?>) agent.plDebugGetStack("package-source").get("frames")).getFirst();
                var source = (PlDebugSource.Reference) frame.get("sourceRef");
                JsonRpcServer rpc = new JsonRpcServer(agent);
                var dispatch = JsonRpcServer.class.getDeclaredMethod("handleRequest", String.class);
                dispatch.setAccessible(true);
                Map<String, Object> params = new java.util.LinkedHashMap<>(Map.of("debugId", "package-source", "operationId", "member-set",
                    "stopRevision", started.get("stopRevision"), "sourceRefId", source.id(), "sourceRevision", 1,
                    "nativeFrameId", source.nativeFrameId(), "line", 3));
                String call = new Gson().toJson(Map.of("id", 1, "method", "pl_debug_set_breakpoints", "params", params));
                JsonObject created = JsonParser.parseString((String) dispatch.invoke(rpc, call)).getAsJsonObject();
                assertTrue(created.getAsJsonObject("result").get("ok").getAsBoolean(), created.toString());
                assertTrue(jdbc.base.nativeBreakpoints.listing().contains("SCOTT." + program + ", Line 3"));
                assertEquals("P_TEST", agent.plDebugListBreakpoints("package-source").stream()
                    .filter(item -> source.id().equals(item.getSourceRefId())).findFirst().orElseThrow().getName());
                int sets = jdbc.base.nativeBreakpoints.sets;
                agent.plDebugStepIn("package-source");
                assertEquals(created, JsonParser.parseString((String) dispatch.invoke(rpc, call)).getAsJsonObject());
                assertEquals(sets, jdbc.base.nativeBreakpoints.sets);
                params.put("operationId", "stale-member-set");
                call = new Gson().toJson(Map.of("id", 2, "method", "pl_debug_set_breakpoints", "params", params));
                assertTrue(JsonParser.parseString((String) dispatch.invoke(rpc, call)).getAsJsonObject().has("error"));
                assertEquals("failed", agent.plDebugOperationStatus("package-source", "stale-member-set").get("state"));
                assertEquals(sets, jdbc.base.nativeBreakpoints.sets);
                agent.plDebugClose("package-source");
            }
        }
    }

    @Test
    void anonymousSourceRpcUsesTheProvenRootAndOriginalRevision() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            OceanBaseOracleAgent agent = agent(jdbc, new AtomicInteger());
            Map<String, Object> start = agent.plDebugStart(request("anonymous-source"));
            Map<?, ?> frame = (Map<?, ?>) ((java.util.List<?>) agent.plDebugGetStack("anonymous-source").get("frames")).getFirst();
            PlDebugSource.Reference source = (PlDebugSource.Reference) frame.get("sourceRef");
            assertEquals("controlled_root", source.evidenceKind());
            assertEquals("submitted_wrapper", source.lineBasis());
            assertEquals("BEGIN\n  NULL;\nEND;", source.source());
            JsonRpcServer rpc = new JsonRpcServer(agent);
            var dispatch = JsonRpcServer.class.getDeclaredMethod("handleRequest", String.class);
            dispatch.setAccessible(true);
            Map<String, Object> params = new java.util.LinkedHashMap<>(Map.of("debugId", "anonymous-source", "operationId", "root-set",
                "stopRevision", start.get("stopRevision"), "sourceRefId", source.id(), "sourceRevision", 1,
                "nativeFrameId", 1, "line", 2));
            String call = new Gson().toJson(Map.of("id", 1, "method", "pl_debug_set_breakpoints", "params", params));
            JsonObject created = JsonParser.parseString((String) dispatch.invoke(rpc, call)).getAsJsonObject();
            assertTrue(created.getAsJsonObject("result").get("ok").getAsBoolean(), created.toString());
            assertEquals(source.lineOffset() + 2, agent.plDebugListBreakpoints("anonymous-source").getFirst().getNativeLine());
            agent.plDebugStepOver("anonymous-source");
            assertEquals(created, JsonParser.parseString((String) dispatch.invoke(rpc, call)).getAsJsonObject());
            params.put("operationId", "stale-root");
            String stale = new Gson().toJson(Map.of("id", 2, "method", "pl_debug_set_breakpoints", "params", params));
            assertTrue(JsonParser.parseString((String) dispatch.invoke(rpc, stale)).getAsJsonObject().has("error"));
            assertEquals(1, jdbc.nativeBreakpoints.sets);
            agent.plDebugClose("anonymous-source");
        }
    }

    @Test
    void partialBreakpointArrayKeepsConfirmedPrefixWithoutReplayingIt() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            OceanBaseOracleAgent agent = agent(jdbc, new AtomicInteger());
            agent.plDebugStart(request("partial-array"));
            com.dbx.agent.PlDebugBreakpoint first = new com.dbx.agent.PlDebugBreakpoint();
            first.setKind("ANONYMOUS");
            first.setLine(2);
            com.dbx.agent.PlDebugBreakpoint second = new com.dbx.agent.PlDebugBreakpoint();
            second.setKind("ANONYMOUS");
            second.setLine(3);
            second.setSignature("unsupported-signature");
            var items = java.util.List.of(first, second, first);
            assertThrows(RuntimeException.class, () -> agent.plDebugSetBreakpoints("partial-array", "partial", null, items));
            assertEquals(1, ((java.util.List<?>) agent.plDebugStatus("partial-array").get("breakpoints")).size());
            assertEquals("unknown", agent.plDebugOperationStatus("partial-array", "partial").get("state"));
            Map<?, ?> partial = (Map<?, ?>) agent.plDebugOperationStatus("partial-array", "partial").get("result");
            java.util.List<?> outcomes = (java.util.List<?>) partial.get("items");
            assertEquals("succeeded", ((Map<?, ?>) outcomes.get(0)).get("state"));
            assertEquals("failed", ((Map<?, ?>) outcomes.get(1)).get("state"));
            assertEquals("not_started", ((Map<?, ?>) outcomes.get(2)).get("state"));
            assertEquals(1, ((java.util.List<?>) partial.get("breakpoints")).size());
            assertThrows(RuntimeException.class, () -> agent.plDebugSetBreakpoints("partial-array", "partial", null, items));
            assertEquals(1, ((java.util.List<?>) agent.plDebugStatus("partial-array").get("breakpoints")).size());
            agent.plDebugClose("partial-array");
        }
    }

    @Test
    void originalBreakpointArrayNeverRecreatesDeletedRegistration() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            OceanBaseOracleAgent agent = agent(jdbc, new AtomicInteger());
            agent.plDebugStart(request("array-receipt"));
            com.dbx.agent.PlDebugBreakpoint breakpoint = new com.dbx.agent.PlDebugBreakpoint();
            breakpoint.setKind("ANONYMOUS");
            breakpoint.setLine(2);
            var items = java.util.List.of(breakpoint);
            Map<String, Object> original = agent.plDebugSetBreakpoints("array-receipt", "create", null, items);
            assertEquals(0, original.get("result"));
            var created = agent.plDebugListBreakpoints("array-receipt");
            assertNotNull(created.getFirst().getRegistrationId());
            assertEquals(true, created.getFirst().getOwned());
            assertEquals(true, created.getFirst().getEnabled());
            assertNotNull(created.getFirst().getNativeLine());
            created.getFirst().setOwner("caller-mutated");
            assertEquals("SCOTT", agent.plDebugListBreakpoints("array-receipt").getFirst().getOwner());
            Map<String, Object> removed = agent.plDebugDeleteBreakpoints("array-receipt", "delete", null, created);
            assertSame(original, agent.plDebugSetBreakpoints("array-receipt", "create", null, items));
            assertTrue(agent.plDebugListBreakpoints("array-receipt").isEmpty());
            breakpoint.setLine(3);
            assertThrows(RuntimeException.class, () -> agent.plDebugSetBreakpoints("array-receipt", "create", null, items));
            agent.plDebugClose("array-receipt");
            assertSame(removed, agent.plDebugDeleteBreakpoints("array-receipt", "delete", null, created));
        }
    }

    @Test
    void aZeroNativeWriteUserClaimStillMakesALaterArrayRejectionPartial() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            AtomicInteger opens = new AtomicInteger();
            PlDebugManager manager = new PlDebugManager(() -> jdbc.connection(opens.getAndIncrement() % 2 == 0));
            manager.start(request("claim-array"));
            com.dbx.agent.PlDebugBreakpoint first = new com.dbx.agent.PlDebugBreakpoint();
            first.setKind("ANONYMOUS"); first.setLine(2);
            manager.changeBreakpoints("claim-array", "locate", null, java.util.List.of(first), false);
            var original = manager.breakpoints("claim-array");
            int nativeLine = original.getFirst().getNativeLine();
            manager.changeBreakpoints("claim-array", "remove", null, original, true);
            manager.map("claim-array", session -> {
                var arm = PlDebugSession.class.getDeclaredMethod("armStartBreakpoint", int.class, String.class);
                arm.setAccessible(true);
                arm.invoke(session, nativeLine, "private-wrapper");
                return session.snapshot();
            });
            assertTrue(manager.breakpoints("claim-array").isEmpty());
            int writes = jdbc.nativeBreakpoints.writes;
            com.dbx.agent.PlDebugBreakpoint invalid = new com.dbx.agent.PlDebugBreakpoint();
            invalid.setKind("ANONYMOUS"); invalid.setLine(3); invalid.setSignature("unsupported");
            var items = java.util.List.of(first, invalid);
            assertThrows(Exception.class, () -> manager.changeBreakpoints("claim-array", "partial-claim", null, items, false));
            var receipt = manager.operationStatus("claim-array", "partial-claim");
            assertEquals("unknown", receipt.get("state"));
            assertNull(receipt.get("error"));
            assertEquals(1, ((java.util.List<?>) manager.status("claim-array").get("breakpoints")).size());
            assertEquals(writes, jdbc.nativeBreakpoints.writes);
            assertThrows(Exception.class, () -> manager.changeBreakpoints("claim-array", "partial-claim", null, items, false));
            assertEquals(writes, jdbc.nativeBreakpoints.writes);
            manager.close("claim-array");
        }
    }

    @Test
    void breakpointRpcRecoversOriginalToggleWithoutRequiringLegacyRevision() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            OceanBaseOracleAgent agent = agent(jdbc, new AtomicInteger());
            agent.plDebugStart(request("toggle-rpc"));
            com.dbx.agent.PlDebugBreakpoint breakpoint = new com.dbx.agent.PlDebugBreakpoint();
            breakpoint.setKind("ANONYMOUS");
            breakpoint.setLine(2);
            agent.plDebugSetBreakpoints("toggle-rpc", java.util.List.of(breakpoint));
            int number = agent.plDebugListBreakpoints("toggle-rpc").getFirst().getBreakpointNumber();
            JsonRpcServer rpc = new JsonRpcServer(agent);
            var dispatch = JsonRpcServer.class.getDeclaredMethod("handleRequest", String.class);
            dispatch.setAccessible(true);
            String request = new Gson().toJson(Map.of("id", 1, "method", "pl_debug_set_breakpoint_enabled",
                "params", Map.of("debugId", "toggle-rpc", "operationId", "toggle", "breakpointNumber", number, "enabled", false)));
            JsonObject first = JsonParser.parseString((String) dispatch.invoke(rpc, request)).getAsJsonObject();
            assertTrue(first.getAsJsonObject("result").get("ok").getAsBoolean(), first.toString());
            assertEquals("succeeded", agent.plDebugOperationStatus("toggle-rpc", "toggle").get("state"));
            String list = new Gson().toJson(Map.of("id", 3, "method", "pl_debug_list_breakpoints", "params", Map.of("debugId", "toggle-rpc")));
            JsonObject listing = JsonParser.parseString((String) dispatch.invoke(rpc, list)).getAsJsonObject();
            JsonObject listed = listing.getAsJsonArray("result").get(0).getAsJsonObject();
            assertTrue(listed.get("owned").getAsBoolean());
            assertFalse(listed.get("enabled").getAsBoolean());
            assertFalse(listed.get("localActive").getAsBoolean());
            assertTrue(listed.has("registrationId"));
            Map<?, ?> owned = (Map<?, ?>) ((java.util.List<?>) agent.plDebugStatus("toggle-rpc").get("breakpoints")).getFirst();
            assertEquals(false, owned.get("localActive"));
            long revision = ((Number) agent.plDebugStatus("toggle-rpc").get("stopRevision")).longValue();
            String flat = new Gson().toJson(Map.of("id", 2, "method", "pl_debug_set_breakpoint_enabled", "params",
                Map.of("debugId", "toggle-rpc", "operationId", "registered-toggle", "stopRevision", revision,
                    "registrationId", owned.get("registrationId"), "breakpointNumber", number, "enabled", true)));
            JsonObject enabled = JsonParser.parseString((String) dispatch.invoke(rpc, flat)).getAsJsonObject();
            assertTrue(enabled.getAsJsonObject("result").get("ok").getAsBoolean(), enabled.toString());
            var active = agent.plDebugListBreakpoints("toggle-rpc").getFirst();
            assertEquals(true, active.getEnabled());
            assertEquals(true, active.getLocalActive());
            agent.plDebugClose("toggle-rpc");
            assertEquals(first, JsonParser.parseString((String) dispatch.invoke(rpc, request)).getAsJsonObject());
            assertEquals(enabled, JsonParser.parseString((String) dispatch.invoke(rpc, flat)).getAsJsonObject());
        }
    }

    @Test
    void breakpointReceiptRetainsOriginalActionAndResultAfterClose() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            AtomicInteger opens = new AtomicInteger();
            PlDebugManager manager = new PlDebugManager(() -> jdbc.connection(opens.getAndIncrement() % 2 == 0));
            Map<String, Object> start = manager.start(request("breakpoint-receipt"));
            long revision = ((Number) start.get("stopRevision")).longValue();
            com.dbx.agent.PlDebugBreakpoint breakpoint = new com.dbx.agent.PlDebugBreakpoint();
            breakpoint.setKind("ANONYMOUS");
            breakpoint.setLine(2);
            manager.map("breakpoint-receipt", session -> session.setBreakpoints(java.util.List.of(breakpoint)));
            int number = manager.breakpoints("breakpoint-receipt").getFirst().getBreakpointNumber();
            Map<String, Object> result = manager.setBreakpointEnabled("breakpoint-receipt", "toggle", revision, number, false);
            assertEquals(true, result.get("ok"));
            assertSame(result, manager.setBreakpointEnabled("breakpoint-receipt", "toggle", revision, number, false));
            assertEquals("set_breakpoint_enabled", manager.operationStatus("breakpoint-receipt", "toggle").get("action"));
            assertThrows(RuntimeException.class, () -> manager.setBreakpointEnabled("breakpoint-receipt", "toggle", revision, number, true));
            assertThrows(RuntimeException.class, () -> manager.setValue("breakpoint-receipt", "toggle", revision, "N", 0, 0, "1"));
            manager.close("breakpoint-receipt");
            assertSame(result, manager.setBreakpointEnabled("breakpoint-receipt", "toggle", revision, number, false));
        }
    }

    @Test
    void assignmentRpcRetainsOriginalResultAndNeverReplaysUnknownOrRejectedWrites() throws Exception {
        for (String scenario : java.util.List.of("success", "rejected", "missing_result", "sql_error", "unsupported")) {
            try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
                jdbc.setValueSupported = !scenario.equals("unsupported");
                jdbc.setValueResult = scenario.equals("rejected") ? 77 : 0;
                jdbc.setValueNull = scenario.equals("missing_result");
                if (scenario.equals("sql_error")) jdbc.setValueFailure = new SQLException("response lost after evaluation");
                AtomicInteger opens = new AtomicInteger();
                OceanBaseOracleAgent agent = agent(jdbc, opens);
                Map<String, Object> start = agent.plDebugStart(request("value-start"));
                long revision = ((Number) start.get("stopRevision")).longValue();
                JsonRpcServer rpc = new JsonRpcServer(agent);
                var dispatch = JsonRpcServer.class.getDeclaredMethod("handleRequest", String.class);
                dispatch.setAccessible(true);
                Map<String, Object> params = Map.of("debugId", "value-start", "operationId", "assignment",
                    "stopRevision", revision, "name", "\"a(b)\"", "frame", 0, "index", 2, "value", "9007199254740993123456789");
                String request = new Gson().toJson(Map.of("id", 1, "method", "pl_debug_set_value", "params", params));
                JsonObject result = JsonParser.parseString((String) dispatch.invoke(rpc, request)).getAsJsonObject();
                boolean known = scenario.equals("success") || scenario.equals("rejected");
                assertEquals(known, result.has("result"), result.toString());
                if (known) assertEquals(scenario.equals("success"), result.getAsJsonObject("result").get("ok").getAsBoolean());
                if (scenario.equals("unsupported")) {
                    assertTrue(result.getAsJsonObject("error").get("message").getAsString().contains("does not declare SET_VALUE"));
                }
                dispatch.invoke(rpc, request);
                assertEquals(scenario.equals("unsupported") ? 0 : 1, jdbc.setValueExecutions.get());
                if (!scenario.equals("unsupported")) assertEquals("1:\"a(b)\"(2) := 9007199254740993123456789;", jdbc.assignments.getFirst());
                Map<String, Object> status = agent.plDebugOperationStatus("value-start", "assignment");
                assertEquals(scenario.equals("success") ? "succeeded" : scenario.equals("rejected") || scenario.equals("unsupported") ? "failed" : "unknown", status.get("state"));
                assertEquals(2, opens.get());
                assertThrows(RuntimeException.class, () -> agent.plDebugSetValue("value-start", "assignment", revision, "N", 0, 0, "2"));
                agent.plDebugClose("value-start");
                PlDebugNativeTest.assertNoHelperDdl(jdbc.sql);
            }
        }
    }

    @Test
    void sameAssignmentIdJoinsOriginalCallAndStaleRevisionNeverDispatches() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture();
             ExecutorService client = Executors.newFixedThreadPool(2)) {
            jdbc.setValueSupported = true;
            jdbc.holdSetValue = true;
            OceanBaseOracleAgent agent = agent(jdbc, new AtomicInteger());
            Map<String, Object> start = agent.plDebugStart(request("value-pending"));
            long revision = ((Number) start.get("stopRevision")).longValue();
            assertThrows(RuntimeException.class, () -> agent.plDebugSetValue("value-pending", "old", revision - 1, "N", 0, 0, "1"));
            assertEquals(0, jdbc.setValueExecutions.get());
            Future<Map<String, Object>> first = client.submit(() -> agent.plDebugSetValue("value-pending", "same", revision, "N", 0, 0, "1"));
            assertTrue(jdbc.setValueEntered.await(2, TimeUnit.SECONDS));
            assertEquals("running", agent.plDebugOperationStatus("value-pending", "same").get("state"));
            Future<Map<String, Object>> duplicate = client.submit(() -> agent.plDebugSetValue("value-pending", "same", revision, "N", 0, 0, "1"));
            jdbc.setValueRelease.countDown();
            assertEquals(first.get(2, TimeUnit.SECONDS), duplicate.get(2, TimeUnit.SECONDS));
            assertEquals(1, jdbc.setValueExecutions.get());
            agent.plDebugResume("value-pending");
            assertEquals(true, agent.plDebugSetValue("value-pending", "same", revision, "N", 0, 0, "1").get("ok"));
            assertEquals(1, jdbc.setValueExecutions.get());
            agent.plDebugClose("value-pending");
        }
    }

    @Test
    void registersBeforeConnectionCreationAndNeverReplaysADuplicateStart() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture();
             ExecutorService client = Executors.newSingleThreadExecutor()) {
            CountDownLatch opening = new CountDownLatch(1);
            CountDownLatch allowOpen = new CountDownLatch(1);
            AtomicInteger opens = new AtomicInteger();
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent(() -> {
                opens.incrementAndGet(); opening.countDown();
                assertTrue(allowOpen.await(3, TimeUnit.SECONDS));
                return jdbc.connection(true);
            });
            Future<?> start = client.submit(() -> agent.plDebugStart(request("start-before-open")));
            assertTrue(opening.await(2, TimeUnit.SECONDS));
            try {
                Map<String, Object> intent = agent.plDebugStatus("start-before-open");
                assertEquals("starting", intent.get("state"));
                assertNull(intent.get("nativeDebugId"));
                assertEquals(false, intent.get("targetDispatched"));
                assertEquals("running", agent.plDebugStart(request("start-before-open")).get("startState"));
                assertEquals(1, opens.get());
                assertEquals(false, agent.plDebugAbort("start-before-open").get("cancelConfirmed"));
                assertFalse(agent.plDebugClose("start-before-open"));
            } finally {
                allowOpen.countDown();
            }
            assertThrows(ExecutionException.class, () -> start.get(2, TimeUnit.SECONDS));
            assertEquals(0, jdbc.targetExecutions.get());
            Map<String, Object> stopped = agent.plDebugStatus("start-before-open");
            assertEquals("cancelled", stopped.get("executionOutcome"));
            assertEquals(true, stopped.get("cancelConfirmed"));
            assertEquals("released", stopped.get("releaseState"));
            assertEquals("failed", agent.plDebugStart(request("start-before-open")).get("startState"));
            assertEquals(1, opens.get());
        }
    }

    @Test
    void publishesTheNativeIdentityBeforeDebugOnAndHonoursEarlyCancellation() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            AtomicReference<PlDebugSession> published = new AtomicReference<>();
            assertThrows(java.util.concurrent.CancellationException.class, () -> PlDebugSession.start(
                jdbc.connection(true), jdbc.connection(false), request("publish-first"), jdbc.targetWorker, 120000,
                session -> {
                    published.set(session);
                    assertEquals("native-id", session.snapshot().get("debugId"));
                    assertEquals(0, jdbc.targetExecutions.get());
                    session.requestAbort();
                }));
            assertNotNull(published.get());
            assertEquals("released", published.get().snapshot().get("releaseState"));
            assertEquals("cancelled", published.get().snapshot().get("executionOutcome"));
            assertFalse(jdbc.sql.stream().anyMatch(sql -> sql.contains("DBMS_DEBUG.DEBUG_ON")));
            assertEquals(0, jdbc.targetExecutions.get());
        }
    }

    @Test
    void preservesTheStartReceiptAfterReleaseAndRejectsChangedContent() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            AtomicInteger opens = new AtomicInteger();
            OceanBaseOracleAgent agent = agent(jdbc, opens);
            Map<String, Object> start = agent.plDebugStart(request("one-target"));
            assertEquals("one-target", start.get("debugId"));
            assertEquals("native-id", start.get("nativeDebugId"));
            assertEquals("paused", agent.plDebugStart(request("one-target")).get("state"));
            assertEquals(2, opens.get());
            assertThrows(IllegalArgumentException.class, () -> agent.plDebugStatus("native-id"));
            assertThrows(IllegalStateException.class, () -> agent.plDebugStart(request("second-target")));
            PlDebugStartRequest changed = request("one-target");
            changed.setSource("BEGIN NULL; NULL; END;");
            assertThrows(IllegalArgumentException.class, () -> agent.plDebugStart(changed));
            assertEquals("succeeded", agent.plDebugResume("one-target").get("executionOutcome"));
            assertTrue(agent.plDebugClose("one-target"));
            assertEquals("released", agent.plDebugStart(request("one-target")).get("releaseState"));
            assertEquals(1, jdbc.targetExecutions.get());
            assertEquals(2, opens.get());
            PlDebugNativeTest.assertNoHelperDdl(jdbc.sql);
        }
    }

    @Test
    void rejectsAnotherOperationWhilePendingResumeAndAbortsWithoutWaitingForItsMonitor() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture();
             ExecutorService client = Executors.newSingleThreadExecutor()) {
            jdbc.longContinue = true;
            OceanBaseOracleAgent agent = agent(jdbc, new AtomicInteger());
            agent.plDebugStart(request("busy-target"));
            Future<Map<String, Object>> continuation = client.submit(() -> agent.plDebugResume("busy-target"));
            assertTrue(jdbc.continueEntered.await(2, TimeUnit.SECONDS));
            assertTimeoutPreemptively(Duration.ofSeconds(2), () -> {
                assertEquals("running", agent.plDebugHeartbeat("busy-target").get("state"));
                assertThrows(IllegalStateException.class, () -> agent.plDebugStepOver("busy-target"));
                assertEquals(true, agent.plDebugAbort("busy-target").get("cancelConfirmed"));
            });
            continuation.get(2, TimeUnit.SECONDS);
            assertTrue(agent.plDebugClose("busy-target"));
            assertEquals(1, jdbc.statementCancels.get());
            assertEquals(1, jdbc.targetExecutions.get());
            assertEquals(1, jdbc.cleanupExecutions.get());
            assertEquals(jdbc.output, agent.plDebugGetLog("busy-target").get("output"));
        }
    }

    @Test
    void retainsFailedStartupResourcesAndRetriesOnlyTheUnclosedConnection() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            AtomicInteger opens = new AtomicInteger();
            jdbc.debuggeeCloseFailures.set(1);
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent(() -> {
                if (opens.incrementAndGet() == 2) throw new SQLException("injected second connection rejection");
                return jdbc.connection(true);
            });
            assertThrows(RuntimeException.class, () -> agent.plDebugStart(request("failed-start")));
            Map<String, Object> failed = agent.plDebugStatus("failed-start");
            assertEquals("failed", failed.get("startState"));
            assertEquals("unknown", failed.get("releaseState"));
            assertEquals(false, failed.get("targetDispatched"));
            assertNull(failed.get("nativeDebugId"));
            assertThrows(IllegalStateException.class, () -> agent.plDebugStart(request("another-start")));
            assertEquals("failed", agent.plDebugStart(request("failed-start")).get("startState"));
            assertTrue(agent.plDebugClose("failed-start"));
            assertEquals("released", agent.plDebugStatus("failed-start").get("releaseState"));
            assertEquals(2, Collections.frequency(jdbc.events, "debuggee.close"));
            assertEquals(2, opens.get());
            assertEquals(0, jdbc.targetExecutions.get());
        }
    }

    @Test
    void preservesTheSessionsCancellationRequestDuringAutomaticStartupCleanup() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture()) {
            jdbc.attachFailure = true;
            AtomicInteger opens = new AtomicInteger();
            OceanBaseOracleAgent agent = agent(jdbc, opens);
            assertThrows(RuntimeException.class, () -> agent.plDebugStart(request("automatic-start-cleanup")));
            Map<String, Object> status = agent.plDebugStatus("automatic-start-cleanup");
            assertEquals("failed", status.get("startState"));
            assertEquals(true, status.get("cancelConfirmed"));
            assertEquals("cancelled", status.get("executionOutcome"));
            assertEquals(true, status.get("cancelRequested"));
            assertEquals("released", status.get("releaseState"));
            assertEquals("failed", agent.plDebugStart(request("automatic-start-cleanup")).get("startState"));
            assertEquals(1, jdbc.targetExecutions.get());
            assertEquals(1, jdbc.statementCancels.get());
            assertEquals(2, opens.get());
        }
    }

    private static OceanBaseOracleAgent agent(PlDebugLifecycleTest.Fixture jdbc, AtomicInteger opens) {
        return new OceanBaseOracleAgent(() -> jdbc.connection(opens.getAndIncrement() % 2 == 0));
    }

    @Test
    void closeDirectlyCancelsAPausedTargetWhoseControllerWasClosed() throws Exception {
        try (PlDebugLifecycleTest.Fixture jdbc = new PlDebugLifecycleTest.Fixture();
             var target = new com.dbx.agent.PlDebugDedicatedOwnerFixture(jdbc.connection(true));
             var controller = new com.dbx.agent.PlDebugDedicatedOwnerFixture(jdbc.connection(false))) {
            AtomicInteger opens = new AtomicInteger();
            OceanBaseOracleAgent agent = new OceanBaseOracleAgent(() -> opens.getAndIncrement() == 0 ? target.connection : controller.connection);
            agent.plDebugStart(request("closed-controller"));
            jdbc.controllerClosed = true;
            assertTrue(agent.plDebugClose("closed-controller"));
            assertEquals("released", agent.plDebugStatus("closed-controller").get("releaseState"));
            assertEquals("cancelled", agent.plDebugStatus("closed-controller").get("executionOutcome"));
            assertEquals(1, jdbc.targetExecutions.get());
            assertEquals(1, jdbc.statementCancels.get());
            assertEquals(0, jdbc.cleanupExecutions.get());
            assertEquals(2, opens.get());
            assertFalse(jdbc.events.contains("detach"));
            assertTrue(target.resourcesReleased());
            assertTrue(controller.resourcesReleased());
        }
    }

    @Test
    void anUnreturnedPhysicalConnectionIsNotReportedReleased() {
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent(() -> {
            throw new PlDebugManager.UntrackedConnectionException(new SQLException("injected initialization and close failure"));
        });
        assertThrows(RuntimeException.class, () -> agent.plDebugStart(request("untracked-start")));
        assertEquals("unknown", agent.plDebugStatus("untracked-start").get("releaseState"));
        assertEquals(true, agent.plDebugStatus("untracked-start").get("untrackedConnection"));
        assertEquals(false, agent.plDebugStatus("untracked-start").get("targetDispatched"));
        assertFalse(agent.plDebugClose("untracked-start"));
        assertEquals("unknown", agent.plDebugStatus("untracked-start").get("releaseState"));
    }

    private static PlDebugStartRequest request(String id) {
        PlDebugStartRequest request = new PlDebugStartRequest();
        request.setOperationId(id);
        request.setSchema("SCOTT");
        request.setObjectType("ANONYMOUS");
        request.setSource("BEGIN\n  NULL;\nEND;");
        return request;
    }
}
