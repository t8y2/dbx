package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.PlDebugStartRequest;
import org.junit.jupiter.api.Test;

import javax.sql.rowset.serial.SerialClob;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLRecoverableException;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugLifecycleTest {
    @Test
    void controllerLossDoesNotSkipAnAlreadyDispatchedPrivateCleanup() throws Exception {
        try (Fixture jdbc = new Fixture(); ExecutorService callers = Executors.newSingleThreadExecutor()) {
            PlDebugSession session = jdbc.start();
            session.abortByStatement();
            jdbc.holdCleanup = true;
            Future<?> close = callers.submit(session::close);
            try {
                assertTrue(jdbc.cleanupEntered.await(2, TimeUnit.SECONDS));
                jdbc.controllerClosed = true;
                assertFalse(close.isDone());
                assertFalse(jdbc.events.contains("debuggee.rollback"));
                assertFalse(jdbc.events.contains("debuggee.close"));
            } finally {
                jdbc.allowCleanup.countDown();
            }
            close.get(2, TimeUnit.SECONDS);
            assertEquals(1, jdbc.cleanupExecutions.get());
            assertEquals("released", session.snapshot().get("releaseState"));
            assertFalse(jdbc.events.contains("detach"));
        }
    }

    @Test
    void unknownControllerPhysicalStateDoesNotClaimRelease() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            PlDebugSession session = jdbc.start();
            session.abortByStatement();
            jdbc.controllerStateFailure = true;
            assertThrows(IllegalStateException.class, session::close);
            assertEquals("unknown", session.snapshot().get("releaseState"));
            assertEquals(0, jdbc.cleanupExecutions.get());
            assertFalse(jdbc.events.contains("debugger.close"));
            jdbc.controllerStateFailure = false;
            session.close();
            assertEquals("released", session.snapshot().get("releaseState"));
            assertEquals(1, jdbc.targetExecutions.get());
        }
    }

    @Test
    void unconfirmedNativePausePolicyNeverDispatchesTarget() throws Exception {
        for (boolean wrongBehaviour : new boolean[] {false, true}) {
            try (Fixture jdbc = new Fixture()) {
                jdbc.nativeTimeoutResult = wrongBehaviour ? 120 : 0;
                jdbc.nativeTimeoutBehaviour = wrongBehaviour ? 3 : 0;
                var original = new java.util.concurrent.atomic.AtomicReference<PlDebugSession>();
                jdbc.initialized = original::set;
                assertThrows(SQLException.class, jdbc::start);
                assertEquals(0, jdbc.targetExecutions.get());
                assertEquals(false, original.get().snapshot().get("targetDispatched"));
                original.get().close();
                assertEquals("released", original.get().snapshot().get("releaseState"));
            }
        }
    }

    @Test
    void closedControllerCancelsOriginalTargetWithoutStartingPrivateCleanup() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            PlDebugSession session = jdbc.start();
            jdbc.controllerClosed = true;
            session.close();
            assertEquals(1, jdbc.statementCancels.get());
            assertEquals(0, jdbc.cleanupExecutions.get());
            assertFalse(jdbc.events.contains("detach"));
            assertTrue(jdbc.events.contains("debuggee.rollback"));
            assertTrue(jdbc.events.contains("debugger.close"));
            assertTrue(jdbc.events.contains("debuggee.close"));
            assertEquals("cancelled", session.snapshot().get("executionOutcome"));
            assertEquals("released", session.snapshot().get("releaseState"));
            assertTrue(session.log().toString().contains("recovery is incomplete"));
        }
    }

    @Test
    void privateCleanupConfigurationFailurePreservesCancellationAndBlocksJdbc() throws Exception {
        for (boolean restoreFailure : new boolean[] {false, true}) {
            try (Fixture jdbc = new Fixture()) {
                jdbc.networkTimeout = 120000;
                jdbc.failPrivateTimeoutDisable = !restoreFailure;
                jdbc.failPrivateTimeoutRestore = restoreFailure;
                PlDebugSession session = jdbc.start();
                session.abort();
                assertThrows(IllegalStateException.class, session::close);
                assertThrows(IllegalStateException.class, session::close);
                assertEquals("cancelled", session.snapshot().get("executionOutcome"));
                assertEquals(true, session.snapshot().get("executionStopped"));
                assertEquals(restoreFailure ? 1 : 0, jdbc.cleanupExecutions.get());
                assertEquals(0, jdbc.outputTransfers.get());
                assertFalse(jdbc.events.contains("cleanup.close"));
                assertFalse(jdbc.events.contains("debuggee.rollback"));
                assertFalse(jdbc.events.contains("debuggee.close"));
                assertEquals("unknown", session.snapshot().get("releaseState"));
            }
        }
    }

    @Test
    void abortOutputCleanupProtectsOnlyItsNativeExecuteWait() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.networkTimeout = 120000;
            PlDebugSession session = jdbc.start();
            session.abort();
            session.close();
            session.close();
            assertEquals(List.of(0), jdbc.cleanupNetworkTimeouts);
            assertEquals(List.of(30), jdbc.cleanupQueryTimeouts);
            assertEquals(120000, jdbc.networkTimeout);
            assertEquals(1, jdbc.targetExecutions.get());
            assertEquals(1, jdbc.cleanupExecutions.get());
            assertEquals("cancelled", session.snapshot().get("executionOutcome"));
            assertEquals("released", session.snapshot().get("releaseState"));
        }
    }

    @Test
    void abortDuringRestoreNeverCancelsOutputOrRollback() throws Exception {
        try (Fixture jdbc = new Fixture(); ExecutorService callers = Executors.newFixedThreadPool(2)) {
            jdbc.networkTimeout = 120000;
            jdbc.holdTimeoutRestore = true;
            PlDebugSession session = jdbc.start();
            Future<?> resumed = callers.submit(() -> { try { session.resume(); } catch (Exception e) { throw new RuntimeException(e); } });
            assertTrue(jdbc.timeoutRestoreEntered.await(2, TimeUnit.SECONDS));
            Future<?> aborted = callers.submit(() -> { try { session.abortByStatement(); } catch (Exception e) { throw new RuntimeException(e); } });
            jdbc.allowTimeoutRestore.countDown();
            resumed.get(2, TimeUnit.SECONDS);
            aborted.get(2, TimeUnit.SECONDS);
            session.close();
            assertEquals(0, jdbc.statementCancels.get());
            assertEquals(1, jdbc.targetExecutions.get());
            assertEquals("succeeded", session.snapshot().get("executionOutcome"));
            assertEquals("released", session.snapshot().get("releaseState"));
        }
    }

    @Test
    void failedTimeoutDisableNeverDispatchesAndRetainsOriginalResources() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.networkTimeout = 120000;
            jdbc.failTimeoutDisable = true;
            var original = new java.util.concurrent.atomic.AtomicReference<PlDebugSession>();
            jdbc.initialized = original::set;
            assertThrows(Exception.class, jdbc::start);
            PlDebugSession session = original.get();
            assertNotNull(session);
            assertEquals(false, session.snapshot().get("targetDispatched"));
            assertEquals("not_started", session.snapshot().get("executionOutcome"));
            assertEquals(0, jdbc.targetExecutions.get());
            assertThrows(IllegalStateException.class, session::close);
            assertFalse(jdbc.events.contains("target.close"));
            assertFalse(jdbc.events.contains("debuggee.rollback"));
            assertFalse(jdbc.events.contains("debuggee.close"));
        }
    }

    @Test
    void executeCommunicationErrorSurvivesASecondRestoreError() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.networkTimeout = 120000;
            jdbc.failTimeoutRestore = true;
            jdbc.targetFailure = new SQLRecoverableException("original execute communication failure", "08000");
            PlDebugSession session = jdbc.start();
            jdbc.releaseTarget.countDown();
            jdbc.targetWorker.submit(() -> {}).get(2, TimeUnit.SECONDS);
            var status = session.snapshot();
            assertEquals(false, status.get("executionStopped"));
            assertEquals("unknown", status.get("executionOutcome"));
            assertTrue(status.toString().contains("original execute communication failure"), status.toString());
            assertThrows(IllegalStateException.class, session::close);
            assertEquals(0, jdbc.outputTransfers.get());
            assertFalse(jdbc.events.contains("target.close"));
        }
    }

    @Test
    void lateTrackedRestoreCannotRaceCancelOrCleanupAndDoesNotReleaseOwner() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.networkTimeout = 120000;
            jdbc.holdTimeoutRestore = true;
            try (var tracked = new com.dbx.agent.PlDebugDedicatedOwnerFixture(jdbc.connection(true))) {
                PlDebugSession session = jdbc.start(tracked.connection);
                assertThrows(Exception.class, session::resume);
                assertTrue(jdbc.timeoutRestoreEntered.await(1, TimeUnit.SECONDS));
                assertEquals(true, session.snapshot().get("executionStopped"));
                assertThrows(IllegalStateException.class, session::abortByStatement);
                assertThrows(IllegalStateException.class, session::close);
                assertFalse(tracked.resourcesReleased());
                assertEquals(0, jdbc.statementCancels.get());
                assertEquals(0, jdbc.outputTransfers.get());
                assertFalse(jdbc.events.contains("target.close"));
                assertFalse(jdbc.events.contains("debuggee.rollback"));
                assertFalse(jdbc.events.contains("debuggee.close"));
                jdbc.allowTimeoutRestore.countDown();
                assertTrue(jdbc.timeoutRestoreCompleted.await(2, TimeUnit.SECONDS));
                assertThrows(IllegalStateException.class, session::close,
                    "late setter completion is not a new session configuration receipt");
                assertFalse(tracked.resourcesReleased());
            } finally { jdbc.allowTimeoutRestore.countDown(); }
        }
    }

    @Test
    void targetWaitAloneDisablesNetworkTimeoutAndRestoresBeforeOutput() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.networkTimeout = 120000;
            PlDebugSession session = jdbc.start();
            assertEquals(0, jdbc.networkTimeout);
            session.resume();
            session.close();
            assertEquals(120000, jdbc.networkTimeout);
            assertTrue(jdbc.events.indexOf("timeout.120000") < jdbc.events.indexOf("target.output"));
            assertEquals(1, jdbc.targetExecutions.get());
            assertEquals("released", session.snapshot().get("releaseState"));
        }
    }

    @Test
    void restoreFailurePreservesStoppedFactAndBlocksAllTargetCleanup() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.networkTimeout = 120000;
            jdbc.failTimeoutRestore = true;
            PlDebugSession session = jdbc.start();
            assertThrows(Exception.class, session::resume);
            assertEquals(true, session.snapshot().get("executionStopped"));
            assertEquals("unknown", session.snapshot().get("executionOutcome"));
            assertThrows(IllegalStateException.class, session::close);
            assertThrows(IllegalStateException.class, session::abortByStatement);
            assertEquals(0, jdbc.outputTransfers.get());
            assertEquals(0, jdbc.statementCancels.get());
            assertFalse(jdbc.events.contains("target.close"));
            assertFalse(jdbc.events.contains("debuggee.rollback"));
            assertFalse(jdbc.events.contains("debuggee.close"));
        }
    }

    @Test
    void privateOutputCaptureCanPassMoreThanThirtyTwoConfirmedWrapperStops() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            PlDebugSession session = jdbc.start();
            session.listBreakpoints();
            jdbc.privateCaptureStops = 40;
            jdbc.controlTimeouts.clear();
            var result = session.resume();
            assertEquals("ended", result.get("state"), result.toString());
            assertEquals(0, jdbc.privateCaptureStops);
            assertEquals(1, jdbc.targetExecutions.get());
            assertEquals(41, jdbc.controlTimeouts.size());
            assertEquals(PlDebugNative.CALL_TIMEOUT_SECONDS, jdbc.controlTimeouts.getFirst());
            for (int index = 1; index < jdbc.controlTimeouts.size(); index++) {
                assertTrue(jdbc.controlTimeouts.get(index) > 0);
                assertTrue(jdbc.controlTimeouts.get(index) <= jdbc.controlTimeouts.get(index - 1));
            }
            session.close();
            assertEquals("released", session.snapshot().get("releaseState"));
        }
    }

    @Test
    void completedBreakpointHistoryDoesNotQueryAnInactiveDebugger() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            PlDebugSession session = jdbc.start();
            session.setBreakpoints(List.of(anonymousPoint(2)));
            int reads = jdbc.nativeBreakpoints.reads;
            jdbc.nativeBreakpoints.failReadAt = reads + 1;
            session.resume();
            assertEquals("ended", session.snapshot().get("state"));
            assertEquals(1, session.listBreakpoints().size());
            assertEquals(reads, jdbc.nativeBreakpoints.reads);
            session.close();
        }
    }

    @Test
    void unexpectedAnonymousBootstrapNeverNavigatesToFindAnotherToken() throws Exception {
        for (boolean wrongToken : new boolean[] {false, true}) {
            try (Fixture jdbc = new Fixture()) {
                if (wrongToken) jdbc.wrongRootToken = true;
                else jdbc.initialLine = 13;
                PlDebugSession session = jdbc.start();
                assertNull(session.startSnapshot().get("line"));
                assertEquals(wrongToken ? 3 : 0, jdbc.flags.size());
                var frame = (Map<?, ?>) ((List<?>) session.stack().get("frames")).getFirst();
                assertFalse(frame.containsKey("sourceRef"));
                assertThrows(IllegalStateException.class, () -> session.setBreakpoints(List.of(anonymousPoint(2))));
                assertEquals(0, jdbc.nativeBreakpoints.sets);
                session.close();
            }
        }
    }

    private static com.dbx.agent.PlDebugBreakpoint anonymousPoint(int line) {
        var point = new com.dbx.agent.PlDebugBreakpoint();
        point.setKind("ANONYMOUS");
        point.setLine(line);
        return point;
    }

    @Test
    void ordinaryUserInitializationDoesNotDependOnSysQualifiedSqlFunctionResolution() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.rejectSysSqlFunctions = true;
            PlDebugSession session = jdbc.start();
            assertEquals("native-id", session.debugId());
            assertEquals("paused", session.snapshot().get("state"));
            session.resume();
            session.close();
            assertEquals("released", session.snapshot().get("releaseState"));
            assertEquals(1, jdbc.targetExecutions.get());
        }
    }

    @Test
    void anonymousStartupSkipsThePrivatePrefixBeforePublishingItsFirstUserLine() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.initialLine = 2;
            PlDebugSession session = jdbc.start();
            assertEquals("1", session.startSnapshot().get("line"));
            assertEquals("13", session.startSnapshot().get("nativeLine"));
            assertEquals(java.util.Collections.nCopies(13, PlDebugNative.STEP_IN), jdbc.flags);
            assertEquals(false, session.startSnapshot().get("terminated"));
            session.resume();
            session.close();
        }
    }

    @Test
    void startsWithoutDdlPreservesOutputAndRollsBackBeforeDetaching() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.output = "first\n\n" + "汉|*\"\\\u001f\n".repeat(12000);
            PlDebugSession session = jdbc.start();
            assertEquals("paused", session.snapshot().get("state"));
            assertEquals(true, session.log().get("outputPending"));
            assertEquals("", session.log().get("output"));
            Map<String, Object> end = session.resume();
            assertEquals(true, end.get("targetReturned"));
            assertEquals("ended", end.get("state"));
            assertEquals(jdbc.output, session.log().get("output"));
            assertEquals(jdbc.output, session.log().get("output"));
            assertEquals(1, jdbc.targetExecutions.get());
            assertEquals(1, jdbc.outputTransfers.get());
            assertEquals("pending", end.get("transactionOutcome"));
            session.close();
            assertEquals("released", session.snapshot().get("releaseState"));
            assertEquals("controlled_work_rolled_back", session.snapshot().get("transactionOutcome"));
            assertTrue(jdbc.events.indexOf("debuggee.rollback") < jdbc.events.indexOf("detach"));
            assertTrue(jdbc.events.indexOf("detach") < jdbc.events.indexOf("debuggee.close"));
            PlDebugNativeTest.assertNoHelperDdl(jdbc.sql);
        }
    }

    @Test
    void cancelsTheOriginalStatementWhileContinueOwnsTheSessionMonitor() throws Exception {
        try (Fixture jdbc = new Fixture(); ExecutorService client = Executors.newSingleThreadExecutor()) {
            jdbc.longContinue = true;
            PlDebugSession session = jdbc.start();
            Future<Map<String, Object>> continuation = client.submit(session::resume);
            assertTrue(jdbc.continueEntered.await(2, TimeUnit.SECONDS));
            assertTimeoutPreemptively(Duration.ofSeconds(2), () -> {
                assertEquals("running", session.snapshot().get("state"));
                assertEquals(true, session.abort().get("cancelConfirmed"));
            });
            continuation.get(2, TimeUnit.SECONDS);
            assertEquals(1, jdbc.statementCancels.get());
            assertEquals(1, jdbc.targetExecutions.get(), "output cleanup must never replay the target");
            assertEquals(1, jdbc.cleanupExecutions.get());
            assertEquals(jdbc.output, session.log().get("output"));
            assertEquals("unavailable", session.snapshot().get("outParamsState"));
            session.close();
        }
    }

    @Test
    void cancellationRacingANaturalReturnDoesNotRewriteSuccessAsCancelled() throws Exception {
        try (Fixture jdbc = new Fixture(); ExecutorService client = Executors.newSingleThreadExecutor()) {
            jdbc.longContinue = true;
            jdbc.cancelCompletesNormally = true;
            PlDebugSession session = jdbc.start();
            Future<Map<String, Object>> continuation = client.submit(session::resume);
            assertTrue(jdbc.continueEntered.await(2, TimeUnit.SECONDS));
            Map<String, Object> result = session.abort();
            continuation.get(2, TimeUnit.SECONDS);
            assertEquals(false, result.get("cancelConfirmed"));
            assertEquals(true, result.get("executionStopped"));
            assertEquals("succeeded", result.get("executionOutcome"));
            assertEquals(true, result.get("targetDispatched"));
            session.close();
        }
    }

    @Test
    void aReturnedTransportErrorDoesNotProveDatabaseTerminationOrAllowDetach() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.targetFailure = new SQLRecoverableException("injected transport loss", "08006");
            PlDebugSession session = jdbc.start();
            jdbc.controlFailure = true;
            assertThrows(SQLException.class, session::resume);
            jdbc.releaseTarget.countDown();
            jdbc.targetWorker.submit(() -> {}).get(2, TimeUnit.SECONDS);
            assertEquals(true, session.snapshot().get("targetReturned"));
            assertEquals("unknown", session.snapshot().get("state"));
            assertEquals("unknown", session.snapshot().get("executionOutcome"));
            assertEquals(false, session.snapshot().get("executionStopped"));
            assertThrows(IllegalStateException.class, session::close);
            assertFalse(jdbc.events.contains("detach"));
            assertFalse(jdbc.events.contains("debugger.close"));
            assertEquals("native-id", session.snapshot().get("debugId"));
        }
    }

    @Test
    void capturedBusinessErrorIsFailureEvenWhenTheWrapperReturnsNormally() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.capturedError = -20001;
            PlDebugSession session = jdbc.start();
            Map<String, Object> result = session.resume();
            assertEquals("failed", result.get("executionOutcome"));
            assertEquals("business failure", result.get("error"));
            assertEquals(true, result.get("executionStopped"));
            assertEquals(false, session.abort().get("cancelConfirmed"));
            session.close();
        }
    }

    @Test
    void nativeInterruptCodeAlsoConfirmsCancellation() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.cancellationError = new SQLException("statement interrupted", "HY000", -5065);
            PlDebugSession session = jdbc.start();
            assertEquals(true, session.abort().get("cancelConfirmed"));
            assertEquals("cancelled", session.snapshot().get("executionOutcome"));
            session.close();
        }
    }

    @Test
    void aGenericInternalErrorIsNotACancellationReceipt() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.cancellationError = new SQLException("another internal error", "HY000", 600);
            PlDebugSession session = jdbc.start();
            Map<String, Object> result = session.abort();
            assertEquals(false, result.get("cancelConfirmed"));
            assertEquals("unknown", result.get("executionOutcome"));
            assertEquals(true, result.get("executionStopped"), "native terminated is still an independent stop receipt");
            session.close();
        }
    }

    @Test
    void keepsIdentityAndResourcesWhenRollbackFailsAndAllowsCleanupRetry() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            PlDebugSession session = jdbc.start();
            session.resume();
            jdbc.rollbackFailures.set(1);
            assertThrows(IllegalStateException.class, session::close);
            assertEquals("native-id", session.snapshot().get("debugId"));
            assertEquals("unknown", session.snapshot().get("releaseState"));
            assertEquals("unknown", session.snapshot().get("transactionOutcome"));
            assertFalse(jdbc.events.contains("detach"));
            assertFalse(jdbc.events.contains("debuggee.close"));
            session.close();
            assertEquals("released", session.snapshot().get("releaseState"));
            assertEquals(1, jdbc.targetExecutions.get());
        }
    }

    @Test
    void doesNotPollOrResumeAgainAfterANativeContinuationResponseIsLost() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            PlDebugSession session = jdbc.start();
            allowExceptionFixture(session);
            session.setExceptionBreakpoint(true);
            int startupCalls = jdbc.flags.size();
            jdbc.controlFailure = true;
            assertThrows(SQLException.class, session::resume);
            assertEquals(List.of(2050), jdbc.flags.subList(startupCalls, jdbc.flags.size()));
            assertEquals("unknown", session.snapshot().get("state"));
            assertThrows(IllegalStateException.class, session::resume);
            assertEquals(startupCalls + 1, jdbc.flags.size());
            assertEquals(1, jdbc.targetExecutions.get());
        }
    }

    @Test
    void retriesOnlyTheUnreleasedConnectionAfterPartialClose() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            PlDebugSession session = jdbc.start();
            session.resume();
            jdbc.debuggeeCloseFailures.set(1);
            assertThrows(IllegalStateException.class, session::close);
            assertEquals(true, session.snapshot().get("debuggerClosed"));
            assertEquals(false, session.snapshot().get("debuggeeClosed"));
            assertEquals("controlled_work_rolled_back", session.snapshot().get("transactionOutcome"));
            session.close();
            assertEquals("released", session.snapshot().get("releaseState"));
            assertEquals(1, Collections.frequency(jdbc.events, "detach"));
            assertEquals(1, Collections.frequency(jdbc.events, "debugger.close"));
            assertEquals(1, Collections.frequency(jdbc.events, "debuggee.rollback"));
            assertEquals(2, Collections.frequency(jdbc.events, "debuggee.close"));
        }
    }

    @Test
    void attachFailureCancelsTheOriginalTargetBeforeClosingEitherConnection() throws Exception {
        try (Fixture jdbc = new Fixture()) {
            jdbc.attachFailure = true;
            assertThrows(IllegalStateException.class, jdbc::start);
            assertEquals(1, jdbc.targetExecutions.get());
            assertEquals(1, jdbc.statementCancels.get());
            assertEquals(0, jdbc.cleanupExecutions.get(), "an unattached controller cannot drive private output cleanup");
            assertFalse(jdbc.events.contains("detach"));
            assertTrue(jdbc.events.contains("debuggee.close"));
            assertTrue(jdbc.events.contains("debugger.close"));
        }
    }

    @Test
    void exceptionRejectionDoesNotDispatchOrPreventNormalControlAndCleanup() throws Exception {
        for (String version : List.of("4.2.5.7", "unverified")) {
            try (Fixture jdbc = new Fixture()) {
                jdbc.version = version;
                PlDebugSession session = jdbc.start();
                int controls = jdbc.flags.size();
                assertThrows(com.dbx.agent.AgentRpcError.class, () -> session.setExceptionBreakpoint(true));
                assertEquals(false, session.snapshot().get("exceptionBreakpoint"));
                assertEquals(controls, jdbc.flags.size());
                assertEquals(false, session.setExceptionBreakpoint(false).get("exceptionBreakpoint"));
                assertEquals(controls, jdbc.flags.size());
                session.resumeIgnoreBreakpoints();
                session.close();
                assertEquals("released", session.snapshot().get("releaseState"));
            }
        }
    }

    static void allowExceptionFixture(PlDebugSession session) throws Exception {
        var capability = PlDebugSession.class.getDeclaredField("exceptionCapability");
        capability.setAccessible(true);
        capability.set(session, Map.of("status", "unknown", "canAttempt", true, "evidence", "test-only native path fixture"));
    }

    static final class Fixture implements AutoCloseable {
        final ExecutorService targetWorker = Executors.newSingleThreadExecutor();
        final CountDownLatch targetEntered = new CountDownLatch(1);
        final CountDownLatch continueEntered = new CountDownLatch(1);
        final CountDownLatch releaseTarget = new CountDownLatch(1);
        final List<String> sql = Collections.synchronizedList(new ArrayList<>());
        final List<String> events = Collections.synchronizedList(new ArrayList<>());
        final List<Integer> flags = Collections.synchronizedList(new ArrayList<>());
        final List<Integer> controlTimeouts = new ArrayList<>();
        final AtomicInteger targetExecutions = new AtomicInteger();
        volatile int networkTimeout;
        boolean failTimeoutRestore;
        boolean failTimeoutDisable;
        boolean failPrivateTimeoutDisable;
        boolean failPrivateTimeoutRestore;
        int timeoutDisables;
        int timeoutRestores;
        final CountDownLatch timeoutDisableFailed = new CountDownLatch(1);
        java.util.function.Consumer<PlDebugSession> initialized = session -> {};
        boolean holdTimeoutRestore;
        final CountDownLatch timeoutRestoreEntered = new CountDownLatch(1);
        final CountDownLatch allowTimeoutRestore = new CountDownLatch(1);
        final CountDownLatch timeoutRestoreCompleted = new CountDownLatch(1);
        final AtomicInteger cleanupExecutions = new AtomicInteger();
        boolean holdCleanup;
        final CountDownLatch cleanupEntered = new CountDownLatch(1);
        final CountDownLatch allowCleanup = new CountDownLatch(1);
        final List<Integer> cleanupNetworkTimeouts = new ArrayList<>();
        final List<Integer> cleanupQueryTimeouts = new ArrayList<>();
        final AtomicInteger statementCancels = new AtomicInteger();
        final AtomicInteger outputTransfers = new AtomicInteger();
        final AtomicInteger setValueExecutions = new AtomicInteger();
        final List<String> assignments = Collections.synchronizedList(new ArrayList<>());
        final CountDownLatch setValueEntered = new CountDownLatch(1);
        final CountDownLatch setValueRelease = new CountDownLatch(1);
        boolean setValueSupported;
        boolean holdSetValue;
        boolean setValueNull;
        int setValueResult;
        SQLException setValueFailure;
        final AtomicInteger rollbackFailures = new AtomicInteger();
        final AtomicInteger debuggeeCloseFailures = new AtomicInteger();
        volatile boolean cancelled;
        volatile boolean controllerClosed;
        boolean controllerStateFailure;
        int nativeTimeoutResult = 120;
        int nativeTimeoutBehaviour;
        volatile boolean longContinue;
        volatile boolean controlFailure;
        volatile boolean attachFailure;
        volatile boolean cancelCompletesNormally;
        boolean rejectSysSqlFunctions;
        volatile SQLException targetFailure;
        SQLException cancellationError = new SQLException("ORA-00600: internal error code, arguments: -5065, Query execution was interrupted", "70100", 600);
        int capturedError;
        int initialLine = 2;
        int rootLine = 2;
        int rootSteps;
        int privateCaptureStops;
        boolean rootBootstrapComplete;
        String rootTokenName;
        String rootToken;
        boolean wrongRootToken;
        String version = "4.2.5.7";
        SQLException versionFailure;
        String output = "before-cancel\n\n";
        final PlDebugBreakpointRegistryTest.Server nativeBreakpoints = new PlDebugBreakpointRegistryTest.Server();

        PlDebugSession start() throws Exception {
            return start(connection(true));
        }

        PlDebugSession start(Connection debuggee) throws Exception {
            PlDebugStartRequest request = new PlDebugStartRequest();
            request.setSchema("SCOTT");
            request.setObjectType("ANONYMOUS");
            request.setSource("BEGIN\n  NULL;\nEND;");
            return PlDebugSession.start(debuggee, connection(false), request, targetWorker, 600000, initialized);
        }

        Connection connection(boolean debuggee) {
            String role = debuggee ? "debuggee" : "debugger";
            return proxy(Connection.class, (method, args) -> {
                switch (method.getName()) {
                    case "isClosed":
                        if (!debuggee && controllerStateFailure) throw new SQLException("controller physical state unavailable");
                        return !debuggee && controllerClosed;
                    case "getNetworkTimeout": return debuggee ? networkTimeout : 120000;
                    case "setNetworkTimeout":
                        assertTrue(debuggee, "controller timeout must remain unchanged");
                        if ((int) args[1] == 0 && ++timeoutDisables == 2 && failPrivateTimeoutDisable) throw new SQLException("private disable acknowledgement lost");
                        if ((int) args[1] != 0 && ++timeoutRestores == 2 && failPrivateTimeoutRestore) throw new SQLException("private restore acknowledgement lost");
                        if ((int) args[1] == 0 && failTimeoutDisable) {
                            timeoutDisableFailed.countDown();
                            throw new SQLException("disable acknowledgement lost");
                        }
                        if ((int) args[1] != 0 && holdTimeoutRestore) {
                            timeoutRestoreEntered.countDown();
                            assertTrue(allowTimeoutRestore.await(5, TimeUnit.SECONDS));
                        }
                        if ((int) args[1] != 0 && failTimeoutRestore) throw new SQLException("restore acknowledgement lost");
                        networkTimeout = (int) args[1]; events.add("timeout." + networkTimeout);
                        if (networkTimeout != 0) timeoutRestoreCompleted.countDown();
                        return null;
                    case "setAutoCommit": assertEquals(false, args[0]); return null;
                    case "commit": fail("The debugger must never auto-commit the target"); return null;
                    case "rollback":
                        events.add(role + ".rollback");
                        if (rollbackFailures.getAndUpdate(n -> Math.max(0, n - 1)) > 0) throw new SQLException("injected rollback loss");
                        return null;
                    case "close":
                        events.add(role + ".close");
                        if (debuggee && debuggeeCloseFailures.getAndUpdate(n -> Math.max(0, n - 1)) > 0) {
                            throw new SQLException("injected close failure");
                        }
                        return null;
                    case "createStatement":
                        return proxy(Statement.class, (member, values) -> {
                            if (member.getName().equals("execute")) {
                                String statement = (String) values[0]; sql.add(statement);
                                if (statement.contains("DETACH_SESSION")) events.add("detach");
                                return false;
                            }
                            return empty(member.getReturnType());
                        });
                    case "prepareStatement": return scalar((String) args[0]);
                    case "getMetaData": return proxy(java.sql.DatabaseMetaData.class, (member, values) ->
                        member.getName().equals("getDatabaseProductVersion") ? version : empty(member.getReturnType()));
                    case "prepareCall": return call((String) args[0], debuggee);
                    default: return empty(method.getReturnType());
                }
            });
        }

        PreparedStatement scalar(String statement) {
            sql.add(statement);
            return proxy(PreparedStatement.class, (method, args) -> {
                if (!method.getName().equals("executeQuery")) return empty(method.getReturnType());
                if (statement.contains("OB_VERSION()") && versionFailure != null) throw versionFailure;
                if (rejectSysSqlFunctions && statement.startsWith("SELECT SYS.DBMS_DEBUG.")) {
                    throw new SQLException("table or view does not exist", "42S02", 942);
                }
                AtomicInteger row = new AtomicInteger();
                return proxy(ResultSet.class, (member, values) -> switch (member.getName()) {
                    case "next" -> row.getAndIncrement() < (statement.contains("ALL_PROCEDURES") && setValueSupported ? 2 : 1);
                    case "getString" -> statement.contains("OB_VERSION()") ? version : statement.contains("ALL_PROCEDURES") ? row.get() == 1 ? "INITIALIZE" : "SET_VALUE" : statement.contains("INITIALIZE") ? "native-id" : "120";
                    default -> empty(member.getReturnType());
                });
            });
        }

        CallableStatement call(String statement, boolean debuggee) {
            sql.add(statement);
            if (!debuggee && (statement.contains("SHOW_BREAKPOINTS") || statement.contains("set_breakpoint(")
                || statement.contains("enable_breakpoint(") || statement.contains("disable_breakpoint(") || statement.contains("delete_breakpoint("))) {
                try { return nativeBreakpoints.connection().prepareCall(statement); }
                catch (SQLException error) { throw new AssertionError(error); }
            }
            if (!debuggee && statement.contains("SYS.DBMS_DEBUG.GET_RUNTIME_INFO(8, r)")) {
                return proxy(CallableStatement.class, (method, args) -> switch (method.getName()) {
                    case "getInt" -> (int) args[0] == 4 ? 1 : 0;
                    case "getString" -> (int) args[0] == 2 ? "SCOTT" : "__anonymous_block__";
                    default -> empty(method.getReturnType());
                });
            }
            boolean target = debuggee && statement.contains("SAVEPOINT DBX_PD_");
            if (target) {
                var marker = java.util.regex.Pattern.compile("(DBX_[A-Z0-9]+_ROOT_TOKEN) CONSTANT VARCHAR2\\(32\\) := '([^']+)'").matcher(statement);
                if (marker.find()) { rootTokenName = marker.group(1); rootToken = marker.group(2); }
            }
            boolean cleanup = debuggee && !target && statement.contains("SYS.DBMS_OUTPUT.GET_LINE");
            boolean control = !debuggee && (statement.contains("SYS.DBMS_DEBUG.continue(") || statement.contains("SYS.DBMS_DEBUG.synchronize("));
            boolean synchronize = control && statement.contains("synchronize(r");
            boolean assignment = statement.contains("SYS.DBMS_DEBUG.SET_VALUE");
            boolean markerRead = statement.contains("SYS.DBMS_DEBUG.get_value(");
            boolean[] navigating = {false};
            boolean[] capturing = {false};
            Map<Integer, Object> bindings = new LinkedHashMap<>();
            int[] queryTimeout = {0};
            return proxy(CallableStatement.class, (method, args) -> {
                switch (method.getName()) {
                    case "close": if (target) events.add("target.close"); if (cleanup) events.add("cleanup.close"); return null;
                    case "setQueryTimeout": queryTimeout[0] = (int) args[0]; if (control) controlTimeouts.add((int) args[0]); return null;
                    case "setInt", "setString": bindings.put((int) args[0], args[1]); return null;
                    case "cancel":
                        statementCancels.incrementAndGet(); cancelled = true; releaseTarget.countDown(); return null;
                    case "execute":
                        if (assignment) {
                            setValueExecutions.incrementAndGet();
                            assignments.add(bindings.get(2) + ":" + bindings.get(3));
                            setValueEntered.countDown();
                            if (holdSetValue) assertTrue(setValueRelease.await(3, TimeUnit.SECONDS));
                            if (setValueFailure != null) throw setValueFailure;
                        }
                        if (!debuggee && attachFailure && statement.contains("ATTACH_SESSION")) {
                            throw new SQLException("injected attach rejection");
                        }
                        if (target) {
                            targetExecutions.incrementAndGet(); targetEntered.countDown();
                            if (!releaseTarget.await(5, TimeUnit.SECONDS)) throw new SQLException("test target deadline");
                            if (cancelled && !cancelCompletesNormally) throw cancellationError;
                            if (targetFailure != null) throw targetFailure;
                        } else if (cleanup) {
                            cleanupNetworkTimeouts.add(networkTimeout);
                            cleanupQueryTimeouts.add(queryTimeout[0]);
                            cleanupExecutions.incrementAndGet();
                            cleanupEntered.countDown();
                            if (holdCleanup) assertTrue(allowCleanup.await(5, TimeUnit.SECONDS));
                        } else if (control) {
                            if (synchronize) {
                                if (failTimeoutDisable) {
                                    assertTrue(timeoutDisableFailed.await(2, TimeUnit.SECONDS));
                                    throw new SQLException("no target dispatched after timeout configuration failure");
                                }
                                assertTrue(targetEntered.await(2, TimeUnit.SECONDS));
                            } else {
                                int flag = (int) bindings.get(1); flags.add(flag);
                                if (rootBootstrapComplete || flag != PlDebugNative.STEP_IN) continueEntered.countDown();
                                if (controlFailure) throw new SQLException("injected response loss");
                                if (!rootBootstrapComplete && flag == PlDebugNative.STEP_IN) {
                                    rootSteps++;
                                    rootLine = rootSteps;
                                    rootBootstrapComplete = rootLine >= 13;
                                    navigating[0] = true;
                                } else if (flag == PlDebugNative.STEP_OVER) { }
                                else if (privateCaptureStops > 0) { privateCaptureStops--; capturing[0] = true; }
                                else if (flag == PlDebugNative.ABORT) { cancelled = true; releaseTarget.countDown(); }
                                else if (longContinue) assertTrue(releaseTarget.await(5, TimeUnit.SECONDS));
                                else releaseTarget.countDown();
                            }
                        }
                        return false;
                    case "getClob":
                        if (statement.contains("print_backtrace(frames)")) return new SerialClob("[]".toCharArray());
                        if (target) events.add("target.output");
                        outputTransfers.incrementAndGet(); return new SerialClob(output.toCharArray());
                    case "getString":
                        if (statement.contains("SYS.DBMS_DEBUG.INITIALIZE()")) return "native-id";
                        if (control) return (int) args[0] == (synchronize ? 7 : 8) ? "__anonymous_block__" : "SCOTT";
                        if (markerRead && rootTokenName != null && rootTokenName.equals(bindings.get(1))) {
                            return new com.google.gson.Gson().toJson(rootSteps < 3 ? "Null" : "'" + (wrongRootToken ? "wrong" : rootToken) + "'");
                        }
                        if (target && (int) args[0] == 2 && capturedError != 0) return "business failure";
                        return null;
                    case "getInt":
                        if (statement.contains("SYS.DBMS_DEBUG.SET_TIMEOUT(?)")) return nativeTimeoutResult;
                        if (statement.contains("SYS.DBMS_DEBUG.GET_TIMEOUT_BEHAVIOUR()")) return nativeTimeoutBehaviour;
                        if (assignment) return setValueResult;
                        int index = (int) args[0];
                        if (target || cleanup) return index == 3 ? -1 : target && index == 1 ? capturedError : 0;
                        if (control) {
                            int field = index - (synchronize ? 0 : 1);
                            return switch (field) {
                                case 1 -> 0;
                                case 2 -> synchronize ? initialLine : navigating[0] ? rootLine : capturing[0] ? 16 : 13;
                                case 3 -> synchronize || navigating[0] || capturing[0] || (int) bindings.get(1) == PlDebugNative.STEP_OVER ? 0 : 1;
                                case 4 -> synchronize ? 2 : navigating[0] || capturing[0] || (int) bindings.get(1) == PlDebugNative.STEP_OVER ? 9 : 15;
                                case 5 -> 1;
                                case 9 -> 1;
                                default -> 0;
                            };
                        }
                        return 0;
                    case "wasNull": return assignment && setValueNull;
                    default: return empty(method.getReturnType());
                }
            });
        }

        public void close() throws Exception {
            cancelled = true;
            releaseTarget.countDown();
            targetWorker.shutdownNow();
            assertTrue(targetWorker.awaitTermination(2, TimeUnit.SECONDS));
        }
    }
}
