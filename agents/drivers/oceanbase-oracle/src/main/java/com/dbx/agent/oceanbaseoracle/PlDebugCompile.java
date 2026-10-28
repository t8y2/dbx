package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.PlDebugStartRequest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.List;
import java.util.ArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import com.google.gson.Gson;
import com.google.gson.JsonElement;

final class PlDebugCompile {
    record Unit(String owner, String name, String objectType, String sql, boolean reusesSettings) {}

    static final class Manager {
        private static final Gson JSON = new Gson();
        private final Map<String, Operation> operations = new LinkedHashMap<>();
        private final Object admission;
        private final BooleanSupplier debuggerBusy;

        Manager() { this(new Object(), () -> false); }
        Manager(Object admission, BooleanSupplier debuggerBusy) {
            this.admission = admission;
            this.debuggerBusy = debuggerBusy;
        }

        boolean hasUnresolved() {
            synchronized (operations) {
                return operations.values().stream().map(Operation::snapshot).anyMatch(receipt ->
                    !Boolean.TRUE.equals(receipt.get("finished")) || !"released".equals(receipt.get("releaseState"))
                        || "unknown".equals(receipt.get("ddlState")));
            }
        }

        Map<String, Object> execute(String operationId, PlDebugStartRequest target, Map<String, Object> preview,
                                    PlDebugManager.OwnerFactory owners) {
            if (operationId == null || !operationId.matches("[A-Za-z0-9_-]{1,128}")) {
                throw new IllegalArgumentException("A stable compilation operationId is required");
            }
            if (target == null || preview == null) throw new IllegalArgumentException("A confirmed compilation preview is required");
            JsonElement content = JSON.toJsonTree(Map.of("target", target, "preview", preview));
            Operation operation;
            synchronized (admission) { synchronized (operations) {
                operation = operations.get(operationId);
                if (operation != null) {
                    if (!operation.content.equals(content)) throw new IllegalArgumentException("The compilation operationId belongs to a different request");
                    return operation.snapshot();
                }
                if (operations.size() >= PlDebugManager.MAX_STARTS) throw new IllegalStateException("Compilation receipt capacity reached; original receipts were retained");
                if (hasUnresolved() || debuggerBusy.getAsBoolean()) {
                    throw new IllegalStateException("The original compilation must be resolved and released before another operation");
                }
                operation = new Operation(operationId, content, target, preview);
                operations.put(operationId, operation);
            } }
            return operation.run(owners);
        }

        Map<String, Object> status(String operationId) {
            synchronized (operations) {
                Operation operation = operations.get(operationId);
                if (operation == null) throw new IllegalArgumentException("The original compilation operation was not found");
                return operation.snapshot();
            }
        }
    }

    private static final class Operation {
        final String id;
        final JsonElement content;
        final Execution execution;
        private volatile PlDebugMetadataInspection.Scope scope;
        private volatile String resourceError;
        private volatile String cleanupError;
        private volatile boolean finished;

        Operation(String id, JsonElement content, PlDebugStartRequest target, Map<String, Object> preview) {
            this.id = id;
            this.content = content.deepCopy();
            this.execution = new Execution(target, preview);
        }

        Map<String, Object> snapshot() {
            Map<String, Object> result = new LinkedHashMap<>(execution.snapshot());
            result.put("operationId", id);
            result.put("finished", finished);
            PlDebugMetadataInspection.Scope current = scope;
            result.put("releaseState", current != null && current.released() ? "released" : "unconfirmed");
            if (resourceError != null) result.put("resourceError", resourceError);
            if (cleanupError != null) result.put("cleanupError", cleanupError);
            return java.util.Collections.unmodifiableMap(result);
        }

        Map<String, Object> run(PlDebugManager.OwnerFactory owners) {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(PlDebugNative.CALL_TIMEOUT_SECONDS);
            PlDebugMetadataInspection.Scope current = new PlDebugMetadataInspection.Scope();
            scope = current;
            try {
                Connection connection = current.open(owners, deadline);
                execution.run(connection, deadline, current);
            } catch (Exception error) {
                resourceError = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
            } finally {
                current.finishReading();
                try { current.cleanup(deadline); }
                catch (Exception error) { cleanupError = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage(); }
                finished = true;
            }
            return snapshot();
        }
    }

