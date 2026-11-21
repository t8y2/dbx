package com.dbx.agent.oceanbaseoracle;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

final class PlDebugSource {
    record Reference(String id, long sourceRevision, long stopRevision, int nativeFrameId,
                     String lineBasis, String identityState, String evidenceKind, String objectType,
                     String source, int lineOffset, String owner, String name, String objectId, int namespace) {}

    static Reference reference(Version version, PlDebugNative.Frame frame, String id, long stopRevision) {
        return reference(version, frame, id, stopRevision, null);
    }

    static Reference reference(Version version, PlDebugNative.Frame frame, String id, long stopRevision,
                               PlDebugTarget.Candidate target) {
        String program = version == null ? null : version.name();
        if (target != null) {
            if (version == null || !Objects.equals(target.owner(), version.owner())) return null;
            if (target.packageName() == null) {
                if (!Objects.equals(target.name(), version.name()) || !Objects.equals(target.objectType(), version.objectType())
                    || !Objects.equals(target.objectId(), version.objectId())) return null;
            } else {
                if (!"PACKAGE BODY".equals(version.objectType()) || !Objects.equals(target.packageName(), version.name())
                    || !target.packageName().matches("[A-Z][A-Z0-9_$#]*") || !target.name().matches("[A-Z][A-Z0-9_$#]*")) return null;
                if (Objects.equals(frame.program(), target.program())) program = target.program();
                else if (Objects.equals(frame.program(), target.packageName() + ".__init__")) program = target.packageName() + ".__init__";
                else return null;
            }
        }
        if (version == null || !"candidate".equals(version.state()) || !"native".equals(frame.identityState())
            || !Objects.equals(version.owner(), frame.owner()) || !Objects.equals(program, frame.program())
            || frame.namespace() == null || frame.line() == null || frame.line() <= 0 || frame.line() > version.lines().size()) return null;
        int namespace = "PACKAGE BODY".equals(version.objectType()) ? 2 : 1;
        if (frame.namespace() != namespace) return null;
        return new Reference(id, 1, stopRevision, frame.nativeFrameId(), "all_source", "native", "backtrace",
            version.objectType(), version.text(), 0, version.owner(), version.name(), version.objectId(), namespace);
    }

    record Line(int number, String text) {}
    record Version(String owner, String name, String objectType, String objectId,
                   String status, String lastDdl, String state, List<Line> lines) {
        Version { lines = List.copyOf(lines); }
        String text() { return lines.stream().map(Line::text).collect(java.util.stream.Collectors.joining()); }
    }

    static Version load(Connection connection, PlDebugTarget.Candidate target) throws SQLException {
        String name = target.packageName() == null ? target.name() : target.packageName();
        String type = target.packageName() == null ? target.objectType() : "PACKAGE BODY";
        return load(connection, target.owner(), name, type,
            target.packageName() == null ? target.objectId() : null);
    }

    static Version load(Connection connection, String owner, String name, String type,
                        String expectedObjectId) throws SQLException {
        return load(connection, owner, name, type, expectedObjectId, 0, Long.MAX_VALUE, Integer.MAX_VALUE);
    }

    static Version load(Connection connection, String owner, String name, String type,
                        String expectedObjectId, long deadlineNanos, long maxBytes, int maxLines) throws SQLException {
        checkDeadline(deadlineNanos);
        String sql = "SELECT o.OBJECT_ID, o.STATUS, TO_CHAR(o.LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS'), s.LINE, s.TEXT "
            + "FROM SYS.ALL_OBJECTS o LEFT JOIN SYS.ALL_SOURCE s "
            + "ON s.OWNER = o.OWNER AND s.NAME = o.OBJECT_NAME AND s.TYPE = o.OBJECT_TYPE "
            + "WHERE o.OWNER = ? AND o.OBJECT_NAME = ? AND o.OBJECT_TYPE = ? ORDER BY s.LINE";
        List<Line> lines = new ArrayList<>();
        String objectId = null;
        String status = null;
        String lastDdl = null;
        boolean found = false;
        boolean noSource = false;
        long bytes = 0;
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            int timeout = PlDebugNative.CALL_TIMEOUT_SECONDS;
            if (deadlineNanos != 0) {
                long remaining = deadlineNanos - System.nanoTime();
                if (remaining <= 0) throw new java.sql.SQLTimeoutException("Debug source read deadline exceeded");
                timeout = (int) Math.min(timeout, 1 + (remaining - 1) / 1_000_000_000L);
            }
            statement.setQueryTimeout(timeout);
            statement.setString(1, owner);
            statement.setString(2, name);
            statement.setString(3, type);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    checkDeadline(deadlineNanos);
                    String id = rows.getString(1);
                    String rowStatus = rows.getString(2);
                    String ddl = rows.getString(3);
                    if (id == null || id.isEmpty() || expectedObjectId != null && !expectedObjectId.equals(id)) {
                        throw new SQLException("Debug source object identity is missing or changed");
                    }
                    if (found && (!id.equals(objectId) || !Objects.equals(status, rowStatus) || !Objects.equals(lastDdl, ddl))) {
                        throw new SQLException("Debug source contains conflicting object metadata");
                    }
                    objectId = id;
                    status = rowStatus;
                    lastDdl = ddl;
                    found = true;
                    int number = rows.getInt(4);
                    boolean missingLine = rows.wasNull();
                    String text = rows.getString(5);
                    if (missingLine) {
                        if (noSource || !lines.isEmpty() || text != null) throw new SQLException("Debug source has an incomplete line identity");
                        noSource = true;
                    } else {
                        if (noSource || number != lines.size() + 1 || text == null) {
                            throw new SQLException("Debug source has missing, duplicate or incomplete lines");
                        }
                        if (maxBytes != Long.MAX_VALUE) {
                            bytes += text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                            if (bytes > maxBytes) throw new SQLException("Debug source byte budget exceeded");
                        }
                        int start = 0;
                        do {
                            if (lines.size() >= maxLines) throw new SQLException("Debug source line budget exceeded");
                            int newline = text.indexOf('\n', start);
                            int end = newline < 0 ? text.length() : newline + 1;
                            lines.add(new Line(lines.size() + 1, text.substring(start, end)));
                            start = end;
                        } while (start < text.length());
                    }
                }
            }
        }
        checkDeadline(deadlineNanos);
        return new Version(owner, name, type, objectId, status, lastDdl,
            !found ? "not_visible" : lines.isEmpty() ? "source_unavailable" : "candidate", lines);
    }

    private static void checkDeadline(long deadlineNanos) throws java.sql.SQLTimeoutException {
        if (deadlineNanos != 0 && System.nanoTime() >= deadlineNanos) {
            throw new java.sql.SQLTimeoutException("Debug source read deadline exceeded");
        }
    }
}
