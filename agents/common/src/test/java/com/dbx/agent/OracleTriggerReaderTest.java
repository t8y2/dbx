package com.dbx.agent;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class OracleTriggerReaderTest {
    private static final String OWNER = " Owner ";
    private static final String PARENT_OWNER = " Parent Owner ";
    private static final String NAME = " Trigger A ";
    private static final String SOURCE = "TRIGGER \" Trigger A \" BEFORE INSERT ON \" Parent Owner \".\" Parent \"\nFOR EACH ROW DISABLE\nBEGIN\n/* " + "中文😀".repeat(12_000) + " */\nNULL; END;";

    @Test
    void readsRawCrossOwnerIdentityAndIndependentStatesAndFullClob() throws Exception {
        try (Connection connection = fixture()) {
            OracleTriggerReader reader = new OracleTriggerReader(connection, "oceanbase-oracle");
            List<TriggerInfo> triggers = reader.listTriggers(PARENT_OWNER, " Parent ");
            assertEquals(1, triggers.size());
            TriggerInfo trigger = triggers.get(0);
            assertFalse(trigger.getEnabled());
            assertFalse(trigger.getValid());
            assertEquals(OWNER, trigger.getOracle_metadata().owner());
            assertEquals(NAME, trigger.getName());
            assertEquals(PARENT_OWNER, trigger.getOracle_metadata().parent().owner());
            assertEquals("9007199254740993", trigger.getOracle_metadata().objectId());
            assertTrue(reader.listTriggers(PARENT_OWNER.trim(), " Parent ").isEmpty());
            assertTrue(reader.listTriggers(PARENT_OWNER, "Parent").isEmpty());

            ObjectSource source = reader.getObjectSource(OWNER, NAME);
            assertEquals(SOURCE, source.getSource());
            assertTrue(source.getTrigger().getOracle_metadata().definition().complete());
            assertEquals("ALL_SOURCE", source.getTrigger().getOracle_metadata().definition().origin());
            assertEquals(List.of(new OracleTriggerMetadata.CompilationError(1, 5, 7, "Missing procedure", "ERROR")), source.getTrigger().getOracle_metadata().errors());
            assertFalse(source.getTrigger().getValid());
        }
    }

    @Test
    void enrichesOnlyTheSelectedPageWithoutLoadingSourceOrRewritingOtherRows() throws Exception {
        try (Connection connection = fixture()) {
            connection.createStatement().execute("DROP TABLE ALL_SOURCE");
            ObjectInfo table = new ObjectInfo("unchanged", "TABLE", OWNER, "comment", true);
            ObjectInfo trigger = new ObjectInfo(NAME, "TRIGGER", OWNER, null);
            new OracleTriggerReader(connection, "oceanbase-oracle").enrichObjects(List.of(table, trigger), OWNER);
            assertEquals("comment", table.getComment());
            assertTrue(table.getValid());
            assertNull(table.getTrigger());
            assertNull(trigger.getTrigger().getStatement());
            assertNull(trigger.getTrigger().getOracle_metadata().definition());
            assertEquals(PARENT_OWNER, trigger.getParent_schema());
            assertEquals(" Parent ", trigger.getParent_name());
            assertFalse(trigger.getValid());
        }
    }

    @Test
    void missingColumnsStayUnknownRatherThanDisabledOrValid() throws Exception {
        try (Connection connection = fixture()) {
            connection.createStatement().execute("ALTER TABLE ALL_TRIGGERS DROP COLUMN STATUS");
            connection.createStatement().execute("ALTER TABLE ALL_TRIGGERS DROP COLUMN BASE_OBJECT_TYPE");
            TriggerInfo trigger = new OracleTriggerReader(connection, "dm").listTriggers(PARENT_OWNER, " Parent ").get(0);
            assertNull(trigger.getEnabled());
            assertFalse(trigger.getValid());
            assertEquals("UNKNOWN", trigger.getOracle_metadata().scope());
            assertEquals("unavailable", trigger.getOracle_metadata().reads().get("enabled").state());
            assertEquals("unavailable", trigger.getOracle_metadata().reads().get("scope").state());
            assertEquals("unavailable", trigger.getOracle_metadata().reads().get("parent").state());
            assertNull(trigger.getOracle_metadata().parent());
        }
    }

    @Test
    void bodyOnlyFallbackRetainsTextButCannotAuthorizeReplacement() throws Exception {
        try (Connection connection = fixture()) {
            connection.createStatement().execute("DROP TABLE ALL_SOURCE");
            ObjectSource source = new OracleTriggerReader(connection, "dm").getObjectSource(OWNER, NAME);
            assertEquals("BEGIN NULL; END;", source.getSource());
            assertFalse(source.getTrigger().getOracle_metadata().definition().complete());
            assertEquals("body", source.getTrigger().getOracle_metadata().definition().format());
            assertNotEquals("available", source.getTrigger().getOracle_metadata().reads().get("definition").state());
        }
    }

    @Test
    void schemaScopeHasNoInventedTableAndUnreadableErrorsAreNotEmpty() throws Exception {
        try (Connection connection = fixture()) {
            connection.createStatement().execute("UPDATE ALL_TRIGGERS SET BASE_OBJECT_TYPE='SCHEMA', TABLE_NAME=NULL");
            connection.createStatement().execute("DROP TABLE ALL_ERRORS");
            ObjectSource source = new OracleTriggerReader(connection, "oceanbase-oracle").getObjectSource(OWNER, NAME);
            OracleTriggerMetadata metadata = source.getTrigger().getOracle_metadata();
            assertEquals("SCHEMA", metadata.scope());
            assertEquals(PARENT_OWNER, metadata.scopeOwner());
            assertNull(metadata.parent());
            assertNull(metadata.errors());
            assertNotEquals("available", metadata.reads().get("errors").state());
        }
    }

    @Test
    void dmTimerUsesTheDatabaseBaseScopeWithoutInventingAParent() throws Exception {
        try (Connection connection = fixture()) {
            connection.createStatement().execute("UPDATE ALL_TRIGGERS SET BASE_OBJECT_TYPE='DATABASE', TRIGGERING_EVENT='TIMER', TABLE_NAME=NULL");
            OracleTriggerMetadata metadata = new OracleTriggerReader(connection, "dm").getObjectSource(OWNER, NAME).getTrigger().getOracle_metadata();
            assertEquals("TIMER", metadata.scope());
            assertEquals("DATABASE", metadata.scopeType());
            assertNull(metadata.parent());
            assertNull(metadata.scopeOwner());
            // Oracle's event text must not be reinterpreted as a DM capability.
            assertEquals("DATABASE", new OracleTriggerReader(connection, "oracle").getObjectSource(OWNER, NAME).getTrigger().getOracle_metadata().scope());
        }
    }

    @Test
    void successfulVisibleEmptyIdentityIsNotAnOldProviderOrAnUnreadableDictionary() throws Exception {
        try (Connection connection = fixture()) {
            connection.createStatement().execute("DELETE FROM ALL_TRIGGERS");
            ObjectSource source = new OracleTriggerReader(connection, "oceanbase-oracle").getObjectSource(OWNER, NAME);
            assertEquals("", source.getSource());
            assertEquals("empty", source.getTrigger().getOracle_metadata().reads().get("identity").state());
            assertNull(source.getTrigger().getOracle_metadata().objectId());
            assertNull(source.getTrigger().getOracle_metadata().definition());
            assertEquals(OWNER, source.getTrigger().getOracle_metadata().owner());
            connection.createStatement().execute("DROP TABLE ALL_TRIGGERS");
            assertThrows(java.sql.SQLException.class, () -> new OracleTriggerReader(connection, "oceanbase-oracle").getObjectSource(OWNER, NAME));
        }
    }

    @Test
    void dictionaryLineGapCannotBecomeACompleteReplacementBaseline() throws Exception {
        try (Connection connection = fixture()) {
            connection.createStatement().execute("INSERT INTO ALL_SOURCE SELECT OWNER,NAME,TYPE,3,' -- lost dictionary line' FROM ALL_SOURCE WHERE LINE=1");
            ObjectSource source = new OracleTriggerReader(connection, "oceanbase-oracle").getObjectSource(OWNER, NAME);
            assertFalse(source.getTrigger().getOracle_metadata().definition().complete());
            assertEquals("BEGIN NULL; END;", source.getSource());
        }
    }

    @Test
    void nullCompilationErrorTextRemainsAnExplicitReadFailure() throws Exception {
        try (Connection connection = fixture()) {
            connection.createStatement().execute("UPDATE ALL_ERRORS SET TEXT=NULL");
            ObjectSource source = new OracleTriggerReader(connection, "oceanbase-oracle").getObjectSource(OWNER, NAME);
            assertTrue(source.getTrigger().getOracle_metadata().definition().complete());
            assertNull(source.getTrigger().getOracle_metadata().errors());
            assertEquals("error", source.getTrigger().getOracle_metadata().reads().get("errors").state());
        }
    }

    @Test
    void interruptedCharacterStreamCannotBecomeACompleteDefinition() throws Exception {
        try (Connection connection = fixture()) {
            Connection interrupted = (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
                try {
                    Object value = method.invoke(connection, args);
                    if (method.getName().equals("prepareStatement") && ((String) args[0]).contains("FROM ALL_SOURCE")) {
                        return Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(), new Class<?>[]{PreparedStatement.class}, (p, m, a) -> {
                            try {
                                Object result = m.invoke(value, a);
                                if (!m.getName().equals("executeQuery")) return result;
                                return Proxy.newProxyInstance(java.sql.ResultSet.class.getClassLoader(), new Class<?>[]{java.sql.ResultSet.class}, (r, read, column) -> {
                                    if (read.getName().equals("getCharacterStream")) return new java.io.Reader() {
                                        @Override public int read(char[] buffer, int offset, int length) throws java.io.IOException { throw new java.io.IOException("Stream interrupted"); }
                                        @Override public void close() {}
                                    };
                                    try { return read.invoke(result, column); }
                                    catch (InvocationTargetException error) { throw error.getCause(); }
                                });
                            } catch (InvocationTargetException error) { throw error.getCause(); }
                        });
                    }
                    return value;
                } catch (InvocationTargetException error) { throw error.getCause(); }
            });
            ObjectSource source = new OracleTriggerReader(interrupted, "oceanbase-oracle").getObjectSource(OWNER, NAME);
            assertEquals("BEGIN NULL; END;", source.getSource());
            assertFalse(source.getTrigger().getOracle_metadata().definition().complete());
        }
    }

    @Test
    void concurrentSameNameRecreationCannotProduceAWritableSnapshot() throws Exception {
        try (Connection connection = fixture()) {
            Connection racing = (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
                try {
                    Object value = method.invoke(connection, args);
                    if (method.getName().equals("prepareStatement") && ((String) args[0]).contains("FROM ALL_SOURCE")) {
                        PreparedStatement statement = (PreparedStatement) value;
                        return Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(), new Class<?>[]{PreparedStatement.class}, (p, m, a) -> {
                            try {
                                Object result = m.invoke(statement, a);
                                if (m.getName().equals("executeQuery")) connection.createStatement().execute("UPDATE ALL_OBJECTS SET OBJECT_ID=99");
                                return result;
                            } catch (InvocationTargetException error) { throw error.getCause(); }
                        });
                    }
                    return value;
                } catch (InvocationTargetException error) { throw error.getCause(); }
            });
            ObjectSource source = new OracleTriggerReader(racing, "oceanbase-oracle").getObjectSource(OWNER, NAME);
            assertEquals(SOURCE, source.getSource());
            assertFalse(source.getTrigger().getOracle_metadata().definition().complete());
            assertEquals("incomplete", source.getTrigger().getOracle_metadata().reads().get("identity").state());
        }
    }

    private static Connection fixture() throws Exception {
        Connection connection = DriverManager.getConnection("jdbc:h2:mem:" + UUID.randomUUID() + ";MODE=Oracle;NON_KEYWORDS=SEQUENCE,POSITION,LINE");
        try (var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE ALL_TRIGGERS (OWNER VARCHAR, TRIGGER_NAME VARCHAR, TRIGGERING_EVENT VARCHAR, TRIGGER_TYPE VARCHAR, STATUS VARCHAR, TABLE_OWNER VARCHAR, TABLE_NAME VARCHAR, BASE_OBJECT_TYPE VARCHAR, WHEN_CLAUSE VARCHAR, REFERENCING_NAMES VARCHAR, DESCRIPTION VARCHAR, TRIGGER_BODY CLOB)");
            statement.execute("CREATE TABLE ALL_OBJECTS (OWNER VARCHAR, OBJECT_NAME VARCHAR, OBJECT_TYPE VARCHAR, OBJECT_ID BIGINT, LAST_DDL_TIME TIMESTAMP, STATUS VARCHAR)");
            statement.execute("CREATE TABLE ALL_SOURCE (OWNER VARCHAR, NAME VARCHAR, TYPE VARCHAR, LINE INT, TEXT CLOB)");
            statement.execute("CREATE TABLE ALL_ERRORS (OWNER VARCHAR, NAME VARCHAR, TYPE VARCHAR, SEQUENCE INT, LINE INT, POSITION INT, TEXT VARCHAR, ATTRIBUTE VARCHAR)");
        }
        try (PreparedStatement statement = connection.prepareStatement("INSERT INTO ALL_TRIGGERS VALUES (?, ?, 'INSERT', 'BEFORE EACH ROW', 'DISABLED', ?, ' Parent ', 'TABLE', NULL, NULL, NULL, 'BEGIN NULL; END;')")) {
            statement.setString(1, OWNER); statement.setString(2, NAME); statement.setString(3, PARENT_OWNER); statement.executeUpdate();
        }
        try (PreparedStatement statement = connection.prepareStatement("INSERT INTO ALL_OBJECTS VALUES (?, ?, 'TRIGGER', 9007199254740993, CURRENT_TIMESTAMP, 'INVALID')")) {
            statement.setString(1, OWNER); statement.setString(2, NAME); statement.executeUpdate();
        }
        try (PreparedStatement statement = connection.prepareStatement("INSERT INTO ALL_SOURCE VALUES (?, ?, 'TRIGGER', 1, ?)")) {
            statement.setString(1, OWNER); statement.setString(2, NAME); statement.setString(3, SOURCE); statement.executeUpdate();
        }
        try (PreparedStatement statement = connection.prepareStatement("INSERT INTO ALL_ERRORS VALUES (?, ?, 'TRIGGER', 1, 5, 7, 'Missing procedure', 'ERROR')")) {
            statement.setString(1, OWNER); statement.setString(2, NAME); statement.executeUpdate();
        }
        return connection;
    }
}
