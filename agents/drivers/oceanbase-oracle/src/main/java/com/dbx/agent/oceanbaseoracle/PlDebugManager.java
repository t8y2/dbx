package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.PlDebugBreakpoint;
import com.dbx.agent.PlDebugStartRequest;
import com.dbx.agent.AgentRpcError;
import com.dbx.agent.AbstractJdbcAgent.DedicatedConnectionOwner;
import com.google.gson.Gson;
import com.google.gson.JsonElement;

import java.sql.Connection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

/** Agent-local lifetime of a debugger; access ownership is enforced by Core. */
final class PlDebugManager {
    // Core gives each debugger its own runtime. Retain a bounded number of start
    // receipts instead of evicting an old id and accidentally running it again.
    static final int MAX_STARTS = 8;
    private static final long CLIENT_LEASE_MILLIS = 120_000;
    private static final Gson JSON = new Gson();
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final ProfiledOwnerFactory owners;
    private final Object admission;
    private final BooleanSupplier compilationBusy;

    @FunctionalInterface
    interface ConnectionFactory {
        Connection open() throws Exception;
    }

    @FunctionalInterface
    interface OwnerFactory {
        DedicatedConnectionOwner register(Runnable onRetire, Runnable onCompletion);
    }

    @FunctionalInterface
    interface ProfiledOwnerFactory {
        DedicatedConnectionOwner register(PlDebugStartRequest request, Runnable onRetire, Runnable onCompletion);
    }

    @FunctionalInterface
    interface SessionCall<T> {
        T call(PlDebugSession session) throws Exception;
    }

    static final class UntrackedConnectionException extends Exception {
        UntrackedConnectionException(Throwable cause) {
            super("A startup connection was not returned and its physical release is unconfirmed", cause);
        }
    }

    PlDebugManager(ConnectionFactory connections) {
        this(connections, new Object(), () -> false);
    }

    PlDebugManager(ConnectionFactory connections, Object admission, BooleanSupplier compilationBusy) {
        // Scripted JDBC tests retain the same ownership contract; a deliberately
        // unreturned connection remains unknown rather than being marked released.
        this((onRetire, onCompletion) -> new DedicatedConnectionOwner() {
            private boolean unknown;
            @Override public Connection open() throws Exception {
                try { return connections.open(); }
                catch (UntrackedConnectionException error) { unknown = true; throw error; }
            }
            @Override public boolean resourcesReleased() { return !unknown; }
            @Override public void close() { }
        }, admission, compilationBusy);
    }

    PlDebugManager(OwnerFactory owners) {
        this((request, onRetire, onCompletion) -> owners.register(onRetire, onCompletion));
    }

    PlDebugManager(OwnerFactory owners, Object admission, BooleanSupplier compilationBusy) {
        this((request, onRetire, onCompletion) -> owners.register(onRetire, onCompletion), admission, compilationBusy);
    }

    PlDebugManager(ProfiledOwnerFactory owners) {
        this(owners, new Object(), () -> false);
    }

    PlDebugManager(ProfiledOwnerFactory owners, Object admission, BooleanSupplier compilationBusy) {
        this.owners = owners;
        this.admission = admission;
        this.compilationBusy = compilationBusy;
    }

    boolean hasUnreleased() {
        synchronized (entries) { return entries.values().stream().anyMatch(item -> !item.released()); }
    }

