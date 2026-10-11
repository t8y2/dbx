package com.dbx.agent;

import java.util.Objects;

public final class QueryPageOptions {
    private int pageSize;
    private Integer fetchSize;
    private int maxRows;
    private int timeoutSecs;
    private boolean deferLobs;

    public QueryPageOptions() {
        this(100, null, JdbcExecutor.DEFAULT_MAX_ROWS, 0, false);
    }

    public QueryPageOptions(int pageSize, Integer fetchSize, int maxRows) {
        this(pageSize, fetchSize, maxRows, 0, false);
    }

    public QueryPageOptions(int pageSize, Integer fetchSize, int maxRows, int timeoutSecs) {
        this(pageSize, fetchSize, maxRows, timeoutSecs, false);
    }

    public QueryPageOptions(int pageSize, Integer fetchSize, int maxRows, int timeoutSecs, boolean deferLobs) {
        this.pageSize = pageSize;
        this.fetchSize = fetchSize;
        this.maxRows = maxRows;
        this.timeoutSecs = timeoutSecs;
        this.deferLobs = deferLobs;
    }

    public int getPageSize() {
        return pageSize;
    }

    public Integer getFetchSize() {
        return fetchSize;
    }

    public int getMaxRows() {
        return maxRows;
    }

    public int getTimeoutSecs() {
        return timeoutSecs;
    }

    public boolean getDeferLobs() {
        return deferLobs;
    }

    public void setPageSize(int pageSize) {
        this.pageSize = pageSize;
    }

    public void setFetchSize(Integer fetchSize) {
        this.fetchSize = fetchSize;
    }

    public void setMaxRows(int maxRows) {
        this.maxRows = maxRows;
    }

    public void setTimeoutSecs(int timeoutSecs) {
        this.timeoutSecs = timeoutSecs;
    }

    public void setDeferLobs(boolean deferLobs) {
        this.deferLobs = deferLobs;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof QueryPageOptions)) return false;
        QueryPageOptions that = (QueryPageOptions) other;
        return pageSize == that.pageSize
            && maxRows == that.maxRows
            && timeoutSecs == that.timeoutSecs
            && deferLobs == that.deferLobs
            && Objects.equals(fetchSize, that.fetchSize);
    }

    @Override
    public int hashCode() {
        return Objects.hash(pageSize, fetchSize, maxRows, timeoutSecs, deferLobs);
    }

    @Override
    public String toString() {
        return "QueryPageOptions(pageSize=" + pageSize
            + ", fetchSize=" + fetchSize
            + ", maxRows=" + maxRows
            + ", timeoutSecs=" + timeoutSecs
            + ", deferLobs=" + deferLobs
            + ")";
    }
}
