package com.dbx.agent.h2;

import com.dbx.agent.ConnectParams;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.sql.Driver;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;

final class H2DriverLoader {
    private static final Object EXTRACTION_LOCK = new Object();
    private static final Path CACHE_ROOT = Path.of(System.getProperty("java.io.tmpdir"), "dbx-h2-drivers");
    // H2's engine registry is classloader-scoped. Keep one engine per driver for
    // the Agent process, not one per logical session (which fights for file locks).
    private static final Map<H2DriverVersion, LoadedDriver> BUNDLED = new EnumMap<>(H2DriverVersion.class);
    private static final Map<String, LoadedDriver> EXTERNAL = new HashMap<>();

    private H2DriverLoader() {
    }

    static boolean autoServerEnabled(ConnectParams params) throws Exception {
        // Use H2's parser so escaped INIT statements and duplicate options keep JDBC semantics.
        Class<?> connectionInfo = load(H2DriverVersion.V3).classLoader().loadClass("org.h2.engine.ConnectionInfo");
        Properties properties = new Properties();
        if (params.getUsername() != null) {
            properties.setProperty("user", params.getUsername());
        }
        if (params.getPassword() != null) {
            properties.setProperty("password", params.getPassword());
        }
        Object info = connectionInfo.getConstructor(String.class, Properties.class, String.class, Object.class)
            .newInstance(H2Agent.buildUrl(params), properties, null, null);
        return Boolean.TRUE.equals(connectionInfo.getMethod("getProperty", String.class, boolean.class)
            .invoke(info, "AUTO_SERVER", false));
    }

    static synchronized LoadedDriver load(H2DriverVersion version) throws Exception {
        LoadedDriver cached = BUNDLED.get(version);
        if (cached != null) {
            return cached;
        }
        Path jar = extract(version);
        URLClassLoader classLoader = new URLClassLoader(
            new URL[]{jar.toUri().toURL()},
            H2DriverLoader.class.getClassLoader()
        );
        try {
            Driver driver = (Driver) Class.forName("org.h2.Driver", true, classLoader).getDeclaredConstructor().newInstance();
            LoadedDriver loaded = new LoadedDriver(version, version.version(), driver, classLoader);
            BUNDLED.put(version, loaded);
            return loaded;
        } catch (Exception error) {
            closeAfterFailure(classLoader, error);
            throw error;
        } catch (LinkageError error) {
            closeAfterFailure(classLoader, error);
            throw error;
        }
    }

    static synchronized LoadedDriver loadExternal(List<String> driverPaths, String driverClass) throws Exception {
        if (driverPaths == null || driverPaths.isEmpty()) {
            throw new IllegalArgumentException("Custom H2 driver profile requires at least one JDBC JAR path");
        }
        List<URL> urls = new ArrayList<>();
        List<String> identities = new ArrayList<>();
        for (String driverPath : driverPaths) {
            Path path = Path.of(driverPath).toAbsolutePath().normalize();
            if (!Files.isRegularFile(path)) {
                throw new IOException("Custom H2 JDBC JAR does not exist: " + path);
            }
            path = path.toRealPath();
            identities.add(path + ":" + sha256(path));
            // Keep the original location for relative Manifest Class-Path entries.
            urls.add(path.toUri().toURL());
        }
        String effectiveDriverClass = driverClass == null || driverClass.isBlank() ? "org.h2.Driver" : driverClass.trim();
        String identity = effectiveDriverClass + "|" + String.join("|", identities);
        LoadedDriver cached = EXTERNAL.get(identity);
        if (cached != null) {
            return cached;
        }
        URLClassLoader classLoader = new URLClassLoader(
            urls.toArray(new URL[0]),
            H2DriverLoader.class.getClassLoader()
        );
        try {
            Driver driver = (Driver) Class.forName(effectiveDriverClass, true, classLoader).getDeclaredConstructor().newInstance();
            LoadedDriver loaded = new LoadedDriver(H2DriverVersion.CUSTOM, identity, driver, classLoader);
            EXTERNAL.put(identity, loaded);
            return loaded;
        } catch (Exception error) {
            closeAfterFailure(classLoader, error);
            throw error;
        } catch (LinkageError error) {
            closeAfterFailure(classLoader, error);
            throw error;
        }
    }

    private static Path extract(H2DriverVersion version) throws Exception {
        byte[] bytes;
        try (InputStream input = H2DriverLoader.class.getResourceAsStream(version.resourcePath())) {
            if (input == null) {
                throw new IOException("Bundled H2 driver is missing: " + version.resourcePath());
            }
            bytes = input.readAllBytes();
        }
        String digest = sha256(bytes);
        Path directory = CACHE_ROOT.resolve(version.version() + "-" + digest.substring(0, 16));
        Path target = directory.resolve("h2.jar");
        synchronized (EXTRACTION_LOCK) {
            Files.createDirectories(directory);
            if (!Files.isRegularFile(target) || Files.size(target) != bytes.length || !digest.equals(sha256(target))) {
                Path temporary = directory.resolve("h2.jar.tmp-" + UUID.randomUUID());
                Files.write(temporary, bytes);
                try {
                    Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                } catch (java.nio.file.AtomicMoveNotSupportedException ignored) {
                    Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
        return target;
    }

    private static String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = Files.newInputStream(path)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (read > 0) {
                    digest.update(buffer, 0, read);
                }
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static void closeAfterFailure(URLClassLoader classLoader, Throwable error) {
        try {
            classLoader.close();
        } catch (IOException closeError) {
            error.addSuppressed(closeError);
        }
    }

    record LoadedDriver(H2DriverVersion version, String identity, Driver driver, URLClassLoader classLoader) {
    }
}