    Map<String, Object> start(PlDebugStartRequest input) throws Exception {
        if (input == null || input.getOperationId() == null
            || !input.getOperationId().matches("[A-Za-z0-9_-]{1,128}")) {
            throw new IllegalArgumentException("A stable start operationId is required");
        }
        // Freeze values before registration: callers cannot mutate the request
        // behind its receipt, including its parameter list.
        JsonElement content = JSON.toJsonTree(input);
        var frozenParams = content.getAsJsonObject().getAsJsonArray("params");
        if (frozenParams != null) {
            for (int index = 0; index < input.getParams().size(); index++) {
                var parameter = input.getParams().get(index);
                if (parameter != null && parameter.getTypedValue() != null) frozenParams.get(index).getAsJsonObject().add("typedValue", parameter.getTypedValue().deepCopy());
            }
        }
        PlDebugStartRequest request = JSON.fromJson(content, PlDebugStartRequest.class);
        Entry entry;
        synchronized (admission) { synchronized (entries) {
            Entry existing = entries.get(request.getOperationId());
            if (existing != null) {
                if (!existing.content.equals(content)) {
                    throw new IllegalArgumentException("The start operationId already belongs to a different request");
                }
                return existing.snapshot();
            }
            if (entries.values().stream().anyMatch(item -> !item.released())) {
                throw new IllegalStateException("The previous debugger must be released before starting another target");
            }
            if (compilationBusy.getAsBoolean()) throw new IllegalStateException("The original debug compilation must be resolved and released before starting a target");
            if (entries.size() >= MAX_STARTS) {
                throw new IllegalStateException("This debugger runtime's start receipts are full; use a new dedicated runtime");
            }
            entry = new Entry(request, content);
            entries.put(entry.id, entry);
        } }

        // Intent is queryable before either connection, INITIALIZE, or target SQL.
        try {
            entry.owner = owners.register(request, entry::requestShutdown, entry::resourceCompleted);
            entry.checkCancellation();
            entry.debuggee = entry.owner.open();
            entry.checkCancellation();
            entry.debugger = entry.owner.open();
            entry.checkCancellation();
            PlDebugSession.start(entry.debuggee, entry.debugger, request, entry.worker, CLIENT_LEASE_MILLIS,
                session -> {
                    entry.session = session;
                    session.setCompletionListener(entry::notifyCompletion);
                    if (entry.cancelRequested.get()) session.requestAbort();
                });
            entry.startState = "succeeded";
        } catch (Exception error) {
            entry.untrackedConnection = error instanceof UntrackedConnectionException
                || entry.owner != null && !entry.owner.resourcesReleased();
            entry.startError = error.getMessage();
            entry.startState = "failed";
            // Once initialized, the session owns cleanup and keeps every partial
            // fact. Otherwise no business target has been dispatched.
            if (entry.session == null) {
                try { entry.closeUninitialized(); }
                catch (Exception cleanupError) { error.addSuppressed(cleanupError); }
            }
            throw error;
        } finally {
            entry.startDone.complete(null);
            entry.notifyCompletion();
            entry.finishIfReleased();
        }
        return entry.snapshot();
    }

    Map<String, Object> status(String id) {
        return find(id).snapshot();
    }

    Map<String, Object> results(String id) {
        Entry entry = find(id);
        return entry.decorate(new LinkedHashMap<>(entry.session == null
            ? Map.of("results", List.of(), "collectionState", entry.startDone.isDone() ? "unavailable" : "pending")
            : entry.session.results()));
    }

    Map<String, Object> resultPage(String id, String generation, String resultId, int offset, int limit) {
        Entry entry = find(id);
        if (entry.session == null) throw new IllegalArgumentException("No retained debugger result has been published");
        return entry.decorate(new LinkedHashMap<>(entry.session.resultPage(generation, resultId, offset, limit)));
    }

    Map<String, Object> heartbeat(String id) {
        Entry entry = find(id);
        if (entry.session != null) entry.session.heartbeat();
        return entry.snapshot();
    }

    Map<String, Object> log(String id) {
        Entry entry = find(id);
        return entry.session == null ? entry.snapshot() : entry.decorate(entry.session.log());
    }

    Map<String, Object> log(String id, int offset, int limit) {
        Entry entry = find(id);
        return entry.session == null ? entry.snapshot() : entry.decorate(entry.session.log(offset, limit));
    }

    Map<String, Object> map(String id, SessionCall<Map<String, Object>> action) throws Exception {
        Entry entry = find(id);
        return entry.decorate(call(entry, action));
    }

