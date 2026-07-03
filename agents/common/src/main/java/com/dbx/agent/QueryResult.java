package com.dbx.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

public final class QueryResult {
    private List<String> columns;
    private List<String> column_types;
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
        this.rows = normalizeRows(rows);
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
        this.rows = rows;
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
        if (input == null) {
            return Collections.emptyList();
        }
        List<List<Object>> normalized = new ArrayList<>(input.size());
        for (List<?> row : input) {
            normalized.add(row == null ? Collections.emptyList() : new ArrayList<Object>(row));
        }
        return normalized;
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
            && Objects.equals(rows, that.rows);
    }

    @Override
    public int hashCode() {
        return Objects.hash(columns, column_types, rows, affected_rows, execution_time_ms, truncated);
    }

    @Override
    public String toString() {
        return "QueryResult(columns=" + columns
            + ", column_types=" + column_types
            + ", rows=" + rows
            + ", affected_rows=" + affected_rows
            + ", execution_time_ms=" + execution_time_ms
            + ", truncated=" + truncated
            + ")";
    }
}
