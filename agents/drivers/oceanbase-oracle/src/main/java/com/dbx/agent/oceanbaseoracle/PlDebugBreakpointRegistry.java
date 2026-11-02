package com.dbx.agent.oceanbaseoracle;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/** Original-controller writes and their confirmed native registration identities. */
final class PlDebugBreakpointRegistry {
    record SourceBinding(String id, long revision, int line) {}
    record Registration(String id, int number, PlDebugBreakpointInventory.Program program, SourceBinding source,
                        boolean internalHold, boolean userHold) {}
    record Mutation(Registration registration, int result, boolean nativeMutation, boolean changed) {
        Mutation(Registration registration, int result, boolean nativeMutation) {
            this(registration, result, nativeMutation, nativeMutation);
        }
    }

    static final class Failure extends Exception {
        final boolean dispatched;
        final Integer nativeResult;
        final Integer nativeNumber;

        Failure(Throwable cause, boolean dispatched, Integer nativeResult, Integer nativeNumber) {
            super(cause.getMessage(), cause);
            this.dispatched = dispatched;
            this.nativeResult = nativeResult;
            this.nativeNumber = nativeNumber;
        }
    }

    private final Connection debugger;
    private final String registrationPrefix = UUID.randomUUID().toString();
    private long sequence;
    private final Set<Integer> retiredNumbers = new HashSet<>();
    private PlDebugBreakpointInventory inventory;
    private volatile List<Registration> registrations = List.of();
    private volatile String state = "uninitialized";
    private volatile String observed;

    PlDebugBreakpointRegistry(Connection debugger) { this.debugger = debugger; }

    String state() { return state; }
    String observed() { return observed; }
    List<Registration> registrations() { return registrations; }

    boolean retired(int number) { return retiredNumbers.contains(number); }

    boolean enabled(Registration registration) { return inventory.entry(registration.number()).enabled(); }

    Registration legacyRegistration(int number) {
        Registration registration = registrations.stream().filter(item -> item.number() == number && item.userHold()).findFirst()
            .orElseThrow(() -> new IllegalArgumentException("The native breakpoint number has no current registration"));
        if (retiredNumbers.contains(number)) throw new IllegalArgumentException("This native breakpoint number was reused; the original registrationId is required");
        return registration;
    }

    void requireUsable() {
        if ("unknown".equals(state) || "changed".equals(state)) {
            throw new IllegalStateException("The original breakpoint inventory is " + state + "; inspect or close the original session");
        }
    }

    void verify() throws Failure {
        try {
            requireUsable();
            observed = PlDebugNative.breakpointListing(debugger);
            if (inventory == null) {
                try { inventory = PlDebugBreakpointInventory.empty(observed); }
                catch (RuntimeException error) { state = "changed"; throw error; }
            } else {
                try { inventory.requireCurrent(observed); }
                catch (RuntimeException error) { state = "changed"; throw error; }
            }
            state = "confirmed";
        } catch (Exception error) {
            if (error instanceof SQLException sql && PlDebugNative.connectionUnsafe(sql)) state = "unknown";
            throw new Failure(error, false, null, null);
        }
    }

    Mutation set(PlDebugBreakpointInventory.Program program, SourceBinding source, Runnable beforeDispatch) throws Failure {
        return set(program, source, false, beforeDispatch);
    }

    Mutation setInternal(PlDebugBreakpointInventory.Program program, Runnable beforeDispatch) throws Failure {
        return set(program, null, true, beforeDispatch);
    }

    private Mutation set(PlDebugBreakpointInventory.Program program, SourceBinding source, boolean internal, Runnable beforeDispatch) throws Failure {
        verify();
        for (Registration existing : registrations) {
            if (existing.program().equals(program)) {
                if (!internal && existing.internalHold() && !existing.userHold() && source != null) {
                    Registration claimed = new Registration(existing.id(), existing.number(), program, source, true, true);
                    registrations = registrations.stream().map(item -> item == existing ? claimed : item).toList();
                    return new Mutation(claimed, 0, false, true);
                }
                if (!internal && !existing.userHold()) throw new Failure(new IllegalArgumentException("A source reference is required to claim an internal breakpoint"), false, null, existing.number());
                if (!Objects.equals(existing.source(), source)) throw new Failure(new IllegalStateException("The original breakpoint belongs to a different source reference or revision"), false, null, existing.number());
                return new Mutation(existing, 0, false);
            }
        }
        boolean[] dispatched = {false};
        Integer result = null;
        Integer number = null;
        try {
            int[] nativeResult = PlDebugNative.setBreakpoint(debugger, program, () -> {
                beforeDispatch.run();
                dispatched[0] = true;
            });
            result = nativeResult[1];
            number = result == 0 ? nativeResult[0] : null;
            observed = PlDebugNative.breakpointListing(debugger);
            if (result != 0) {
                inventory.requireCurrent(observed);
                if (result == 12 || result == 16) return new Mutation(null, result, true);
                throw new IllegalStateException("The native SET result cannot confirm a rejected mutation (result=" + result + ")");
            }
            for (Registration existing : registrations) {
                if (existing.number() == number) throw new IllegalStateException("The native SET returned another registration's number");
            }
            PlDebugBreakpointInventory confirmed = inventory.confirmSet(program, number, observed);
            Registration registration = new Registration(registrationPrefix + ":" + (++sequence), number, program, source, internal, !internal);
            List<Registration> updated = new ArrayList<>(registrations);
            updated.add(registration);
            inventory = confirmed;
            registrations = List.copyOf(updated);
            return new Mutation(registration, 0, true);
        } catch (Exception error) {
            if (dispatched[0]) state = "unknown";
            throw new Failure(error, dispatched[0], result, number);
        }
    }

