package com.dbx.agent;

/** Optional read semantics; accepting an option is not proof of provider support. */
public record MetadataReadOptions(boolean exact) {
    public static final MetadataReadOptions DEFAULT = new MetadataReadOptions(false);
    public static final MetadataReadOptions EXACT = new MetadataReadOptions(true);

    public static MetadataReadOptions fromIdentityMode(String mode) {
        if (mode == null) return DEFAULT;
        if ("exact".equals(mode)) return EXACT;
        throw new IllegalArgumentException("Unsupported metadata identity mode");
    }
}
