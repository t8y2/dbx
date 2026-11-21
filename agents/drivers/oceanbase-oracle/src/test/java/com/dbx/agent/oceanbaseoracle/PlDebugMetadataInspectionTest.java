package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.AbstractJdbcAgent.DedicatedConnectionOwner;
import org.junit.jupiter.api.Test;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.util.Map;
import java.util.concurrent.CancellationException;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugMetadataInspectionTest {
    @Test
    void publishesOnlyAfterTheDedicatedConnectionAndOwnerAreReleased() throws Exception {
        Owner owner = new Owner();
        Map<String, Object> result = PlDebugMetadataInspection.run(owner::register, (connection, deadline) -> {
            assertSame(owner.connection, connection);
            assertEquals(0, owner.closes);
            assertFalse(owner.released);
            return Map.of("preview", "ready");
        });
        assertEquals("ready", result.get("preview"));
        assertEquals(1, owner.opens);
        assertEquals(1, owner.closes);
        assertEquals(1, owner.ownerCloses);
        assertEquals(owner.openDeadline, owner.closeDeadline);
        assertEquals(owner.openDeadline, owner.unreturnedDeadline);
    }

    @Test
    void preservesReadAndCleanupFailuresWithoutPublishing() {
        Owner owner = new Owner();
        owner.failClose = true;
        SQLException error = assertThrows(SQLException.class, () -> PlDebugMetadataInspection.run(owner::register,
            (connection, deadline) -> { throw new SQLException("read failed", "42000"); }));
        assertEquals("read failed", error.getMessage());
        assertEquals(1, error.getSuppressed().length);
        assertEquals("close failed", error.getSuppressed()[0].getMessage());
        assertEquals(0, owner.ownerCloses);
        owner.failClose = false;
        owner.retire.run();
        assertEquals(1, owner.ownerCloses);
        assertEquals(1, owner.opens);
    }

    @Test
    void doesNotPublishWhenThePhysicalCloseHasOnlyBeenRequested() {
        Owner owner = new Owner();
        owner.deferRelease = true;
        assertThrows(IllegalStateException.class, () -> PlDebugMetadataInspection.run(owner::register,
            (connection, deadline) -> Map.of("preview", "ready")));
        assertEquals(0, owner.ownerCloses);
        owner.released = true;
        owner.completed.run();
        owner.completed.run();
        assertEquals(1, owner.ownerCloses);
    }

    @Test
    void lateUnreturnedConnectionsKeepTheirOriginalOwner() {
        Owner owner = new Owner();
        owner.failOpen = true;
        assertThrows(SQLException.class, () -> PlDebugMetadataInspection.run(owner::register,
            (connection, deadline) -> { fail("No connection was delivered"); return Map.of(); }));
        assertEquals(0, owner.ownerCloses);
        owner.released = true;
        owner.completed.run();
        assertEquals(1, owner.ownerCloses);
        assertEquals(1, owner.opens);
    }

    @Test
    void retirementCancelsOnlyItsOwnActiveReaderAndKeepsTheResultUnpublished() {
        Owner owner = new Owner();
        assertThrows(CancellationException.class, () -> PlDebugMetadataInspection.run(owner::register, (connection, deadline) -> {
            owner.retire.run();
            assertTrue(Thread.currentThread().isInterrupted());
            return Map.of("preview", "ready");
        }));
        assertFalse(Thread.currentThread().isInterrupted());
        assertEquals(1, owner.ownerCloses);
        owner.retire.run();
        assertFalse(Thread.currentThread().isInterrupted(), "a late retirement must not interrupt a reused RPC worker");
    }

    @Test
    void doesNotConsumeAnInterruptThatPredatedTheInspection() {
        Owner owner = new Owner();
        Thread.currentThread().interrupt();
        try {
            assertThrows(SQLTimeoutException.class, () -> PlDebugMetadataInspection.run(owner::register,
                (connection, deadline) -> { fail("An interrupted inspection cannot read"); return Map.of(); }));
            assertTrue(Thread.currentThread().isInterrupted());
            assertEquals(0, owner.opens);
        } finally { Thread.interrupted(); }
    }

    private static final class Owner implements DedicatedConnectionOwner {
        boolean released = true;
        boolean failOpen;
        boolean failClose;
        boolean deferRelease;
        int opens;
        int closes;
        int ownerCloses;
        long openDeadline;
        long closeDeadline;
        long unreturnedDeadline;
        Runnable retire;
        Runnable completed;
        final Connection connection = proxy(Connection.class, (method, args) -> {
            if (method.getName().equals("close")) {
                closes++;
                if (failClose) throw new SQLException("close failed");
                if (!deferRelease) { released = true; completed.run(); }
            }
            return empty(method.getReturnType());
        });

        DedicatedConnectionOwner register(Runnable onRetire, Runnable onCompletion) {
            retire = onRetire;
            completed = onCompletion;
            return this;
        }
        @Override public Connection open() throws Exception {
            opens++;
            released = false;
            if (failOpen) throw new SQLException("unreturned connection");
            return connection;
        }
        @Override public Connection openUntil(long deadline) throws Exception { openDeadline = deadline; return open(); }
        @Override public boolean closeConnectionUntil(Connection input, long deadline) throws SQLException {
            assertSame(connection, input);
            closeDeadline = deadline;
            input.close();
            return released;
        }
        @Override public boolean closeUnreturnedConnectionsUntil(long deadline) { unreturnedDeadline = deadline; return released; }
        @Override public boolean resourcesReleased() { return released; }
        @Override public void close() {
            assertTrue(released);
            ownerCloses++;
        }
    }
}
