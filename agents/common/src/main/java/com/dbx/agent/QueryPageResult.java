package com.dbx.agent;

import java.util.Collections;
import java.util.List;
import java.util.Objects;

public final class QueryPageResult {
    private List<String> columns;
    private List<String> column_types;
    private List<List<Object>> rows;
    private long affected_rows;
    private long execution_time_ms;
    private boolean truncated;
    private String session_id;
    private boolean has_more;

    public QueryPageResult() {
        this(Collections.emptyList(), Collections.emptyList(), 0L, 0L, false, null, false);
    }

    public QueryPageResult(List<String> columns, List<? extends List<?>> rows, long affected_rows, long execution_time_ms) {
        this(columns, rows, affected_rows, execution_time_ms, false, null, false);
    }

    public QueryPageResult(
        List<String> columns,
        List<? extends List<?>> rows,
        long affected_rows,
        long execution_time_ms,
        boolean truncated
    ) {
        this(columns, rows, affected_rows, execution_time_ms, truncated, null, false);
    }

    public QueryPageResult(
        List<String> columns,
        List<? extends List<?>> rows,
        long affected_rows,
        long execution_time_ms,
        boolean truncated,
        String session_id,
        boolean has_more
    ) {
        this(columns, null, rows, affected_rows, execution_time_ms, truncated, session_id, has_more);
    }

    public QueryPageResult(
        List<String> columns,
        List<String> column_types,
        List<? extends List<?>> rows,
        long affected_rows,
        long execution_time_ms,
        boolean truncated,
        String session_id,
        boolean has_more
    ) {
        this.columns = columns == null ? Collections.emptyList() : columns;
        this.column_types = column_types == null ? Collections.emptyList() : column_types;
        this.rows = QueryResult.normalizeRows(rows);
        this.affected_rows = affected_rows;
        this.execution_time_ms = execution_time_ms;
        this.truncated = truncated;
        this.session_id = session_id;
        this.has_more = has_more;
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

    public String getSession_id() {
        return session_id;
    }

    public boolean getHas_more() {
        return has_more;
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

    public void setSession_id(String session_id) {
        this.session_id = session_id;
    }

    public void setHas_more(boolean has_more) {
        this.has_more = has_more;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof QueryPageResult)) return false;
        QueryPageResult that = (QueryPageResult) other;
        return affected_rows == that.affected_rows
            && execution_time_ms == that.execution_time_ms
            && truncated == that.truncated
            && has_more == that.has_more
            && Objects.equals(columns, that.columns)
            && Objects.equals(column_types, that.column_types)
            && Objects.equals(rows, that.rows)
            && Objects.equals(session_id, that.session_id);
    }

    @Override
    public int hashCode() {
        return Objects.hash(columns, column_types, rows, affected_rows, execution_time_ms, truncated, session_id, has_more);
    }

    @Override
    public String toString() {
        return "QueryPageResult(columns=" + columns
            + ", column_types=" + column_types
            + ", rows=" + rows
            + ", affected_rows=" + affected_rows
            + ", execution_time_ms=" + execution_time_ms
            + ", truncated=" + truncated
            + ", session_id=" + session_id
            + ", has_more=" + has_more
            + ")";
    }
}
