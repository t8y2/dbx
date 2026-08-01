package com.dbx.agent;

/** Internal JDBC result value carrying display WKT and its optional SRID. */
public final class SpatialValue {
    private final String wkt;
    private final Integer srid;

    public SpatialValue(String wkt, Integer srid) {
        this.wkt = wkt;
        this.srid = srid;
    }

    public String getWkt() {
        return wkt;
    }

    public Integer getSrid() {
        return srid;
    }
}
