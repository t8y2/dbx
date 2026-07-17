package com.dbx.agent;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

/**
 * Decode PostGIS EWKB / WKB byte streams (and PGgeometry / hex strings) into
 * OGC Well-Known Text. Behaves identically to the Rust implementation in
 * {@code crates/dbx-core/src/db/postgres.rs::ewkb_to_wkt}, including the
 * {@code Z} / {@code M} / {@code ZM} dimension suffixes and {@code EMPTY}
 * geometries. Used by the JDBC agent layer so that PostgresLike databases
 * such as HighGo / KingBase / Vastbase / openGauss / GaussDB return WKT for
 * {@code geometry}/{@code geography} columns instead of opaque hex blobs.
 *
 * <p>The decoder is permissive: any unrecognized payload (truncated bytes,
 * unsupported geometry kind, non-hex strings, etc.) falls back to a hex
 * representation prefixed with {@code 0x} so the cell remains visible.
 */
public final class EwkbWktDecoder {
    /** Reflectively-detected PGgeometry classes that expose getValue() returning EWKT text. */
    private static final String[] PGGEOMETRY_CLASS_NAMES = new String[]{
        "org.postgis.PGgeometry",            // legacy PostGIS-JDBC
        "net.postgis.jdbc.PGgeometry",       // modern PostGIS-JDBC (>= 2024 release)
        "com.highgo.jdbc.geometry.PGgeometry"
    };

    /**
     * Generic {@code org.postgresql.util.PGobject}-shaped classes. Their
     * {@code getValue()} returns the textual representation the driver got off
     * the wire. For PostGIS columns on HighGo / KingBase / Vastbase that text
     * is the EWKB hex (e.g. {@code 0101000020E61000...}) — we still need to run
     * it through the EWKB hex parser.
     */
    private static final String[] PGOBJECT_CLASS_NAMES = new String[]{
        "org.postgresql.util.PGobject",
        "com.highgo.jdbc.util.PGobject",
        "org.postgresql.geometric.PGobject"
    };

    private EwkbWktDecoder() {
    }

