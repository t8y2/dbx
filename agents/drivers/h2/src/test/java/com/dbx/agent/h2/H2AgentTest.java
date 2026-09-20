package com.dbx.agent.h2;

import com.dbx.agent.BaseDatabaseAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseAgent;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import com.dbx.agent.test.JdbcExecutionBehaviorTest;
import com.dbx.agent.test.JdbcMetadataBehaviorTest;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.util.List;
import java.util.Map;
import java.util.jar.JarOutputStream;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class H2AgentMigrationTest {
    @TempDir
    Path tempDirectory;

    @Test
    void agentExtendsBaseDatabaseAgent() {
        Assertions.assertTrue(BaseDatabaseAgent.class.isAssignableFrom(H2Agent.class));
    }

    @Test
    void buildUrlUsesExplicitConnectionString() {
        ConnectParams params = new ConnectParams(
            "127.0.0.1",
            9092,
            "test",
            "sa",
            "",
            "",
            "jdbc:h2:file:/tmp/dbx-h2-test;AUTO_SERVER=TRUE",
            false
        );

        Assertions.assertEquals("jdbc:h2:file:/tmp/dbx-h2-test;AUTO_SERVER=TRUE", H2Agent.buildUrl(params));
    }

    @Test
    void buildUrlKeepsTcpModeWhenNoConnectionString() {
        ConnectParams params = new ConnectParams("127.0.0.1", 9092, "test", "sa", "", "", "", false);

        Assertions.assertEquals("jdbc:h2:tcp://127.0.0.1:9092/test", H2Agent.buildUrl(params));
    }

    @Test
    @SuppressWarnings("unchecked")
    void exposesDatabaseMetadataForTestAndConnectedConnection() {
        ConnectParams params = new ConnectParams("", 0, "mem:dbx-agent-info;DB_CLOSE_DELAY=-1", "sa", "", "", "", false);
        H2Agent agent = new H2Agent();

        Map<String, Object> result = agent.testConnectionWithInfo(params);
        Assertions.assertEquals(true, result.get("ok"));
        Map<String, String> testedInfo = (Map<String, String>) result.get("databaseInfo");
        assertH2DatabaseInfo(testedInfo);

        agent.connect(params);
        try {
            assertH2DatabaseInfo(agent.getDatabaseInfo());
        } finally {
            agent.disconnect();
        }
    }

    @Test
    void loadsEveryBundledH2Driver() {
        assertBundledDriver("h2-v1", H2DriverVersion.V1, "1.4.200");
        assertBundledDriver("h2-v2", H2DriverVersion.V2, "2.1.214");
        assertBundledDriver("h2-v3", H2DriverVersion.V3, "2.4.240");
        assertBundledDriver("h2-legacy", H2DriverVersion.V2, "2.1.214");
    }

    @Test
    void autoSelectsBundledDriverFromMvStoreFormat() {
        assertAutoDetectedFileDriver(H2DriverVersion.V1);
        assertAutoDetectedFileDriver(H2DriverVersion.V2);
        assertAutoDetectedFileDriver(H2DriverVersion.V3);
    }

    @Test
    void autoSelectsH2V1ForPageStoreDatabase() {
        Path base = tempDirectory.resolve("pagestore");
        H2Agent creator = new H2Agent();
        creator.connect(profileParams("h2-v1", "file:" + base + ";MV_STORE=FALSE"));
        try {
            creator.executeQuery("CREATE TABLE PAGESTORE_PROBE (ID INT PRIMARY KEY)", null, new ExecuteQueryOptions());
        } finally {
            creator.disconnect();
        }
        Assertions.assertTrue(Files.isRegularFile(Path.of(base + ".h2.db")));

        H2Agent detected = new H2Agent();
        detected.connect(profileParams("h2", "file:" + base + ";MV_STORE=FALSE;IFEXISTS=TRUE"));
        try {
            Assertions.assertEquals(H2DriverVersion.V1, detected.driverVersion());
            Assertions.assertEquals(List.of("PAGESTORE_PROBE"), detected.listTables("PUBLIC").stream().map(TableInfo::getName).toList());
        } finally {
            detected.disconnect();
        }
    }

    @Test
    void autoUsesLatestDriverForNewLocalDatabase() throws Exception {
        Path base = tempDirectory.resolve("new-auto");
        H2Agent agent = new H2Agent();
        agent.connect(profileParams("h2", "file:" + base));
        try {
            Assertions.assertEquals(H2DriverVersion.V3, agent.driverVersion());
            agent.executeQuery("CREATE TABLE LATEST_PROBE (ID INT PRIMARY KEY)", null, new ExecuteQueryOptions());
        } finally {
            agent.disconnect();
        }
        Assertions.assertEquals(3, H2FileFormatDetector.detect("jdbc:h2:file:" + base).orElseThrow());
    }

    @Test
    void autoRejectsCorruptMvStoreWithoutModifyingIt() throws Exception {
        Path base = tempDirectory.resolve("corrupt");
        Path file = Path.of(base + ".mv.db");
        byte[] corrupt = new byte[8192];
        java.util.Arrays.fill(corrupt, (byte) 0x5a);
        Files.write(file, corrupt);
        FileTime modified = Files.getLastModifiedTime(file);

        RuntimeException error = Assertions.assertThrows(
            RuntimeException.class,
            () -> new H2Agent().connect(profileParams("h2", "file:" + base + ";IFEXISTS=TRUE"))
        );

        Assertions.assertTrue(hasCauseMessage(error, "Cannot determine the H2 MVStore format"));
        Assertions.assertArrayEquals(corrupt, Files.readAllBytes(file));
        Assertions.assertEquals(modified, Files.getLastModifiedTime(file));
    }

    @Test
    void autoRejectsAmbiguousPageStoreAndMvStoreFiles() throws Exception {
        Path base = tempDirectory.resolve("ambiguous");
        Files.write(Path.of(base + ".h2.db"), new byte[]{1});
        Files.write(Path.of(base + ".mv.db"), new byte[8192]);

        RuntimeException error = Assertions.assertThrows(
            RuntimeException.class,
            () -> new H2Agent().connect(profileParams("h2", "file:" + base + ";IFEXISTS=TRUE"))
        );

        Assertions.assertTrue(hasCauseMessage(error, "Both H2 PageStore and MVStore files exist"));
    }

    @Test
    void autoHonorsIfExistsWithoutCreatingMissingDatabase() {
        Path base = tempDirectory.resolve("missing-ifexists");

        Assertions.assertThrows(
            RuntimeException.class,
            () -> new H2Agent().connect(profileParams("h2", "file:" + base + ";IFEXISTS=TRUE"))
        );

        Assertions.assertFalse(Files.exists(Path.of(base + ".mv.db")));
        Assertions.assertFalse(Files.exists(Path.of(base + ".h2.db")));
    }

    @Test
    void autoOpensExistingMvStoreReadOnlyWithoutChangingFile() throws Exception {
        Path base = tempDirectory.resolve("readonly");
        H2Agent creator = new H2Agent();
        creator.connect(profileParams("h2-v2", "file:" + base));
        try {
            creator.executeQuery("CREATE TABLE READONLY_PROBE (ID INT PRIMARY KEY)", null, new ExecuteQueryOptions());
        } finally {
            creator.disconnect();
        }
        Path file = Path.of(base + ".mv.db");
        byte[] before = Files.readAllBytes(file);

        H2Agent reader = new H2Agent();
        reader.connect(profileParams("h2", "file:" + base + ";ACCESS_MODE_DATA=r;IFEXISTS=TRUE"));
        try {
            Assertions.assertEquals(H2DriverVersion.V2, reader.driverVersion());
            Assertions.assertEquals(0, reader.executeQuery("SELECT * FROM READONLY_PROBE", null, new ExecuteQueryOptions()).getRows().size());
            Assertions.assertThrows(
                RuntimeException.class,
                () -> reader.executeQuery("INSERT INTO READONLY_PROBE VALUES (1)", null, new ExecuteQueryOptions())
            );
        } finally {
            reader.disconnect();
        }
        Assertions.assertArrayEquals(before, Files.readAllBytes(file));
    }

    @Test
    void encryptedMvStoreRequiresExplicitDriverProfile() {
        Path base = tempDirectory.resolve("encrypted");
        ConnectParams createParams = profileParams("h2-v3", "file:" + base + ";CIPHER=AES");
        createParams.setPassword("file-secret user-secret");
        H2Agent creator = new H2Agent();
        creator.connect(createParams);
        try {
            creator.executeQuery("CREATE TABLE ENCRYPTED_PROBE (ID INT PRIMARY KEY)", null, new ExecuteQueryOptions());
        } finally {
            creator.disconnect();
        }

        ConnectParams autoParams = profileParams("h2", "file:" + base + ";CIPHER=AES;IFEXISTS=TRUE");
        autoParams.setPassword("file-secret user-secret");
        RuntimeException error = Assertions.assertThrows(RuntimeException.class, () -> new H2Agent().connect(autoParams));
        Assertions.assertTrue(hasCauseMessage(error, "choose an explicit H2 driver profile"));

        ConnectParams explicitParams = profileParams("h2-v3", "file:" + base + ";CIPHER=AES;IFEXISTS=TRUE");
        explicitParams.setPassword("file-secret user-secret");
        H2Agent detected = new H2Agent();
        detected.connect(explicitParams);
        try {
            Assertions.assertEquals(H2DriverVersion.V3, detected.driverVersion());
            Assertions.assertEquals(List.of("ENCRYPTED_PROBE"), detected.listTables("PUBLIC").stream().map(TableInfo::getName).toList());
        } finally {
            detected.disconnect();
        }
    }

    @Test
    void loadsCustomH2DriverFromExternalClasspath() throws Exception {
        Path helperJar = tempDirectory.resolve("helper.jar");
        try (JarOutputStream ignored = new JarOutputStream(Files.newOutputStream(helperJar))) {
        }
        Path driverJar = copyBundledDriver("h2-2.1.214.jar");
        ConnectParams params = profileParams("h2-custom", "mem:dbx-h2-custom;DB_CLOSE_DELAY=-1");
        params.setJdbc_driver_paths(List.of(helperJar.toString(), driverJar.toString()));
        params.setJdbc_driver_class("org.h2.Driver");

        H2Agent agent = new H2Agent();
        agent.connect(params);
        try {
            Assertions.assertEquals(H2DriverVersion.CUSTOM, agent.driverVersion());
            Assertions.assertTrue(agent.getDatabaseInfo().get("driverVersion").startsWith("2.1.214"));
            agent.executeQuery("CREATE TABLE CUSTOM_DRIVER_PROBE (ID INT PRIMARY KEY)", null, new ExecuteQueryOptions());
            Assertions.assertEquals(List.of("CUSTOM_DRIVER_PROBE"), agent.listTables("PUBLIC").stream().map(TableInfo::getName).toList());
        } finally {
            agent.disconnect();
        }
    }

    @Test
    void rejectsCustomH2DriverWithoutClasspath() {
        ConnectParams params = profileParams("h2-custom", "mem:dbx-h2-custom-missing;DB_CLOSE_DELAY=-1");

        RuntimeException error = Assertions.assertThrows(RuntimeException.class, () -> new H2Agent().connect(params));

        Assertions.assertTrue(hasCauseMessage(error, "requires at least one JDBC JAR path"));
    }

    @Test
    void rejectsMissingCustomH2DriverJar() {
        ConnectParams params = profileParams("h2-custom", "mem:dbx-h2-custom-missing-file;DB_CLOSE_DELAY=-1");
        params.setJdbc_driver_paths(List.of(tempDirectory.resolve("missing-h2.jar").toString()));

        RuntimeException error = Assertions.assertThrows(RuntimeException.class, () -> new H2Agent().connect(params));

        Assertions.assertTrue(hasCauseMessage(error, "Custom H2 JDBC JAR does not exist"));
    }

    @Test
    void rejectsInvalidCustomH2DriverClass() throws Exception {
        ConnectParams params = profileParams("h2-custom", "mem:dbx-h2-custom-invalid-class;DB_CLOSE_DELAY=-1");
        params.setJdbc_driver_paths(List.of(copyBundledDriver("h2-2.4.240.jar").toString()));
        params.setJdbc_driver_class("example.MissingH2Driver");

        RuntimeException error = Assertions.assertThrows(RuntimeException.class, () -> new H2Agent().connect(params));

        Assertions.assertTrue(hasCauseMessage(error, "example.MissingH2Driver"));
    }

    private void assertBundledDriver(String profile, H2DriverVersion expected, String expectedVersion) {
        ConnectParams params = profileParams(profile, "mem:dbx-" + profile + ";DB_CLOSE_DELAY=-1");
        H2Agent agent = new H2Agent();
        agent.connect(params);
        try {
            Assertions.assertEquals(expected, agent.driverVersion());
            Assertions.assertTrue(agent.getDatabaseInfo().get("driverVersion").startsWith(expectedVersion));
        } finally {
            agent.disconnect();
        }
    }

    private void assertAutoDetectedFileDriver(H2DriverVersion expected) {
        Path base = tempDirectory.resolve("format-" + expected.storageFormat());
        ConnectParams createParams = profileParams(expected.profile(), "file:" + base);
        H2Agent creator = new H2Agent();
        creator.connect(createParams);
        try {
            creator.executeQuery("CREATE TABLE VERSION_PROBE (ID INT PRIMARY KEY)", null, new ExecuteQueryOptions());
        } finally {
            creator.disconnect();
        }

        ConnectParams autoParams = profileParams("h2", "file:" + base + ";IFEXISTS=TRUE");
        H2Agent detected = new H2Agent();
        detected.connect(autoParams);
        try {
            Assertions.assertEquals(expected, detected.driverVersion());
            Assertions.assertEquals(List.of("VERSION_PROBE"), detected.listTables("PUBLIC").stream().map(TableInfo::getName).toList());
        } finally {
            detected.disconnect();
        }
    }

    private static ConnectParams profileParams(String profile, String database) {
        ConnectParams params = new ConnectParams("", 0, database, "sa", "", "", "", false);
        params.setDriver_profile(profile);
        return params;
    }

    private Path copyBundledDriver(String name) throws Exception {
        Path target = tempDirectory.resolve(name);
        try (InputStream input = H2AgentMigrationTest.class.getResourceAsStream("/drivers/" + name)) {
            Assertions.assertNotNull(input, "Missing bundled test driver " + name);
            Files.copy(input, target, StandardCopyOption.REPLACE_EXISTING);
        }
        return target;
    }

    private static boolean hasCauseMessage(Throwable error, String expected) {
        Throwable current = error;
        while (current != null) {
            if (current.getMessage() != null && current.getMessage().contains(expected)) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private static void assertH2DatabaseInfo(Map<String, String> info) {
        Assertions.assertEquals("H2", info.get("productName"));
        Assertions.assertFalse(info.get("productVersion").isEmpty());
        Assertions.assertFalse(info.get("driverName").isEmpty());
        Assertions.assertFalse(info.get("driverVersion").isEmpty());
        Assertions.assertFalse(info.get("jdbcVersion").isEmpty());
        Assertions.assertEquals("upper", info.get("unquotedIdentifierCase"));
        Assertions.assertFalse(info.containsKey("quotedIdentifierCase"));
    }
}

class H2VersionMatrixTest {
    @Test
    void tableDdlPreservesGeneratedColumnsConstraintsAndComments() {
        for (String profile : List.of("h2-v1", "h2-v2", "h2-v3")) {
            ConnectParams params = new ConnectParams("", 0, "mem:ddl-" + profile, "sa", "", "", "", false);
            params.setDriver_profile(profile);
            H2Agent agent = new H2Agent();
            agent.connect(params);
            try {
                ExecuteQueryOptions options = new ExecuteQueryOptions();
                agent.executeQuery("CREATE SCHEMA \"Source\"; CREATE SCHEMA \"Target\"", null, options);
                agent.executeQuery("CREATE SEQUENCE \"Source\".UNUSED; CREATE SEQUENCE \"Source\".SHARED START WITH 10", null, options);
                agent.executeQuery("CREATE TABLE \"Source\".PARENT (ID INT PRIMARY KEY, TOKEN BIGINT DEFAULT NEXT VALUE FOR \"Source\".SHARED)", null, options);
                agent.executeQuery("CREATE TABLE \"Source\".CHILD (ID INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "
                    + "PARENT_ID INT, QTY INT DEFAULT 1 CHECK (QTY > 0), TOTAL INT AS (QTY * 2), RAW_BYTES BINARY(8), "
                    + "TOKEN BIGINT DEFAULT NEXT VALUE FOR \"Source\".SHARED, NOTE VARCHAR(128) DEFAULT 'NEXT VALUE FOR \"Source\".\"UNUSED\"', "
                    + "CONSTRAINT FK_PARENT FOREIGN KEY (PARENT_ID) REFERENCES \"Source\".PARENT(ID) ON DELETE CASCADE)", null, options);
                agent.executeQuery("COMMENT ON COLUMN \"Source\".CHILD.QTY IS 'quantity'; COMMENT ON TABLE \"Source\".CHILD IS 'child table'", null, options);
                agent.executeQuery("CREATE INDEX \"Source\".IDX_QTY ON \"Source\".CHILD(QTY DESC)", null, options);
                List<ColumnInfo> columns = agent.getColumns("Source", "CHILD");
                Assertions.assertTrue(columns.get(0).getExtra().contains("identity"), profile);
                Assertions.assertEquals("computed", columns.get(3).getExtra(), profile);
                Assertions.assertEquals("quantity", columns.get(2).getComment(), profile);

                for (String table : List.of("PARENT", "CHILD")) {
                    String ddl = agent.getTableDdl("Source", table);
                    Assertions.assertFalse(ddl.contains("CREATE USER"), ddl);
                    Assertions.assertFalse(ddl.contains("CREATE SCHEMA"), ddl);
                    Assertions.assertFalse(ddl.contains("INSERT INTO"), ddl);
                    Assertions.assertFalse(ddl.contains("CREATE SEQUENCE IF NOT EXISTS \"Source\".\"UNUSED\""), ddl);
                    if (table.equals("PARENT")) {
                        Assertions.assertFalse(ddl.contains("SYSTEM_SEQUENCE_"), ddl);
                    }
                    agent.executeQuery(ddl.replace("\"Source\".", "\"Target\"."), null, options);
                }
                agent.executeQuery("INSERT INTO \"Target\".PARENT(ID) VALUES (1)", null, options);
                agent.executeQuery("INSERT INTO \"Target\".CHILD(PARENT_ID) VALUES (1)", null, options);
                Assertions.assertEquals(List.of(List.of(1, 1, 2)), agent.executeQuery("SELECT ID, QTY, TOTAL FROM \"Target\".CHILD", null, options).getRows(), profile);
                Assertions.assertEquals("11", agent.executeQuery("SELECT TOKEN FROM \"Target\".CHILD", null, options).getRows().get(0).get(0).toString(), profile);
                Assertions.assertThrows(RuntimeException.class, () -> agent.executeQuery("INSERT INTO \"Target\".CHILD(QTY) VALUES (-1)", null, options), profile);
                Assertions.assertTrue(agent.getTableDdl("Target", "CHILD").contains("\"QTY\" DESC"), profile);
                Assertions.assertEquals("quantity", agent.getColumns("Target", "CHILD").get(2).getComment(), profile);
                agent.executeQuery("DELETE FROM \"Target\".PARENT", null, options);
                Assertions.assertTrue(agent.executeQuery("SELECT * FROM \"Target\".CHILD", null, options).getRows().isEmpty(), profile);
            } finally {
                agent.disconnect();
            }
        }
    }

    @Test
    void generatedAlwaysIdentityAcceptsExplicitInsertWithOverride() {
        for (String profile : List.of("h2-v2", "h2-v3")) {
            H2Agent agent = connect(profile);
            try {
                ExecuteQueryOptions options = new ExecuteQueryOptions();
                agent.executeQuery("CREATE TABLE ALWAYS_ID (ID INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, V INT)", null, options);
                Assertions.assertEquals("generated always as identity", agent.getColumns("PUBLIC", "ALWAYS_ID").get(0).getExtra());
                agent.executeQuery("INSERT INTO ALWAYS_ID(ID, V) OVERRIDING SYSTEM VALUE VALUES (42, 7)", null, options);
                Assertions.assertEquals(List.of(List.of(42, 7)), agent.executeQuery("SELECT ID, V FROM ALWAYS_ID", null, options).getRows());
            } finally {
                agent.disconnect();
            }
        }
    }

    @Test
    void transferMetadataAndWritesRespectCustomSchemasAcrossBundledVersions() {
        for (String profile : List.of("h2-v1", "h2-v2", "h2-v3")) {
            ConnectParams params = new ConnectParams("", 0, "mem:transfer-" + profile, "sa", "", "", "", false);
            params.setDriver_profile(profile);
            H2Agent agent = new H2Agent();
            agent.connect(params);
            try {
                ExecuteQueryOptions options = new ExecuteQueryOptions();
                agent.executeQuery("CREATE SCHEMA \"TransferTarget\"", null, options);
                agent.executeQuery("CREATE TABLE PUBLIC.ITEMS (PUBLIC_ONLY INT)", null, options);
                agent.executeQuery(
                    "CREATE TABLE \"TransferTarget\".ITEMS (ID INT, PART INT, NAME VARCHAR(1024), AMOUNT DECIMAL(12, 2), PRIMARY KEY (ID, PART))",
                    null, options
                );
                agent.executeQuery("CREATE INDEX \"TransferTarget\".IDX_NAME ON \"TransferTarget\".ITEMS(NAME)", null, options);
                agent.executeQuery("CREATE UNIQUE HASH INDEX \"TransferTarget\".IDX_PART ON \"TransferTarget\".ITEMS(PART)", null, options);

                Assertions.assertTrue(agent.listSchemas().contains("TransferTarget"), profile);
                Assertions.assertTrue(agent.listTables("TransferTarget").stream().anyMatch(table -> table.getName().equals("ITEMS")), profile);
                Assertions.assertTrue(agent.listTables("MISSING_SCHEMA").isEmpty(), profile);
                Assertions.assertEquals(List.of("PUBLIC_ONLY"), agent.getColumns(null, "ITEMS").stream().map(ColumnInfo::getName).toList(), profile);
                List<ColumnInfo> columns = agent.getColumns("TransferTarget", "ITEMS");
                Assertions.assertEquals(List.of("ID", "PART", "NAME", "AMOUNT"), columns.stream().map(ColumnInfo::getName).toList(), profile);
                Assertions.assertEquals(1024, columns.get(2).getCharacter_maximum_length(), profile);
                Assertions.assertEquals(12, columns.get(3).getNumeric_precision(), profile);
                Assertions.assertEquals(2, columns.get(3).getNumeric_scale(), profile);
                Assertions.assertTrue(agent.listIndexes("TransferTarget", "ITEMS").stream().anyMatch(index -> index.getName().equals("IDX_NAME")), profile);
                agent.executeQuery("CREATE SCHEMA \"TransferCopy\"", null, options);
                String ddl = agent.getTableDdl("TransferTarget", "ITEMS");
                agent.executeQuery(ddl.replace("\"TransferTarget\".", "\"TransferCopy\"."), null, options);
                Assertions.assertEquals(1024, agent.getColumns("TransferCopy", "ITEMS").get(2).getCharacter_maximum_length(), profile);
                Assertions.assertTrue(agent.listIndexes("TransferCopy", "ITEMS").stream().anyMatch(index -> index.getName().equals("IDX_NAME")), profile);
                Assertions.assertTrue(agent.listIndexes("TransferCopy", "ITEMS").stream().anyMatch(index -> index.getName().equals("IDX_PART") && index.getIs_unique()), profile);
                agent.executeQuery("INSERT INTO \"TransferCopy\".ITEMS VALUES (1, 1, 'first', 1.00)", null, options);
                Assertions.assertThrows(RuntimeException.class, () -> agent.executeQuery("INSERT INTO \"TransferCopy\".ITEMS VALUES (2, 1, 'duplicate', 2.00)", null, options), profile);

                agent.executeQuery("INSERT INTO \"TransferTarget\".ITEMS VALUES (1, 1, 'old', 1.00)", null, options);
                agent.executeQuery(
                    "MERGE INTO \"TransferTarget\".\"ITEMS\" (\"ID\", \"PART\", \"NAME\", \"AMOUNT\") KEY (\"ID\", \"PART\") VALUES "
                        + "(1, 1, 'updated', 12.34), (1, 2, 'new', 56.78)",
                    null, options
                );
                QueryResult result = agent.executeQuery("SELECT NAME, CAST(AMOUNT AS VARCHAR) FROM \"TransferTarget\".ITEMS ORDER BY PART", null, options);
                Assertions.assertEquals(List.of(List.of("updated", "12.34"), List.of("new", "56.78")), result.getRows(), profile);
                agent.executeQuery("TRUNCATE TABLE \"TransferTarget\".ITEMS", null, options);
                Assertions.assertTrue(agent.executeQuery("SELECT * FROM \"TransferTarget\".ITEMS", null, options).getRows().isEmpty(), profile);
                agent.executeQuery("CREATE TABLE \"TransferTarget\".PAYLOADS (LABEL VARCHAR(128), DATA JSON, RAW_BYTES VARBINARY)", null, options);
                agent.executeQuery("INSERT INTO \"TransferTarget\".PAYLOADS VALUES ('C:\\tmp\\o''clock', JSON '[1,2]', X'00ff')", null, options);
                QueryResult payload = agent.executeQuery("SELECT * FROM \"TransferTarget\".PAYLOADS", null, options);
                Assertions.assertEquals(List.of(List.of("C:\\tmp\\o'clock", "[1,2]", "0x00ff")), payload.getRows(), profile);
            } finally {
                agent.disconnect();
            }
        }
    }

    @Test
    void metadataAndExecutionWorkAcrossBundledVersions() {
        for (String profile : List.of("h2-v1", "h2-v2", "h2-v3")) {
            H2Agent agent = connect(profile);
            try {
                agent.executeQuery("CREATE TABLE PARENT_TABLE (ID INT PRIMARY KEY, NAME VARCHAR(64))", null, new ExecuteQueryOptions());
                agent.executeQuery(
                    "CREATE TABLE CHILD_TABLE (ID INT PRIMARY KEY, PARENT_ID INT, AMOUNT DECIMAL(12, 2), "
                        + "CONSTRAINT FK_CHILD_PARENT FOREIGN KEY (PARENT_ID) REFERENCES PARENT_TABLE(ID))",
                    null,
                    new ExecuteQueryOptions()
                );
                agent.executeQuery("CREATE INDEX IDX_CHILD_AMOUNT ON CHILD_TABLE(AMOUNT)", null, new ExecuteQueryOptions());
                agent.executeQuery("CREATE VIEW CHILD_VIEW AS SELECT ID, AMOUNT FROM CHILD_TABLE", null, new ExecuteQueryOptions());
                agent.executeQuery("CREATE ALIAS DBX_REVERSE FOR \"java.lang.Integer.reverse\"", null, new ExecuteQueryOptions());
                agent.executeQuery("INSERT INTO PARENT_TABLE VALUES (1, 'parent')", null, new ExecuteQueryOptions());
                agent.executeQuery("INSERT INTO CHILD_TABLE VALUES (1, 1, 12.34)", null, new ExecuteQueryOptions());

                Assertions.assertTrue(agent.listSchemas().contains("PUBLIC"), profile);
                Assertions.assertTrue(agent.listTables("PUBLIC").stream().map(TableInfo::getName).toList().containsAll(List.of("PARENT_TABLE", "CHILD_TABLE", "CHILD_VIEW")), profile);

                List<ObjectInfo> objects = agent.listObjects("PUBLIC");
                Assertions.assertTrue(objects.stream().anyMatch(object -> object.getName().equals("DBX_REVERSE")), profile);
                Assertions.assertTrue(agent.getObjectSource("PUBLIC", "CHILD_VIEW", "VIEW").getSource().contains("CHILD_TABLE"), profile);

                List<ColumnInfo> columns = agent.getColumns("PUBLIC", "CHILD_TABLE");
                Assertions.assertEquals(List.of("ID", "PARENT_ID", "AMOUNT"), columns.stream().map(ColumnInfo::getName).toList(), profile);
                Assertions.assertTrue(columns.stream().filter(column -> column.getName().equals("ID")).findFirst().orElseThrow().getIs_primary_key(), profile);

                List<IndexInfo> indexes = agent.listIndexes("PUBLIC", "CHILD_TABLE");
                Assertions.assertTrue(indexes.stream().anyMatch(index -> index.getName().equals("IDX_CHILD_AMOUNT")), profile);
                Assertions.assertTrue(indexes.stream().anyMatch(IndexInfo::getIs_primary), profile);

                List<ForeignKeyInfo> foreignKeys = agent.listForeignKeys("PUBLIC", "CHILD_TABLE");
                Assertions.assertTrue(foreignKeys.stream().anyMatch(key -> key.getName().equals("FK_CHILD_PARENT")), profile);

                QueryResult result = agent.executeQuery("SELECT DBX_REVERSE(1), AMOUNT FROM CHILD_TABLE", null, new ExecuteQueryOptions());
                Assertions.assertEquals(1, result.getRows().size(), profile);
            } finally {
                agent.disconnect();
            }
        }
    }

    private static H2Agent connect(String profile) {
        ConnectParams params = new ConnectParams("", 0, "mem:matrix-" + profile + ";DB_CLOSE_DELAY=-1", "sa", "", "", "", false);
        params.setDriver_profile(profile);
        H2Agent agent = new H2Agent();
        agent.connect(params);
        return agent;
    }
}

class H2ExecutionBehaviorTest extends JdbcExecutionBehaviorTest {
    @Override
    protected DatabaseAgent createConnectedAgent(String databaseName) {
        return H2AgentTestSupport.createH2Agent(databaseName);
    }

    @Override
    protected String resultSetSql() {
        return "CALL 42";
    }

    @Override
    protected List<String> expectedResultSetColumns() {
        return List.of("42");
    }

    @Override
    protected List<List<Object>> expectedResultSetRows() {
        return List.of(List.<Object>of(42));
    }

    @Override
    protected String rowsSql(int rowCount) {
        return "SELECT X FROM SYSTEM_RANGE(1, " + rowCount + ")";
    }

    @Test
    void displaysJsonColumnsAsText() {
        withAgent("dbx-agent-h2-json", agent -> {
            agent.executeQuery(
                "CREATE TABLE EVENTS (ID INT PRIMARY KEY, ACTION_PARAMS JSON, RAW_BYTES VARBINARY)",
                null,
                new ExecuteQueryOptions()
            );
            agent.executeQuery(
                "INSERT INTO EVENTS VALUES (1, JSON '[]', X'5B5D'), (2, JSON '[{\"type\":\"ACCESS_CONTROL\"}]', X'00FF')",
                null,
                new ExecuteQueryOptions()
            );

            QueryResult result = agent.executeQuery(
                "SELECT ACTION_PARAMS, RAW_BYTES FROM EVENTS ORDER BY ID",
                null,
                new ExecuteQueryOptions()
            );

            Assertions.assertEquals(
                List.of(
                    List.of("[]", "0x5b5d"),
                    List.of("[{\"type\":\"ACCESS_CONTROL\"}]", "0x00ff")
                ),
                result.getRows()
            );
        });
    }
}

class H2MetadataBehaviorTest extends JdbcMetadataBehaviorTest {
    @Override
    protected DatabaseAgent createConnectedAgent(String databaseName) {
        return H2AgentTestSupport.createH2Agent(databaseName);
    }

    @Override
    protected List<String> metadataFixtureSql() {
        return List.of(
            "CREATE TABLE BETA_TABLE (ID INT PRIMARY KEY)",
            "CREATE TABLE ALPHA_TABLE (ID INT PRIMARY KEY)",
            "CREATE TABLE COLUMN_ORDER_SAMPLE (ID INT PRIMARY KEY, NAME VARCHAR(64), CREATED_AT TIMESTAMP)"
        );
    }

    @Override
    protected String metadataSchema() {
        return "PUBLIC";
    }

    @Override
    protected List<String> expectedTablesInOrder() {
        return List.of("ALPHA_TABLE", "BETA_TABLE", "COLUMN_ORDER_SAMPLE");
    }

    @Override
    protected String metadataColumnsTable() {
        return "COLUMN_ORDER_SAMPLE";
    }

    @Override
    protected List<String> expectedColumnsInOrder() {
        return List.of("ID", "NAME", "CREATED_AT");
    }

    @Test
    void constrainedTableMetadataFiltersTypesAndPages() {
        withAgent("dbx-agent-h2-constrained-metadata", agent -> {
            for (String sql : metadataFixtureSql()) {
                agent.executeQuery(sql, null, new ExecuteQueryOptions());
            }

            List<TableInfo> tables = agent.listTables(
                metadataSchema(),
                new MetadataListConstraints("table", 1, 1, List.of("TABLE"))
            );

            Assertions.assertEquals(1, tables.size());
            Assertions.assertEquals("BETA_TABLE", tables.get(0).getName());
        });
    }
}

final class H2AgentTestSupport {
    private H2AgentTestSupport() {
    }

    static DatabaseAgent createH2Agent(String databaseName) {
        H2Agent agent = new H2Agent();
        agent.connect(new ConnectParams("", 0, "mem:" + databaseName + ";DB_CLOSE_DELAY=-1", "", "", "", "", false));
        return agent;
    }
}
