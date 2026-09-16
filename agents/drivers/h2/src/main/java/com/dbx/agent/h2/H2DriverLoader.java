package com.dbx.agent.h2;

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
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

final class H2DriverLoader {
    private static final Object EXTRACTION_LOCK = new Object();
    private static final Path CACHE_ROOT = Path.of(System.getProperty("java.io.tmpdir"), "dbx-h2-drivers");

    private H2DriverLoader() {
    }

    static LoadedDriver load(H2DriverVersion version) throws Exception {
        Path jar = extract(version);
        URLClassLoader classLoader = new URLClassLoader(
            new URL[]{jar.toUri().toURL()},
            H2DriverLoader.class.getClassLoader()
        );
        try {
            Driver driver = (Driver) Class.forName("org.h2.Driver", true, classLoader).getDeclaredConstructor().newInstance();
            return new LoadedDriver(version, version.version(), driver, classLoader);
        } catch (Exception error) {
            closeAfterFailure(classLoader, error);
            throw error;
        } catch (LinkageError error) {
            closeAfterFailure(classLoader, error);
            throw error;
        }
    }

    static LoadedDriver loadExternal(List<String> driverPaths, String driverClass) throws Exception {
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
            urls.add(path.toUri().toURL());
            identities.add(path + ":" + sha256(path));
        }
        String effectiveDriverClass = driverClass == null || driverClass.isBlank() ? "org.h2.Driver" : driverClass.trim();
        URLClassLoader classLoader = new URLClassLoader(
            urls.toArray(new URL[0]),
            H2DriverLoader.class.getClassLoader()
        );
        try {
            Driver driver = (Driver) Class.forName(effectiveDriverClass, true, classLoader).getDeclaredConstructor().newInstance();
            return new LoadedDriver(H2DriverVersion.CUSTOM, effectiveDriverClass + "|" + String.join("|", identities), driver, classLoader);
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
