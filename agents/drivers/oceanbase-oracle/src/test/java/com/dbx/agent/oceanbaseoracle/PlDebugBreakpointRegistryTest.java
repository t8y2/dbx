package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Map;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugBreakpointRegistryTest {
    private static final PlDebugBreakpointInventory.Program PROGRAM = new PlDebugBreakpointInventory.Program("O", "P", 1, 12);
    private static final PlDebugBreakpointRegistry.SourceBinding SOURCE = new PlDebugBreakpointRegistry.SourceBinding("source-one", 1, 3);

    @Test
    void ownsConfirmedCreatesAndDoesNotReplayAnAlreadyRegisteredProgram() throws Exception {
        Server server = new Server();
        var registry = new PlDebugBreakpointRegistry(server.connection());
        var created = registry.set(PROGRAM, SOURCE, () -> {});
        assertEquals(0, created.result());
        assertTrue(created.nativeMutation());
        assertEquals(1, created.registration().number());
        assertEquals(SOURCE, created.registration().source());
        assertEquals("confirmed", registry.state());
        var duplicate = registry.set(PROGRAM, SOURCE, () -> fail("Duplicate registration must not dispatch"));
        assertEquals(created.registration(), duplicate.registration());
        assertFalse(duplicate.nativeMutation());
        assertEquals(1, server.sets);
        var changedSource = new PlDebugBreakpointRegistry.SourceBinding(SOURCE.id(), 2, SOURCE.line());
        assertFalse(assertThrows(PlDebugBreakpointRegistry.Failure.class,
            () -> registry.set(PROGRAM, changedSource, () -> {})).dispatched);
        assertEquals(1, server.sets);
        assertEquals(1, registry.registrations().size());
    }

    @Test
    void deletedNumbersCanBeReusedButOldRegistrationIdsCannotChangeTheNewRecord() throws Exception {
        Server server = new Server();
        var registry = new PlDebugBreakpointRegistry(server.connection());
        var original = registry.set(PROGRAM, SOURCE, () -> {}).registration();
        assertEquals(original, registry.legacyRegistration(original.number()));
        assertTrue(registry.enabled(original.id(), false, () -> {}).nativeMutation());
        assertFalse(registry.enabled(original.id(), false, () -> fail("Already disabled")).nativeMutation());
        registry.enabled(original.id(), true, () -> {});
        registry.delete(original.id(), () -> {});
        assertTrue(registry.registrations().isEmpty());
        server.nextNumber = original.number();
        var replacement = registry.set(PROGRAM, SOURCE, () -> {}).registration();
        assertEquals(original.number(), replacement.number());
        assertNotEquals(original.id(), replacement.id());
        assertThrows(IllegalArgumentException.class, () -> registry.legacyRegistration(replacement.number()));
        int writes = server.writes;
        assertFalse(assertThrows(PlDebugBreakpointRegistry.Failure.class, () -> registry.delete(original.id(), () -> {})).dispatched);
        assertFalse(assertThrows(PlDebugBreakpointRegistry.Failure.class, () -> registry.enabled(original.id(), false, () -> {})).dispatched);
        assertEquals(writes, server.writes);
        assertEquals(replacement, registry.registrations().getFirst());
    }

    @Test
    void observesExternalChangesBeforeWritingAndNeverAdoptsAnUnmanagedInventory() throws Exception {
        Server server = new Server();
        var registry = new PlDebugBreakpointRegistry(server.connection());
        var original = registry.set(PROGRAM, SOURCE, () -> {}).registration();
        server.records.clear();
        assertFalse(assertThrows(PlDebugBreakpointRegistry.Failure.class, () -> registry.delete(original.id(), () -> {})).dispatched);
        assertEquals(1, server.writes);
        assertEquals("changed", registry.state());
        assertEquals(original, registry.registrations().getFirst(), "Keep the last confirmed record, not an empty successful list");
        assertThrows(IllegalStateException.class, registry::requireUsable);
        Server foreign = new Server();
        foreign.records.put(99, new Item(PROGRAM, true));
        var unmanaged = new PlDebugBreakpointRegistry(foreign.connection());
        assertFalse(assertThrows(PlDebugBreakpointRegistry.Failure.class, () -> unmanaged.set(PROGRAM, SOURCE, () -> {})).dispatched);
        assertEquals(0, foreign.writes);
        assertTrue(unmanaged.registrations().isEmpty());
        assertTrue(unmanaged.observed().contains("99."));
    }

    @Test
    void aPostWriteReadFailureOrMissingNumberKeepsAnUnknownSingleDispatch() throws Exception {
        for (boolean missingNumber : new boolean[] {false, true}) {
            Server server = new Server();
            server.failReadAt = missingNumber ? 0 : 2;
            server.missingSetNumber = missingNumber;
            var registry = new PlDebugBreakpointRegistry(server.connection());
            var failure = assertThrows(PlDebugBreakpointRegistry.Failure.class, () -> registry.set(PROGRAM, SOURCE, () -> {}));
            assertTrue(failure.dispatched);
            assertEquals("unknown", registry.state());
            assertEquals(1, server.sets);
            assertEquals(1, server.records.size(), "The native create really happened");
            assertTrue(registry.registrations().isEmpty());
            assertThrows(PlDebugBreakpointRegistry.Failure.class, () -> registry.set(PROGRAM, SOURCE, () -> {}));
            assertEquals(1, server.sets, "Unknown never retries the native SET");
        }
    }

    @Test
    void preservesOriginalNativeResultWhenThePostWriteInventoryIsUnexpected() throws Exception {
        Server server = new Server();
        var registry = new PlDebugBreakpointRegistry(server.connection());
        var created = registry.set(PROGRAM, SOURCE, () -> {}).registration();
        server.ignoreToggle = true;
        var failure = assertThrows(PlDebugBreakpointRegistry.Failure.class, () -> registry.enabled(created.id(), false, () -> {}));
        assertTrue(failure.dispatched);
        assertEquals(0, failure.nativeResult);
        assertEquals(created.number(), failure.nativeNumber);
        assertEquals("unknown", registry.state());
        assertEquals(created, registry.registrations().getFirst());
        assertThrows(PlDebugBreakpointRegistry.Failure.class, () -> registry.delete(created.id(), () -> {}));
        assertEquals(2, server.writes);
    }

    @Test
    void distinguishesProvenNativeRefusalAndPredispatchCancellationFromUnknown() throws Exception {
        Server server = new Server();
        server.setResult = 12;
        var registry = new PlDebugBreakpointRegistry(server.connection());
        assertEquals(12, registry.set(PROGRAM, SOURCE, () -> {}).result());
        assertEquals("confirmed", registry.state());
        assertTrue(registry.registrations().isEmpty());
        server.setResult = 0;
        RuntimeException cancelled = new IllegalStateException("Owner cancelled before dispatch");
        var failure = assertThrows(PlDebugBreakpointRegistry.Failure.class,
            () -> registry.set(PROGRAM, SOURCE, () -> { throw cancelled; }));
        assertFalse(failure.dispatched);
        assertSame(cancelled, failure.getCause());
        assertEquals(1, server.sets);
        assertEquals("confirmed", registry.state());
        assertNotNull(registry.set(PROGRAM, SOURCE, () -> {}).registration());
    }

    @Test
    void keepsNonzeroNativeResultsSeparateFromTheConfirmedAbsenceAndUnknownCases() throws Exception {
        Server server = new Server();
        var registry = new PlDebugBreakpointRegistry(server.connection());
        var created = registry.set(PROGRAM, SOURCE, () -> {}).registration();
        server.mutationResult = 13;
        server.removeOnRefusal = true;
        assertEquals(13, registry.delete(created.id(), () -> {}).result());
        assertEquals("confirmed", registry.state());
        assertTrue(registry.registrations().isEmpty());
        var next = registry.set(PROGRAM, SOURCE, () -> {}).registration();
        server.removeOnRefusal = false;
        var failure = assertThrows(PlDebugBreakpointRegistry.Failure.class, () -> registry.delete(next.id(), () -> {}));
        assertEquals(13, failure.nativeResult);
        assertTrue(failure.dispatched);
        assertEquals("unknown", registry.state(), "A missing native id contradicting the retained record is not a confirmed ordinary refusal");
    }

    @Test
    void aPredispatchConnectionLossBlocksControlButANonfatalReadFailureIsNotMisclassified() throws Exception {
        for (String state : new String[] {"08006", "HY001"}) {
            Server server = new Server();
            server.failReadAt = 1;
            server.readFailureState = state;
            var registry = new PlDebugBreakpointRegistry(server.connection());
            var failure = assertThrows(PlDebugBreakpointRegistry.Failure.class, () -> registry.set(PROGRAM, SOURCE, () -> {}));
            assertFalse(failure.dispatched);
            assertEquals(0, server.sets);
            if (state.startsWith("08")) {
                assertEquals("unknown", registry.state());
                assertThrows(IllegalStateException.class, registry::requireUsable);
            } else {
                assertEquals("uninitialized", registry.state());
                assertNotNull(registry.set(PROGRAM, SOURCE, () -> {}).registration());
                assertEquals(1, server.sets);
            }
        }
    }

    private record Item(PlDebugBreakpointInventory.Program program, boolean enabled) {}

    @Test
    void internalAndUserHoldsShareOneNativeRegistrationWithoutLosingSourceIdentity() throws Exception {
        Server server = new Server();
        var registry = new PlDebugBreakpointRegistry(server.connection());
        var internal = registry.setInternal(PROGRAM, () -> {}).registration();
        assertTrue(internal.internalHold());
        assertFalse(internal.userHold());
        assertThrows(IllegalArgumentException.class, () -> registry.legacyRegistration(internal.number()));
        assertThrows(PlDebugBreakpointRegistry.Failure.class, () -> registry.set(PROGRAM, null, () -> fail("No SET")));
        var claim = registry.set(PROGRAM, SOURCE, () -> fail("Claim must reuse the confirmed native record"));
        assertTrue(claim.changed());
        assertFalse(claim.nativeMutation());
        assertEquals(internal.id(), claim.registration().id());
        assertEquals(SOURCE, claim.registration().source());
        var released = registry.releaseInternal(internal.id(), () -> fail("User hold keeps native record"));
        assertFalse(released.registration().internalHold());
        assertTrue(released.registration().userHold());
        assertEquals(SOURCE, released.registration().source());
        assertEquals(1, server.writes);
        registry.delete(internal.id(), () -> {});
        assertTrue(registry.registrations().isEmpty());
        assertEquals(2, server.writes);
    }

    @Test
    void deletingUserHoldKeepsPrivateRegistrationUntilItsOwnRelease() throws Exception {
        Server server = new Server();
        var registry = new PlDebugBreakpointRegistry(server.connection());
        var internal = registry.setInternal(PROGRAM, () -> {}).registration();
        registry.set(PROGRAM, SOURCE, () -> fail("No duplicate SET"));
        var deleted = registry.delete(internal.id(), () -> fail("Internal hold keeps native record"));
        assertTrue(deleted.changed());
        assertFalse(deleted.nativeMutation());
        assertFalse(deleted.registration().userHold());
        assertTrue(deleted.registration().internalHold());
        assertNull(deleted.registration().source());
        registry.releaseInternal(internal.id(), () -> {});
        assertTrue(registry.registrations().isEmpty());
        assertEquals(2, server.writes);
    }

    @Test
    void unsafeJdbcSubclassesWithoutSqlStateInvalidatePredispatchInventory() {
        for (SQLException error : java.util.List.of(new java.sql.SQLTimeoutException("timeout"),
            new java.sql.SQLRecoverableException("lost"), new java.sql.SQLTransientConnectionException("lost"),
            new java.sql.SQLNonTransientConnectionException("lost"))) {
            Server server = new Server();
            server.failReadAt = 1;
            server.readFailure = error;
            var registry = new PlDebugBreakpointRegistry(server.connection());
            var failure = assertThrows(PlDebugBreakpointRegistry.Failure.class,
                () -> registry.set(PROGRAM, SOURCE, () -> fail("No native dispatch after inventory loss")));
            assertSame(error, failure.getCause());
            assertFalse(failure.dispatched);
            assertEquals("unknown", registry.state());
            assertThrows(PlDebugBreakpointRegistry.Failure.class, registry::verify);
            assertEquals(1, server.reads, "Unknown inventory must not be refreshed into a guessed usable state");
            assertEquals(0, server.writes);
        }
    }

    static final class Server {
        final Map<Integer, Item> records = new LinkedHashMap<>();
        final java.util.Deque<Integer> numbers = new java.util.ArrayDeque<>();
        int nextNumber = 1;
        int reads;
        int sets;
        int writes;
        int setResult;
        PlDebugBreakpointInventory.Program lastSet;
        int failReadAt;
        String readFailureState = "08006";
        SQLException readFailure;
        int mutationResult;
        boolean removeOnRefusal;
        boolean missingSetNumber;
        boolean ignoreToggle;

        String listing() {
            if (records.isEmpty()) return PlDebugBreakpointInventory.EMPTY;
            StringBuilder result = new StringBuilder();
            records.forEach((number, item) -> result.append(String.format(java.util.Locale.ROOT, "%3d. ", number))
                .append(item.program.owner()).append('.').append(item.program.name()).append(", Line ").append(item.program.line())
                .append(" [offset (\t0,  0),  0] ").append(item.enabled ? "" : "Disabled.").append('\n'));
            return result.toString();
        }

        Connection connection() {
            return proxy(Connection.class, (method, args) -> {
                if (!method.getName().equals("prepareCall")) return empty(method.getReturnType());
                String sql = (String) args[0];
                boolean read = sql.contains("SHOW_BREAKPOINTS");
                boolean set = sql.contains("set_breakpoint(");
                boolean delete = sql.contains("delete_breakpoint(");
                boolean enable = sql.contains("enable_breakpoint(");
                Map<Integer, Object> inputs = new LinkedHashMap<>();
                Map<Integer, Integer> outputs = new LinkedHashMap<>();
                boolean[] wasNull = {false};
                return proxy(CallableStatement.class, (member, values) -> {
                    switch (member.getName()) {
                        case "setString", "setInt": inputs.put((int) values[0], values[1]); return null;
                        case "execute":
                            if (read) {
                                if (++reads == failReadAt) throw readFailure != null ? readFailure : new SQLException("Inventory response was lost", readFailureState);
                            } else if (set) {
                                sets++; writes++; outputs.put(6, setResult);
                                if (setResult == 0) {
                                    int number = numbers.isEmpty() ? nextNumber++ : numbers.removeFirst();
                                    nextNumber = Math.max(nextNumber, number + 1);
                                    lastSet = new PlDebugBreakpointInventory.Program((String) inputs.get(1), (String) inputs.get(2), (int) inputs.get(3), (int) inputs.get(4));
                                    records.put(number, new Item(lastSet, true));
                                    if (!missingSetNumber) outputs.put(5, number);
                                }
                            } else {
                                writes++;
                                int number = (int) inputs.get(2);
                                Item existing = records.get(number);
                                outputs.put(1, existing == null ? 13 : mutationResult);
                                if (mutationResult != 0) {
                                    if (removeOnRefusal) records.remove(number);
                                } else if (existing != null) {
                                    if (delete) records.remove(number);
                                    else if (!ignoreToggle) records.put(number, new Item(existing.program, enable));
                                }
                            }
                            return false;
                        case "getString": return listing();
                        case "getInt":
                            Integer value = outputs.get((int) values[0]);
                            wasNull[0] = value == null;
                            return value == null ? 0 : value;
                        case "wasNull": return wasNull[0];
                        default: return empty(member.getReturnType());
                    }
                });
            });
        }
    }
}
