package com.dbx.agent.h2;

import com.dbx.agent.ConnectParams;

import java.util.Locale;

enum H2DriverVersion {
    V1("h2-v1", "1.4.200", "/drivers/h2-1.4.200.jar", 1),
    V2("h2-v2", "2.1.214", "/drivers/h2-2.1.214.jar", 2),
    V3("h2-v3", "2.4.240", "/drivers/h2-2.4.240.jar", 3),
    CUSTOM("h2-custom", "custom", "", 0);

    private final String profile;
    private final String version;
    private final String resourcePath;
    private final int storageFormat;

    H2DriverVersion(String profile, String version, String resourcePath, int storageFormat) {
        this.profile = profile;
        this.version = version;
        this.resourcePath = resourcePath;
        this.storageFormat = storageFormat;
    }

    String profile() {
        return profile;
    }

    String version() {
        return version;
    }

    String resourcePath() {
        return resourcePath;
    }

    int storageFormat() {
        return storageFormat;
    }

    static H2DriverVersion select(ConnectParams params) throws Exception {
        String profile = params.getDriver_profile();
        String normalized = profile == null ? "" : profile.trim().toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "h2-v1" -> V1;
            case "h2-v2", "h2-legacy" -> V2;
            case "h2-v3" -> V3;
            case "h2-custom" -> CUSTOM;
            case "", "h2", "h2-auto", "h2_embedded", "h2_server" -> {
                String url = H2Agent.buildUrl(params);
                H2DriverLoader.LoadedDriver active = H2FileConnections.find(url);
                if (active != null) {
                    if (active.version() == CUSTOM) {
                        throw new IllegalArgumentException("This H2 file is already open with a custom driver; select the same custom H2 driver profile");
                    }
                    yield active.version();
                }
                try {
                    java.util.OptionalInt detected = H2FileFormatDetector.detect(url);
                    yield detected.isPresent() ? fromStorageFormat(detected.getAsInt()) : V3;
                } catch (H2FileFormatDetector.HeaderReadException error) {
                    // Another Agent may own the file. H2's AUTO_SERVER path negotiates
                    // the wire protocol and validates the lock/server key itself.
                    if (H2FileFormatDetector.hasAutoServerLock(url) && H2DriverLoader.autoServerEnabled(params)) {
                        yield V3;
                    }
                    throw error;
                }
            }
            default -> throw new IllegalArgumentException("Unsupported H2 driver profile: " + profile);
        };
    }

    private static H2DriverVersion fromStorageFormat(int format) {
        return switch (format) {
            case 1 -> V1;
            case 2 -> V2;
            case 3 -> V3;
            default -> throw new IllegalArgumentException("Unsupported H2 database file format: " + format);
        };
    }
}
