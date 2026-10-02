package app.dbx.jdbc;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.tools.ToolProvider;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Driver;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;

import static org.junit.jupiter.api.Assertions.*;

final class LegacyJdbcDriverClassTest {
    private static final String H2_URL = "jdbc:h2:mem:legacy_class_resolution";
    private static final String TERADATA_URL = "jdbc:teradata://127.0.0.1/DATABASE=fixture,DBS_PORT=1025";
    private static final String DB2_URL = "jdbc:db2://127.0.0.1:50000/FIXTURE";

    @TempDir
    Path temporaryDirectory;

    @Test
    void resolvesHistoricalH2AliasesUsingTheSelectedJar() throws Exception {
        try (URLClassLoader loader = h2Loader()) {
            for (String alias : List.of("h2_embedded", "h2_embedded_v2")) {
                assertThrows(ClassNotFoundException.class, () -> Class.forName(alias, true, loader));
                Class<?> resolved = LegacyJdbcDriverClass.load(alias, H2_URL, loader);
                assertEquals("org.h2.Driver", resolved.getName());
                assertSame(loader, resolved.getClassLoader());
                assertInstanceOf(Driver.class, resolved.getDeclaredConstructor().newInstance());
            }
        }
    }

    @Test
    void resolvesHistoricalTeradataAndDb2Identities() throws Exception {
        for (String[] fixture : List.of(
            new String[] { "teradata", TERADATA_URL, "com.teradata.jdbc.TeraDriver" },
            new String[] { "db2", DB2_URL, "com.ibm.db2.jcc.DB2Driver" }
        )) {
            try (URLClassLoader loader = fixtureLoader(fixture[2], "")) {
                assertThrows(ClassNotFoundException.class, () -> Class.forName(fixture[0], true, loader));
                Class<?> resolved = LegacyJdbcDriverClass.load(fixture[0], fixture[1], loader);
                assertEquals(fixture[2], resolved.getName());
                assertSame(loader, resolved.getClassLoader());
                assertInstanceOf(Driver.class, resolved.getDeclaredConstructor().newInstance());
            }
        }
    }

    @Test
    void preservesExplicitClassesRegardlessOfUrl() throws Exception {
        try (URLClassLoader loader = h2Loader()) {
            Class<?> explicit = Class.forName("org.h2.Driver", true, loader);
            assertSame(explicit, LegacyJdbcDriverClass.load("org.h2.Driver", TERADATA_URL, loader));
            assertSame(explicit, LegacyJdbcDriverClass.load("org.h2.Driver", null, loader));
        }
    }

    @Test
    void preservesLoadableUnqualifiedCustomClassesIncludingAliases() throws Exception {
        for (String name : List.of("teradata", "db2", "h2_embedded", "h2_embedded_v2", "CustomDriver")) {
            try (URLClassLoader loader = fixtureLoader(name, "")) {
                Class<?> explicit = Class.forName(name, true, loader);
                assertSame(explicit, LegacyJdbcDriverClass.load(name, TERADATA_URL, loader));
                assertSame(explicit, LegacyJdbcDriverClass.load(name, H2_URL, loader));
                assertInstanceOf(Driver.class, explicit.getDeclaredConstructor().newInstance());
            }
        }
    }

    @Test
    void rejectsUnknownAndMalformedAliases() throws Exception {
        try (URLClassLoader loader = h2Loader()) {
            for (String name : List.of("custom.MissingDriver", "unknown", "h2_embedded_v3", "H2_embedded",
                " h2_embedded", "h2_embedded ", "", "com.example.teradata")) {
                ClassNotFoundException error = assertThrows(ClassNotFoundException.class,
                    () -> LegacyJdbcDriverClass.load(name, H2_URL, loader));
                assertEquals(name, error.getMessage());
            }
        }
    }

    @Test
    void rejectsMissingMalformedAndMismatchedUrls() throws Exception {
        try (URLClassLoader loader = h2Loader()) {
            for (String[] fixture : List.of(
                new String[] { "teradata", H2_URL },
                new String[] { "db2", TERADATA_URL },
                new String[] { "h2_embedded", DB2_URL },
                new String[] { "h2_embedded_v2", "jdbc:h2other:mem:test" },
                new String[] { "teradata", "jdbc:teradatax://localhost" },
                new String[] { "db2", "jdbc:db20://localhost/TEST" },
                new String[] { "h2_embedded", "prefix:jdbc:h2:mem:test" },
                new String[] { "h2_embedded", "jdbc:h2:" },
                new String[] { "teradata", "jdbc:teradata://" },
                new String[] { "db2", "jdbc:db2:" },
                new String[] { "h2_embedded", "" },
                new String[] { "teradata", null }
            )) {
                ClassNotFoundException error = assertThrows(ClassNotFoundException.class,
                    () -> LegacyJdbcDriverClass.load(fixture[0], fixture[1], loader));
                assertEquals(fixture[0], error.getMessage());
            }
        }
    }

