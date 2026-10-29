package com.dbx.agent.yashandb;

import com.dbx.agent.ConnectParams;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.QueryResult;
import com.dbx.agent.SpatialColumn;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * End-to-end smoke for {@code MDSYS.ST_GEOMETRY} decoding against a live
 * YashanDB instance.
 *
 * <p>Needs {@code DBX_TEST_YASHANDB_HOST}, {@code DBX_TEST_YASHANDB_PORT},
 * {@code DBX_TEST_YASHANDB_DATABASE}, {@code DBX_TEST_YASHANDB_USER},
 * {@code DBX_TEST_YASHANDB_PASSWORD}, and optionally
 * {@code DBX_TEST_YASHANDB_SCHEMA} / {@code DBX_TEST_YASHANDB_TABLE}
 * (defaults {@code DBX_GEO} / {@code DBX_GEO_PROBE}). The probe table is
 * expected to contain the columns created by the spatial preview runbook
 * (G4326, G4490, G3857, GZ, GPOLY, GMULTI, GCOLL, G0, GNULL).
 */
class YashandbAgentLiveTest {
    @Test
    @EnabledIfEnvironmentVariable(named = "DBX_TEST_YASHANDB_HOST", matches = ".+")
    void decodesSpatialColumnsIntoWktAndSrid() {
        String schema = envOr("DBX_TEST_YASHANDB_SCHEMA", "DBX_GEO");
        String table = envOr("DBX_TEST_YASHANDB_TABLE", "DBX_GEO_PROBE");
        YashandbAgent agent = new YashandbAgent();
        agent.connect(new ConnectParams(
            System.getenv("DBX_TEST_YASHANDB_HOST"),
            Integer.parseInt(envOr("DBX_TEST_YASHANDB_PORT", "1688")),
            System.getenv("DBX_TEST_YASHANDB_DATABASE"),
            System.getenv("DBX_TEST_YASHANDB_USER"),
            System.getenv("DBX_TEST_YASHANDB_PASSWORD"),
            "",
            "",
            false
        ));

        QueryResult result = agent.executeQuery(
            "SELECT * FROM " + schema + "." + table + " WHERE ID = 1",
            null,
            new ExecuteQueryOptions()
        );

        int idIndex = result.getColumns().indexOf("ID");
        Assertions.assertTrue(idIndex >= 0, result.getColumns().toString());
        Assertions.assertEquals(1, ((Number) result.getRows().get(0).get(idIndex)).intValue());

        Map<String, Integer> columnIndexes = new HashMap<>();
        for (int i = 0; i < result.getColumns().size(); i++) {
            columnIndexes.put(result.getColumns().get(i).toUpperCase(), i);
        }
        Map<Integer, Integer> sridByIndex = new HashMap<>();
        for (SpatialColumn column : result.getSpatial_columns()) {
            sridByIndex.put(column.getColumn_index(), column.getSrid());
        }
        List<Object> row = result.getRows().get(0);

        assertWkt(row, columnIndexes, sridByIndex, "G4326", 4326, "POINT(116.397 39.908)");
        assertWkt(row, columnIndexes, sridByIndex, "G4490", 4490, "POINT(116.397 39.908)");
        assertWkt(row, columnIndexes, sridByIndex, "GZ", 4326, "POINT Z(116.397 39.908 50)");
        assertWkt(row, columnIndexes, sridByIndex, "GPOLY", 4326, null);
        assertWkt(row, columnIndexes, sridByIndex, "GMULTI", 4326, null);
        assertWkt(row, columnIndexes, sridByIndex, "GCOLL", 4326, null);
        assertWkt(row, columnIndexes, sridByIndex, "G3857", 3857, null);

        Integer g0 = columnIndexes.get("G0");
        Assertions.assertNotNull(g0);
        Assertions.assertTrue(String.valueOf(row.get(g0)).startsWith("POINT("));
        Assertions.assertNull(sridByIndex.get(g0), "SRID 0 must stay unknown");

        Integer gnull = columnIndexes.get("GNULL");
        Assertions.assertNotNull(gnull);
        Assertions.assertNull(row.get(gnull));
    }

    private static void assertWkt(
        List<Object> row,
        Map<String, Integer> columnIndexes,
        Map<Integer, Integer> sridByIndex,
        String column,
        int expectedSrid,
        String expectedWkt
    ) {
        Integer index = columnIndexes.get(column);
        Assertions.assertNotNull(index, column + " missing from " + columnIndexes.keySet());
        Object value = row.get(index);
        Assertions.assertNotNull(value, column + " should decode to WKT");
        String wkt = String.valueOf(value);
        Assertions.assertFalse(wkt.startsWith("0x"), column + " fell back to hex: " + wkt);
        if (expectedWkt != null) {
            Assertions.assertEquals(expectedWkt, wkt, column);
        }
        Assertions.assertEquals(expectedSrid, sridByIndex.get(index), column + " SRID");
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