    Map<String, Object> setValue(String id, String operationId, Long stopRevision, String name,
                                 int frame, int index, String value) throws Exception {
        if (operationId == null || !operationId.matches("[A-Za-z0-9_-]{1,128}") || stopRevision == null
            || name == null || name.trim().isEmpty() || value == null || frame < 0 || index < 0) {
            throw AgentRpcError.requestRejected("A stable assignment operationId, stopRevision, name, value and valid frame/index are required");
        }
        Entry entry = find(id);
        JsonElement frozen = JSON.toJsonTree(Map.of("operationId", operationId, "stopRevision", stopRevision,
            "name", name, "frame", frame, "index", index, "value", value));
        return mutate(entry, operationId, "set_value", frozen, stopRevision,
            receipt -> entry.session.setValue(name, frame, index, value,
                stopRevision, () -> receipt.dispatched = true));
    }

    private Map<String, Object> mutate(Entry entry, String operationId, String action,
                                       JsonElement frozen, long stopRevision,
                                       MutationCall mutation) throws Exception {
        MutationOperation operation;
        boolean original;
        synchronized (entry.actionLock) {
            operation = entry.operations.get(operationId);
            original = operation == null;
            if (!original && (!operation.action.equals(action) || !operation.frozen.equals(frozen))) {
                throw AgentRpcError.requestRejected("The operationId belongs to a different request");
            }
            if (original) {
                if (entry.operations.size() >= 256) throw AgentRpcError.requestRejected("Mutation receipts are full");
                operation = new MutationOperation(action, frozen, stopRevision);
                entry.operations.put(operationId, operation);
            }
        }
        if (!original) return operation.done.join();
        MutationOperation receipt = operation;
        try {
            Map<String, Object> result = call(entry, session -> mutation.call(receipt));
            result.put("operationId", operationId);
            result.put("stopRevision", stopRevision);
            result = entry.decorate(result);
            receipt.result = result;
            receipt.state = Boolean.TRUE.equals(result.get("ok")) ? "succeeded" : "failed";
            receipt.done.complete(result);
            return result;
        } catch (Throwable error) {
            boolean rejected = !receipt.dispatched && !receipt.changed && error instanceof Exception;
            Throwable failure = rejected
                ? AgentRpcError.requestRejected(error.getMessage() == null ? "Mutation was rejected before dispatch" : error.getMessage())
                : (receipt.changed || receipt.dispatched) && error instanceof AgentRpcError
                    ? new IllegalStateException("The breakpoint batch partially changed before a later item failed: " + error.getMessage())
                    : error;
            receipt.state = receipt.dispatched || receipt.changed ? "unknown" : "failed";
            receipt.error = failure.getMessage();
            if (rejected) receipt.rejection = Map.of("contractVersion", 1, "category", "protocol", "retryable", false,
                "sessionDisposition", "keep", "stage", "request", "operationOutcome", "not_started", "message", receipt.error);
            receipt.done.completeExceptionally(failure);
            if (failure instanceof Error fatal) throw fatal;
            throw (Exception) failure;
        }
    }

    Map<String, Object> mutateBreakpoint(String id, String action, com.dbx.agent.PlDebugBreakpointMutation request) throws Exception {
        if (request == null || request.operationId() == null || !request.operationId().matches("[A-Za-z0-9_-]{1,128}")
            || request.stopRevision() == null || request.stopRevision() <= 0
            || !List.of("set_breakpoints", "delete_breakpoints", "set_breakpoint_enabled").contains(action)) {
            throw AgentRpcError.requestRejected("A stable operationId, action and stopRevision are required");
        }
        Entry entry = find(id);
        JsonElement frozen = JSON.toJsonTree(request);
        return mutate(entry, request.operationId(), action, frozen, request.stopRevision(), receipt ->
            entry.session.mutateBreakpoint(action, JSON.fromJson(frozen, com.dbx.agent.PlDebugBreakpointMutation.class), () -> {
                entry.session.requireBreakpointStop(request.stopRevision());
                receipt.dispatched = true;
            }, () -> receipt.changed = true));
    }

