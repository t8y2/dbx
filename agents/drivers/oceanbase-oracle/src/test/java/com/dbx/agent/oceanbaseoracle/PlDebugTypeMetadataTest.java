package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugTypeMetadataTest {
    private static long deadline() { return System.nanoTime() + TimeUnit.SECONDS.toNanos(30); }

    @Test
    void resolvesSqlTypeOwnersInTheTypeNamespaceAndRestoresTheOriginalSchema() throws Exception {
        Jdbc jdbc = new Jdbc();
        jdbc.ids.put(" Exact.Type Owner ", "201006");
        assertEquals(" Exact.Type Owner ", PlDebugTypeMetadata.resolveSqlTypeOwner(jdbc.connection(),jdbc.pack,"201006   ",deadline()));
        assertEquals("READER",jdbc.schema);
        assertTrue(jdbc.sql.getFirst().contains("OBJECT_TYPE='TYPE'"));
        assertFalse(jdbc.sql.getFirst().contains("OBJECT_TYPE='PACKAGE'"));
        assertEquals(jdbc.pack,jdbc.boundPackage);
    }

    @Test
    void provesTheExactQuotedOwnerAndRestoresTheOriginalContext() throws Exception {
        Jdbc jdbc = new Jdbc();
        jdbc.ids.put(" Mixed.\" Owner ", "201006");
        assertEquals(" Mixed.\" Owner ", PlDebugTypeMetadata.resolveOwner(jdbc.connection(), jdbc.pack, "201006   ", deadline()));
        assertEquals("READER", jdbc.schema);
        assertTrue(jdbc.sql.contains("ALTER SESSION SET CURRENT_SCHEMA=\" Mixed.\"\" Owner \""));
        assertEquals(jdbc.pack, jdbc.boundPackage);
    }

    @Test
    void doesNotGuessTheCurrentOrTargetOwnerWhenCandidatesAreMissing() {
        Jdbc jdbc = new Jdbc();
        jdbc.ids.clear();
        assertThrows(SQLException.class, () -> PlDebugTypeMetadata.resolveOwner(jdbc.connection(), jdbc.pack, "201006", deadline()));
        assertEquals(0, jdbc.alters);
    }

    @Test
    void rejectsMalformedIdsBeforeAnyDatabaseCall() {
        Jdbc jdbc = new Jdbc();
        for (String id : List.of(" 201006", "201006\t", "2.01006E5", "201006.0", "-1")) {
            assertThrows(SQLException.class, () -> PlDebugTypeMetadata.resolveOwner(jdbc.connection(), jdbc.pack, id, deadline()));
        }
        assertTrue(jdbc.sql.isEmpty());
    }

    @Test
    void restoresAfterAConclusiveReadFailureWithoutScanningTheNextCandidate() {
        Jdbc jdbc = new Jdbc();
        jdbc.readFailure = new SQLException("metadata denied", "42000");
        SQLException error = assertThrows(SQLException.class, () -> PlDebugTypeMetadata.resolveOwner(jdbc.connection(), jdbc.pack, "201006", deadline()));
        assertEquals("metadata denied", error.getMessage());
        assertEquals("READER", jdbc.schema);
        assertEquals(2, jdbc.alters);
    }

    @Test
    void doesNotSendRestoreSqlAfterAnUncertainTimeout() {
        Jdbc jdbc = new Jdbc();
        jdbc.readFailure = new SQLTimeoutException("in flight");
        assertThrows(SQLTimeoutException.class, () -> PlDebugTypeMetadata.resolveOwner(jdbc.connection(), jdbc.pack, "201006", deadline()));
        assertEquals(1, jdbc.alters);
        assertNotEquals("READER", jdbc.schema);
    }

    @Test
    void doesNotPublishAnOwnerWhenRestorationFails() {
        Jdbc jdbc = new Jdbc();
        jdbc.restoreFailure = true;
        assertThrows(SQLException.class, () -> PlDebugTypeMetadata.resolveOwner(jdbc.connection(), jdbc.pack, "1", deadline()));
        assertEquals(2, jdbc.alters);
    }

    @Test
    void preservesBothTheOriginalReadErrorAndTheRestorationFailure() {
        Jdbc jdbc = new Jdbc();
        jdbc.readFailure = new SQLException("metadata denied", "42000");
        jdbc.restoreFailure = true;
        SQLException error = assertThrows(SQLException.class, () -> PlDebugTypeMetadata.resolveOwner(jdbc.connection(), jdbc.pack, "1", deadline()));
        assertEquals("metadata denied", error.getMessage());
        assertEquals(1, error.getSuppressed().length);
        assertEquals("restore failed", error.getSuppressed()[0].getMessage());
    }

    @Test
    void rejectsContradictoryOwnersInsteadOfTakingTheFirstMatch() {
        Jdbc jdbc = new Jdbc();
        jdbc.ids.replaceAll((owner, id) -> "201006");
        assertThrows(SQLException.class, () -> PlDebugTypeMetadata.resolveOwner(jdbc.connection(), jdbc.pack, "201006", deadline()));
        assertEquals("READER", jdbc.schema);
        assertEquals(4, jdbc.alters);
    }

    @Test
    void refusesAnExpiredDeadlineWithoutOpeningAStatement() {
        Jdbc jdbc = new Jdbc();
        assertThrows(SQLTimeoutException.class, () -> PlDebugTypeMetadata.resolveOwner(jdbc.connection(), jdbc.pack, "1", System.nanoTime() - 1));
        assertTrue(jdbc.sql.isEmpty());
    }

    private static final class Jdbc {
        final String pack = " P.\"kg ";
        final Map<String, String> ids = new LinkedHashMap<>(Map.of("A", "1", "B", "2"));
        final List<String> sql = new ArrayList<>();
        String schema = "READER";
        String boundPackage;
        int alters;
        SQLException readFailure;
        boolean restoreFailure;

        Connection connection() {
            return proxy(Connection.class, (method, args) -> {
                if (!method.getName().equals("prepareStatement")) return empty(method.getReturnType());
                String query = (String) args[0];
                sql.add(query);
                return proxy(PreparedStatement.class, (operation, values) -> {
                    if (operation.getName().equals("setString")) boundPackage = (String) values[1];
                    if (operation.getName().equals("execute")) {
                        alters++;
                        String next = query.substring(query.indexOf('=') + 2, query.length() - 1).replace("\"\"", "\"");
                        if (restoreFailure && next.equals("READER")) throw new SQLException("restore failed");
                        schema = next;
                        return true;
                    }
                    if (operation.getName().equals("executeQuery")) {
                        if (query.contains("ALL_OBJECTS")) return rows(ids.keySet().stream().map(owner -> new String[]{owner, pack}).toList());
                        if (!schema.equals("READER") && readFailure != null) throw readFailure;
                        return rows(List.<String[]>of(new String[]{schema, schema.equals("READER") ? "99" : ids.get(schema), "READER", "READER"}));
                    }
                    return empty(operation.getReturnType());
                });
            });
        }

        ResultSet rows(List<String[]> values) {
            AtomicInteger index = new AtomicInteger(-1);
            return proxy(ResultSet.class, (method, args) -> switch (method.getName()) {
                case "next" -> index.incrementAndGet() < values.size();
                case "getString" -> values.get(index.get())[(int) args[0] - 1];
                default -> empty(method.getReturnType());
            });
        }
    }
}
