package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.tools.ToolProvider;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Driver;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;

import static org.junit.jupiter.api.Assertions.*;

final class ExternalJdbcClassLoaderTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    @TempDir Path directory;
    private final Map<String, Object> savedFields = new LinkedHashMap<>();
    private final List<URLClassLoader> loaders = new ArrayList<>();
    private List<Driver> savedDrivers;
    private ClassLoader originalContext;

    @BeforeEach
    void saveRegistrationState() throws Exception {
        originalContext = Thread.currentThread().getContextClassLoader();
        savedDrivers = Collections.list(DriverManager.getDrivers());
        for (String name : List.of("registeredDriver", "registeredDriverKey", "registeredDriverClassLoader", "logicalDriverKey")) {
            Field field = field(name);
            savedFields.put(name, field.get(null));
            field.set(null, null);
        }
    }

    @AfterEach
    void restoreRegistrationState() throws Exception {
        Method close = DbxJdbcPlugin.class.getDeclaredMethod("closeSharedConnection");
        close.setAccessible(true);
        close.invoke(null);
        for (Driver driver : Collections.list(DriverManager.getDrivers())) {
            if (!savedDrivers.contains(driver)) DriverManager.deregisterDriver(driver);
        }
        for (var entry : savedFields.entrySet()) field(entry.getKey()).set(null, entry.getValue());
        Thread.currentThread().setContextClassLoader(originalContext);
        for (URLClassLoader loader : loaders) loader.close();
    }

    @Test
    void selectedDependencyWinsOverIncompatiblePluginClassThroughProductionRegistration() throws Exception {
        Path[] jars = fixture(7);
        ObjectNode connection = configuration("fixture.SelectedDriver", jars);
        Driver driver = register(connection);
        assertEquals(7, driver.getMajorVersion());
        ClassLoader selected = (ClassLoader) field("registeredDriverClassLoader").get(null);
        assertSame(selected, Thread.currentThread().getContextClassLoader());
        Class<?> dependency = selected.loadClass("org.apache.commons.lang3.StringUtils");
        assertEquals(jars[1].toUri().toURL(), dependency.getProtectionDomain().getCodeSource().getLocation());
        assertEquals(Integer.class, dependency.getMethod("isEmpty", CharSequence.class).getReturnType());
        assertEquals(boolean.class, org.apache.commons.lang3.StringUtils.class
            .getMethod("isEmpty", CharSequence.class).getReturnType());
        assertSame(Driver.class, selected.loadClass("java.sql.Driver"));
        assertSame(driver, register(connection));
        assertSame(selected, field("registeredDriverClassLoader").get(null));

        Path[] replacement = fixture(9);
        assertEquals(9, register(configuration("fixture.SelectedDriver", replacement)).getMajorVersion());
        assertNotSame(selected, field("registeredDriverClassLoader").get(null));
        assertEquals(7, register(connection).getMajorVersion());
    }

    @Test
    void serviceDiscoveryUsesSelectedJarsAndContextResources() throws Exception {
        Path[] jars = fixture(11);
        Driver driver = register(configuration("", jars));
        assertEquals(11, driver.getMajorVersion());
        assertTrue(driver.acceptsURL("jdbc:fixture:test"));
    }

    @Test
    void missingSelectedDependencyDoesNotBorrowPluginClasses() throws Exception {
        Path[] jars = fixture(3);
        InvocationTargetException error = assertThrows(InvocationTargetException.class,
            () -> register(configuration("fixture.SelectedDriver", jars[0], jars[2])));
        Throwable root = error;
        while (root.getCause() != null) root = root.getCause();
        assertInstanceOf(ClassNotFoundException.class, root);
        assertEquals("org.apache.commons.lang3.StringUtils", root.getMessage());
    }

    @Test
    void explicitAndServiceLoadedH2CanQueryAndReconnect() throws Exception {
        Path h2 = Path.of(org.h2.Driver.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        for (String driverClass : List.of("org.h2.Driver", "")) {
            ObjectNode connection = configuration(driverClass, h2);
            connection.put("connection_string", "jdbc:h2:mem:external_loader_" + directory.getFileName());
            connection.put("username", "sa");
            connection.put("password", "");
            for (int cycle = 0; cycle < 2; cycle++) {
                JsonNode result = request("executeQuery", connection, "SELECT 1");
                assertFalse(result.has("error"), result.toString());
                assertEquals(1, result.path("result").path("rows").path(0).path(0).asInt());
                assertFalse(request("close", connection, null).has("error"));
            }
            rememberLoader();
        }
    }

    @Test
    void noPathsPreservesSuppliedContextLoader() throws Exception {
        Path h2 = Path.of(org.h2.Driver.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        URLClassLoader context = new URLClassLoader(new java.net.URL[]{h2.toUri().toURL()}, ClassLoader.getPlatformClassLoader());
        loaders.add(context);
        Thread.currentThread().setContextClassLoader(context);
        assertNotNull(register(configuration("org.h2.Driver")));
        assertSame(context, field("registeredDriverClassLoader").get(null));
        assertSame(context, Thread.currentThread().getContextClassLoader());
    }

    private Driver register(ObjectNode connection) throws Exception {
        Method register = DbxJdbcPlugin.class.getDeclaredMethod("registerDrivers", JsonNode.class);
        register.setAccessible(true);
        try {
            register.invoke(null, connection);
            return (Driver) field("registeredDriver").get(null);
        } finally {
            rememberLoader();
        }
    }

    private void rememberLoader() throws Exception {
        Object value = field("registeredDriverClassLoader").get(null);
        if (value instanceof URLClassLoader loader && !loaders.contains(loader)) loaders.add(loader);
    }

    private static Field field(String name) throws Exception {
        Field field = DbxJdbcPlugin.class.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    private static ObjectNode configuration(String driverClass, Path... paths) {
        ObjectNode connection = MAPPER.createObjectNode().put("jdbc_driver_class", driverClass);
        var selected = connection.putArray("jdbc_driver_paths");
        for (Path path : paths) selected.add(path.toString());
        return connection;
    }

    private static JsonNode request(String method, ObjectNode connection, String sql) throws Exception {
        ObjectNode request = MAPPER.createObjectNode().put("id", 1).put("method", method);
        ObjectNode params = request.putObject("params");
        params.set("connection", connection);
        if (sql != null) params.put("sql", sql);
        Method handler = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        handler.setAccessible(true);
        return (JsonNode) handler.invoke(null, request.toString());
    }

    // The plugin has boolean StringUtils.isEmpty(CharSequence). The selected dependency
    // deliberately returns Integer, reproducing Phoenix's incompatible return descriptor.
    private Path[] fixture(int version) throws Exception {
        Path root = Files.createTempDirectory(directory, "fixture-");
        Path dependency = root.resolve("org/apache/commons/lang3/StringUtils.java");
        Path driver = root.resolve("fixture/SelectedDriver.java");
        Files.createDirectories(dependency.getParent());
        Files.createDirectories(driver.getParent());
        Files.writeString(dependency, "package org.apache.commons.lang3; public class StringUtils {"
            + " public static Integer isEmpty(CharSequence ignored) { return " + version + "; }}");
        Files.writeString(driver, """
            package fixture;
            public class SelectedDriver implements java.sql.Driver {
                private final int version;
                public SelectedDriver() throws Exception {
                    version = org.apache.commons.lang3.StringUtils.isEmpty("");
                    ClassLoader context = Thread.currentThread().getContextClassLoader();
                    if (context.loadClass(getClass().getName()) != getClass()) throw new AssertionError("Wrong TCCL");
                    try (var input = context.getResourceAsStream("selected-driver.txt")) {
                        if (input == null || !new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8)
                            .equals("selected-resource")) throw new AssertionError("Missing selected resource");
                    }
                }
                public java.sql.Connection connect(String url, java.util.Properties properties) { return null; }
                public boolean acceptsURL(String url) { return url.startsWith("jdbc:fixture:"); }
                public java.sql.DriverPropertyInfo[] getPropertyInfo(String u, java.util.Properties p) { return new java.sql.DriverPropertyInfo[0]; }
                public int getMajorVersion() { return version; }
                public int getMinorVersion() { return 0; }
                public boolean jdbcCompliant() { return false; }
                public java.util.logging.Logger getParentLogger() { return java.util.logging.Logger.getGlobal(); }
            }
            """);
        var compiler = ToolProvider.getSystemJavaCompiler();
        assertNotNull(compiler, "Classloading regression requires a JDK");
        assertEquals(0, compiler.run(null, null, null, "-proc:none", "-d", root.toString(), dependency.toString(), driver.toString()));
        Path driverJar = root.resolve("driver.jar");
        try (var jar = new JarOutputStream(Files.newOutputStream(driverJar))) {
            add(jar, "fixture/SelectedDriver.class", Files.readAllBytes(root.resolve("fixture/SelectedDriver.class")));
            add(jar, "META-INF/services/java.sql.Driver", "fixture.SelectedDriver\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        Path dependencyJar = root.resolve("dependency.jar");
        try (var jar = new JarOutputStream(Files.newOutputStream(dependencyJar))) {
            add(jar, "org/apache/commons/lang3/StringUtils.class", Files.readAllBytes(root.resolve("org/apache/commons/lang3/StringUtils.class")));
        }
        Path resources = Files.createDirectory(root.resolve("resources"));
        Files.writeString(resources.resolve("selected-driver.txt"), "selected-resource");
        return new Path[]{driverJar, dependencyJar, resources};
    }

    private static void add(JarOutputStream jar, String name, byte[] bytes) throws Exception {
        jar.putNextEntry(new JarEntry(name));
        jar.write(bytes);
        jar.closeEntry();
    }
}