    Map<String, Object> changeBreakpoints(String id, String operationId, Long stopRevision,
                                          List<PlDebugBreakpoint> breakpoints, boolean delete) throws Exception {
        if (operationId == null || !operationId.matches("[A-Za-z0-9_-]{1,128}") || breakpoints == null) {
            throw AgentRpcError.requestRejected("A stable breakpoint operationId and breakpoint array are required");
        }
        Entry entry = find(id);
        Map<String, Object> content = new LinkedHashMap<>();
        content.put("stopRevision", stopRevision);
        content.put("breakpoints", breakpoints);
        JsonElement frozen = JSON.toJsonTree(content);
        long revision = stopRevision == null ? entry.session == null ? 0 : entry.session.breakpointStopRevision() : stopRevision;
        return mutate(entry, operationId, delete ? "delete_breakpoints" : "set_breakpoints", frozen, revision, receipt -> {
            entry.session.requireBreakpointStop(revision);
            List<PlDebugBreakpoint> items = java.util.Arrays.asList(JSON.fromJson(
                frozen.getAsJsonObject().get("breakpoints"), PlDebugBreakpoint[].class));
            List<Map<String, Object>> outcomes = new ArrayList<>();
            List<Object> changed = new ArrayList<>();
            for (int index = 0; index < items.size(); index++) {
                boolean[] dispatched = {false};
                Runnable beforeDispatch = () -> {
                    entry.session.requireBreakpointStop(revision);
                    dispatched[0] = true;
                    receipt.dispatched = true;
                };
                try {
                    List<PlDebugBreakpoint> item = java.util.Collections.singletonList(items.get(index));
                    Map<String, Object> result = delete ? entry.session.deleteBreakpoints(item, beforeDispatch)
                        : entry.session.setBreakpoints(item, beforeDispatch);
                    receipt.changed |= Boolean.TRUE.equals(result.get("changed"));
                    outcomes.add(Map.of("index", index, "state", "succeeded", "result", result));
                    if (result.get("breakpoints") instanceof List<?> values) changed.addAll(values);
                } catch (Exception error) {
                    outcomes.add(Map.of("index", index, "state", dispatched[0] ? "unknown" : "failed",
                        "message", error.getMessage() == null ? "Breakpoint operation failed" : error.getMessage()));
                    for (int tail = index + 1; tail < items.size(); tail++) {
                        outcomes.add(Map.of("index", tail, "state", "not_started"));
                    }
                    receipt.result = Map.of("ok", false, "operationId", operationId, "stopRevision", revision,
                        "items", List.copyOf(outcomes), "breakpoints", List.copyOf(changed));
                    throw error;
                }
            }
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("ok", true);
            result.put("result", 0);
            result.put("breakpoints", List.copyOf(changed));
            result.put("items", List.copyOf(outcomes));
            return result;
        });
    }

    Map<String, Object> setBreakpointEnabled(String id, String operationId, Long stopRevision,
                                             int breakpoint, boolean enabled) throws Exception {
        if (operationId == null || !operationId.matches("[A-Za-z0-9_-]{1,128}")) {
            throw AgentRpcError.requestRejected("A stable breakpoint operationId is required");
        }
        Entry entry = find(id);
        Map<String, Object> content = new LinkedHashMap<>();
        content.put("stopRevision", stopRevision);
        content.put("breakpointNumber", breakpoint);
        content.put("enabled", enabled);
        JsonElement frozen = JSON.toJsonTree(content);
        long revision = stopRevision == null ? entry.session == null ? 0 : entry.session.breakpointStopRevision() : stopRevision;
        return mutate(entry, operationId, "set_breakpoint_enabled", frozen, revision, receipt -> {
            entry.session.requireBreakpointStop(revision);
            return entry.session.setBreakpointEnabled(breakpoint, enabled, () -> {
                entry.session.requireBreakpointStop(revision);
                receipt.dispatched = true;
            });
        });
    }

