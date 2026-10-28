package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.AbstractJdbcAgent.DedicatedConnectionOwner;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.TimeUnit;

final class PlDebugMetadataInspection {
    @FunctionalInterface
    interface Inspection {
        Map<String, Object> read(Connection connection, long deadlineNanos) throws Exception;
    }

    static Map<String, Object> run(PlDebugManager.OwnerFactory owners, Inspection inspection) throws Exception {
        Scope scope = new Scope();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(PlDebugNative.CALL_TIMEOUT_SECONDS);
        Map<String, Object> result;
        Throwable failure = null;
        try {
            result = inspection.read(scope.open(owners, deadline), deadline);
            scope.check(deadline);
        } catch (Exception | Error error) {
            failure = error;
            throw error;
        } finally {
            scope.finishReading();
            try { scope.cleanup(deadline); }
            catch (Exception cleanupError) {
                if (failure != null) failure.addSuppressed(cleanupError);
                else throw cleanupError;
            }
        }
        scope.check(deadline);
        if (!scope.released()) throw new IllegalStateException("Typed metadata connection release is unconfirmed; the preview was not published");
        return result;
    }

    static final class Scope {
        private final Object stateLock = new Object();
        private final boolean initiallyInterrupted = Thread.currentThread().isInterrupted();
        private Thread reader = Thread.currentThread();
        private boolean readingFinished;
        private boolean retirementInterrupted;
        private boolean ownerClosed;
        private volatile boolean retired;
        private volatile DedicatedConnectionOwner owner;
        private volatile Connection connection;
        private boolean connectionClosed;

        Connection open(PlDebugManager.OwnerFactory owners, long deadline) throws Exception {
            owner = owners.register(this::retire, this::resourceCompleted);
            check(deadline);
            connection = owner.openUntil(deadline);
            check(deadline);
            return connection;
        }

        void check(long deadline) throws SQLException {
            if (retired) throw new CancellationException("Typed metadata inspection was retired before completion");
            PlDebugTypeMetadata.remainingSeconds(deadline);
        }

        void retire() {
            boolean cleanup;
            synchronized (stateLock) {
                retired = true;
                cleanup = readingFinished;
                if (!readingFinished && reader != null) {
                    retirementInterrupted = true;
                    reader.interrupt();
                }
            }
            if (cleanup) {
                try { cleanup(System.nanoTime()); }
                catch (Exception ignored) { /* The original physical owner retains unconfirmed resources. */ }
            }
        }

        void finishReading() {
            synchronized (stateLock) {
                readingFinished = true;
                reader = null;
                if (retirementInterrupted && !initiallyInterrupted) Thread.interrupted();
            }
        }

        void cleanup(long deadline) throws Exception {
            Connection current;
            DedicatedConnectionOwner resourceOwner;
            synchronized (stateLock) {
                if (ownerClosed) return;
                current = connectionClosed ? null : connection;
                resourceOwner = owner;
            }
            Exception failure = null;
            if (current != null && resourceOwner != null) {
                try {
                    if (resourceOwner.closeConnectionUntil(current, deadline)) {
                        synchronized (stateLock) { connectionClosed = true; }
                    }
                } catch (Exception error) { failure = error; }
            }
            if (resourceOwner != null) {
                try { resourceOwner.closeUnreturnedConnectionsUntil(deadline); }
                catch (Exception error) {
                    if (failure == null) failure = error;
                    else failure.addSuppressed(error);
                }
            }
            resourceCompleted();
            if (failure != null) throw failure;
        }

        void resourceCompleted() {
            synchronized (stateLock) {
                if (readingFinished && !ownerClosed && owner != null && owner.resourcesReleased()) {
                    owner.close();
                    ownerClosed = true;
                }
            }
        }

        boolean released() {
            synchronized (stateLock) { return ownerClosed && owner != null && owner.resourcesReleased(); }
        }
    }

    private PlDebugMetadataInspection() {}
}
