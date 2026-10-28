package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.PlDebugStartRequest;
import com.dbx.agent.AbstractJdbcAgent.DedicatedConnectionOwner;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLRecoverableException;
import java.sql.SQLException;
import java.util.Map;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugCompileTest {
    @Test void readbackUsesNativeObjectIdTextAndBindsTheExactIdentityWithoutUnsupportedNlsFormatting() throws Exception {
        var bindings = new java.util.LinkedHashMap<Integer, Object>();
        Connection connection = proxy(Connection.class, (method, args) -> {
            if (!method.getName().equals("prepareStatement")) return empty(method.getReturnType());
            String sql = (String) args[0];
            if (sql.contains("ALL_OBJECTS")) {
                assertTrue(sql.startsWith("SELECT OBJECT_ID, STATUS FROM SYS.ALL_OBJECTS"));
                var rows = compileRows(List.of(List.of("9007199254740993123", "INVALID")));
                return proxy(PreparedStatement.class, (member, values) -> {
                    if (member.getName().equals("setString")) bindings.put((Integer) values[0], values[1]);
                    if (member.getName().equals("executeQuery")) assertEquals(Map.of(1, " Owner.\" ", 2, " Proc.\" ", 3, "PROCEDURE"), bindings);
                    try { return member.invoke(rows, values); }
                    catch (java.lang.reflect.InvocationTargetException error) { throw error.getCause(); }
                });
            }
            if (sql.contains("ALL_ERRORS")) return compileRows(List.of());
            if (sql.contains("ALL_PLSQL_OBJECT_SETTINGS")) return compileRows(List.of(List.of("FALSE", "2")));
            throw new AssertionError("Unexpected readback query");
        });
        var unit = PlDebugCompile.unit(" Owner.\" ", target("PROCEDURE", " Proc.\" ", null));
        var readback = PlDebugCompile.readback(connection, unit, System.nanoTime() + TimeUnit.SECONDS.toNanos(30));
        assertEquals("9007199254740993123", readback.get("objectId"));
        assertEquals("INVALID", readback.get("status"));
    }

    @Test void currentDictionaryRereadDoesNotReplayOrRewriteTheOriginalDdlReceipt() throws Exception {
        var originalDdl = new AtomicInteger();
        var target = PlDebugTargetTest.request("NUMBER");
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        Connection original = compilationConnection("diagnostics_failure", PlDebugTargetTest.overloaded(), originalDdl, new AtomicInteger());
        var confirmed = PlDebugCompile.preview(original, target, deadline);
        var receipt = new PlDebugCompile.Execution(target, confirmed).run(original, deadline);
        assertEquals("executed", receipt.get("ddlState"));
        assertEquals(false, ((Map<?, ?>) receipt.get("readback")).get("diagnosticsComplete"));
        var rereadDdl = new AtomicInteger();
        Connection current = compilationConnection("invalid", PlDebugTargetTest.overloaded(), rereadDdl, new AtomicInteger());
        var inspected = PlDebugCompile.inspect(current, target, deadline);
        var observation = (Map<?, ?>) inspected.get("compileObservation");
        assertEquals("SCOTT", observation.get("schema"));
        assertEquals("PACKAGE BODY", observation.get("objectType"));
        assertEquals(true, ((Map<?, ?>) observation.get("readback")).get("diagnosticsComplete"));
        assertEquals(false, ((Map<?, ?>) receipt.get("readback")).get("diagnosticsComplete"));
        assertEquals(1, originalDdl.get());
        assertEquals(0, rereadDdl.get());
        assertFalse(((Map<?, ?>) inspected.get("compilePreview")).containsKey("readback"));
        assertFalse(inspected.containsKey("ddlState"));
    }

    @Test void compileAndDebuggerAdmissionsAreMutuallyExclusiveBeforeAnyNewConnection() throws Exception {
        for (boolean compileFirst : List.of(false, true)) {
            Object admission = new Object();
            var compileRef = new java.util.concurrent.atomic.AtomicReference<PlDebugCompile.Manager>();
            var entered = new java.util.concurrent.CountDownLatch(1);
            var release = new java.util.concurrent.CountDownLatch(1);
            var debugOpens = new AtomicInteger();
            var compileOwners = new AtomicInteger();
            var debugger = new PlDebugManager(() -> {
                debugOpens.incrementAndGet(); entered.countDown();
                if (!release.await(5, TimeUnit.SECONDS)) throw new SQLException("fixture gate expired");
                throw new SQLException("fixture connection stopped");
            }, admission, () -> compileRef.get().hasUnresolved());
            var compiler = new PlDebugCompile.Manager(admission, debugger::hasUnreleased);
            compileRef.set(compiler);
            var start = target("ANONYMOUS", null, null);
            start.setOperationId("debug-admission");
            var named = target("PROCEDURE", "P", null);
            PlDebugManager.OwnerFactory owners = (retire, completed) -> {
                compileOwners.incrementAndGet(); entered.countDown();
                try {
                    if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("fixture gate expired");
                } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException(error); }
                var owner = new CompileOwner(null); owner.failOpen = true;
                return owner.register(retire, completed);
            };
            var worker = java.util.concurrent.Executors.newSingleThreadExecutor();
            try {
                var pending = worker.submit(() -> {
                    if (compileFirst) compiler.execute("compile-admission", named, Map.of(), owners);
                    else try { debugger.start(start); } catch (Exception expected) { }
                });
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                if (compileFirst) {
                    assertThrows(IllegalStateException.class, () -> debugger.start(start));
                    assertEquals(0, debugOpens.get());
                } else {
                    assertThrows(IllegalStateException.class, () -> compiler.execute("compile-admission", named, Map.of(), owners));
                    assertEquals(0, compileOwners.get());
                }
                release.countDown();
                pending.get(2, TimeUnit.SECONDS);
            } finally { release.countDown(); worker.shutdownNow(); }
        }
    }

    @Test void retainedOperationSurvivesPhysicalReleaseFailureAndCannotBeBypassedWithANewId() throws Exception {
        for (String scenario : List.of("invalid", "connection_failure")) {
            var ddl = new AtomicInteger();
            Connection connection = compilationConnection(scenario, PlDebugTargetTest.overloaded(), ddl, new AtomicInteger());
            var target = PlDebugTargetTest.request("NUMBER");
            var confirmed = PlDebugCompile.preview(connection, target, System.nanoTime() + TimeUnit.SECONDS.toNanos(30));
            var owner = new CompileOwner(connection);
            owner.failClose = scenario.equals("invalid");
            var manager = new PlDebugCompile.Manager();
            var result = manager.execute("compile-1", target, confirmed, owner::register);
            assertEquals(1, ddl.get());
            assertEquals(1, owner.opens);
            assertEquals(scenario.equals("invalid") ? "executed" : "unknown", result.get("ddlState"));
            assertEquals(scenario.equals("invalid") ? "unconfirmed" : "released", result.get("releaseState"));
            if (owner.failClose) assertEquals("physical close failed", result.get("cleanupError"));
            assertEquals(result, manager.status("compile-1"));
            assertEquals(result, manager.execute("compile-1", target, confirmed, owner::register));
            assertThrows(IllegalStateException.class, () -> manager.execute("compile-2", target, confirmed, owner::register));
            var changed = new java.util.LinkedHashMap<>(confirmed);
            changed.put("sql", "arbitrary client SQL");
            assertThrows(IllegalArgumentException.class, () -> manager.execute("compile-1", target, changed, owner::register));
            assertEquals(1, ddl.get());
            assertEquals(1, owner.opens);
            if (owner.failClose) {
                owner.released = true;
                owner.completed.run();
                assertEquals("released", manager.status("compile-1").get("releaseState"));
                assertEquals("executed", manager.status("compile-1").get("ddlState"));
                assertEquals(1, owner.ownerCloses);
                assertEquals(1, ddl.get());
            }
        }
    }

    @Test void retainedOperationKeepsOpenAndCleanupErrorsSeparately() {
        var owner = new CompileOwner(null);
        owner.failOpen = true;
        var manager = new PlDebugCompile.Manager();
        var result = manager.execute("open-failure", target("PROCEDURE", "P", null), Map.of(), owner::register);
        assertEquals("not_started", result.get("ddlState"));
        assertEquals(false, result.get("dispatched"));
        assertEquals("open failed", result.get("resourceError"));
        assertEquals("unreturned close failed", result.get("cleanupError"));
        assertEquals("unconfirmed", result.get("releaseState"));
        assertEquals(0, owner.ownerCloses);
    }

    @Test void retirementDuringDdlPreparationPreventsDispatchAndReleasesOnlyItsOwnInterrupt() throws Exception {
        var ddl = new AtomicInteger();
        Connection base = compilationConnection("invalid", PlDebugTargetTest.overloaded(), ddl, new AtomicInteger());
        var ownerRef = new java.util.concurrent.atomic.AtomicReference<CompileOwner>();
        Connection connection = proxy(Connection.class, (method, args) -> {
            if (method.getName().equals("prepareStatement") && ((String) args[0]).startsWith("ALTER ")) {
                ownerRef.get().retire.run();
            }
            try { return method.invoke(base, args); }
            catch (java.lang.reflect.InvocationTargetException error) { throw error.getCause(); }
        });
        var target = PlDebugTargetTest.request("NUMBER");
        var confirmed = PlDebugCompile.preview(connection, target, System.nanoTime() + TimeUnit.SECONDS.toNanos(30));
        var owner = new CompileOwner(connection);
        ownerRef.set(owner);
        assertFalse(Thread.currentThread().isInterrupted());
        var result = new PlDebugCompile.Manager().execute("retired-before-ddl", target, confirmed, owner::register);
        assertEquals("not_started", result.get("ddlState"));
        assertEquals(false, result.get("dispatched"));
        assertEquals(0, ddl.get());
        assertEquals("released", result.get("releaseState"));
        assertFalse(Thread.currentThread().isInterrupted());
    }

    private static final class CompileOwner implements DedicatedConnectionOwner {
        final Connection connection;
        boolean released = true;
        boolean failClose;
        boolean failOpen;
        int opens;
        int ownerCloses;
        Runnable completed;
        Runnable retire;
        CompileOwner(Connection connection) { this.connection = connection; }
        DedicatedConnectionOwner register(Runnable retire, Runnable completed) { this.retire = retire; this.completed = completed; return this; }
        @Override public Connection open() throws Exception {
            opens++; released = false;
            if (failOpen) throw new SQLException("open failed");
            return connection;
        }
        @Override public Connection openUntil(long deadline) throws Exception { return open(); }
        @Override public boolean closeConnectionUntil(Connection connection, long deadline) throws SQLException {
            assertSame(this.connection, connection);
            if (failClose) throw new SQLException("physical close failed");
            released = true;
            return true;
        }
        @Override public boolean closeUnreturnedConnectionsUntil(long deadline) throws SQLException {
            if (failOpen) throw new SQLException("unreturned close failed");
            return released;
        }
        @Override public boolean resourcesReleased() { return released; }
        @Override public void close() { assertTrue(released); ownerCloses++; }
    }

    @Test void executionKeepsDdlFactAcrossReadbackAndCloseFailuresAndNeverReplays() throws Exception {
        for (String scenario : List.of("invalid", "diagnostics_failure", "close_failure", "connection_failure", "changed")) {
            var jdbc = PlDebugTargetTest.overloaded();
            var ddl = new AtomicInteger();
            var statementCloses = new AtomicInteger();
            Connection connection = compilationConnection(scenario, jdbc, ddl, statementCloses);
            var target = PlDebugTargetTest.request("NUMBER");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            var confirmed = PlDebugCompile.preview(connection, target, deadline);
            var execution = new PlDebugCompile.Execution(target, confirmed);
            if (scenario.equals("changed")) jdbc.bodyText += "-- concurrent edit\n";
            var receipt = execution.run(connection, deadline);
            if (scenario.equals("changed")) {
                assertEquals("not_started", receipt.get("ddlState")); assertEquals(0, ddl.get());
            } else if (scenario.equals("connection_failure")) {
                assertEquals("unknown", receipt.get("ddlState"));
                assertEquals("unconfirmed", receipt.get("statementReleaseState"));
                assertEquals(0, statementCloses.get());
            } else {
                assertEquals("executed", receipt.get("ddlState"));
                var observed = (Map<?, ?>) receipt.get("readback");
                assertEquals("INVALID", observed.get("status"));
                assertEquals(!scenario.equals("diagnostics_failure"), observed.get("diagnosticsComplete"));
                if (scenario.equals("close_failure")) {
                    assertEquals("close failed", receipt.get("statementCloseError"));
                    assertEquals("unconfirmed", receipt.get("statementReleaseState"));
                }
            }
            int attempts = ddl.get();
            assertEquals(receipt, execution.run(connection, deadline));
            assertEquals(attempts, ddl.get());
        }
    }

    private static Connection compilationConnection(String scenario, PlDebugTargetTest.Metadata jdbc,
                                                     AtomicInteger ddl, AtomicInteger statementCloses) {
        return proxy(Connection.class, (method, args) -> {
            if (!method.getName().equals("prepareStatement")) return empty(method.getReturnType());
            String sql = (String) args[0];
            if (sql.startsWith("ALTER ")) return proxy(PreparedStatement.class, (member, values) -> {
                if (member.getName().equals("execute")) {
                    assertEquals("ALTER PACKAGE \"SCOTT\".\"P_TEST\" COMPILE DEBUG BODY", sql);
                    ddl.incrementAndGet();
                    if (scenario.equals("connection_failure")) throw new SQLRecoverableException("lost DDL response", "08000");
                }
                if (member.getName().equals("close")) {
                    statementCloses.incrementAndGet();
                    if (scenario.equals("close_failure")) throw new SQLException("close failed");
                }
                return empty(member.getReturnType());
            });
            if (sql.contains("ALL_PLSQL_OBJECT_SETTINGS")) return compileRows(List.of(List.of("FALSE", "2")));
            if (sql.contains("ALL_ERRORS")) {
                if (scenario.equals("diagnostics_failure")) return proxy(PreparedStatement.class, (member, values) -> {
                    if (member.getName().equals("executeQuery")) throw new SQLException("diagnostics denied", "42000", 1031);
                    return empty(member.getReturnType());
                });
                return compileRows(List.of(List.of("1", "3", "4", "missing identifier", "ERROR", "201")));
            }
            if (ddl.get() > 0 && sql.contains("ALL_OBJECTS") && !sql.contains("JOIN SYS.ALL_SOURCE")) return compileRows(List.of(List.of("123", "INVALID")));
            return jdbc.query(sql);
        });
    }

    private static PreparedStatement compileRows(List<List<String>> values) {
        return proxy(PreparedStatement.class, (method, args) -> {
            if (!method.getName().equals("executeQuery")) return empty(method.getReturnType());
            int[] cursor = {-1};
            return proxy(ResultSet.class, (member, index) -> switch (member.getName()) {
                case "next" -> ++cursor[0] < values.size();
                case "getString" -> values.get(cursor[0]).get((int) index[0] - 1);
                default -> empty(member.getReturnType());
            });
        });
    }
    static PlDebugStartRequest target(String type, String name, String packageName) {
        var request = new PlDebugStartRequest();
        request.setObjectType(type); request.setObjectName(name); request.setPackageName(packageName);
        return request;
    }

    @Test void preservesExactIdentifiersAndNeverCompilesAPackageSpecification() {
        var procedure = PlDebugCompile.unit(" owner.\" ", target("PROCEDURE", " p.\" ", null));
        assertEquals("ALTER PROCEDURE \" owner.\"\" \".\" p.\"\" \" COMPILE DEBUG REUSE SETTINGS", procedure.sql());
        var packaged = PlDebugCompile.unit("APP", target("FUNCTION", "member", " p.\" "));
        assertEquals("PACKAGE BODY", packaged.objectType());
        assertEquals(" p.\" ", packaged.name());
        assertEquals("ALTER PACKAGE \"APP\".\" p.\"\" \" COMPILE DEBUG BODY", packaged.sql());
        assertFalse(packaged.reusesSettings());
        assertTrue(PlDebugCompile.unit("APP", target("FUNCTION", "F", null)).reusesSettings());
        assertThrows(IllegalArgumentException.class, () -> PlDebugCompile.unit("APP", target("ANONYMOUS", null, null)));
    }

    @Test void observesDebugFlagWithoutRequiringOptimizationLevelOne() throws Exception {
        assertEquals("ready", settings("TRUE", "2", null).get("state"));
        assertEquals("requires_compile", settings("FALSE", "2", null).get("state"));
        assertEquals("unknown", settings(null, "1", null).get("state"));
        assertEquals("unknown", settings(null, null, new SQLException("view unavailable", "42S02", 942)).get("state"));
        assertThrows(SQLRecoverableException.class, () -> settings(null, null, new SQLRecoverableException("connection lost", "08000")));
    }

    @Test void compilationPolicyCannotStartOrResolveATargetAndRejectsAnonymousInspection() {
        var agent = new OceanBaseOracleAgent();
        var request = target("PROCEDURE", "P", null);
        request.setMetadataPreparation("debug_compile");
        assertThrows(IllegalArgumentException.class, () -> agent.plDebugStart(request));
        assertThrows(IllegalArgumentException.class, () -> agent.plDebugResolveTarget(request));
        request.setObjectType("ANONYMOUS");
        assertThrows(IllegalArgumentException.class, () -> agent.plDebugInspect(request));
        request.setObjectType("PROCEDURE");
        request.setObjectName("");
        assertThrows(IllegalArgumentException.class, () -> agent.plDebugInspect(request));
    }

    private Map<String, Object> settings(String debug, String level, SQLException failure) throws Exception {
        var row = new AtomicInteger();
        Connection connection = proxy(Connection.class, (method, args) -> {
            assertEquals("prepareStatement", method.getName());
            return proxy(PreparedStatement.class, (member, values) -> {
                if (member.getName().equals("executeQuery")) {
                    if (failure != null) throw failure;
                    return proxy(ResultSet.class, (field, index) -> switch (field.getName()) {
                        case "next" -> row.getAndIncrement() == 0;
                        case "getString" -> (int) index[0] == 1 ? debug : level;
                        default -> empty(field.getReturnType());
                    });
                }
                return empty(member.getReturnType());
            });
        });
        return PlDebugCompile.settings(connection, PlDebugCompile.unit("APP", target("PROCEDURE", "P", null)));
    }
}