    Map<String, Object> operationStatus(String id, String operationId) {
        Entry entry = find(id);
        synchronized (entry.actionLock) {
            MutationOperation operation = entry.operations.get(operationId);
            if (operation == null) throw new IllegalArgumentException("The original operation is not available");
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("operationId", operationId);
            result.put("action", operation.action);
            result.put("state", operation.state);
            result.put("stopRevision", operation.stopRevision);
            result.put("result", operation.result);
            result.put("message", operation.error);
            result.put("error", operation.rejection);
            return result;
        }
    }

    private interface MutationCall {
        Map<String, Object> call(MutationOperation receipt) throws Exception;
    }

    private static final class MutationOperation {
        final String action;
        final JsonElement frozen;
        final long stopRevision;
        final CompletableFuture<Map<String, Object>> done = new CompletableFuture<>();
        volatile boolean dispatched;
        volatile boolean changed;
        volatile Map<String, Object> rejection;
        volatile String state = "running";
        volatile String error;
        volatile Map<String, Object> result;

        MutationOperation(String action, JsonElement frozen, long stopRevision) {
            this.action = action;
            this.frozen = frozen;
            this.stopRevision = stopRevision;
        }
    }

    List<PlDebugBreakpoint> breakpoints(String id) throws Exception {
        return call(find(id), PlDebugSession::listBreakpoints);
    }

    private <T> T call(Entry entry, SessionCall<T> action) throws Exception {
        synchronized (entry.actionLock) {
            if (!"succeeded".equals(entry.startState) || !entry.startDone.isDone()) {
                throw new IllegalStateException("PL debug start has not completed successfully; inspect its status");
            }
            if (entry.cancelRequested.get() || entry.cleanupRunning.get()) {
                throw new IllegalStateException("This target has a pending stop or cleanup request");
            }
            if (entry.actionRunning) throw new IllegalStateException("A debug operation is already running");
            if (entry.operations.values().stream().anyMatch(operation -> "unknown".equals(operation.state))) {
                throw new IllegalStateException("The original mutation result is unknown; inspect or close the original session");
            }
            entry.actionDone = new CompletableFuture<>();
            entry.actionRunning = true;
        }
        try {
            return action.call(entry.session);
        } finally {
            synchronized (entry.actionLock) {
                entry.actionRunning = false;
                entry.actionDone.complete(null);
            }
            entry.notifyCompletion();
        }
    }

    Map<String, Object> abort(String id) throws Exception {
        Entry entry = find(id);
        boolean busy;
        synchronized (entry.actionLock) {
            entry.cancelRequested.set(true);
            busy = entry.actionRunning || !entry.startDone.isDone();
        }
        PlDebugSession session = entry.session;
        if (session != null) {
            if (busy) session.abortByStatement();
            else session.abort();
        }
        return entry.snapshot();
    }

    boolean close(String id) throws Exception {
        Entry entry = find(id);
        synchronized (entry.lifecycleLock) { entry.shutdownRequested = true; }
        try { return close(entry, false); }
        finally { entry.finishIfReleased(); }
    }

