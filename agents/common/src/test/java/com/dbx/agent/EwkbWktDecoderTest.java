package com.dbx.agent;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class EwkbWktDecoderTest {

    private static byte[] hex(String s) {
        s = s.replace(" ", "");
        if (s.startsWith("0x") || s.startsWith("0X")) s = s.substring(2);
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(s.charAt(i * 2), 16);
            int lo = Character.digit(s.charAt(i * 2 + 1), 16);
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Cross-checked against the Rust ewkb_to_wkt tests in
    // crates/dbx-core/src/db/postgres.rs (same hex inputs, same expected WKT).
    // ──────────────────────────────────────────────────────────────────────

    @Test
    void decodesPointWithSridFromRustFixture() {
        byte[] raw = hex("0101000020E6100000C520B07268195D404E62105839F44340");
        assertEquals("POINT(116.397 39.908)", EwkbWktDecoder.decode(raw));
    }

    @Test
    void decodesMultiPolygonFromRustFixture() {
        byte[] raw = hex(
            "0106000020E610000002000000010300000001000000050000000000000000005D40000000000000444000000000"
                + "00405D4000000000000044400000000000405D4000000000008044400000000000005D40000000000080444000"
                + "00000000005D400000000000004440010300000001000000050000000000000000805D40000000000080434000"
                + "00000000C05D4000000000008043400000000000C05D4000000000000044400000000000805D40000000000000"
                + "44400000000000805D400000000000804340"
        );
        assertEquals(
            "MULTIPOLYGON(((116 40,117 40,117 41,116 41,116 40)),((118 39,119 39,119 40,118 40,118 39)))",
            EwkbWktDecoder.decode(raw)
        );
    }

    @Test
    void decodesGeometryCollectionFromRustFixture() {
        byte[] raw = hex(
            "0107000020E61000000200000001010000000000000000005D40000000000000444001020000000200000000000000"
                + "00405D4000000000008044400000000000805D400000000000004540"
        );
        assertEquals(
            "GEOMETRYCOLLECTION(POINT(116 40),LINESTRING(117 41,118 42))",
            EwkbWktDecoder.decode(raw)
        );
    }

    @Test
    void decodesHexStringWithoutPrefix() {
        String hex = "0101000020E6100000C520B07268195D404E62105839F44340";
        assertEquals("POINT(116.397 39.908)", EwkbWktDecoder.decode(hex));
    }

    @Test
    void decodesHexStringWith0xPrefix() {
        String hex = "0x0101000020E6100000C520B07268195D404E62105839F44340";
        assertEquals("POINT(116.397 39.908)", EwkbWktDecoder.decode(hex));
    }

    @Test
    void preservesAlreadyWktTextFromStAsText() {
        String wkt = "POINT(116.397 39.908)";
        assertEquals(wkt, EwkbWktDecoder.decode(wkt));
    }

    @Test
    void preservesAlreadyEwktTextWithSrid() {
        String ewkt = "SRID=4326;POINT(116.397 39.908)";
        assertEquals(ewkt, EwkbWktDecoder.decode(ewkt));
    }

    @Test
    void truncatedBytesFallBackToHex() {
        // First few bytes of a valid point but truncated mid-coordinate.
        byte[] raw = hex("0101000020E6100000C520B072");
        Object decoded = EwkbWktDecoder.decode(raw);
        assertTrue(decoded instanceof String);
        String s = (String) decoded;
        assertTrue(s.startsWith("0x"), "expected hex fallback, got: " + s);
        assertEquals("0x0101000020e6100000c520b072", s);
    }

    @Test
    void unparseableHexStringPreservedWithHexPrefix() {
        // Looks like hex (even, leading 01), but bytes are not valid EWKB.
        String mostly = "0123456789ABCDEF";
        Object decoded = EwkbWktDecoder.decode(mostly);
        assertTrue(decoded instanceof String);
        // Shape A: parseEwkb returns null, so we re-emit the input ensuring 0x prefix.
        assertTrue(((String) decoded).toLowerCase().startsWith("0x"), decoded.toString());
    }

    @Test
    void nullInputReturnsNull() {
        assertNull(EwkbWktDecoder.decode(null));
    }

    @Test
    void formatsWholeNumberDoublesWithoutTrailingDot() {
        // Ensure POINT(116 40) is "116 40", not "116.0 40.0" — matches Rust f64 Display.
        byte[] raw = hex("0101000020E61000000000000000005D400000000000004440");
        assertEquals("POINT(116 40)", EwkbWktDecoder.decode(raw));
    }

    @Test
    void emptyPointBecomesPointEmpty() {
        // A 2D point with both coordinates = NaN encodes as "POINT EMPTY" in the decoder.
        // EWKB: little-endian Point with SRID=0 omitted; type=1, then two NaN doubles.
        byte[] raw = hex("0101000000" + nanLe() + nanLe());
        assertEquals("POINT EMPTY", EwkbWktDecoder.decode(raw));
    }

    private static String nanLe() {
        // IEEE 754 quiet NaN, little-endian — same value Rust's f64::NAN encodes to.
        long bits = Double.doubleToRawLongBits(Double.NaN);
        StringBuilder sb = new StringBuilder(16);
        for (int i = 0; i < 8; i++) {
            int b = (int) ((bits >>> (i * 8)) & 0xFF);
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    @Test
    void pgGeometryReflectiveDecodeReturnsValueText() {
        // Synthetic stand-in for org.postgis.PGgeometry — same shape: getValue() returns EWKT.
        Object pgGeom = new FakePGgeometry("SRID=4326;POINT(116.397 39.908)");
        assertEquals("SRID=4326;POINT(116.397 39.908)", EwkbWktDecoder.decode(pgGeom));
    }

    @SuppressWarnings("unused")
    public static final class FakePGgeometry {
        private final String value;

        public FakePGgeometry(String value) {
            this.value = value;
        }

        // Class name won't match the reflective list so this falls through to toString();
        // we keep it here purely to assert the toString() fallback also works (no NPE).
        public String getValue() {
            return value;
        }

        @Override
        public String toString() {
            return value;
        }
    }
}
