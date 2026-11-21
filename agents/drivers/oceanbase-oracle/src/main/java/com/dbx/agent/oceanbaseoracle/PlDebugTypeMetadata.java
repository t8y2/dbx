package com.dbx.agent.oceanbaseoracle;

import java.math.BigInteger;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLNonTransientConnectionException;
import java.sql.SQLRecoverableException;
import java.sql.SQLTimeoutException;
import java.sql.SQLTransientConnectionException;
import java.util.LinkedHashSet;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.TimeUnit;

final class PlDebugTypeMetadata {
    private static final int MAX_OWNER_CANDIDATES = 64;
    private static final String CONTEXT_SQL = "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA'),"
        + "SYS_CONTEXT('USERENV','CURRENT_SCHEMAID'),SYS_CONTEXT('USERENV','SESSION_USER'),"
        + "SYS_CONTEXT('USERENV','CURRENT_USER') FROM DUAL";

    private record Context(String schema, BigInteger schemaId, String sessionUser, String currentUser) {
        boolean sameIdentity(Context other) {
            return sessionUser.equals(other.sessionUser) && currentUser.equals(other.currentUser);
        }
    }

    static String resolveOwner(Connection connection, String packageName, String encodedOwner, long deadlineNanos) throws SQLException {
        return resolveObjectOwner(connection, packageName, encodedOwner, deadlineNanos, "PACKAGE");
    }

    static String resolveSqlTypeOwner(Connection connection, String typeName, String encodedOwner, long deadlineNanos) throws SQLException {
        return resolveObjectOwner(connection, typeName, encodedOwner, deadlineNanos, "TYPE");
    }

    private static String resolveObjectOwner(Connection connection, String packageName, String encodedOwner, long deadlineNanos, String objectType) throws SQLException {
        BigInteger ownerId = schemaId(encodedOwner, true);
        Set<String> candidates = new LinkedHashSet<>();
        try (PreparedStatement statement = prepare(connection,
            "SELECT OWNER, OBJECT_NAME FROM SYS.ALL_OBJECTS WHERE OBJECT_TYPE='" + objectType + "' AND OBJECT_NAME=?", deadlineNanos)) {
            statement.setString(1, packageName);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    remainingSeconds(deadlineNanos);
                    String owner = rows.getString(1);
                    if (!Objects.equals(packageName, rows.getString(2))) continue;
                    if (owner == null || owner.isEmpty()) throw new SQLException("Incomplete type container owner metadata");
                    candidates.add(owner);
                    if (candidates.size() > MAX_OWNER_CANDIDATES) throw new SQLException("Type owner candidate budget exceeded");
                }
            }
        }
        if (candidates.isEmpty()) throw new SQLException("Type owner unresolved: no visible type container candidates");
        Context original = context(connection, deadlineNanos);
        Set<String> matches = new LinkedHashSet<>();
        long verificationDeadline = deadlineNanos - TimeUnit.SECONDS.toNanos(1);
        for (String candidate : candidates) {
            SQLException failure = null;
            try {
                setSchema(connection, candidate, verificationDeadline);
                Context current = context(connection, verificationDeadline);
                if (!candidate.equals(current.schema()) || !original.sameIdentity(current)) {
                    throw new SQLException("Type owner schema or user identity changed during verification");
                }
                if (ownerId.equals(current.schemaId())) matches.add(candidate);
            } catch (SQLException error) {
                failure = error;
                throw error;
            } finally {
                if (failure == null || !uncertain(failure)) {
                    try {
                        setSchema(connection, original.schema(), deadlineNanos);
                        if (!original.equals(context(connection, deadlineNanos))) {
                            throw new SQLException("Original metadata schema restoration was not confirmed");
                        }
                    } catch (SQLException restoreError) {
                        if (failure != null) failure.addSuppressed(restoreError);
                        else throw restoreError;
                    }
                }
            }
        }
        if (matches.size() != 1) throw new SQLException(matches.isEmpty()
            ? "Type owner unresolved: no verified schema ID match"
            : "Contradictory schema identity for the declared type owner");
        return matches.iterator().next();
    }

    private static Context context(Connection connection, long deadlineNanos) throws SQLException {
        try (PreparedStatement statement = prepare(connection, CONTEXT_SQL, deadlineNanos);
             ResultSet rows = statement.executeQuery()) {
            if (!rows.next()) throw new SQLException("Metadata session identity was not returned");
            String schema = rows.getString(1);
            BigInteger id = schemaId(rows.getString(2), false);
            String sessionUser = rows.getString(3);
            String currentUser = rows.getString(4);
            if (schema == null || schema.isEmpty() || sessionUser == null || currentUser == null || rows.next()) {
                throw new SQLException("Incomplete metadata session identity");
            }
            return new Context(schema, id, sessionUser, currentUser);
        }
    }

    private static void setSchema(Connection connection, String schema, long deadlineNanos) throws SQLException {
        try (PreparedStatement statement = prepare(connection,
            "ALTER SESSION SET CURRENT_SCHEMA=\"" + schema.replace("\"", "\"\"") + "\"", deadlineNanos)) {
            statement.execute();
        }
    }

    static PreparedStatement prepare(Connection connection, String sql, long deadlineNanos) throws SQLException {
        int seconds = remainingSeconds(deadlineNanos);
        PreparedStatement statement = connection.prepareStatement(sql);
        try {
            statement.setQueryTimeout(seconds);
            return statement;
        } catch (SQLException error) {
            try { statement.close(); } catch (SQLException closeError) { error.addSuppressed(closeError); }
            throw error;
        }
    }

    static int remainingSeconds(long deadlineNanos) throws SQLTimeoutException {
        long remaining = deadlineNanos - System.nanoTime();
        if (Thread.currentThread().isInterrupted() || remaining <= 0) throw new SQLTimeoutException("Type metadata preparation was cancelled or exhausted its deadline");
        return (int) Math.min(PlDebugNative.CALL_TIMEOUT_SECONDS,
            Math.max(1, TimeUnit.NANOSECONDS.toSeconds(remaining) + (remaining % TimeUnit.SECONDS.toNanos(1) == 0 ? 0 : 1)));
    }

    private static BigInteger schemaId(String encoded, boolean padded) throws SQLException {
        if (encoded == null || !encoded.matches(padded ? "[0-9]+ *" : "[0-9]+")) {
            throw new SQLException("Invalid numeric type schema identity");
        }
        int end = encoded.length();
        while (end > 0 && encoded.charAt(end - 1) == ' ') end--;
        return new BigInteger(encoded.substring(0, end));
    }

    private static boolean uncertain(SQLException error) {
        for (Throwable current = error; current != null; current = current.getCause()) {
            if (current instanceof SQLTimeoutException || current instanceof SQLRecoverableException
                || current instanceof SQLNonTransientConnectionException || current instanceof SQLTransientConnectionException) return true;
            if (current instanceof SQLException sql && sql.getSQLState() != null
                && (sql.getSQLState().startsWith("08") || sql.getSQLState().startsWith("HYT"))) return true;
        }
        return false;
    }

    private PlDebugTypeMetadata() {}
}