    static final class Execution {
        private static final Gson JSON = new Gson();
        private final PlDebugStartRequest target;
        private final JsonElement confirmedPreview;
        private final AtomicBoolean started = new AtomicBoolean();
        private volatile Map<String, Object> receipt = Map.of("dispatched", false, "ddlState", "not_started");
        private volatile PreparedStatement pendingStatement;

        Execution(PlDebugStartRequest target, Map<String, Object> confirmedPreview) {
            this.target = JSON.fromJson(JSON.toJsonTree(target), PlDebugStartRequest.class);
            this.confirmedPreview = JSON.toJsonTree(confirmedPreview);
        }

        Map<String, Object> snapshot() { return receipt; }

        private void update(String key, Object value) {
            Map<String, Object> next = new LinkedHashMap<>(receipt);
            next.put(key, value);
            receipt = java.util.Collections.unmodifiableMap(next);
        }

        Map<String, Object> run(Connection connection, long deadlineNanos) {
            return run(connection, deadlineNanos, null);
        }

        Map<String, Object> run(Connection connection, long deadlineNanos, PlDebugMetadataInspection.Scope scope) {
            if (!started.compareAndSet(false, true)) return snapshot();
            PreparedStatement statement = null;
            boolean closeAllowed = true;
            try {
                Map<String, Object> current = preview(connection, target, deadlineNanos);
                if (!Boolean.TRUE.equals(current.get("canCompile")) || !confirmedPreview.equals(JSON.toJsonTree(current))) {
                    throw new SQLException("The debug compilation target changed after confirmation; refresh its preview");
                }
                Unit unit = unit((String) current.get("schema"), target);
                statement = PlDebugTypeMetadata.prepare(connection, unit.sql(), deadlineNanos);
                pendingStatement = statement;
                if (scope != null) scope.check(deadlineNanos);
                Map<String, Object> dispatched = new LinkedHashMap<>(receipt);
                dispatched.put("dispatched", true);
                dispatched.put("ddlState", "unknown");
                receipt = java.util.Collections.unmodifiableMap(dispatched);
                closeAllowed = false;
                try {
                    statement.execute();
                    update("ddlState", "executed");
                    closeAllowed = true;
                } catch (SQLException error) {
                    update("ddlError", error.getMessage());
                    closeAllowed = !PlDebugNative.connectionUnsafe(error);
                    if (closeAllowed) update("ddlState", "failed");
                }
                if ("executed".equals(receipt.get("ddlState"))) {
                    try {
                        Map<String, Object> observed = readback(connection, unit, deadlineNanos);
                        update("readback", observed);
                        if (Boolean.TRUE.equals(observed.get("connectionUnsafe"))) closeAllowed = false;
                    }
                    catch (SQLException error) {
                        if (PlDebugNative.connectionUnsafe(error)) closeAllowed = false;
                        update("readbackError", error.getMessage());
                    }
                }
            } catch (SQLException | RuntimeException error) {
                update("error", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
            } finally {
                if (statement != null && closeAllowed) {
                    try { statement.close(); pendingStatement = null; }
                    catch (SQLException error) { update("statementCloseError", error.getMessage()); }
                }
                update("statementReleaseState", pendingStatement == null ? "released" : "unconfirmed");
            }
            return snapshot();
        }
    }