    Mutation delete(String registrationId, Runnable beforeDispatch) throws Failure {
        Registration registration = registrations.stream().filter(item -> item.id().equals(registrationId) && item.userHold()).findFirst().orElse(null);
        if (registration == null) throw new Failure(new IllegalArgumentException("The original user breakpoint registration is not available"), false, null, null);
        if (registration.internalHold()) {
            verify();
            Registration retained = new Registration(registration.id(), registration.number(), registration.program(), null, true, false);
            registrations = registrations.stream().map(item -> item == registration ? retained : item).toList();
            return new Mutation(retained, 0, false, true);
        }
        return mutate(registrationId, null, beforeDispatch);
    }

    Mutation releaseInternal(String registrationId, Runnable beforeDispatch) throws Failure {
        Registration registration = registrations.stream().filter(item -> item.id().equals(registrationId) && item.internalHold()).findFirst().orElse(null);
        if (registration == null) throw new Failure(new IllegalArgumentException("The original internal breakpoint registration is not available"), false, null, null);
        if (registration.userHold()) {
            verify();
            Registration retained = new Registration(registration.id(), registration.number(), registration.program(), registration.source(), false, true);
            registrations = registrations.stream().map(item -> item == registration ? retained : item).toList();
            return new Mutation(retained, 0, false, true);
        }
        return mutate(registrationId, null, beforeDispatch);
    }

    Mutation enabled(String registrationId, boolean enabled, Runnable beforeDispatch) throws Failure {
        return mutate(registrationId, enabled, beforeDispatch);
    }

    private Mutation mutate(String registrationId, Boolean enabled, Runnable beforeDispatch) throws Failure {
        Registration registration = registrations.stream().filter(item -> item.id().equals(registrationId)).findFirst().orElse(null);
        if (registration == null) throw new Failure(new IllegalArgumentException("The original breakpoint registration is not available"), false, null, null);
        verify();
        if (enabled != null && inventory.entry(registration.number()).enabled() == enabled) {
            return new Mutation(registration, 0, false);
        }
        boolean[] dispatched = {false};
        Integer result = null;
        try {
            Runnable mark = () -> { beforeDispatch.run(); dispatched[0] = true; };
            result = enabled == null ? PlDebugNative.deleteBreakpoint(debugger, registration.number(), mark)
                : PlDebugNative.toggleBreakpoint(debugger, registration.number(), enabled, mark);
            observed = PlDebugNative.breakpointListing(debugger);
            if (result == 13) {
                PlDebugBreakpointInventory absent = inventory.confirmDelete(registration.number(), observed);
                registrations = registrations.stream().filter(item -> !item.id().equals(registrationId)).toList();
                retiredNumbers.add(registration.number());
                inventory = absent;
                return new Mutation(registration, result, true);
            }
            if (result == 14 || (enabled == null && result == 15)) {
                inventory.requireCurrent(observed);
                if (result == 15) state = "changed";
                return new Mutation(registration, result, true);
            }
            if (result != 0) throw new IllegalStateException("The native breakpoint mutation was not confirmed (result=" + result + ")");
            PlDebugBreakpointInventory confirmed = enabled == null ? inventory.confirmDelete(registration.number(), observed)
                : inventory.confirmEnabled(registration.number(), enabled, observed);
            if (enabled == null) {
                registrations = registrations.stream().filter(item -> !item.id().equals(registrationId)).toList();
                retiredNumbers.add(registration.number());
            }
            inventory = confirmed;
            return new Mutation(registration, 0, true);
        } catch (Exception error) {
            if (dispatched[0]) state = "unknown";
            throw new Failure(error, dispatched[0], result, registration.number());
        }
    }
}