    /**
     * Decode a JDBC-returned object from a {@code geometry} / {@code geography}
     * column into a textual representation, preferring WKT.
     *
     * <p>Accepted inputs:
     * <ul>
     *   <li>{@code null} — returned as-is.</li>
     *   <li>{@code byte[]} — interpreted as raw EWKB.</li>
     *   <li>A {@code PGgeometry}-like object exposing {@code getValue()} — the
     *       returned string is taken verbatim (already EWKT/WKT).</li>
     *   <li>{@link String} — if it looks like hex EWKB (with optional
     *       {@code 0x}/{@code \\x} prefix and a leading endian byte of
     *       {@code 00}/{@code 01}), it is decoded; otherwise returned as-is.</li>
     * </ul>
     *
     * @param value raw column value
     * @return decoded WKT, or a {@code 0x}-prefixed hex fallback, or {@code null}
     */
    public static Object decode(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof byte[]) {
            return decodeBytes((byte[]) value);
        }
        if (value instanceof String) {
            return decodeString((String) value);
        }
        // PGgeometry / PGobject and friends — pull out their getValue() text
        // and run it through the same string path. For PostGIS-JDBC types
        // getValue() yields EWKT (passes through unchanged); for the generic
        // PGobject driver returns EWKB hex, which decodeString() decodes.
        String pgValue = tryReflectiveGetValue(value);
        if (pgValue != null) {
            return decodeString(pgValue);
        }
        // Last resort: rely on toString() / underlying value.
        return value.toString();
    }

    /** Decode a raw EWKB byte sequence; returns hex {@code 0x..} on failure. */
    static String decodeBytes(byte[] raw) {
        if (raw == null) {
            return null;
        }
        String wkt = parseEwkb(raw);
        if (wkt != null) {
            return wkt;
        }
        return bytesToHexWithPrefix(raw);
    }

    /**
     * Decode a string column. If the text matches an EWKB hex layout the bytes
     * are decoded; otherwise (already WKT, ST_AsText output, etc.) returned
     * unchanged.
     */
    static String decodeString(String value) {
        if (value == null) {
            return null;
        }
        byte[] bytes = tryParseHex(value);
        if (bytes == null) {
            return value;
        }
        String wkt = parseEwkb(bytes);
        if (wkt != null) {
            return wkt;
        }
        // looked like hex but couldn't be parsed — preserve hex form.
        return ensureHexPrefix(value);
    }

    /**
     * Try to extract textual value from PGgeometry / PGobject-like objects via
     * {@code getValue()}. Returns {@code null} if the class doesn't match any
     * known PostGIS / PostgreSQL JDBC type (or the call fails reflectively).
     */
    private static String tryReflectiveGetValue(Object value) {
        Class<?> cls = value.getClass();
        if (!matchesAnyClassName(cls, PGGEOMETRY_CLASS_NAMES)
            && !matchesAnyClassName(cls, PGOBJECT_CLASS_NAMES)) {
            return null;
        }
        try {
            Method getValue = cls.getMethod("getValue");
            Object result = getValue.invoke(value);
            if (result instanceof String) {
                return (String) result;
            }
        } catch (ReflectiveOperationException ignored) {
            // fall through
        }
        return null;
    }

    private static boolean matchesAnyClassName(Class<?> cls, String[] names) {
        Class<?> current = cls;
        while (current != null) {
            for (String name : names) {
                if (current.getName().equals(name)) {
                    return true;
                }
                for (Class<?> iface : current.getInterfaces()) {
                    if (iface.getName().equals(name)) {
                        return true;
                    }
                }
            }
            current = current.getSuperclass();
        }
        return false;
    }

    /** @return parsed bytes, or {@code null} if {@code value} is not hex EWKB. */
    static byte[] tryParseHex(String value) {
        String s = value;
        if (s.length() >= 2 && (s.startsWith("0x") || s.startsWith("0X"))) {
            s = s.substring(2);
        } else if (s.length() >= 2 && (s.startsWith("\\x") || s.startsWith("\\X"))) {
            s = s.substring(2);
        }
        if (s.length() < 10 || (s.length() & 1) != 0) {
            return null;
        }
        // First byte must be the WKB endian marker (00 = big, 01 = little)
        char e0 = s.charAt(0);
        char e1 = s.charAt(1);
        if (!((e0 == '0') && (e1 == '0' || e1 == '1'))) {
            return null;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
                return null;
            }
        }
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(s.charAt(i * 2), 16);
            int lo = Character.digit(s.charAt(i * 2 + 1), 16);
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    private static String ensureHexPrefix(String value) {
        if (value.startsWith("0x") || value.startsWith("0X")) {
            return value;
        }
        return "0x" + value;
    }

    static String bytesToHexWithPrefix(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2 + 2);
        sb.append("0x");
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }

    // ── EWKB parser ────────────────────────────────────────────────────────

    private static String parseEwkb(byte[] raw) {
        if (raw == null || raw.length == 0) {
            return null;
        }
        Reader reader = new Reader(raw);
        Geometry g = parseGeometry(reader);
        if (g == null || reader.pos != raw.length) {
            return null;
        }
        return geometryToWkt(g);
    }

    private static Geometry parseGeometry(Reader reader) {
        Integer endian = reader.readU8();
        if (endian == null) {
            return null;
        }
        boolean little;
        if (endian == 0) {
            little = false;
        } else if (endian == 1) {
            little = true;
        } else {
            return null;
        }
        Long typeWordBoxed = reader.readU32(little);
        if (typeWordBoxed == null) {
            return null;
        }
        long typeWord = typeWordBoxed;
        Dims parsed = parseDimensions(typeWord);
        long baseType = parsed.baseType;
        if (parsed.hasSrid) {
            if (reader.readU32(little) == null) {
                return null;
            }
        }
        Dimensions dims = parsed.dims;
        switch ((int) baseType) {
            case 1: { // Point
                int len = dims.coordinateLen();
                List<Double> coords = new ArrayList<>(len);
                for (int i = 0; i < len; i++) {
                    Double v = reader.readF64(little);
                    if (v == null) {
                        return null;
                    }
                    coords.add(v);
                }
                boolean allNan = true;
                for (Double v : coords) {
                    if (!Double.isNaN(v)) {
                        allNan = false;
                        break;
                    }
                }
                return new Geometry(GeomKind.POINT, dims, allNan ? null : coords, null, null, null, null, null);
            }
            case 2: { // LineString
                List<List<Double>> points = parsePoints(reader, little, dims);
                if (points == null) return null;
                return new Geometry(GeomKind.LINESTRING, dims, null, points, null, null, null, null);
            }
            case 3: { // Polygon
                Long ringCount = reader.readU32(little);
                if (ringCount == null) return null;
                List<List<List<Double>>> rings = new ArrayList<>();
                for (int i = 0; i < ringCount; i++) {
                    List<List<Double>> ring = parsePoints(reader, little, dims);
                    if (ring == null) return null;
                    rings.add(ring);
                }
                return new Geometry(GeomKind.POLYGON, dims, null, null, rings, null, null, null);
            }
            case 4: { // MultiPoint
                Long count = reader.readU32(little);
                if (count == null) return null;
                List<List<Double>> mpoints = new ArrayList<>();
                for (int i = 0; i < count; i++) {
                    List<Double> coords = readPointCoords(reader, dims);
                    if (coords == null) {
                        // sub-point parse failure (returning null != EMPTY); abort.
                        return null;
                    }
                    boolean allNan = true;
                    for (Double v : coords) {
                        if (!Double.isNaN(v)) {
                            allNan = false;
                            break;
                        }
                    }
                    mpoints.add(allNan ? null : coords);
                }
                return new Geometry(GeomKind.MULTIPOINT, dims, null, null, null, mpoints, null, null);
            }
            case 5: { // MultiLineString
                Long count = reader.readU32(little);
                if (count == null) return null;
                List<List<List<Double>>> lines = new ArrayList<>();
                for (int i = 0; i < count; i++) {
                    Geometry sub = parseGeometry(reader);
                    if (sub == null || sub.kind != GeomKind.LINESTRING) return null;
                    lines.add(sub.points);
                }
                return new Geometry(GeomKind.MULTILINESTRING, dims, null, null, lines, null, null, null);
            }
            case 6: { // MultiPolygon
                Long count = reader.readU32(little);
                if (count == null) return null;
                List<List<List<List<Double>>>> polys = new ArrayList<>();
                for (int i = 0; i < count; i++) {
                    Geometry sub = parseGeometry(reader);
                    if (sub == null || sub.kind != GeomKind.POLYGON) return null;
                    polys.add(sub.rings);
                }
                return new Geometry(GeomKind.MULTIPOLYGON, dims, null, null, null, null, polys, null);
            }
            case 7: { // GeometryCollection
                Long count = reader.readU32(little);
                if (count == null) return null;
                List<Geometry> children = new ArrayList<>();
                for (int i = 0; i < count; i++) {
                    Geometry sub = parseGeometry(reader);
                    if (sub == null) return null;
                    children.add(sub);
                }
                return new Geometry(GeomKind.GEOMETRYCOLLECTION, dims, null, null, null, null, null, children);
            }
            default:
                return null;
        }
    }

    private static List<List<Double>> parsePoints(Reader reader, boolean little, Dimensions dims) {
        Long count = reader.readU32(little);
        if (count == null) return null;
        int dim = dims.coordinateLen();
        List<List<Double>> result = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            List<Double> coords = new ArrayList<>(dim);
            for (int j = 0; j < dim; j++) {
                Double v = reader.readF64(little);
                if (v == null) return null;
                coords.add(v);
            }
            result.add(coords);
        }
        return result;
    }

    private static List<Double> readPointCoords(Reader reader, Dimensions parentDims) {
        Integer endian = reader.readU8();
        if (endian == null) return null;
        boolean little;
        if (endian == 0) {
            little = false;
        } else if (endian == 1) {
            little = true;
        } else {
            return null;
        }
        Long typeWord = reader.readU32(little);
        if (typeWord == null) return null;
        Dims parsed = parseDimensions(typeWord);
        if (parsed.baseType != 1 || !parsed.dims.equals(parentDims)) {
            return null;
        }
        if (parsed.hasSrid) {
            if (reader.readU32(little) == null) return null;
        }
        int dim = parsed.dims.coordinateLen();
        List<Double> coords = new ArrayList<>(dim);
        for (int i = 0; i < dim; i++) {
            Double v = reader.readF64(little);
            if (v == null) return null;
            coords.add(v);
        }
        return coords;
    }

    private static Dims parseDimensions(long typeWord) {
        long baseType = typeWord & 0x1FFF_FFFFL;
        boolean hasZ = (typeWord & 0x8000_0000L) != 0;
        boolean hasM = (typeWord & 0x4000_0000L) != 0;
        boolean hasSrid = (typeWord & 0x2000_0000L) != 0;
        if (baseType >= 3000) {
            hasZ = true;
            hasM = true;
            baseType -= 3000;
        } else if (baseType >= 2000) {
            hasM = true;
            baseType -= 2000;
        } else if (baseType >= 1000) {
            hasZ = true;
            baseType -= 1000;
        }
        return new Dims(baseType, new Dimensions(hasZ, hasM), hasSrid);
    }

    // ── WKT formatting ─────────────────────────────────────────────────────

    private static String geometryToWkt(Geometry g) {
        String suffix = g.dims.suffix();
        switch (g.kind) {
            case POINT:
                if (g.coords == null) {
                    return "POINT" + suffix + " EMPTY";
                }
                return "POINT" + suffix + "(" + formatCoord(g.coords) + ")";
            case LINESTRING:
                if (g.points == null || g.points.isEmpty()) {
                    return "LINESTRING" + suffix + " EMPTY";
                }
                return "LINESTRING" + suffix + "(" + formatCoordSeq(g.points) + ")";
            case POLYGON:
                if (g.rings == null || g.rings.isEmpty()) {
                    return "POLYGON" + suffix + " EMPTY";
                }
                return "POLYGON" + suffix + "(" + joinRings(g.rings) + ")";
            case MULTIPOINT:
                if (g.multiPoints == null || g.multiPoints.isEmpty()) {
                    return "MULTIPOINT" + suffix + " EMPTY";
                }
                return "MULTIPOINT" + suffix + "(" + joinMultiPoints(g.multiPoints) + ")";
            case MULTILINESTRING:
                if (g.rings == null || g.rings.isEmpty()) {
                    return "MULTILINESTRING" + suffix + " EMPTY";
                }
                return "MULTILINESTRING" + suffix + "(" + joinRings(g.rings) + ")";
            case MULTIPOLYGON:
                if (g.polygons == null || g.polygons.isEmpty()) {
                    return "MULTIPOLYGON" + suffix + " EMPTY";
                }
                return "MULTIPOLYGON" + suffix + "(" + joinPolygons(g.polygons) + ")";
            case GEOMETRYCOLLECTION:
                if (g.children == null || g.children.isEmpty()) {
                    return "GEOMETRYCOLLECTION" + suffix + " EMPTY";
                }
                StringBuilder sb = new StringBuilder("GEOMETRYCOLLECTION").append(suffix).append("(");
                for (int i = 0; i < g.children.size(); i++) {
                    if (i > 0) sb.append(',');
                    sb.append(geometryToWkt(g.children.get(i)));
                }
                sb.append(')');
                return sb.toString();
            default:
                throw new IllegalStateException("unknown geometry kind: " + g.kind);
        }
    }

    private static String formatCoord(List<Double> coords) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < coords.size(); i++) {
            if (i > 0) sb.append(' ');
            sb.append(formatDouble(coords.get(i)));
        }
        return sb.toString();
    }

    private static String formatCoordSeq(List<List<Double>> points) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < points.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(formatCoord(points.get(i)));
        }
        return sb.toString();
    }

    private static String joinRings(List<List<List<Double>>> rings) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < rings.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append('(').append(formatCoordSeq(rings.get(i))).append(')');
        }
        return sb.toString();
    }

    private static String joinMultiPoints(List<List<Double>> mpoints) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < mpoints.size(); i++) {
            if (i > 0) sb.append(',');
            List<Double> p = mpoints.get(i);
            if (p == null) {
                sb.append("EMPTY");
            } else {
                sb.append('(').append(formatCoord(p)).append(')');
            }
        }
        return sb.toString();
    }

    private static String joinPolygons(List<List<List<List<Double>>>> polys) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < polys.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append('(').append(joinRings(polys.get(i))).append(')');
        }
        return sb.toString();
    }

    /**
     * Format a double the same way Rust's {@code f64::Display} does — shortest
     * round-trippable decimal, trailing {@code .0} stripped (so {@code 116.0}
     * becomes {@code "116"}, not {@code "116.0"}).
     */
    static String formatDouble(double value) {
        if (Double.isNaN(value)) {
            return "NaN";
        }
        if (Double.isInfinite(value)) {
            return value > 0 ? "inf" : "-inf";
        }
        String s = Double.toString(value);
        // Strip trailing ".0" for whole-number doubles so output matches Rust.
        if (s.endsWith(".0")) {
            return s.substring(0, s.length() - 2);
        }
        return s;
    }

    // ── helper structs ─────────────────────────────────────────────────────

    private enum GeomKind {
        POINT, LINESTRING, POLYGON, MULTIPOINT, MULTILINESTRING, MULTIPOLYGON, GEOMETRYCOLLECTION
    }

    private static final class Geometry {
        final GeomKind kind;
        final Dimensions dims;
        final List<Double> coords;            // POINT
        final List<List<Double>> points;      // LINESTRING
        final List<List<List<Double>>> rings; // POLYGON / MULTILINESTRING (lines == rings shape-wise)
        final List<List<Double>> multiPoints; // MULTIPOINT (null entry = EMPTY)
        final List<List<List<List<Double>>>> polygons; // MULTIPOLYGON
        final List<Geometry> children;        // GEOMETRYCOLLECTION

        Geometry(
            GeomKind kind,
            Dimensions dims,
            List<Double> coords,
            List<List<Double>> points,
            List<List<List<Double>>> rings,
            List<List<Double>> multiPoints,
            List<List<List<List<Double>>>> polygons,
            List<Geometry> children
        ) {
            this.kind = kind;
            this.dims = dims;
            this.coords = coords;
            this.points = points;
            this.rings = rings;
            this.multiPoints = multiPoints;
            this.polygons = polygons;
            this.children = children;
        }
    }

    private static final class Dimensions {
        final boolean hasZ;
        final boolean hasM;

        Dimensions(boolean hasZ, boolean hasM) {
            this.hasZ = hasZ;
            this.hasM = hasM;
        }

        String suffix() {
            if (hasZ && hasM) return " ZM";
            if (hasZ) return " Z";
            if (hasM) return " M";
            return "";
        }

        int coordinateLen() {
            return 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof Dimensions)) return false;
            Dimensions d = (Dimensions) o;
            return hasZ == d.hasZ && hasM == d.hasM;
        }

        @Override
        public int hashCode() {
            return (hasZ ? 1 : 0) * 31 + (hasM ? 1 : 0);
        }
    }

    private static final class Dims {
        final long baseType;
        final Dimensions dims;
        final boolean hasSrid;

        Dims(long baseType, Dimensions dims, boolean hasSrid) {
            this.baseType = baseType;
            this.dims = dims;
            this.hasSrid = hasSrid;
        }
    }

    private static final class Reader {
        final byte[] raw;
        int pos;

        Reader(byte[] raw) {
            this.raw = raw;
        }

        Integer readU8() {
            if (pos >= raw.length) return null;
            int v = raw[pos] & 0xFF;
            pos += 1;
            return v;
        }

        Long readU32(boolean little) {
            if (pos + 4 > raw.length) return null;
            long v;
            if (little) {
                v = ((long) (raw[pos] & 0xFF))
                    | ((long) (raw[pos + 1] & 0xFF) << 8)
                    | ((long) (raw[pos + 2] & 0xFF) << 16)
                    | ((long) (raw[pos + 3] & 0xFF) << 24);
            } else {
                v = ((long) (raw[pos] & 0xFF) << 24)
                    | ((long) (raw[pos + 1] & 0xFF) << 16)
                    | ((long) (raw[pos + 2] & 0xFF) << 8)
                    | ((long) (raw[pos + 3] & 0xFF));
            }
            pos += 4;
            return v & 0xFFFF_FFFFL;
        }

        Double readF64(boolean little) {
            if (pos + 8 > raw.length) return null;
            long bits;
            if (little) {
                bits = ((long) (raw[pos] & 0xFF))
                    | ((long) (raw[pos + 1] & 0xFF) << 8)
                    | ((long) (raw[pos + 2] & 0xFF) << 16)
                    | ((long) (raw[pos + 3] & 0xFF) << 24)
                    | ((long) (raw[pos + 4] & 0xFF) << 32)
                    | ((long) (raw[pos + 5] & 0xFF) << 40)
                    | ((long) (raw[pos + 6] & 0xFF) << 48)
                    | ((long) (raw[pos + 7] & 0xFF) << 56);
            } else {
                bits = ((long) (raw[pos] & 0xFF) << 56)
                    | ((long) (raw[pos + 1] & 0xFF) << 48)
                    | ((long) (raw[pos + 2] & 0xFF) << 40)
                    | ((long) (raw[pos + 3] & 0xFF) << 32)
                    | ((long) (raw[pos + 4] & 0xFF) << 24)
                    | ((long) (raw[pos + 5] & 0xFF) << 16)
                    | ((long) (raw[pos + 6] & 0xFF) << 8)
                    | ((long) (raw[pos + 7] & 0xFF));
            }
            pos += 8;
            return Double.longBitsToDouble(bits);
        }
    }
}
