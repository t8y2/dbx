package com.dbx.agent.transwarp;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.MetadataListConstraints;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.PartitionInfo;
import com.dbx.agent.QueryPageOptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.List;
import java.util.jar.JarFile;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TranswarpAgentTest {
    private static final String JDBC_URL = "jdbc:h2:mem:transwarp_agent;DB_CLOSE_DELAY=-1";

    @BeforeAll
    static void loadTestDatabaseDriver() throws Exception {
        Class.forName("org.h2.Driver");
    }

    @Test
    void buildsVendorUrlForBothProductProfiles() {
        TranswarpAgent agent = new TranswarpAgent();
        ConnectParams params = new ConnectParams("quark.example", 10000, "analytics", "user", "", "fetchSize=1000", "", false);
        params.setSsl(true);
        assertEquals("jdbc:inceptor2://quark.example:10000/analytics;fetchSize=1000;ssl=true", agent.buildJdbcUrl(params));
        params.setConnection_string("jdbc:transwarp2://a:10000,b:10000/analytics;serviceDiscoveryMode=zooKeeper");
        assertEquals(params.getConnection_string(), agent.buildJdbcUrl(params));
    }

    @Test
    void unsupportedIndexAndForeignKeyMetadataDoesNotCallTheSdk() {
        TranswarpAgent agent = new TranswarpAgent();
        assertTrue(agent.listIndexes("demo", "orders").isEmpty());
        assertTrue(agent.listForeignKeys("demo", "orders").isEmpty());
    }

    @Test
    void readsWaterdropCatalogViewsWithoutHidingPackagesOrPartitions() throws Exception {
        try (Connection connection = DriverManager.getConnection(JDBC_URL); Statement sql = connection.createStatement()) {
            sql.execute("CREATE SCHEMA IF NOT EXISTS system");
            sql.execute("CREATE SCHEMA IF NOT EXISTS demo");
            sql.execute("DROP TABLE IF EXISTS demo.orders");
            sql.execute("CREATE TABLE demo.orders (id INT PRIMARY KEY, amount DECIMAL(12,2))");
            sql.execute("CREATE TABLE IF NOT EXISTS system.databases_v (database_name VARCHAR)");
            sql.execute("CREATE TABLE IF NOT EXISTS system.tables_v (database_name VARCHAR, table_name VARCHAR, table_type VARCHAR, commentstring VARCHAR)");
            sql.execute("CREATE TABLE IF NOT EXISTS system.views_v (database_name VARCHAR, view_name VARCHAR, origin_text VARCHAR)");
            sql.execute("CREATE TABLE IF NOT EXISTS system.columns_v (database_name VARCHAR, table_name VARCHAR, column_id INT, column_name VARCHAR, column_type VARCHAR, nullable VARCHAR, default_value VARCHAR, commentstring VARCHAR)");
            sql.execute("CREATE TABLE IF NOT EXISTS system.procedures_v (database_name VARCHAR, procedure_name VARCHAR, full_text VARCHAR)");
            sql.execute("CREATE TABLE IF NOT EXISTS system.functions_v (database_name VARCHAR, function_name VARCHAR, full_text VARCHAR)");
            sql.execute("CREATE TABLE IF NOT EXISTS system.packages_v (database_name VARCHAR, package_name VARCHAR, full_text VARCHAR, package_body VARCHAR)");
            sql.execute("CREATE TABLE IF NOT EXISTS system.partitions_v (database_name VARCHAR, table_name VARCHAR, partition_id INT, partition_name VARCHAR, partition_value VARCHAR, partition_key VARCHAR)");
            sql.execute("CREATE TABLE IF NOT EXISTS system.range_partitions_v (database_name VARCHAR, table_name VARCHAR, partition_id INT, partition_name VARCHAR, partition_range VARCHAR, partition_key VARCHAR)");
            sql.execute("CREATE TABLE IF NOT EXISTS system.buckets_v (database_name VARCHAR, table_name VARCHAR, bucket_id INT, bucket_name VARCHAR, bucket_count INT, bucket_column VARCHAR)");
            sql.execute("CREATE TABLE IF NOT EXISTS system.triggers_v (database_name VARCHAR, table_name VARCHAR, trigger_name VARCHAR, event VARCHAR, timing VARCHAR)");
            sql.execute("INSERT INTO system.databases_v VALUES ('demo')");
            sql.execute("INSERT INTO system.tables_v VALUES ('demo', 'orders', 'MANAGED_TABLE', 'sales')");
            sql.execute("INSERT INTO system.tables_v VALUES ('demo', 'daily_mv', 'MATERIALIZED VIEW', NULL)");
            sql.execute("INSERT INTO system.views_v VALUES ('demo', 'summary', 'CREATE VIEW summary AS SELECT id FROM orders')");
            sql.execute("INSERT INTO system.columns_v VALUES ('demo', 'orders', 1, 'id', 'INT', 'false', NULL, 'order key')");
            sql.execute("INSERT INTO system.columns_v VALUES ('demo', 'orders', 2, 'amount', 'DECIMAL(12,2)', 'true', '0', NULL)");
            sql.execute("INSERT INTO system.procedures_v VALUES ('demo', 'load_orders', 'CREATE PROCEDURE load_orders() BEGIN END')");
            sql.execute("INSERT INTO system.functions_v VALUES ('demo', 'total', 'CREATE FUNCTION total() RETURNS INT')");
            sql.execute("INSERT INTO system.packages_v VALUES ('demo', 'reports', 'CREATE PACKAGE reports', 'CREATE PACKAGE BODY reports')");
            sql.execute("INSERT INTO system.partitions_v VALUES ('demo', 'orders', 1, 'west', 'W', 'region')");
            sql.execute("INSERT INTO system.range_partitions_v VALUES ('demo', 'orders', 2, 'recent', '2025', 'year')");
            sql.execute("INSERT INTO system.buckets_v VALUES ('demo', 'orders', 1, 'bucket_0', 8, 'id')");
            sql.execute("INSERT INTO system.triggers_v VALUES ('demo', 'orders', 'orders_audit', 'INSERT', 'AFTER')");
        }

        TranswarpAgent agent = connectedAgent();
        try {
            assertEquals(List.of("demo"), agent.listSchemas());
            assertEquals("H2", agent.getDatabaseInfo().get("productName"));
            assertEquals(List.of("daily_mv", "orders", "summary"), agent.listTables("demo").stream().map(table -> table.getName()).toList());
            assertEquals(List.of("daily_mv"), agent.listTables("demo", new MetadataListConstraints(null, null, null, List.of("MATERIALIZED_VIEW")))
                .stream().map(table -> table.getName()).toList());
            List<ObjectInfo> objects = agent.listObjects("demo", MetadataListConstraints.NONE);
            assertTrue(objects.stream().anyMatch(item -> item.getObject_type().equals("PACKAGE_BODY") && item.getName().equals("reports")));
            assertTrue(objects.stream().anyMatch(item -> item.getObject_type().equals("PROCEDURE")));
            assertEquals(List.of("reports"), agent.listObjects("demo", new MetadataListConstraints(null, null, null, List.of("PACKAGE")))
                .stream().map(ObjectInfo::getName).toList());
            List<ColumnInfo> columns = agent.getColumns("demo", "orders");
            assertEquals(2, columns.size());
            assertTrue(columns.get(0).getIs_primary_key());
            assertFalse(columns.get(0).getIs_nullable());
            assertEquals("0", columns.get(1).getColumn_default());
            assertEquals(12, columns.get(1).getNumeric_precision());
            assertEquals(2, columns.get(1).getNumeric_scale());
            assertEquals("CREATE PACKAGE BODY reports", agent.getObjectSource("demo", "reports", "PACKAGE_BODY").getSource());
            List<PartitionInfo> partitions = agent.listPartitions("demo", "orders");
            assertEquals(3, partitions.size());
            assertEquals("LIST", partitions.get(0).partition_type());
            assertEquals("RANGE", partitions.get(1).partition_type());
            assertEquals("BUCKET", partitions.get(2).partition_type());
            assertEquals("bucket_0", partitions.get(2).name());
            assertEquals("8", partitions.get(2).value());
            assertEquals("id", partitions.get(2).partition_key());
            assertEquals("orders_audit", agent.listTriggers("demo", "orders").get(0).getName());
            try (Connection connection = DriverManager.getConnection(JDBC_URL); Statement sql = connection.createStatement()) {
                sql.execute("DROP TABLE system.range_partitions_v");
                sql.execute("DROP TABLE system.buckets_v");
                sql.execute("DROP TABLE system.triggers_v");
                sql.execute("DROP TABLE system.packages_v");
            }
            assertEquals(1, agent.listPartitions("demo", "orders").size());
            assertTrue(agent.listObjects("demo").stream().anyMatch(item -> item.getName().equals("load_orders")));
        } finally {
            agent.disconnect();
        }
    }

    @Test
    void transactionFailureRollsBackEarlierStatement() throws Exception {
        try (Connection connection = DriverManager.getConnection(JDBC_URL); Statement sql = connection.createStatement()) {
            sql.execute("CREATE SCHEMA IF NOT EXISTS demo");
            sql.execute("DROP TABLE IF EXISTS demo.tx_test");
            sql.execute("CREATE TABLE demo.tx_test (id INT PRIMARY KEY)");
        }
        TranswarpAgent agent = connectedAgent();
        try {
            assertThrows(RuntimeException.class, () -> agent.executeTransaction(
                List.of("INSERT INTO demo.tx_test VALUES (1)", "INSERT INTO demo.tx_test VALUES (1)"), ""));
            try (Connection connection = DriverManager.getConnection(JDBC_URL);
                 var sql = connection.createStatement();
                 var rows = sql.executeQuery("SELECT COUNT(*) FROM demo.tx_test")) {
                assertTrue(rows.next());
                assertEquals(0, rows.getInt(1));
            }
        } finally {
            agent.disconnect();
        }
    }

    @Test
    void pagesQueryResultsThroughSharedJdbcExecutor() throws Exception {
        try (Connection connection = DriverManager.getConnection(JDBC_URL); Statement sql = connection.createStatement()) {
            sql.execute("CREATE SCHEMA IF NOT EXISTS demo");
            sql.execute("DROP TABLE IF EXISTS demo.page_test");
            sql.execute("CREATE TABLE demo.page_test (id INT PRIMARY KEY)");
            sql.execute("INSERT INTO demo.page_test VALUES (1), (2), (3)");
        }
        TranswarpAgent agent = connectedAgent();
        try {
            var first = agent.executeQueryPage("SELECT id FROM demo.page_test ORDER BY id", "",
                new QueryPageOptions(2, null, 10));
            assertEquals(2, first.getRows().size());
            assertTrue(first.getHas_more());
            var next = agent.fetchQueryPage(first.getSession_id(), 2);
            assertEquals(1, next.getRows().size());
            assertFalse(next.getHas_more());
        } finally {
            agent.disconnect();
        }
    }

    @Test
    void packagedAgentLoadsDefaultDriverWithoutExternalClasspath() throws Exception {
        Path jar = Path.of(System.getProperty("dbx.transwarp.agent.jar"));
        assertTrue(Files.isRegularFile(jar));
        try (JarFile archive = new JarFile(jar.toFile())) {
            assertFalse(Boolean.parseBoolean(archive.getManifest().getMainAttributes().getValue("Agent-External-Driver")));
        }
        try (URLClassLoader loader = new URLClassLoader(new URL[]{jar.toUri().toURL()}, ClassLoader.getPlatformClassLoader())) {
            Class<?> paramsClass = loader.loadClass("com.dbx.agent.ConnectParams");
            Object params = paramsClass.getDeclaredConstructor().newInstance();
            Object agent = loader.loadClass("com.dbx.agent.transwarp.TranswarpAgent").getDeclaredConstructor().newInstance();
            var loadDriver = loader.loadClass("com.dbx.agent.AbstractJdbcAgent").getDeclaredMethod("loadDriver", paramsClass);
            loadDriver.setAccessible(true);
            loadDriver.invoke(agent, params);
            Driver driver = (Driver) Class.forName("org.apache.hive.jdbc.HiveDriver", true, loader)
                .getDeclaredConstructor().newInstance();
            assertTrue(driver.acceptsURL("jdbc:inceptor2://localhost:10000/default"));
            assertTrue(driver.acceptsURL("jdbc:transwarp2://localhost:10000/default"));
            assertTrue(driver.acceptsURL("jdbc:hive2://localhost:10000/default"));
        }
    }

    @Test
    void validatesUsingSharedJdbcConnectionLifecycle() {
        ConnectParams params = new ConnectParams("", 0, "demo", "", "", "", JDBC_URL, false);
        params.setJdbc_driver_class("org.h2.Driver");
        var result = new TranswarpAgent().testConnectionWithInfo(params);
        assertEquals(true, result.get("ok"));
        assertEquals("SELECT 1", result.get("validation"));
    }

    @Test
    void packagedAgentRunsSharedJsonRpcProtocol() throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        Process process = new ProcessBuilder(java, "-jar", System.getProperty("dbx.transwarp.agent.jar"))
            .redirectErrorStream(true).start();
        try {
            try (var input = process.getOutputStream()) {
                input.write("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"shutdown\",\"params\":{}}\n".getBytes(StandardCharsets.UTF_8));
            }
            assertTrue(process.waitFor(10, TimeUnit.SECONDS), "Packaged Agent did not shut down");
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertEquals(0, process.exitValue(), output);
            assertTrue(output.contains("\"ready\":true"), output);
            assertTrue(output.contains("\"result\":"), output);
            assertFalse(output.contains("\"error\":"), output);
        } finally {
            process.destroyForcibly();
            process.waitFor(5, TimeUnit.SECONDS);
        }
    }

    private static TranswarpAgent connectedAgent() {
        ConnectParams params = new ConnectParams("", 0, "demo", "", "", "", JDBC_URL, false);
        params.setJdbc_driver_class("org.h2.Driver");
        params.setDriver_profile("transwarp-inceptor");
        TranswarpAgent agent = new TranswarpAgent();
        agent.connect(params);
        return agent;
    }
}
