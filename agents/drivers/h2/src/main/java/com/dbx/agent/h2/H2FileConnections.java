package com.dbx.agent.h2;

import java.lang.ref.WeakReference;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Tracks physical connections and embedded engines without extending their lifetimes. */
final class H2FileConnections {
    private static final Map<Path, List<OpenConnection>> CONNECTIONS = new HashMap<>();

    private H2FileConnections() {
    }

    static synchronized H2DriverLoader.LoadedDriver find(String jdbcUrl) throws Exception {
        CONNECTIONS.values().forEach(entries -> entries.removeIf(entry -> !entry.isOpen()));
        CONNECTIONS.values().removeIf(List::isEmpty);
        List<OpenConnection> entries = CONNECTIONS.get(key(jdbcUrl));
        return entries == null ? null : entries.get(0).driver();
    }

    static synchronized void register(String jdbcUrl, Connection connection, H2DriverLoader.LoadedDriver driver) throws Exception {
        Path key = key(jdbcUrl);
        if (key != null) {
            EmbeddedDatabase database = embeddedDatabase(connection);
            List<OpenConnection> entries = CONNECTIONS.computeIfAbsent(key, ignored -> new ArrayList<>());
            if (database != null && entries.stream().anyMatch(entry -> entry.database() != null
                && entry.database().reference().get() == database.reference().get())) {
                return;
            }
            entries.add(new OpenConnection(new WeakReference<>(connection), database, driver));
        }
    }

    private static EmbeddedDatabase embeddedDatabase(Connection connection) {
        try {
            // Public H2 accessors differ only in their return types across bundled versions.
            Object session = connection.getClass().getMethod("getSession").invoke(connection);
            if (session == null) {
                return null;
            }
            Object database = session.getClass().getMethod("getDatabase").invoke(session);
            if (database == null) {
                return null;
            }
            return new EmbeddedDatabase(new WeakReference<>(database), database.getClass().getMethod("isClosing"));
        } catch (ReflectiveOperationException ignored) {
            // AUTO_SERVER remote sessions and custom wrappers may expose no embedded engine.
            return null;
        }
    }

    private static Path key(String jdbcUrl) throws Exception {
        Path base = H2FileFormatDetector.localDatabaseBasePath(jdbcUrl);
        if (base == null) {
            return null;
        }
        for (String suffix : List.of(".mv.db", ".h2.db")) {
            Path file = Path.of(base + suffix);
            if (Files.isRegularFile(file)) {
                return file.toRealPath();
            }
        }
        return base;
    }

    private record EmbeddedDatabase(WeakReference<Object> reference, Method isClosing) {
        boolean isOpen() {
            Object database = reference.get();
            if (database == null) {
                return false;
            }
            synchronized (database) {
                try {
                    return Boolean.FALSE.equals(isClosing.invoke(database));
                } catch (ReflectiveOperationException ignored) {
                    return false;
                }
            }
        }
    }

    private record OpenConnection(
        WeakReference<Connection> reference,
        EmbeddedDatabase database,
        H2DriverLoader.LoadedDriver driver
    ) {
        boolean isOpen() {
            Connection connection = reference.get();
            try {
                if (connection != null && !connection.isClosed()) {
                    return true;
                }
            } catch (SQLException ignored) {
            }
            // DB_CLOSE_DELAY can keep the engine and its file lock alive after JDBC close.
            return database != null && database.isOpen();
        }
    }
}