    @Test
    void doesNotReplaceMissingSelectedJarsWithContextDrivers() throws Exception {
        ClassLoader previous = Thread.currentThread().getContextClassLoader();
        try (URLClassLoader context = h2Loader();
             URLClassLoader selected = new URLClassLoader(
                 new URL[] { temporaryDirectory.resolve("missing.jar").toUri().toURL() },
                 ClassLoader.getPlatformClassLoader())) {
            Thread.currentThread().setContextClassLoader(context);
            ClassNotFoundException error = assertThrows(ClassNotFoundException.class,
                () -> LegacyJdbcDriverClass.load("h2_embedded_v2", H2_URL, selected));
            assertEquals("org.h2.Driver", error.getMessage());
            assertSame(context, Thread.currentThread().getContextClassLoader());
        } finally {
            Thread.currentThread().setContextClassLoader(previous);
        }
    }

    @Test
    void usesTheSuppliedContextLoaderWhenNoPathsAreSelected() throws Exception {
        ClassLoader previous = Thread.currentThread().getContextClassLoader();
        try (URLClassLoader context = h2Loader()) {
            Thread.currentThread().setContextClassLoader(context);
            Class<?> resolved = LegacyJdbcDriverClass.load("h2_embedded", H2_URL,
                Thread.currentThread().getContextClassLoader());
            assertSame(context, resolved.getClassLoader());
            assertSame(context, Thread.currentThread().getContextClassLoader());
        } finally {
            Thread.currentThread().setContextClassLoader(previous);
        }
    }

    @Test
    void preservesTheSuppliedLoadersParentDelegation() throws Exception {
        try (URLClassLoader parent = h2Loader();
             URLClassLoader child = new URLClassLoader(new URL[0], parent)) {
            Class<?> resolved = LegacyJdbcDriverClass.load("h2_embedded", H2_URL, child);
            assertSame(parent, resolved.getClassLoader());
        }
    }

    @Test
    void preservesClassNotFoundForADifferentClass() {
        ClassNotFoundException failure = new ClassNotFoundException("vendor.RequiredDependency");
        ClassLoader loader = new ClassLoader(ClassLoader.getPlatformClassLoader()) {
            @Override
            protected Class<?> findClass(String name) throws ClassNotFoundException {
                throw failure;
            }
        };
        assertSame(failure, assertThrows(ClassNotFoundException.class,
            () -> LegacyJdbcDriverClass.load("teradata", TERADATA_URL, loader)));
    }

    @Test
    void preservesClassNotFoundThatWrapsALoadingFailure() {
        ClassNotFoundException failure = new ClassNotFoundException("teradata",
            new NoClassDefFoundError("vendor/RequiredDependency"));
        ClassLoader loader = new ClassLoader(ClassLoader.getPlatformClassLoader()) {
            @Override
            protected Class<?> findClass(String name) throws ClassNotFoundException {
                throw failure;
            }
        };
        assertSame(failure, assertThrows(ClassNotFoundException.class,
            () -> LegacyJdbcDriverClass.load("teradata", TERADATA_URL, loader)));
    }

    @Test
    void propagatesInitializerFailuresWithoutAliasFallback() throws Exception {
        try (URLClassLoader loader = fixtureLoader("teradata",
            "static { if (true) throw new IllegalStateException(\"initializer failed\"); }")) {
            ExceptionInInitializerError error = assertThrows(ExceptionInInitializerError.class,
                () -> LegacyJdbcDriverClass.load("teradata", TERADATA_URL, loader));
            assertEquals("initializer failed", error.getCause().getMessage());
            assertThrows(NoClassDefFoundError.class,
                () -> LegacyJdbcDriverClass.load("teradata", TERADATA_URL, loader));
        }
    }

    @Test
    void propagatesLinkageErrorsWithoutAliasFallback() {
        LinkageError failure = new UnsupportedClassVersionError("driver requires a newer Java version");
        ClassLoader loader = new ClassLoader(ClassLoader.getPlatformClassLoader()) {
            @Override
            protected Class<?> findClass(String name) {
                throw failure;
            }
        };
        assertSame(failure, assertThrows(LinkageError.class,
            () -> LegacyJdbcDriverClass.load("teradata", TERADATA_URL, loader)));
    }