    private boolean close(Entry entry, boolean lifecyclePass) throws Exception {
        if (entry.released()) return true;
        if (!entry.cleanupRunning.compareAndSet(false, true)) {
            if (lifecyclePass) entry.cleanupWaiter.set(true);
            return false;
        }
        try {
            abort(entry.id);
            // Startup still owns connection creation and will observe the stop
            // latch. Do not race its SQL or claim that pending allocation closed.
            if (!entry.startDone.isDone()) return false;
            entry.actionDone.get(PlDebugNative.CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (entry.session != null) entry.session.close();
            else entry.closeUninitialized();
            entry.cleanupError = null;
            return entry.released();
        } catch (Exception error) {
            entry.cleanupError = error.getMessage();
            throw error;
        } finally {
            entry.cleanupRunning.set(false);
            if (!lifecyclePass) {
                if (entry.cleanupWaiter.getAndSet(false)) entry.notifyCompletion();
                entry.finishIfReleased();
            }
        }
    }

    void closeAll() throws Exception {
        List<Entry> current;
        synchronized (entries) { current = List.copyOf(entries.values()); }
        Exception failure = null;
        for (Entry entry : current) {
            if (entry.released()) {
                entry.finishIfReleased();
                continue;
            }
            entry.requestShutdown();
            try {
                if (!close(entry.id)) throw new IllegalStateException("A debug start or cleanup is still pending");
            } catch (Exception error) {
                if (failure == null) failure = error;
                else failure.addSuppressed(error);
            }
        }
        if (failure != null) throw failure;
    }

    private Entry find(String id) {
        synchronized (entries) {
            Entry entry = entries.get(id);
            if (entry == null) throw new IllegalArgumentException("No debugger with this start identity exists in this runtime");
            return entry;
        }
    }

    private final class Entry {
        final String id;
        final JsonElement content;
        final PlDebugStartRequest request;
        final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "dbx-pl-debug-target");
            thread.setDaemon(true);
            return thread;
        });
        final Object actionLock = new Object();
        final Map<String, MutationOperation> operations = new LinkedHashMap<>();
        final AtomicBoolean cancelRequested = new AtomicBoolean();
        final AtomicBoolean cleanupRunning = new AtomicBoolean();
        final AtomicBoolean cleanupWaiter = new AtomicBoolean();
        final Object lifecycleLock = new Object();
        ExecutorService lifecycle;
        boolean shutdownRequested;
        boolean continuationPending;
        boolean continuationScheduled;
        boolean sealed;
        final CompletableFuture<Void> startDone = new CompletableFuture<>();
        volatile CompletableFuture<Void> actionDone = CompletableFuture.completedFuture(null);
        volatile boolean actionRunning;
        volatile PlDebugSession session;
        volatile DedicatedConnectionOwner owner;
        volatile Connection debuggee;
        volatile Connection debugger;
        volatile boolean debuggeeClosed;
        volatile boolean debuggerClosed;
        volatile boolean untrackedConnection;
        volatile String cleanupError;
        volatile String startState = "running";
        volatile String startError;

        Entry(PlDebugStartRequest request, JsonElement content) {
            this.request = request;
            this.id = request.getOperationId();
            this.content = content;
        }

        void checkCancellation() {
            if (cancelRequested.get()) throw new CancellationException("PL debug start was cancelled before dispatch");
        }

        void closeUninitialized() throws Exception {
            Exception failure = null;
            if (debugger != null && !debuggerClosed) {
                try { debugger.close(); debuggerClosed = true; }
                catch (Exception error) { failure = error; }
            }
            if (debuggee != null && !debuggeeClosed) {
                try { debuggee.close(); debuggeeClosed = true; }
                catch (Exception error) {
                    if (failure == null) failure = error;
                    else failure.addSuppressed(error);
                }
            }
            if (owner != null) {
                try { owner.closeUnreturnedConnections(); }
                catch (Exception error) {
                    if (failure == null) failure = error;
                    else failure.addSuppressed(error);
                }
            }
            cleanupError = failure == null ? null : "Startup connection cleanup could not be confirmed";
            if (failure != null) throw failure;
        }

        boolean released() {
            if (!startDone.isDone()) return false;
            if (owner != null && !owner.resourcesReleased()) return false;
            PlDebugSession current = session;
            if (current != null) return Objects.equals("released", current.snapshot().get("releaseState"));
            return (debuggee == null || debuggeeClosed)
                && (debugger == null || debuggerClosed) && cleanupError == null;
        }

        void requestShutdown() {
            synchronized (lifecycleLock) {
                shutdownRequested = true;
                cancelRequested.set(true);
            }
            notifyCompletion();
        }

        void notifyCompletion() {
            synchronized (lifecycleLock) {
                if (!shutdownRequested || sealed) return;
                continuationPending = true;
                if (continuationScheduled) return;
                scheduleCleanup();
            }
        }

        void resourceCompleted() {
            notifyCompletion();
            finishIfReleased();
        }

        private void scheduleCleanup() {
            if (lifecycle == null) {
                lifecycle = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                    new ArrayBlockingQueue<>(1), runnable -> {
                        Thread thread = new Thread(runnable, "dbx-pl-debug-lifecycle");
                        thread.setDaemon(true);
                        return thread;
                    });
            }
            continuationScheduled = true;
            CompletableFuture.supplyAsync(this::cleanupPass, lifecycle).thenAccept(terminal -> {
                // The cleanup body and its final state writes have completed.
                // Releasing the owner before this point could let main exit early.
                if (terminal && owner != null) owner.close();
            });
        }

        private boolean cleanupPass() {
            synchronized (lifecycleLock) { continuationPending = false; }
            try { PlDebugManager.this.close(this, true); }
            catch (Exception ignored) { /* Original receipt retains the failed cleanup facts. */ }
            synchronized (lifecycleLock) {
                continuationScheduled = false;
                if (released()) {
                    sealed = true;
                    worker.shutdown();
                    lifecycle.shutdown();
                    return true;
                }
                if (continuationPending) scheduleCleanup();
                return false;
            }
        }

        void finishIfReleased() {
            synchronized (lifecycleLock) {
                if (sealed || continuationScheduled || cleanupRunning.get() || !released()) return;
                sealed = true;
                worker.shutdown();
                if (lifecycle != null) lifecycle.shutdown();
            }
            if (owner != null) owner.close();
        }

        Map<String, Object> snapshot() {
            PlDebugSession current = session;
            Map<String, Object> result;
            if (current != null) {
                result = current.snapshot();
            } else {
                result = new LinkedHashMap<>();
                result.put("owner", request.getSchema());
                result.put("targetDispatched", false);
                result.put("targetReturned", false);
                result.put("executionStopped", startDone.isDone());
                result.put("executionOutcome", cancelRequested.get() && startDone.isDone() ? "cancelled" : "not_started");
                result.put("cancelConfirmed", cancelRequested.get() && startDone.isDone());
                result.put("transactionOutcome", "not_started");
                result.put("releaseState", released() ? "released" : hasUntrackedConnection() || cleanupError != null ? "unknown" : "open");
                result.put("cleanupError", cleanupError);
                result.put("debuggeeClosed", debuggee == null ? startDone.isDone() && !hasUntrackedConnection() : debuggeeClosed);
                result.put("debuggerClosed", debugger == null ? startDone.isDone() && !hasUntrackedConnection() : debuggerClosed);
                result.put("terminated", startDone.isDone());
                result.put("state", startDone.isDone() ? "ended" : "starting");
            }
            if (!startDone.isDone()) result.put("state", "starting");
            synchronized (actionLock) {
                if ("paused".equals(result.get("state")) && operations.values().stream()
                    .anyMatch(operation -> "unknown".equals(operation.state))) result.put("state", "unknown");
            }
            result.put("operationBusy", actionRunning);
            return decorate(result);
        }

        Map<String, Object> decorate(Map<String, Object> result) {
            result.put("debugId", id);
            result.put("nativeDebugId", session == null ? null : session.debugId());
            result.put("startOperationId", id);
            result.put("startState", startState);
            result.put("startError", startError);
            result.put("cancelRequested", cancelRequested.get() || Boolean.TRUE.equals(result.get("cancelRequested")));
            result.put("untrackedConnection", hasUntrackedConnection());
            result.put("cleanupError", cleanupError);
            result.put("cleanupPending", cleanupRunning.get() && !released());
            if (cleanupError != null && !Objects.equals("released", result.get("releaseState"))) {
                result.put("releaseState", "unknown");
            }
            return result;
        }

        private boolean hasUntrackedConnection() {
            return untrackedConnection && owner != null && !owner.resourcesReleased();
        }
    }
}
