package com.dbx.agent;

import java.util.Objects;

public final class SpatialColumn {
    private final int column_index;
    private final Integer srid;

    public SpatialColumn(int columnIndex, Integer srid) {
        this.column_index = columnIndex;
        this.srid = srid;
    }

    public int getColumn_index() {
        return column_index;
    }

    public Integer getSrid() {
        return srid;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof SpatialColumn)) return false;
        SpatialColumn that = (SpatialColumn) other;
        return column_index == that.column_index && Objects.equals(srid, that.srid);
    }

    @Override
    public int hashCode() {
        return Objects.hash(column_index, srid);
    }

    @Override
    public String toString() {
        return "SpatialColumn(column_index=" + column_index + ", srid=" + srid + ")";
    }
}
