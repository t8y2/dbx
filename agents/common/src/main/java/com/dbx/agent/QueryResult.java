package com.dbx.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

public final class QueryResult {
    private List<String> columns;
    private List<String> column_types;
    private List<SpatialColumn> spatial_columns;
    private List<List<Integer>> spatial_values;
    private List<List<Object>> rows;
    private long affected_rows;
    private long execution_time_ms;
    private boolean truncated;

    public QueryResult() {
        this(Collections.emptyList(), Collections.emptyList(), 0L, 0L, false);
    }

    public QueryResult(List<String> columns, List<? extends List<?>> rows, long affected_rows, long execution_time_ms) {
        this(columns, rows, affected_rows, execution_time_ms, false);
    }

    public QueryResult(
        List<String> columns,
        List<? extends List<?>> rows,
        long affected_rows,
        long execution_time_ms,
        boolean truncated
    ) {
        this(columns, null, rows, affected_rows, execution_time_ms, truncated);
    }

    public QueryResult(
        List<String> columns,
        List<String> column_types,
        List<? extends List<?>> rows,
        long affected_rows,
        long execution_time_ms,
        boolean truncated
    ) {
        this.columns = columns == null ? Collections.emptyList() : columns;
        this.column_types = column_types == null ? Collections.emptyList() : column_types;
        NormalizedRows normalized = normalizeRowsWithSpatial(rows);
        this.rows = normalized.rows;
        this.spatial_columns = normalized.spatialColumns.isEmpty() ? null : normalized.spatialColumns;
        this.spatial_values = normalized.spatialValues.isEmpty() ? null : normalized.spatialValues;
        this.affected_rows = affected_rows;
        this.execution_time_ms = execution_time_ms;
        this.truncated = truncated;
    }

    public List<String> getColumns() {
        return columns;
    }

    public List<String> getColumn_types() {
        return column_types;
    }

    public List<List<Object>> getRows() {
        return rows;
    }

    public List<SpatialColumn> getSpatial_columns() {
        return spatial_columns == null ? Collections.emptyList() : spatial_columns;
    }

    public List<List<Integer>> getSpatial_values() {
        return spatial_values == null ? Collections.emptyList() : spatial_values;
    }

    public long getAffected_rows() {
        return affected_rows;
    }

    public long getExecution_time_ms() {
        return execution_time_ms;
    }

    public boolean getTruncated() {
        return truncated;
    }

    public void setColumns(List<String> columns) {
        this.columns = columns;
    }

    public void setColumn_types(List<String> column_types) {
        this.column_types = column_types;
    }

    public void setRows(List<List<Object>> rows) {
        NormalizedRows normalized = normalizeRowsWithSpatial(rows);
        this.rows = normalized.rows;
        this.spatial_columns = normalized.spatialColumns.isEmpty() ? null : normalized.spatialColumns;
        this.spatial_values = normalized.spatialValues.isEmpty() ? null : normalized.spatialValues;
    }

    public void setSpatial_columns(List<SpatialColumn> spatial_columns) {
        this.spatial_columns = spatial_columns == null || spatial_columns.isEmpty() ? null : spatial_columns;
    }

    public void setSpatial_values(List<List<Integer>> spatial_values) {
        this.spatial_values = spatial_values == null || spatial_values.isEmpty() ? null : spatial_values;
    }

    public void setAffected_rows(long affected_rows) {
        this.affected_rows = affected_rows;
    }

    public void setExecution_time_ms(long execution_time_ms) {
        this.execution_time_ms = execution_time_ms;
    }

    public void setTruncated(boolean truncated) {
        this.truncated = truncated;
    }

    static List<List<Object>> normalizeRows(List<? extends List<?>> input) {
        return normalizeRowsWithSpatial(input).rows;
    }

    static NormalizedRows normalizeRowsWithSpatial(List<? extends List<?>> input) {
        if (input == null) {
            return new NormalizedRows(Collections.emptyList(), Collections.emptyList(), Collections.emptyList());
        }
        List<List<Object>> normalized = new ArrayList<>(input.size());
        List<List<Integer>> spatialValues = new ArrayList<>(input.size());
        // column_index -> first non-null SRID seen (TreeMap keeps output ordered)
        Map<Integer, Integer> sridByColumn = new TreeMap<>();
        Set<Integer> spatialColumnIndexes = new TreeSet<>();
        for (List<?> inputRow : input) {
            List<?> row = inputRow == null ? Collections.emptyList() : inputRow;
            List<Object> values = new ArrayList<>(row.size());
            List<Integer> rowSrids = new ArrayList<>(row.size());
            for (int columnIndex = 0; columnIndex < row.size(); columnIndex++) {
                Object value = row.get(columnIndex);
                if (value instanceof SpatialValue) {
                    SpatialValue spatialValue = (SpatialValue) value;
                    spatialColumnIndexes.add(columnIndex);
                    Integer srid = spatialValue.getSrid();
                    // SRID 0 means unknown, mirroring the Rust drivers.
                    rowSrids.add(srid == null || srid == 0 ? null : srid);
                    if (srid != null && srid != 0 && !sridByColumn.containsKey(columnIndex)) {
                        sridByColumn.put(columnIndex, srid);
                    }
                    values.add(spatialValue.getWkt());
                } else {
                    rowSrids.add(null);
                    values.add(value);
                }
            }
            normalized.add(values);
            spatialValues.add(rowSrids);
        }
        List<SpatialColumn> spatialColumns = new ArrayList<>(spatialColumnIndexes.size());
        for (Integer columnIndex : spatialColumnIndexes) {
            spatialColumns.add(new SpatialColumn(columnIndex, sridByColumn.get(columnIndex)));
        }
        return new NormalizedRows(
            normalized,
            spatialColumns,
            spatialColumns.isEmpty() ? Collections.emptyList() : spatialValues
        );
    }

    static final class NormalizedRows {
        final List<List<Object>> rows;
        final List<SpatialColumn> spatialColumns;
        final List<List<Integer>> spatialValues;

        NormalizedRows(List<List<Object>> rows, List<SpatialColumn> spatialColumns, List<List<Integer>> spatialValues) {
            this.rows = rows;
            this.spatialColumns = spatialColumns;
            this.spatialValues = spatialValues;
        }
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof QueryResult)) return false;
        QueryResult that = (QueryResult) other;
        return affected_rows == that.affected_rows
            && execution_time_ms == that.execution_time_ms
            && truncated == that.truncated
            && Objects.equals(columns, that.columns)
            && Objects.equals(column_types, that.column_types)
            && Objects.equals(spatial_columns, that.spatial_columns)
            && Objects.equals(spatial_values, that.spatial_values)
            && Objects.equals(rows, that.rows);
    }

    @Override
    public int hashCode() {
        return Objects.hash(columns, column_types, spatial_columns, spatial_values, rows, affected_rows, execution_time_ms, truncated);
    }

    @Override
    public String toString() {
        return "QueryResult(columns=" + columns
            + ", column_types=" + column_types
            + ", spatial_columns=" + spatial_columns
            + ", spatial_values=" + spatial_values
            + ", rows=" + rows
            + ", affected_rows=" + affected_rows
            + ", execution_time_ms=" + execution_time_ms
            + ", truncated=" + truncated
            + ")";
    }
}