    @Test
    void propagatesFailuresInTheResolvedVendorClass() throws Exception {
        try (URLClassLoader loader = fixtureLoader("com.teradata.jdbc.TeraDriver",
            "static { if (true) throw new UnsatisfiedLinkError(\"vendor library missing\"); }")) {
            UnsatisfiedLinkError error = assertThrows(UnsatisfiedLinkError.class,
                () -> LegacyJdbcDriverClass.load("teradata", TERADATA_URL, loader));
            assertEquals("vendor library missing", error.getMessage());
        }
        try (URLClassLoader loader = fixtureLoader("com.ibm.db2.jcc.DB2Driver",
            "static { if (true) throw new IllegalStateException(\"vendor initialization failed\"); }")) {
            ExceptionInInitializerError error = assertThrows(ExceptionInInitializerError.class,
                () -> LegacyJdbcDriverClass.load("db2", DB2_URL, loader));
            assertEquals("vendor initialization failed", error.getCause().getMessage());
        }
    }

    @Test
    void rechecksTheUrlOnRepeatedResolution() throws Exception {
        try (URLClassLoader loader = h2Loader()) {
            Class<?> expected = LegacyJdbcDriverClass.load("h2_embedded", H2_URL, loader);
            ClassNotFoundException error = assertThrows(ClassNotFoundException.class,
                () -> LegacyJdbcDriverClass.load("h2_embedded", DB2_URL, loader));
            assertEquals("h2_embedded", error.getMessage());
            assertSame(expected, LegacyJdbcDriverClass.load("h2_embedded", H2_URL, loader));
        }
    }

    @Test
    void leavesConstructionFailuresAndDriverTypeValidationToTheCaller() throws Exception {
        try (URLClassLoader loader = fixtureLoader("teradata",
            "public teradata() { throw new IllegalStateException(\"constructor failed\"); }")) {
            Class<?> resolved = LegacyJdbcDriverClass.load("teradata", TERADATA_URL, loader);
            InvocationTargetException error = assertThrows(InvocationTargetException.class,
                () -> resolved.getDeclaredConstructor().newInstance());
            assertEquals("constructor failed", error.getCause().getMessage());
        }
        try (URLClassLoader loader = compile("teradata", "public class teradata {}")) {
            Class<?> resolved = LegacyJdbcDriverClass.load("teradata", TERADATA_URL, loader);
            assertThrows(ClassCastException.class, () -> Driver.class.cast(resolved.getDeclaredConstructor().newInstance()));
        }
    }

    @Test
    void isolatesConcurrentResolutionsByLoader() throws Exception {
        try (URLClassLoader first = h2Loader(); URLClassLoader second = h2Loader();
             var executor = Executors.newFixedThreadPool(4)) {
            List<Callable<Class<?>>> tasks = new ArrayList<>();
            for (int index = 0; index < 20; index++) {
                ClassLoader selected = index % 2 == 0 ? first : second;
                tasks.add(() -> LegacyJdbcDriverClass.load("h2_embedded_v2", H2_URL, selected));
            }
            var results = executor.invokeAll(tasks);
            assertNotSame(results.get(0).get(), results.get(1).get());
            for (int index = 0; index < results.size(); index++) {
                assertSame(index % 2 == 0 ? first : second, results.get(index).get().getClassLoader());
            }
        }
    }

    private static URLClassLoader h2Loader() {
        return new URLClassLoader(new URL[] { org.h2.Driver.class.getProtectionDomain().getCodeSource().getLocation() },
            ClassLoader.getPlatformClassLoader());
    }

    private URLClassLoader fixtureLoader(String name, String body) throws Exception {
        int separator = name.lastIndexOf('.');
        String packageDeclaration = separator < 0 ? "" : "package " + name.substring(0, separator) + ";";
        String simpleName = name.substring(separator + 1);
        return compile(name, packageDeclaration + "public class " + simpleName + " implements java.sql.Driver {"
            + body + """
                public java.sql.Connection connect(String url, java.util.Properties properties) {
                    throw new AssertionError("Registration must not connect");
                }
                public boolean acceptsURL(String url) { return false; }
                public java.sql.DriverPropertyInfo[] getPropertyInfo(String url, java.util.Properties properties) {
                    return new java.sql.DriverPropertyInfo[0];
                }
                public int getMajorVersion() { return 1; }
                public int getMinorVersion() { return 0; }
                public boolean jdbcCompliant() { return false; }
                public java.util.logging.Logger getParentLogger() { return java.util.logging.Logger.getGlobal(); }
                }
                """);
    }

    private URLClassLoader compile(String name, String source) throws Exception {
        Path root = Files.createTempDirectory(temporaryDirectory, "driver-");
        Path file = root.resolve(name.replace('.', '/') + ".java");
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
        var compiler = ToolProvider.getSystemJavaCompiler();
        assertNotNull(compiler, "Driver classloading fixtures require the Java 21 JDK");
        assertEquals(0, compiler.run(null, null, null, "-proc:none", "-d", root.toString(), file.toString()));
        return new URLClassLoader(new URL[] { root.toUri().toURL() }, ClassLoader.getPlatformClassLoader());
    }
}