    static Map<String, Object> readback(Connection connection, Unit unit, long deadlineNanos) throws SQLException {
        Map<String, Object> result = new LinkedHashMap<>();
        String objectSql = "SELECT OBJECT_ID, STATUS FROM SYS.ALL_OBJECTS WHERE OWNER = ? AND OBJECT_NAME = ? AND OBJECT_TYPE = ?";
        try (PreparedStatement statement = PlDebugTypeMetadata.prepare(connection, objectSql, deadlineNanos)) {
            statement.setString(1, unit.owner()); statement.setString(2, unit.name()); statement.setString(3, unit.objectType());
            try (ResultSet rows = statement.executeQuery()) {
                if (rows.next()) {
                    result.put("objectId", rows.getString(1)); result.put("status", rows.getString(2));
                    if (rows.next()) throw new SQLException("Debug compilation readback has an ambiguous object identity");
                } else result.put("status", "not_visible");
            }
        }
        List<Map<String, Object>> diagnostics = new ArrayList<>();
        String errorsSql = "SELECT SEQUENCE, LINE, POSITION, TEXT, ATTRIBUTE, MESSAGE_NUMBER FROM SYS.ALL_ERRORS WHERE OWNER = ? AND NAME = ? AND TYPE = ? ORDER BY SEQUENCE";
        boolean complete = true;
        long bytes = 0;
        try (PreparedStatement statement = PlDebugTypeMetadata.prepare(connection, errorsSql, deadlineNanos)) {
            statement.setString(1, unit.owner()); statement.setString(2, unit.name()); statement.setString(3, unit.objectType());
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    PlDebugTypeMetadata.remainingSeconds(deadlineNanos);
                    Map<String, Object> diagnostic = new LinkedHashMap<>();
                    for (int index = 1; index <= 6; index++) {
                        String value = rows.getString(index);
                        diagnostic.put(List.of("sequence", "line", "position", "text", "attribute", "messageNumber").get(index - 1), value);
                        if (value != null) bytes += value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                    }
                    if (diagnostics.size() >= 8192 || bytes > 1_048_576) { complete = false; break; }
                    diagnostics.add(java.util.Collections.unmodifiableMap(diagnostic));
                }
            }
        } catch (SQLException error) {
            complete = false;
            result.put("diagnosticsError", error.getMessage());
            if (PlDebugNative.connectionUnsafe(error)) result.put("connectionUnsafe", true);
        }
        result.put("diagnostics", List.copyOf(diagnostics));
        result.put("diagnosticsComplete", complete);
        if (!Boolean.TRUE.equals(result.get("connectionUnsafe"))) {
            try { result.put("settings", settings(connection, unit, deadlineNanos)); }
            catch (SQLException error) {
                result.put("settingsError", error.getMessage());
                if (PlDebugNative.connectionUnsafe(error)) result.put("connectionUnsafe", true);
            }
        }
        return java.util.Collections.unmodifiableMap(result);
    }

    static Map<String, Object> inspect(Connection connection, PlDebugStartRequest target, long deadlineNanos) throws SQLException {
        Map<String, Object> preview = preview(connection, target, deadlineNanos);
        Unit unit = unit((String) preview.get("schema"), target);
        Map<String, Object> observation = new LinkedHashMap<>();
        observation.put("schema", unit.owner());
        observation.put("objectName", unit.name());
        observation.put("objectType", unit.objectType());
        try { observation.put("readback", readback(connection, unit, deadlineNanos)); }
        catch (SQLException error) { observation.put("error", error.getMessage()); }
        return Map.of("compilePreview", preview, "compileObservation", observation);
    }

    static Map<String, Object> preview(Connection connection, PlDebugStartRequest target, long deadlineNanos) throws SQLException {
        Unit unit = unit(PlDebugTarget.owner(connection, target.getSchema()), target);
        List<PlDebugSource.Version> sources = sources(connection, unit, deadlineNanos);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("schema", unit.owner());
        result.put("objectName", unit.name());
        result.put("objectType", unit.objectType());
        result.put("sql", unit.sql());
        result.put("reusesSettings", unit.reusesSettings());
        result.put("sources", sources);
        if (sources.stream().anyMatch(source -> !"candidate".equals(source.state())
            || !("VALID".equals(source.status()) || "INVALID".equals(source.status())))) {
            result.put("canCompile", false);
            result.put("state", "source_unavailable");
            return result;
        }
        List<Map<String, Object>> signatures = PlDebugTarget.compileSignatures(connection, unit.owner(), target, deadlineNanos);
        Map<String, Object> settings = settings(connection, unit, deadlineNanos);
        if (!sources.equals(sources(connection, unit, deadlineNanos))
            || !signatures.equals(PlDebugTarget.compileSignatures(connection, unit.owner(), target, deadlineNanos))) {
            throw new SQLException("The debug compilation target changed while preparing its preview");
        }
        if (deadlineNanos != 0 && System.nanoTime() >= deadlineNanos) throw new java.sql.SQLTimeoutException("Debug compilation preview deadline exceeded");
        result.put("signatures", signatures);
        result.put("settings", settings);
        result.put("canCompile", true);
        result.put("state", "available");
        return result;
    }

    private static List<PlDebugSource.Version> sources(Connection connection, Unit unit, long deadlineNanos) throws SQLException {
        List<PlDebugSource.Version> result = new ArrayList<>();
        long remainingBytes = 1_048_576;
        int remainingLines = 8192;
        for (String type : "PACKAGE BODY".equals(unit.objectType()) ? List.of("PACKAGE BODY", "PACKAGE") : List.of(unit.objectType())) {
            PlDebugSource.Version source = PlDebugSource.load(connection, unit.owner(), unit.name(), type, null,
                deadlineNanos, remainingBytes, remainingLines);
            remainingBytes -= source.text().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
            remainingLines -= source.lines().size();
            result.add(source);
        }
        return List.copyOf(result);
    }

    static Unit unit(String owner, PlDebugStartRequest target) {
        if (owner == null || owner.isEmpty() || target == null || target.getObjectName() == null
            || target.getObjectName().isEmpty()
            || !("PROCEDURE".equals(target.getObjectType()) || "FUNCTION".equals(target.getObjectType()))) {
            throw new IllegalArgumentException("Debug compilation requires an exact named procedure or function");
        }
        String packageName = target.getPackageName();
        boolean packaged = packageName != null && !packageName.isEmpty();
        String name = packaged ? packageName : target.getObjectName();
        String type = packaged ? "PACKAGE BODY" : target.getObjectType();
        String sql = "ALTER " + (packaged ? "PACKAGE" : type) + " " + quote(owner) + "." + quote(name)
            + " COMPILE DEBUG" + (packaged ? " BODY" : " REUSE SETTINGS");
        return new Unit(owner, name, type, sql, !packaged);
    }

    static Map<String, Object> settings(Connection connection, Unit unit) throws SQLException {
        return settings(connection, unit, 0);
    }

    private static Map<String, Object> settings(Connection connection, Unit unit, long deadlineNanos) throws SQLException {
        String sql = "SELECT PLSQL_DEBUG, PLSQL_OPTIMIZE_LEVEL FROM SYS.ALL_PLSQL_OBJECT_SETTINGS WHERE OWNER = ? AND NAME = ? AND TYPE = ?";
        try (PreparedStatement statement = deadlineNanos == 0 ? connection.prepareStatement(sql) : PlDebugTypeMetadata.prepare(connection, sql, deadlineNanos)) {
            if (deadlineNanos == 0) statement.setQueryTimeout(PlDebugNative.CALL_TIMEOUT_SECONDS);
            statement.setString(1, unit.owner());
            statement.setString(2, unit.name());
            statement.setString(3, unit.objectType());
            try (ResultSet rows = statement.executeQuery()) {
                if (!rows.next()) return Map.of("state", "unknown", "reason", "not_visible");
                String debug = rows.getString(1);
                String level = rows.getString(2);
                if (rows.next()) throw new SQLException("Debug compilation settings have an ambiguous object identity");
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("state", "TRUE".equalsIgnoreCase(debug) ? "ready" : "FALSE".equalsIgnoreCase(debug) ? "requires_compile" : "unknown");
                result.put("plsqlDebug", debug);
                result.put("optimizeLevel", level);
                return result;
            }
        } catch (SQLException error) {
            if (PlDebugNative.connectionUnsafe(error)) throw error;
            if (error.getErrorCode() != 942 && error.getErrorCode() != 1031 && error.getErrorCode() != 904) throw error;
            return Map.of("state", "unknown", "reason", "settings_unavailable", "vendorCode", error.getErrorCode());
        }
    }

    private static String quote(String name) { return '"' + name.replace("\"", "\"\"") + '"'; }
}
